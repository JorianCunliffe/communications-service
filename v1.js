import twilio from 'twilio';
import { E164, rejectMissingCapability, rejectUnauthorizedTenant } from './auth.js';
import { assertContactable, resolveConfig, ensureContact, storeCallConfig } from './configResolver.js';
import { getDatabase } from './database.js';
import { recordMessage } from './smsLog.js';
import { recordCall } from './callLog.js';
import { enqueueEvent } from './eventOutbox.js';
import { randomUUID } from 'node:crypto';
import { canonicalCommunication, normaliseCorrelation, normalisePurpose, prefixedId, resolveCommunicationThread } from './communicationModel.js';
import { calendarCandidates, ingestCalendarEvent, resolveCalendarEvent, resolveCalendarEventId } from './calendar.js';
import { getEventContext, getLooseEnds, getPersonMemory, getProjectMemory, getThreadMemory, searchMemory } from './memory.js';
import { idempotencyKey, markOutbound, reserveOutbound } from './outboundOperations.js';
import { tenantDatabase } from './tenantContext.js';
import { emailEnabled } from './emailWebhook.js';
import { loadEmailConnection, sendEmailWithProvider } from './emailDelivery.js';
import { createEmailReplyRoute } from './emailReplyRoutes.js';
import { outboundEmailRequest } from './email.js';

const CHANNELS = ['voice', 'sms', 'email', 'whatsapp', 'slack', 'teams', 'recording'];
const DIRECTIONS = ['inbound', 'outbound'];
const TERMINAL_CALL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
const CALL_OVERRIDE_FIELDS = ['model', 'effort', 'voice', 'temperature', 'systemMessage', 'introMessage', 'introMessage2', 'introVoice', 'greetingText', 'aiSpeaksFirst', 'liveTranscript'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INBOX_DISPOSITIONS = ['candidate_human_response', 'human', 'spam', 'bounce', 'automatic_reply', 'mailing_list', 'unsubscribe_intent', 'system_generated', 'archived', 'unassigned'];

export function providerCallbackUrl(baseUrl, path, tenantId) {
    const url = new URL(path, `${String(baseUrl).replace(/\/$/, '')}/`);
    url.searchParams.set('tenant_id', tenantId);
    return url.toString();
}

function database(reply) {
    const db = getDatabase();
    if (!db) reply.code(503).send({ error: 'Communications persistence is not configured' });
    return db ? tenantDatabase(db, reply.request.tenantId) : null;
}

function errorReply(reply, error, status = 400) {
    const payload = { error: error.message };
    if (error.providerError) payload.provider_error = error.providerError;
    return reply.code(status).send(payload);
}

function outboundError(action, error) {
    const code = /^\d+$/.test(String(error?.code ?? '')) ? Number(error.code) : null;
    const providerError = {
        provider: 'twilio',
        code,
        status: Number.isInteger(error?.status) ? error.status : null,
        more_info: typeof error?.moreInfo === 'string' ? error.moreInfo : null,
    };
    const suffix = code ? ` (Twilio ${code})` : '';
    const wrapped = new Error(`${action}: ${error?.message || 'Unknown outbound provider error'}${suffix}`);
    wrapped.providerError = providerError;
    console.error(wrapped.message, providerError);
    return wrapped;
}

function toCanonical(row) {
    return canonicalCommunication({
        tenantId: row.tenant_id,
        communicationId: row.communication_id,
        threadId: row.thread_id,
        channel: row.channel,
        direction: row.direction,
        occurredAt: row.occurred_at,
        personId: row.person_id || row.contact_id,
        content: row.body,
        summary: row.summary,
        provider: row.provider,
        providerId: row.provider_id,
        correlation: row.correlation || {},
        purpose: row.purpose,
        resolution: row.resolution,
        businessStatus: row.business_status,
        disposition: row.disposition,
        successful: row.successful,
        memoryEligible: row.memory_eligible,
        failureCode: row.failure_code,
        failureReason: row.failure_reason,
        outcomeSource: row.outcome_source,
        outcomeConfidence: row.outcome_confidence,
        outcomeDetectedAt: row.outcome_detected_at,
    });
}

async function getCommunication(db, communicationId) {
    const { data, error } = await db.from('communications').select('*')
        .eq('communication_id', communicationId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
}

function parseSemantic(body = {}) {
    let callbackUrl = null;
    if (body.callback_url !== undefined && body.callback_url !== null) {
        try {
            const parsed = new URL(body.callback_url);
            if (parsed.protocol !== 'https:') throw new Error('not https');
            callbackUrl = parsed.toString();
        } catch (_) {
            throw new Error('"callback_url" must be a valid https URL');
        }
    }
    if (body.project_id && !UUID.test(body.project_id)) throw new Error('"project_id" must be an internal project UUID; use correlation.external_project_id for workflow IDs');
    return {
        purpose: normalisePurpose(body.purpose),
        correlation: normaliseCorrelation(body.correlation || body.metadata),
        threadId: body.thread_id || null,
        callbackUrl,
    };
}

export default async function v1Routes(fastify) {
    fastify.addHook('preHandler', async (request, reply) => {
        const rejected = await rejectUnauthorizedTenant(request, reply, getDatabase(), 'Communications API');
        if (rejected) return rejected;
        const capability = request.method === 'GET' ? 'communications:read' : 'communications:write';
        const denied = rejectMissingCapability(request, reply, capability);
        if (denied) return denied;
        if (request.method === 'POST' && request.url.split('?')[0].endsWith('/emails')) {
            const emailDenied = rejectMissingCapability(request, reply, 'email:send');
            if (emailDenied) return emailDenied;
        }
        if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
            request.body.tenant_id = request.tenantId;
            request.body.correlation = {
                ...(request.body.metadata || {}),
                ...(request.body.correlation || {}),
                tenant_id: request.tenantId,
            };
        }
        return null;
    });

    fastify.get('/communications', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
        let query = db.from('communications').select('*', { count: 'exact' })
            .order('occurred_at', { ascending: false }).limit(limit);
        if (request.query.cursor) {
            const cursor = new Date(request.query.cursor);
            if (Number.isNaN(cursor.valueOf())) return reply.code(400).send({ error: 'cursor must be an ISO timestamp' });
            query = query.lt('occurred_at', cursor.toISOString());
        }
        if (request.query.channel) {
            if (!CHANNELS.includes(request.query.channel)) return reply.code(400).send({ error: 'Unknown channel' });
            query = query.eq('channel', request.query.channel);
        }
        if (request.query.thread_id) query = query.eq('thread_id', request.query.thread_id);
        if (request.query.ask_id) query = query.eq('purpose->>ask_id', request.query.ask_id);
        if (request.query.person_id) query = query.eq('person_id', request.query.person_id);
        if (request.query.business_status) query = query.eq('business_status', request.query.business_status);
        if (request.query.disposition) query = query.eq('disposition', request.query.disposition);
        if (request.query.successful === 'true' || request.query.successful === 'false') {
            query = query.eq('successful', request.query.successful === 'true');
        }
        if (request.query.memory_eligible === 'true' || request.query.memory_eligible === 'false') {
            query = query.eq('memory_eligible', request.query.memory_eligible === 'true');
        }
        const { data, error, count } = await query;
        if (error) return errorReply(reply, new Error(error.message), 500);
        return {
            data: (data || []).map(toCanonical), count, limit,
            next_cursor: data?.length === limit ? data[data.length - 1].occurred_at : null,
        };
    });

    // Provider adapters can project email, WhatsApp, Slack or Teams here. This
    // route records communication history; it never executes workflow logic.
    fastify.post('/communications', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const body = request.body || {};
        if (!CHANNELS.includes(body.channel)) return reply.code(400).send({ error: 'Unknown channel' });
        if (!DIRECTIONS.includes(body.direction)) return reply.code(400).send({ error: 'Unknown direction' });
        let semantic;
        try { semantic = parseSemantic(body); } catch (error) { return errorReply(reply, error); }

        try {
            if (body.provider && body.provider_id) {
                const existing = await db.from('communications').select('*').eq('provider', body.provider)
                    .eq('provider_id', body.provider_id).maybeSingle();
                if (existing.error) throw new Error(existing.error.message);
                if (existing.data) return reply.code(200).send({ ...toCanonical(existing.data), duplicate: true });
            }
            const communicationId = prefixedId('comm');
            const requestedCalendarEvent = body.calendar_event_id || semantic.correlation.calendar_event_id || null;
            const calendarEvent = await resolveCalendarEvent(db, requestedCalendarEvent);
            const calendarEventId = calendarEvent?.id || null;
            if (requestedCalendarEvent && !calendarEvent) {
                return reply.code(400).send({ error: 'calendar_event_id did not resolve to exactly one calendar event' });
            }
            const projectId = body.project_id || calendarEvent?.project_id || null;
            const resolvedCorrelation = {
                ...semantic.correlation,
                ...(projectId ? { project_id: projectId } : {}),
                ...(calendarEventId ? { calendar_event_id: calendarEventId } : {}),
            };
            const thread = await resolveCommunicationThread({
                db,
                participantIdentity: body.identity || body.person_id || null,
                serviceIdentity: body.service_identity || null,
                direction: body.direction,
                purpose: semantic.purpose,
                correlation: resolvedCorrelation,
                threadId: semantic.threadId || calendarEvent?.communication_thread_id || null,
                callbackUrl: semantic.callbackUrl,
            });
            const row = {
                communication_id: communicationId,
                channel: body.channel,
                direction: body.direction,
                source_table: 'communications_api',
                source_id: randomUUID(),
                contact_id: body.person_id || null,
                person_id: body.person_id || null,
                project_id: projectId,
                occurred_at: body.occurred_at || new Date().toISOString(),
                subject: body.subject || null,
                body: body.content || null,
                body_them: body.direction === 'inbound' ? body.content || null : null,
                summary: body.summary || null,
                provider: body.provider || null,
                provider_id: body.provider_id || null,
                purpose: thread.purpose,
                correlation: thread.correlation,
                thread_id: thread.threadId,
                thread_link_type: thread.linkType,
                calendar_event_id: calendarEventId,
                metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
            };
            const { data, error } = await db.from('communications').insert(row).select('*').single();
            if (error?.code === '23505' && body.provider && body.provider_id) {
                const duplicate = await db.from('communications').select('*').eq('provider', body.provider)
                    .eq('provider_id', body.provider_id).maybeSingle();
                if (duplicate.error) throw new Error(duplicate.error.message);
                return reply.code(200).send({ ...toCanonical(duplicate.data), duplicate: true });
            }
            if (error) throw new Error(error.message);

            await enqueueEvent({
                type: 'communication.created', communicationId, purpose: thread.purpose, correlation: thread.correlation,
                destination: thread.callbackUrl,
                payload: { channel: body.channel, direction: body.direction },
            });
            if (body.direction === 'inbound') {
                await enqueueEvent({
                    type: 'communication.received', communicationId, purpose: thread.purpose,
                    correlation: thread.correlation, destination: thread.callbackUrl,
                    payload: { channel: body.channel, direction: body.direction },
                });
            }
            if (body.direction === 'inbound' && thread.purpose?.type === 'human_ask') {
                await enqueueEvent({
                    type: 'ask.response.received', communicationId, purpose: thread.purpose,
                    correlation: thread.correlation, destination: thread.callbackUrl,
                    payload: { ask_id: thread.purpose.ask_id, channel: body.channel, content: body.content || null },
                });
            }
            const candidates = !calendarEventId && (data.person_id || data.contact_id)
                ? await calendarCandidates(db, { contactId: data.person_id || data.contact_id, occurredAt: data.occurred_at })
                : [];
            return reply.code(201).send({ ...toCanonical(data), calendarCandidates: candidates });
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.get('/communications/:communicationId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const row = await getCommunication(db, request.params.communicationId);
            if (!row) return reply.code(404).send({ error: 'Communication not found' });
            return toCanonical(row);
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.post('/communications/:communicationId/disposition', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const disposition = String(request.body?.disposition || '').trim().toLowerCase();
        if (!INBOX_DISPOSITIONS.includes(disposition)) return reply.code(400).send({ error: 'Unknown disposition' });
        const memoryEligible = request.body?.memory_eligible === undefined
            ? ['candidate_human_response', 'human'].includes(disposition)
            : request.body.memory_eligible === true;
        if (memoryEligible && !['candidate_human_response', 'human'].includes(disposition)) {
            return reply.code(400).send({ error: 'Non-human dispositions cannot be memory eligible' });
        }
        const updated = await db.from('communications').update({
            disposition, memory_eligible: memoryEligible, updated_at: new Date().toISOString(),
        }).eq('communication_id', request.params.communicationId).select('*').maybeSingle();
        if (updated.error) return errorReply(reply, new Error(updated.error.message), 500);
        if (!updated.data) return reply.code(404).send({ error: 'Communication not found' });
        if (updated.data.channel === 'email') {
            const email = await db.from('email_messages').update({
                triage_class: disposition, memory_eligible: memoryEligible, updated_at: new Date().toISOString(),
            }).eq('communication_id', request.params.communicationId);
            if (email.error) return errorReply(reply, new Error(email.error.message), 500);
        }
        return toCanonical(updated.data);
    });

    fastify.get('/inbox', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
        let query = db.from('communications').select('*').eq('direction', 'inbound')
            .order('occurred_at', { ascending: false }).limit(limit);
        if (request.query.channel) query = query.eq('channel', request.query.channel);
        if (request.query.disposition) query = query.eq('disposition', request.query.disposition);
        if (request.query.cursor) {
            const cursor = new Date(request.query.cursor);
            if (Number.isNaN(cursor.valueOf())) return reply.code(400).send({ error: 'cursor must be an ISO timestamp' });
            query = query.lt('occurred_at', cursor.toISOString());
        }
        const result = await query;
        if (result.error) return errorReply(reply, new Error(result.error.message), 500);
        return {
            data: (result.data || []).map(toCanonical),
            next_cursor: result.data?.length === limit ? result.data[result.data.length - 1].occurred_at : null,
        };
    });

    fastify.post('/communications/:communicationId/enrich', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const communication = await getCommunication(db, request.params.communicationId);
            if (!communication) return reply.code(404).send({ error: 'Communication not found' });
            if (communication.memory_eligible === false) {
                return reply.code(409).send({ error: 'Communication is audit-only and is not eligible for memory enrichment' });
            }
            const job = await db.rpc('requeue_communication_enrichment', { p_communication_id: request.params.communicationId });
            if (job.error) throw new Error(job.error.message);
            return { job: job.data, requeued: true };
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.post('/messages', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const { to, from, body } = request.body || {};
        if (!E164.test(to || '')) return reply.code(400).send({ error: '"to" must be an E.164 phone number' });
        if (!E164.test(from || '')) return reply.code(400).send({ error: '"from" must be an E.164 phone number' });
        if (typeof body !== 'string' || !body.trim() || body.length > 1600) {
            return reply.code(400).send({ error: '"body" must contain 1 to 1600 characters' });
        }

        let semantic;
        try { semantic = parseSemantic(request.body); } catch (error) { return errorReply(reply, error); }
        const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_URL } = process.env;
        if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
            return reply.code(503).send({ error: 'Twilio messaging is not configured' });
        }

        let communicationId = prefixedId('comm');
        try {
            await assertContactable(to, 'SMS', { allowed: request.body?.override_do_not_contact === true, reason: request.body?.override_reason });
            await ensureContact(to);
        } catch (error) {
            if (error.code === 'DO_NOT_CONTACT') return errorReply(reply, error, 409);
            return errorReply(reply, error, 500);
        }
        try {
            const operation = await reserveOutbound(db, {
                key: idempotencyKey(request), type: 'sms', communicationId,
                request: { to, from, body, purpose: semantic.purpose, correlation: semantic.correlation, thread_id: semantic.threadId,
                    override_do_not_contact: request.body?.override_do_not_contact, override_reason: request.body?.override_reason },
            });
            communicationId = operation.communication_id;
            if (operation.status === 'completed') return reply.code(200).send(operation.response);
            let message = { sid: operation.provider_id, status: operation.provider_status };
            if (operation.status !== 'provider_sent') {
                const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
                message = await client.messages.create({
                    to, from, body,
                    ...(PUBLIC_URL ? { statusCallback: providerCallbackUrl(PUBLIC_URL, '/message-status', request.tenantId) } : {}),
                });
                await markOutbound(db, operation.id, { status: 'provider_sent', provider_id: message.sid, provider_status: message.status });
            }
            const stored = await recordMessage({
                otherParty: to, twilioNumber: from, direction: 'outbound', body,
                messageSid: message.sid, status: message.status, communicationId,
                ...semantic, strict: true,
            });
            const communication = canonicalCommunication({
                tenantId: request.tenantId, communicationId, threadId: stored.threadId,
                channel: 'sms', direction: 'outbound', content: body,
                provider: 'twilio', providerId: message.sid,
                correlation: stored.correlation, purpose: stored.purpose,
            });
            await enqueueEvent({
                type: 'communication.created', communicationId, purpose: stored.purpose,
                correlation: stored.correlation, destination: stored.callbackUrl,
                payload: { channel: 'sms', direction: 'outbound' },
            });
            await enqueueEvent({
                type: 'sms.sent', communicationId, purpose: stored.purpose,
                correlation: stored.correlation, destination: stored.callbackUrl,
                payload: { status: message.status, channel: 'sms', direction: 'outbound' },
            });
            await markOutbound(db, operation.id, { status: 'completed', response: communication, completed_at: new Date().toISOString() });
            return reply.code(201).send(communication);
        } catch (error) {
            if (error.code === 'DO_NOT_CONTACT') return errorReply(reply, error, 409);
            if (error.code === 'IDEMPOTENCY_REQUIRED') return errorReply(reply, error, 400);
            if (error.code === 'IDEMPOTENCY_CONFLICT') return errorReply(reply, error, 409);
            if (error.code === 'IDEMPOTENCY_IN_PROGRESS') return errorReply(reply, error, 409);
            return errorReply(reply, outboundError('Failed to send message', error), 502);
        }
    });

    fastify.get('/messages/:communicationId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const row = await getCommunication(db, request.params.communicationId);
            if (!row || row.channel !== 'sms') return reply.code(404).send({ error: 'Message not found' });
            return toCanonical(row);
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.post('/emails', async (request, reply) => {
        if (!emailEnabled()) return reply.code(503).send({ error: 'Email delivery is disabled' });
        const db = database(reply); if (!db) return reply;
        const body = request.body || {};
        if (!body.from && !body.service_identity_id) {
            return reply.code(400).send({ error: 'from or service_identity_id is required' });
        }
        let semantic;
        try { semantic = parseSemantic(body); } catch (error) { return errorReply(reply, error); }
        let operation = null;
        let communicationId = prefixedId('comm');
        try {
            const { connection, serviceIdentity } = await loadEmailConnection(db, request.tenantId, {
                connectionId: body.provider_connection_id || null,
                serviceIdentityId: body.service_identity_id || null,
                from: body.from || null,
            });
            const thread = await resolveCommunicationThread({
                db,
                tenantId: request.tenantId,
                participantIdentity: body.to?.[0] || body.to || body.person_id || null,
                serviceIdentity: serviceIdentity.address,
                direction: 'outbound',
                threadId: semantic.threadId || prefixedId('thread'),
                purpose: semantic.purpose,
                correlation: semantic.correlation,
                callbackUrl: semantic.callbackUrl || connection.default_callback_url || null,
            });
            const providerRequest = {
                ...body,
                from: body.from || (serviceIdentity.display_name
                    ? `${serviceIdentity.display_name} <${serviceIdentity.address}>`
                    : serviceIdentity.address),
            };
            if (!providerRequest.reply_to?.length && serviceIdentity.reply_domain) {
                const reply = await createEmailReplyRoute(db, {
                    tenantId: request.tenantId,
                    threadId: thread.threadId,
                    askId: thread.purpose?.type === 'human_ask' ? thread.purpose.ask_id : null,
                    personId: body.person_id || null,
                    serviceIdentityId: serviceIdentity.id,
                });
                providerRequest.reply_to = [`reply+${reply.token}@${serviceIdentity.reply_domain}`];
            }
            const key = idempotencyKey(request);
            operation = await reserveOutbound(db, {
                tenantId: request.tenantId,
                key,
                type: 'email',
                communicationId,
                request: {
                    from: providerRequest.from, to: providerRequest.to, cc: providerRequest.cc,
                    bcc: providerRequest.bcc, subject: providerRequest.subject,
                    text: providerRequest.text, html: providerRequest.html,
                    purpose: thread.purpose, correlation: thread.correlation, thread_id: thread.threadId,
                },
            });
            communicationId = operation.communication_id;
            if (operation.status === 'completed') return reply.code(200).send(operation.response);
            if (operation.status === 'failed') {
                const reconciliation = new Error('Email operation previously failed after reservation; reconcile provider state before retrying');
                reconciliation.code = 'IDEMPOTENCY_RECONCILIATION_REQUIRED';
                throw reconciliation;
            }

            let sent = { providerId: operation.provider_id, providerResponse: operation.response, email: null };
            if (operation.status !== 'provider_sent') {
                sent = await sendEmailWithProvider({ connection, request: providerRequest, idempotencyKey: key });
                await markOutbound(db, operation.id, {
                    status: 'provider_sent', provider_id: sent.providerId, provider_status: 'accepted',
                    response: sent.providerResponse,
                });
            }

            // Re-normalise without making another provider call when resuming a
            // provider_sent operation.
            const delivered = sent.email || outboundEmailRequest(providerRequest);
            const sourceId = randomUUID();
            const emailRow = await db.from('email_messages').insert({
                id: sourceId,
                communication_id: communicationId,
                thread_id: thread.threadId,
                person_id: body.person_id || null,
                purpose: thread.purpose,
                correlation: thread.correlation,
                callback_url: thread.callbackUrl,
                provider_connection_id: connection.id,
                service_identity_id: serviceIdentity.id,
                provider_email_id: sent.providerId,
                direction: 'outbound',
                from_addresses: [delivered.from],
                to_addresses: delivered.to,
                cc_addresses: delivered.cc,
                bcc_addresses: delivered.bcc,
                reply_to_addresses: delivered.replyTo,
                subject: delivered.subject,
                text_body: delivered.text,
                sanitized_html: delivered.html,
                headers: {},
                occurred_at: new Date().toISOString(),
                delivery_status: 'accepted',
            });
            if (emailRow.error) throw new Error(emailRow.error.message);
            const communicationRow = await db.from('communications').insert({
                communication_id: communicationId,
                channel: 'email', direction: 'outbound', source_table: 'email_messages', source_id: sourceId,
                contact_id: body.person_id || null, person_id: body.person_id || null,
                occurred_at: new Date().toISOString(), subject: delivered.subject,
                body: delivered.text || delivered.html, provider: connection.provider, provider_id: sent.providerId,
                purpose: thread.purpose, correlation: thread.correlation, thread_id: thread.threadId,
                thread_link_type: 'explicit', memory_eligible: true,
                metadata: { provider_connection_id: connection.id },
            });
            if (communicationRow.error) throw new Error(communicationRow.error.message);

            const response = canonicalCommunication({
                tenantId: request.tenantId,
                communicationId,
                threadId: thread.threadId,
                channel: 'email', direction: 'outbound', content: delivered.text || delivered.html,
                provider: connection.provider, providerId: sent.providerId,
                correlation: thread.correlation, purpose: thread.purpose,
            });
            await enqueueEvent({
                tenantId: request.tenantId,
                type: 'email.accepted', communicationId, purpose: thread.purpose,
                correlation: thread.correlation, destination: thread.callbackUrl || connection.default_callback_url,
                dedupeKey: `email-accepted:${connection.id}:${sent.providerId}`,
                payload: { channel: 'email', direction: 'outbound', provider_id: sent.providerId, thread_id: thread.threadId },
            });
            await markOutbound(db, operation.id, { status: 'completed', response, completed_at: new Date().toISOString() });
            return reply.code(202).send(response);
        } catch (error) {
            if (operation?.id) {
                await markOutbound(db, operation.id, {
                    status: 'failed', response: { error: error.message }, completed_at: new Date().toISOString(),
                }).catch(() => {});
            }
            if (error.code === 'IDEMPOTENCY_REQUIRED') return errorReply(reply, error, 400);
            if (error.code === 'IDEMPOTENCY_CONFLICT') return errorReply(reply, error, 409);
            if (error.code === 'IDEMPOTENCY_IN_PROGRESS') return errorReply(reply, error, 409);
            if (error.code === 'IDEMPOTENCY_RECONCILIATION_REQUIRED') return errorReply(reply, error, 409);
            return errorReply(reply, error, error.status && error.status < 500 ? 400 : 502);
        }
    });

    fastify.get('/emails/:communicationId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const communication = await getCommunication(db, request.params.communicationId);
        if (!communication || communication.channel !== 'email') return reply.code(404).send({ error: 'Email not found' });
        const message = await db.from('email_messages').select('*').eq('communication_id', request.params.communicationId).maybeSingle();
        if (message.error) return errorReply(reply, new Error(message.error.message), 500);
        return { ...toCanonical(communication), email: message.data };
    });

    fastify.post('/calls', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const { to, from, overrides = {} } = request.body || {};
        if (!E164.test(to || '')) return reply.code(400).send({ error: '"to" must be an E.164 phone number' });
        if (!E164.test(from || '')) return reply.code(400).send({ error: '"from" must be an E.164 phone number' });
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return reply.code(400).send({ error: '"overrides" must be an object' });
        const unknownOverrides = Object.keys(overrides).filter((field) => !CALL_OVERRIDE_FIELDS.includes(field));
        if (unknownOverrides.length) return reply.code(400).send({ error: `Unknown override field(s): ${unknownOverrides.join(', ')}` });
        let semantic;
        try { semantic = parseSemantic(request.body); } catch (error) { return errorReply(reply, error); }

        const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_URL } = process.env;
        if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_URL) {
            return reply.code(503).send({ error: 'Twilio calling is not configured' });
        }

        let communicationId = prefixedId('comm');
        try {
            await assertContactable(to, 'outbound call', { allowed: request.body?.override_do_not_contact === true, reason: request.body?.override_reason });
            await ensureContact(to);
        } catch (error) {
            if (error.code === 'DO_NOT_CONTACT') return errorReply(reply, error, 409);
            return errorReply(reply, error, 500);
        }
        try {
            const operation = await reserveOutbound(db, {
                key: idempotencyKey(request), type: 'voice', communicationId,
                request: { to, from, overrides, purpose: semantic.purpose, correlation: semantic.correlation, thread_id: semantic.threadId,
                    override_do_not_contact: request.body?.override_do_not_contact, override_reason: request.body?.override_reason },
            });
            communicationId = operation.communication_id;
            if (operation.status === 'completed') return reply.code(200).send(operation.response);
            const resolved = await resolveConfig({ from, to, direction: 'outbound' });
            const config = { ...resolved, ...overrides, tenantId: request.tenantId };
            const base = PUBLIC_URL.replace(/\/$/, '');
            let call = { sid: operation.provider_id, status: operation.provider_status };
            if (operation.status !== 'provider_sent') {
                const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
                call = await client.calls.create({
                    to, from,
                    url: providerCallbackUrl(base, '/outbound-answer', request.tenantId),
                    statusCallback: providerCallbackUrl(base, '/call-status', request.tenantId),
                    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], statusCallbackMethod: 'POST',
                });
                await markOutbound(db, operation.id, { status: 'provider_sent', provider_id: call.sid, provider_status: call.status });
            }
            storeCallConfig(call.sid, config);
            const stored = await recordCall({
                callSid: call.sid, otherParty: to, serviceIdentity: from, direction: 'outbound', config,
                metadata: { from }, communicationId, tenantId: request.tenantId, ...semantic, strict: true,
            });
            await enqueueEvent({
                type: 'communication.created', communicationId, purpose: stored.purpose,
                correlation: stored.correlation, destination: stored.callbackUrl,
                payload: { channel: 'voice', direction: 'outbound' },
            });
            await enqueueEvent({
                type: 'call.started', communicationId, purpose: stored.purpose,
                correlation: stored.correlation, destination: stored.callbackUrl,
                payload: { status: call.status, channel: 'voice', direction: 'outbound' },
            });
            const response = canonicalCommunication({
                tenantId: request.tenantId, communicationId, threadId: stored.threadId,
                channel: 'voice', direction: 'outbound', provider: 'twilio',
                providerId: call.sid, correlation: stored.correlation, purpose: stored.purpose,
            });
            await markOutbound(db, operation.id, { status: 'completed', response, completed_at: new Date().toISOString() });
            return reply.code(201).send(response);
        } catch (error) {
            if (error.code === 'DO_NOT_CONTACT') return errorReply(reply, error, 409);
            if (error.code === 'IDEMPOTENCY_REQUIRED') return errorReply(reply, error, 400);
            if (error.code === 'IDEMPOTENCY_CONFLICT') return errorReply(reply, error, 409);
            if (error.code === 'IDEMPOTENCY_IN_PROGRESS') return errorReply(reply, error, 409);
            return errorReply(reply, outboundError('Failed to place call', error), 502);
        }
    });

    fastify.get('/calls/:communicationId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const row = await getCommunication(db, request.params.communicationId);
            if (!row || row.channel !== 'voice') return reply.code(404).send({ error: 'Call not found' });
            return toCanonical(row);
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.get('/contacts', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const { data, error } = await db.from('contacts').select('*').order('name').limit(200);
        if (error) return errorReply(reply, new Error(error.message), 500);
        return { data: data || [] };
    });

    fastify.post('/contacts', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const body = request.body || {};
        if (typeof body.name !== 'string' || !body.name.trim()) {
            return reply.code(400).send({ error: '"name" is required' });
        }
        const identities = Array.isArray(body.identities) ? body.identities : [];
        if (identities.some((identity) => typeof identity?.type !== 'string' || !identity.type || typeof identity?.value !== 'string' || !identity.value)) {
            return reply.code(400).send({ error: 'Every identity requires non-empty "type" and "value" strings' });
        }
        const phone = body.phone_number || identities.find((item) => item?.type === 'phone')?.value || null;
        if (phone && !E164.test(phone)) return reply.code(400).send({ error: 'Phone identity must be E.164' });

        const rows = identities.map((identity) => ({
            type: identity.type,
            value: identity.value,
            provider: identity.provider || null,
            metadata: identity.metadata || {},
        }));
        if (phone && !rows.some((row) => row.type === 'phone' && row.value === phone)) {
            rows.push({ type: 'phone', value: phone, provider: 'twilio', metadata: {} });
        }
        const created = await db.rpc('create_communication_contact', {
            p_name: body.name.trim(), p_phone_number: phone, p_identities: rows,
        });
        if (created.error) return errorReply(reply, new Error(created.error.message), 500);
        const person = created.data;
        return reply.code(201).send({ ...person, person_id: person.id, identities: rows });
    });

    fastify.get('/contacts/:personId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const [person, identities] = await Promise.all([
            db.from('contacts').select('*').eq('id', request.params.personId).maybeSingle(),
            db.from('communication_identities').select('*').eq('person_id', request.params.personId),
        ]);
        if (person.error) return errorReply(reply, new Error(person.error.message), 500);
        if (!person.data) return reply.code(404).send({ error: 'Contact not found' });
        return { ...person.data, person_id: person.data.id, identities: identities.data || [] };
    });

    fastify.get('/contacts/:personId/memory', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const memory = await getPersonMemory(db, request.params.personId);
            if (!memory) return reply.code(404).send({ error: 'Contact not found' });
            return memory;
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.get('/projects/:projectId/memory', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const memory = await getProjectMemory(db, request.params.projectId);
            if (!memory) return reply.code(404).send({ error: 'Project not found' });
            return memory;
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.post('/calendar/events', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const result = await ingestCalendarEvent(db, request.body || {});
            return reply.code(201).send(result);
        } catch (error) { return errorReply(reply, error, 400); }
    });

    fastify.get('/calendar/candidates', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        if (!request.query.person_id || !request.query.occurred_at) {
            return reply.code(400).send({ error: 'person_id and occurred_at are required' });
        }
        try {
            return { calendarCandidates: await calendarCandidates(db, {
                contactId: request.query.person_id, occurredAt: request.query.occurred_at,
                windowMinutes: Number(request.query.window_minutes) || undefined,
            }) };
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.get('/calendar/events/:eventId/context', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const eventId = await resolveCalendarEventId(db, request.params.eventId);
            if (!eventId) return reply.code(404).send({ error: 'Calendar event not found' });
            const context = await getEventContext(db, eventId);
            return context;
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.post('/context/search', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try { return await searchMemory(db, request.body || {}); }
        catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.get('/threads/:threadId', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const memory = await getThreadMemory(db, request.params.threadId);
            if (!memory) return reply.code(404).send({ error: 'Thread not found' });
            return { ...memory.thread, ...memory, communications: memory.communications.map(toCanonical) };
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.get('/loose-ends', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const data = await getLooseEnds(db, {
                personId: request.query.person_id || null,
                projectId: request.query.project_id || null,
                limit: request.query.limit,
            });
            return { data, count: data.length };
        } catch (error) { return errorReply(reply, error, 500); }
    });

    fastify.post('/commitments/:commitmentId/status', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const statuses = ['open', 'completed', 'cancelled', 'superseded', 'unknown'];
        if (!statuses.includes(request.body?.status)) return reply.code(400).send({ error: `status must be one of: ${statuses.join(', ')}` });
        const now = new Date().toISOString();
        const result = await db.from('communication_commitments').update({
            status: request.body.status, updated_at: now,
            resolved_at: ['completed', 'cancelled', 'superseded'].includes(request.body.status) ? now : null,
        }).eq('id', request.params.commitmentId).select('*').maybeSingle();
        if (result.error) return errorReply(reply, new Error(result.error.message), 500);
        if (!result.data) return reply.code(404).send({ error: 'Commitment not found' });
        return result.data;
    });

    fastify.post('/facts/:factId/status', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        if (!['active', 'retracted'].includes(request.body?.status)) return reply.code(400).send({ error: 'status must be active or retracted' });
        const result = await db.from('communication_facts').update({ status: request.body.status, updated_at: new Date().toISOString() })
            .eq('id', request.params.factId).select('*').maybeSingle();
        if (result.error) return errorReply(reply, new Error(result.error.message), 500);
        if (!result.data) return reply.code(404).send({ error: 'Fact not found' });
        return result.data;
    });

    // Communications does not decide whether a reply answers an Ask. Hyperflow
    // (the intent owner) explicitly calls this only after its resolver decides
    // that a particular communication is the answer. Follow-up questions stay
    // in the open thread and never become ask.resolved by accident.
    fastify.post('/asks/:askId/resolve', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const communicationId = request.body?.communication_id;
        if (typeof communicationId !== 'string' || !communicationId) {
            return reply.code(400).send({ error: '"communication_id" is required' });
        }
        const binding = await db.from('ask_bindings').select('*').eq('ask_id', request.params.askId).maybeSingle();
        if (binding.error) return errorReply(reply, new Error(binding.error.message), 500);
        if (!binding.data) return reply.code(404).send({ error: 'Ask is not bound to a communication thread' });
        if (binding.data.status === 'resolved') {
            if (binding.data.resolved_by === communicationId) {
                return { ask_id: request.params.askId, status: 'resolved', communication_id: communicationId,
                    thread_id: binding.data.thread_id, resolved_at: binding.data.resolved_at, duplicate: true };
            }
            return reply.code(409).send({ error: 'Ask was resolved by a different communication' });
        }
        if (binding.data.status !== 'open') return reply.code(409).send({ error: `Ask is ${binding.data.status}` });
        const communication = await getCommunication(db, communicationId);
        if (!communication || communication.thread_id !== binding.data.thread_id) {
            return reply.code(400).send({ error: 'The resolving communication is not in this Ask thread' });
        }
        const thread = await db.from('communication_threads').select('callback_url')
            .eq('thread_id', binding.data.thread_id).maybeSingle();
        if (thread.error) return errorReply(reply, new Error(thread.error.message), 500);

        const resolved = await db.rpc('resolve_communication_ask', {
            p_ask_id: request.params.askId,
            p_communication_id: communicationId,
        });
        if (resolved.error) return errorReply(reply, new Error(resolved.error.message), 500);

        await enqueueEvent({
            type: 'ask.resolved', communicationId, purpose: binding.data.purpose,
            correlation: communication.correlation || {}, destination: request.body?.callback_url || thread.data?.callback_url || null,
            payload: { ask_id: request.params.askId, thread_id: binding.data.thread_id },
        });
        return resolved.data;
    });

    fastify.get('/events', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const { data, error } = await db.from('outbound_events').select('*').order('created_at', { ascending: false }).limit(100);
        if (error) return errorReply(reply, new Error(error.message), 500);
        return { data: data || [] };
    });

    fastify.post('/events/:eventId/requeue', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const result = await db.from('outbound_events').update({
            status: 'pending', attempts: 0, last_error: null, next_attempt_at: new Date().toISOString(),
            lease_token: null, lease_expires_at: null,
        }).eq('event_id', request.params.eventId).select('*').maybeSingle();
        if (result.error) return errorReply(reply, new Error(result.error.message), 500);
        if (!result.data) return reply.code(404).send({ error: 'Event not found' });
        return { ...result.data, requeued: true };
    });
}

export { CHANNELS, DIRECTIONS, TERMINAL_CALL_STATUSES, toCanonical, parseSemantic, outboundError };

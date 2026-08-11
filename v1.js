import twilio from 'twilio';
import { E164, rejectUnauthorized } from './auth.js';
import { getSupabase, resolveConfig, ensureContact, storeCallConfig, warnIfSuppressed } from './configResolver.js';
import { recordMessage } from './smsLog.js';
import { recordCall } from './callLog.js';
import { enqueueEvent } from './eventOutbox.js';
import { randomUUID } from 'node:crypto';
import { canonicalCommunication, normaliseCorrelation, normalisePurpose, prefixedId, resolveCommunicationThread } from './communicationModel.js';
import { calendarCandidates, ingestCalendarEvent, resolveCalendarEvent, resolveCalendarEventId } from './calendar.js';
import { getEventContext, getLooseEnds, getPersonMemory, getProjectMemory, getThreadMemory, searchMemory } from './memory.js';

const CHANNELS = ['voice', 'sms', 'email', 'whatsapp', 'slack', 'teams', 'recording'];
const DIRECTIONS = ['inbound', 'outbound'];
const TERMINAL_CALL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];

function database(reply) {
    const db = getSupabase();
    if (!db) reply.code(503).send({ error: 'Communications persistence is not configured' });
    return db;
}

function errorReply(reply, error, status = 400) {
    return reply.code(status).send({ error: error.message });
}

function toCanonical(row) {
    return canonicalCommunication({
        communicationId: row.communication_id,
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
    return {
        purpose: normalisePurpose(body.purpose),
        correlation: normaliseCorrelation(body.correlation || body.metadata),
        threadId: body.thread_id || null,
        callbackUrl,
    };
}

export default async function v1Routes(fastify) {
    fastify.addHook('preHandler', async (request, reply) => rejectUnauthorized(request, reply, 'Communications API'));

    fastify.get('/communications', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
        let query = db.from('communications').select('*', { count: 'exact' })
            .order('occurred_at', { ascending: false }).limit(limit);
        if (request.query.channel) {
            if (!CHANNELS.includes(request.query.channel)) return reply.code(400).send({ error: 'Unknown channel' });
            query = query.eq('channel', request.query.channel);
        }
        if (request.query.thread_id) query = query.eq('thread_id', request.query.thread_id);
        if (request.query.ask_id) query = query.eq('purpose->>ask_id', request.query.ask_id);
        if (request.query.person_id) query = query.eq('person_id', request.query.person_id);
        const { data, error, count } = await query;
        if (error) return errorReply(reply, new Error(error.message), 500);
        return { data: (data || []).map(toCanonical), count, limit };
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
            const communicationId = prefixedId('comm');
            const requestedCalendarEvent = body.calendar_event_id || semantic.correlation.calendar_event_id || null;
            const calendarEvent = await resolveCalendarEvent(db, requestedCalendarEvent);
            const calendarEventId = calendarEvent?.id || null;
            if (requestedCalendarEvent && !calendarEvent) {
                return reply.code(400).send({ error: 'calendar_event_id did not resolve to exactly one calendar event' });
            }
            const projectId = body.project_id || calendarEvent?.project_id || semantic.correlation.project_id || null;
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

    fastify.post('/communications/:communicationId/enrich', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        try {
            const communication = await getCommunication(db, request.params.communicationId);
            if (!communication) return reply.code(404).send({ error: 'Communication not found' });
            const job = await db.from('communication_enrichment_jobs').upsert({
                communication_id: request.params.communicationId, job_type: 'memory', status: 'pending',
                attempts: 0, last_error: null, rerun_requested: false,
                next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            }, { onConflict: 'communication_id,job_type' }).select('*').single();
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

        const communicationId = prefixedId('comm');
        ensureContact(to);
        warnIfSuppressed(to, 'SMS');
        try {
            const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
            const message = await client.messages.create({
                to, from, body,
                ...(PUBLIC_URL ? { statusCallback: `${PUBLIC_URL.replace(/\/$/, '')}/message-status` } : {}),
            });
            const stored = await recordMessage({
                otherParty: to, twilioNumber: from, direction: 'outbound', body,
                messageSid: message.sid, status: message.status, communicationId,
                ...semantic, strict: true,
            });
            const communication = canonicalCommunication({
                communicationId, channel: 'sms', direction: 'outbound', content: body,
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
            return reply.code(201).send(communication);
        } catch (error) {
            return errorReply(reply, new Error(`Failed to send message: ${error.message}`), 502);
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

    fastify.post('/calls', async (request, reply) => {
        const db = database(reply); if (!db) return reply;
        const { to, from, overrides = {} } = request.body || {};
        if (!E164.test(to || '')) return reply.code(400).send({ error: '"to" must be an E.164 phone number' });
        if (!E164.test(from || '')) return reply.code(400).send({ error: '"from" must be an E.164 phone number' });
        let semantic;
        try { semantic = parseSemantic(request.body); } catch (error) { return errorReply(reply, error); }

        const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_URL } = process.env;
        if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_URL) {
            return reply.code(503).send({ error: 'Twilio calling is not configured' });
        }

        const communicationId = prefixedId('comm');
        try {
            const resolved = await resolveConfig({ from, to, direction: 'outbound' });
            const config = { ...resolved, ...overrides };
            const base = PUBLIC_URL.replace(/\/$/, '');
            const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
            const call = await client.calls.create({
                to, from, url: `${base}/outbound-answer`, statusCallback: `${base}/call-status`,
                statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], statusCallbackMethod: 'POST',
            });
            storeCallConfig(call.sid, config);
            const stored = await recordCall({
                callSid: call.sid, otherParty: to, serviceIdentity: from, direction: 'outbound', config,
                metadata: { from }, communicationId, ...semantic, strict: true,
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
            return reply.code(201).send(canonicalCommunication({
                communicationId, channel: 'voice', direction: 'outbound', provider: 'twilio',
                providerId: call.sid, correlation: stored.correlation, purpose: stored.purpose,
            }));
        } catch (error) {
            return errorReply(reply, new Error(`Failed to place call: ${error.message}`), 502);
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

        const { data: person, error } = await db.from('contacts').insert({
            name: body.name.trim(), phone_number: phone,
        }).select('*').single();
        if (error) return errorReply(reply, new Error(error.message), 500);

        const rows = identities.map((identity) => ({
            person_id: person.id,
            type: identity.type,
            value: identity.value,
            provider: identity.provider || null,
            metadata: identity.metadata || {},
        }));
        if (phone && !rows.some((row) => row.type === 'phone' && row.value === phone)) {
            rows.push({ person_id: person.id, type: 'phone', value: phone, provider: 'twilio', metadata: {} });
        }
        if (rows.length) {
            const identitiesWrite = await db.from('communication_identities').insert(rows);
            if (identitiesWrite.error) return errorReply(reply, new Error(identitiesWrite.error.message), 500);
        }
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
        if (binding.data.status === 'resolved') return reply.code(409).send({ error: 'Ask is already resolved' });
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
}

export { CHANNELS, DIRECTIONS, TERMINAL_CALL_STATUSES, toCanonical, parseSemantic };

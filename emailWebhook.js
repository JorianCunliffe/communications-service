import { randomUUID } from 'node:crypto';
import { canonicalEmail } from './email.js';
import { emailProvider } from './emailProviders.js';
import { triageEmail } from './emailTriage.js';
import {
    replyRouteAddressFromAddresses,
    replyTokenFromAddresses,
    resolveEmailReplyRoute,
    resolveLegacyEmailReplyRoute,
} from './emailReplyRoutes.js';
import { getDatabase } from './database.js';
import { enqueueEvent } from './eventOutbox.js';
import { prefixedId, resolveCommunicationThread } from './communicationModel.js';

const MAX_ATTEMPTS = 8;
let timer = null;

export function inboundEmailInput(eventData = {}, full = {}) {
    // The webhook recipient is the SMTP envelope Resend actually accepted. The
    // retrieve endpoint may canonicalise an alias back to the service mailbox,
    // which would erase our opaque reply+token route if it won precedence.
    return { ...full, ...eventData, provider_email_id: eventData.email_id };
}

function logSafeError(error) {
    return String(error?.message || error || 'Unknown error')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
        .replace(/https?:\/\/\S+/gi, '[url]')
        .slice(0, 500);
}

export function emailEnabled() {
    return ['1', 'true', 'yes'].includes(String(process.env.EMAIL_ENABLED || '').trim().toLowerCase());
}

export function installRawJsonParser(fastify) {
    if (fastify.hasContentTypeParser('application/json')) fastify.removeContentTypeParser('application/json');
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
        request.rawBody = body;
        try { done(null, body.length ? JSON.parse(body.toString('utf8')) : {}); }
        catch (error) { error.statusCode = 400; done(error); }
    });
}

function rawBody(request) {
    if (Buffer.isBuffer(request.rawBody)) return request.rawBody.toString('utf8');
    throw new Error('Raw webhook body is unavailable');
}

async function providerConnection(db, provider, connectionId) {
    const result = await db.from('provider_connections').select('*')
        .eq('id', connectionId).eq('provider', provider).eq('enabled', true).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data;
}

async function queueReceipt(db, connection, request, verified) {
    const provider = emailProvider(connection);
    const eventId = provider.providerEventId(request.headers);
    if (!eventId) throw new Error('Provider event ID is missing');
    const raw = rawBody(request);
    const row = {
        tenant_id: connection.tenant_id,
        provider_connection_id: connection.id,
        provider_event_id: eventId,
        provider_event_type: verified.type || null,
        raw_body: raw,
        raw_payload: verified,
        signature_headers: Object.fromEntries(Object.entries(request.headers)
            .filter(([name]) => name.startsWith('svix-'))),
        verified_at: new Date().toISOString(),
    };
    const inserted = await db.from('webhook_receipts').upsert(row, {
        onConflict: 'provider_connection_id,provider_event_id', ignoreDuplicates: true,
    });
    if (inserted.error) throw new Error(inserted.error.message);
    const receipt = await db.from('webhook_receipts').select('*')
        .eq('tenant_id', connection.tenant_id).eq('provider_connection_id', connection.id).eq('provider_event_id', eventId).maybeSingle();
    if (receipt.error || !receipt.data) throw new Error(receipt.error?.message || 'Could not confirm webhook receipt');
    if (receipt.data.processing_status === 'processed' || receipt.data.processing_status === 'ignored') return { receipt: receipt.data, duplicate: true };
    const job = await db.from('communication_jobs').upsert({
        tenant_id: connection.tenant_id,
        receipt_id: receipt.data.id,
        job_type: 'email_normalize',
        status: 'pending',
        next_attempt_at: new Date().toISOString(),
    }, { onConflict: 'receipt_id', ignoreDuplicates: true });
    if (job.error) throw new Error(job.error.message);
    return { receipt: receipt.data, duplicate: false };
}

async function findReceivingIdentity(db, tenantId, connectionId, addresses) {
    const candidates = [];
    for (const item of addresses) {
        const result = await db.from('service_identities').select('*')
            .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
            .eq('channel', 'email').eq('address', item.address).eq('can_receive', true).maybeSingle();
        if (result.error) throw new Error(result.error.message);
        if (result.data) candidates.push(result.data);
    }
    if (candidates.length !== 1) throw new Error('Inbound address did not resolve to exactly one trusted receiving identity');
    return candidates[0];
}

async function personForSender(db, tenantId, sender) {
    const identity = await db.from('communication_identities').select('person_id')
        .eq('tenant_id', tenantId).eq('type', 'email').eq('value', sender).maybeSingle();
    if (identity.error) throw new Error(identity.error.message);
    return identity.data?.person_id || null;
}

async function existingEmailThread(db, tenantId, email) {
    if (email.provider_conversation_id) {
        const match = await db.from('email_messages').select('thread_id,purpose,correlation,callback_url')
            .eq('tenant_id', tenantId).eq('provider_conversation_id', email.provider_conversation_id)
            .order('occurred_at', { ascending: false }).limit(2);
        if (match.error) throw new Error(match.error.message);
        const withThread = (match.data || []).filter((row) => row.thread_id);
        if (withThread.length === 1) return withThread[0];
    }
    const references = [email.in_reply_to, ...email.references_header].filter(Boolean);
    for (const reference of references) {
        const match = await db.from('email_messages').select('thread_id,purpose,correlation,callback_url')
            .eq('tenant_id', tenantId).eq('message_id', reference).limit(2);
        if (match.error) throw new Error(match.error.message);
        const withThread = (match.data || []).filter((row) => row.thread_id);
        if (withThread.length === 1) return withThread[0];
        if (withThread.length > 1) return null;
    }
    return null;
}

async function processInbound(db, receipt, connection, payload) {
    const provider = emailProvider(connection);
    const eventData = payload.data || {};
    const full = await provider.retrieveReceived(connection, eventData.email_id);
    const email = canonicalEmail(inboundEmailInput(eventData, full));
    const triage = triageEmail(email, payload.type);
    const token = replyTokenFromAddresses(email.to_addresses);
    let replyRoute = await resolveEmailReplyRoute(db, receipt.tenant_id, token);
    if (!replyRoute) replyRoute = await resolveLegacyEmailReplyRoute(db, receipt.tenant_id, email.to_addresses);
    let serviceIdentity;
    if (replyRoute) {
        const replyAddress = replyRouteAddressFromAddresses(email.to_addresses);
        const routed = await db.from('service_identities').select('*').eq('tenant_id', receipt.tenant_id)
            .eq('id', replyRoute.service_identity_id).eq('channel', 'email').maybeSingle();
        if (routed.error || !routed.data) throw new Error(routed.error?.message || 'Reply route receiving identity is unavailable');
        if (!replyAddress || String(routed.data.reply_domain || '').toLowerCase() !== replyAddress.domain) {
            throw new Error('Reply route domain does not match the receiving address');
        }
        serviceIdentity = routed.data;
    } else {
        serviceIdentity = await findReceivingIdentity(db, receipt.tenant_id, connection.id, email.to_addresses);
    }
    const personId = await personForSender(db, receipt.tenant_id, email.from_addresses[0].address);

    const nativeThread = replyRoute ? null : await existingEmailThread(db, receipt.tenant_id, email);
    const purpose = replyRoute?.ask_id
        ? { type: 'human_ask', ask_id: replyRoute.ask_id }
        : nativeThread?.purpose || null;
    const correlation = {
        ...(nativeThread?.correlation || {}),
        tenant_id: receipt.tenant_id,
        ...(replyRoute?.thread_id ? { thread_id: replyRoute.thread_id } : {}),
    };
    let semantic = await resolveCommunicationThread({
        db,
        tenantId: receipt.tenant_id,
        participantIdentity: email.from_addresses[0].address,
        serviceIdentity: serviceIdentity.address,
        direction: 'inbound',
        threadId: replyRoute?.thread_id || nativeThread?.thread_id || null,
        purpose,
        correlation,
        callbackUrl: nativeThread?.callback_url || connection.default_callback_url || null,
    });
    if (!semantic.threadId) {
        semantic = await resolveCommunicationThread({
            db,
            tenantId: receipt.tenant_id,
            participantIdentity: email.from_addresses[0].address,
            serviceIdentity: serviceIdentity.address,
            direction: 'inbound',
            threadId: prefixedId('thread'),
            purpose: null,
            correlation: { tenant_id: receipt.tenant_id },
            callbackUrl: connection.default_callback_url || null,
        });
    }

    const communicationId = prefixedId('comm');
    const sourceId = randomUUID();
    const emailRow = await db.from('email_messages').insert({
        id: sourceId,
        tenant_id: receipt.tenant_id,
        communication_id: communicationId,
        thread_id: semantic.threadId,
        person_id: personId,
        purpose: semantic.purpose,
        correlation: semantic.correlation,
        callback_url: semantic.callbackUrl,
        receipt_id: receipt.id,
        provider_connection_id: connection.id,
        service_identity_id: serviceIdentity.id,
        ...email,
        direction: 'inbound',
        triage_class: triage.classification,
        automated: triage.automated,
        bounce: triage.bounce,
        memory_eligible: triage.memoryEligible,
        delivery_status: 'received',
    }).select('*').single();
    if (emailRow.error) throw new Error(emailRow.error.message);

    const communication = await db.from('communications').insert({
        tenant_id: receipt.tenant_id,
        communication_id: communicationId,
        channel: 'email',
        direction: 'inbound',
        source_table: 'email_messages',
        source_id: sourceId,
        contact_id: personId,
        person_id: personId,
        occurred_at: email.occurred_at,
        subject: email.subject,
        body: email.text_body || email.sanitized_html,
        body_them: email.text_body || email.sanitized_html,
        provider: connection.provider,
        provider_id: email.provider_email_id,
        purpose: semantic.purpose,
        correlation: semantic.correlation,
        thread_id: semantic.threadId,
        thread_link_type: semantic.linkType || 'native',
        memory_eligible: triage.memoryEligible,
        disposition: triage.classification,
        metadata: { provider_connection_id: connection.id, message_id: email.message_id },
    });
    if (communication.error) throw new Error(communication.error.message);

    if (email.attachments.length) {
        const rows = email.attachments.map((item) => ({
            tenant_id: receipt.tenant_id,
            communication_id: communicationId,
            email_message_id: sourceId,
            provider_attachment_id: item.id || null,
            filename: item.filename || null,
            content_type: item.content_type || null,
            size_bytes: item.size || null,
            content_disposition: item.content_disposition || null,
            content_id: item.content_id || null,
        }));
        const attachments = await db.from('communication_attachments').insert(rows);
        if (attachments.error) throw new Error(attachments.error.message);
    }

    const eventBase = {
        tenantId: receipt.tenant_id,
        communicationId,
        purpose: semantic.purpose,
        correlation: semantic.correlation,
        destination: semantic.callbackUrl || connection.default_callback_url,
        payload: { channel: 'email', thread_id: semantic.threadId, triage: triage.classification },
    };
    await enqueueEvent({ ...eventBase, type: 'communication.received', dedupeKey: `email-received:${connection.id}:${email.provider_email_id}` });
    if (triage.askResponseEligible && semantic.purpose?.type === 'human_ask') {
        await enqueueEvent({ ...eventBase, type: 'ask.response.received', dedupeKey: `email-ask-response:${connection.id}:${email.provider_email_id}` });
    }
}

async function processDelivery(db, receipt, connection, payload) {
    const providerId = payload.data?.email_id;
    if (!providerId) return;
    const found = await db.from('email_messages').select('*').eq('tenant_id', receipt.tenant_id)
        .eq('provider_connection_id', connection.id).eq('provider_email_id', providerId).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    if (!found.data) return;
    const failed = ['email.failed', 'email.bounced', 'email.suppressed'].includes(payload.type);
    const delivered = payload.type === 'email.delivered';
    const update = await db.from('email_messages').update({ delivery_status: payload.type.replace('email.', ''), updated_at: new Date().toISOString() })
        .eq('tenant_id', receipt.tenant_id).eq('id', found.data.id);
    if (update.error) throw new Error(update.error.message);
    if (failed || delivered) {
        await enqueueEvent({
            tenantId: receipt.tenant_id,
            type: failed ? 'email.failed' : 'email.delivered',
            communicationId: found.data.communication_id,
            purpose: found.data.purpose,
            correlation: found.data.correlation || {},
            destination: found.data.callback_url || connection.default_callback_url,
            dedupeKey: `${payload.type}:${connection.id}:${providerId}`,
            payload: { channel: 'email', provider_id: providerId, provider_event: payload.type },
        });
    }
}

async function finishJob(db, job, receipt, values) {
    const jobUpdate = await db.from('communication_jobs').update({
        ...values, lease_token: null, lease_expires_at: null, updated_at: new Date().toISOString(),
    }).eq('tenant_id', job.tenant_id).eq('id', job.id).eq('lease_token', job.lease_token);
    if (jobUpdate.error) throw new Error(jobUpdate.error.message);
    const receiptUpdate = await db.from('webhook_receipts').update({
        processing_status: values.status === 'done' ? 'processed' : values.status,
        processed_at: values.status === 'done' ? new Date().toISOString() : null,
        last_error: values.last_error || null,
    }).eq('tenant_id', receipt.tenant_id).eq('id', receipt.id);
    if (receiptUpdate.error) throw new Error(receiptUpdate.error.message);
}

export async function processCommunicationJobs() {
    const db = getDatabase();
    if (!db || !emailEnabled()) return { attempted: 0, completed: 0 };
    const claimed = await db.rpc('claim_communication_jobs', { p_limit: 20, p_lease_seconds: 90 });
    if (claimed.error) throw new Error(`Could not claim communication jobs: ${claimed.error.message}`);
    let completed = 0;
    for (const job of claimed.data || []) {
        const receiptResult = await db.from('webhook_receipts').select('*').eq('tenant_id', job.tenant_id).eq('id', job.receipt_id).maybeSingle();
        let stage = 'receipt_lookup';
        try {
            if (receiptResult.error || !receiptResult.data) throw new Error(receiptResult.error?.message || 'Webhook receipt is missing');
            const receipt = receiptResult.data;
            stage = 'connection_lookup';
            const connectionResult = await db.from('provider_connections').select('*').eq('tenant_id', receipt.tenant_id)
                .eq('id', receipt.provider_connection_id).maybeSingle();
            if (connectionResult.error || !connectionResult.data) throw new Error(connectionResult.error?.message || 'Provider connection is missing');
            const payload = receipt.raw_payload;
            stage = payload.type === 'email.received' ? 'inbound_normalization' : 'delivery_normalization';
            if (payload.type === 'email.received') await processInbound(db, receipt, connectionResult.data, payload);
            else if (String(payload.type || '').startsWith('email.')) await processDelivery(db, receipt, connectionResult.data, payload);
            stage = 'job_completion';
            await finishJob(db, job, receipt, { status: 'done', completed_at: new Date().toISOString(), last_error: null });
            completed += 1;
        } catch (error) {
            const exhausted = job.attempts >= MAX_ATTEMPTS || error.retryable === false;
            const delay = Math.min(60 * 60 * 1000, 5000 * (2 ** Math.min(job.attempts, 8)));
            console.warn(`Email job ${job.id} stage ${stage} attempt ${job.attempts} ${exhausted ? 'failed' : 'deferred'}: ${logSafeError(error)}`);
            if (receiptResult.data) await finishJob(db, job, receiptResult.data, {
                status: exhausted ? 'failed' : 'pending',
                next_attempt_at: new Date(Date.now() + delay).toISOString(),
                completed_at: exhausted ? new Date().toISOString() : null,
                last_error: error.message.slice(0, 500),
            });
        }
    }
    return { attempted: claimed.data?.length || 0, completed };
}

export function startCommunicationJobSweeper() {
    if (timer || !getDatabase() || !emailEnabled()) return;
    const sweep = () => processCommunicationJobs().catch((error) => console.warn(`Email jobs: ${error.message}`));
    timer = setInterval(sweep, 15000);
    timer.unref?.();
    sweep();
}

export default async function emailWebhookRoutes(fastify) {
    fastify.post('/email/:provider/:connectionId', async (request, reply) => {
        if (!emailEnabled()) return reply.code(404).send({ error: 'Email webhooks are disabled' });
        const db = getDatabase();
        if (!db) return reply.code(503).send({ error: 'Communications persistence is not configured' });
        try {
            const connection = await providerConnection(db, request.params.provider, request.params.connectionId);
            if (!connection) return reply.code(404).send({ error: 'Provider connection not found' });
            const verified = emailProvider(connection).verifyWebhook({ connection, rawBody: rawBody(request), headers: request.headers });
            const queued = await queueReceipt(db, connection, request, verified);
            return reply.code(200).send({ accepted: true, duplicate: queued.duplicate, receipt_id: queued.receipt.id });
        } catch (error) {
            console.warn(`Rejected email webhook: ${error.message}`);
            return reply.code(400).send({ error: 'Invalid email webhook' });
        }
    });
}

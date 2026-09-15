import { openMailboxCredential, sealMailboxCredential, mailboxKeyFingerprint } from './mailboxCrypto.js';
import { updateGmailDraft, usableGmailCredential } from './gmailMailbox.js';
import { updateOutlookDraft, usableOutlookCredential } from './outlookMailbox.js';
import { markOutbound, reserveOutbound } from './outboundOperations.js';

function credentialAad(tenantId, connectionId) {
    return `communications-mailbox:${tenantId}:${connectionId}`;
}

async function writeAudit(db, tenantId, connectionId, actorId, action, outcome, details = {}) {
    const result = await db.from('mailbox_audit_events').insert({
        tenant_id: tenantId,
        provider_connection_id: connectionId || null,
        actor_id: actorId || null,
        action,
        outcome,
        details,
    });
    if (result.error) throw new Error(`Could not write mailbox audit event: ${result.error.message}`);
}

async function saveCredential(db, tenantId, connectionId, credential) {
    const result = await db.from('mailbox_oauth_credentials').upsert({
        tenant_id: tenantId,
        provider_connection_id: connectionId,
        encrypted_payload: sealMailboxCredential(credential, credentialAad(tenantId, connectionId)),
        key_fingerprint: mailboxKeyFingerprint(),
        updated_at: new Date().toISOString(),
    }, { onConflict: 'provider_connection_id' });
    if (result.error) throw new Error(`Could not store mailbox credential: ${result.error.message}`);
}

async function selectedConnection(db, tenantId, connectionId) {
    const result = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('id', connectionId).eq('enabled', true).maybeSingle();
    if (result.error) throw new Error(`Could not load mailbox connection: ${result.error.message}`);
    if (!result.data || !['gmail', 'outlook'].includes(result.data.provider) || !(result.data.channels || []).includes('email')) {
        throw Object.assign(new Error('Mailbox connection is unavailable'), { status: 404 });
    }
    return result.data;
}

async function accessCredential(db, tenantId, connection) {
    const stored = await db.from('mailbox_oauth_credentials').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connection.id).maybeSingle();
    if (stored.error) throw new Error(`Could not load mailbox credential: ${stored.error.message}`);
    if (!stored.data) throw Object.assign(new Error('Mailbox credential is unavailable'), { status: 409 });
    const credential = openMailboxCredential(stored.data.encrypted_payload, credentialAad(tenantId, connection.id));
    const usable = connection.provider === 'outlook'
        ? await usableOutlookCredential(credential)
        : await usableGmailCredential(credential);
    if (usable.refreshed) await saveCredential(db, tenantId, connection.id, usable.credential);
    return usable.credential;
}

function stableResponse(record, providerDraft, request) {
    const message = providerDraft?.message || {};
    return {
        id: record.id,
        provider_draft_id: record.provider_draft_id,
        provider_message_id: message.id || record.provider_message_id || null,
        provider_thread_id: message.threadId || message.conversationId || request.provider_thread_id || record.provider_thread_id || null,
        status: 'created',
        updated_at: new Date().toISOString(),
    };
}

async function recordDraftFailure(db, tenantId, recordId, error) {
    try {
        await db.from('mailbox_drafts').update({
            last_error: String(error.message || error).slice(0, 500),
            updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', recordId);
    } catch (_) {
        // The original provider/idempotency error is more useful than a secondary audit write failure.
    }
}

export async function updateMailboxDraft(db, {
    tenantId,
    connectionId,
    draftId,
    actorId = null,
    idempotencyKey,
    request,
}, dependencies = {}) {
    const reserveOperation = dependencies.reserveOperation || reserveOutbound;
    const markOperation = dependencies.markOperation || markOutbound;
    const credentialProvider = dependencies.credentialProvider || accessCredential;
    const audit = dependencies.audit || writeAudit;
    const providers = dependencies.providers || {
        outlook: (credential, id, input) => updateOutlookDraft(credential.access_token, id, input),
        gmail: (credential, id, input, connection) => updateGmailDraft(credential.access_token, id, input, connection.provider_account_id),
    };

    if (!idempotencyKey) {
        const error = new Error('Idempotency-Key header is required for mailbox draft updates');
        error.code = 'IDEMPOTENCY_REQUIRED';
        error.status = 400;
        throw error;
    }
    const recordResult = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('provider_draft_id', draftId).maybeSingle();
    if (recordResult.error) throw new Error(recordResult.error.message);
    if (!recordResult.data) throw Object.assign(new Error('Mailbox draft not found'), { status: 404 });
    const record = recordResult.data;
    const connection = await selectedConnection(db, tenantId, connectionId);
    const operationRequest = {
        connection_id: connectionId,
        draft_id: draftId,
        to: request.to,
        cc: request.cc || [],
        bcc: request.bcc || [],
        reply_to: request.reply_to || [],
        subject: request.subject,
        text: request.text || null,
        html: request.html || null,
        provider_thread_id: request.provider_thread_id || record.provider_thread_id || null,
    };
    let operation;
    try {
        operation = await reserveOperation(db, {
            tenantId,
            key: idempotencyKey,
            type: 'mailbox_draft_update',
            communicationId: record.communication_id || `draft:${record.id}`,
            request: operationRequest,
        });
        if (operation.status === 'completed') return operation.response;
        const credential = await credentialProvider(db, tenantId, connection);
        const providerRequest = {
            ...request,
            provider_thread_id: request.provider_thread_id || record.provider_thread_id || undefined,
        };
        const providerUpdate = providers[connection.provider];
        if (typeof providerUpdate !== 'function') throw new Error(`Unsupported mailbox provider: ${connection.provider}`);
        const providerDraft = await providerUpdate(credential, draftId, providerRequest, connection);
        if (providerDraft?.id !== draftId) {
            const error = new Error('Provider changed the draft identity during update');
            error.code = 'DRAFT_IDENTITY_CHANGED';
            error.status = 409;
            throw error;
        }
        const response = stableResponse(record, providerDraft, providerRequest);
        const updated = await db.from('mailbox_drafts').update({
            provider_message_id: response.provider_message_id,
            provider_thread_id: response.provider_thread_id,
            status: 'created',
            last_error: null,
            updated_at: response.updated_at,
        }).eq('tenant_id', tenantId).eq('id', record.id).select('*').single();
        if (updated.error) throw new Error(updated.error.message);
        await markOperation(db, operation.id, {
            status: 'completed',
            provider_id: draftId,
            response,
            completed_at: response.updated_at,
        });
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.updated', 'succeeded', {
            draft_id: draftId,
            provider: connection.provider,
        });
        return response;
    } catch (error) {
        if (operation?.id) {
            await markOperation(db, operation.id, {
                status: 'failed',
                response: { error: error.message, code: error.code || null },
                completed_at: new Date().toISOString(),
            }).catch(() => {});
        }
        await recordDraftFailure(db, tenantId, record.id, error);
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.updated', 'failed', {
            draft_id: draftId,
            error: String(error.message || error).slice(0, 200),
        }).catch(() => {});
        throw error;
    }
}
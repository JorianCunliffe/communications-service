import { createHash } from 'node:crypto';
import { ingestCanonicalInboundEmail } from './emailWebhook.js';
import {
    createGmailDraft,
    GmailMessageNormalizationError,
    getGmailDraft,
    gmailHistoryMessageIds,
    gmailInitialMessageIds,
    gmailMessage,
    gmailProfile,
    startGmailWatch,
    usableGmailCredential,
} from './gmailMailbox.js';
import { mailboxKeyFingerprint, openMailboxCredential, sealMailboxCredential } from './mailboxCrypto.js';

function connectionRef(connection, state) {
    return {
        id: connection.id,
        provider: connection.provider,
        mailbox_address: connection.provider_account_id,
        display_name: connection.display_name || null,
        state: state?.status || connection.metadata?.state || 'pending',
        scopes: Array.isArray(connection.metadata?.scopes) ? connection.metadata.scopes : [],
        last_successful_sync_at: state?.last_successful_sync_at || null,
        watch_expiration: state?.watch_expiration || null,
        last_error: state?.last_error || null,
        can_send: false,
        can_create_drafts: true,
    };
}

async function audit(db, tenantId, connectionId, actorId, action, outcome, details = {}) {
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

function credentialAad(tenantId, connectionId) {
    return `communications-mailbox:${tenantId}:${connectionId}`;
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

async function loadCredential(db, tenantId, connectionId) {
    const result = await db.from('mailbox_oauth_credentials').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).maybeSingle();
    if (result.error) throw new Error(`Could not load mailbox credential: ${result.error.message}`);
    if (!result.data) throw new Error('Mailbox credential is unavailable');
    return openMailboxCredential(result.data.encrypted_payload, credentialAad(tenantId, connectionId));
}

async function accessCredential(db, tenantId, connectionId) {
    const stored = await loadCredential(db, tenantId, connectionId);
    const usable = await usableGmailCredential(stored);
    if (usable.refreshed) await saveCredential(db, tenantId, connectionId, usable.credential);
    return usable.credential;
}

async function selectedConnection(db, tenantId, connectionId) {
    const result = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('id', connectionId).eq('enabled', true).maybeSingle();
    if (result.error) throw new Error(`Could not load mailbox connection: ${result.error.message}`);
    if (!result.data || result.data.provider !== 'gmail' || !(result.data.channels || []).includes('email')) {
        throw new Error('Gmail mailbox connection is unavailable');
    }
    return result.data;
}

async function receivingIdentity(db, tenantId, connectionId) {
    const result = await db.from('service_identities').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('channel', 'email').eq('can_receive', true).maybeSingle();
    if (result.error) throw new Error(`Could not load mailbox identity: ${result.error.message}`);
    if (!result.data) throw new Error('Mailbox receiving identity is unavailable');
    return result.data;
}

export async function connectGmailMailbox(db, { tenantId, initiatorId, tokens, scopes }) {
    const credential = {
        ...tokens,
        expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        scopes,
    };
    const profile = await gmailProfile(credential.access_token);
    const mailboxAddress = String(profile.emailAddress || '').trim().toLowerCase();
    if (!mailboxAddress) throw new Error('Google did not return a Gmail mailbox address');
    const found = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('provider', 'gmail').eq('provider_account_id', mailboxAddress).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    let connection = found.data;
    const existingIdentity = await db.from('service_identities').select('*')
        .eq('tenant_id', tenantId).eq('channel', 'email').eq('address', mailboxAddress).maybeSingle();
    if (existingIdentity.error) throw new Error(existingIdentity.error.message);
    if (existingIdentity.data && existingIdentity.data.provider_connection_id !== connection?.id) {
        throw new Error('This mailbox address is already assigned to a different tenant email connection');
    }
    const values = {
        provider: 'gmail',
        provider_account_id: mailboxAddress,
        display_name: mailboxAddress,
        credential_reference: 'db:mailbox_oauth_credentials',
        channels: ['email'],
        default_callback_url: process.env.HYPERFLOW_EVENT_URL || null,
        enabled: true,
        metadata: { connection_type: 'connected_mailbox', scopes, state: 'connected' },
        updated_at: new Date().toISOString(),
    };
    if (connection) {
        const updated = await db.from('provider_connections').update(values).eq('tenant_id', tenantId).eq('id', connection.id).select('*').single();
        if (updated.error) throw new Error(updated.error.message);
        connection = updated.data;
    } else {
        const inserted = await db.from('provider_connections').insert({ tenant_id: tenantId, ...values }).select('*').single();
        if (inserted.error) throw new Error(inserted.error.message);
        connection = inserted.data;
    }
    await saveCredential(db, tenantId, connection.id, credential);
    const identityValues = {
        tenant_id: tenantId, provider_connection_id: connection.id, channel: 'email', address: mailboxAddress,
        display_name: mailboxAddress, can_send: false, can_receive: true, is_default: false,
        metadata: { connected_mailbox: true, draft_only: true }, updated_at: new Date().toISOString(),
    };
    const identity = existingIdentity.data
        ? await db.from('service_identities').update(identityValues).eq('tenant_id', tenantId).eq('id', existingIdentity.data.id).select('*').single()
        : await db.from('service_identities').insert(identityValues).select('*').single();
    if (identity.error) throw new Error(identity.error.message);
    const watch = await startGmailWatch(credential.access_token);
    const state = await db.from('mailbox_sync_state').upsert({
        tenant_id: tenantId,
        provider_connection_id: connection.id,
        history_id: watch?.historyId || profile.historyId || null,
        watch_expiration: watch?.expiration ? new Date(Number(watch.expiration)).toISOString() : null,
        status: 'pending',
        last_error: null,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'provider_connection_id' }).select('*').single();
    if (state.error) throw new Error(state.error.message);
    await audit(db, tenantId, connection.id, initiatorId, 'mailbox.connected', 'succeeded', { provider: 'gmail', watch_enabled: Boolean(watch) });
    return connectionRef(connection, state.data);
}

export async function listMailboxConnections(db, tenantId) {
    const connections = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('enabled', true).order('updated_at', { ascending: false }).limit(100);
    if (connections.error) throw new Error(connections.error.message);
    const supported = (connections.data || []).filter((item) => ['gmail', 'outlook'].includes(item.provider));
    const states = await db.from('mailbox_sync_state').select('*').eq('tenant_id', tenantId).limit(100);
    if (states.error) throw new Error(states.error.message);
    const byConnection = new Map((states.data || []).map((item) => [item.provider_connection_id, item]));
    return supported.map((connection) => connectionRef(connection, byConnection.get(connection.id)));
}

async function markSync(db, tenantId, connectionId, values) {
    const result = await db.from('mailbox_sync_state').update({ ...values, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId);
    if (result.error) throw new Error(result.error.message);
}

export async function syncGmailMailbox(db, { tenantId, connectionId, actorId = null, maxMessages = 1000 }) {
    const connection = await selectedConnection(db, tenantId, connectionId);
    const identity = await receivingIdentity(db, tenantId, connectionId);
    const claimed = await db.rpc('claim_mailbox_sync', {
        p_tenant_id: tenantId,
        p_provider_connection_id: connectionId,
        p_lease_seconds: 300,
    });
    if (claimed.error) throw new Error(`Could not claim mailbox sync: ${claimed.error.message}`);
    if (claimed.data !== true) return { connection_id: connectionId, status: 'syncing', in_progress: true };
    try {
        const credential = await accessCredential(db, tenantId, connectionId);
        const state = await db.from('mailbox_sync_state').select('*')
            .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).maybeSingle();
        if (state.error) throw new Error(state.error.message);
        let messageIds;
        let nextHistoryId;
        let recovered = false;
        if (state.data?.history_id && state.data?.last_successful_sync_at) {
            try {
                const history = await gmailHistoryMessageIds(credential.access_token, state.data.history_id);
                messageIds = history.messageIds;
                nextHistoryId = history.historyId;
            } catch (error) {
                if (error.status !== 404) throw error;
                recovered = true;
                const profile = await gmailProfile(credential.access_token);
                messageIds = await gmailInitialMessageIds(credential.access_token, { maxMessages });
                nextHistoryId = profile.historyId;
            }
        } else {
            const profile = await gmailProfile(credential.access_token);
            messageIds = await gmailInitialMessageIds(credential.access_token, { maxMessages });
            nextHistoryId = profile.historyId;
            if (state.data?.history_id) {
                try {
                    const catchup = await gmailHistoryMessageIds(credential.access_token, state.data.history_id);
                    messageIds = [...new Set([...messageIds, ...catchup.messageIds])];
                    nextHistoryId = catchup.historyId || nextHistoryId;
                } catch (error) {
                    if (error.status !== 404) throw error;
                    recovered = true;
                }
            }
        }
        let ingested = 0;
        let duplicates = 0;
        let skipped = 0;
        for (const messageId of messageIds) {
            let email;
            try {
                email = await gmailMessage(credential.access_token, messageId, connection.provider_account_id);
            } catch (error) {
                if (!(error instanceof GmailMessageNormalizationError)) throw error;
                skipped += 1;
                continue;
            }
            if (!email.providerLabels.includes('INBOX')) continue;
            const outcome = await ingestCanonicalInboundEmail({
                db,
                tenantId,
                connection,
                email,
                serviceIdentityId: identity.id,
                providerEventType: 'gmail.message.received',
            });
            if (outcome.duplicate) duplicates += 1;
            else ingested += 1;
        }
        const watch = !state.data?.watch_expiration || new Date(state.data.watch_expiration).valueOf() < Date.now() + 24 * 60 * 60 * 1000
            ? await startGmailWatch(credential.access_token)
            : null;
        await markSync(db, tenantId, connectionId, {
            history_id: watch?.historyId || nextHistoryId,
            ...(watch?.expiration ? { watch_expiration: new Date(Number(watch.expiration)).toISOString() } : {}),
            status: 'healthy',
            last_successful_sync_at: new Date().toISOString(),
            last_error: null,
        });
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'succeeded', { ingested, duplicates, skipped, recovered });
        return { connection_id: connectionId, status: 'healthy', ingested, duplicates, skipped, recovered, history_id: watch?.historyId || nextHistoryId };
    } catch (error) {
        const state = [401, 403].includes(error.status) ? 'expired' : 'degraded';
        await markSync(db, tenantId, connectionId, { status: state, last_error: String(error.message || error).slice(0, 500) }).catch(() => {});
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'failed', { error: String(error.message || error).slice(0, 200) }).catch(() => {});
        throw error;
    }
}

function requestHash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function createMailboxDraft(db, { tenantId, connectionId, actorId = null, idempotencyKey, request }) {
    if (!idempotencyKey) throw new Error('Idempotency-Key header is required for mailbox drafts');
    const connection = await selectedConnection(db, tenantId, connectionId);
    const hash = requestHash(request);
    const existing = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
        if (existing.data.request_hash !== hash) {
            const error = new Error('Idempotency key was already used with different draft content');
            error.status = 409;
            throw error;
        }
        if (existing.data.status === 'created') return existing.data;
        const error = new Error('Draft operation requires provider reconciliation before retry');
        error.status = 409;
        throw error;
    }
    const reserved = await db.from('mailbox_drafts').insert({
        tenant_id: tenantId,
        provider_connection_id: connectionId,
        communication_id: request.communication_id || null,
        idempotency_key: idempotencyKey,
        request_hash: hash,
        status: 'creating',
    }).select('*').single();
    if (reserved.error) {
        const raced = await db.from('mailbox_drafts').select('*')
            .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).eq('idempotency_key', idempotencyKey).maybeSingle();
        if (raced.error) throw new Error(raced.error.message);
        if (!raced.data) throw new Error(reserved.error.message);
        if (raced.data.request_hash !== hash) {
            const error = new Error('Idempotency key was already used with different draft content');
            error.status = 409;
            throw error;
        }
        if (raced.data.status === 'created') return raced.data;
        const error = new Error('Draft operation is already in progress; reconcile it before retry');
        error.status = 409;
        throw error;
    }
    try {
        const credential = await accessCredential(db, tenantId, connectionId);
        const draft = await createGmailDraft(credential.access_token, request, connection.provider_account_id);
        const updated = await db.from('mailbox_drafts').update({
            provider_draft_id: draft.id,
            provider_message_id: draft.message?.id || null,
            provider_thread_id: draft.message?.threadId || request.provider_thread_id || null,
            status: 'created',
            last_error: null,
            updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', reserved.data.id).select('*').single();
        if (updated.error) throw new Error(updated.error.message);
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.created', 'succeeded', { draft_id: draft.id });
        return updated.data;
    } catch (error) {
        await db.from('mailbox_drafts').update({ status: 'failed', last_error: String(error.message || error).slice(0, 500), updated_at: new Date().toISOString() })
            .eq('tenant_id', tenantId).eq('id', reserved.data.id);
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.created', 'failed', { error: String(error.message || error).slice(0, 200) }).catch(() => {});
        throw error;
    }
}

export async function getMailboxDraft(db, { tenantId, connectionId, draftId }) {
    const record = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).eq('provider_draft_id', draftId).maybeSingle();
    if (record.error) throw new Error(record.error.message);
    if (!record.data) return null;
    const credential = await accessCredential(db, tenantId, connectionId);
    const provider = await getGmailDraft(credential.access_token, draftId);
    return { ...record.data, provider: { id: provider.id, message_id: provider.message?.id, thread_id: provider.message?.threadId } };
}

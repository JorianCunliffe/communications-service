import { createHash } from 'node:crypto';
import { ingestCanonicalInboundEmail } from './emailWebhook.js';
import { safeHtml } from './email.js';
import {
    createGmailDraft,
    updateGmailDraft,
    GmailMessageNormalizationError,
    GmailMessageUnavailableError,
    getGmailDraft,
    gmailDraftEditableFields,
    gmailDraftHasAttachments,
    gmailHistoryMessageIds,
    gmailInitialMessageIds,
    gmailMessage,
    gmailProfile,
    startGmailWatch,
    usableGmailCredential,
} from './gmailMailbox.js';
import { mailboxKeyFingerprint, openMailboxCredential, sealMailboxCredential } from './mailboxCrypto.js';
import { microsoftDirectoryTenantId } from './mailboxOAuth.js';
import {
    createOutlookDraft,
    updateOutlookDraft,
    getOutlookDraft,
    outlookDraftEditableFields,
    OutlookMessageNormalizationError,
    outlookDeltaMessages,
    outlookMessage,
    outlookProfile,
    usableOutlookCredential,
} from './outlookMailbox.js';

function connectionRef(connection, state) {
    const scopes = Array.isArray(connection.metadata?.scopes) ? connection.metadata.scopes : [];
    const canCreateDrafts = connection.provider === 'outlook'
        ? scopes.some((scope) => String(scope).toLowerCase() === 'mail.readwrite')
        : scopes.includes('https://www.googleapis.com/auth/gmail.compose');
    const status = state?.status || connection.metadata?.state || 'pending';
    const remediation = status === 'revoked'
        ? 'Reconnect the mailbox and grant consent again'
        : status === 'expired'
            ? 'Reconnect the mailbox because its refresh credential is no longer usable'
            : status === 'degraded'
                ? 'Retry synchronization; reconnect if the error persists'
                : null;
    return {
        id: connection.id,
        provider: connection.provider,
        mailbox_address: connection.provider_account_id,
        display_name: connection.display_name || null,
        state: status,
        scopes,
        last_successful_sync_at: state?.last_successful_sync_at || null,
        watch_expiration: state?.watch_expiration || null,
        last_error: state?.last_error || null,
        can_send: false,
        can_create_drafts: canCreateDrafts,
        remediation,
        provider_tenant_id: connection.provider === 'outlook' ? (connection.metadata?.provider_tenant_id || null) : null,
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

async function accessCredential(db, tenantId, connection) {
    const connectionId = connection.id;
    const stored = await loadCredential(db, tenantId, connectionId);
    const usable = connection.provider === 'outlook'
        ? await usableOutlookCredential(stored)
        : await usableGmailCredential(stored);
    if (usable.refreshed) await saveCredential(db, tenantId, connectionId, usable.credential);
    return usable.credential;
}

async function selectedConnection(db, tenantId, connectionId) {
    const result = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('id', connectionId).eq('enabled', true).maybeSingle();
    if (result.error) throw new Error(`Could not load mailbox connection: ${result.error.message}`);
    if (!result.data || !['gmail', 'outlook'].includes(result.data.provider) || !(result.data.channels || []).includes('email')) {
        throw new Error('Mailbox connection is unavailable');
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
        metadata: { connection_type: 'connected_mailbox', scopes, state: 'connected', provider_tenant_id: providerTenantId },
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
        metadata: { connected_mailbox: true, draft_only: true, provider_tenant_id: providerTenantId }, updated_at: new Date().toISOString(),
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
        provider_cursor: watch?.historyId || profile.historyId || null,
        watch_expiration: watch?.expiration ? new Date(Number(watch.expiration)).toISOString() : null,
        status: 'pending',
        last_error: null,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'provider_connection_id' }).select('*').single();
    if (state.error) throw new Error(state.error.message);
    await audit(db, tenantId, connection.id, initiatorId, 'mailbox.connected', 'succeeded', { provider: 'gmail', watch_enabled: Boolean(watch) });
    return connectionRef(connection, state.data);
}

export async function connectOutlookMailbox(db, { tenantId, initiatorId, tokens, scopes }) {
    const providerTenantId = microsoftDirectoryTenantId(tokens);
    const credential = {
        ...tokens,
        expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
        scopes,
    };
    const profile = await outlookProfile(credential.access_token);
    const mailboxAddress = String(profile.mail || profile.userPrincipalName || '').trim().toLowerCase();
    if (!mailboxAddress) throw new Error('Microsoft did not return an Outlook mailbox address');
    const found = await db.from('provider_connections').select('*')
        .eq('tenant_id', tenantId).eq('provider', 'outlook').eq('provider_account_id', mailboxAddress).maybeSingle();
    if (found.error) throw new Error(found.error.message);
    let connection = found.data;
    const existingProviderTenantId = String(connection?.metadata?.provider_tenant_id || '').trim().toLowerCase();
    if (existingProviderTenantId && existingProviderTenantId !== providerTenantId) {
        throw new Error('This Outlook mailbox is already bound to a different Microsoft directory');
    }
    const existingIdentity = await db.from('service_identities').select('*')
        .eq('tenant_id', tenantId).eq('channel', 'email').eq('address', mailboxAddress).maybeSingle();
    if (existingIdentity.error) throw new Error(existingIdentity.error.message);
    if (existingIdentity.data && existingIdentity.data.provider_connection_id !== connection?.id) {
        throw new Error('This mailbox address is already assigned to a different tenant email connection');
    }
    const values = {
        provider: 'outlook',
        provider_account_id: mailboxAddress,
        display_name: String(profile.displayName || mailboxAddress),
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
        display_name: String(profile.displayName || mailboxAddress), can_send: false, can_receive: true, is_default: false,
        metadata: { connected_mailbox: true, draft_only: true }, updated_at: new Date().toISOString(),
    };
    const identity = existingIdentity.data
        ? await db.from('service_identities').update(identityValues).eq('tenant_id', tenantId).eq('id', existingIdentity.data.id).select('*').single()
        : await db.from('service_identities').insert(identityValues).select('*').single();
    if (identity.error) throw new Error(identity.error.message);
    const state = await db.from('mailbox_sync_state').upsert({
        tenant_id: tenantId,
        provider_connection_id: connection.id,
        provider_cursor: null,
        status: 'pending',
        last_error: null,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'provider_connection_id' }).select('*').single();
    if (state.error) throw new Error(state.error.message);
    await audit(db, tenantId, connection.id, initiatorId, 'mailbox.connected', 'succeeded', { provider: 'outlook', provider_tenant_id: providerTenantId });
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
        const credential = await accessCredential(db, tenantId, connection);
        const state = await db.from('mailbox_sync_state').select('*')
            .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).maybeSingle();
        if (state.error) throw new Error(state.error.message);
        let messageIds;
        let nextHistoryId;
        let recovered = false;
        const committedCursor = state.data?.provider_cursor || state.data?.history_id;
        if (committedCursor && state.data?.last_successful_sync_at) {
            try {
                const history = await gmailHistoryMessageIds(credential.access_token, committedCursor);
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
            if (committedCursor) {
                try {
                    const catchup = await gmailHistoryMessageIds(credential.access_token, committedCursor);
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
        let unavailable = 0;
        for (const messageId of messageIds) {
            let email;
            try {
                email = await gmailMessage(credential.access_token, messageId, connection.provider_account_id);
            } catch (error) {
                if (!(error instanceof GmailMessageNormalizationError) && !(error instanceof GmailMessageUnavailableError)) throw error;
                skipped += 1;
                if (error instanceof GmailMessageUnavailableError) unavailable += 1;
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
            provider_cursor: watch?.historyId || nextHistoryId,
            ...(watch?.expiration ? { watch_expiration: new Date(Number(watch.expiration)).toISOString() } : {}),
            status: 'healthy',
            last_successful_sync_at: new Date().toISOString(),
            last_error: null,
        });
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'succeeded', { ingested, duplicates, skipped, unavailable, recovered });
        return { connection_id: connectionId, status: 'healthy', ingested, duplicates, skipped, unavailable, recovered, history_id: watch?.historyId || nextHistoryId };
    } catch (error) {
        const state = error.oauthError === 'invalid_grant' || error.status === 403 ? 'revoked' : error.status === 401 ? 'expired' : 'degraded';
        const detail = `${error.providerOperation ? `${error.providerOperation}: ` : ''}${String(error.message || error)}`;
        await markSync(db, tenantId, connectionId, { status: state, last_error: detail.slice(0, 500) }).catch(() => {});
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'failed', { error: detail.slice(0, 200) }).catch(() => {});
        throw error;
    }
}

export async function syncOutlookMailbox(db, { tenantId, connectionId, actorId = null, maxMessages = 1000 }) {
    const connection = await selectedConnection(db, tenantId, connectionId);
    if (connection.provider !== 'outlook') throw new Error('Outlook mailbox connection is unavailable');
    const identity = await receivingIdentity(db, tenantId, connectionId);
    const claimed = await db.rpc('claim_mailbox_sync', {
        p_tenant_id: tenantId,
        p_provider_connection_id: connectionId,
        p_lease_seconds: 300,
    });
    if (claimed.error) throw new Error(`Could not claim mailbox sync: ${claimed.error.message}`);
    if (claimed.data !== true) return { connection_id: connectionId, status: 'syncing', in_progress: true };
    try {
        const credential = await accessCredential(db, tenantId, connection);
        const state = await db.from('mailbox_sync_state').select('*')
            .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).maybeSingle();
        if (state.error) throw new Error(state.error.message);
        let delta;
        let recovered = false;
        try {
            delta = await outlookDeltaMessages(credential.access_token, state.data?.provider_cursor || null, { maxMessages });
        } catch (error) {
            if (![404, 410].includes(error.status) || !state.data?.provider_cursor) throw error;
            recovered = true;
            delta = await outlookDeltaMessages(credential.access_token, null, { maxMessages });
        }
        let ingested = 0;
        let duplicates = 0;
        let skipped = 0;
        for (const messageId of delta.messageIds) {
            let email;
            try {
                email = await outlookMessage(credential.access_token, messageId, connection.provider_account_id);
            } catch (error) {
                if (!(error instanceof OutlookMessageNormalizationError)) throw error;
                skipped += 1;
                continue;
            }
            const outcome = await ingestCanonicalInboundEmail({
                db, tenantId, connection, email, serviceIdentityId: identity.id,
                providerEventType: 'outlook.message.received',
            });
            if (outcome.duplicate) duplicates += 1;
            else ingested += 1;
        }
        await markSync(db, tenantId, connectionId, {
            provider_cursor: delta.cursor,
            status: 'healthy',
            last_successful_sync_at: new Date().toISOString(),
            last_error: null,
        });
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'succeeded', { provider: 'outlook', ingested, duplicates, skipped, recovered });
        return { connection_id: connectionId, status: 'healthy', ingested, duplicates, skipped, recovered };
    } catch (error) {
        const state = error.oauthError === 'invalid_grant' || error.status === 403 ? 'revoked' : error.status === 401 ? 'expired' : 'degraded';
        await markSync(db, tenantId, connectionId, { status: state, last_error: String(error.message || error).slice(0, 500) }).catch(() => {});
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'failed', { provider: 'outlook', error: String(error.message || error).slice(0, 200) }).catch(() => {});
        throw error;
    }
}

export async function syncMailbox(db, input) {
    const connection = await selectedConnection(db, input.tenantId, input.connectionId);
    return connection.provider === 'outlook' ? syncOutlookMailbox(db, input) : syncGmailMailbox(db, input);
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
        status: 'reserved',
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
        const credential = await accessCredential(db, tenantId, connection);
        let providerRequest = request;
        if (connection.provider === 'outlook' && request.communication_id && !request.provider_message_id) {
            const email = await db.from('email_messages').select('provider_email_id')
                .eq('tenant_id', tenantId).eq('communication_id', request.communication_id).maybeSingle();
            if (email.error) throw new Error(email.error.message);
            providerRequest = { ...request, provider_message_id: email.data?.provider_email_id || undefined };
        }
        const draft = connection.provider === 'outlook'
            ? await createOutlookDraft(credential.access_token, providerRequest)
            : await createGmailDraft(credential.access_token, providerRequest, connection.provider_account_id);
        const updated = await db.from('mailbox_drafts').update({
            provider_draft_id: draft.id,
            provider_message_id: draft.message?.id || null,
            provider_thread_id: draft.message?.threadId || draft.message?.conversationId || request.provider_thread_id || null,
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
    const connection = await selectedConnection(db, tenantId, connectionId);
    const credential = await accessCredential(db, tenantId, connection);
    const provider = connection.provider === 'outlook'
        ? await getOutlookDraft(credential.access_token, draftId)
        : await getGmailDraft(credential.access_token, draftId);
    if (!provider?.id || provider.id !== draftId) {
        throw draftUpdateError('Provider draft was not found', 404, 'DRAFT_NOT_FOUND');
    }
    if (connection.provider === 'outlook' && provider.isDraft !== true) {
        throw draftUpdateError('Provider object is no longer an editable draft', 409, 'DRAFT_NOT_EDITABLE');
    }
    if (connection.provider === 'gmail') {
        const labels = provider.message?.labelIds || provider.labelIds;
        if (!Array.isArray(labels) || !labels.includes('DRAFT')) {
            throw draftUpdateError('Provider object is no longer an editable draft', 409, 'DRAFT_NOT_EDITABLE');
        }
    }
    return {
        ...record.data,
        provider: connection.provider === 'outlook'
            ? { id: provider.id, message_id: provider.id, thread_id: provider.conversationId, is_draft: provider.isDraft }
            : { id: provider.id, message_id: provider.message?.id, thread_id: provider.message?.threadId, is_draft: true },
    };
}

function draftUpdateError(message, status = 409, code = 'DRAFT_UPDATE_CONFLICT') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function updateResult(record) {
    return {
        id: record.id,
        provider_draft_id: record.provider_draft_id,
        provider_message_id: record.provider_message_id,
        provider_thread_id: record.provider_thread_id,
        status: record.status,
        revision: record.revision,
        created_at: record.created_at,
        updated_at: record.updated_at,
    };
}

const DRAFT_EDITABLE_FIELDS = ['to', 'cc', 'bcc', 'reply_to', 'subject', 'text', 'html'];

function normalizeDraftValue(key, value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim().toLowerCase()).sort();
    if (key === 'subject') return String(value ?? '').trim();
    if (key === 'html') return safeHtml(value) || '';
    return String(value ?? '');
}

function normalizedUpdateRequest(request = {}) {
    return Object.fromEntries(DRAFT_EDITABLE_FIELDS
        .filter(key => request[key] !== undefined)
        .map(key => [key, normalizeDraftValue(key, request[key])]));
}

function draftFieldsMatch(request, current) {
    const entries = Object.entries(request);
    return entries.length > 0 && entries.every(([key, value]) => JSON.stringify(value) === JSON.stringify(normalizeDraftValue(key, current[key])));
}

function providerDraftData(provider, providerName, mailboxAddress) {
    return {
        fields: providerName === 'outlook'
            ? outlookDraftEditableFields(provider)
            : gmailDraftEditableFields(provider, mailboxAddress),
        provider_message_id: provider?.message?.id || (providerName === 'outlook' ? provider?.id : null),
        provider_thread_id: provider?.message?.threadId || provider?.conversationId || null,
    };
}

async function currentEditableProviderDraft(connection, credential, draftId, providerOps = {}) {
    const provider = connection.provider === 'outlook'
        ? await (providerOps.getOutlookDraft || getOutlookDraft)(credential.access_token, draftId)
        : await (providerOps.getGmailDraft || getGmailDraft)(credential.access_token, draftId, { format: 'full' });
    if (!provider?.id || provider.id !== draftId) throw draftUpdateError('Provider draft was not found', 404, 'DRAFT_NOT_FOUND');
    if (connection.provider === 'outlook' && provider.isDraft !== true) {
        throw draftUpdateError('Provider object is no longer an editable draft', 409, 'DRAFT_NOT_EDITABLE');
    }
    if (connection.provider === 'gmail') {
        const labels = provider.message?.labelIds || provider.labelIds;
        if (!Array.isArray(labels) || !labels.includes('DRAFT')) {
            throw draftUpdateError('Provider object is no longer an editable draft', 409, 'DRAFT_NOT_EDITABLE');
        }
        if (gmailDraftHasAttachments(provider)) {
            throw draftUpdateError('Gmail drafts with attachments are not supported for in-place updates', 409, 'DRAFT_ATTACHMENTS_UNSUPPORTED');
        }
    }
    return { provider, ...providerDraftData(provider, connection.provider, connection.provider_account_id) };
}

async function finalizeDraftUpdate(db, { tenantId, connectionId, draft, receiptId, draftId, providerData, expectedRevision }) {
    const nextRevision = expectedRevision + 1;
    const result = updateResult({
        ...draft,
        provider_draft_id: draftId,
        provider_message_id: providerData.provider_message_id || draft.provider_message_id,
        provider_thread_id: providerData.provider_thread_id || draft.provider_thread_id,
        revision: nextRevision,
        updated_at: null,
    });
    const finalized = await db.rpc('finalize_mailbox_draft_update', {
        p_tenant_id: tenantId,
        p_provider_connection_id: connectionId,
        p_mailbox_draft_id: draft.id,
        p_receipt_id: receiptId,
        p_provider_draft_id: draftId,
        p_provider_message_id: result.provider_message_id,
        p_provider_thread_id: result.provider_thread_id,
        p_expected_revision: expectedRevision,
        p_result: result,
    });
    if (finalized.error) {
        throw draftUpdateError('Draft update finalization is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    return finalized.data || result;
}

async function reconcileDraftUpdate(db, { tenantId, connectionId, draft, receipt, draftId, connection, credential, providerOps }) {
    const leaseActive = draft.active_update_id === receipt.id
        && (!receipt.lease_until || new Date(receipt.lease_until).valueOf() > Date.now());
    if (leaseActive) {
        throw draftUpdateError('Another draft update is in progress; retry after its lease expires', 409, 'DRAFT_UPDATE_IN_PROGRESS');
    }
    let current;
    try {
        current = await currentEditableProviderDraft(connection, credential, draftId, providerOps);
    } catch {
        throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    if (!draftFieldsMatch(receipt.update_request || {}, current.fields)) {
        throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    return finalizeDraftUpdate(db, {
        tenantId, connectionId, draft, receiptId: receipt.id, draftId,
        providerData: current, expectedRevision: Number(receipt.base_revision || draft.revision || 1),
    });
}

/**
 * Update an existing provider draft without ever changing its provider ID.
 * The receipt row is deliberately separate from mailbox_drafts: one draft can
 * be edited many times while each idempotency key remains durable forever.
 */
export async function updateMailboxDraft(db, {
    tenantId, connectionId, draftId, actorId = null, idempotencyKey, request,
    providerOps = {}, credentialOverride = null,
}) {
    if (!idempotencyKey) throw draftUpdateError('Idempotency-Key header is required for mailbox draft updates', 400, 'IDEMPOTENCY_REQUIRED');
    const connection = await selectedConnection(db, tenantId, connectionId);
    const hashRequest = Object.fromEntries(['to', 'cc', 'bcc', 'reply_to', 'subject', 'text', 'html', 'revision']
        .filter(key => request?.[key] !== undefined)
        .map(key => [key, request[key]]));
    const hash = requestHash(hashRequest);
    const draft = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('provider_draft_id', draftId).maybeSingle();
    if (draft.error) throw new Error(draft.error.message);
    if (!draft.data) throw draftUpdateError('Mailbox draft not found', 404, 'DRAFT_NOT_FOUND');
    if (draft.data.status !== 'created' || !draft.data.provider_draft_id) {
        throw draftUpdateError('Mailbox draft is not editable until its provider state is reconciled', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }

    const existing = await db.from('mailbox_draft_update_receipts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('mailbox_draft_id', draft.data.id).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
        if (existing.data.request_hash !== hash) {
            throw draftUpdateError('Idempotency key was already used with different draft content', 409, 'IDEMPOTENCY_CONFLICT');
        }
        if (existing.data.status === 'updated') return existing.data.result || updateResult(draft.data);
        if (existing.data.status === 'failed') {
            throw draftUpdateError(existing.data.last_error || 'Draft update previously failed', existing.data.error_status || 502, existing.data.error_code || 'DRAFT_PROVIDER_FAILED');
        }
        if (['applying', 'uncertain'].includes(existing.data.status)) {
            try {
                const credential = credentialOverride || await accessCredential(db, tenantId, connection);
                return reconcileDraftUpdate(db, {
                    tenantId, connectionId, draft: draft.data, receipt: existing.data, draftId, connection, credential, providerOps,
                });
            } catch (error) {
                if (error.code === 'DRAFT_RECONCILIATION_REQUIRED' || error.code === 'DRAFT_UPDATE_IN_PROGRESS') throw error;
                throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
            }
        }
        if (existing.data.status === 'reserved'
            && Number(existing.data.base_revision || 1) !== Number(draft.data.revision || 1)) {
            await db.rpc('release_mailbox_draft_update', {
                p_tenant_id: tenantId, p_provider_connection_id: connectionId,
                p_mailbox_draft_id: draft.data.id, p_receipt_id: existing.data.id,
                p_error: 'Draft revision changed while this update was waiting',
                p_error_status: 409, p_error_code: 'STALE_REVISION', p_force_stale: true,
            });
            throw draftUpdateError('Draft revision changed; reload the draft before updating', 409, 'STALE_REVISION');
        }
        if (existing.data.status !== 'reserved') {
            throw draftUpdateError('Another draft update is in progress; retry after the active update completes', 409, 'DRAFT_UPDATE_IN_PROGRESS');
        }
    }

    const requestedRevision = request?.revision;
    if (requestedRevision !== undefined && (!Number.isInteger(requestedRevision) || requestedRevision < 1)) {
        throw draftUpdateError('revision must be a positive integer', 422, 'INVALID_REVISION');
    }
    if (requestedRevision !== undefined && requestedRevision !== Number(draft.data.revision || 1)) {
        throw draftUpdateError('Draft revision changed; reload the draft before updating', 409, 'STALE_REVISION');
    }
    const normalizedRequest = normalizedUpdateRequest(request);
    if (!Object.keys(normalizedRequest).length) {
        throw draftUpdateError('At least one editable draft field is required', 422, 'INVALID_DRAFT_UPDATE');
    }
    const reserved = existing.data?.status === 'reserved' && !draft.data.active_update_id
        ? { data: existing.data, error: null }
        : await db.from('mailbox_draft_update_receipts').insert({
            tenant_id: tenantId,
            provider_connection_id: connectionId,
            mailbox_draft_id: draft.data.id,
            idempotency_key: idempotencyKey,
            request_hash: hash,
            update_request: normalizedRequest,
            base_revision: Number(draft.data.revision || 1),
            status: 'reserved',
        }).select('*').single();
    if (reserved.error) {
        const raced = await db.from('mailbox_draft_update_receipts').select('*')
            .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
            .eq('mailbox_draft_id', draft.data.id).eq('idempotency_key', idempotencyKey).maybeSingle();
        if (raced.error) throw new Error(raced.error.message);
        if (!raced.data) throw new Error(reserved.error.message);
        if (raced.data.request_hash !== hash) throw draftUpdateError('Idempotency key was already used with different draft content', 409, 'IDEMPOTENCY_CONFLICT');
        if (raced.data.status === 'updated') return raced.data.result;
        if (['applying', 'uncertain'].includes(raced.data.status)) {
            try {
                const credential = credentialOverride || await accessCredential(db, tenantId, connection);
                return reconcileDraftUpdate(db, {
                    tenantId, connectionId, draft: draft.data, receipt: raced.data, draftId, connection, credential, providerOps,
                });
            } catch (error) {
                if (error.code === 'DRAFT_RECONCILIATION_REQUIRED' || error.code === 'DRAFT_UPDATE_IN_PROGRESS') throw error;
                throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
            }
        }
        return updateMailboxDraft(db, {
            tenantId, connectionId, draftId, actorId, idempotencyKey, request, providerOps, credentialOverride,
        });
    }

    let claimed;
    try {
        claimed = await db.rpc('claim_mailbox_draft_update', {
            p_tenant_id: tenantId, p_provider_connection_id: connectionId,
            p_mailbox_draft_id: draft.data.id, p_receipt_id: reserved.data.id,
            p_expected_revision: Number(draft.data.revision || 1), p_lease_seconds: 90,
        });
    } catch (error) {
        throw draftUpdateError('Draft update claim is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    if (claimed.error) {
        await db.from('mailbox_draft_update_receipts').update({
            status: 'uncertain', last_error: claimed.error.message, updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', reserved.data.id);
        throw draftUpdateError('Draft update claim is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    if (claimed.data !== true) {
        throw draftUpdateError('Another draft update is in progress; retry after the active update completes', 409, 'DRAFT_UPDATE_IN_PROGRESS');
    }

    const providerRequest = { ...(request || {}) };
    delete providerRequest.revision;
    delete providerRequest.communication_id;
    delete providerRequest.provider_draft_id;
    delete providerRequest.headers;
    delete providerRequest.provider_thread_id;
    delete providerRequest.in_reply_to;
    delete providerRequest.references;
    let providerStarted = false;
    let receiptCommitted = false;
    try {
        const credential = credentialOverride || await accessCredential(db, tenantId, connection);
        providerStarted = true;
        const providerDraft = connection.provider === 'outlook'
            ? await (providerOps.updateOutlookDraft || updateOutlookDraft)(credential.access_token, draftId, providerRequest)
            : await (providerOps.updateGmailDraft || updateGmailDraft)(credential.access_token, draftId, providerRequest, connection.provider_account_id);
        if (!providerDraft || providerDraft.id !== draftId) {
            throw draftUpdateError('Provider changed the draft identifier', 409, 'DRAFT_ID_CHANGED');
        }
        const nextRevision = Number(draft.data.revision || 1) + 1;
        const providerData = providerDraftData(providerDraft, connection.provider, connection.provider_account_id);
        const result = await finalizeDraftUpdate(db, {
            tenantId, connectionId, draft: draft.data, receiptId: reserved.data.id, draftId,
            providerData, expectedRevision: Number(draft.data.revision || 1),
        });
        receiptCommitted = true;
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.updated', 'succeeded', {
            draft_id: draftId, revision: nextRevision,
        }).catch(() => {});
        return result;
    } catch (error) {
        let uncertain = !receiptCommitted && providerStarted && (
            error.providerAfterMutation === true
            || error.code === 'DRAFT_RECONCILIATION_REQUIRED'
            || error.retryable === true || ![400, 401, 403, 404, 409, 422].includes(Number(error.status))
            || [408, 429, 500, 502, 503, 504].includes(Number(error.status))
        );
        if (!providerStarted && !receiptCommitted) uncertain = false;
        if (!uncertain && !receiptCommitted) {
            const released = await db.rpc('release_mailbox_draft_update', {
                p_tenant_id: tenantId, p_provider_connection_id: connectionId,
                p_mailbox_draft_id: draft.data.id, p_receipt_id: reserved.data.id,
                p_error: String(error.message || error).slice(0, 500),
                p_error_status: Number.isInteger(error.status) ? error.status : 502,
                p_error_code: error.code || 'DRAFT_PROVIDER_FAILED', p_force_stale: true,
            });
            if (released.error) uncertain = true;
        }
        if (receiptCommitted) {
            // The result is durable; keep the active claim if releasing it
            // failed so another key cannot issue a second provider update.
            throw error;
        }
        const status = uncertain ? 'uncertain' : 'failed';
        const errorStatus = Number(error.status);
        const persistedErrorStatus = Number.isInteger(errorStatus)
            && [400, 401, 403, 404, 409, 422].includes(errorStatus)
            ? errorStatus
            : 502;
        await db.from('mailbox_draft_update_receipts').update({
            status,
            last_error: String(error.message || error).slice(0, 500),
            error_status: persistedErrorStatus,
            error_code: error.code || (uncertain ? 'DRAFT_RECONCILIATION_REQUIRED' : 'DRAFT_PROVIDER_FAILED'),
            lease_until: uncertain ? undefined : null,
            updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', reserved.data.id);
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.updated', 'failed', {
            draft_id: draftId, error: String(error.message || error).slice(0, 200),
        }).catch(() => {});
        if (uncertain) {
            const reconciliation = error.code === 'DRAFT_RECONCILIATION_REQUIRED'
                ? error
                : draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
            reconciliation.providerOperation = error.providerOperation;
            reconciliation.providerAfterMutation = error.providerAfterMutation;
            throw reconciliation;
        }
        throw error;
    }
}

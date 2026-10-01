import { createHash } from 'node:crypto';
import { ingestCanonicalInboundEmail } from './emailWebhook.js';
import { safeHtml } from './email.js';
import { draftRecipientListsMatch } from './draftRecipientComparison.js';
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

async function accessCredentialWithStatus(db, tenantId, connection, { forceRefresh = false } = {}) {
    const connectionId = connection.id;
    const stored = await loadCredential(db, tenantId, connectionId);
    const usable = connection.provider === 'outlook'
        ? await usableOutlookCredential(stored, { forceRefresh })
        : await usableGmailCredential(stored);
    if (usable.refreshed) await saveCredential(db, tenantId, connectionId, usable.credential);
    return usable;
}

async function accessCredential(db, tenantId, connection) {
    return (await accessCredentialWithStatus(db, tenantId, connection)).credential;
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

export function outlookProviderTenantId(connection, tokens) {
    const providerTenantId = microsoftDirectoryTenantId(tokens);
    const existingProviderTenantId = String(connection?.metadata?.provider_tenant_id || '').trim().toLowerCase();
    if (existingProviderTenantId && existingProviderTenantId !== providerTenantId) {
        throw new Error('This Outlook mailbox is already bound to a different Microsoft directory');
    }
    return providerTenantId;
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
    const providerTenantId = outlookProviderTenantId(connection, tokens);
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
        display_name: String(profile.displayName || mailboxAddress), can_send: false, can_receive: true, is_default: false,
        metadata: { connected_mailbox: true, draft_only: true, provider_tenant_id: providerTenantId }, updated_at: new Date().toISOString(),
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

export async function syncOutlookMailbox(db, { tenantId, connectionId, actorId = null, maxMessages = 1000, forceRefresh = false }) {
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
        const { credential, refreshed } = await accessCredentialWithStatus(db, tenantId, connection, { forceRefresh });
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
        await audit(db, tenantId, connectionId, actorId, 'mailbox.sync', 'succeeded', { provider: 'outlook', ingested, duplicates, skipped, recovered, token_refreshed: refreshed });
        return { connection_id: connectionId, status: 'healthy', ingested, duplicates, skipped, recovered, token_refreshed: refreshed };
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

const UPDATE_REQUEST_HASH_FIELDS = ['to', 'cc', 'bcc', 'reply_to', 'subject', 'text', 'html', 'revision'];

function updateRequestHash(request, recoveryBinding = null) {
    const hashRequest = Object.fromEntries(UPDATE_REQUEST_HASH_FIELDS
        .filter(key => request?.[key] !== undefined)
        .map(key => [key, request[key]]));
    const canonicalBinding = recoveryBinding ? {
        failed_update_receipt_id: recoveryBinding.failed_update_receipt_id,
        reviewed_content_hash: recoveryBinding.reviewed_content_hash,
        expected_revision: recoveryBinding.expected_revision,
    } : null;
    return requestHash(canonicalBinding ? { ...hashRequest, recovery_binding: canonicalBinding } : hashRequest);
}

export async function createMailboxDraft(db, { tenantId, connectionId, actorId = null, idempotencyKey, request, credentialOverride, providerOps = {} }) {
    if (!idempotencyKey) throw new Error('Idempotency-Key header is required for mailbox drafts');
    const connection = await selectedConnection(db, tenantId, connectionId);
    const hash = requestHash(request);
    const existing = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    let reserved;
    if (existing.data) {
        if (existing.data.request_hash !== hash) {
            const error = new Error('Idempotency key was already used with different draft content');
            error.status = 409;
            throw error;
        }
        if (existing.data.status === 'created') return existing.data;
        // Only explicit pre-dispatch evidence permits another create. Legacy
        // failures and unknown provider outcomes must never be guessed safe.
        if (existing.data.status === 'failed' && !existing.data.provider_draft_id
            && existing.data.last_error?.startsWith('[before-provider] ')) {
            reserved = await db.from('mailbox_drafts').update({ status: 'creating', last_error: null, updated_at: new Date().toISOString() })
                .eq('tenant_id', tenantId).eq('id', existing.data.id).eq('status', 'failed')
                .eq('last_error', existing.data.last_error).select('*').maybeSingle();
            if (reserved.error) throw new Error(reserved.error.message);
            if (!reserved.data) throw draftUpdateError('Draft operation is already in progress');
        } else {
            if (existing.data.status === 'failed' && existing.data.provider_draft_id) {
                const credential = credentialOverride || await accessCredential(db, tenantId, connection);
                const current = await currentEditableProviderDraft(connection, credential, existing.data.provider_draft_id, providerOps);
                if (draftFieldsMatch(normalizedUpdateRequest(request), current.fields)) {
                    const restored = await db.from('mailbox_drafts').update({ status: 'created', last_error: null,
                        provider_message_id: current.provider_message_id || existing.data.provider_message_id,
                        provider_thread_id: current.provider_thread_id || existing.data.provider_thread_id,
                        provider_change_key: current.provider_change_key,
                        updated_at: new Date().toISOString() })
                        .eq('tenant_id', tenantId).eq('id', existing.data.id).eq('status', 'failed').select('*').maybeSingle();
                    if (restored.error) throw new Error(restored.error.message);
                    if (restored.data) return restored.data;
                }
            }
            const error = new Error('Draft operation requires provider reconciliation before retry');
            error.status = 409;
            throw error;
        }
    }
    reserved ||= await db.from('mailbox_drafts').insert({
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
    let providerStarted = false;
    let createdDraft;
    try {
        const credential = credentialOverride || await accessCredential(db, tenantId, connection);
        let providerRequest = request;
        if (connection.provider === 'outlook' && request.communication_id && !request.provider_message_id) {
            const email = await db.from('email_messages').select('provider_email_id')
                .eq('tenant_id', tenantId).eq('communication_id', request.communication_id).maybeSingle();
            if (email.error) throw new Error(email.error.message);
            providerRequest = { ...request, provider_message_id: email.data?.provider_email_id || undefined };
        }
        providerStarted = true;
        const draft = connection.provider === 'outlook'
            ? await (providerOps.createOutlookDraft || createOutlookDraft)(credential.access_token, providerRequest)
            : await (providerOps.createGmailDraft || createGmailDraft)(credential.access_token, providerRequest, connection.provider_account_id);
        createdDraft = draft;
        if (!draft?.id) throw new Error('Provider did not confirm a draft identity');
        const updated = await db.from('mailbox_drafts').update({
            provider_draft_id: draft.id,
            provider_message_id: draft.message?.id || null,
            provider_change_key: connection.provider === 'outlook' ? draft.message?.changeKey || null : null,
            provider_thread_id: draft.message?.threadId || draft.message?.conversationId || request.provider_thread_id || null,
            status: 'created',
            last_error: null,
            updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', reserved.data.id).select('*').single();
        if (updated.error) throw new Error(updated.error.message);
        // A failed audit write must not downgrade an already durable success.
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.created', 'succeeded', { draft_id: draft.id }).catch(() => {});
        return updated.data;
    } catch (error) {
        const knownDraftId = createdDraft?.id || error.providerDraftId;
        await db.from('mailbox_drafts').update({ status: 'failed', ...(knownDraftId ? { provider_draft_id: knownDraftId } : {}), last_error: `${providerStarted ? '' : '[before-provider] '}${String(error.message || error)}`.slice(0, 500), updated_at: new Date().toISOString() })
            .eq('tenant_id', tenantId).eq('id', reserved.data.id);
        await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.created', 'failed', { error: String(error.message || error).slice(0, 200) }).catch(() => {});
        throw error;
    }
}

export function mailboxDraftPreview(providerName, provider, mailboxAddress) {
    const fields = providerName === 'outlook' ? outlookDraftEditableFields(provider) : gmailDraftEditableFields(provider, mailboxAddress);
    const content = fields.text || fields.html || '';
    return {
        provider: providerName,
        subject: fields.subject,
        to: fields.to, cc: fields.cc, bcc: fields.bcc,
        body: content.slice(0, 200_000),
        body_type: fields.text ? 'text' : fields.html ? 'html' : 'text',
        truncated: content.length > 200_000,
        web_url: providerName === 'outlook' ? provider.webLink || null : null,
        mailbox_address: mailboxAddress,
        fetched_at: new Date().toISOString(),
    };
}

// Resolve only an exact tenant-owned receipt; never search by subject or recipient.
export async function getMailboxDraftByReceipt(db, { tenantId, receiptId }, readDraft = getMailboxDraft) {
    const record = await db.from('mailbox_drafts').select('*').eq('tenant_id', tenantId).eq('id', receiptId).maybeSingle();
    if (record.error) throw new Error(record.error.message);
    if (!record.data) return null;
    if (!record.data.provider_connection_id || !record.data.provider_draft_id || record.data.status !== 'created') {
        throw draftUpdateError('Receipt does not identify a successfully created draft');
    }
    return readDraft(db, { tenantId, connectionId: record.data.provider_connection_id, draftId: record.data.provider_draft_id });
}

async function readReviewableProviderDraft(db, { tenantId, connectionId, draftId }, deps) {
    const record = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId).eq('provider_draft_id', draftId).maybeSingle();
    if (record.error) throw new Error(record.error.message);
    if (!record.data) return null;
    const connection = await selectedConnection(db, tenantId, connectionId);
    const credential = await deps.accessCredential(db, tenantId, connection);
    const provider = connection.provider === 'outlook'
        ? await deps.getOutlookDraft(credential.access_token, draftId, { textBody: true })
        : await deps.getGmailDraft(credential.access_token, draftId, { format: 'full' });
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
    const preview = mailboxDraftPreview(connection.provider, provider, connection.provider_account_id);
    return { record: record.data, connection, provider, preview: { ...preview, content_hash: draftContentHash(preview) } };
}

/** Hash of exactly what a reviewer sees; fetch time and links are excluded. */
export function draftContentHash(preview) {
    const list = value => (Array.isArray(value) ? value : []).map(item => String(item).trim().toLowerCase()).sort();
    return requestHash({
        subject: String(preview.subject ?? ''), to: list(preview.to), cc: list(preview.cc), bcc: list(preview.bcc),
        body: String(preview.body ?? ''), body_type: preview.body_type, truncated: preview.truncated === true,
    });
}

function outlookDraftPreviewVerifiable(provider) {
    const body = provider?.body;
    const supportedBodyType = ['text', 'html'].includes(String(body?.contentType || '').toLowerCase());
    const recipients = ['toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo'];
    return typeof provider?.subject === 'string'
        && supportedBodyType
        && typeof body?.content === 'string'
        && recipients.every(field => Array.isArray(provider[field])
            && provider[field].every(item => typeof item?.emailAddress?.address === 'string' && item.emailAddress.address.length > 0));
}

export async function getMailboxDraft(db, { tenantId, connectionId, draftId }, deps = {
    accessCredential, getOutlookDraft, getGmailDraft,
}) {
    const read = await readReviewableProviderDraft(db, { tenantId, connectionId, draftId }, deps);
    if (!read) return null;
    const { record, connection, provider, preview } = read;
    return {
        ...record,
        preview,
        provider: connection.provider === 'outlook'
            ? { id: provider.id, message_id: provider.id, thread_id: provider.conversationId, is_draft: provider.isDraft }
            : { id: provider.id, message_id: provider.message?.id, thread_id: provider.message?.threadId, is_draft: true },
    };
}

/**
 * Adopt a reviewed provider version for a legacy draft saved before version
 * tracking. The provider is read, never written: the saved version is taken
 * from the same read whose content matched the reviewer's approved hash, and
 * it is stored only while no version, update or newer revision exists.
 */
export async function adoptMailboxDraftBaseline(db, {
    tenantId, connectionId, draftId, actorId = null, reviewedContentHash, expectedRevision,
}, deps = { accessCredential, getOutlookDraft, getGmailDraft }) {
    if (typeof reviewedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedContentHash)) {
        throw draftUpdateError('reviewed_content_hash from the draft preview is required', 422, 'INVALID_BASELINE_REVIEW');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw draftUpdateError('expected_revision must be a positive integer', 422, 'INVALID_REVISION');
    }
    const read = await readReviewableProviderDraft(db, { tenantId, connectionId, draftId }, deps);
    if (!read) throw draftUpdateError('Mailbox draft not found', 404, 'DRAFT_NOT_FOUND');
    const { record, connection, provider, preview } = read;
    const versionField = connection.provider === 'outlook' ? 'provider_change_key' : 'provider_message_id';
    if (record.status !== 'created') {
        throw draftUpdateError('Mailbox draft is not editable until its provider state is reconciled', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    if (record.active_update_id) {
        throw draftUpdateError('Another draft update is in progress; retry after the active update completes', 409, 'DRAFT_UPDATE_IN_PROGRESS');
    }
    if (Number(record.revision || 1) !== expectedRevision) {
        throw draftUpdateError('Draft revision changed; reload the draft before reviewing it', 409, 'STALE_REVISION');
    }
    if (record[versionField]) {
        throw draftUpdateError('Draft already has a saved provider version', 409, 'BASELINE_NOT_REQUIRED');
    }
    if (preview.content_hash !== reviewedContentHash) {
        throw draftUpdateError('Draft changed in the mailbox since it was reviewed; review the current draft', 409, 'DRAFT_PROVIDER_CHANGED');
    }
    const version = connection.provider === 'outlook' ? provider.changeKey : provider.message?.id;
    if (typeof version !== 'string' || !version) {
        throw draftUpdateError('Provider did not return a draft version', 409, 'DRAFT_VERSION_UNAVAILABLE');
    }
    const adopted = await db.from('mailbox_drafts').update({ [versionField]: version, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('id', record.id).eq('provider_draft_id', draftId).eq('status', 'created')
        .eq('revision', expectedRevision).is('active_update_id', null).is(versionField, null)
        .select('*').maybeSingle();
    if (adopted.error) throw new Error(adopted.error.message);
    if (!adopted.data) {
        throw draftUpdateError('Draft changed while its baseline was being saved; review it again', 409, 'DRAFT_UPDATE_CONFLICT');
    }
    await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.baseline_adopted', 'succeeded', {
        draft_id: draftId, revision: expectedRevision, content_hash: reviewedContentHash,
    }).catch(() => {});
    return { ...updateResult(adopted.data), baseline_adopted: true, content_hash: reviewedContentHash };
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
    return entries.length > 0 && entries.every(([key, value]) =>
        ['to', 'cc', 'bcc', 'reply_to'].includes(key)
            ? draftRecipientListsMatch(value, current[key])
            : JSON.stringify(value) === JSON.stringify(normalizeDraftValue(key, current[key])));
}

function recoveryBindingFromReceipt(receipt) {
    const binding = receipt?.update_request?.recovery_binding;
    if (!binding || typeof binding.failed_update_receipt_id !== 'string'
        || typeof binding.reviewed_content_hash !== 'string'
        || !/^[a-f0-9]{64}$/.test(binding.reviewed_content_hash)
        || !Number.isInteger(binding.expected_revision)) return null;
    return binding;
}

function validStoredEditableRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).length === 0
        || Object.keys(request).some(key => !DRAFT_EDITABLE_FIELDS.includes(key))) return false;
    return Object.entries(request).every(([key, value]) => {
        const isRecipientList = ['to', 'cc', 'bcc', 'reply_to'].includes(key);
        return isRecipientList
            ? Array.isArray(value) && value.every(item => typeof item === 'string')
            : typeof value === 'string';
    });
}

function hasExactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
}

function matchingStoredEditableRequest(left, right) {
    const leftFields = editableReceiptRequest(left);
    const rightFields = editableReceiptRequest(right);
    return Object.keys(leftFields).length === Object.keys(rightFields).length
        && Object.keys(leftFields).every(key => Object.hasOwn(rightFields, key)
            && JSON.stringify(leftFields[key]) === JSON.stringify(rightFields[key]));
}

function verifiedLinkedRecoveryBinding(candidate, {
    original, draft, tenantId, connectionId, draftId,
}) {
    const baseRevision = original.base_revision;
    if (!Number.isInteger(baseRevision) || baseRevision < 1
        || original.status !== 'failed' || original.error_code !== 'DRAFT_PROVIDER_CHANGED'
        || Number(original.error_status) !== 409
        || !validStoredEditableRequest(original.update_request)) return null;

    const request = candidate?.update_request;
    const binding = request?.recovery_binding;
    if (!candidate
        || typeof candidate.id !== 'string' || !candidate.id || candidate.id === original.id
        || typeof candidate.idempotency_key !== 'string' || !candidate.idempotency_key
        || candidate.idempotency_key === original.idempotency_key
        || candidate.tenant_id !== tenantId
        || candidate.provider_connection_id !== connectionId
        || candidate.mailbox_draft_id !== draft.id
        || !Number.isInteger(candidate.base_revision) || candidate.base_revision !== baseRevision
        || !request || typeof request !== 'object' || Array.isArray(request)
        || !hasExactKeys(binding, ['failed_update_receipt_id', 'reviewed_content_hash', 'expected_revision'])
        || binding.failed_update_receipt_id !== original.id
        || typeof binding.reviewed_content_hash !== 'string'
        || !/^[a-f0-9]{64}$/.test(binding.reviewed_content_hash)
        || !Number.isInteger(binding.expected_revision) || binding.expected_revision !== baseRevision
        || Object.keys(request).some(key => key !== 'recovery_binding' && !DRAFT_EDITABLE_FIELDS.includes(key))) return null;

    const candidateEditable = editableReceiptRequest(request);
    if (!validStoredEditableRequest(candidateEditable)
        || Object.keys(request).length !== Object.keys(candidateEditable).length + 1
        || !matchingStoredEditableRequest(original.update_request, candidateEditable)
        || candidate.request_hash !== updateRequestHash({
            ...candidateEditable,
            revision: binding.expected_revision,
        }, binding)) return null;
    return binding;
}

function verifiedLinkedRecoveryResult(candidate, scope) {
    const binding = verifiedLinkedRecoveryBinding(candidate, scope);
    if (!binding || candidate.status !== 'updated') return null;
    const { original, draft, draftId } = scope;
    const baseRevision = original.base_revision;
    const result = candidate.result;
    const currentRevision = Number(draft.revision || 1);
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || result.id !== draft.id
        || result.status !== 'created'
        || result.provider_draft_id !== draftId
        || result.provider_message_id !== draftId
        || !Number.isInteger(result.revision) || result.revision !== baseRevision + 1
        || !Number.isInteger(currentRevision) || currentRevision < result.revision
        || typeof result.provider_change_key !== 'string' || !result.provider_change_key.trim()
        || result.update_receipt_id !== candidate.id
        || result.recovered_from_receipt_id !== original.id
        || result.reviewed_content_hash !== binding.reviewed_content_hash) return null;
    return result;
}

function draftUpdateLeaseExpired(value, now = Date.now()) {
    // Native pg reads preserve timestamptz as Date; JSON clients return strings.
    // Do not coerce missing, numeric or malformed values into an expired lease.
    const timestamp = value instanceof Date ? value.getTime()
        : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && timestamp <= now;
}

async function resolveLinkedRecoveryResult(db, {
    tenantId, connectionId, draft, draftId, original, connection, credentialOverride, providerOps,
}) {
    const linked = await db.from('mailbox_draft_update_receipts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('mailbox_draft_id', draft.id)
        .contains('update_request', { recovery_binding: { failed_update_receipt_id: original.id } });
    if (linked.error) throw new Error(linked.error.message);
    // A completed successor and an outstanding successor are also ambiguous.
    // Failed attempts remain history, not alternative successful outcomes.
    const candidates = (linked.data || []).filter(receipt => receipt.status !== 'failed');
    if (candidates.length !== 1) return null;
    const candidate = candidates[0];
    const scope = { original, draft, tenantId, connectionId, draftId };
    if (candidate.status === 'updated') return verifiedLinkedRecoveryResult(candidate, scope);
    if (!['uncertain', 'applying'].includes(candidate.status)
        || !verifiedLinkedRecoveryBinding(candidate, scope)
        || candidate.result != null
        || draft.active_update_id !== candidate.id
        || Number(draft.revision) !== candidate.base_revision) return null;

    // Resume the existing claim, not the original failed operation or a new
    // recovery. The original review hash authorizes that receipt; it is not a
    // requirement that the post-write draft still hash to its pre-write body.
    const now = Date.now();
    if (!draftUpdateLeaseExpired(candidate.lease_until, now)
        || !draftUpdateLeaseExpired(draft.active_update_lease_until, now)) {
        throw draftUpdateError('Another draft update is in progress; retry after its lease expires', 409, 'DRAFT_UPDATE_IN_PROGRESS');
    }
    if (typeof db.transaction !== 'function') {
        throw draftUpdateError('Atomic draft claim verification is unavailable; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    try {
        const credential = credentialOverride || await accessCredential(db, tenantId, connection);
        return await reconcileDraftUpdate(db, {
            tenantId, connectionId, draft, receipt: candidate, draftId, connection, credential, providerOps,
            requireActiveClaim: true,
        });
    } catch (error) {
        if (error.code === 'DRAFT_RECONCILIATION_REQUIRED' || error.code === 'DRAFT_UPDATE_IN_PROGRESS') throw error;
        throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
}

function editableReceiptRequest(request = {}) {
    return Object.fromEntries(DRAFT_EDITABLE_FIELDS
        .filter(key => request[key] !== undefined)
        .map(key => [key, request[key]]));
}

function effectiveOutlookReceiptRequest(request = {}) {
    const editable = editableReceiptRequest(request);
    // Graph uses HTML when both alternatives are supplied to a draft PATCH.
    if (editable.html !== undefined && editable.text !== undefined) delete editable.text;
    return editable;
}

function assertVerifiableRecoveryResult(provider, draftId) {
    if (provider?.id !== draftId || provider?.isDraft !== true
        || !outlookDraftPreviewVerifiable(provider)
        || typeof provider.changeKey !== 'string' || !provider.changeKey) {
        const error = draftUpdateError(
            'Outlook recovery result is incomplete or unverifiable; reconcile before retrying',
            409,
            'DRAFT_RECONCILIATION_REQUIRED',
        );
        error.providerAfterMutation = true;
        throw error;
    }
}

function providerDraftData(provider, providerName, mailboxAddress) {
    return {
        fields: providerName === 'outlook'
            ? outlookDraftEditableFields(provider)
            : gmailDraftEditableFields(provider, mailboxAddress),
        provider_message_id: provider?.message?.id || (providerName === 'outlook' ? provider?.id : null),
        provider_thread_id: provider?.message?.threadId || provider?.conversationId || null,
        provider_change_key: providerName === 'outlook' ? provider?.changeKey || null : null,
    };
}

async function currentEditableProviderDraft(connection, credential, draftId, providerOps = {}, { textBody = false } = {}) {
    const provider = connection.provider === 'outlook'
        ? await (providerOps.getOutlookDraft || getOutlookDraft)(credential.access_token, draftId, ...(textBody ? [{ textBody: true }] : []))
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

async function finalizeDraftUpdate(db, { tenantId, connectionId, draft, receiptId, draftId, providerData, expectedRevision, recoveryBinding = null, requireActiveClaim = false }) {
    const nextRevision = expectedRevision + 1;
    const result = updateResult({
        ...draft,
        provider_draft_id: draftId,
        provider_message_id: providerData.provider_message_id || draft.provider_message_id,
        provider_thread_id: providerData.provider_thread_id || draft.provider_thread_id,
        revision: nextRevision,
        updated_at: null,
    });
    result.provider_change_key = providerData.provider_change_key;
    if (recoveryBinding) {
        result.update_receipt_id = receiptId;
        result.recovered_from_receipt_id = recoveryBinding.failed_update_receipt_id;
        result.reviewed_content_hash = recoveryBinding.reviewed_content_hash;
    }
    const args = {
        p_tenant_id: tenantId,
        p_provider_connection_id: connectionId,
        p_mailbox_draft_id: draft.id,
        p_receipt_id: receiptId,
        p_provider_draft_id: draftId,
        p_provider_message_id: result.provider_message_id,
        p_provider_thread_id: result.provider_thread_id,
        p_expected_revision: expectedRevision,
        p_result: result,
    };
    if (requireActiveClaim) {
        if (typeof db.transaction !== 'function') {
            throw draftUpdateError('Atomic draft claim verification is unavailable; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
        }
        return db.transaction(async tx => {
            if (typeof tx.lockMailboxDraftUpdateClaim !== 'function'
                || !await tx.lockMailboxDraftUpdateClaim(args)) {
                throw draftUpdateError('Draft update claim changed; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
            }
            const finalized = await tx.rpc('finalize_mailbox_draft_update', args);
            // Throw within the transaction so failed finalization rolls back.
            // A missing durable result is never replaced by fabricated success.
            if (finalized.error || !finalized.data) {
                throw draftUpdateError('Draft update finalization is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
            }
            return finalized.data;
        });
    }
    const finalized = await db.rpc('finalize_mailbox_draft_update', args);
    if (finalized.error) {
        throw draftUpdateError('Draft update finalization is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    return finalized.data || result;
}

async function reconcileDraftUpdate(db, { tenantId, connectionId, draft, receipt, draftId, connection, credential, providerOps, requireActiveClaim = false }) {
    const leaseActive = draft.active_update_id === receipt.id
        && !draftUpdateLeaseExpired(receipt.lease_until);
    if (leaseActive) {
        throw draftUpdateError('Another draft update is in progress; retry after its lease expires', 409, 'DRAFT_UPDATE_IN_PROGRESS');
    }
    const recoveryBinding = recoveryBindingFromReceipt(receipt);
    if (receipt?.update_request?.recovery_binding !== undefined && !recoveryBinding) {
        throw draftUpdateError('Draft recovery receipt binding is unverifiable; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    const storedEditableRequest = editableReceiptRequest(receipt.update_request || {});
    const plainTextRecovery = recoveryBinding && storedEditableRequest.text !== undefined && storedEditableRequest.html === undefined;
    let current;
    try {
        current = await currentEditableProviderDraft(connection, credential, draftId, providerOps, {
            textBody: plainTextRecovery,
        });
    } catch {
        throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    if (recoveryBinding) {
        try {
            assertVerifiableRecoveryResult(current.provider, draftId);
        } catch {
            throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
        }
    }
    const receiptRequest = recoveryBinding && connection.provider === 'outlook'
        ? effectiveOutlookReceiptRequest(receipt.update_request || {})
        : editableReceiptRequest(receipt.update_request || {});
    if (!draftFieldsMatch(receiptRequest, current.fields)) {
        throw draftUpdateError('Draft provider outcome is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    return finalizeDraftUpdate(db, {
        tenantId, connectionId, draft, receiptId: receipt.id, draftId,
        providerData: current, expectedRevision: Number(receipt.base_revision || draft.revision || 1),
        recoveryBinding, requireActiveClaim,
    });
}

/**
 * Update an existing provider draft without ever changing its provider ID.
 * The receipt row is deliberately separate from mailbox_drafts: one draft can
 * be edited many times while each idempotency key remains durable forever.
 */
export async function updateMailboxDraft(db, {
    tenantId, connectionId, draftId, actorId = null, idempotencyKey, request,
    providerOps = {}, credentialOverride = null, reviewedRecovery = null,
}) {
    if (!idempotencyKey) throw draftUpdateError('Idempotency-Key header is required for mailbox draft updates', 400, 'IDEMPOTENCY_REQUIRED');
    const connection = await selectedConnection(db, tenantId, connectionId);
    const recoveryBinding = reviewedRecovery ? {
        failed_update_receipt_id: reviewedRecovery.failedUpdateReceiptId,
        reviewed_content_hash: reviewedRecovery.reviewedContentHash,
        expected_revision: reviewedRecovery.expectedRevision,
    } : null;
    const hash = updateRequestHash(request, recoveryBinding);
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
            if (connection.provider === 'outlook'
                && existing.data.error_code === 'DRAFT_PROVIDER_CHANGED'
                && Number(existing.data.error_status) === 409) {
                const recovered = await resolveLinkedRecoveryResult(db, {
                    tenantId, connectionId, draft: draft.data, draftId, original: existing.data,
                    connection, credentialOverride, providerOps,
                });
                if (recovered) return recovered;
            }
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
            update_request: {
                ...normalizedRequest,
                ...(recoveryBinding ? { recovery_binding: recoveryBinding } : {}),
            },
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
            tenantId, connectionId, draftId, actorId, idempotencyKey, request, providerOps, credentialOverride, reviewedRecovery,
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
        if (connection.provider === 'gmail' && !draft.data.provider_message_id) {
            throw draftUpdateError('Gmail draft has no saved message version; review and reconcile it before updating', 409, 'DRAFT_VERSION_UNAVAILABLE');
        }
        if (connection.provider === 'outlook' && !draft.data.provider_change_key) {
            throw draftUpdateError('Outlook draft has no saved change key; review and reconcile it before updating', 409, 'DRAFT_VERSION_UNAVAILABLE');
        }
        let expectedChangeKey = draft.data.provider_change_key;
        if (reviewedRecovery) {
            if (connection.provider !== 'outlook') {
                throw draftUpdateError('Reviewed update recovery is supported only for Outlook drafts', 409, 'DRAFT_RECOVERY_UNSUPPORTED');
            }
            const review = await readReviewableProviderDraft(db, { tenantId, connectionId, draftId }, {
                accessCredential: async () => credential,
                getOutlookDraft: providerOps.getOutlookDraft || getOutlookDraft,
                getGmailDraft: providerOps.getGmailDraft || getGmailDraft,
            });
            if (!review || review.record.id !== draft.data.id) {
                throw draftUpdateError('Mailbox draft not found', 404, 'DRAFT_NOT_FOUND');
            }
            if (review.preview.truncated || !outlookDraftPreviewVerifiable(review.provider)) {
                throw draftUpdateError('The live draft preview is truncated or unverifiable and cannot be safely reviewed', 409, 'DRAFT_PREVIEW_UNVERIFIABLE');
            }
            if (review.preview.content_hash !== recoveryBinding.reviewed_content_hash) {
                throw draftUpdateError('Draft changed in the mailbox since it was reviewed; review the current draft', 409, 'DRAFT_PROVIDER_CHANGED');
            }
            if (typeof review.provider.changeKey !== 'string' || !review.provider.changeKey) {
                throw draftUpdateError('Provider did not return a draft version', 409, 'DRAFT_VERSION_UNAVAILABLE');
            }
            expectedChangeKey = review.provider.changeKey;
            await audit(db, tenantId, connectionId, actorId, 'mailbox.draft.recovery_authorized', 'succeeded', {
                draft_id: draftId,
                failed_update_receipt_id: recoveryBinding.failed_update_receipt_id,
                update_receipt_id: reserved.data.id,
                reviewed_content_hash: recoveryBinding.reviewed_content_hash,
                revision: recoveryBinding.expected_revision,
            });
        }
        providerStarted = true;
        const providerDraft = connection.provider === 'outlook'
            ? await (providerOps.updateOutlookDraft || updateOutlookDraft)(credential.access_token, draftId, providerRequest,
                { expectedChangeKey })
            : await (providerOps.updateGmailDraft || updateGmailDraft)(credential.access_token, draftId, providerRequest, connection.provider_account_id,
                { expectedMessageId: draft.data.provider_message_id });
        if (recoveryBinding && (!providerDraft || providerDraft.id !== draftId)) {
            assertVerifiableRecoveryResult(providerDraft, draftId);
        }
        if (!providerDraft || providerDraft.id !== draftId) {
            throw draftUpdateError('Provider changed the draft identifier', 409, 'DRAFT_ID_CHANGED');
        }
        if (recoveryBinding) {
            assertVerifiableRecoveryResult(providerDraft, draftId);
        }
        let verifiedProviderDraft = providerDraft;
        if (recoveryBinding && normalizedRequest.text !== undefined && normalizedRequest.html === undefined) {
            try {
                verifiedProviderDraft = await (providerOps.getOutlookDraft || getOutlookDraft)(
                    credential.access_token, draftId, { textBody: true },
                );
            } catch {
                const error = draftUpdateError('Outlook recovery verification is uncertain; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
                error.providerAfterMutation = true;
                throw error;
            }
            assertVerifiableRecoveryResult(verifiedProviderDraft, draftId);
            if (verifiedProviderDraft.changeKey !== providerDraft.changeKey) {
                const error = draftUpdateError('Outlook draft changed during recovery verification; reconcile before retrying', 409, 'DRAFT_RECONCILIATION_REQUIRED');
                error.providerAfterMutation = true;
                throw error;
            }
        }
        if (recoveryBinding && !draftFieldsMatch(effectiveOutlookReceiptRequest(normalizedRequest), providerDraftData(verifiedProviderDraft, 'outlook', connection.provider_account_id).fields)) {
            const error = draftUpdateError('Outlook recovery response does not verify the requested draft update', 409, 'DRAFT_RECONCILIATION_REQUIRED');
            error.providerAfterMutation = true;
            throw error;
        }
        const nextRevision = Number(draft.data.revision || 1) + 1;
        const providerData = providerDraftData(verifiedProviderDraft, connection.provider, connection.provider_account_id);
        const result = await finalizeDraftUpdate(db, {
            tenantId, connectionId, draft: draft.data, receiptId: reserved.data.id, draftId,
            providerData, expectedRevision: Number(draft.data.revision || 1),
            recoveryBinding,
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

/**
 * Repair an Outlook draft update rejected by the provider-version guard after
 * a fresh, explicit content review. The rejected receipt remains immutable;
 * recovery always creates a separate idempotent update receipt.
 */
export async function recoverMailboxDraft(db, {
    tenantId, connectionId, draftId, actorId = null, idempotencyKey,
    failedUpdateReceiptId, reviewedContentHash, expectedRevision,
}, { providerOps = {}, credentialOverride = null } = {}) {
    if (!idempotencyKey) {
        throw draftUpdateError('Idempotency-Key header is required for mailbox draft recovery', 400, 'IDEMPOTENCY_REQUIRED');
    }
    if (typeof reviewedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedContentHash)) {
        throw draftUpdateError('reviewed_content_hash from the draft preview is required', 422, 'INVALID_RECOVERY_REVIEW');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw draftUpdateError('expected_revision must be a positive integer', 422, 'INVALID_REVISION');
    }
    if (typeof failedUpdateReceiptId !== 'string' || !failedUpdateReceiptId) {
        throw draftUpdateError('failed_update_receipt_id is required', 422, 'INVALID_RECOVERY_RECEIPT');
    }

    const connection = await selectedConnection(db, tenantId, connectionId);
    if (connection.provider !== 'outlook') {
        throw draftUpdateError('Reviewed update recovery is supported only for Outlook drafts', 409, 'DRAFT_RECOVERY_UNSUPPORTED');
    }
    const draftResult = await db.from('mailbox_drafts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('provider_draft_id', draftId).maybeSingle();
    if (draftResult.error) throw new Error(draftResult.error.message);
    if (!draftResult.data) throw draftUpdateError('Mailbox draft not found', 404, 'DRAFT_NOT_FOUND');

    const originalResult = await db.from('mailbox_draft_update_receipts').select('*')
        .eq('tenant_id', tenantId).eq('provider_connection_id', connectionId)
        .eq('mailbox_draft_id', draftResult.data.id).eq('id', failedUpdateReceiptId).maybeSingle();
    if (originalResult.error) throw new Error(originalResult.error.message);
    if (!originalResult.data) {
        throw draftUpdateError('Failed update receipt not found for this draft', 404, 'DRAFT_RECOVERY_RECEIPT_NOT_FOUND');
    }
    const original = originalResult.data;
    if (original.status !== 'failed' || original.error_code !== 'DRAFT_PROVIDER_CHANGED'
        || Number(original.error_status) !== 409
        || Number(original.base_revision) !== expectedRevision) {
        throw draftUpdateError('Only a DRAFT_PROVIDER_CHANGED failure at the reviewed base revision can be recovered', 409, 'DRAFT_RECOVERY_NOT_ALLOWED');
    }
    if (idempotencyKey === original.idempotency_key) {
        throw draftUpdateError('Recovery requires a new Idempotency-Key', 409, 'IDEMPOTENCY_CONFLICT');
    }
    if (draftResult.data.status !== 'created' || draftResult.data.provider_draft_id !== draftId) {
        throw draftUpdateError('Mailbox draft is not editable until its provider state is reconciled', 409, 'DRAFT_RECONCILIATION_REQUIRED');
    }
    const storedRequest = original.update_request;
    if (!storedRequest || typeof storedRequest !== 'object' || Array.isArray(storedRequest)
        || Object.keys(storedRequest).length === 0
        || Object.keys(storedRequest).some(key => !DRAFT_EDITABLE_FIELDS.includes(key))) {
        throw draftUpdateError('Rejected update receipt contains unsupported fields and cannot be recovered', 409, 'DRAFT_RECOVERY_INVALID_RECEIPT');
    }
    for (const [key, value] of Object.entries(storedRequest)) {
        const isRecipientList = ['to', 'cc', 'bcc', 'reply_to'].includes(key);
        if (isRecipientList ? (!Array.isArray(value) || value.some(item => typeof item !== 'string')) : typeof value !== 'string') {
            throw draftUpdateError('Rejected update receipt contains invalid editable fields', 409, 'DRAFT_RECOVERY_INVALID_RECEIPT');
        }
    }

    const request = { ...normalizedUpdateRequest(storedRequest), revision: expectedRevision };
    return updateMailboxDraft(db, {
        tenantId, connectionId, draftId, actorId, idempotencyKey, request, providerOps, credentialOverride,
        reviewedRecovery: { failedUpdateReceiptId, reviewedContentHash, expectedRevision },
    });
}

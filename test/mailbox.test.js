import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openMailboxCredential, sealMailboxCredential } from '../mailboxCrypto.js';
import {
    createMailboxOAuthState,
    gmailAuthorizationUrl,
    mailboxOAuthNonceHash,
    outlookAuthorizationUrl,
    verifyMailboxOAuthState,
} from '../mailboxOAuth.js';
import { canonicalGmailMessage, GmailMessageNormalizationError, GmailMessageUnavailableError, gmailDraftMessage } from '../gmailMailbox.js';
import {
    canonicalOutlookMessage,
    createOutlookDraft,
    outlookDeltaMessages,
    OutlookMessageNormalizationError,
} from '../outlookMailbox.js';

const KEYS = [
    'MAILBOX_CREDENTIAL_ENCRYPTION_KEY', 'MAILBOX_OAUTH_STATE_SECRET',
    'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'PUBLIC_URL',
    'MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_TENANT',
    'HYPERFLOW_URL', 'MAILBOX_OAUTH_RETURN_ORIGINS',
];
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const key of KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
    }
});

function configure() {
    process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.MAILBOX_OAUTH_STATE_SECRET = 'test-state-secret-that-is-long-and-random';
    process.env.GMAIL_OAUTH_CLIENT_ID = 'client.apps.googleusercontent.com';
    process.env.GMAIL_OAUTH_CLIENT_SECRET = 'client-secret';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'microsoft-client';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'microsoft-secret';
    process.env.PUBLIC_URL = 'https://communications.example.com';
    process.env.HYPERFLOW_URL = 'https://hyperflow.example.com';
    process.env.MAILBOX_OAUTH_RETURN_ORIGINS = 'https://hyperflow.example.com';
}

describe('connected mailbox credentials and OAuth state', () => {
    test('encrypts OAuth material with tenant and connection associated data', () => {
        configure();
        const sealed = sealMailboxCredential({ refresh_token: 'secret-refresh' }, 'tenant-a:connection-a');
        assert.doesNotMatch(sealed, /secret-refresh/);
        assert.deepEqual(openMailboxCredential(sealed, 'tenant-a:connection-a'), { refresh_token: 'secret-refresh' });
        assert.throws(() => openMailboxCredential(sealed, 'tenant-b:connection-a'), /decrypted or authenticated/);
    });

    test('signs a short-lived tenant and initiator-bound OAuth state', () => {
        configure();
        const created = createMailboxOAuthState({ tenantId: 'tenant-a', initiatorId: 'user-a', returnUrl: 'https://hyperflow.example.com/settings' });
        const verified = verifyMailboxOAuthState(created.token);
        assert.equal(verified.tenantId, 'tenant-a');
        assert.equal(verified.initiatorId, 'user-a');
        assert.equal(verified.returnUrl, 'https://hyperflow.example.com/settings');
        assert.match(mailboxOAuthNonceHash(verified.nonce), /^[a-f0-9]{64}$/);
        assert.throws(() => verifyMailboxOAuthState(`${created.token}x`), /signature/);
        assert.throws(() => createMailboxOAuthState({ tenantId: 'tenant-a', initiatorId: 'user-a', returnUrl: 'https://attacker.example.com/' }), /allowlisted/);
    });

    test('rejects a low-entropy OAuth state secret', () => {
        configure();
        process.env.MAILBOX_OAUTH_STATE_SECRET = 'too-short';
        assert.throws(() => createMailboxOAuthState({
            tenantId: 'tenant-a', initiatorId: 'user-a', returnUrl: 'https://hyperflow.example.com/'
        }), /at least 32 bytes/);
    });

    test('requests offline Gmail read and compose access with the exact callback', () => {
        configure();
        const url = new URL(gmailAuthorizationUrl('signed-state'));
        assert.equal(url.origin, 'https://accounts.google.com');
        assert.equal(url.searchParams.get('access_type'), 'offline');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://communications.example.com/oauth/mailboxes/google/callback');
        assert.match(url.searchParams.get('scope'), /gmail\.readonly/);
        assert.match(url.searchParams.get('scope'), /gmail\.compose/);
    });

    test('binds Outlook OAuth state and requests delegated offline Mail.ReadWrite access', () => {
        configure();
        const created = createMailboxOAuthState({
            tenantId: 'tenant-a', initiatorId: 'user-a', returnUrl: 'https://hyperflow.example.com/settings',
            provider: 'outlook', setupDraftId: 'setup-1',
        });
        const verified = verifyMailboxOAuthState(created.token);
        assert.equal(verified.provider, 'outlook');
        assert.equal(verified.setupDraftId, 'setup-1');
        const url = new URL(outlookAuthorizationUrl(created.token));
        assert.equal(url.origin, 'https://login.microsoftonline.com');
        assert.equal(url.pathname, '/common/oauth2/v2.0/authorize');
        assert.equal(url.searchParams.get('redirect_uri'), 'https://communications.example.com/oauth/mailboxes/microsoft/callback');
        assert.match(url.searchParams.get('scope'), /offline_access/);
        assert.match(url.searchParams.get('scope'), /Mail\.ReadWrite/);
    });
});

describe('Gmail adapter contract', () => {
    test('normalizes a full Gmail MIME message without trusting provider HTML', () => {
        const message = canonicalGmailMessage({
            id: 'gmail-message-1', threadId: 'gmail-thread-1', internalDate: String(Date.parse('2026-08-30T00:00:00Z')),
            payload: {
                mimeType: 'multipart/alternative',
                headers: [
                    { name: 'From', value: 'Alex <alex@example.com>' },
                    { name: 'To', value: 'Coach <coach@example.com>' },
                    { name: 'Subject', value: 'Progress' },
                    { name: 'Message-ID', value: '<gmail-message-1@example.com>' },
                ],
                parts: [
                    { mimeType: 'text/plain', body: { data: Buffer.from('Plain reply').toString('base64url') } },
                    { mimeType: 'text/html', body: { data: Buffer.from('<p>Reply</p><script>bad()</script>').toString('base64url') } },
                ],
            },
        });
        assert.equal(message.provider_email_id, 'gmail-message-1');
        assert.equal(message.provider_conversation_id, 'gmail-thread-1');
        assert.equal(message.from_addresses[0].address, 'alex@example.com');
        assert.equal(message.text_body, 'Plain reply');
        assert.doesNotMatch(message.sanitized_html, /script/i);
    });

    test('uses the connected mailbox as the recipient for Gmail inbox messages without a To header', () => {
        const message = canonicalGmailMessage({
            id: 'gmail-message-bcc', threadId: 'gmail-thread-bcc', internalDate: String(Date.parse('2026-08-30T00:00:00Z')),
            payload: {
                mimeType: 'text/plain',
                headers: [
                    { name: 'From', value: 'Alex <alex@example.com>' },
                    { name: 'Subject', value: 'Bcc delivery' },
                ],
                body: { data: Buffer.from('Private inbox message').toString('base64url') },
            },
        }, { mailboxAddress: 'coach@example.com' });
        assert.equal(message.to_addresses[0].address, 'coach@example.com');
        assert.equal(message.from_addresses[0].address, 'alex@example.com');
    });

    test('exposes a distinct error type for per-message Gmail normalization failures', () => {
        const error = new GmailMessageNormalizationError('gmail-message-invalid', new Error('missing sender'));
        assert.equal(error.code, 'GMAIL_MESSAGE_INVALID');
        assert.equal(error.providerMessageId, 'gmail-message-invalid');
        assert.match(error.message, /missing sender/);
    });

    test('classifies a disappeared Gmail message as skippable provider churn', () => {
        const cause = Object.assign(new Error('Requested entity was not found.'), {
            status: 404,
            providerOperation: 'gmail.messages.get',
        });
        const error = new GmailMessageUnavailableError('gmail-message-deleted', cause);
        assert.equal(error.code, 'GMAIL_MESSAGE_UNAVAILABLE');
        assert.equal(error.status, 404);
        assert.equal(error.providerMessageId, 'gmail-message-deleted');
        assert.equal(error.cause.providerOperation, 'gmail.messages.get');
    });

    test('creates a Gmail draft MIME payload but exposes no send operation', () => {
        const draft = gmailDraftMessage({
            to: ['Alex <alex@example.com>'], subject: 'Daily update', text: 'Draft only',
            provider_thread_id: 'gmail-thread-1', in_reply_to: '<one@example.com>',
        }, 'coach@example.com');
        const mime = Buffer.from(draft.raw, 'base64url').toString('utf8');
        assert.match(mime, /From: coach@example\.com/);
        assert.match(mime, /To: Alex <alex@example\.com>/);
        assert.match(mime, /In-Reply-To: <one@example\.com>/);
        assert.match(mime, /Draft only/);
        assert.equal(draft.threadId, 'gmail-thread-1');
    });
});

describe('Outlook adapter contract', () => {
    test('follows Graph delta pagination, de-duplicates messages and persists the opaque delta cursor', async () => {
        const calls = [];
        const pages = [
            { value: [{ id: 'm1' }, { id: 'm2' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' },
            { value: [{ id: 'm2' }, { id: 'removed', '@removed': { reason: 'deleted' } }, { id: 'm3' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-cursor' },
        ];
        const result = await outlookDeltaMessages('token', null, {
            request: async (_token, url) => { calls.push(url); return pages.shift(); },
        });
        assert.deepEqual(result.messageIds, ['m1', 'm2', 'm3']);
        assert.equal(result.cursor, 'https://graph.microsoft.com/v1.0/delta-cursor');
        assert.equal(calls[1], 'https://graph.microsoft.com/v1.0/next-page');
    });

    test('creates reply drafts with createReply followed by an update and never calls send', async () => {
        const calls = [];
        const result = await createOutlookDraft('token', {
            provider_message_id: 'source-message', text: 'Draft response',
        }, {
            request: async (_token, path, options) => {
                calls.push({ path, options });
                return calls.length === 1 ? { id: 'draft-1' } : { id: 'draft-1', isDraft: true };
            },
        });
        assert.equal(result.id, 'draft-1');
        assert.match(calls[0].path, /source-message\/createReply$/);
        assert.equal(calls[0].options.method, 'POST');
        assert.match(calls[1].path, /draft-1$/);
        assert.equal(calls[1].options.method, 'PATCH');
        assert.equal(calls.some(call => /send/i.test(call.path)), false);
    });

    test('creates standalone Outlook drafts under messages and never sends them', async () => {
        const calls = [];
        const result = await createOutlookDraft('token', {
            to: ['Alex <alex@example.com>'], subject: 'Review', text: 'Draft only',
        }, {
            request: async (_token, path, options) => { calls.push({ path, options }); return { id: 'draft-2', isDraft: true }; },
        });
        assert.equal(result.id, 'draft-2');
        assert.equal(calls[0].path, 'me/messages');
        assert.equal(calls[0].options.method, 'POST');
        assert.equal(calls.some(call => /send/i.test(call.path)), false);
    });

    test('normalizes Graph messages into the canonical email contract', () => {
        const email = canonicalOutlookMessage({
            id: 'graph-message-1', conversationId: 'graph-thread-1', internetMessageId: '<graph@example.com>',
            receivedDateTime: '2026-08-31T00:00:00Z', subject: 'Work update',
            from: { emailAddress: { name: 'Alex', address: 'alex@work.example' } },
            toRecipients: [{ emailAddress: { address: 'coach@work.example' } }],
            body: { contentType: 'html', content: '<p>Progress</p><script>bad()</script>' },
            bodyPreview: 'Progress',
            attachments: [{ id: 'a1', name: 'report.pdf', contentType: 'application/pdf', size: 100, isInline: false }],
        });
        assert.equal(email.provider_email_id, 'graph-message-1');
        assert.equal(email.provider_conversation_id, 'graph-thread-1');
        assert.equal(email.from_addresses[0].address, 'alex@work.example');
        assert.equal(email.to_addresses[0].address, 'coach@work.example');
        assert.doesNotMatch(email.sanitized_html, /script/i);
        assert.equal(email.attachments[0].filename, 'report.pdf');
    });

    test('uses the connected Outlook mailbox as a Bcc fallback', () => {
        const email = canonicalOutlookMessage({
            id: 'graph-message-2', from: { emailAddress: { address: 'sender@example.com' } },
            subject: 'Private', body: { contentType: 'text', content: 'Private update' },
        }, { mailboxAddress: 'owner@outlook.com' });
        assert.equal(email.to_addresses[0].address, 'owner@outlook.com');
    });

    test('exposes a provider-specific Outlook normalization error', () => {
        const error = new OutlookMessageNormalizationError('graph-invalid', new Error('missing sender'));
        assert.equal(error.code, 'OUTLOOK_MESSAGE_INVALID');
        assert.equal(error.providerMessageId, 'graph-invalid');
    });
});

describe('connected mailbox migration', () => {
    test('keeps credentials, state, drafts and audit tenant-owned and backend-only', () => {
        const sql = readFileSync(new URL('../migrations/016_connected_mailboxes.sql', import.meta.url), 'utf8');
        for (const table of ['mailbox_oauth_credentials', 'mailbox_sync_state', 'mailbox_oauth_states', 'mailbox_drafts', 'mailbox_audit_events']) {
            assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
            assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
        }
        assert.match(sql, /consume_mailbox_oauth_state/);
        assert.match(sql, /revoke all on public\.mailbox_oauth_credentials[\s\S]+from anon/);
        assert.match(sql, /revoke execute on function public\.consume_mailbox_oauth_state\(text,text,text\) from public/);
        assert.match(sql, /revoke execute on function public\.claim_mailbox_sync\(text,uuid,integer\) from public/);
        assert.match(sql, /grant select, insert, update, delete on public\.mailbox_oauth_credentials[\s\S]+to service_role/);
        assert.match(sql, /grant execute on function public\.consume_mailbox_oauth_state\(text,text,text\) to service_role/);
    });

    test('adds a provider-neutral cursor without removing Gmail history state', () => {
        const sql = readFileSync(new URL('../migrations/017_provider_neutral_mailbox_cursor.sql', import.meta.url), 'utf8');
        assert.match(sql, /add column if not exists provider_cursor text/);
        assert.match(sql, /set provider_cursor=history_id/);
    });
});

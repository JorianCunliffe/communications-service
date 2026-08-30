import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openMailboxCredential, sealMailboxCredential } from '../mailboxCrypto.js';
import {
    createMailboxOAuthState,
    gmailAuthorizationUrl,
    mailboxOAuthNonceHash,
    verifyMailboxOAuthState,
} from '../mailboxOAuth.js';
import { canonicalGmailMessage, GmailMessageNormalizationError, gmailDraftMessage } from '../gmailMailbox.js';

const KEYS = [
    'MAILBOX_CREDENTIAL_ENCRYPTION_KEY', 'MAILBOX_OAUTH_STATE_SECRET',
    'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'PUBLIC_URL',
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
});

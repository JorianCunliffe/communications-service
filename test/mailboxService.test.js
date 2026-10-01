import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { serverOptions } from '../serverOptions.js';
import v1Routes from '../v1.js';
import { hashApiSecret } from '../auth.js';
import { outlookProviderTenantId, updateMailboxDraft, recoverMailboxDraft, mailboxDraftPreview, createMailboxDraft, getMailboxDraftByReceipt, getMailboxDraft, adoptMailboxDraftBaseline, draftContentHash } from '../mailboxService.js';
import { getGmailDraft, updateGmailDraft } from '../gmailMailbox.js';
import { getOutlookDraft, updateOutlookDraft } from '../outlookMailbox.js';

test('Outlook draft read requests provider web link and plain text without changing update reads', async () => {
    const calls = [];
    const request = async (...args) => { calls.push(args); return {}; };
    await getOutlookDraft('token', 'draft/1', { request, textBody: true });
    assert.match(calls[0][1], /draft%2F1.*webLink/);
    assert.equal(calls[0][2].headers.Prefer, 'outlook.body-content-type="text"');
    await getOutlookDraft('token', 'draft/1', { request });
    assert.deepEqual(calls[1][2], {});
});
test('draft preview projects current Outlook content and Gmail full MIME content', () => {
    const outlook = mailboxDraftPreview('outlook', {
        subject: 'Edited in Outlook', body: { contentType: 'text', content: 'Hello\n\nCurrent body' },
        toRecipients: [{ emailAddress: { address: 'person@example.com' } }], webLink: 'https://outlook.office.com/mail/draft',
    }, 'owner@example.com');
    assert.equal(outlook.body, 'Hello\n\nCurrent body');
    assert.equal(outlook.subject, 'Edited in Outlook');
    assert.equal(outlook.web_url, 'https://outlook.office.com/mail/draft');
    assert.deepEqual(outlook.to, ['person@example.com']);
    const gmail = mailboxDraftPreview('gmail', { message: { payload: {
        headers: [{ name: 'Subject', value: 'Gmail draft' }, { name: 'To', value: 'person@example.com' }],
        mimeType: 'text/plain', body: { data: Buffer.from('Gmail body\nTwo lines').toString('base64url') },
    } } }, 'owner@example.com');
    assert.equal(gmail.body, 'Gmail body\nTwo lines');
    assert.equal(gmail.web_url, null);
    const long = mailboxDraftPreview('outlook', { body: { contentType: 'text', content: 'x'.repeat(200001) } });
    assert.equal(long.body.length, 200000);
    assert.equal(long.truncated, true);
});

const tenant = 'service-test-tenant';

test('receipt recovery is tenant scoped and reads the exact existing provider draft only', async () => {
    let record = { status: 'created', provider_connection_id: 'outlook', provider_draft_id: 'draft' };
    const filters = [];
    const query = { select() { return this; }, eq(...args) { filters.push(args); return this; }, async maybeSingle() { return { data: record }; } };
    const db = { from(table) { assert.equal(table, 'mailbox_drafts'); return query; } };
    let reads = 0;
    const read = async (_db, args) => { reads++; assert.deepEqual(args, { tenantId: tenant, connectionId: 'outlook', draftId: 'draft' }); return { verified: true }; };
    assert.deepEqual(await getMailboxDraftByReceipt(db, { tenantId: tenant, receiptId: 'receipt' }, read), { verified: true });
    assert.deepEqual(filters, [['tenant_id', tenant], ['id', 'receipt']]);
    record = null;
    assert.equal(await getMailboxDraftByReceipt(db, { tenantId: tenant, receiptId: 'receipt' }, read), null);
    record = { status: 'failed', provider_connection_id: 'outlook', provider_draft_id: 'draft' };
    await assert.rejects(getMailboxDraftByReceipt(db, { tenantId: tenant, receiptId: 'receipt' }, read), /successfully created/);
    assert.equal(reads, 1);
});
const connectionId = '00000000-0000-4000-8000-000000000001';

class Query {
    constructor(db, table) {
        this.db = db; this.table = table; this.filters = []; this.action = 'select';
        this.payload = null; this.cardinality = null;
    }
    select() { return this; }
    eq(field, value) { this.filters.push([field, value, '=']); return this; }
    is(field, value) { this.filters.push([field, value, 'is']); return this; }
    contains(field, value) { this.filters.push([field, value, 'contains']); return this; }
    maybeSingle() { this.cardinality = 'maybe'; return this; }
    single() { this.cardinality = 'single'; return this; }
    insert(value) { this.action = 'insert'; this.payload = value; return this; }
    update(value) { this.action = 'update'; this.payload = value; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }
    run() {
        const rows = this.db.tables[this.table] || (this.db.tables[this.table] = []);
        const jsonContains = (actual, expected) => {
            if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
                return actual && typeof actual === 'object' && !Array.isArray(actual)
                    && Object.entries(expected).every(([key, value]) => jsonContains(actual[key], value));
            }
            if (Array.isArray(expected)) return Array.isArray(actual) && expected.every(item => actual.some(value => jsonContains(value, item)));
            return actual === expected;
        };
        const matches = row => this.filters.every(([field, value, op]) => op === 'is'
            ? row[field] === value
            : op === 'contains' ? jsonContains(row[field], value) : row[field] === value);
        if (this.action === 'insert') {
            const row = { ...this.payload, id: this.payload.id || `id-${++this.db.sequence}` };
            rows.push(row);
            return { data: this.cardinality ? row : null, error: null };
        }
        if (this.action === 'update') {
            const found = rows.filter(matches);
            found.forEach(row => Object.assign(row, this.payload));
            const data = this.cardinality === 'single' ? (found[0] || null) : this.cardinality === 'maybe' ? (found[0] || null) : null;
            return { data, error: this.cardinality === 'single' && !data ? { message: 'not found' } : null };
        }
        const found = rows.filter(matches);
        const data = this.cardinality === 'single' ? (found[0] || null) : this.cardinality === 'maybe' ? (found[0] || null) : found;
        return { data, error: this.cardinality === 'single' && !data ? { message: 'not found' } : null };
    }
}

class MemoryDb {
    constructor({ draft, receipts = [] } = {}) {
        this.sequence = 0;
        this.rpcCalls = 0;
        this.tables = {
            tenants: [{ tenant_id: tenant, status: 'active' }],
            provider_connections: [{ id: connectionId, tenant_id: tenant, provider: 'outlook', enabled: true, channels: ['email'], provider_account_id: 'owner@example.com' }],
            mailbox_drafts: [{ id: 'draft-row', tenant_id: tenant, provider_connection_id: connectionId, provider_draft_id: 'draft-1', provider_message_id: 'message-1', provider_thread_id: 'thread-1', provider_change_key: 'change-1', status: 'created', revision: 1, active_update_id: null, ...(draft || {}) }],
            mailbox_draft_update_receipts: receipts,
            mailbox_audit_events: [],
        };
    }
    from(table) { return new Query(this, table); }
    async rpc(name, args) {
        if (name === 'claim_mailbox_draft_update') {
            const draft = this.tables.mailbox_drafts.find(row => row.id === args.p_mailbox_draft_id
                && row.tenant_id === args.p_tenant_id && row.revision === args.p_expected_revision
                && row.active_update_id === null);
            const receipt = this.tables.mailbox_draft_update_receipts.find(row => row.id === args.p_receipt_id && row.status === 'reserved');
            if (!draft || !receipt) return { data: false, error: null };
            draft.active_update_id = receipt.id;
            draft.active_update_lease_until = new Date(Date.now() + 90_000).toISOString();
            receipt.status = 'applying';
            receipt.lease_until = draft.active_update_lease_until;
            return { data: true, error: null };
        }
        if (name === 'release_mailbox_draft_update') {
            const draft = this.tables.mailbox_drafts.find(row => row.id === args.p_mailbox_draft_id && row.tenant_id === args.p_tenant_id);
            const receipt = this.tables.mailbox_draft_update_receipts.find(row => row.id === args.p_receipt_id);
            if (draft) { draft.active_update_id = null; draft.active_update_lease_until = null; }
            if (receipt) Object.assign(receipt, { status: 'failed', error_code: args.p_error_code, error_status: args.p_error_status, last_error: args.p_error, lease_until: null });
            return { data: true, error: null };
        }
        if (name !== 'finalize_mailbox_draft_update') return { data: null, error: { message: 'unexpected rpc' } };
        this.rpcCalls += 1;
        const draft = this.tables.mailbox_drafts.find(row => row.id === args.p_mailbox_draft_id
            && row.tenant_id === args.p_tenant_id && row.active_update_id === args.p_receipt_id
            && row.revision === args.p_expected_revision);
        const receipt = this.tables.mailbox_draft_update_receipts.find(row => row.id === args.p_receipt_id);
        if (!draft || !receipt) return { data: null, error: { message: 'claim changed' } };
        Object.assign(draft, {
            provider_draft_id: args.p_provider_draft_id,
            provider_message_id: args.p_provider_message_id || draft.provider_message_id,
            provider_thread_id: args.p_provider_thread_id || draft.provider_thread_id,
            provider_change_key: args.p_result.provider_change_key || null,
            revision: draft.revision + 1,
            active_update_id: null,
        });
        const result = { ...args.p_result, revision: draft.revision, updated_at: 'now' };
        Object.assign(receipt, { status: 'updated', result });
        return { data: result, error: null };
    }
}

test('Gmail receipt recovery reads the draft ID, preserves a changed message ID and renders full MIME', async () => {
    const db = new MemoryDb({ draft: { provider_draft_id: 'r-123', provider_message_id: 'old-message' } });
    db.tables.provider_connections[0].provider = 'gmail';
    let provider = { id: 'r-123', message: { id: 'new-message', threadId: 'thread-1', labelIds: ['DRAFT'], payload: {
        mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'Edited Gmail draft' }, { name: 'To', value: 'recipient@example.com' }],
        parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Current Gmail text').toString('base64url') } }],
    } } };
    const calls = [];
    const deps = {
        accessCredential: async () => ({ access_token: 'test-only' }),
        getOutlookDraft: async () => { throw new Error('Gmail must not use Outlook'); },
        getGmailDraft: (token, id, options) => getGmailDraft(token, id, { ...options, request: async (_token, path) => { calls.push(path); return provider; } }),
    };
    const read = (database, args) => getMailboxDraft(database, args, deps);
    const recover = () => getMailboxDraftByReceipt(db, { tenantId: tenant, receiptId: 'draft-row' }, read);
    const before = JSON.stringify(db.tables);
    const result = await recover();
    assert.deepEqual(calls, ['/drafts/r-123?format=full']);
    assert.equal(result.provider_draft_id, 'r-123');
    assert.equal(result.provider.message_id, 'new-message');
    assert.equal(result.provider.is_draft, true);
    assert.equal(result.preview.provider, 'gmail');
    assert.equal(result.preview.body, 'Current Gmail text');
    assert.deepEqual(result.preview.to, ['recipient@example.com']);
    assert.equal(JSON.stringify(db.tables), before);
    provider.message.labelIds = ['SENT'];
    await assert.rejects(recover(), /no longer an editable draft/);
    provider.message.labelIds = ['DRAFT']; provider.id = 'other-draft';
    await assert.rejects(recover(), /not found/);
    provider = null;
    await assert.rejects(recover(), /not found/);
    deps.getGmailDraft = async () => { throw Object.assign(new Error('Gmail unavailable'), { status: 503 }); };
    await assert.rejects(recover(), /Gmail unavailable/);
    assert.equal(JSON.stringify(db.tables), before);
});

const providerOps = ({ subject = 'Updated' } = {}) => {
    const calls = { update: 0, get: 0 };
    return {
        calls,
        updateOutlookDraft: async () => {
            calls.update += 1;
            return { id: 'draft-1', isDraft: true, changeKey: 'change-2', conversationId: 'thread-1', subject };
        },
        getOutlookDraft: async () => {
            calls.get += 1;
            return { id: 'draft-1', isDraft: true, conversationId: 'thread-1', subject, body: { contentType: 'Text', content: 'body' } };
        },
    };
};

const input = { subject: 'Updated', text: 'body' };
const requestHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const microsoftTokenForTenant = tenantId => ({
    id_token: ['header', Buffer.from(JSON.stringify({ tid: tenantId })).toString('base64url'), 'signature'].join('.'),
});

describe('Outlook multitenant directory binding', () => {
    const directoryA = '12345678-90ab-cdef-1234-567890abcdef';
    const directoryB = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    test('records the provider directory for a new Outlook connection', () => {
        assert.equal(outlookProviderTenantId(null, microsoftTokenForTenant(directoryA)), directoryA);
    });

    test('permits reconnect only to the same Microsoft directory', () => {
        const existing = { metadata: { provider_tenant_id: directoryA } };
        assert.equal(outlookProviderTenantId(existing, microsoftTokenForTenant(directoryA)), directoryA);
        assert.throws(
            () => outlookProviderTenantId(existing, microsoftTokenForTenant(directoryB)),
            /different Microsoft directory/
        );
    });
});
const options = (db, key, request = input, ops = providerOps()) => ({
    tenantId: tenant, connectionId, draftId: 'draft-1', idempotencyKey: key, request,
    credentialOverride: { access_token: 'test' }, providerOps: ops, db,
});

for (const provider of ['gmail', 'outlook']) for (const state of ['sent', 'deleted']) {
    test(`${provider} ${state} draft remains held on exact retry without mutation or replacement`, async () => {
        const db = new MemoryDb();
        db.tables.provider_connections[0].provider = provider;
        let reads = 0; let writes = 0;
        const request = async (_token, _path, init) => {
            if (init?.method && init.method !== 'GET') { writes++; throw new Error('Must not mutate a sent or deleted draft'); }
            reads++;
            if (state === 'deleted') throw Object.assign(new Error('Provider draft not found'), { status: 404 });
            return provider === 'gmail'
                ? { id: 'draft-1', message: { id: 'message-1', labelIds: ['SENT'] } }
                : { id: 'draft-1', isDraft: false, changeKey: 'change-1' };
        };
        const ops = {
            updateGmailDraft: (token, id, body, mailbox, opts) => updateGmailDraft(token, id, body, mailbox, { ...opts, request }),
            updateOutlookDraft: (token, id, body, opts) => updateOutlookDraft(token, id, body, { ...opts, request }),
            createGmailDraft: async () => { writes++; throw new Error('Must not create a replacement'); },
            createOutlookDraft: async () => { writes++; throw new Error('Must not create a replacement'); },
        };
        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(updateMailboxDraft(db, options(db, `${provider}-${state}`, input, ops)), error => {
                assert.equal(error.status, state === 'deleted' ? 404 : 409);
                if (state === 'sent') assert.equal(error.code, 'DRAFT_NOT_EDITABLE');
                return true;
            });
        }
        assert.equal(reads, 1);
        assert.equal(writes, 0);
        assert.equal(db.tables.mailbox_drafts[0].provider_draft_id, 'draft-1');
        assert.equal(db.tables.mailbox_drafts[0].revision, 1);
        assert.equal(db.tables.mailbox_drafts[0].active_update_id, null);
        assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
    });
}

test('Gmail update rejects a human replacement, retains the baseline, and does not replay a failed key', async () => {
    const db = new MemoryDb();
    db.tables.provider_connections[0].provider = 'gmail';
    let reads = 0; let writes = 0;
    const ops = { updateGmailDraft: (token, id, body, mailbox, options) => updateGmailDraft(token, id, body, mailbox, {
        ...options, request: async (_token, _path, request) => {
            if (request?.method === 'PUT') { writes++; throw new Error('Must not overwrite human content'); }
            reads++;
            return { id: 'draft-1', message: { id: 'human-version', labelIds: ['DRAFT'] } };
        }
    }) };
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(updateMailboxDraft(db, options(db, 'human-conflict', input, ops)),
            error => error.status === 409 && error.code === 'DRAFT_PROVIDER_CHANGED');
    }
    assert.equal(reads, 1); assert.equal(writes, 0);
    assert.equal(db.tables.mailbox_drafts[0].provider_message_id, 'message-1');
    assert.equal(db.tables.mailbox_drafts[0].revision, 1);
    assert.equal(db.tables.mailbox_drafts[0].active_update_id, null);
    assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
});

test('Gmail update persists each replacement message ID as the next guarded baseline', async () => {
    const db = new MemoryDb();
    db.tables.provider_connections[0].provider = 'gmail';
    let version = 1; let writes = 0;
    const provider = () => ({ id: 'draft-1', message: { id: `message-${version}`, threadId: 'thread-1', labelIds: ['DRAFT'], payload: {
        headers: [{ name: 'To', value: 'recipient@example.com' }, { name: 'Subject', value: 'Test' }],
        mimeType: 'text/plain', body: { data: Buffer.from('Original').toString('base64url') }
    } } });
    const ops = { updateGmailDraft: (token, id, body, mailbox, options) => updateGmailDraft(token, id, body, mailbox, {
        ...options, request: async (_token, _path, request) => {
            if (request?.method === 'PUT') { writes++; version++; }
            return provider();
        }
    }) };
    for (let i = 1; i <= 2; i++) {
        const result = await updateMailboxDraft(db, options(db, `update-${i}`, { ...input, revision: i }, ops));
        assert.equal(result.provider_message_id, `message-${i + 1}`);
        assert.equal(result.revision, i + 1);
    }
    assert.equal(writes, 2);
    assert.equal(db.tables.mailbox_drafts[0].provider_message_id, 'message-3');
});

test('Gmail legacy draft without a saved message version is held before any provider mutation', async () => {
    const db = new MemoryDb({ draft: { provider_message_id: null } });
    db.tables.provider_connections[0].provider = 'gmail';
    let calls = 0;
    await assert.rejects(updateMailboxDraft(db, options(db, 'missing-version', input, {
        updateGmailDraft: async () => { calls++; }
    })), error => error.status === 409 && error.code === 'DRAFT_VERSION_UNAVAILABLE');
    assert.equal(calls, 0);
    assert.equal(db.tables.mailbox_drafts[0].active_update_id, null);
});

describe('mailbox draft create recovery', () => {
    const make = () => { const db = new MemoryDb(); db.tables.mailbox_drafts = []; return db; };
    const args = { tenantId: tenant, connectionId, idempotencyKey: 'create-test', request: { to: ['person@example.com'], subject: 'Test', text: 'Body' } };
    const credentialOverride = { access_token: 'test' };
    test('pre-provider credential failure can be retried once with the same receipt', async () => {
        const db = make(); let calls = 0;
        const providerOps = { createOutlookDraft: async () => { calls++; return { id: 'new-draft' }; } };
        await assert.rejects(createMailboxDraft(db, { ...args, providerOps }));
        assert.match(db.tables.mailbox_drafts[0].last_error, /^\[before-provider\]/);
        const result = await createMailboxDraft(db, { ...args, credentialOverride, providerOps });
        assert.equal(result.status, 'created');
        await createMailboxDraft(db, { ...args, credentialOverride, providerOps });
        assert.equal(calls, 1);
        assert.equal(db.tables.mailbox_drafts.length, 1);
    });
    test('unknown create outcome and legacy errors cannot trigger another provider create', async () => {
        const db = make(); let calls = 0;
        const providerOps = { createOutlookDraft: async () => { calls++; throw new Error('socket timeout'); } };
        await assert.rejects(createMailboxDraft(db, { ...args, credentialOverride, providerOps }), /socket timeout/);
        await assert.rejects(createMailboxDraft(db, { ...args, credentialOverride, providerOps }), /reconciliation/);
        assert.equal(calls, 1);
    });
    test('known partial reply identity is saved and exact provider content reconciles without create', async () => {
        const db = make(); let calls = 0;
        const providerOps = {
            createOutlookDraft: async () => { calls++; throw Object.assign(new Error('read timeout'), { providerDraftId: 'known-draft' }); },
            getOutlookDraft: async () => ({ id: 'known-draft', isDraft: true, changeKey: 'recovered-version', subject: 'Test', toRecipients: [{ emailAddress: { address: 'person@example.com' } }], body: { contentType: 'text', content: 'Body' } }),
        };
        await assert.rejects(createMailboxDraft(db, { ...args, credentialOverride, providerOps }), /read timeout/);
        assert.equal(db.tables.mailbox_drafts[0].provider_draft_id, 'known-draft');
        const result = await createMailboxDraft(db, { ...args, credentialOverride, providerOps });
        assert.equal(result.status, 'created');
        assert.equal(result.provider_change_key, 'recovered-version');
        assert.equal(calls, 1);
    });
    test('a changed provider draft remains held and is never overwritten', async () => {
        const db = make();
        const providerOps = {
            createOutlookDraft: async () => { throw Object.assign(new Error('read timeout'), { providerDraftId: 'known-draft' }); },
            getOutlookDraft: async () => ({ id: 'known-draft', isDraft: true, subject: 'Human edit', body: { contentType: 'text', content: 'Changed' } }),
        };
        await assert.rejects(createMailboxDraft(db, { ...args, credentialOverride, providerOps }));
        await assert.rejects(createMailboxDraft(db, { ...args, credentialOverride, providerOps }), /reconciliation/);
        assert.equal(db.tables.mailbox_drafts[0].status, 'failed');
    });
    test('Gmail create reconciliation retains the verified message baseline for later updates', async () => {
        const db = make(); db.tables.provider_connections[0].provider = 'gmail';
        const providerOps = {
            createGmailDraft: async () => { throw Object.assign(new Error('read timeout'), { providerDraftId: 'known-draft' }); },
            getGmailDraft: async () => ({ id: 'known-draft', message: { id: 'verified-message', threadId: 'verified-thread', labelIds: ['DRAFT'], payload: {
                headers: [{ name: 'Subject', value: 'Test' }, { name: 'To', value: 'person@example.com' }],
                mimeType: 'text/plain', body: { data: Buffer.from('Body').toString('base64url') }
            } } }),
        };
        await assert.rejects(createMailboxDraft(db, { ...args, credentialOverride, providerOps }), /read timeout/);
        const result = await createMailboxDraft(db, { ...args, credentialOverride, providerOps });
        assert.equal(result.status, 'created');
        assert.equal(result.provider_message_id, 'verified-message');
        assert.equal(result.provider_thread_id, 'verified-thread');
    });
    test('audit outage does not downgrade successful creation', async () => {
        const db = make(); const from = db.from.bind(db); let calls = 0;
        db.from = table => { if (table === 'mailbox_audit_events') throw new Error('audit unavailable'); return from(table); };
        const providerOps = { createOutlookDraft: async () => { calls++; return { id: 'new-draft' }; } };
        await createMailboxDraft(db, { ...args, credentialOverride, providerOps });
        const result = await createMailboxDraft(db, { ...args, credentialOverride, providerOps });
        assert.equal(result.status, 'created'); assert.equal(calls, 1);
    });
});

describe('mailbox draft update service state machine', () => {
    test('HTTP PATCH requires authentication and Idempotency-Key', async () => {
        const previous = { api: process.env.API_KEY, legacy: process.env.LEGACY_TENANT_ID };
        process.env.API_KEY = 'mailbox-http-test-key';
        process.env.LEGACY_TENANT_ID = tenant;
        const app = Fastify(serverOptions);
        const db = new MemoryDb();
        await app.register(v1Routes, { prefix: '/v1', database: db });
        try {
            const unauthenticated = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/draft-1`, payload: input,
            });
            assert.equal(unauthenticated.statusCode, 401);
            const receiptUrl = '/v1/mailboxes/drafts/receipts/missing';
            assert.equal((await app.inject({ method: 'GET', url: receiptUrl })).statusCode, 401);
            assert.equal((await app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant } })).statusCode, 404);
            assert.equal((await app.inject({ method: 'GET', url: receiptUrl, headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': 'foreign' } })).statusCode, 403);
            const longId = 'AAMk' + 'x'.repeat(180) + '/+=';
            const longUrl = `/v1/mailboxes/${connectionId}/drafts/${encodeURIComponent(longId)}`;
            assert.equal((await app.inject({ method: 'GET', url: longUrl })).statusCode, 401);
            const longDraft = await app.inject({ method: 'GET', url: longUrl, headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant } });
            assert.equal(longDraft.statusCode, 404);
            assert.equal(longDraft.json().error, 'Mailbox draft not found');
            const oversized = await app.inject({ method: 'GET', url: `/v1/mailboxes/${connectionId}/drafts/${'x'.repeat(2049)}` });
            assert.equal(oversized.statusCode, 414);
            db.tables.api_clients = [{
                id: 'draft-capability-client', key_id: 'draft-capability',
                secret_hash: await hashApiSecret('draft-capability-secret-1234567890'),
                allowed_tenants: [tenant], roles: [], capabilities: ['communications:write'],
            }];
            delete process.env.API_KEY;
            db.tables.api_clients[0].capabilities.push('communications:read');
            const deniedReceipt = await app.inject({ method: 'GET', url: receiptUrl,
                headers: { 'x-api-key': 'draft-capability.draft-capability-secret-1234567890', 'x-tenant-id': tenant } });
            assert.equal(deniedReceipt.statusCode, 403);
            assert.match(deniedReceipt.json().error, /email:draft/);
            const denied = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
                headers: { 'x-api-key': 'draft-capability.draft-capability-secret-1234567890', 'x-tenant-id': tenant, 'Idempotency-Key': 'capability-denied' },
                payload: input,
            });
            assert.equal(denied.statusCode, 403);
            assert.match(denied.json().error, /email:draft/);
            process.env.API_KEY = 'mailbox-http-test-key';
            const missingKey = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
                headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant }, payload: input,
            });
            assert.ok([400, 403].includes(missingKey.statusCode));
            if (missingKey.statusCode === 400) assert.equal(missingKey.json().code, 'IDEMPOTENCY_REQUIRED');
            const notFound = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/missing-draft`,
                headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant, 'Idempotency-Key': 'http-not-found' },
                payload: input,
            });
            assert.equal(notFound.statusCode, 404);
            assert.equal(notFound.json().code, 'DRAFT_NOT_FOUND');
            db.tables.mailbox_draft_update_receipts.push({
                id: 'http-updated', tenant_id: tenant, provider_connection_id: connectionId,
                mailbox_draft_id: 'draft-row', idempotency_key: 'http-updated',
                request_hash: requestHash(input), status: 'updated',
                result: { id: 'draft-row', provider_draft_id: 'draft-1', revision: 2 },
            });
            const replay = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
                headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant, 'Idempotency-Key': 'http-updated' },
                payload: input,
            });
            assert.equal(replay.statusCode, 200);
            db.tables.mailbox_draft_update_receipts.push({
                id: 'http-conflict', tenant_id: tenant, provider_connection_id: connectionId,
                mailbox_draft_id: 'draft-row', idempotency_key: 'http-conflict',
                request_hash: requestHash(input), status: 'updated',
                result: { id: 'draft-row', provider_draft_id: 'draft-1', revision: 2 },
            });
            const conflict = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
                headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant, 'Idempotency-Key': 'http-conflict' },
                payload: { subject: 'Different' },
            });
            assert.equal(conflict.statusCode, 409);
            assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT');
            db.tables.mailbox_draft_update_receipts.push({
                id: 'http-failed', tenant_id: tenant, provider_connection_id: connectionId,
                mailbox_draft_id: 'draft-row', idempotency_key: 'http-failed',
                request_hash: requestHash(input), status: 'failed', error_status: 502,
                error_code: 'DRAFT_PROVIDER_FAILED', last_error: 'provider unavailable',
            });
            const failed = await app.inject({
                method: 'PATCH', url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
                headers: { 'x-api-key': 'mailbox-http-test-key', 'x-tenant-id': tenant, 'Idempotency-Key': 'http-failed' },
                payload: input,
            });
            assert.equal(failed.statusCode, 502);
            assert.equal(failed.json().code, 'DRAFT_PROVIDER_FAILED');
        } finally {
            await app.close();
            if (previous.api === undefined) delete process.env.API_KEY; else process.env.API_KEY = previous.api;
            if (previous.legacy === undefined) delete process.env.LEGACY_TENANT_ID; else process.env.LEGACY_TENANT_ID = previous.legacy;
        }
    });

    test('finalizes atomically and exact retry does not mutate provider twice', async () => {
        const db = new MemoryDb();
        const ops = providerOps();
        const first = await updateMailboxDraft(db, options(db, 'key-one', input, ops));
        const second = await updateMailboxDraft(db, options(db, 'key-one', input, ops));
        assert.equal(first.provider_draft_id, 'draft-1');
        assert.equal(first.revision, 2);
        assert.deepEqual(second, first);
        assert.equal(ops.calls.update, 1);
        assert.equal(db.rpcCalls, 1);
        assert.equal(db.tables.mailbox_drafts[0].active_update_id, null);
    });

    test('exact retry of a reserved receipt with no active claim safely starts once', async () => {
        const ops = providerOps();
        const reserved = {
            id: 'reserved-receipt', tenant_id: tenant, provider_connection_id: connectionId,
            mailbox_draft_id: 'draft-row', idempotency_key: 'reserved-key',
            request_hash: requestHash(input), update_request: { subject: 'Updated', text: 'body' },
            base_revision: 1, status: 'reserved',
        };
        const db = new MemoryDb({ receipts: [reserved] });
        const result = await updateMailboxDraft(db, options(db, 'reserved-key', input, ops));
        assert.equal(result.revision, 2);
        assert.equal(ops.calls.update, 1);
    });

    test('same key with different content conflicts', async () => {
        const db = new MemoryDb();
        const ops = providerOps();
        await updateMailboxDraft(db, options(db, 'key-one', input, ops));
        await assert.rejects(updateMailboxDraft(db, options(db, 'key-one', { subject: 'Different', text: 'body' }, ops)),
            error => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT');
        assert.equal(ops.calls.update, 1);
    });

    test('a competing active claim never reaches the provider', async () => {
        const db = new MemoryDb({ draft: { active_update_id: 'winner-receipt' } });
        const ops = providerOps();
        await assert.rejects(updateMailboxDraft(db, options(db, 'key-two', input, ops)),
            error => error.status === 409 && error.code === 'DRAFT_UPDATE_IN_PROGRESS');
        assert.equal(ops.calls.update, 0);
    });

    test('tenant predicates prevent a foreign draft from being updated', async () => {
        const db = new MemoryDb({ draft: { tenant_id: 'other-tenant' } });
        const ops = providerOps();
        await assert.rejects(updateMailboxDraft(db, options(db, 'foreign-key', input, ops)),
            error => error.status === 404 && error.code === 'DRAFT_NOT_FOUND');
        assert.equal(ops.calls.update, 0);
        assert.equal(db.tables.mailbox_drafts[0].active_update_id, null);
    });

    test('exact uncertain retry reconciles a matching provider draft without mutation', async () => {
        const receipt = {
            id: 'uncertain-receipt', tenant_id: tenant, provider_connection_id: connectionId,
            mailbox_draft_id: 'draft-row', idempotency_key: 'uncertain-key',
            request_hash: requestHash({ subject: 'Updated' }), update_request: { subject: 'Updated' }, base_revision: 1, status: 'uncertain',
            lease_until: new Date(Date.now() - 1000).toISOString(),
        };
        const db = new MemoryDb({ draft: { active_update_id: receipt.id }, receipts: [receipt] });
        const ops = providerOps();
        const result = await updateMailboxDraft(db, options(db, 'uncertain-key', { subject: 'Updated' }, ops));
        assert.equal(result.revision, 2);
        assert.equal(ops.calls.update, 0);
        assert.equal(ops.calls.get, 1);
    });

    test('exact uncertain retry does not finalize an unproven provider state', async () => {
        const receipt = {
            id: 'uncertain-receipt', tenant_id: tenant, provider_connection_id: connectionId,
            mailbox_draft_id: 'draft-row', idempotency_key: 'uncertain-key',
            request_hash: requestHash({ subject: 'Updated' }), update_request: { subject: 'Updated' }, base_revision: 1, status: 'uncertain',
            lease_until: new Date(Date.now() - 1000).toISOString(),
        };
        const db = new MemoryDb({ draft: { active_update_id: receipt.id }, receipts: [receipt] });
        const ops = providerOps({ subject: 'Other' });
        await assert.rejects(updateMailboxDraft(db, options(db, 'uncertain-key', { subject: 'Updated' }, ops)),
            error => error.status === 409 && error.code === 'DRAFT_RECONCILIATION_REQUIRED');
        assert.equal(ops.calls.update, 0);
        assert.equal(db.tables.mailbox_drafts[0].revision, 1);
        assert.equal(db.tables.mailbox_drafts[0].active_update_id, receipt.id);
        assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'uncertain');
    });

    test('reconciliation GET transient errors keep the claim and forbid a second mutation', async () => {
        const receipt = {
            id: 'timeout-receipt', tenant_id: tenant, provider_connection_id: connectionId,
            mailbox_draft_id: 'draft-row', idempotency_key: 'timeout-key',
            request_hash: requestHash({ subject: 'Updated' }), update_request: { subject: 'Updated' },
            base_revision: 1, status: 'uncertain', lease_until: new Date(Date.now() - 1000).toISOString(),
        };
        const db = new MemoryDb({ draft: { active_update_id: receipt.id }, receipts: [receipt] });
        const ops = providerOps();
        ops.getOutlookDraft = async () => { ops.calls.get += 1; throw Object.assign(new Error('timeout'), { status: 503 }); };
        await assert.rejects(updateMailboxDraft(db, options(db, 'timeout-key', { subject: 'Updated' }, ops)),
            error => error.status === 409 && error.code === 'DRAFT_RECONCILIATION_REQUIRED');
        assert.equal(ops.calls.update, 0);
        assert.equal(db.tables.mailbox_drafts[0].active_update_id, receipt.id);
        assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'uncertain');
    });

    test('deterministic provider 4xx fails terminally and releases the claim', async () => {
        const db = new MemoryDb();
        const ops = providerOps();
        ops.updateOutlookDraft = async () => {
            ops.calls.update += 1;
            const error = new Error('invalid draft');
            error.status = 400;
            error.code = 'DRAFT_INPUT_INVALID';
            throw error;
        };
        await assert.rejects(updateMailboxDraft(db, options(db, 'bad-provider-input', input, ops)),
            error => error.status === 400 && error.code === 'DRAFT_INPUT_INVALID');
        await assert.rejects(updateMailboxDraft(db, options(db, 'bad-provider-input', input, ops)),
            error => error.status === 400 && error.code === 'DRAFT_INPUT_INVALID');
        assert.equal(db.tables.mailbox_drafts[0].active_update_id, null);
        assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
    });
});

test('HTTP reviewed recovery requires both capabilities and maps only review authorization fields', async () => {
    const previous = { api: process.env.API_KEY, legacy: process.env.LEGACY_TENANT_ID };
    delete process.env.API_KEY;
    process.env.LEGACY_TENANT_ID = tenant;
    const db = new MemoryDb({ receipts: [failedChangedReceipt()] });
    db.tables.api_clients = [{
        id: 'recovery-capability-client',
        key_id: 'recovery-capability',
        secret_hash: await hashApiSecret('recovery-capability-secret-1234567890'),
        allowed_tenants: [tenant],
        roles: [],
        capabilities: ['email:draft'],
    }];
    const app = Fastify(serverOptions);
    await app.register(v1Routes, { prefix: '/v1', database: db });
    const headers = {
        'x-api-key': 'recovery-capability.recovery-capability-secret-1234567890',
        'x-tenant-id': tenant,
        'Idempotency-Key': 'http-recovery-new-key',
    };
    const url = `/v1/mailboxes/${connectionId}/drafts/draft-1/recover`;
    try {
        const missingWrite = await app.inject({ method: 'POST', url, headers, payload: {} });
        assert.equal(missingWrite.statusCode, 403);
        assert.match(missingWrite.json().error, /communications:write/);
        db.tables.api_clients[0].capabilities = ['communications:write'];
        const missingDraft = await app.inject({ method: 'POST', url, headers, payload: {} });
        assert.equal(missingDraft.statusCode, 403);
        assert.match(missingDraft.json().error, /email:draft/);
        db.tables.api_clients[0].capabilities.push('email:draft');
        const invalidHash = await app.inject({
            method: 'POST', url, headers,
            payload: { failed_update_receipt_id: 'rejected-update', reviewed_content_hash: 'invalid', expected_revision: 1 },
        });
        assert.equal(invalidHash.statusCode, 422);
        assert.equal(invalidHash.json().code, 'INVALID_RECOVERY_REVIEW');
        const missingReceipt = await app.inject({
            method: 'POST', url, headers,
            payload: { reviewed_content_hash: 'a'.repeat(64), expected_revision: 1 },
        });
        assert.equal(missingReceipt.statusCode, 422);
        assert.equal(missingReceipt.json().code, 'INVALID_RECOVERY_RECEIPT');
        const replacementPayload = await app.inject({
            method: 'POST', url, headers,
            payload: { failed_update_receipt_id: 'rejected-update', reviewed_content_hash: 'a'.repeat(64), expected_revision: 1, subject: 'Must not be accepted' },
        });
        assert.equal(replacementPayload.statusCode, 422);
        assert.equal(replacementPayload.json().code, 'INVALID_RECOVERY_BODY');
        const recoveryBinding = {
            failed_update_receipt_id: 'rejected-update',
            reviewed_content_hash: 'a'.repeat(64),
            expected_revision: 1,
        };
        const recoveryReceipt = {
            id: 'completed-http-recovery',
            tenant_id: tenant,
            provider_connection_id: connectionId,
            mailbox_draft_id: 'draft-row',
            idempotency_key: 'http-recovery-new-key',
            request_hash: requestHash({ subject: 'Approved', revision: 1, recovery_binding: recoveryBinding }),
            update_request: { subject: 'Approved', recovery_binding: recoveryBinding },
            base_revision: 1,
            status: 'updated',
            result: { provider_draft_id: 'draft-1', revision: 2, update_receipt_id: 'completed-http-recovery' },
        };
        db.tables.mailbox_draft_update_receipts.push(recoveryReceipt);
        const patchBypass = await app.inject({
            method: 'PATCH',
            url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
            headers,
            payload: {
                subject: 'Approved',
                revision: 1,
                reviewedRecovery: { failedUpdateReceiptId: 'rejected-update', reviewedContentHash: 'a'.repeat(64), expectedRevision: 1 },
                recovery_binding: recoveryBinding,
            },
        });
        assert.equal(patchBypass.statusCode, 409);
        assert.equal(patchBypass.json().code, 'IDEMPOTENCY_CONFLICT');
        assert.equal(recoveryReceipt.status, 'updated');
        assert.equal(db.tables.mailbox_draft_update_receipts.length, 2);
    } finally {
        await app.close();
        if (previous.api === undefined) delete process.env.API_KEY; else process.env.API_KEY = previous.api;
        if (previous.legacy === undefined) delete process.env.LEGACY_TENANT_ID; else process.env.LEGACY_TENANT_ID = previous.legacy;
    }
});

test('reviewed baseline adoption saves the exact read version of a legacy Outlook draft and never writes the provider', async () => {
    const db = new MemoryDb({ draft: { provider_change_key: null } });
    let provider = { id: 'draft-1', isDraft: true, changeKey: 'reviewed-key', conversationId: 'thread-1', subject: 'Old routing question',
        toRecipients: [{ emailAddress: { address: 'Person@Example.com' } }], body: { contentType: 'text', content: 'Which team should handle this?' } };
    const deps = { accessCredential: async () => ({ access_token: 'test-only' }), getOutlookDraft: async () => provider,
        getGmailDraft: async () => { throw new Error('Outlook only'); } };
    const args = { tenantId: tenant, connectionId, draftId: 'draft-1', actorId: 'reviewer' };
    const reviewed = await getMailboxDraft(db, args, deps);
    assert.equal(reviewed.preview.content_hash, draftContentHash(reviewed.preview));
    const hash = reviewed.preview.content_hash;

    await assert.rejects(adoptMailboxDraftBaseline(db, { ...args, reviewedContentHash: 'nope', expectedRevision: 1 }, deps), error => error.status === 422);
    await assert.rejects(adoptMailboxDraftBaseline(db, { ...args, reviewedContentHash: hash, expectedRevision: 2 }, deps), error => error.code === 'STALE_REVISION');
    provider = { ...provider, changeKey: 'human-edit', body: { contentType: 'text', content: 'Edited in Outlook' } };
    await assert.rejects(adoptMailboxDraftBaseline(db, { ...args, reviewedContentHash: hash, expectedRevision: 1 }, deps), error => error.code === 'DRAFT_PROVIDER_CHANGED');
    db.tables.mailbox_drafts[0].active_update_id = 'other-update';
    provider = { ...provider, changeKey: 'reviewed-key', body: { contentType: 'text', content: 'Which team should handle this?' } };
    await assert.rejects(adoptMailboxDraftBaseline(db, { ...args, reviewedContentHash: hash, expectedRevision: 1 }, deps), error => error.code === 'DRAFT_UPDATE_IN_PROGRESS');
    db.tables.mailbox_drafts[0].active_update_id = null;
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, null);

    const adopted = await adoptMailboxDraftBaseline(db, { ...args, reviewedContentHash: hash, expectedRevision: 1 }, deps);
    assert.equal(adopted.baseline_adopted, true);
    assert.equal(adopted.revision, 1);
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'reviewed-key');
    assert.equal(db.tables.mailbox_audit_events.at(-1).action, 'mailbox.draft.baseline_adopted');
    await assert.rejects(adoptMailboxDraftBaseline(db, { ...args, reviewedContentHash: hash, expectedRevision: 1 }, deps), error => error.code === 'BASELINE_NOT_REQUIRED');

    // The update then runs under the adopted version guard.
    const guards = [];
    const updated = await updateMailboxDraft(db, { ...args, idempotencyKey: 'after-baseline', request: { subject: 'Inspection confirmed', text: 'See you Thursday' },
        credentialOverride: { access_token: 'test-only' }, providerOps: {
            updateOutlookDraft: async (_token, id, _request, options) => { guards.push(options.expectedChangeKey); return { id, isDraft: true, changeKey: 'next-key', conversationId: 'thread-1' }; },
        } });
    assert.deepEqual(guards, ['reviewed-key']);
    assert.equal(updated.revision, 2);
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'next-key');
});

test('baseline adoption refuses a version saved concurrently during review', async () => {
    const db = new MemoryDb({ draft: { provider_change_key: null } });
    const provider = { id: 'draft-1', isDraft: true, changeKey: 'reviewed-key', subject: 'S', body: { contentType: 'text', content: 'B' } };
    const deps = { accessCredential: async () => ({ access_token: 'test-only' }), getOutlookDraft: async () => {
        // Another writer saves a version after the record read but before the conditional update.
        db.tables.mailbox_drafts[0] = { ...db.tables.mailbox_drafts[0], provider_change_key: 'raced-key' };
        return provider;
    }, getGmailDraft: async () => null };
    const hash = draftContentHash(mailboxDraftPreview('outlook', provider, 'owner@example.com'));
    await assert.rejects(adoptMailboxDraftBaseline(db, { tenantId: tenant, connectionId, draftId: 'draft-1', reviewedContentHash: hash, expectedRevision: 1 }, deps),
        error => error.code === 'DRAFT_UPDATE_CONFLICT');
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'raced-key');
});

const failedChangedReceipt = (overrides = {}) => ({
    id: 'rejected-update',
    tenant_id: tenant,
    provider_connection_id: connectionId,
    mailbox_draft_id: 'draft-row',
    idempotency_key: 'old-update-key',
    request_hash: requestHash({ subject: 'Approved' }),
    update_request: { subject: 'Approved' },
    base_revision: 1,
    status: 'failed',
    error_status: 409,
    error_code: 'DRAFT_PROVIDER_CHANGED',
    last_error: 'Outlook draft changed outside this service',
    ...overrides,
});

const completedRecoveryReceipt = (original, overrides = {}) => {
    const binding = {
        failed_update_receipt_id: original.id,
        reviewed_content_hash: 'a'.repeat(64),
        expected_revision: Number(original.base_revision),
    };
    const updateRequest = { ...original.update_request, recovery_binding: binding };
    return {
        id: 'verified-recovery',
        tenant_id: tenant,
        provider_connection_id: connectionId,
        mailbox_draft_id: 'draft-row',
        idempotency_key: 'new-recovery-key',
        request_hash: requestHash({
            ...original.update_request,
            revision: Number(original.base_revision),
            recovery_binding: binding,
        }),
        update_request: updateRequest,
        base_revision: Number(original.base_revision),
        status: 'updated',
        result: {
            id: 'draft-row',
            provider_draft_id: 'draft-1',
            provider_message_id: 'draft-1',
            status: 'created',
            revision: Number(original.base_revision) + 1,
            provider_change_key: 'verified-recovery-key',
            update_receipt_id: 'verified-recovery',
            recovered_from_receipt_id: original.id,
            reviewed_content_hash: binding.reviewed_content_hash,
        },
        ...overrides,
    };
};

test('Fastify PATCH maps the original failure retry to its verified recovery result', async () => {
    const previous = { api: process.env.API_KEY, legacy: process.env.LEGACY_TENANT_ID };
    process.env.API_KEY = 'mailbox-recovery-replay-key';
    process.env.LEGACY_TENANT_ID = tenant;
    const original = failedChangedReceipt({
        request_hash: requestHash({ subject: 'Approved', revision: 1 }),
    });
    const linked = completedRecoveryReceipt(original);
    const db = new MemoryDb({ draft: { revision: 2 }, receipts: [original, linked] });
    const before = JSON.stringify(db.tables);
    const app = Fastify(serverOptions);
    await app.register(v1Routes, { prefix: '/v1', database: db });
    try {
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/mailboxes/${connectionId}/drafts/draft-1`,
            headers: {
                'x-api-key': 'mailbox-recovery-replay-key',
                'x-tenant-id': tenant,
                'Idempotency-Key': original.idempotency_key,
            },
            payload: { subject: 'Approved', revision: 1 },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), linked.result);
        assert.equal(JSON.stringify(db.tables), before);
    } finally {
        await app.close();
        if (previous.api === undefined) delete process.env.API_KEY; else process.env.API_KEY = previous.api;
        if (previous.legacy === undefined) delete process.env.LEGACY_TENANT_ID; else process.env.LEGACY_TENANT_ID = previous.legacy;
    }
});

const liveRecoveryProvider = (overrides = {}) => ({
    id: 'draft-1',
    isDraft: true,
    changeKey: 'reviewed-live-key',
    conversationId: 'thread-1',
    subject: 'Human-reviewed current subject',
    toRecipients: [{ emailAddress: { address: 'person@example.com' } }],
    ccRecipients: [],
    bccRecipients: [],
    replyTo: [],
    body: { contentType: 'text', content: 'Current human-edited body' },
    ...overrides,
});

const recoveryCall = (db, reviewedContentHash, extras = {}) => recoverMailboxDraft(db, {
    tenantId: tenant,
    connectionId,
    draftId: 'draft-1',
    actorId: 'reviewer',
    idempotencyKey: 'new-recovery-key',
    failedUpdateReceiptId: 'rejected-update',
    reviewedContentHash,
    expectedRevision: 1,
    ...extras,
}, {
    credentialOverride: { access_token: 'test-only' },
    providerOps: extras.providerOps || {},
});

test('reviewed Outlook recovery uses the approved live change key and retains the rejected receipt', async () => {
    const original = failedChangedReceipt();
    const db = new MemoryDb({ receipts: [original] });
    const originalBefore = structuredClone(original);
    const provider = liveRecoveryProvider();
    const reviewedContentHash = draftContentHash(mailboxDraftPreview('outlook', provider, 'owner@example.com'));
    const calls = { reads: [], updates: [] };
    const result = await recoveryCall(db, reviewedContentHash, {
        providerOps: {
            getOutlookDraft: async (_token, id, options) => { calls.reads.push({ id, options }); return provider; },
            updateOutlookDraft: async (_token, id, request, options) => {
                calls.updates.push({ id, request, options });
                return { ...provider, id, subject: 'Approved', changeKey: 'post-recovery-key' };
            },
        },
    });

    assert.deepEqual(calls.reads, [{ id: 'draft-1', options: { textBody: true } }]);
    assert.equal(calls.updates.length, 1);
    assert.deepEqual(calls.updates[0], {
        id: 'draft-1',
        request: { subject: 'Approved' },
        options: { expectedChangeKey: 'reviewed-live-key' },
    });
    assert.equal(result.provider_draft_id, 'draft-1');
    assert.equal(result.revision, 2);
    assert.equal(result.update_receipt_id, db.tables.mailbox_draft_update_receipts[1].id);
    assert.equal(result.recovered_from_receipt_id, original.id);
    assert.equal(result.reviewed_content_hash, reviewedContentHash);
    assert.deepEqual(original, originalBefore);
    assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
    assert.deepEqual(db.tables.mailbox_draft_update_receipts[1].update_request, {
        subject: 'Approved',
        recovery_binding: {
            failed_update_receipt_id: original.id,
            reviewed_content_hash: reviewedContentHash,
            expected_revision: 1,
        },
    });
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'post-recovery-key');
    const authEvent = db.tables.mailbox_audit_events.find(event => event.action === 'mailbox.draft.recovery_authorized');
    assert.equal(authEvent.outcome, 'succeeded');
    assert.equal(authEvent.details.failed_update_receipt_id, original.id);
    assert.equal(authEvent.details.update_receipt_id, result.update_receipt_id);
    assert.equal(authEvent.details.reviewed_content_hash, reviewedContentHash);

    const retried = await recoveryCall(db, reviewedContentHash, {
        providerOps: {
            getOutlookDraft: async () => { throw new Error('An exact completed retry must not read the provider'); },
            updateOutlookDraft: async () => { throw new Error('An exact completed retry must not mutate the provider'); },
        },
    });
    assert.deepEqual(retried, result);
    assert.equal(calls.updates.length, 1);
});

test('original Outlook failure key resolves read-only to the verified recovery result', async () => {
    const original = failedChangedReceipt({
        request_hash: requestHash({ subject: 'Approved', revision: 1 }),
    });
    const db = new MemoryDb({ receipts: [original] });
    const originalBefore = JSON.stringify(original);
    const provider = liveRecoveryProvider();
    const reviewedContentHash = draftContentHash(mailboxDraftPreview('outlook', provider, 'owner@example.com'));
    let providerCalls = 0;
    const recovered = await recoveryCall(db, reviewedContentHash, {
        providerOps: {
            getOutlookDraft: async () => { providerCalls++; return provider; },
            updateOutlookDraft: async (_token, id) => {
                providerCalls++;
                return { ...provider, id, subject: 'Approved', changeKey: 'post-recovery-key' };
            },
        },
    });
    const linkedReceipt = db.tables.mailbox_draft_update_receipts[1];
    db.tables.mailbox_drafts[0].revision = 3;
    db.tables.mailbox_drafts[0].provider_change_key = 'later-human-edit-key';
    const stateBeforeReplay = JSON.stringify(db.tables);
    const initialProviderCalls = providerCalls;
    let rpcCalls = 0;
    const rpc = db.rpc.bind(db);
    db.rpc = (...args) => { rpcCalls++; return rpc(...args); };
    const noProviderAccess = {
        getOutlookDraft: async () => { throw new Error('Historical receipt replay must not read Outlook'); },
        updateOutlookDraft: async () => { throw new Error('Historical receipt replay must not write Outlook'); },
    };

    const replay = await updateMailboxDraft(db, options(db, original.idempotency_key, {
        subject: 'Approved', revision: 1,
    }, noProviderAccess));
    assert.deepEqual(replay, recovered);
    assert.equal(replay, linkedReceipt.result);
    assert.equal(providerCalls, initialProviderCalls);
    assert.equal(rpcCalls, 0);
    assert.equal(JSON.stringify(db.tables), stateBeforeReplay);
    assert.equal(JSON.stringify(original), originalBefore);

    for (const changedRequest of [
        { subject: 'Different', revision: 1 },
        { subject: 'Approved', revision: 2 },
        { subject: 'Approved' },
    ]) {
        await assert.rejects(updateMailboxDraft(db, options(db, original.idempotency_key, changedRequest, noProviderAccess)),
            error => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT');
    }
    assert.equal(JSON.stringify(db.tables), stateBeforeReplay);

    const requestWithoutRevision = { subject: 'Approved' };
    const sourceWithoutRevision = failedChangedReceipt({
        id: 'rejected-without-revision',
        idempotency_key: 'old-key-without-revision',
        request_hash: requestHash(requestWithoutRevision),
    });
    const noRevisionDb = new MemoryDb({ receipts: [sourceWithoutRevision] });
    await assert.rejects(updateMailboxDraft(noRevisionDb, options(noRevisionDb, sourceWithoutRevision.idempotency_key, {
        ...requestWithoutRevision,
        revision: 1,
    }, noProviderAccess)), error => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT');
});

test('incomplete or unrelated recovery receipts cannot resolve an Outlook failure key', async () => {
    const original = failedChangedReceipt({
        request_hash: requestHash({ subject: 'Approved', revision: 1 }),
    });
    const linked = completedRecoveryReceipt(original);
    const invalidReceipts = [
        { ...linked, result: { ...linked.result, update_receipt_id: undefined } },
        {
            ...linked,
            update_request: {
                subject: 'Different',
                recovery_binding: linked.update_request.recovery_binding,
            },
            request_hash: requestHash({
                subject: 'Different',
                revision: 1,
                recovery_binding: linked.update_request.recovery_binding,
            }),
        },
        {
            ...linked,
            update_request: {
                subject: 'Approved',
                recovery_binding: { ...linked.update_request.recovery_binding, failed_update_receipt_id: 'other-source' },
            },
        },
        {
            ...linked,
            update_request: {
                subject: 'Approved',
                recovery_binding: { ...linked.update_request.recovery_binding, expected_revision: 2 },
            },
            request_hash: requestHash({
                subject: 'Approved',
                revision: 2,
                recovery_binding: { ...linked.update_request.recovery_binding, expected_revision: 2 },
            }),
        },
        {
            ...linked,
            update_request: {
                subject: 'Approved',
                recovery_binding: { ...linked.update_request.recovery_binding, reviewed_content_hash: 'b'.repeat(64) },
            },
            request_hash: requestHash({
                subject: 'Approved',
                revision: 1,
                recovery_binding: { ...linked.update_request.recovery_binding, reviewed_content_hash: 'b'.repeat(64) },
            }),
        },
        { ...linked, request_hash: 'f'.repeat(64) },
        { ...linked, result: { ...linked.result, provider_draft_id: 'different-draft' } },
        { ...linked, result: { ...linked.result, provider_change_key: '' } },
        { ...linked, base_revision: 2 },
        { ...linked, idempotency_key: original.idempotency_key },
        { ...linked, tenant_id: 'foreign-tenant' },
        { ...linked, status: 'uncertain' },
    ];
    for (const invalid of invalidReceipts) {
        const db = new MemoryDb({
            draft: { revision: 2 },
            receipts: [structuredClone(original), invalid],
        });
        const before = JSON.stringify(db.tables);
        await assert.rejects(updateMailboxDraft(db, options(db, original.idempotency_key, {
            subject: 'Approved', revision: 1,
        }, {
            getOutlookDraft: async () => { throw new Error('Invalid historical receipt must not access Outlook'); },
            updateOutlookDraft: async () => { throw new Error('Invalid historical receipt must not access Outlook'); },
        })), error => error.status === 409 && error.code === 'DRAFT_PROVIDER_CHANGED');
        assert.equal(JSON.stringify(db.tables), before);
    }

    const duplicateDb = new MemoryDb({
        draft: { revision: 2 },
        receipts: [
            structuredClone(original),
            linked,
            { ...structuredClone(linked), id: 'second-verified-recovery', idempotency_key: 'another-recovery-key' },
        ],
    });
    const duplicateBefore = JSON.stringify(duplicateDb.tables);
    await assert.rejects(updateMailboxDraft(duplicateDb, options(duplicateDb, original.idempotency_key, {
        subject: 'Approved', revision: 1,
    })), error => error.status === 409 && error.code === 'DRAFT_PROVIDER_CHANGED');
    assert.equal(JSON.stringify(duplicateDb.tables), duplicateBefore);
});

test('recovery receipt hash binds the review, source receipt and new idempotency key', async () => {
    const secondSource = failedChangedReceipt({ id: 'another-rejected-update', idempotency_key: 'another-old-key' });
    const db = new MemoryDb({ receipts: [failedChangedReceipt(), secondSource] });
    const provider = liveRecoveryProvider();
    const hash = draftContentHash(mailboxDraftPreview('outlook', provider, 'owner@example.com'));
    let writes = 0;
    const providerOps = {
        getOutlookDraft: async () => provider,
        updateOutlookDraft: async (_token, id) => { writes++; return { ...provider, id, subject: 'Approved', changeKey: 'next' }; },
    };
    await recoveryCall(db, hash, { providerOps });
    await assert.rejects(recoveryCall(db, 'f'.repeat(64), { providerOps }),
        error => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(recoveryCall(db, hash, {
        failedUpdateReceiptId: secondSource.id, providerOps,
    }), error => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(recoveryCall(db, hash, {
        idempotencyKey: 'old-update-key', providerOps,
    }), error => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(updateMailboxDraft(db, options(db, 'new-recovery-key', {
        subject: 'Approved',
        revision: 1,
        reviewedRecovery: { failedUpdateReceiptId: 'rejected-update', reviewedContentHash: hash, expectedRevision: 1 },
        recovery_binding: { failed_update_receipt_id: 'rejected-update', reviewed_content_hash: hash },
    }, providerOps)), error => error.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(writes, 1);
});

test('invalid or changed review never writes or adopts the live provider version', async () => {
    const db = new MemoryDb({ receipts: [failedChangedReceipt()] });
    const approved = liveRecoveryProvider();
    const hash = draftContentHash(mailboxDraftPreview('outlook', approved, 'owner@example.com'));
    let writes = 0;
    let live = liveRecoveryProvider({ subject: 'Changed after review' });
    const providerOps = {
        getOutlookDraft: async () => live,
        updateOutlookDraft: async () => { writes++; throw new Error('Invalid review must not write'); },
    };
    await assert.rejects(recoveryCall(db, hash, { providerOps }), error => error.code === 'DRAFT_PROVIDER_CHANGED');
    assert.equal(writes, 0);
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'change-1');
    assert.equal(db.tables.mailbox_drafts[0].revision, 1);
    assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
    assert.equal(db.tables.mailbox_draft_update_receipts[0].error_code, 'DRAFT_PROVIDER_CHANGED');
    assert.equal(db.tables.mailbox_draft_update_receipts[1].status, 'failed');

    live = liveRecoveryProvider({ body: { contentType: 'text', content: 'x'.repeat(200001) } });
    const truncatedHash = draftContentHash(mailboxDraftPreview('outlook', live, 'owner@example.com'));
    await assert.rejects(recoverMailboxDraft(db, {
        tenantId: tenant, connectionId, draftId: 'draft-1', idempotencyKey: 'truncated',
        failedUpdateReceiptId: 'rejected-update', reviewedContentHash: truncatedHash, expectedRevision: 1,
    }, { credentialOverride: { access_token: 'test-only' }, providerOps }),
    error => error.code === 'DRAFT_PREVIEW_UNVERIFIABLE');
    assert.equal(writes, 0);

    const current = liveRecoveryProvider();
    const currentHash = draftContentHash(mailboxDraftPreview('outlook', current, 'owner@example.com'));
    for (const [name, invalidProvider, expectedCode] of [
        ['sent', { ...current, isDraft: false }, 'DRAFT_NOT_EDITABLE'],
        ['identifier-changed', { ...current, id: 'different-draft' }, 'DRAFT_NOT_FOUND'],
        ['missing-live-version', { ...current, changeKey: null }, 'DRAFT_VERSION_UNAVAILABLE'],
        ['incomplete-preview', { ...current, body: null }, 'DRAFT_PREVIEW_UNVERIFIABLE'],
    ]) {
        await assert.rejects(recoverMailboxDraft(db, {
            tenantId: tenant, connectionId, draftId: 'draft-1', idempotencyKey: `invalid-${name}`,
            failedUpdateReceiptId: 'rejected-update', reviewedContentHash: currentHash, expectedRevision: 1,
        }, {
            credentialOverride: { access_token: 'test-only' },
            providerOps: { getOutlookDraft: async () => invalidProvider, updateOutlookDraft: async () => { writes++; } },
        }), error => error.code === expectedCode);
    }
    assert.equal(writes, 0);

    const noSavedVersionDb = new MemoryDb({ draft: { provider_change_key: null }, receipts: [failedChangedReceipt()] });
    await assert.rejects(recoverMailboxDraft(noSavedVersionDb, {
        tenantId: tenant, connectionId, draftId: 'draft-1', idempotencyKey: 'no-saved-version',
        failedUpdateReceiptId: 'rejected-update', reviewedContentHash: currentHash, expectedRevision: 1,
    }, {
        credentialOverride: { access_token: 'test-only' },
        providerOps: { getOutlookDraft: async () => { throw new Error('No live read without a saved baseline'); }, updateOutlookDraft: async () => { writes++; } },
    }), error => error.code === 'DRAFT_VERSION_UNAVAILABLE');
    assert.equal(writes, 0);
});

test('recovery rejects out-of-scope, stale, unsupported, active and malformed source receipts before mutation', async () => {
    const provider = liveRecoveryProvider();
    const hash = draftContentHash(mailboxDraftPreview('outlook', provider, 'owner@example.com'));
    const rejectedOps = { getOutlookDraft: async () => provider, updateOutlookDraft: async () => { throw new Error('Must not write'); } };
    const db = new MemoryDb({ receipts: [failedChangedReceipt()] });
    const args = { tenantId: tenant, connectionId, draftId: 'draft-1', idempotencyKey: 'attempt', failedUpdateReceiptId: 'rejected-update', reviewedContentHash: hash, expectedRevision: 1 };
    const deps = { credentialOverride: { access_token: 'test-only' }, providerOps: rejectedOps };
    await assert.rejects(recoverMailboxDraft(db, { ...args, failedUpdateReceiptId: 'foreign-or-missing' }, deps),
        error => error.code === 'DRAFT_RECOVERY_RECEIPT_NOT_FOUND');
    await assert.rejects(recoverMailboxDraft(db, { ...args, expectedRevision: 2 }, deps),
        error => error.code === 'DRAFT_RECOVERY_NOT_ALLOWED');
    db.tables.mailbox_drafts[0].revision = 2;
    await assert.rejects(recoverMailboxDraft(db, args, deps), error => error.code === 'STALE_REVISION');
    db.tables.mailbox_drafts[0].revision = 1;
    db.tables.mailbox_drafts[0].active_update_id = 'other-update';
    await assert.rejects(recoverMailboxDraft(db, { ...args, idempotencyKey: 'active-attempt' }, deps),
        error => error.code === 'DRAFT_UPDATE_IN_PROGRESS');
    db.tables.mailbox_drafts[0].active_update_id = null;
    db.tables.provider_connections[0].provider = 'gmail';
    await assert.rejects(recoverMailboxDraft(db, { ...args, idempotencyKey: 'gmail-attempt' }, deps),
        error => error.code === 'DRAFT_RECOVERY_UNSUPPORTED');
    db.tables.provider_connections[0].provider = 'outlook';
    db.tables.mailbox_draft_update_receipts[0].update_request = { subject: 'Approved', headers: { injected: 'bad' } };
    await assert.rejects(recoverMailboxDraft(db, { ...args, idempotencyKey: 'malformed-attempt' }, deps),
        error => error.code === 'DRAFT_RECOVERY_INVALID_RECEIPT');

    const foreignReceiptDb = new MemoryDb({ receipts: [failedChangedReceipt({ tenant_id: 'foreign-tenant' })] });
    await assert.rejects(recoverMailboxDraft(foreignReceiptDb, args, deps),
        error => error.code === 'DRAFT_RECOVERY_RECEIPT_NOT_FOUND');
    const wrongFailureDb = new MemoryDb({ receipts: [failedChangedReceipt({ error_code: 'DRAFT_PROVIDER_FAILED' })] });
    await assert.rejects(recoverMailboxDraft(wrongFailureDb, args, deps),
        error => error.code === 'DRAFT_RECOVERY_NOT_ALLOWED');
});

test('recovery authorization audit failure is fail-closed before provider mutation', async () => {
    const db = new MemoryDb({ receipts: [failedChangedReceipt()] });
    const provider = liveRecoveryProvider();
    const hash = draftContentHash(mailboxDraftPreview('outlook', provider, 'owner@example.com'));
    let writes = 0;
    const from = db.from.bind(db);
    db.from = table => table === 'mailbox_audit_events'
        ? { insert: async () => ({ error: { message: 'audit unavailable' } }) }
        : from(table);
    await assert.rejects(recoveryCall(db, hash, {
        providerOps: {
            getOutlookDraft: async () => provider,
            updateOutlookDraft: async () => { writes++; return provider; },
        },
    }), /Could not write mailbox audit event/);
    assert.equal(writes, 0);
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'change-1');
    assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
});

test('uncertain recovery reconciliation preserves source linkage in the durable result', async () => {
    const original = failedChangedReceipt({
        request_hash: requestHash({ subject: 'Approved', revision: 1 }),
    });
    const db = new MemoryDb({ receipts: [original] });
    const initialProvider = liveRecoveryProvider();
    const hash = draftContentHash(mailboxDraftPreview('outlook', initialProvider, 'owner@example.com'));
    let provider = initialProvider;
    let writes = 0;
    let reads = 0;
    const providerOps = {
        getOutlookDraft: async () => { reads++; return provider; },
        updateOutlookDraft: async (_token, id) => {
            writes++;
            provider = { ...initialProvider, id, subject: 'Approved', changeKey: 'after-uncertain-write' };
            throw Object.assign(new Error('response lost after provider update'), { status: 503, providerAfterMutation: true });
        },
    };
    await assert.rejects(recoveryCall(db, hash, { providerOps }),
        error => error.code === 'DRAFT_RECONCILIATION_REQUIRED');
    const receipt = db.tables.mailbox_draft_update_receipts[1];
    assert.equal(receipt.status, 'uncertain');
    const uncertainState = JSON.stringify(db.tables);
    await assert.rejects(updateMailboxDraft(db, options(db, original.idempotency_key, {
        subject: 'Approved', revision: 1,
    }, providerOps)), error => error.code === 'DRAFT_PROVIDER_CHANGED');
    assert.equal(JSON.stringify(db.tables), uncertainState);
    receipt.lease_until = new Date(Date.now() - 1000).toISOString();
    db.tables.mailbox_drafts[0].active_update_lease_until = receipt.lease_until;
    const result = await recoveryCall(db, hash, { providerOps });
    assert.equal(writes, 1);
    assert.equal(result.update_receipt_id, receipt.id);
    assert.equal(result.recovered_from_receipt_id, 'rejected-update');
    assert.equal(result.reviewed_content_hash, hash);
    assert.equal(db.tables.mailbox_draft_update_receipts[0].status, 'failed');
    assert.equal(receipt.status, 'updated');
    const reconciledState = JSON.stringify(db.tables);
    const readsAfterReconciliation = reads;
    const replay = await updateMailboxDraft(db, options(db, original.idempotency_key, {
        subject: 'Approved', revision: 1,
    }, providerOps));
    assert.deepEqual(replay, result);
    assert.equal(reads, readsAfterReconciliation);
    assert.equal(JSON.stringify(db.tables), reconciledState);
});

test('real Outlook update helper rechecks the reviewed change key after claim and audits before any PATCH', async () => {
    const buildDb = () => {
        const db = new MemoryDb({ receipts: [failedChangedReceipt()] });
        const rpc = db.rpc.bind(db);
        const order = [];
        db.rpc = async (name, args) => {
            if (name === 'claim_mailbox_draft_update') order.push('claim');
            return rpc(name, args);
        };
        return { db, order };
    };
    const initial = liveRecoveryProvider({ changeKey: 'fresh-key' });
    const hash = draftContentHash(mailboxDraftPreview('outlook', initial, 'owner@example.com'));
    const rejected = buildDb();
    let reads = 0;
    let patches = 0;
    const rejectingTransport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') { patches++; throw new Error('A stale reviewed change key must block PATCH'); }
        reads++;
        if (reads === 2) {
            assert.ok(rejected.db.tables.mailbox_audit_events.some(event => event.action === 'mailbox.draft.recovery_authorized'));
            rejected.order.push('guard-read');
            return { ...initial, changeKey: 'later-key' };
        }
        rejected.order.push('review-read');
        return initial;
    };
    const rejectingOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: rejectingTransport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: rejectingTransport }),
    };
    await assert.rejects(recoveryCall(rejected.db, hash, { providerOps: rejectingOps }),
        error => error.code === 'DRAFT_PROVIDER_CHANGED');
    assert.deepEqual(rejected.order, ['claim', 'review-read', 'guard-read']);
    assert.equal(reads, 2);
    assert.equal(patches, 0);
    assert.equal(rejected.db.tables.mailbox_drafts[0].provider_change_key, 'change-1');
    assert.equal(rejected.db.tables.mailbox_drafts[0].revision, 1);
    assert.equal(rejected.db.tables.mailbox_draft_update_receipts[0].status, 'failed');

    const successful = buildDb();
    reads = 0;
    patches = 0;
    const updated = { ...initial, subject: 'Approved', changeKey: 'after-patch-key' };
    const successfulTransport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') {
            patches++;
            successful.order.push('patch');
            assert.ok(successful.db.tables.mailbox_audit_events.some(event => event.action === 'mailbox.draft.recovery_authorized'));
            assert.deepEqual(JSON.parse(options.body), { subject: 'Approved' });
            return {};
        }
        reads++;
        successful.order.push(reads === 1 ? 'review-read' : reads === 2 ? 'guard-read' : 'verify-read');
        return reads < 3 ? initial : updated;
    };
    const successfulOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: successfulTransport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: successfulTransport }),
    };
    const result = await recoveryCall(successful.db, hash, { providerOps: successfulOps });
    assert.equal(result.revision, 2);
    assert.equal(result.provider_draft_id, 'draft-1');
    assert.equal(successful.db.tables.mailbox_drafts[0].provider_change_key, 'after-patch-key');
    assert.equal(patches, 1);
    assert.deepEqual(successful.order, ['claim', 'review-read', 'guard-read', 'patch', 'verify-read']);
});

test('partial Outlook update response becomes uncertain and cannot finalize without a change key', async () => {
    const db = new MemoryDb({ receipts: [failedChangedReceipt()] });
    const originalProvider = liveRecoveryProvider({ changeKey: 'fresh-key' });
    const hash = draftContentHash(mailboxDraftPreview('outlook', originalProvider, 'owner@example.com'));
    const partial = { ...originalProvider, subject: 'Approved', changeKey: null };
    let reads = 0;
    let patches = 0;
    const transport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') {
            patches++;
            return {};
        }
        reads++;
        if (reads <= 2) return originalProvider;
        return partial;
    };
    const providerOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: transport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: transport }),
    };
    await assert.rejects(recoveryCall(db, hash, { providerOps }),
        error => error.code === 'DRAFT_RECONCILIATION_REQUIRED');
    const receipt = db.tables.mailbox_draft_update_receipts[1];
    assert.equal(receipt.status, 'uncertain');
    assert.equal(db.tables.mailbox_drafts[0].revision, 1);
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'change-1');
    receipt.lease_until = new Date(Date.now() - 1000).toISOString();
    db.tables.mailbox_drafts[0].active_update_lease_until = receipt.lease_until;
    await assert.rejects(recoveryCall(db, hash, { providerOps }),
        error => error.code === 'DRAFT_RECONCILIATION_REQUIRED');
    assert.equal(reads, 4);
    assert.equal(patches, 1);
    assert.equal(receipt.status, 'uncertain');
    assert.equal(db.tables.mailbox_drafts[0].revision, 1);
    assert.equal(db.tables.mailbox_drafts[0].provider_change_key, 'change-1');
});

test('lost Outlook response reconciles dual-body recovery using HTML precedence without changing source history', async () => {
    const original = failedChangedReceipt({
        update_request: { text: 'Plain fallback', html: '<p>HTML wins</p>' },
    });
    const db = new MemoryDb({ receipts: [original] });
    const originalBefore = structuredClone(original);
    const reviewed = liveRecoveryProvider({ changeKey: 'fresh-key' });
    const hash = draftContentHash(mailboxDraftPreview('outlook', reviewed, 'owner@example.com'));
    let reads = 0;
    let patches = 0;
    let providerState = reviewed;
    const transport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') {
            patches++;
            assert.ok(db.tables.mailbox_audit_events.some(event => event.action === 'mailbox.draft.recovery_authorized'));
            assert.deepEqual(JSON.parse(options.body), { body: { contentType: 'HTML', content: '<p>HTML wins</p>' } });
            providerState = {
                ...reviewed,
                changeKey: 'after-html-write',
                body: { contentType: 'HTML', content: '<p>HTML wins</p>' },
            };
            throw Object.assign(new Error('lost PATCH response'), { status: 503 });
        }
        reads++;
        if (reads <= 2) return reviewed;
        return providerState;
    };
    const providerOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: transport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: transport }),
    };
    await assert.rejects(recoveryCall(db, hash, { providerOps }),
        error => error.code === 'DRAFT_RECONCILIATION_REQUIRED');
    const receipt = db.tables.mailbox_draft_update_receipts[1];
    assert.equal(receipt.status, 'uncertain');
    assert.deepEqual(receipt.update_request.text, 'Plain fallback');
    assert.deepEqual(receipt.update_request.html, '<p>HTML wins</p>');
    receipt.lease_until = new Date(Date.now() - 1000).toISOString();
    db.tables.mailbox_drafts[0].active_update_lease_until = receipt.lease_until;
    const result = await recoveryCall(db, hash, { providerOps });
    assert.equal(result.revision, 2);
    assert.equal(result.provider_change_key, 'after-html-write');
    assert.equal(result.recovered_from_receipt_id, original.id);
    assert.equal(result.update_receipt_id, receipt.id);
    assert.equal(patches, 1);
    assert.deepEqual(original, originalBefore);
    assert.equal(receipt.status, 'updated');
    assert.deepEqual(receipt.update_request, {
        text: 'Plain fallback',
        html: '<p>HTML wins</p>',
        recovery_binding: {
            failed_update_receipt_id: original.id,
            reviewed_content_hash: hash,
            expected_revision: 1,
        },
    });
});

test('text-only Outlook recovery verifies and reconciles in Graph text-preferred representation', async () => {
    const sourceRequest = {
        to: ['person@example.com'],
        subject: 'Approved',
        text: 'Recovered plain text',
        revision: 1,
    };
    const original = failedChangedReceipt({
        request_hash: requestHash(sourceRequest),
        update_request: {
            to: ['person@example.com'],
            subject: 'Approved',
            text: 'Recovered plain text',
        },
    });
    const originalBefore = JSON.stringify(original);
    const db = new MemoryDb({ receipts: [original] });
    const initialText = liveRecoveryProvider({ changeKey: 'fresh-key' });
    const initialHtml = { ...initialText, body: { contentType: 'html', content: '<p>Initial HTML view</p>' } };
    const hash = draftContentHash(mailboxDraftPreview('outlook', initialText, 'owner@example.com'));
    const updatedText = { ...initialText, subject: 'Approved', changeKey: 'after-write', body: { contentType: 'text', content: 'Recovered plain text' } };
    const updatedHtml = { ...updatedText, body: { contentType: 'html', content: '<p>Recovered plain text</p>' } };
    let preferredReads = 0;
    let defaultReads = 0;
    let patches = 0;
    const transport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') {
            patches++;
            assert.ok(db.tables.mailbox_audit_events.some(event => event.action === 'mailbox.draft.recovery_authorized'));
            assert.deepEqual(JSON.parse(options.body), {
                subject: 'Approved',
                toRecipients: [{ emailAddress: { address: 'person@example.com' } }],
                body: { contentType: 'Text', content: 'Recovered plain text' },
            });
            return {};
        }
        if (options.headers?.Prefer) {
            preferredReads++;
            return preferredReads === 1 ? initialText : updatedText;
        }
        defaultReads++;
        return defaultReads === 1 ? initialHtml : updatedHtml;
    };
    const providerOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: transport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: transport }),
    };
    const result = await recoveryCall(db, hash, { providerOps });
    assert.equal(result.revision, 2);
    assert.equal(result.provider_change_key, 'after-write');
    assert.equal(preferredReads, 2);
    assert.equal(defaultReads, 2);
    assert.equal(patches, 1);

    const recoveryReceipt = db.tables.mailbox_draft_update_receipts[1];
    const createTimeBindingKeys = Object.keys(recoveryReceipt.update_request.recovery_binding);
    const pglite = new PGlite();
    try {
        await pglite.exec(`
            create table mailbox_receipt_jsonb_roundtrip (
                update_request jsonb not null,
                result jsonb not null
            )
        `);
        await pglite.query(
            'insert into mailbox_receipt_jsonb_roundtrip values ($1::jsonb, $2::jsonb)',
            [JSON.stringify(recoveryReceipt.update_request), JSON.stringify(recoveryReceipt.result)],
        );
        const persisted = (await pglite.query(
            'select update_request, result from mailbox_receipt_jsonb_roundtrip',
        )).rows[0];
        assert.notDeepEqual(Object.keys(persisted.update_request.recovery_binding), createTimeBindingKeys);
        recoveryReceipt.update_request = persisted.update_request;
        recoveryReceipt.result = persisted.result;
    } finally {
        await pglite.close();
    }

    db.tables.mailbox_drafts[0].revision = 3;
    db.tables.mailbox_drafts[0].provider_change_key = 'later-human-edit-key';
    const replaySnapshot = JSON.stringify(db.tables);
    const providerRequestCount = preferredReads + defaultReads + patches;
    let rpcCalls = 0;
    const rpc = db.rpc.bind(db);
    db.rpc = (...args) => { rpcCalls++; return rpc(...args); };
    const noProviderAccess = {
        getOutlookDraft: async () => { throw new Error('JSONB historical replay must not read Outlook'); },
        updateOutlookDraft: async () => { throw new Error('JSONB historical replay must not write Outlook'); },
    };
    const replay = await updateMailboxDraft(db, options(db, original.idempotency_key, sourceRequest, noProviderAccess));
    assert.deepEqual(replay, recoveryReceipt.result);
    assert.equal(preferredReads + defaultReads + patches, providerRequestCount);
    assert.equal(rpcCalls, 0);
    assert.equal(JSON.stringify(db.tables), replaySnapshot);
    assert.equal(JSON.stringify(original), originalBefore);

    const changedKeyDb = new MemoryDb({ receipts: [failedChangedReceipt({ update_request: { text: 'Recovered plain text' } })] });
    preferredReads = 0;
    defaultReads = 0;
    patches = 0;
    const changedKeyTransport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') { patches++; return {}; }
        if (options.headers?.Prefer) {
            preferredReads++;
            return preferredReads === 1 ? initialText : { ...updatedText, changeKey: 'raced-key' };
        }
        defaultReads++;
        return defaultReads === 1 ? initialHtml : updatedHtml;
    };
    const changedKeyOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: changedKeyTransport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: changedKeyTransport }),
    };
    await assert.rejects(recoveryCall(changedKeyDb, hash, { providerOps: changedKeyOps }),
        error => error.code === 'DRAFT_RECONCILIATION_REQUIRED');
    assert.equal(patches, 1);
    assert.equal(changedKeyDb.tables.mailbox_drafts[0].revision, 1);
    assert.equal(changedKeyDb.tables.mailbox_drafts[0].provider_change_key, 'change-1');
    assert.equal(changedKeyDb.tables.mailbox_draft_update_receipts[1].status, 'uncertain');
});

test('lost text-only Outlook response reconciles plain text when default Graph reads return HTML', async () => {
    const original = failedChangedReceipt({ update_request: { text: 'Recovered plain text' } });
    const db = new MemoryDb({ receipts: [original] });
    const originalBefore = structuredClone(original);
    const initialText = liveRecoveryProvider({ changeKey: 'fresh-key' });
    const initialHtml = { ...initialText, body: { contentType: 'html', content: '<p>Before</p>' } };
    const hash = draftContentHash(mailboxDraftPreview('outlook', initialText, 'owner@example.com'));
    const updatedText = { ...initialText, changeKey: 'after-write', body: { contentType: 'text', content: 'Recovered plain text' } };
    const updatedHtml = { ...updatedText, body: { contentType: 'html', content: '<p>Recovered plain text</p>' } };
    let preferredReads = 0;
    let defaultReads = 0;
    let patches = 0;
    const transport = async (_token, _path, options = {}) => {
        if (options.method === 'PATCH') {
            patches++;
            assert.ok(db.tables.mailbox_audit_events.some(event => event.action === 'mailbox.draft.recovery_authorized'));
            assert.deepEqual(JSON.parse(options.body), { body: { contentType: 'Text', content: 'Recovered plain text' } });
            throw Object.assign(new Error('lost PATCH response'), { status: 503 });
        }
        if (options.headers?.Prefer) {
            preferredReads++;
            return preferredReads === 1 ? initialText : updatedText;
        }
        defaultReads++;
        return defaultReads === 1 ? initialHtml : updatedHtml;
    };
    const providerOps = {
        getOutlookDraft: (token, id, options) => getOutlookDraft(token, id, { ...options, request: transport }),
        updateOutlookDraft: (token, id, request, options) => updateOutlookDraft(token, id, request, { ...options, request: transport }),
    };
    await assert.rejects(recoveryCall(db, hash, { providerOps }),
        error => error.code === 'DRAFT_RECONCILIATION_REQUIRED');
    const receipt = db.tables.mailbox_draft_update_receipts[1];
    assert.equal(receipt.status, 'uncertain');
    receipt.lease_until = new Date(Date.now() - 1000).toISOString();
    db.tables.mailbox_drafts[0].active_update_lease_until = receipt.lease_until;
    const result = await recoveryCall(db, hash, { providerOps });
    assert.equal(result.revision, 2);
    assert.equal(result.provider_change_key, 'after-write');
    assert.equal(result.recovered_from_receipt_id, original.id);
    assert.equal(preferredReads, 2);
    assert.equal(defaultReads, 1);
    assert.equal(patches, 1);
    assert.deepEqual(original, originalBefore);
    assert.equal(receipt.status, 'updated');
});

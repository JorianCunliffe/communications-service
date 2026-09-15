import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { updateOutlookDraft } from '../outlookMailbox.js';
import { updateMailboxDraft } from '../mailboxDraftUpdate.js';

function mailboxDb({ provider = 'outlook' } = {}) {
    const record = {
        id: 'draft-row-1', tenant_id: 'tenant-a', provider_connection_id: 'connection-a',
        communication_id: 'comm-1', provider_draft_id: 'draft-1', provider_message_id: 'draft-1',
        provider_thread_id: 'thread-1', status: 'created',
    };
    const connection = {
        id: 'connection-a', tenant_id: 'tenant-a', provider, provider_account_id: 'owner@example.com',
        enabled: true, channels: ['email'],
    };
    const updates = [];

    function query(table) {
        const filters = {};
        let pendingUpdate = null;
        const chain = {
            select() { return chain; },
            eq(field, value) { filters[field] = value; return chain; },
            update(values) { pendingUpdate = values; return chain; },
            async maybeSingle() {
                if (table === 'mailbox_drafts') {
                    const matches = filters.tenant_id === record.tenant_id
                        && filters.provider_connection_id === record.provider_connection_id
                        && filters.provider_draft_id === record.provider_draft_id;
                    return { data: matches ? { ...record } : null, error: null };
                }
                if (table === 'provider_connections') {
                    const matches = filters.tenant_id === connection.tenant_id
                        && filters.id === connection.id && filters.enabled === true;
                    return { data: matches ? { ...connection } : null, error: null };
                }
                return { data: null, error: null };
            },
            async single() {
                if (table !== 'mailbox_drafts' || !pendingUpdate) return { data: null, error: new Error('unexpected single') };
                updates.push(pendingUpdate);
                Object.assign(record, pendingUpdate);
                return { data: { ...record }, error: null };
            },
            then(resolve, reject) {
                if (table === 'mailbox_drafts' && pendingUpdate) {
                    updates.push(pendingUpdate);
                    Object.assign(record, pendingUpdate);
                }
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            },
        };
        return chain;
    }
    return { from: query, record, connection, updates };
}

describe('Outlook draft update adapter', () => {
    test('updates the existing draft id and never calls send', async () => {
        const calls = [];
        const result = await updateOutlookDraft('token', 'draft-1', {
            to: ['Alex <alex@example.com>'], subject: 'Inspection confirmed', text: 'Confirmed for 2:30pm',
        }, {
            request: async (_token, path, options = {}) => {
                calls.push({ path, options });
                if (calls.length === 1) return { id: 'draft-1', conversationId: 'thread-1', isDraft: true };
                return { id: 'draft-1', conversationId: 'thread-1', isDraft: true };
            },
        });
        assert.equal(result.id, 'draft-1');
        assert.equal(calls.length, 2);
        assert.match(calls[0].path, /draft-1/);
        assert.equal(calls[1].options.method, 'PATCH');
        assert.match(calls[1].path, /draft-1$/);
        assert.equal(calls.some(({ path }) => /send/i.test(path)), false);
        const payload = JSON.parse(calls[1].options.body);
        assert.equal(payload.subject, 'Inspection confirmed');
        assert.equal(payload.body.content, 'Confirmed for 2:30pm');
    });

    test('fails closed when the provider item is no longer a draft', async () => {
        await assert.rejects(() => updateOutlookDraft('token', 'draft-1', {
            to: ['alex@example.com'], subject: 'No change', text: 'No change',
        }, {
            request: async () => ({ id: 'draft-1', isDraft: false }),
        }), (error) => error.status === 409 && error.code === 'DRAFT_NOT_EDITABLE');
    });
});

describe('provider-neutral mailbox draft update service', () => {
    test('keeps provider draft identity, stores the update, and marks idempotency complete', async () => {
        const db = mailboxDb();
        const marked = [];
        const audited = [];
        const result = await updateMailboxDraft(db, {
            tenantId: 'tenant-a', connectionId: 'connection-a', draftId: 'draft-1', actorId: 'hyperflow',
            idempotencyKey: 'draft:update:1',
            request: { to: ['alex@example.com'], subject: 'Confirmed', text: '2:30pm' },
        }, {
            reserveOperation: async (_db, input) => {
                assert.equal(input.type, 'mailbox_draft_update');
                assert.equal(input.key, 'draft:update:1');
                return { id: 'operation-1', status: 'reserved' };
            },
            markOperation: async (_db, id, values) => { marked.push({ id, values }); },
            credentialProvider: async () => ({ access_token: 'test-token' }),
            providers: {
                outlook: async (_credential, id) => ({ id, message: { id, conversationId: 'thread-1', isDraft: true } }),
            },
            audit: async (...args) => { audited.push(args); },
        });
        assert.equal(result.provider_draft_id, 'draft-1');
        assert.equal(result.provider_message_id, 'draft-1');
        assert.equal(marked[0].values.status, 'completed');
        assert.equal(marked[0].values.provider_id, 'draft-1');
        assert.equal(db.record.provider_draft_id, 'draft-1');
        assert.equal(audited.length, 1);
        assert.equal(audited[0][4], 'mailbox.draft.updated');
        assert.equal(audited[0][5], 'succeeded');
    });

    test('returns a completed idempotent result without calling the provider again', async () => {
        const db = mailboxDb();
        const cached = { provider_draft_id: 'draft-1', status: 'created' };
        let providerCalls = 0;
        const result = await updateMailboxDraft(db, {
            tenantId: 'tenant-a', connectionId: 'connection-a', draftId: 'draft-1',
            idempotencyKey: 'draft:update:1',
            request: { to: ['alex@example.com'], subject: 'Confirmed', text: '2:30pm' },
        }, {
            reserveOperation: async () => ({ id: 'operation-1', status: 'completed', response: cached }),
            providers: { outlook: async () => { providerCalls += 1; } },
            audit: async () => {},
        });
        assert.deepEqual(result, cached);
        assert.equal(providerCalls, 0);
    });

    test('rejects a provider response that changes the draft identity', async () => {
        const db = mailboxDb();
        await assert.rejects(() => updateMailboxDraft(db, {
            tenantId: 'tenant-a', connectionId: 'connection-a', draftId: 'draft-1',
            idempotencyKey: 'draft:update:identity',
            request: { to: ['alex@example.com'], subject: 'Confirmed', text: '2:30pm' },
        }, {
            reserveOperation: async () => ({ id: 'operation-1', status: 'reserved' }),
            markOperation: async () => {},
            credentialProvider: async () => ({ access_token: 'test-token' }),
            providers: { outlook: async () => ({ id: 'different-draft', message: {} }) },
            audit: async () => {},
        }), (error) => error.status === 409 && error.code === 'DRAFT_IDENTITY_CHANGED');
    });
});

describe('mailbox draft update migration', () => {
    test('adds mailbox_draft_update to durable outbound operation types', () => {
        const sql = readFileSync(new URL('../migrations/026_mailbox_draft_updates.sql', import.meta.url), 'utf8');
        assert.match(sql, /mailbox_draft_update/);
        assert.match(sql, /outbound_operations_operation_type_check/);
    });
});
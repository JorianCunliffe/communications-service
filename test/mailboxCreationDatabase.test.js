import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhase02Database } from './fixtures/phase02Database.js';
import { createPostgresClient } from '../database.js';
import { createMailboxDraft, updateMailboxDraft } from '../mailboxService.js';
import { updateOutlookDraft } from '../outlookMailbox.js';

test('draft reservation and concurrent safe retry work against the migrated schema', async () => {
    const tenantId = 'draft-create-test';
    const fixture = await createPhase02Database(tenantId, 'local-draft-create');
    try {
        const connection = await fixture.sql.query("insert into provider_connections (tenant_id,provider,channels,provider_account_id,credential_reference,enabled) values ($1,'outlook',ARRAY['email'],'owner@example.test','fixture',true) returning id", [tenantId]);
        const db = createPostgresClient(fixture.sql);
        const args = { tenantId, connectionId: connection.rows[0].id, idempotencyKey: 'draft-create-1', request: { to: ['test@example.test'], text: 'Draft only' } };
        await assert.rejects(createMailboxDraft(db, args), /Mailbox credential is unavailable/);
        let calls = 0;
        const retry = { ...args, credentialOverride: { access_token: 'fixture' }, providerOps: { createOutlookDraft: async () => { calls++; return { id: 'fixture-draft' }; } } };
        const results = await Promise.allSettled([createMailboxDraft(db, retry), createMailboxDraft(db, retry)]);
        assert.ok(results.some(result => result.status === 'fulfilled'));
        assert.equal(calls, 1, 'only one conditional claim may create at the provider');
        const stored = await fixture.sql.query('select status,provider_draft_id from mailbox_drafts where tenant_id=$1', [tenantId]);
        assert.deepEqual(stored.rows, [{ status: 'created', provider_draft_id: 'fixture-draft' }]);
    } finally { await fixture.close(); }
});

test('Outlook provider baseline persists atomically and rejects changed or legacy drafts', async () => {
    const tenantId = 'outlook-version-test';
    const fixture = await createPhase02Database(tenantId, 'local-outlook-version', { serverRoles: true });
    try {
        const connection = await fixture.sql.query("insert into provider_connections (tenant_id,provider,channels,provider_account_id,credential_reference,enabled) values ($1,'outlook',ARRAY['email'],'owner@example.test','fixture',true) returning id", [tenantId]);
        const db = createPostgresClient(fixture.sql);
        const connectionId = connection.rows[0].id;
        let version = 1; let writes = 0;
        const current = () => ({ id: 'outlook-draft', isDraft: true, changeKey: `key-${version}`, subject: 'Test',
            toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }], body: { contentType: 'Text', content: 'Draft' } });
        const providerOps = {
            createOutlookDraft: async () => ({ id: 'outlook-draft', message: current() }),
            updateOutlookDraft: (token, id, body, options) => updateOutlookDraft(token, id, body, { ...options,
                request: async (_token, _path, request) => {
                    if (request?.method === 'PATCH') { writes++; version++; }
                    return current();
                } })
        };
        const shared = { tenantId, connectionId, credentialOverride: { access_token: 'fixture' }, providerOps };
        const created = await createMailboxDraft(db, { ...shared, idempotencyKey: 'create', request: { to: ['recipient@example.test'], text: 'Draft' } });
        assert.equal(created.provider_change_key, 'key-1');
        for (let revision = 1; revision <= 2; revision++) {
            const updated = await updateMailboxDraft(db, { ...shared, draftId: 'outlook-draft', idempotencyKey: `update-${revision}`, request: { text: 'Updated', revision } });
            assert.equal(updated.provider_change_key, `key-${revision + 1}`);
            const persisted = await fixture.sql.query('select provider_change_key,revision,active_update_id from mailbox_drafts where id=$1', [created.id]);
            assert.deepEqual(persisted.rows[0], { provider_change_key: `key-${revision + 1}`, revision: revision + 1, active_update_id: null });
        }
        version++; // A human edits the draft outside Communications.
        const conflict = { ...shared, draftId: 'outlook-draft', idempotencyKey: 'conflict', request: { text: 'Must not overwrite' } };
        for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(updateMailboxDraft(db, conflict), error => error.code === 'DRAFT_PROVIDER_CHANGED' && error.status === 409);
        assert.equal(writes, 2);
        const preserved = await fixture.sql.query('select provider_change_key,revision,active_update_id from mailbox_drafts where id=$1', [created.id]);
        assert.deepEqual(preserved.rows[0], { provider_change_key: 'key-3', revision: 3, active_update_id: null });
        await fixture.sql.query('update mailbox_drafts set provider_change_key=null where id=$1', [created.id]);
        await assert.rejects(updateMailboxDraft(db, { ...conflict, idempotencyKey: 'legacy' }), error => error.code === 'DRAFT_VERSION_UNAVAILABLE');
        assert.equal(writes, 2);
        for (const role of ['anon', 'authenticated']) {
            const privilege = await fixture.sql.query("select has_function_privilege($1, 'finalize_mailbox_draft_update(text,uuid,uuid,uuid,text,text,text,integer,jsonb)', 'EXECUTE') as allowed", [role]);
            assert.equal(privilege.rows[0].allowed, false);
        }
    } finally { await fixture.close(); }
});

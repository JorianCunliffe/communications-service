import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhase02Database } from './fixtures/phase02Database.js';
import { createPostgresClient } from '../database.js';
import { createMailboxDraft } from '../mailboxService.js';

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

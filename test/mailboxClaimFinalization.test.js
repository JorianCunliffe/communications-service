import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhase02Database } from './fixtures/phase02Database.js';
import { createPostgresClient } from '../database.js';

const tenantId = 'mailbox-claim-finalization-test';
let fixture;
let database;
let connectionId;
let nextId = 0;

before(async () => {
    fixture = await createPhase02Database(tenantId, 'local-mailbox-claim-finalization');
    const connection = await fixture.sql.query(
        "insert into provider_connections(tenant_id,provider,provider_account_id,credential_reference,channels) values($1,'outlook','claim-test@example.test','fixture',array['email']) returning id",
        [tenantId],
    );
    connectionId = connection.rows[0].id;
    database = createPostgresClient(fixture.sql);
});

after(async () => {
    await fixture?.close();
});

async function createDraft({ revision = 3, active = true, receiptStatus = 'uncertain' } = {}) {
    nextId += 1;
    const suffix = String(nextId);
    const draft = (await fixture.sql.query(
        `insert into mailbox_drafts(
            tenant_id,provider_connection_id,provider_draft_id,provider_message_id,provider_thread_id,
            idempotency_key,request_hash,status,revision
        ) values($1,$2,$3,'message-before','thread-before',$4,'request-hash','created',$5) returning id`,
        [tenantId, connectionId, `provider-draft-${suffix}`, `draft-${suffix}`, revision],
    )).rows[0];
    const receipt = (await fixture.sql.query(
        `insert into mailbox_draft_update_receipts(
            tenant_id,provider_connection_id,mailbox_draft_id,idempotency_key,request_hash,
            update_request,status,base_revision
        ) values($1,$2,$3,$4,'update-hash','{"subject":"After"}',$5,$6) returning id`,
        [tenantId, connectionId, draft.id, `update-${suffix}`, receiptStatus, revision],
    )).rows[0];
    if (active) {
        await fixture.sql.query('update mailbox_drafts set active_update_id=$1 where id=$2', [receipt.id, draft.id]);
    }
    return { draftId: draft.id, receiptId: receipt.id, providerDraftId: `provider-draft-${suffix}`, revision };
}

function finalizeArgs(scenario, overrides = {}) {
    return {
        p_tenant_id: tenantId,
        p_provider_connection_id: connectionId,
        p_mailbox_draft_id: scenario.draftId,
        p_receipt_id: scenario.receiptId,
        p_provider_draft_id: scenario.providerDraftId,
        p_provider_message_id: 'message-after',
        p_provider_thread_id: 'thread-after',
        p_expected_revision: scenario.revision,
        p_result: { provider_change_key: 'change-after', provider_draft_id: scenario.providerDraftId },
        ...overrides,
    };
}

async function state(scenario) {
    const draft = (await fixture.sql.query(
        'select active_update_id,provider_message_id,provider_thread_id,provider_change_key,revision from mailbox_drafts where id=$1',
        [scenario.draftId],
    )).rows[0];
    const receipt = (await fixture.sql.query(
        'select status,result,lease_until from mailbox_draft_update_receipts where id=$1',
        [scenario.receiptId],
    )).rows[0];
    return { draft, receipt };
}

test('migration 041 accepts a cleared uncertain claim, but the transaction guard refuses it unchanged', async () => {
    const ordinary = await createDraft({ active: false });
    const finalization = await database.rpc('finalize_mailbox_draft_update', finalizeArgs(ordinary));
    assert.equal(finalization.error, null);
    assert.equal(finalization.data.revision, 4, 'the migration 041 finalizer has a null-active-claim uncertain-receipt exception');

    const guarded = await createDraft({ active: false });
    const before = await state(guarded);
    const locked = await database.transaction(async tx => tx.lockMailboxDraftUpdateClaim(finalizeArgs(guarded)));
    assert.equal(locked, false);
    assert.deepEqual(await state(guarded), before, 'a failed guard must not run finalization or change draft/receipt state');
    assert.equal(database.lockMailboxDraftUpdateClaim, undefined, 'the lock helper is exposed only on transaction-bound clients');
});

test('wrong claim, revision, tenant, and draft id do not acquire the transaction lock', async () => {
    const scenario = await createDraft();
    const otherClaim = (await fixture.sql.query(
        `insert into mailbox_draft_update_receipts(
            tenant_id,provider_connection_id,mailbox_draft_id,idempotency_key,request_hash,
            update_request,status,base_revision
        ) values($1,$2,$3,'wrong-claim','wrong-hash','{}','uncertain',$4) returning id`,
        [tenantId, connectionId, scenario.draftId, scenario.revision],
    )).rows[0].id;
    const base = finalizeArgs(scenario);
    const mismatches = [
        { p_receipt_id: otherClaim },
        { p_expected_revision: scenario.revision + 1 },
        { p_tenant_id: `${tenantId}-wrong` },
        { p_mailbox_draft_id: '00000000-0000-4000-8000-000000000001' },
    ];
    for (const mismatch of mismatches) {
        assert.equal(
            await database.transaction(tx => tx.lockMailboxDraftUpdateClaim({ ...base, ...mismatch })),
            false,
            `mismatched lock args should be rejected: ${JSON.stringify(mismatch)}`,
        );
    }
    assert.equal((await state(scenario)).draft.active_update_id, scenario.receiptId);
});

test('matching claimed uncertain receipt finalizes once and commits draft version and revision atomically', async () => {
    const scenario = await createDraft({ revision: 3, active: true, receiptStatus: 'uncertain' });
    const args = finalizeArgs(scenario);
    const result = await database.transaction(async tx => {
        assert.equal(await tx.lockMailboxDraftUpdateClaim(args), true);
        const finalized = await tx.rpc('finalize_mailbox_draft_update', args);
        assert.equal(finalized.error, null);
        return finalized.data;
    });
    assert.equal(result.revision, 4);
    const committed = await state(scenario);
    assert.deepEqual(committed.draft, {
        active_update_id: null,
        provider_message_id: 'message-after',
        provider_thread_id: 'thread-after',
        provider_change_key: 'change-after',
        revision: 4,
    });
    assert.equal(committed.receipt.status, 'updated');
    assert.equal(committed.receipt.result.revision, 4);
    assert.equal(await database.transaction(tx => tx.lockMailboxDraftUpdateClaim(args)), false);
    const duplicate = await database.rpc('finalize_mailbox_draft_update', args);
    assert.match(duplicate.error.message, /Mailbox draft revision or update claim changed/);
    assert.equal((await state(scenario)).draft.revision, 4);
});

test('throwing after successful guarded RPC rolls back both draft and receipt mutations', async () => {
    const scenario = await createDraft({ revision: 3, active: true, receiptStatus: 'uncertain' });
    const before = await state(scenario);
    await assert.rejects(database.transaction(async tx => {
        assert.equal(await tx.lockMailboxDraftUpdateClaim(finalizeArgs(scenario)), true);
        const finalized = await tx.rpc('finalize_mailbox_draft_update', finalizeArgs(scenario));
        assert.equal(finalized.error, null);
        throw new Error('force transaction rollback');
    }), /force transaction rollback/);
    assert.deepEqual(await state(scenario), before);
});

test('a claim cleared before locking is rejected even when its receipt is uncertain', async () => {
    const scenario = await createDraft({ revision: 3, active: true, receiptStatus: 'uncertain' });
    await fixture.sql.query('update mailbox_drafts set active_update_id=null where id=$1', [scenario.draftId]);
    const before = await state(scenario);
    assert.equal(await database.transaction(tx => tx.lockMailboxDraftUpdateClaim(finalizeArgs(scenario))), false);
    assert.deepEqual(await state(scenario), before);
});
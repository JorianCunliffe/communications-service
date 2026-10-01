import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPhase02Database } from './fixtures/phase02Database.js';
import { createPostgresClient } from '../database.js';
import { updateMailboxDraft } from '../mailboxService.js';

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

const recoveryHashFields = ['to', 'cc', 'bcc', 'reply_to', 'subject', 'text', 'html', 'revision'];

function updateRequestHash(request, recoveryBinding = null) {
    const hashRequest = Object.fromEntries(recoveryHashFields
        .filter(key => request[key] !== undefined)
        .map(key => [key, request[key]]));
    return createHash('sha256')
        .update(JSON.stringify(recoveryBinding ? { ...hashRequest, recovery_binding: recoveryBinding } : hashRequest))
        .digest('hex');
}

function leaseSql(value) {
    if (value === 'expired') return "now() - interval '1 hour'";
    if (value === 'future') return "now() + interval '1 hour'";
    if (value === 'missing') return 'null';
    throw new Error(`Unsupported test lease state: ${value}`);
}

async function createLinkedRecovery({ receiptLease = 'expired', draftLease = 'expired' } = {}) {
    nextId += 1;
    const suffix = String(nextId);
    const providerDraftId = `recovery-provider-draft-${suffix}`;
    const originalKey = `original-failed-update-${suffix}`;
    const recoveryKey = `linked-recovery-update-${suffix}`;
    const request = {
        to: ['person@example.test'],
        subject: 'Approved subject',
        text: 'Approved body for an existing uncertain recovery.',
        revision: 3,
    };
    const editableRequest = {
        to: request.to,
        subject: request.subject,
        text: request.text,
    };
    const draft = (await fixture.sql.query(
        `insert into mailbox_drafts(
            tenant_id,provider_connection_id,provider_draft_id,provider_message_id,provider_thread_id,
            idempotency_key,request_hash,status,revision,provider_change_key
        ) values($1,$2,$3,'message-before','thread-before',$4,'draft-create-hash','created',3,'old-change-key')
        returning id`,
        [tenantId, connectionId, providerDraftId, `draft-create-${suffix}`],
    )).rows[0];
    const original = (await fixture.sql.query(
        `insert into mailbox_draft_update_receipts(
            tenant_id,provider_connection_id,mailbox_draft_id,idempotency_key,request_hash,
            update_request,status,base_revision,error_status,error_code,last_error
        ) values($1,$2,$3,$4,$5,$6::jsonb,'failed',3,409,'DRAFT_PROVIDER_CHANGED','Outlook draft changed outside this service')
        returning id`,
        [
            tenantId, connectionId, draft.id, originalKey, updateRequestHash(request),
            JSON.stringify(editableRequest),
        ],
    )).rows[0];
    const recoveryBinding = {
        failed_update_receipt_id: original.id,
        reviewed_content_hash: createHash('sha256').update(`reviewed-${suffix}`).digest('hex'),
        expected_revision: 3,
    };
    const linkedRequest = { ...editableRequest, recovery_binding: recoveryBinding };
    const linked = (await fixture.sql.query(
        `insert into mailbox_draft_update_receipts(
            tenant_id,provider_connection_id,mailbox_draft_id,idempotency_key,request_hash,
            update_request,status,base_revision,lease_until
        ) values($1,$2,$3,$4,$5,$6::jsonb,'uncertain',3,${leaseSql(receiptLease)})
        returning id`,
        [
            tenantId, connectionId, draft.id, recoveryKey,
            updateRequestHash(request, recoveryBinding), JSON.stringify(linkedRequest),
        ],
    )).rows[0];
    await fixture.sql.query(
        `update mailbox_drafts
            set active_update_id=$1,active_update_lease_until=${leaseSql(draftLease)}
          where id=$2`,
        [linked.id, draft.id],
    );
    return {
        draftId: draft.id,
        providerDraftId,
        originalReceiptId: original.id,
        linkedReceiptId: linked.id,
        originalKey,
        recoveryKey,
        request,
        recoveryBinding,
    };
}

async function mailboxRows(scenario) {
    const drafts = await fixture.sql.query(
        'select * from mailbox_drafts where id=$1',
        [scenario.draftId],
    );
    const receipts = await fixture.sql.query(
        'select * from mailbox_draft_update_receipts where mailbox_draft_id=$1 order by id',
        [scenario.draftId],
    );
    return { draft: drafts.rows[0], receipts: receipts.rows };
}

async function assertAdapterLeaseTypes(scenario, expectedReceiptType, expectedDraftType) {
    const receipt = await database.from('mailbox_draft_update_receipts').select('lease_until')
        .eq('id', scenario.linkedReceiptId).single();
    const draft = await database.from('mailbox_drafts').select('active_update_lease_until')
        .eq('id', scenario.draftId).single();
    assert.equal(receipt.error, null);
    assert.equal(draft.error, null);
    assert.equal(receipt.data.lease_until === null ? 'null' : receipt.data.lease_until instanceof Date ? 'date' : typeof receipt.data.lease_until,
        expectedReceiptType);
    assert.equal(draft.data.active_update_lease_until === null ? 'null' : draft.data.active_update_lease_until instanceof Date ? 'date' : typeof draft.data.active_update_lease_until,
        expectedDraftType);
    if (expectedReceiptType === 'date') assert.ok(Number.isFinite(receipt.data.lease_until.getTime()));
    if (expectedDraftType === 'date') assert.ok(Number.isFinite(draft.data.active_update_lease_until.getTime()));
    return { receipt: receipt.data.lease_until, draft: draft.data.active_update_lease_until };
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

test('expired native PostgreSQL recovery leases reconcile the exact linked claim once, without provider writes', async () => {
    const scenario = await createLinkedRecovery();
    const leases = await assertAdapterLeaseTypes(scenario, 'date', 'date');
    assert.ok(leases.receipt.getTime() < Date.now());
    assert.ok(leases.draft.getTime() < Date.now());

    const before = await mailboxRows(scenario);
    const originalBefore = before.receipts.find(receipt => receipt.id === scenario.originalReceiptId);
    const linkedBefore = before.receipts.find(receipt => receipt.id === scenario.linkedReceiptId);
    assert.equal(before.receipts.length, 2);
    assert.equal(before.draft.active_update_id, scenario.linkedReceiptId);
    assert.equal(linkedBefore.status, 'uncertain');
    assert.equal(linkedBefore.result, null);

    const serviceDatabase = createPostgresClient(fixture.sql);
    const observed = { locks: [], finalizations: [] };
    const transaction = serviceDatabase.transaction.bind(serviceDatabase);
    serviceDatabase.transaction = work => transaction(tx => work({
        ...tx,
        async lockMailboxDraftUpdateClaim(args) {
            observed.locks.push(args);
            return tx.lockMailboxDraftUpdateClaim(args);
        },
        async rpc(name, args) {
            if (name === 'finalize_mailbox_draft_update') observed.finalizations.push(args);
            return tx.rpc(name, args);
        },
    }));

    const calls = { reads: 0, writes: 0, creates: 0, sends: 0 };
    const provider = {
        id: scenario.providerDraftId,
        isDraft: true,
        changeKey: 'fresh-graph-change-key',
        conversationId: 'fresh-graph-thread',
        subject: scenario.request.subject,
        toRecipients: [{
            emailAddress: { address: scenario.request.to[0], name: 'Jorian Cunliffe' },
        }],
        ccRecipients: [],
        bccRecipients: [],
        replyTo: [],
        body: { contentType: 'Text', content: scenario.request.text },
    };
    const providerOps = {
        async getOutlookDraft(token, draftId, options) {
            calls.reads += 1;
            assert.equal(token, 'credential-override-token');
            assert.equal(draftId, scenario.providerDraftId);
            assert.deepEqual(options, { textBody: true });
            return provider;
        },
        async updateOutlookDraft() { calls.writes += 1; assert.fail('Reconciliation must not PATCH Graph'); },
        async createOutlookDraft() { calls.creates += 1; assert.fail('Reconciliation must not create a Graph draft'); },
        async sendOutlookMessage() { calls.sends += 1; assert.fail('Reconciliation must not send a Graph message'); },
        async sendOutlookDraft() { calls.sends += 1; assert.fail('Reconciliation must not send a Graph draft'); },
    };
    const update = () => updateMailboxDraft(serviceDatabase, {
        tenantId,
        connectionId,
        draftId: scenario.providerDraftId,
        idempotencyKey: scenario.originalKey,
        request: scenario.request,
        credentialOverride: { access_token: 'credential-override-token' },
        providerOps,
    });

    const result = await update();
    assert.equal(calls.reads, 1);
    assert.deepEqual({ writes: calls.writes, creates: calls.creates, sends: calls.sends }, { writes: 0, creates: 0, sends: 0 });
    assert.equal(observed.locks.length, 1, 'must acquire the transaction-bound strict active-claim lock');
    assert.equal(observed.locks[0].p_tenant_id, tenantId);
    assert.equal(observed.locks[0].p_provider_connection_id, connectionId);
    assert.equal(observed.locks[0].p_mailbox_draft_id, scenario.draftId);
    assert.equal(observed.locks[0].p_provider_draft_id, scenario.providerDraftId);
    assert.equal(observed.locks[0].p_receipt_id, scenario.linkedReceiptId);
    assert.equal(observed.locks[0].p_expected_revision, 3);
    assert.equal(observed.finalizations.length, 1, 'must finalize through the real PostgreSQL adapter RPC');
    assert.equal(observed.finalizations[0].p_receipt_id, scenario.linkedReceiptId);
    assert.equal(observed.finalizations[0].p_expected_revision, 3);
    assert.equal(result.revision, 4);
    assert.equal(result.provider_draft_id, scenario.providerDraftId);
    assert.equal(result.provider_message_id, scenario.providerDraftId);
    assert.equal(result.provider_change_key, provider.changeKey);
    assert.equal(result.update_receipt_id, scenario.linkedReceiptId);
    assert.equal(result.recovered_from_receipt_id, scenario.originalReceiptId);
    assert.equal(result.reviewed_content_hash, scenario.recoveryBinding.reviewed_content_hash);

    const after = await mailboxRows(scenario);
    assert.equal(after.receipts.length, 2, 'reconciliation must not reserve a third receipt');
    assert.deepEqual(after.receipts.find(receipt => receipt.id === scenario.originalReceiptId), originalBefore,
        'the original DRAFT_PROVIDER_CHANGED receipt remains unchanged');
    const linkedAfter = after.receipts.find(receipt => receipt.id === scenario.linkedReceiptId);
    assert.equal(linkedAfter.status, 'updated');
    assert.equal(linkedAfter.result.update_receipt_id, scenario.linkedReceiptId);
    assert.equal(linkedAfter.result.recovered_from_receipt_id, scenario.originalReceiptId);
    assert.equal(linkedAfter.result.reviewed_content_hash, scenario.recoveryBinding.reviewed_content_hash);
    assert.deepEqual(linkedAfter.update_request, linkedBefore.update_request, 'recovery binding remains stable');
    assert.equal(linkedAfter.request_hash, linkedBefore.request_hash, 'canonical linked request hash remains stable');
    assert.equal(after.draft.id, scenario.draftId);
    assert.equal(after.draft.provider_draft_id, scenario.providerDraftId);
    assert.equal(after.draft.revision, 4);
    assert.equal(after.draft.provider_change_key, provider.changeKey);
    assert.equal(after.draft.active_update_id, null);

    const committed = await mailboxRows(scenario);
    const lockCountBeforeRetry = observed.locks.length;
    const finalizationCountBeforeRetry = observed.finalizations.length;
    assert.deepEqual(await update(), result, 'a later original-key retry resolves read-only to the committed linked result');
    assert.deepEqual(await mailboxRows(scenario), committed);
    assert.equal(calls.reads, 1, 'a completed retry must not read Graph again');
    assert.equal(observed.locks.length, lockCountBeforeRetry, 'a completed retry must not reacquire the claim lock');
    assert.equal(observed.finalizations.length, finalizationCountBeforeRetry, 'a completed retry must not repeat finalization');
    assert.deepEqual({ writes: calls.writes, creates: calls.creates, sends: calls.sends }, { writes: 0, creates: 0, sends: 0 });
});

test('future or NULL native PostgreSQL recovery leases hold before Graph access and preserve both receipts', async () => {
    const leaseCases = [
        { receiptLease: 'future', draftLease: 'expired' },
        { receiptLease: 'missing', draftLease: 'expired' },
        { receiptLease: 'expired', draftLease: 'future' },
        { receiptLease: 'expired', draftLease: 'missing' },
    ];
    for (const leaseCase of leaseCases) {
        const scenario = await createLinkedRecovery(leaseCase);
        const expectedReceiptType = leaseCase.receiptLease === 'missing' ? 'null' : 'date';
        const expectedDraftType = leaseCase.draftLease === 'missing' ? 'null' : 'date';
        const leases = await assertAdapterLeaseTypes(scenario, expectedReceiptType, expectedDraftType);
        if (leaseCase.receiptLease === 'future') assert.ok(leases.receipt.getTime() > Date.now());
        if (leaseCase.draftLease === 'future') assert.ok(leases.draft.getTime() > Date.now());

        const before = await mailboxRows(scenario);
        const providerCalls = { reads: 0, writes: 0, creates: 0, sends: 0 };
        await assert.rejects(updateMailboxDraft(database, {
            tenantId,
            connectionId,
            draftId: scenario.providerDraftId,
            idempotencyKey: scenario.originalKey,
            request: scenario.request,
            credentialOverride: { access_token: 'credential-override-token' },
            providerOps: {
                async getOutlookDraft() { providerCalls.reads += 1; assert.fail('An unexpired or absent lease must hold before Graph access'); },
                async updateOutlookDraft() { providerCalls.writes += 1; assert.fail('A held recovery must not PATCH Graph'); },
                async createOutlookDraft() { providerCalls.creates += 1; assert.fail('A held recovery must not create a Graph draft'); },
                async sendOutlookMessage() { providerCalls.sends += 1; assert.fail('A held recovery must not send a Graph message'); },
            },
        }), error => error.code === 'DRAFT_UPDATE_IN_PROGRESS');
        assert.deepEqual(providerCalls, { reads: 0, writes: 0, creates: 0, sends: 0 });
        assert.deepEqual(await mailboxRows(scenario), before, 'lease holds must not mutate the original or linked receipt');
    }
});
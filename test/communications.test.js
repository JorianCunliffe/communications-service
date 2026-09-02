import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { outboundError, parseSemantic, providerCallbackUrl } from '../v1.js';
import { tenantForMessage } from '../smsLog.js';
import {
    canonicalCommunication,
    normaliseCorrelation,
    normalisePurpose,
    prefixedId,
    resolveCommunicationThread,
} from '../communicationModel.js';

test('provider callbacks carry the authenticated tenant without exposing a secret', () => {
    const callback = new URL(providerCallbackUrl('https://communications.example/', '/call-status', 'tenant_a'));
    assert.equal(callback.origin, 'https://communications.example');
    assert.equal(callback.pathname, '/call-status');
    assert.equal(callback.searchParams.get('tenant_id'), 'tenant_a');
});

test('inbound SMS emits the canonical communication.received contract', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf("fastify.all('/incoming-sms'"), source.indexOf("fastify.all('/message-status'"));
    assert.match(handler, /type: 'communication\.received'/);
    assert.doesNotMatch(handler, /type: 'sms\.received'/);
});

test('SMS callbacks resolve exactly one tenant before updating provider state', async () => {
    const rows = [
        { tenant_id: 'tenant_a', twilio_message_sid: 'SM_shared' },
        { tenant_id: 'tenant_b', twilio_message_sid: 'SM_shared' },
    ];
    const db = {
        from() {
            const filters = [];
            const query = {
                select() { return query; },
                eq(field, value) { filters.push([field, value]); return query; },
                limit() { return query; },
                then(resolve, reject) {
                    return Promise.resolve({ data: rows.filter((row) => filters.every(([field, value]) => row[field] === value)), error: null }).then(resolve, reject);
                },
            };
            return query;
        },
    };
    await assert.rejects(() => tenantForMessage(db, 'SM_shared'), /exactly one message/);
    assert.equal(await tenantForMessage(db, 'SM_shared', 'tenant_b'), 'tenant_b');
});

class FakeQuery {
    constructor(db, table) {
        this.db = db;
        this.table = table;
        this.filters = [];
        this.operation = 'select';
        this.payload = null;
        this.takeOne = false;
        this.rowLimit = null;
        this.sort = null;
    }
    select() { return this; }
    eq(field, value) { this.filters.push((row) => row[field] === value); return this; }
    in(field, values) { this.filters.push((row) => values.includes(row[field])); return this; }
    order(field, options = {}) { this.sort = { field, ascending: options.ascending !== false }; return this; }
    limit(value) { this.rowLimit = value; return this; }
    maybeSingle() { this.takeOne = true; return this; }
    single() { this.takeOne = true; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    upsert(payload, options = {}) { this.operation = 'upsert'; this.payload = payload; this.conflict = options.onConflict; return this; }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
    execute() {
        const rows = this.db.tables[this.table] ||= [];
        if (this.operation === 'insert') {
            const additions = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((row) => ({ ...row }));
            rows.push(...additions);
            return { data: this.takeOne ? additions[0] : additions, error: null };
        }
        if (this.operation === 'upsert') {
            const keys = String(this.conflict || (this.payload.ask_id ? 'ask_id' : 'thread_id')).split(',');
            const existing = rows.find((row) => keys.every((key) => row[key] === this.payload[key]));
            if (existing) Object.assign(existing, this.payload);
            else rows.push({ ...this.payload });
            return { data: existing || this.payload, error: null };
        }

        let selected = rows.filter((row) => this.filters.every((filter) => filter(row)));
        if (this.operation === 'update') {
            selected.forEach((row) => Object.assign(row, this.payload));
            return { data: selected, error: null };
        }
        if (this.sort) {
            const sign = this.sort.ascending ? 1 : -1;
            selected = [...selected].sort((a, b) => String(a[this.sort.field]).localeCompare(String(b[this.sort.field])) * sign);
        }
        if (this.rowLimit !== null) selected = selected.slice(0, this.rowLimit);
        return { data: this.takeOne ? selected[0] || null : selected, error: null };
    }
}

class FakeDb {
    constructor() {
        this.tables = { communication_threads: [], ask_bindings: [], communication_identities: [] };
    }
    from(table) { return new FakeQuery(this, table); }
}

describe('outbound provider diagnostics', () => {
    test('retains the Twilio error code without exposing credentials', () => {
        const source = new Error('Policy evaluation failed');
        source.code = 60250;
        source.status = 400;
        source.moreInfo = 'https://www.twilio.com/docs/api/errors/60250';

        const result = outboundError('Failed to send message', source);

        assert.equal(result.message, 'Failed to send message: Policy evaluation failed (Twilio 60250)');
        assert.deepEqual(result.providerError, {
            provider: 'twilio',
            code: 60250,
            status: 400,
            more_info: 'https://www.twilio.com/docs/api/errors/60250',
        });
    });
});

describe('first-class communication purpose', () => {
    test('human_ask requires and preserves a real ask_id', () => {
        assert.deepEqual(normalisePurpose({ type: 'human_ask', ask_id: 'ask_93bc' }), {
            type: 'human_ask', ask_id: 'ask_93bc',
        });
        assert.throws(() => normalisePurpose({ type: 'human_ask' }), /requires.*ask_id/);
    });

    test('ask_id is not accepted as a random correlation metadata field', () => {
        assert.deepEqual(normaliseCorrelation({ ask_id: 'ask_wrong', run_id: 'run_8' }), { run_id: 'run_8' });
    });

    test('canonical identity is provider-independent', () => {
        const id = prefixedId('comm');
        assert.match(id, /^comm_[0-9a-f]{32}$/);
        const communication = canonicalCommunication({
            tenantId: 'tenant_1', communicationId: id, threadId: 'thread_1', channel: 'sms', direction: 'outbound',
            provider: 'twilio', providerId: 'SM123',
            purpose: { type: 'human_ask', ask_id: 'ask_93bc' },
        });
        assert.equal(communication.communication_id, id);
        assert.equal(communication.tenant_id, 'tenant_1');
        assert.equal(communication.thread_id, 'thread_1');
        assert.equal(communication.contract_version, '2.0');
        assert.equal(communication.provider_id, 'SM123');
        assert.equal(communication.resolution, null);
    });

    test('canonical voice records expose business outcome separately from provider delivery', () => {
        const communication = canonicalCommunication({
            communicationId: 'comm_voice', channel: 'voice', direction: 'outbound',
            provider: 'twilio', providerId: 'CA123', businessStatus: 'failed',
            disposition: 'voicemail', successful: false, memoryEligible: false,
            failureCode: 'voicemail', failureReason: 'Twilio detected an answering machine',
            outcomeSource: 'twilio_amd', outcomeConfidence: 1,
        });
        assert.deepEqual(communication.outcome, {
            business_status: 'failed', disposition: 'voicemail', successful: false,
            memory_eligible: false, failure_code: 'voicemail',
            failure_reason: 'Twilio detected an answering machine', source: 'twilio_amd',
            confidence: 1, detected_at: null,
        });
    });
});

describe('Ask-aware cross-channel threading', () => {
    test('a client-supplied explicit thread ID is created and preserved', async () => {
        const db = new FakeDb();
        const result = await resolveCommunicationThread({
            db, tenantId: 'tenant_test', participantIdentity: '+61400000000', direction: 'outbound',
            threadId: 'thread_hyperflow_42', purpose: { type: 'human_ask', ask_id: 'ask_42' }, correlation: {},
        });
        assert.equal(result.threadId, 'thread_hyperflow_42');
        assert.equal(db.tables.communication_threads[0].thread_id, 'thread_hyperflow_42');
    });

    test('an inbound call inherits the open purpose created by an SMS Ask', async () => {
        const db = new FakeDb();
        const outbound = await resolveCommunicationThread({
            db,
            participantIdentity: '+61400000000',
            serviceIdentity: '+61411111111',
            direction: 'outbound',
            purpose: { type: 'human_ask', ask_id: 'ask_93bc' },
            correlation: { tenant_id: 'tenant_1', run_id: 'run_8' },
            callbackUrl: 'https://hyperflow.example.com/events',
        });

        const inboundCall = await resolveCommunicationThread({
            db,
            tenantId: 'tenant_1',
            participantIdentity: '+61400000000',
            serviceIdentity: '+61411111111',
            direction: 'inbound',
            purpose: null,
            correlation: {},
        });

        assert.equal(inboundCall.threadId, outbound.threadId);
        assert.equal(inboundCall.linkType, 'inferred');
        assert.deepEqual(inboundCall.purpose, { type: 'human_ask', ask_id: 'ask_93bc' });
        assert.equal(inboundCall.correlation.thread_id, outbound.threadId);
        assert.equal(inboundCall.correlation.run_id, 'run_8');
        assert.equal(db.tables.ask_bindings[0].status, 'open', 'a reply candidate must not auto-resolve the Ask');
    });

    test('an inbound email joins the one open SMS thread for the same person', async () => {
        const db = new FakeDb();
        db.tables.communication_identities.push(
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'phone', value: '+61400000000', provider: 'twilio' },
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'email', value: 'person@example.com', provider: 'gmail' },
        );
        const outboundSms = await resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: '+61400000000', direction: 'outbound',
            purpose: { type: 'human_ask', ask_id: 'ask_cross_channel' }, correlation: {},
        });

        const inboundEmail = await resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: 'Person@Example.com', direction: 'inbound', correlation: {},
        });

        assert.equal(outboundSms.personId, 'person_1');
        assert.equal(db.tables.communication_threads[0].person_id, 'person_1');
        assert.equal(inboundEmail.threadId, outboundSms.threadId);
        assert.equal(inboundEmail.personId, 'person_1');
        assert.equal(inboundEmail.linkType, 'inferred');
        assert.deepEqual(inboundEmail.purpose, { type: 'human_ask', ask_id: 'ask_cross_channel' });
    });

    test('an exact channel thread wins when the person has another open channel thread', async () => {
        const db = new FakeDb();
        db.tables.communication_identities.push(
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'phone', value: '+61400000000' },
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'email', value: 'person@example.com' },
        );
        db.tables.communication_threads.push(
            { tenant_id: 'tenant_1', thread_id: 'thread_sms', person_id: 'person_1', participant_identity: '+61400000000', status: 'open' },
            { tenant_id: 'tenant_1', thread_id: 'thread_email', person_id: 'person_1', participant_identity: 'person@example.com', status: 'open' },
        );

        const inbound = await resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: 'person@example.com', direction: 'inbound', correlation: {},
        });

        assert.equal(inbound.threadId, 'thread_email');
        assert.equal(inbound.personId, 'person_1');
    });

    test('person-wide inference remains ambiguous when a new channel has two candidates', async () => {
        const db = new FakeDb();
        db.tables.communication_identities.push(
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'phone', value: '+61400000000' },
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'email', value: 'person@example.com' },
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'slack', value: 'U_PERSON_1' },
        );
        db.tables.communication_threads.push(
            { tenant_id: 'tenant_1', thread_id: 'thread_sms', person_id: 'person_1', participant_identity: '+61400000000', status: 'open' },
            { tenant_id: 'tenant_1', thread_id: 'thread_email', person_id: 'person_1', participant_identity: 'person@example.com', status: 'open' },
        );

        const inbound = await resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: 'U_PERSON_1', direction: 'inbound', correlation: {},
        });

        assert.equal(inbound.threadId, null);
        assert.equal(inbound.personId, 'person_1');
    });

    test('workflow person correlation stays opaque while the internal person comes from identity', async () => {
        const db = new FakeDb();
        db.tables.communication_identities.push({
            tenant_id: 'tenant_1', person_id: '0f63d010-4fca-4cd4-8ad5-b9de136f28d4',
            type: 'phone', value: '+61400000000', provider: 'twilio',
        });

        const result = await resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: '+61400000000', direction: 'outbound',
            purpose: { type: 'human_ask', ask_id: 'ask_opaque_person' },
            correlation: { person_id: 'Jorian' },
        });

        assert.equal(result.personId, '0f63d010-4fca-4cd4-8ad5-b9de136f28d4');
        assert.equal(result.correlation.person_id, 'Jorian');
        assert.equal(db.tables.communication_threads[0].person_id, '0f63d010-4fca-4cd4-8ad5-b9de136f28d4');
    });

    test('an identity mapped to two people never falls back to raw-address inference', async () => {
        const db = new FakeDb();
        db.tables.communication_identities.push(
            { tenant_id: 'tenant_1', person_id: 'person_1', type: 'email', value: 'shared@example.com' },
            { tenant_id: 'tenant_1', person_id: 'person_2', type: 'email', value: 'shared@example.com' },
        );
        db.tables.communication_threads.push({
            tenant_id: 'tenant_1', thread_id: 'thread_raw', participant_identity: 'shared@example.com', status: 'open',
        });

        const inbound = await resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: 'shared@example.com', direction: 'inbound', correlation: {},
        });

        assert.equal(inbound.threadId, null);
        assert.equal(inbound.personId, null);
    });

    test('an explicit thread cannot be reassigned to a different person', async () => {
        const db = new FakeDb();
        db.tables.communication_threads.push({
            tenant_id: 'tenant_1', thread_id: 'thread_person_1', person_id: 'person_1', status: 'open', correlation: {},
        });
        await assert.rejects(() => resolveCommunicationThread({
            db, tenantId: 'tenant_1', participantIdentity: 'other@example.com', personId: 'person_2',
            direction: 'inbound', threadId: 'thread_person_1', correlation: {},
        }), /different person/);
    });

    test('two open Asks are ambiguous and are never guessed between', async () => {
        const db = new FakeDb();
        db.tables.communication_threads.push(
            { tenant_id: 'tenant_test', thread_id: 'thread_one', participant_identity: '+61400000000', status: 'open', purpose: { type: 'human_ask', ask_id: 'ask_1' }, correlation: {} },
            { tenant_id: 'tenant_test', thread_id: 'thread_two', participant_identity: '+61400000000', status: 'open', purpose: { type: 'human_ask', ask_id: 'ask_2' }, correlation: {} },
        );
        const inbound = await resolveCommunicationThread({
            db, tenantId: 'tenant_test', participantIdentity: '+61400000000', direction: 'inbound', purpose: null, correlation: {},
        });
        assert.equal(inbound.threadId, null);
        assert.equal(inbound.purpose, null);
    });

    test('terminal threads and Ask bindings cannot be reopened', async () => {
        const db = new FakeDb();
        db.tables.communication_threads.push({ tenant_id: 'tenant_test', thread_id: 'thread_done', status: 'resolved', purpose: { type: 'human_ask', ask_id: 'ask_done' }, correlation: {} });
        db.tables.ask_bindings.push({ tenant_id: 'tenant_test', ask_id: 'ask_cancelled', thread_id: 'thread_other', status: 'cancelled' });
        await assert.rejects(() => resolveCommunicationThread({
            db, tenantId: 'tenant_test', participantIdentity: '+61400000000', direction: 'inbound', threadId: 'thread_done', correlation: {},
        }), /cannot accept/);
        await assert.rejects(() => resolveCommunicationThread({
            db, tenantId: 'tenant_test', participantIdentity: '+61400000000', direction: 'outbound', purpose: { type: 'human_ask', ask_id: 'ask_cancelled' }, correlation: {},
        }), /cancelled/);
    });

    test('the same participant in another tenant is never considered for inference', async () => {
        const db = new FakeDb();
        db.tables.communication_threads.push({
            tenant_id: 'tenant_other', thread_id: 'thread_other', participant_identity: '+61400000000',
            status: 'open', purpose: { type: 'human_ask', ask_id: 'ask_other' }, correlation: { tenant_id: 'tenant_other' },
        });
        const result = await resolveCommunicationThread({
            db, tenantId: 'tenant_test', participantIdentity: '+61400000000', direction: 'inbound', correlation: {},
        });
        assert.equal(result.threadId, null);
    });
});

describe('database contract', () => {
    test('migration includes universal IDs, Ask bindings, threads and durable events', () => {
        const sql = readFileSync(new URL('../migrations/003_communications_api.sql', import.meta.url), 'utf8');
        for (const required of [
            'communication_id', 'communication_threads', 'communication_thread_members',
            'communication_identities', 'ask_bindings', 'outbound_events', 'purpose', 'resolution',
            'resolve_communication_ask',
        ]) assert.match(sql, new RegExp(required));
    });

    test('person-aware migration backfills and indexes semantic threads safely', () => {
        const sql = readFileSync(new URL('../migrations/018_person_aware_threads.sql', import.meta.url), 'utf8');
        for (const required of [
            'communication_threads', 'person_id', 'communication_identities',
            'count(distinct i.person_id)=1', 'communication_threads_tenant_person_fk',
            'communication_threads_tenant_person_open',
        ]) assert.match(sql, new RegExp(required.replace(/[()]/g, '\\$&')));
    });
});

describe('versioned API contract', () => {
    test('purpose is parsed separately from correlation and callback URLs require https', () => {
        const parsed = parseSemantic({
            purpose: { type: 'human_ask', ask_id: 'ask_93bc' },
            correlation: { task_id: 'task_12', ask_id: 'not-metadata' },
            callback_url: 'https://hyperflow.example.com/events',
        });
        assert.equal(parsed.purpose.ask_id, 'ask_93bc');
        assert.deepEqual(parsed.correlation, { task_id: 'task_12' });
        assert.equal(parsed.callbackUrl, 'https://hyperflow.example.com/events');
        assert.throws(() => parseSemantic({ callback_url: 'http://127.0.0.1/events' }), /valid https URL/);
    });

    test('/v1 fails closed without credentials and never falls back to memory', () => {
        const script = `
            import assert from 'node:assert/strict';
            import Fastify from 'fastify';
            import v1Routes from './v1.js';

            const app = Fastify();
            await app.register(v1Routes, { prefix: '/v1' });
            const disabled = await app.inject({ method: 'GET', url: '/v1/communications' });
            assert.equal(disabled.statusCode, 503);

            process.env.API_KEY = 'test-key';
            const noDatabase = await app.inject({
                method: 'GET', url: '/v1/communications', headers: { 'x-api-key': 'test-key' },
            });
            assert.equal(noDatabase.statusCode, 503);
            await app.close();
        `;
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
            cwd: new URL('..', import.meta.url),
            encoding: 'utf8',
            env: { ...process.env, API_KEY: '', PERSISTENCE_PROVIDER: 'none' },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
});

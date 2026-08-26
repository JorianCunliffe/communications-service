import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import v1Routes, { outboundError, parseSemantic } from '../v1.js';
import {
    canonicalCommunication,
    normaliseCorrelation,
    normalisePurpose,
    prefixedId,
    resolveCommunicationThread,
} from '../communicationModel.js';

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
            const key = this.conflict || (this.payload.ask_id ? 'ask_id' : 'thread_id');
            const existing = rows.find((row) => row[key] === this.payload[key]);
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
        this.tables = { communication_threads: [], ask_bindings: [] };
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
            communicationId: id, channel: 'sms', direction: 'outbound',
            provider: 'twilio', providerId: 'SM123',
            purpose: { type: 'human_ask', ask_id: 'ask_93bc' },
        });
        assert.equal(communication.communication_id, id);
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
            db, participantIdentity: '+61400000000', direction: 'outbound',
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

    test('two open Asks are ambiguous and are never guessed between', async () => {
        const db = new FakeDb();
        db.tables.communication_threads.push(
            { thread_id: 'thread_one', participant_identity: '+61400000000', status: 'open', purpose: { type: 'human_ask', ask_id: 'ask_1' }, correlation: {} },
            { thread_id: 'thread_two', participant_identity: '+61400000000', status: 'open', purpose: { type: 'human_ask', ask_id: 'ask_2' }, correlation: {} },
        );
        const inbound = await resolveCommunicationThread({
            db, participantIdentity: '+61400000000', direction: 'inbound', purpose: null, correlation: {},
        });
        assert.equal(inbound.threadId, null);
        assert.equal(inbound.purpose, null);
    });

    test('terminal threads and Ask bindings cannot be reopened', async () => {
        const db = new FakeDb();
        db.tables.communication_threads.push({ thread_id: 'thread_done', status: 'resolved', purpose: { type: 'human_ask', ask_id: 'ask_done' }, correlation: {} });
        db.tables.ask_bindings.push({ ask_id: 'ask_cancelled', thread_id: 'thread_other', status: 'cancelled' });
        await assert.rejects(() => resolveCommunicationThread({
            db, participantIdentity: '+61400000000', direction: 'inbound', threadId: 'thread_done', correlation: {},
        }), /cannot accept/);
        await assert.rejects(() => resolveCommunicationThread({
            db, participantIdentity: '+61400000000', direction: 'outbound', purpose: { type: 'human_ask', ask_id: 'ask_cancelled' }, correlation: {},
        }), /cancelled/);
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

    test('/v1 fails closed without credentials and never falls back to memory', async () => {
        const previous = process.env.API_KEY;
        delete process.env.API_KEY;
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
        if (previous === undefined) delete process.env.API_KEY;
        else process.env.API_KEY = previous;
    });
});

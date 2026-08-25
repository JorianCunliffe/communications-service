import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calendarCandidates, ingestCalendarEvent, normaliseCalendarEvent } from '../calendar.js';
import { normalisePlaudRecording, PlaudProvider } from '../plaud.js';
import { counterpartyContent, extractExplicitCommitments, extractMemoryWithModel, parseObviousDueDate, storeCommitments, storeFactVersions } from '../enrichment.js';
import { getEventContext, getLooseEnds, getPersonMemory, getProjectMemory, getThreadMemory, scoreCommunication, searchMemory } from '../memory.js';

class Query {
    constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.op = 'select'; this.payload = null; this.one = false; this.max = null; this.sort = null; }
    select() { return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    gte(key, value) { this.filters.push((row) => row[key] >= value); return this; }
    lte(key, value) { this.filters.push((row) => row[key] <= value); return this; }
    lt(key, value) { this.filters.push((row) => row[key] < value); return this; }
    not(key, operator) { if (operator === 'is') this.filters.push((row) => row[key] !== null && row[key] !== undefined); return this; }
    or() { return this; }
    order(key, options = {}) { this.sort = { key, ascending: options.ascending !== false }; return this; }
    limit(value) { this.max = value; return this; }
    maybeSingle() { this.one = true; return this; }
    single() { this.one = true; return this; }
    insert(value) { this.op = 'insert'; this.payload = value; return this; }
    update(value) { this.op = 'update'; this.payload = value; return this; }
    delete() { this.op = 'delete'; return this; }
    upsert(value, options = {}) { this.op = 'upsert'; this.payload = value; this.conflict = options.onConflict; return this; }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
    execute() {
        const rows = this.db.tables[this.table] ||= [];
        if (this.op === 'insert') {
            const additions = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((row) => ({ id: row.id || `id_${++this.db.counter}`, ...row }));
            rows.push(...additions); return { data: this.one ? additions[0] : additions, error: null };
        }
        if (this.op === 'upsert') {
            const keys = String(this.conflict || 'id').split(',');
            let row = rows.find((candidate) => keys.every((key) => candidate[key] === this.payload[key]));
            if (row) Object.assign(row, this.payload); else { row = { id: this.payload.id || `id_${++this.db.counter}`, ...this.payload }; rows.push(row); }
            return { data: this.one ? row : [row], error: null };
        }
        let found = rows.filter((row) => this.filters.every((filter) => filter(row)));
        if (this.op === 'delete') { this.db.tables[this.table] = rows.filter((row) => !this.filters.every((filter) => filter(row))); return { data: found, error: null }; }
        if (this.op === 'update') { found.forEach((row) => Object.assign(row, this.payload)); return { data: this.one ? found[0] || null : found, error: null }; }
        if (this.sort) found = [...found].sort((a, b) => String(a[this.sort.key] || '').localeCompare(String(b[this.sort.key] || '')) * (this.sort.ascending ? 1 : -1));
        if (this.max !== null) found = found.slice(0, this.max);
        return { data: this.one ? found[0] || null : found, error: null };
    }
}

class FakeDb {
    constructor(tables = {}, search = []) { this.tables = structuredClone(tables); this.search = structuredClone(search); this.counter = 0; }
    from(table) { return new Query(this, table); }
    rpc(name) { return Promise.resolve({ data: name === 'search_communications' ? structuredClone(this.search) : null, error: null }); }
}

describe('calendar memory foundation', () => {
    test('normalises canonical dates and rejects invalid ranges', () => {
        const event = normaliseCalendarEvent({ provider: 'google', providerId: 'g1', title: 'Valuation', startsAt: '2026-08-13T10:30:00+10:00' });
        assert.equal(event.startsAt, '2026-08-13T00:30:00.000Z');
        assert.throws(() => normaliseCalendarEvent({ provider: 'g', providerId: '1', title: 'x', startsAt: '2026-08-14', endsAt: '2026-08-13' }), /cannot be before/);
    });

    test('ingestion is idempotent, resolves exact identities, and retains unknown participants', async () => {
        const db = new FakeDb({
            communication_identities: [{ person_id: 'person_jim', type: 'email', value: 'jim@example.com' }],
            calendar_events: [], calendar_event_participants: [],
        });
        const input = { provider: 'google', providerId: 'event_1', title: 'Smith Street', startsAt: '2026-08-13T00:30:00Z', participants: [
            { type: 'email', value: 'jim@example.com' }, { type: 'email', value: 'unknown@example.com' },
        ] };
        await ingestCalendarEvent(db, input);
        await ingestCalendarEvent(db, input);
        assert.equal(db.tables.calendar_events.length, 1);
        assert.equal(db.tables.calendar_event_participants.length, 2);
        assert.equal(db.tables.calendar_event_participants.find((row) => row.identity_value === 'jim@example.com').contact_id, 'person_jim');
        assert.equal(db.tables.calendar_event_participants.find((row) => row.identity_value === 'unknown@example.com').contact_id, null);

        await ingestCalendarEvent(db, { ...input, participants: [{ type: 'email', value: 'jim@example.com' }] });
        assert.equal(db.tables.calendar_event_participants.length, 1, 'participants missing from the new provider snapshot are removed');
    });

    test('ambiguous nearby events remain candidates and are never auto-linked', async () => {
        const db = new FakeDb({
            calendar_event_participants: [{ contact_id: 'person_1', event_id: 'event_1' }, { contact_id: 'person_1', event_id: 'event_2' }],
            calendar_events: [{ id: 'event_1', starts_at: '2026-08-13T10:00:00Z' }, { id: 'event_2', starts_at: '2026-08-13T10:20:00Z' }],
        });
        const candidates = await calendarCandidates(db, { contactId: 'person_1', occurredAt: '2026-08-13T10:10:00Z' });
        assert.equal(candidates.length, 2);
        assert.ok(candidates.every((item) => /same participant/.test(item.reason)));
    });
});

describe('Plaud uses the existing recording pipeline contract', () => {
    test('normalises correlation without inventing a Plaud API', () => {
        const row = normalisePlaudRecording({ id: 'plaud_42', mediaUrl: 'https://media.example/42.mp3', calendarEventId: 'event_1', projectId: 'project_1', threadId: 'thread_1' });
        assert.equal(row.source, 'plaud'); assert.equal(row.externalId, 'plaud_42'); assert.equal(row.threadId, 'thread_1');
    });

    test('provider requires an injected native adapter', async () => {
        await assert.rejects(() => new PlaudProvider().listRecent(), /not configured/);
    });

    test('existing queue deduplicates, skips transcription for supplied text, and projects recording context', () => {
        const queue = readFileSync(new URL('../recordings.js', import.meta.url), 'utf8');
        const api = readFileSync(new URL('../api.js', import.meta.url), 'utf8');
        const migration = readFileSync(new URL('../migrations/004_calendar_memory.sql', import.meta.url), 'utf8');
        assert.match(queue, /ignoreDuplicates:\s*true/);
        assert.match(queue, /if \(recording\.transcript\)[\s\S]*row\.status = 'done'/);
        for (const field of ['participants', 'calendarEventId', 'projectId', 'threadId', 'meetingType']) assert.ok(api.includes(field));
        assert.match(migration, /project_recording_to_communications/);
        assert.match(migration, /calendar_event_id/);
    });
});

describe('commitment extraction', () => {
    test('extracts an obvious promise and due weekday conservatively', () => {
        const [commitment] = extractExplicitCommitments("I'll send the valuation Monday.", '2026-08-07T00:00:00Z');
        assert.match(commitment.description, /send the valuation/);
        assert.equal(commitment.due_at, '2026-08-10T07:00:00.000Z');
    });

    test('does not manufacture a commitment from an ordinary statement', () => {
        assert.deepEqual(extractExplicitCommitments('The valuation was discussed yesterday.'), []);
        assert.equal(parseObviousDueDate('no date here'), null);
    });

    test('does not turn requests or assistant questions into commitments', () => {
        assert.deepEqual(extractExplicitCommitments('Can you say goodnight?'), []);
        assert.deepEqual(extractExplicitCommitments('Please tell me which you prefer.'), []);
        assert.equal(counterpartyContent({
            direction: 'outbound', body_them: 'I need SMS for the next test.',
            body: 'assistant: Please tell me which you prefer.\nuser: I need SMS for the next test.',
        }), 'I need SMS for the next test.');
    });

    test('rejects model commitments attributed to assistant speech or user preferences', async () => {
        const communication = {
            communication_id: 'comm_call', direction: 'outbound', channel: 'voice', person_id: 'p1',
            occurred_at: '2026-08-25T10:36:13Z', thread_id: 'thread_1',
            body: 'assistant: Please tell me which you prefer.\nuser: I need SMS for the next test.',
            body_them: 'I need SMS for the next test.',
        };
        const db = new FakeDb({ communication_commitments: [] });
        await storeCommitments(db, communication, { commitments: [{
            description: 'Use SMS for the next HyperFlow test', due_at: null, confidence: 0.96,
            source_excerpt: 'I need SMS for the next test.', source_communication_ids: ['comm_call'],
        }, {
            description: 'Confirm the preference', due_at: null, confidence: 0.72,
            source_excerpt: 'Please tell me which you prefer.', source_communication_ids: ['comm_call'],
        }] }, new Set(['comm_call']), new Map([['comm_call', communication]]));
        assert.deepEqual(db.tables.communication_commitments, []);
    });

    test('stores only a verified counterparty promise from an outbound call', async () => {
        const communication = {
            communication_id: 'comm_call', direction: 'outbound', channel: 'voice', person_id: 'p1',
            occurred_at: '2026-08-25T10:36:13Z', thread_id: 'thread_1',
            body: "assistant: Will you send it?\nuser: I'll send it Monday.", body_them: "I'll send it Monday.",
        };
        const db = new FakeDb({ communication_commitments: [] });
        await storeCommitments(db, communication, { commitments: [{
            description: 'Send it Monday', due_at: null, confidence: 0.95,
            source_excerpt: "I'll send it Monday.", source_communication_ids: ['comm_call'],
        }] }, new Set(['comm_call']), new Map([['comm_call', communication]]));
        assert.equal(db.tables.communication_commitments.length, 1, 'the same quoted promise is stored once');
        assert.ok(db.tables.communication_commitments.every((row) => row.promisor_contact_id === 'p1'));
        assert.ok(db.tables.communication_commitments.every((row) => !/will you/i.test(row.description)));
    });

    test('re-enrichment preserves a human-completed commitment', async () => {
        const description = "I'll send the valuation Monday.";
        const db = new FakeDb({ communication_commitments: [{ id: 'c1', communication_id: 'comm_1', description, status: 'completed' }] });
        await storeCommitments(db, { communication_id: 'comm_1', body: description, occurred_at: '2026-08-07T00:00:00Z', direction: 'inbound', person_id: 'p1' }, { commitments: [] });
        assert.equal(db.tables.communication_commitments[0].status, 'completed');
    });
});

describe('structured asynchronous enrichment', () => {
    test('uses strict Responses API output with evidence IDs', async () => {
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-test';
        let requestBody;
        try {
            const result = await extractMemoryWithModel([{ communication_id: 'comm_1', channel: 'sms', direction: 'inbound', occurred_at: '2026-08-10', body: 'I will send it Monday.' }], {
                fetchImpl: async (_url, options) => {
                    requestBody = JSON.parse(options.body);
                    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: null, current_state: null, outstanding_dependency: null, commitments: [], facts: [], source_communication_ids: ['comm_1'] }) }] }] }) };
                },
            });
            assert.deepEqual(result.source_communication_ids, ['comm_1']);
            assert.equal(requestBody.store, false);
            assert.equal(requestBody.text.format.type, 'json_schema');
            assert.equal(requestBody.text.format.strict, true);
            assert.match(requestBody.input[1].content, /comm_1/);
            assert.match(requestBody.input[1].content, /counterparty_content/);
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
        }
    });
});

describe('thread-aware retrieval', () => {
    test('labels direct matches and thread context separately and omits unrelated threads', async () => {
        const hit = { communication_id: 'comm_1', thread_id: 'thread_1', contact_id: 'person_1', project_id: 'project_1', occurred_at: '2026-08-10T00:00:00Z', rank: 0.12, body: 'valuation Monday' };
        const db = new FakeDb({
            communications: [hit, { communication_id: 'comm_2', thread_id: 'thread_1', occurred_at: '2026-08-09T00:00:00Z', body: 'earlier context' }, { communication_id: 'comm_x', thread_id: 'thread_x', body: 'unrelated' }],
            communication_threads: [{ thread_id: 'thread_1', title: 'Valuation', summary: 'Waiting for report' }, { thread_id: 'thread_x', title: 'Unrelated' }],
            communication_facts: [
                { id: 'fact_old', status: 'superseded', text: 'Valuation expected Friday', contact_id: 'person_1', project_id: 'project_1', updated_at: '2026-08-09' },
                { id: 'fact_new', status: 'active', text: 'Valuation expected Monday', contact_id: 'person_1', project_id: 'project_1', source_communication_ids: ['comm_1'], updated_at: '2026-08-10' },
            ], calendar_events: [], calendar_event_participants: [], communication_commitments: [],
        }, [hit]);
        const result = await searchMemory(db, { query: 'valuation', person_id: 'person_1', project_id: 'project_1' });
        assert.equal(result.communications.find((row) => row.communication_id === 'comm_1').relationship_to_query, 'direct_match');
        assert.equal(result.communications.find((row) => row.communication_id === 'comm_2').relationship_to_query, 'thread_context');
        assert.equal(result.communications.some((row) => row.communication_id === 'comm_x'), false);
        assert.deepEqual(result.threads.map((row) => row.thread_id), ['thread_1']);
        assert.ok(result.threads[0].score > 0);
        assert.deepEqual(result.facts.map((row) => row.id), ['fact_new'], 'active facts are preferred over superseded history');
    });

    test('ranking explains person, project, thread and recency boosts', () => {
        const result = scoreCommunication({ rank: 0.1, contact_id: 'p1', project_id: 'j1', thread_id: 't1', occurred_at: new Date().toISOString() }, { person_id: 'p1', project_id: 'j1', thread_id: 't1' });
        assert.ok(result.score_reasons.text > 0); assert.ok(result.score_reasons.person > 0); assert.ok(result.score_reasons.project > 0); assert.ok(result.score_reasons.thread > 0);
    });
});

describe('memory read models', () => {
    test('thread memory includes enrichment and provenance without requiring it', async () => {
        const db = new FakeDb({
            communication_threads: [{ thread_id: 't1', summary: 'Valuation discussed', summary_source_ids: ['comm_1'], current_state: 'Waiting for report', current_state_source_ids: ['comm_1'] }],
            communications: [{ communication_id: 'comm_1', thread_id: 't1', person_id: 'p1', occurred_at: '2026-08-10' }],
            calendar_events: [], communication_commitments: [{ id: 'c1', thread_id: 't1', communication_id: 'comm_1' }],
            communication_facts: [{ id: 'f1', thread_id: 't1', status: 'active', source_communication_ids: ['comm_1'] }],
            contacts: [{ id: 'p1', name: 'Jim' }],
        });
        const memory = await getThreadMemory(db, 't1');
        assert.equal(memory.current_state, 'Waiting for report');
        assert.deepEqual(memory.provenance.summary, ['comm_1']);
        assert.deepEqual(memory.provenance.facts.f1, ['comm_1']);
    });

    test('person memory assembles active work, evidence and upcoming events', async () => {
        const db = new FakeDb({
            contacts: [{ id: 'p1', name: 'Jim' }],
            communications: [{ communication_id: 'comm_1', person_id: 'p1', thread_id: 't1', occurred_at: '2026-08-10' }],
            communication_threads: [{ thread_id: 't1', status: 'open' }],
            communication_commitments: [{ id: 'c1', status: 'open', promisor_contact_id: 'p1', updated_at: '2026-08-10' }],
            communication_facts: [{ id: 'f1', status: 'active', contact_id: 'p1', updated_at: '2026-08-10' }],
            calendar_event_participants: [{ event_id: 'e1', contact_id: 'p1' }],
            calendar_events: [{ id: 'e1', starts_at: '2099-08-13T10:00:00Z' }],
        });
        const memory = await getPersonMemory(db, 'p1');
        assert.equal(memory.person.name, 'Jim'); assert.equal(memory.active_threads.length, 1);
        assert.equal(memory.open_commitments.length, 1); assert.equal(memory.upcoming_calendar_events.length, 1);
    });

    test('project and event views assemble scoped context', async () => {
        const db = new FakeDb({
            projects: [{ id: 'project_1', name: 'Smith Street' }],
            project_contacts: [{ project_id: 'project_1', role: 'valuer', contacts: { id: 'p1' } }],
            communications: [{ communication_id: 'comm_1', project_id: 'project_1', person_id: 'p1', thread_id: 't1', occurred_at: '2026-08-10' }],
            communication_threads: [{ thread_id: 't1', status: 'open', last_activity_at: '2026-08-10' }],
            communication_commitments: [{ id: 'c1', status: 'open', thread_id: 't1', updated_at: '2026-08-10' }],
            communication_facts: [{ id: 'f1', status: 'active', project_id: 'project_1', thread_id: 't1', contact_id: 'p1', updated_at: '2026-08-10' }],
            calendar_events: [{ id: 'e1', project_id: 'project_1', communication_thread_id: 't1', starts_at: '2026-08-13' }],
            calendar_event_participants: [{ event_id: 'e1', contact_id: 'p1' }],
        });
        const project = await getProjectMemory(db, 'project_1');
        assert.equal(project.project.name, 'Smith Street'); assert.equal(project.threads.length, 1); assert.equal(project.open_commitments.length, 1);
        const event = await getEventContext(db, 'e1');
        assert.equal(event.event.id, 'e1'); assert.equal(event.recent_threads.length, 1); assert.equal(event.open_commitments.length, 1);
    });
});

describe('loose ends', () => {
    test('returns open commitments and unresolved Asks, but not completed commitments', async () => {
        const db = new FakeDb({
            communication_commitments: [
                { id: 'c1', communication_id: 'comm_1', status: 'open', description: 'Send valuation', thread_id: 't1' },
                { id: 'c2', communication_id: 'comm_2', status: 'completed', description: 'Already done', thread_id: 't1' },
            ],
            ask_bindings: [{ ask_id: 'ask_1', status: 'open', thread_id: 't2', purpose: { type: 'human_ask' }, created_at: '2026-08-10' }],
            communication_threads: [],
        });
        const loose = await getLooseEnds(db);
        assert.ok(loose.some((row) => row.type === 'commitment' && row.description === 'Send valuation'));
        assert.ok(loose.some((row) => row.type === 'human_ask'));
        assert.equal(loose.some((row) => row.description === 'Already done'), false);
    });
});

describe('fact lifecycle', () => {
    test('a new value supersedes rather than deletes the old provenance', async () => {
        const db = new FakeDb({ communication_facts: [] });
        const first = { communication_id: 'comm_1', thread_id: 'thread_1', person_id: 'person_1', project_id: 'project_1', direction: 'inbound', body_them: 'Inspection is at 10:30.' };
        const second = { communication_id: 'comm_2', thread_id: 'thread_1', person_id: 'person_1', project_id: 'project_1', direction: 'inbound', body_them: 'Inspection moved to 11:30.' };
        await storeFactVersions(db, second, [{ fact_key: 'inspection_time', text: 'Inspection is at 10:30.', confidence: 0.9, source_communication_ids: ['comm_1'] }], new Set(['comm_1']), new Map([['comm_1', first]]));
        await storeFactVersions(db, second, [{ fact_key: 'inspection_time', text: 'Inspection moved to 11:30.', confidence: 0.95, source_communication_ids: ['comm_2'] }], new Set(['comm_2']), new Map([['comm_2', second]]));
        assert.equal(db.tables.communication_facts.length, 2);
        assert.equal(db.tables.communication_facts[0].status, 'superseded');
        assert.equal(db.tables.communication_facts[1].status, 'active');
        assert.deepEqual(db.tables.communication_facts[1].source_communication_ids, ['comm_2']);
        assert.equal(db.tables.communication_facts[0].superseded_by, db.tables.communication_facts[1].id);
    });

    test('rejects facts cited only to assistant or missing evidence', async () => {
        const db = new FakeDb({ communication_facts: [] });
        const assistantOnly = { communication_id: 'comm_1', direction: 'outbound', body: 'assistant: The meeting is Wednesday.' };
        await storeFactVersions(db, assistantOnly, [{
            fact_key: 'meeting_day', text: 'The meeting is Wednesday.', confidence: 0.9,
            source_communication_ids: ['comm_1'],
        }], new Set(['comm_1']), new Map([['comm_1', assistantOnly]]));
        assert.deepEqual(db.tables.communication_facts, []);
    });
});

describe('migration contract', () => {
    test('adds calendar, durable enrichment, provenance, lifecycle and recording correlation', () => {
        const files = ['004_calendar_memory', '005_communications_enrichment', '006_memory_search', '007_rectification'];
        const sql = files.map((name) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8')).join('\n');
        for (const token of ['calendar_events', 'calendar_event_participants', 'communication_commitments', 'communication_facts', 'source_communication_ids', 'superseded', 'communication_enrichment_jobs', 'rerun_requested', 'participant_identities', 'calendar_event_id', 'outbound_operations', 'lease_token', 'communication_row_id', "exception when others"]) assert.match(sql, new RegExp(token));
    });
});

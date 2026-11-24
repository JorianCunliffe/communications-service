import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import twilio from 'twilio';
import { createPhase02Database } from './fixtures/phase02Database.js';
import { createPostgresClient, closeDatabase } from '../database.js';
import { peekCallConfig } from '../configResolver.js';
import { buildGreetingResponse, buildSessionUpdate } from '../config.js';
import { outboundModelHealth } from '../outboundReadiness.js';
import { executeTool } from '../tools.js';
import { resolvePhoneLine, prepareClientVoice, readLineHistory } from '../phoneLines.js';

const tenant = 'line_owner',
    key = 'isolated-lines-test',
    account = 'AC' + '1'.repeat(32);
const lines = ['+15550000101', '+15550000102'],
    client = '+15550000200';
const base = 'https://phone.test.invalid';
const sid = (prefix, id) => prefix + String(id).padStart(32, '0');

test('two configured lines exchange voice and SMS with one client through signed webhooks and authenticated routes', async (t) => {
    const f = await createPhase02Database(tenant, key);
    t.after(async () => {
        await closeDatabase();
        await f.close();
    });
    Object.assign(process.env, {
        DATABASE_URL: 'postgres://invalid.invalid/test',
        PERSISTENCE_PROVIDER: 'postgres',
        PRECONNECT_REALTIME: 'false',
        TWILIO_VALIDATE_SIGNATURES: 'enforce',
        PUBLIC_URL: base,
        OPENAI_API_KEY: 'test',
        TWILIO_ACCOUNT_SID: account,
        TWILIO_AUTH_TOKEN: 'local-token',
        HYPERFLOW_EVENT_URL: base + '/events',
        COMMUNICATIONS_WEBHOOK_SECRET: 'fixture-only',
    });
    const db = createPostgresClient(f.sql);
    pg.Pool.prototype.transaction = (work) => f.sql.transaction(work);
    t.after(() => {
        delete pg.Pool.prototype.transaction;
    });
    let historyOffline = false;
    t.mock.method(pg.Pool.prototype, 'query', (...args) => {
        if (historyOffline && args[0].includes('"phone_line_history"(')) throw Error('fixture history outage');
        return f.sql.query(...args);
    });
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (url === 'https://api.twilio.com/2010-04-01/Accounts/' + account + '.json')
            return Response.json({ sid: account, owner_account_sid: account, status: 'active' });
        if (url === 'https://api.twilio.com/2010-04-01/Accounts/' + account + '/Balance.json')
            return Response.json({ currency: 'USD', balance: '20' });
        throw Error('Unexpected outbound HTTP in isolated test');
    });
    t.mock.method(outboundModelHealth, 'read', () => ({
        checkedAt: 'fixture',
        models: [
            { roles: ['voice'], usable: true },
            { roles: ['live_transcription'], usable: true },
        ],
    }));
    const dispatches = [];
    t.mock.method(twilio.Twilio.prototype, 'request', async (options) => {
        assert.equal(options.method, 'post');
        const voice = options.uri.endsWith('/Calls.json');
        assert.ok(voice || options.uri.endsWith('/Messages.json'));
        const id = sid(voice ? 'CA' : 'SM', dispatches.length + 1);
        dispatches.push({ id, ...options.data });
        return { statusCode: 201, body: { sid: id, status: 'queued' } };
    });
    const { fastify: app } = await import('../index.js');
    t.after(() => app.close());
    const send = (path, payload, k) =>
        app.inject({ method: 'POST', url: path, payload, headers: { 'x-api-key': key, 'Idempotency-Key': k } });
    const webhook = (path, payload) =>
        app.inject({
            method: 'POST',
            url: path,
            payload,
            headers: {
                'x-twilio-signature': twilio.getExpectedTwilioSignature('local-token', base + path, payload),
            },
        });
    const read = async (line, query = '') => {
        const response = await app.inject({
            url: '/v1/phone-lines/' + encodeURIComponent(line) + '/activity' + query,
            headers: { 'x-api-key': key },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
    };
    for (const line of lines)
        await f.sql.query(
            "insert into phone_configs(tenant_id,twilio_number,line_role,call_system_prompt) values($1,$2,'client','Use {{combined_history}}')",
            [tenant, line],
        );
    await f.sql.query(
        "insert into contacts(tenant_id,name,phone_number,combined_history) values($1,'Client',$2,'FORBIDDEN CONTACT DIGEST')",
        [tenant, client],
    );
    const clientQuery = '?client=' + encodeURIComponent(client);
    assert.equal((await read(lines[0], clientQuery)).status, 'empty');
    for (const [i, line] of lines.entries()) {
        const inbound = { From: client, To: line, Body: 'marker for line ' + i, MessageSid: sid('SM', 500 + i) };
        const duplicates = await Promise.all([
            webhook('/incoming-sms', inbound),
            webhook('/incoming-sms', inbound),
        ]);
        for (const response of duplicates) {
            assert.equal(response.statusCode, 200, response.body);
        }
        const smsPath = i === 0 ? '/v1/messages' : '/sms';
        const payload = { from: line, to: client, body: '  exact reply ' + i + '  ' };
        const sent = await send(smsPath, payload, 'sms-' + i);
        assert.equal(sent.statusCode, 201, sent.body);
        assert.equal(sent.json().history_status, 'available');
        assert.equal((await send(smsPath, payload, 'sms-' + i)).statusCode, 200);
        assert.equal(dispatches.at(-1).Body, payload.body);
        assert.equal(dispatches.at(-1).From, line);
        const callback = new URL(dispatches.at(-1).StatusCallback);
        const delivered = await webhook(callback.pathname + callback.search, {
            MessageSid: dispatches.at(-1).id,
            MessageStatus: 'delivered',
        });
        assert.equal(delivered.statusCode, 204, delivered.body);
        const timeline = await read(line, clientQuery);
        assert.ok(timeline.items.some((item) => item.content === payload.body && item.status === 'delivered'));
    }
    for (const [i, line] of lines.entries()) {
        const outgoing = await send(
            i === 0 ? '/v1/calls' : '/outbound-call',
            { from: line, to: client },
            'voice-' + i,
        );
        assert.equal(outgoing.statusCode, 201, outgoing.body);
        const placed = dispatches.at(-1);
        const url = new URL(placed.Url);
        const answered = await webhook(url.pathname + url.search, { CallSid: placed.id, From: line, To: client });
        assert.equal(answered.statusCode, 200, answered.body);
        assert.match(answered.body, /mediaCapability/);
        const inboundId = sid('CA', 900 + i);
        const incoming = await webhook('/incoming-call', { CallSid: inboundId, From: client, To: line });
        assert.match(incoming.body, /<Stream /);
        for (const id of [placed.id, inboundId]) {
            const config = peekCallConfig(id);
            const prompt = buildSessionUpdate(config).session.instructions;
            assert.ok(prompt.includes('marker for line ' + i), prompt);
            assert.ok(buildGreetingResponse(config).response.instructions.includes('marker for line ' + i));
            assert.ok(!prompt.includes('marker for line ' + (1 - i)));
            assert.ok(!prompt.includes('FORBIDDEN CONTACT DIGEST'));
            const found = await executeTool(
                'recall_conversations',
                { about: 'marker' },
                { clientLine: true, tenantId: tenant, serviceIdentity: line, phoneNumber: client },
            );
            assert.deepEqual(
                found.output.items.map((row) => row.content),
                ['marker for line ' + i],
            );
        }
        const page = await read(line, clientQuery + '&limit=1');
        assert.ok(page.next);
        const older = await read(line, clientQuery + '&limit=1&cursor=' + page.next);
        assert.notEqual(page.items[0].communication_id, older.items[0].communication_id);
        const prior = await read(line, clientQuery + '&before_communication=' + page.items[0].communication_id);
        assert.equal(prior.items[0].communication_id, older.items[0].communication_id);
    }
    assert.equal(dispatches.length, 4);
    assert.equal((await f.sql.query('select count(*) as n from sms_messages')).rows[0].n, 4);
    await f.sql.query('update phone_configs set sms_enabled=false where twilio_number=$1', [lines[0]]);
    const disabled = await send('/v1/messages', { from: lines[0], to: client, body: 'blocked' }, 'disabled');
    assert.equal(disabled.statusCode, 403, disabled.body);
    await f.sql.query('update contacts set do_not_contact=true where tenant_id=$1 and phone_number=$2', [
        tenant,
        client,
    ]);
    const suppressed = await send('/v1/messages', { from: lines[1], to: client, body: 'blocked' }, 'suppressed');
    assert.equal(suppressed.statusCode, 409, suppressed.body);
    await assert.rejects(resolvePhoneLine(db, lines[1], { tenantId: 'other', channel: 'voice' }), {
        statusCode: 403,
    });
    assert.equal(dispatches.length, 4);
    const unknown = sid('CA', 980);
    assert.match(
        (await webhook('/incoming-call', { From: '+15550000888', To: lines[1], CallSid: unknown })).body,
        /<Stream /,
    );
    assert.match(peekCallConfig(unknown).lineHistoryPrompt, /No eligible/);
    // Complete asynchronous call logging before closing the database fixture.
    for (let n = 0; n < 100; n++) {
        if ((await f.sql.query('select count(*) as n from calls')).rows[0].n >= 5) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const count = (await f.sql.query('select count(*) as n from calls where twilio_number is not null')).rows[0].n;
    assert.equal(count, 5);
    for (const [i, line] of lines.entries()) {
        await f.sql.query(`update calls set summary=$1, memory_eligible=true where twilio_call_sid=$2`, [
            'approved voice summary ' + i,
            sid('CA', 900 + i),
        ]);
        const timeline = (await read(line, clientQuery)).items;
        assert.ok(
            timeline.some((item) => item.channel === 'voice' && item.content === 'approved voice summary ' + i),
        );
        assert.ok(!timeline.some((item) => item.content === 'approved voice summary ' + (1 - i)));
    }
    await f.sql.query(
        "insert into calls(tenant_id,twilio_call_sid,phone_number,direction,memory_eligible,summary) values($1,$2,$3,'inbound',true,'ambiguous secret')",
        [tenant, sid('CA', 1000), client],
    );
    const results = await read(lines[1], clientQuery);
    assert.ok(!JSON.stringify(results).includes('ambiguous secret'));
    await f.sql.query(
        `update communications set metadata=metadata||'{"visibility":"private"}' where tenant_id=$1 and body='marker for line 1'`,
        [tenant],
    );
    assert.ok(!JSON.stringify(await read(lines[1], clientQuery)).includes('marker for line 1'));
    assert.equal((await app.inject({ url: '/v1/phone-lines' })).statusCode, 401);
    const foreign = '+15550000444';
    await f.sql.query("insert into tenants(tenant_id,name) values('foreign_lines','Foreign')");
    await f.sql.query("insert into phone_configs(tenant_id,twilio_number) values('foreign_lines',$1)", [foreign]);
    await f.sql.query('update contacts set do_not_contact=false where tenant_id=$1 and phone_number=$2', [
        tenant,
        client,
    ]);
    for (const [path, payload] of [
        ['/v1/messages', { from: foreign, to: client, body: 'blocked' }],
        ['/v1/calls', { from: foreign, to: client }],
    ]) {
        const denied = await send(path, payload, 'foreign-' + path);
        assert.equal(denied.statusCode, 403, denied.body);
    }
    assert.equal(dispatches.length, 4);
    historyOffline = true;
    for (const [path, payload] of [
        ['/v1/messages', { from: lines[1], to: client, body: 'exact offline' }],
        ['/v1/calls', { from: lines[1], to: client }],
    ]) {
        const sent = await send(path, payload, 'offline-' + path);
        assert.equal(sent.statusCode, 201, sent.body);
        assert.equal(sent.json().history_status, 'unavailable');
    }
    assert.equal(dispatches.length, 6);
    const unavailable = await read(lines[1], clientQuery);
    assert.equal(unavailable.status, 'unavailable');
});

test('failed history reads allow client calls without claiming prior knowledge', async () => {
    const offline = { rpc: async () => ({ error: { message: 'offline' } }) };
    const line = { tenant_id: tenant, twilio_number: lines[0] };
    const config = await prepareClientVoice(offline, { systemMessage: 'Reception' }, line, client);
    assert.match(config.lineHistoryPrompt, /temporarily unavailable/);
    assert.equal(config.wantsHistory, false);
    const started = Date.now();
    const timeout = await readLineHistory(
        { rpc: () => new Promise(() => {}) },
        { tenantId: tenant, line: lines[0], client },
    );
    assert.equal(timeout.status, 'unavailable');
    assert.ok(Date.now() - started < 5000);
});

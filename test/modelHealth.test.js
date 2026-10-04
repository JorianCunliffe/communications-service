import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { configuredModelChecks, createModelHealth, failureStatus, probeModel, probeRealtime } from '../modelHealth.js';

test('inventory follows each worker fallback and deduplicates by transport', () => {
    const checks = configuredModelChecks({ SUMMARY_MODEL: 'summary', MEMORY_MODEL: 'memory', PROMISE_MODEL: 'promise' });
    assert.equal(checks.find(c => c.roles.includes('call_outcome')).model, 'memory');
    assert.equal(checks.find(c => c.roles.includes('operational_review')).model, 'promise');
    assert.equal(checks.filter(c => c.model === 'memory').length, 1);
    assert.ok(checks.some(c => c.transport === 'realtime'));
});

test('credits, throttling, permissions and unavailable models stay distinct', () => {
    assert.equal(failureStatus(429, { code: 'insufficient_quota' }), 'quota_or_credit_exhausted');
    assert.equal(failureStatus(429), 'rate_limited');
    assert.equal(failureStatus(403), 'authentication_failed');
    assert.equal(failureStatus(404), 'model_unavailable');
    assert.equal(failureStatus(503), 'provider_unavailable');
});

test('paid checks share one in-flight request, cache, cooldown and stale metadata', async () => {
    let time = 1700000000000, count = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const health = createModelHealth({ now: () => time, env: {}, probe: async () => {
        count++; await barrier; return { status: 'working', usable: true };
    } });
    assert.equal(health.read().stale, true);
    const first = health.refresh(), second = health.refresh();
    assert.equal(health.read().checking, true);
    release();
    await Promise.all([first, second]);
    const expected = configuredModelChecks({}).length;
    assert.equal(count, expected);
    assert.equal(health.read().allWorking, true);
    await health.refresh(); assert.equal(count, expected);
    time += 31 * 60000;
    assert.equal(health.read().stale, true);
    await health.refresh(); assert.equal(count, expected * 2);
});

test('model failures cannot make aggregate green or leak raw messages', async () => {
    const response = await probeModel({ model: 'test', transport: 'responses' }, {
        env: { OPENAI_API_KEY: 'secret' }, fetchImpl: async () => ({ ok: false, status: 429,
            json: async () => ({ error: { code: 'insufficient_quota', message: 'secret customer account' } }) }),
    });
    assert.deepEqual(response, { status: 'quota_or_credit_exhausted', usable: false });
    const health = createModelHealth({ probe: async () => response });
    const result = await health.refresh();
    assert.equal(result.status, 'degraded'); assert.equal(result.allWorking, false);
    assert.ok(!JSON.stringify(result).includes('secret'));
});

test('successful HTTP with failed or incomplete generation is not working', async () => {
    const result = await probeModel({ model: 'test', transport: 'responses' }, {
        env: { OPENAI_API_KEY: 'secret' }, fetchImpl: async () => ({ ok: true,
            json: async () => ({ status: 'incomplete' }) }),
    });
    assert.equal(result.usable, false);
});

test('realtime requires completed generation, not just a socket connection', async () => {
    let socket;
    class Socket extends EventEmitter {
        constructor() { super(); socket = this; }
        send(message) { this.sent = JSON.parse(message); }
        terminate() { this.terminated = true; }
    }
    const pending = probeRealtime({ model: 'test' }, 'secret', Socket);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.created' })));
    assert.equal(socket.sent.type, 'response.create');
    assert.deepEqual(socket.sent.response.output_modalities, ['text']);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { status: 'completed' } })));
    assert.deepEqual(await pending, { status: 'working', usable: true });
    assert.equal(socket.terminated, true);
});

test('missing key and provider timeout fail explicitly', async () => {
    assert.equal((await probeModel({ transport: 'chat' }, { env: {} })).status, 'not_configured');
    const result = await probeModel({ transport: 'chat' }, { env: { OPENAI_API_KEY: 'secret' },
        fetchImpl: async () => { throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); } });
    assert.equal(result.status, 'timeout');
});

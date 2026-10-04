import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { probeTwilio, createTwilioHealth, registerTwilioHealthRoutes } from '../twilioHealth.js';
const sid = 'AC' + 'a'.repeat(32);
const env = { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: 'secret-token' };
function fixture(status = 'active', amount = '25.00', extra = {}) {
    const requests = [];
    return { requests, fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => url.endsWith('/Balance.json')
            ? { balance: amount, currency: 'USD' }
            : { sid, owner_account_sid: sid, status, auth_token: 'private', friendly_name: 'private', ...extra } };
    } };
}
test('read-only account/balance probes use fixed URLs and discard secrets', async () => {
    const f = fixture(); const result = await probeTwilio({ env, ...f });
    assert.equal(result.status, 'active'); assert.equal(result.balance.amount, '25.00');
    assert.equal(f.requests.length, 2);
    for (const request of f.requests) {
        assert.ok(request.url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${sid}`));
        assert.equal(request.options.method, 'GET'); assert.equal(request.options.redirect, 'error');
        assert.ok(request.options.signal);
    }
    assert.doesNotMatch(JSON.stringify(result), /secret|private|ACaaaa/);
});
test('suspended and closed are never masked by a positive balance', async () => {
    for (const status of ['suspended', 'closed']) assert.equal((await probeTwilio({ env, ...fixture(status) })).status, status);
});
test('low, zero and negative balance warnings and configured threshold', async () => {
    for (const [value, expected] of [['10', 'low_balance'], ['0', 'depleted_balance'], ['-2', 'depleted_balance']]) {
        assert.equal((await probeTwilio({ env, ...fixture('active', value) })).status, expected);
    }
    assert.equal((await probeTwilio({ env: { ...env, TWILIO_LOW_BALANCE_THRESHOLD: '30' }, ...fixture() })).status, 'low_balance');
});
test('missing or invalid credentials/configuration make no provider requests', async () => {
    const fetchImpl = () => { throw new Error('must not call'); };
    assert.equal((await probeTwilio({ env: {}, fetchImpl })).status, 'not_configured');
    assert.equal((await probeTwilio({ env: { ...env, TWILIO_ACCOUNT_SID: '../x' }, fetchImpl })).status, 'invalid_configuration');
    assert.equal((await probeTwilio({ env: { ...env, TWILIO_LOW_BALANCE_THRESHOLD: '-1' }, fetchImpl })).status, 'invalid_configuration');
});
test('subaccounts cannot imply parent billing readiness or follow arbitrary URLs', async () => {
    const f = fixture('active', '25', { owner_account_sid: 'AC' + 'b'.repeat(32), subresource_uris: { balance: 'https://evil.example' } });
    const result = await probeTwilio({ env, ...f });
    assert.equal(result.balanceCheck, 'parent_account_required'); assert.equal(result.status, 'balance_unavailable');
    assert.equal(f.requests.length, 1);
});
test('HTTP and network errors are bounded classifications without raw messages', async () => {
    for (const [status, expected] of [[401, 'authentication_failed'], [403, 'authentication_failed'], [429, 'rate_limited'], [500, 'provider_unavailable']]) {
        assert.equal((await probeTwilio({ env, fetchImpl: async () => ({ ok: false, status }) })).status, expected);
    }
    for (const [name, expected] of [['TimeoutError', 'timeout'], ['Error', 'check_failed']]) {
        const result = await probeTwilio({ env, fetchImpl: async () => { throw Object.assign(new Error('secret'), { name }); } });
        assert.equal(result.status, expected); assert.doesNotMatch(JSON.stringify(result), /secret/);
    }
});
test('malformed account and balance never become healthy', async () => {
    assert.equal((await probeTwilio({ env, ...fixture('invented') })).status, 'invalid_response');
    for (const amount of ['', null, 'NaN', 'Infinity']) {
        assert.equal((await probeTwilio({ env, ...fixture('active', amount) })).status, 'balance_unavailable');
    }
});
test('cache deduplicates, cools down, expires and redacts public balance', async () => {
    let now = 1700000000000, calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const health = createTwilioHealth({ now: () => now, probe: async () => { calls++; await gate; return probeTwilio({ env, ...fixture() }); } });
    assert.equal(health.read().accountReady, false);
    const first = health.refresh(), second = health.refresh();
    release(); await Promise.all([first, second]);
    assert.equal(calls, 1); assert.equal(health.read().accountReady, true);
    assert.equal(health.read().balance, undefined); assert.equal(health.read({ privateDetails: true }).balance.amount, '25.00');
    await health.refresh(); assert.equal(calls, 1);
    now += 11 * 60000;
    assert.equal(health.read().stale, true); assert.equal(health.read().accountReady, false);
    await health.refresh(); assert.equal(calls, 2);
});
test('operator routes require authentication before refresh or balance disclosure', async () => {
    const previous = process.env.API_KEY; process.env.API_KEY = 'test-key';
    const app = Fastify(); let refreshes = 0;
    registerTwilioHealthRoutes(app, { read: options => ({ balance: options.privateDetails ? 'private' : null }), refresh: async () => { refreshes++; } });
    try {
        for (const [method, url] of [['GET', '/health/twilio'], ['POST', '/health/twilio/refresh']]) {
            const denied = await app.inject({ method, url }); assert.equal(denied.statusCode, 401); assert.doesNotMatch(denied.body, /private/);
            const allowed = await app.inject({ method, url, headers: { 'x-api-key': 'test-key' } });
            assert.equal(allowed.statusCode, 200); assert.equal(allowed.headers['cache-control'], 'no-store');
        }
        assert.equal(refreshes, 1);
    } finally { await app.close(); if (previous === undefined) delete process.env.API_KEY; else process.env.API_KEY = previous; }
});

test('balance failure preserves suspension and a later successful refresh recovers', async () => {
    const f = fixture('suspended');
    const result = await probeTwilio({ env, fetchImpl: async (url, options) => url.endsWith('/Balance.json')
        ? { ok: false, status: 403 } : f.fetchImpl(url, options) });
    assert.equal(result.status, 'suspended'); assert.equal(result.balanceCheck, 'authentication_failed');
    let time = 1700000000000, fail = true;
    const health = createTwilioHealth({ now: () => time, probe: async () => {
        if (fail) throw new Error('private');
        return probeTwilio({ env, ...fixture() });
    } });
    await health.refresh(); assert.equal(health.read().accountReady, false);
    assert.equal(health.read().status, 'check_failed');
    time += 60001; fail = false; await health.refresh();
    assert.equal(health.read().accountReady, true);
});

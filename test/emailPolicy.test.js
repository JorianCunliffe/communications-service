import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import v1Routes from '../v1.js';
import { assertEmailSendAllowed } from '../emailPolicy.js';
import { sendEmailWithProvider } from '../emailDelivery.js';
import { emailProviderAdapters } from '../emailProviders.js';
import { authenticateTenantRequest, hashApiSecret, rejectMissingCapability } from '../auth.js';

const contract = JSON.parse(readFileSync(new URL('../contracts/email-authority.v1.json', import.meta.url), 'utf8'));
function env(t, values) {
    const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    t.after(() => { for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } });
}
test('shared transport policy restricts CEO and preserves other authorized tenants', t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: JSON.stringify(contract.policies) });
    for (const item of contract.cases) {
        if (item.communications) assert.doesNotThrow(() => assertEmailSendAllowed(item.tenant));
        else assert.throws(() => assertEmailSendAllowed(item.tenant), e => e.statusCode === 403);
    }
});
test('malformed policy and missing tenant cannot reach the provider', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: '[]' });
    assert.throws(() => assertEmailSendAllowed('ceo'), e => e.statusCode === 503);
    await assert.rejects(sendEmailWithProvider({ connection: {}, request: {}, idempotencyKey: 'x' }), e => e.statusCode === 403);
});
test('provider boundary blocks configured tenant before adapter lookup', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: '{"ceo":"draft_only"}' });
    await assert.rejects(sendEmailWithProvider({
        connection: { tenant_id: 'ceo', provider: 'must-not-be-called' }, request: {}, idempotencyKey: 'x'
    }), e => e.statusCode === 403 && e.code === 'email_draft_only');
});
test('another tenant still reaches its provider when explicitly permitted', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: '{"ceo":"draft_only","sender":"allow_send"}' });
    const send = t.mock.method(emailProviderAdapters.resend, 'send', async () => ({ id: 'provider-fixture' }));
    const result = await sendEmailWithProvider({
        connection: { tenant_id: 'sender', provider: 'resend' },
        request: { from: 'sender@example.invalid', to: ['recipient@example.invalid'], subject: 'Fixture', text: 'Test' },
        idempotencyKey: 'fixture-allow'
    });
    assert.equal(result.providerId, 'provider-fixture');
    assert.equal(send.mock.callCount(), 1);
});
test('HTTP legacy wildcard cannot override tenant ceiling or spoof tenant via body', async t => {
    env(t, { API_KEY: 'phase01-test', LEGACY_TENANT_ID: 'ceo',
        EMAIL_SEND_POLICY_BY_TENANT: '{"ceo":"draft_only","sender":"allow_send"}' });
    const app = Fastify();
    await app.register(v1Routes, { prefix: '/v1' });
    t.after(() => app.close());
    const response = await app.inject({ method: 'POST', url: '/v1/emails',
        headers: { 'x-api-key': 'phase01-test', 'x-tenant-id': 'ceo' },
        payload: { approved: true, sendPolicy: 'automatic', correlation: { tenant_id: 'ceo' } } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, 'email_draft_only');
    const spoof = await app.inject({ method: 'POST', url: '/v1/emails',
        headers: { 'x-api-key': 'phase01-test', 'x-tenant-id': 'sender' }, payload: {} });
    assert.equal(spoof.statusCode, 403);
    const malformed = await app.inject({ method: 'POST', url: '/v1/emails',
        headers: { 'x-api-key': 'phase01-test', 'x-tenant-id': 'ceo' }, payload: { tenant_id: 'sender' } });
    assert.ok([400, 403].includes(malformed.statusCode));
});
test('scoped client grants remain channel-specific and cannot cross tenant', async () => {
    const secret = 'phase01-long-test-secret-00001';
    const client = { id: 'client', key_id: 'key', secret_hash: await hashApiSecret(secret),
        allowed_tenants: ['ceo'], roles: [], capabilities: ['communications:write', 'email:draft'] };
    const query = { select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: client }), update() { return this; } };
    const db = { from: () => query };
    const headers = { 'x-api-key': 'key.' + secret, 'x-tenant-id': 'ceo' };
    const auth = await authenticateTenantRequest({ headers }, db);
    assert.equal(auth.ok, true);
    const reply = { code(value) { this.status = value; return this; }, send(value) { return value; } };
    const request = { authContext: auth, body: { capabilities: ['*'], approved: true } };
    for (const capability of ['email:send', 'sms:send', 'voice:call']) {
        assert.match(rejectMissingCapability(request, reply, capability).error, /lacks required capability/);
        assert.equal(reply.status, 403);
    }
    assert.equal(rejectMissingCapability(request, reply, 'email:draft'), null);
    const foreign = await authenticateTenantRequest({ headers: { ...headers, 'x-tenant-id': 'foreign' } }, db);
    assert.equal(foreign.status, 403);
});

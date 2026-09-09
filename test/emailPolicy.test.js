import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import v1Routes from '../v1.js';
import { assertEmailSendAllowed, readEmailPolicy, saveEmailPolicy } from '../emailPolicy.js';
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
        database: policyDb(), connection: { tenant_id: 'ceo', provider: 'must-not-be-called' }, request: {}, idempotencyKey: 'x'
    }), e => e.statusCode === 403 && e.code === 'email_draft_only');
});
test('another tenant still reaches its provider when explicitly permitted', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: '{"ceo":"draft_only","sender":"allow_send"}' });
    const send = t.mock.method(emailProviderAdapters.resend, 'send', async () => ({ id: 'provider-fixture' }));
    const result = await sendEmailWithProvider({
        database: policyDb(), connection: { tenant_id: 'sender', provider: 'resend' },
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
    await app.register(v1Routes, { prefix: '/v1', database: policyDb() });
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

function policyDb() {
    const rows = new Map(['ceo', 'sender'].map(id => [id, { status: 'active', metadata: { retained: true }, updated_at: '2026-09-08T00:00:00.000Z' }]));
    return { from(table) {
        assert.equal(table, 'tenants');
        let tenant, metadata, patch;
        return { select() { return this; }, eq(key, value) { if (key === 'tenant_id') tenant = value; else if (key === 'metadata') metadata = value; return this; },
            update(value) { patch = value; return this; }, async maybeSingle() {
                const row = rows.get(tenant);
                if (!row || (metadata && metadata !== JSON.stringify(row.metadata))) return { data: null };
                if (patch) rows.set(tenant, { ...row, ...patch });
                return { data: rows.get(tenant) };
            } };
    } };
}
test('account policy defaults safely, persists both modes and rejects stale writes', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: undefined });
    const db = policyDb();
    const initial = await readEmailPolicy(db, 'ceo');
    assert.equal(initial.mode, 'draft_only');
    const allowed = await saveEmailPolicy(db, 'ceo', { mode: 'allow_send', version: initial.version });
    assert.equal((await readEmailPolicy(db, 'ceo')).mode, 'allow_send');
    assert.equal((await readEmailPolicy(db, 'sender')).mode, 'draft_only');
    await assert.rejects(saveEmailPolicy(db, 'ceo', { mode: 'draft_only', version: initial.version }), e => e.statusCode === 409);
    assert.equal((await saveEmailPolicy(db, 'ceo', { mode: 'draft_only', version: allowed.version })).mode, 'draft_only');
    assert.equal((await db.from('tenants').select().eq('tenant_id', 'ceo').maybeSingle()).data.metadata.retained, true);
    await assert.rejects(saveEmailPolicy(db, 'ceo', { mode: 'allow_send', version: '' }), e => e.statusCode === 400);
});
test('saved restriction wins over operator grant and operator ceiling wins over saved grant', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: '{"ceo":"allow_send","sender":"draft_only"}' });
    assert.throws(() => assertEmailSendAllowed('ceo', 'draft_only'), e => e.statusCode === 403);
    assert.throws(() => assertEmailSendAllowed('sender', 'allow_send'), e => e.statusCode === 403);
});
test('policy HTTP routes authenticate and enforce tenant binding', async t => {
    env(t, { API_KEY: 'policy-test', LEGACY_TENANT_ID: 'ceo', EMAIL_SEND_POLICY_BY_TENANT: undefined });
    const app = Fastify();
    await app.register(v1Routes, { prefix: '/v1', database: policyDb() });
    t.after(() => app.close());
    assert.equal((await app.inject({ method: 'GET', url: '/v1/tenant-policy/email' })).statusCode, 401);
    const headers = { 'x-api-key': 'policy-test', 'x-tenant-id': 'ceo' };
    const current = await app.inject({ method: 'GET', url: '/v1/tenant-policy/email', headers });
    assert.equal(current.statusCode, 200);
    const saved = await app.inject({ method: 'POST', url: '/v1/tenant-policy/email', headers,
        payload: { mode: 'allow_send', version: current.json().version } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().mode, 'allow_send');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/tenant-policy/email', headers: { ...headers, 'x-tenant-id': 'sender' } })).statusCode, 403);
});

test('concurrent policy updates cannot overwrite each other', async t => {
    env(t, { EMAIL_SEND_POLICY_BY_TENANT: undefined });
    const db = policyDb();
    const initial = await readEmailPolicy(db, 'ceo');
    const outcomes = await Promise.allSettled(['allow_send', 'draft_only'].map(mode => saveEmailPolicy(db, 'ceo', { mode, version: initial.version })));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.statusCode, 409);
});
test('ordinary scoped service client cannot change email authority', async t => {
    env(t, { API_KEY: undefined, EMAIL_SEND_POLICY_BY_TENANT: undefined });
    const secret = 'policy-scoped-fixture-secret';
    const client = { id: 'client', key_id: 'policy', secret_hash: await hashApiSecret(secret),
        allowed_tenants: ['ceo'], roles: [], capabilities: ['communications:read', 'communications:write', 'email:send'] };
    const tenants = policyDb();
    const db = { from(table) {
        if (table === 'tenants') return tenants.from(table);
        assert.equal(table, 'api_clients');
        return { select() { return this; }, eq() { return this; }, update() { return this; }, maybeSingle: async () => ({ data: client }) };
    } };
    const app = Fastify();
    await app.register(v1Routes, { prefix: '/v1', database: db });
    t.after(() => app.close());
    const headers = { 'x-api-key': 'policy.' + secret, 'x-tenant-id': 'ceo' };
    assert.equal((await app.inject({ method: 'GET', url: '/v1/tenant-policy/email', headers })).statusCode, 200);
    const response = await app.inject({ method: 'POST', url: '/v1/tenant-policy/email', headers,
        payload: { mode: 'allow_send', version: 'unconfigured', capabilities: ['*'], approved: true } });
    assert.equal(response.statusCode, 403);
    assert.equal((await readEmailPolicy(tenants, 'ceo')).mode, 'draft_only');
});

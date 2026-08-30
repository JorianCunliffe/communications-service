import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalEmail, outboundEmailRequest } from '../email.js';
import { triageEmail } from '../emailTriage.js';
import { replyTokenFromAddresses } from '../emailReplyRoutes.js';
import { hashApiSecret, verifyApiSecret } from '../auth.js';
import { tenantDatabase } from '../tenantContext.js';
import Fastify from 'fastify';
import { inboundEmailInput, installRawJsonParser } from '../emailWebhook.js';
import { Webhook } from 'svix';
import { emailProviderAdapters } from '../emailProviders.js';

class Query {
    constructor(log, table) { this.log = log; this.table = table; this.filters = []; this.payload = null; this.operation = 'select'; }
    select() { return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    then(resolve, reject) {
        this.log.push({ table: this.table, operation: this.operation, filters: this.filters, payload: this.payload });
        return Promise.resolve({ data: this.payload, error: null }).then(resolve, reject);
    }
}

describe('tenant boundary', () => {
    test('reads are filtered and writes are stamped structurally', async () => {
        const log = [];
        const raw = {
            from: (table) => new Query(log, table),
            rpc: async (name, args) => ({ data: { name, args }, error: null }),
        };
        const db = tenantDatabase(raw, 'tenant_a');
        await db.from('communications').select('*').eq('channel', 'email');
        await db.from('contacts').insert({ name: 'Alex' });
        await db.from('communications').update({ summary: 'done' }).eq('communication_id', 'comm_1');
        assert.deepEqual(log[0].filters, [['channel', 'email'], ['tenant_id', 'tenant_a']]);
        assert.equal(log[1].payload.tenant_id, 'tenant_a');
        assert.deepEqual(log[2].filters, [['communication_id', 'comm_1'], ['tenant_id', 'tenant_a']]);
        await assert.rejects(async () => db.from('contacts').insert({ tenant_id: 'tenant_b' }), /Cross-tenant/);
    });

    test('tenant-aware RPCs receive the authenticated tenant', async () => {
        const raw = { from: () => new Query([], 'x'), rpc: async (name, args) => ({ data: { name, args }, error: null }) };
        const result = await tenantDatabase(raw, 'tenant_a').rpc('search_communications', { q: 'lease' });
        assert.equal(result.data.args.p_tenant_id, 'tenant_a');
    });
});

describe('inbound email routing', () => {
    test('keeps the verified SMTP envelope recipient ahead of the retrieve response', () => {
        const input = inboundEmailInput({
            email_id: 'email_1',
            to: ['reply+abcdefghijklmnopqrstuvwx@projectflow.online'],
            subject: 'Reply',
        }, {
            id: 'email_1',
            to: ['hyperflow@projectflow.online'],
            from: 'person@example.com',
            text: 'Received',
        });
        assert.deepEqual(input.to, ['reply+abcdefghijklmnopqrstuvwx@projectflow.online']);
        assert.equal(input.text, 'Received');
        assert.equal(input.provider_email_id, 'email_1');
    });

    test('requeues the exact routing failures caused by the old recipient precedence', () => {
        const migration = readFileSync(new URL('../migrations/013_inbound_email_reply_recovery.sql', import.meta.url), 'utf8');
        assert.match(migration, /Inbound address did not resolve to exactly one trusted receiving identity/);
        assert.match(migration, /status='pending',attempts=0/);
        assert.match(migration, /provider_event_type='email\.received'/);
    });
});

describe('email adapter contract', () => {
    test('preserves exact JSON bytes for webhook signature verification', async () => {
        const app = Fastify();
        installRawJsonParser(app);
        app.post('/hook', async (request) => ({ raw: request.rawBody.toString('utf8'), parsed: request.body }));
        const raw = '{ "type" : "email.received", "data": {} }';
        const response = await app.inject({ method: 'POST', url: '/hook', headers: { 'content-type': 'application/json' }, payload: raw });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().raw, raw);
        await app.close();
    });

    test('accepts an exact signed provider body and rejects a changed body', () => {
        const previous = process.env.TEST_RESEND_WEBHOOK_SECRET;
        const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
        process.env.TEST_RESEND_WEBHOOK_SECRET = secret;
        const raw = '{"type":"email.received","data":{"email_id":"email_1"}}';
        const id = 'msg_test_1';
        const timestamp = new Date();
        const signature = new Webhook(secret).sign(id, timestamp, raw);
        const headers = {
            'svix-id': id,
            'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
            'svix-signature': signature,
        };
        const connection = { webhook_secret_reference: 'env:TEST_RESEND_WEBHOOK_SECRET' };
        assert.equal(emailProviderAdapters.resend.verifyWebhook({ connection, rawBody: raw, headers }).type, 'email.received');
        assert.throws(() => emailProviderAdapters.resend.verifyWebhook({ connection, rawBody: `${raw} `, headers }));
        if (previous === undefined) delete process.env.TEST_RESEND_WEBHOOK_SECRET;
        else process.env.TEST_RESEND_WEBHOOK_SECRET = previous;
    });

    test('normalises addresses and removes active HTML', () => {
        const email = canonicalEmail({
            id: 'email_1', from: 'Alex <ALEX@example.com>', to: ['team@example.com'],
            subject: 'Hello', text: 'Hi', html: '<p>Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
            headers: { 'Message-ID': '<one@example.com>' }, created_at: '2026-08-27T00:00:00Z',
        });
        assert.equal(email.from_addresses[0].address, 'alex@example.com');
        assert.equal(email.message_id, '<one@example.com>');
        assert.doesNotMatch(email.sanitized_html, /script|javascript/i);
    });

    test('requires a deliverable outbound envelope', () => {
        assert.throws(() => outboundEmailRequest({ from: 'a@example.com', to: [], subject: 'x', text: 'y' }), /At least one/);
        const email = outboundEmailRequest({ from: 'a@example.com', to: 'b@example.com', subject: 'x', text: 'y' });
        assert.equal(email.to[0].address, 'b@example.com');
    });

    test('bounces and automatic replies cannot feed Ask completion or memory', () => {
        const bounce = triageEmail({
            from_addresses: [{ address: 'mailer-daemon@example.com' }], subject: 'Delivery Status Notification', text_body: '', headers: {},
        });
        assert.equal(bounce.classification, 'bounce');
        assert.equal(bounce.askResponseEligible, false);
        assert.equal(bounce.memoryEligible, false);
        const automatic = triageEmail({
            from_addresses: [{ address: 'person@example.com' }], subject: 'Away', text_body: '', headers: { 'auto-submitted': 'auto-replied' },
        });
        assert.equal(automatic.classification, 'automatic_reply');
        assert.equal(automatic.askResponseEligible, false);
        const unsubscribe = triageEmail({
            from_addresses: [{ address: 'person@example.com' }], subject: 'Please unsubscribe me', text_body: '', headers: {},
        });
        assert.equal(unsubscribe.classification, 'unsubscribe_intent');
        assert.equal(unsubscribe.askResponseEligible, false);
    });

    test('opaque reply tokens are extracted only from the dedicated route shape', () => {
        const token = 'abcdefghijklmnopqrstuvwx';
        assert.equal(replyTokenFromAddresses([{ address: `reply+${token}@reply.example.com` }]), token);
        assert.equal(replyTokenFromAddresses([{ address: 'team@example.com' }]), null);
    });
});

describe('API client credentials', () => {
    test('stores a salted one-way scrypt verifier', async () => {
        const encoded = await hashApiSecret('this-is-a-long-random-test-secret');
        assert.match(encoded, /^scrypt\$/);
        assert.equal(await verifyApiSecret('this-is-a-long-random-test-secret', encoded), true);
        assert.equal(await verifyApiSecret('wrong-secret', encoded), false);
        assert.doesNotMatch(encoded, /this-is-a-long/);
    });
});

describe('migration contract', () => {
    test('adds first-class tenants, provider connections, receipts, jobs and email records', () => {
        const tenancy = readFileSync(new URL('../migrations/009_multi_tenancy.sql', import.meta.url), 'utf8');
        const email = readFileSync(new URL('../migrations/010_email_pipeline.sql', import.meta.url), 'utf8');
        for (const term of ['LEGACY_TENANT_ID', 'api_clients', 'allowed_tenants', 'communications_tenant_provider_unique']) {
            assert.match(tenancy, new RegExp(term));
        }
        for (const term of ['provider_connections', 'webhook_receipts', 'communication_jobs', 'email_messages', 'email_reply_routes']) {
            assert.match(email, new RegExp(term));
        }
        assert.match(tenancy, /grant select, insert, update, delete on public\.tenants, public\.api_clients to service_role/i);
        assert.match(email, /grant select, insert, update, delete on public\.provider_connections[\s\S]+to service_role/i);
        assert.match(email, /revoke execute on function public\.claim_communication_jobs\(integer,integer\) from public/i);
    });
});

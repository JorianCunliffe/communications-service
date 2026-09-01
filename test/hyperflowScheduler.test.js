import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { hyperFlowSchedulerHeaders, hyperFlowSchedulerUrl, runHyperFlowSchedulerTick } from '../hyperflowScheduler.js';

test('derives the tick endpoint while preserving the Vercel bypass parameter', () => {
    const url = hyperFlowSchedulerUrl('https://hyper-flow5.vercel.app/api/events?x-vercel-protection-bypass=opaque');
    assert.equal(url, 'https://hyper-flow5.vercel.app/api/schedules?x-vercel-protection-bypass=opaque&action=tick');
});

test('signs the empty scheduler request body with the shared V2 HMAC contract', () => {
    const timestamp = '1788162000';
    const secret = 'shared-secret';
    const headers = hyperFlowSchedulerHeaders(timestamp, secret);
    assert.equal(headers['x-communications-timestamp'], timestamp);
    assert.equal(headers['x-communications-signature-v2'], `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).digest('hex')}`);
});

test('posts one signed empty-body tick and does not expose the secret in the URL', async () => {
    let captured;
    const result = await runHyperFlowSchedulerTick({
        eventUrl: 'https://hyper-flow5.vercel.app/api/events?x-vercel-protection-bypass=opaque',
        secret: 'shared-secret',
        now: 1788162000000,
        fetcher: async (url, options, policy) => {
            captured = { url, options, policy };
            return { ok: true, status: 200 };
        },
    });
    assert.deepEqual(result, { skipped: false, status: 200 });
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.body, undefined);
    assert.equal(captured.url.includes('shared-secret'), false);
    assert.equal(captured.policy.maxRedirects, 0);
});

test('stays disabled when durable HyperFlow event configuration is absent', async () => {
    assert.deepEqual(await runHyperFlowSchedulerTick({ eventUrl: null, secret: 'secret' }), { skipped: true, reason: 'not_configured' });
    assert.deepEqual(await runHyperFlowSchedulerTick({ eventUrl: 'https://example.com/api/events', secret: null }), { skipped: true, reason: 'not_configured' });
});

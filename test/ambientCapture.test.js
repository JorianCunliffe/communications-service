import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { captureAmbientWork, withAmbientCapture } from '../ambientCapture.js';
import { applyHyperFlowVoiceContext } from '../hyperflowVoice.js';
import { buildToolDefinitions } from '../tools.js';

const context = { tenantId: 'org', personId: 'person', communicationId: 'comm', threadId: 'thread', serviceIdentity: '+61400000000' };
test('phone tool signs trusted context, strips injected fields and uses the existing HyperFlow origin', async () => {
    const keys = ['HYPERFLOW_EVENT_URL', 'HYPERFLOW_AGENT_CONTEXT_URL', 'COMMUNICATIONS_WEBHOOK_SECRET'];
    const before = keys.map(key => process.env[key]);
    process.env.HYPERFLOW_EVENT_URL = 'https://hyperflow.example/api/events?old=query'; delete process.env.HYPERFLOW_AGENT_CONTEXT_URL;
    process.env.COMMUNICATIONS_WEBHOOK_SECRET = 'test-secret';
    try {
        let submitted;
        const fetchCapture = async (url, options, policy) => {
            assert.equal(url, 'https://hyperflow.example/api/agent/capture-work');
            assert.deepEqual(policy.allowedHosts, ['hyperflow.example']); assert.equal(policy.maxRedirects, 0);
            submitted = JSON.parse(options.body);
            assert.equal(options.headers['x-communications-signature-v2'], `sha256=${createHmac('sha256', 'test-secret').update(`${options.headers['x-communications-timestamp']}.${options.body}`).digest('hex')}`);
            return { ok: true, json: async () => ({ saved: true, id: 'capture-1' }) };
        };
        const args = { rawText: 'Meet the buyer', idempotencyKey: 'turn-1', tenant_id: 'evil', capturedForUserId: 'victim', sourceProjectId: 'foreign' };
        assert.equal((await captureAmbientWork(args, context, { fetchCapture })).saved, true);
        assert.equal(submitted.tenant_id, 'org');
        assert.deepEqual(submitted.capture, { rawText: 'Meet the buyer', idempotencyKey: 'turn-1' });
        assert.equal(buildToolDefinitions(withAmbientCapture({ tools: [], systemMessage: 'Continue the workflow' }).tools).some(tool => tool.name === 'captureWorkItem'), true);
        for (const result of [{ saved: false }, { saved: true }, { id: 'capture-1' }]) {
            await assert.rejects(captureAmbientWork(args, context, { fetchCapture: async () => ({ ok: true, json: async () => result }) }), /could not be confirmed/);
        }
        await assert.rejects(captureAmbientWork(args, { ...context, personId: null }, { fetchCapture }), /Trusted personId/);
        await assert.rejects(captureAmbientWork(args, context, { fetchCapture: async () => { throw new Error('timeout'); } }), /timeout/);
    } finally { keys.forEach((key, i) => before[i] === undefined ? delete process.env[key] : process.env[key] = before[i]); }
});
test('inbound phone capture is advertised only when HyperFlow returns the owner capability', () => {
    const config = { systemMessage: 'base', tools: ['end_call'] };
    const voice = { greeting: 'Hello', instructions: 'Continue', routing: { kind: 'routed' } };
    assert.equal(applyHyperFlowVoiceContext(config, voice).tools.includes('captureWorkItem'), false);
    const owner = applyHyperFlowVoiceContext(config, { ...voice, captureEnabled: true });
    assert.equal(owner.tools.includes('captureWorkItem'), true);
    assert.match(owner.systemMessage, /Only acknowledge capture after saved:true/);
});

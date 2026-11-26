import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVoiceContextTelemetry } from '../voiceContextTelemetry.js';

test('recorder is inert when disabled', () => {
    assert.equal(startVoiceContextTelemetry({
        requestId: 'fixture', body: 'secret', enabled: false,
        clock: () => assert.fail('clock called'), emit: () => assert.fail('emitted'),
    }), null);
});

test('recorder measures decoded UTF-8 bytes and monotonic stages without retaining content', () => {
    let now = 10;
    const events = [];
    const span = startVoiceContextTelemetry({
        requestId: 'fixture', body: 'secret-é', enabled: true,
        clock: () => now, wallClock: () => 0, emit: event => events.push(event),
    });
    now = 20; span.headers(200);
    now = 35; span.body('private-🙂');
    now = 40; span.finish('ok');
    span.finish('failed');
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.request_bytes, Buffer.byteLength('secret-é'));
    assert.equal(e.response_bytes, Buffer.byteLength('private-🙂'));
    assert.equal(e.headers_ms, 10);
    assert.equal(e.body_ms, 25);
    assert.equal(e.duration_ms, 30);
    assert.equal(e.status_code, 200);
    assert.equal(e.outcome, 'ok');
    assert.doesNotMatch(JSON.stringify(e), /secret|private|🙂/);
});

test('recorder handles incomplete spans and failing sinks without throwing', () => {
    const events = [];
    startVoiceContextTelemetry({ requestId: 'x', body: '', enabled: true,
        emit: e => events.push(e) }).finish('timeout');
    assert.equal(events[0].status_code, null);
    assert.equal(events[0].response_bytes, null);
    assert.equal(events[0].body_ms, null);
    assert.equal(events[0].outcome, 'timeout');
    assert.doesNotThrow(() => startVoiceContextTelemetry({ requestId: 'x', body: '', enabled: true,
        emit: () => { throw new Error('sink failure'); } }).finish('failed'));
    assert.equal(startVoiceContextTelemetry({ requestId: 'x', body: '', enabled: true,
        clock: () => { throw new Error('clock failure'); } }), null);
});

test('existing HyperFlow read preserves request, response, and error behavior with telemetry on or off', async () => {
    const { requestHyperFlowVoiceContext } = await import('../hyperflowVoice.js');
    const keys = ['VOICE_CONTEXT_TELEMETRY', 'HYPERFLOW_AGENT_CONTEXT_URL', 'COMMUNICATIONS_WEBHOOK_SECRET'];
    const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    const oldInfo = console.info;
    const events = [];
    console.info = (label, value) => { if (label === 'voice_context_telemetry') events.push(...value.events); };
    try {
        process.env.HYPERFLOW_AGENT_CONTEXT_URL = 'https://fixture.invalid/api/agent/voice-context';
        process.env.COMMUNICATIONS_WEBHOOK_SECRET = 'fixture-secret';
        const input = { tenantId: 'tenant', personId: 'person', threadId: 'thread',
            communicationId: 'call', serviceIdentity: 'line', utterance: 'private question' };
        const expected = { instructions: 'private context', greeting: 'Hello' };
        const error = new Error('transport failure');
        for (const enabled of ['0', '1']) {
            process.env.VOICE_CONTEXT_TELEMETRY = enabled;
            let calls = 0, reads = 0;
            const result = await requestHyperFlowVoiceContext(input, { fetchContext: async (url, options, policy) => {
                calls++;
                assert.equal(url, process.env.HYPERFLOW_AGENT_CONTEXT_URL);
                assert.equal(options.method, 'POST');
                assert.match(options.headers['x-communications-signature-v2'], /^sha256=/);
                assert.equal(JSON.parse(options.body).communication_id, 'call');
                assert.equal(policy.maxRedirects, 0);
                return { status: 200, ok: true, text: async () => { reads++; return JSON.stringify(expected); } };
            } });
            assert.deepEqual(result, expected);
            assert.equal(calls, 1);
            assert.equal(reads, 1);
            await assert.rejects(requestHyperFlowVoiceContext(input, { fetchContext: async () => { throw error; } }), e => e === error);
            await assert.rejects(requestHyperFlowVoiceContext(input, { fetchContext: async () => ({
                status: 200, ok: true, text: async () => '{"unexpected":true}',
            }) }), /invalid response/);
            await new Promise(resolve => setImmediate(resolve));
            if (enabled === '0') assert.equal(events.length, 0);
        }
        assert.deepEqual(events.map(e => e.outcome), ['ok', 'failed', 'failed']);
        assert.equal(events[0].response_bytes, Buffer.byteLength(JSON.stringify(expected)));
        assert.equal(events[1].response_bytes, null);
        assert.equal(events[2].status_code, 200);
        assert.doesNotMatch(JSON.stringify(events), /private question|private context|fixture-secret|transport failure/);
    } finally {
        console.info = oldInfo;
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    }
});

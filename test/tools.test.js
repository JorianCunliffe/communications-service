import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_ON_TOOLS, buildToolDefinitions, listTools } from '../tools.js';
import { DEFAULT_CONFIG, buildSessionUpdate } from '../config.js';
import { VOICE_CONTEXT_TIMEOUT_MS, withToolDeadline } from '../voiceContextDeadline.js';
import { requestHyperFlowVoiceContext } from '../hyperflowVoice.js';

const previous = process.env.ALWAYS_OFFER_END_CALL;
const setFlag = (value) => {
    if (value === undefined) delete process.env.ALWAYS_OFFER_END_CALL;
    else process.env.ALWAYS_OFFER_END_CALL = value;
};
const names = (definitions) => definitions.map((definition) => definition.name);

afterEach(() => setFlag(previous));

test('voice context arriving after five seconds remains usable within its shared deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(listTools().find(tool => tool.name === 'select_hyperflow_project').timeoutMs, VOICE_CONTEXT_TIMEOUT_MS);
    let attempts = 0;
    let settled = false;
    const result = withToolDeadline(() => {
        attempts++;
        return new Promise(resolve => setTimeout(() => resolve({ code: 'synthetic' }), 6000));
    }, VOICE_CONTEXT_TIMEOUT_MS, 'context').finally(() => { settled = true; });
    await Promise.resolve();
    t.mock.timers.tick(5001);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(999);
    assert.deepEqual(await result, { code: 'synthetic' });
    assert.equal(attempts, 1);
});

test('voice context timeout aborts the actual HTTP body read, without a hidden request continuing', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const keys = ['HYPERFLOW_AGENT_CONTEXT_URL', 'COMMUNICATIONS_WEBHOOK_SECRET'];
    const before = keys.map(key => process.env[key]);
    process.env.HYPERFLOW_AGENT_CONTEXT_URL = 'https://context.example.test/api/context';
    process.env.COMMUNICATIONS_WEBHOOK_SECRET = 'unit-test-secret';
    let requestSignal;
    let aborted = false;
    let requests = 0;
    try {
        const result = withToolDeadline(signal => requestHyperFlowVoiceContext({
            tenantId: 'tenant', personId: 'person', threadId: 'thread', communicationId: 'comm', serviceIdentity: '+61400000000', signal,
        }, { fetchContext: async (_url, options) => {
            requests++;
            requestSignal = options.signal;
            return { ok: true, text: () => new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
            }) };
        } }), VOICE_CONTEXT_TIMEOUT_MS, 'context');
        const rejected = assert.rejects(result, /timed out after 8000ms/);
        await Promise.resolve();
        await Promise.resolve();
        t.mock.timers.tick(VOICE_CONTEXT_TIMEOUT_MS);
        await rejected;
        assert.equal(requestSignal.aborted, true);
        assert.equal(aborted, true);
        assert.equal(requests, 1);
    } finally {
        keys.forEach((key, i) => before[i] === undefined ? delete process.env[key] : process.env[key] = before[i]);
    }
});

test('completed tool deadline is cleared and does not later abort a successful request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    assert.equal(await withToolDeadline(s => { signal = s; return 'ok'; }, 100, 'context'), 'ok');
    t.mock.timers.tick(1000);
    assert.equal(signal.aborted, false);
});

describe('end_call is offered on every call', () => {
    test('the default empty configuration still advertises end_call', () => {
        setFlag(undefined);
        assert.deepEqual(DEFAULT_CONFIG.tools, []);
        assert.deepEqual(names(buildToolDefinitions(DEFAULT_CONFIG.tools)), ['end_call']);
    });

    test('missing and malformed configured tool lists remain safe', () => {
        setFlag(undefined);
        for (const value of [undefined, null, 'end_call']) {
            assert.deepEqual(names(buildToolDefinitions(value)), ['end_call']);
        }
    });

    test('configured tools preserve order without duplicating end_call', () => {
        setFlag(undefined);
        assert.deepEqual(names(buildToolDefinitions(['get_current_time'])), ['get_current_time', 'end_call']);
        assert.deepEqual(names(buildToolDefinitions(['end_call', 'get_current_time'])), ['end_call', 'get_current_time']);
    });

    test('unknown tools are dropped without removing end_call', () => {
        setFlag(undefined);
        assert.deepEqual(names(buildToolDefinitions(['no_such_tool'])), ['end_call']);
    });

    test('session.update carries the default tool to the Realtime model', () => {
        setFlag(undefined);
        const session = buildSessionUpdate({ ...DEFAULT_CONFIG, tools: [] });
        assert.deepEqual(names(session.session.tools), ['end_call']);
        assert.equal(session.session.tool_choice, 'auto');
    });

    test('the explicit deployment kill switch restores opt-in behavior', () => {
        for (const value of ['false', 'FALSE', '0', 'off', 'no']) {
            setFlag(value);
            assert.deepEqual(buildToolDefinitions([]), []);
        }
        setFlag('false');
        assert.deepEqual(names(buildToolDefinitions(['end_call'])), ['end_call']);
    });

    test('the always-on list has one canonical definition', () => {
        assert.deepEqual(ALWAYS_ON_TOOLS, ['end_call']);
    });
});

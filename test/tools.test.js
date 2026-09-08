import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_ON_TOOLS, buildToolDefinitions } from '../tools.js';
import { DEFAULT_CONFIG, buildSessionUpdate } from '../config.js';

const previous = process.env.ALWAYS_OFFER_END_CALL;
const setFlag = (value) => {
    if (value === undefined) delete process.env.ALWAYS_OFFER_END_CALL;
    else process.env.ALWAYS_OFFER_END_CALL = value;
};
const names = (definitions) => definitions.map((definition) => definition.name);

afterEach(() => setFlag(previous));

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

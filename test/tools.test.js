import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_ON_TOOLS, buildToolDefinitions } from '../tools.js';
import { DEFAULT_CONFIG, buildSessionUpdate } from '../config.js';

// end_call has been fully implemented for a while: the registry defines it, the
// media stream watches for it, and it hangs up only once the farewell has
// actually played. None of that ran, because DEFAULT_CONFIG.tools is [] and
// buildToolDefinitions returned nothing for an empty list — so unless someone
// had written end_call into a contact's enabled_tools column by hand, the
// assistant was placed on the call with no way to end it.

const previous = process.env.ALWAYS_OFFER_END_CALL;
const setFlag = (value) => {
    if (value === undefined) delete process.env.ALWAYS_OFFER_END_CALL;
    else process.env.ALWAYS_OFFER_END_CALL = value;
};

const names = (definitions) => definitions.map((definition) => definition.name);

afterEach(() => setFlag(previous));

describe('end_call is offered on every call', () => {
    test('a call with no configured tools can still hang up', () => {
        setFlag(undefined);
        assert.deepEqual(names(buildToolDefinitions([])), ['end_call']);
    });

    test('the default configuration is such a call', () => {
        setFlag(undefined);
        assert.deepEqual(DEFAULT_CONFIG.tools, [], 'the premise of this fix');
        assert.ok(names(buildToolDefinitions(DEFAULT_CONFIG.tools)).includes('end_call'));
    });

    test('a missing or malformed tools column is treated as no tools, not as a failure', () => {
        setFlag(undefined);
        for (const value of [undefined, null, 'end_call']) {
            assert.deepEqual(names(buildToolDefinitions(value)), ['end_call']);
        }
    });

    test('configured tools keep their order and gain end_call at the end', () => {
        setFlag(undefined);
        assert.deepEqual(names(buildToolDefinitions(['get_current_time'])), ['get_current_time', 'end_call']);
    });

    test('a configuration that already names end_call does not get it twice', () => {
        setFlag(undefined);
        const offered = names(buildToolDefinitions(['end_call', 'get_current_time']));
        assert.deepEqual(offered, ['end_call', 'get_current_time']);
        assert.equal(offered.filter((name) => name === 'end_call').length, 1);
    });

    test('an unknown tool name is dropped without taking end_call with it', () => {
        setFlag(undefined);
        assert.deepEqual(names(buildToolDefinitions(['no_such_tool'])), ['end_call']);
    });

    test('the definition is the shape the Realtime API expects', () => {
        setFlag(undefined);
        const [definition] = buildToolDefinitions([]);
        assert.equal(definition.type, 'function');
        assert.equal(definition.name, 'end_call');
        assert.equal(typeof definition.description, 'string');
        assert.equal(definition.parameters.type, 'object');
    });
});

describe('the session actually carries the tool', () => {
    // buildToolDefinitions returning end_call is only useful if buildSessionUpdate
    // still sends it: the tools block is written behind a length check, so an
    // empty list previously meant neither key reached the model.
    test('session.update advertises end_call for a call with no configured tools', () => {
        setFlag(undefined);
        const session = buildSessionUpdate({ ...DEFAULT_CONFIG, tools: [] });
        assert.ok(Array.isArray(session.session.tools), 'tools must be sent');
        assert.ok(names(session.session.tools).includes('end_call'));
        assert.equal(session.session.tool_choice, 'auto');
    });
});

describe('the behaviour can be turned off', () => {
    test('ALWAYS_OFFER_END_CALL=false restores per-contact opt-in', () => {
        setFlag('false');
        assert.deepEqual(buildToolDefinitions([]), []);
        assert.deepEqual(names(buildToolDefinitions(['get_current_time'])), ['get_current_time']);
    });

    test('an explicit configuration still wins when the flag is off', () => {
        setFlag('false');
        assert.deepEqual(names(buildToolDefinitions(['end_call'])), ['end_call']);
    });

    test('the flag is off only for values that plainly mean off', () => {
        for (const value of ['false', 'FALSE', '0', 'off', 'no']) {
            setFlag(value);
            assert.deepEqual(buildToolDefinitions([]), [], `${value} should disable`);
        }
        for (const value of ['true', '1', 'on', '', 'yes']) {
            setFlag(value);
            assert.deepEqual(names(buildToolDefinitions([])), ['end_call'], `${value} should not disable`);
        }
    });

    test('ALWAYS_ON_TOOLS is exported so this list has one home', () => {
        assert.deepEqual(ALWAYS_ON_TOOLS, ['end_call']);
    });
});

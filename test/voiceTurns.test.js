import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceTurns } from '../voiceTurns.js';
import { applyHyperFlowVoiceContext } from '../hyperflowVoice.js';
import { DEFAULT_CONFIG } from '../config.js';

const speech = text => ({ type: 'message', role: 'assistant', content: [{ type: 'audio', transcript: text }] });
const call = (name = 'end_call', id = 'tool1') => ({ type: 'function_call', name, call_id: id, arguments: '{}' });
const done = (id, output, extra = {}) => ({ id, status: 'completed', output, ...extra });
function harness(run) {
    const sent = [], ended = [], executed = [];
    let epoch = 0;
    const turns = createVoiceTurns({
        runTool: async tool => { executed.push(tool.call_id); return run ? run(tool) : { name: tool.name, output: { reason: 'caller finished' } }; },
        sendResponse: (...args) => sent.push(args),
        endAfterPlayback: reason => ended.push(reason),
        generation: () => epoch,
    });
    return { turns, sent, ended, executed, interrupt() { epoch++; turns.interrupt(); } };
}
test('spoken goodbye plus end_call drains once without generating a duplicate', async () => {
    const h = harness();
    await h.turns.done(done('r1', [speech('Goodbye!'), call()]));
    assert.equal(h.sent.length, 0);
    assert.equal(h.ended.length, 1);
    await h.turns.done(done('r1', [speech('Goodbye!'), call()]));
    assert.equal(h.executed.length, 1);
    assert.equal(h.ended.length, 1);
});
test('silent end_call waits for its explicitly identified farewell response', async () => {
    const h = harness();
    await h.turns.done(done('r1', [call()]));
    assert.equal(h.ended.length, 0);
    assert.equal(h.sent.length, 1);
    const metadata = h.sent[0][0].metadata;
    await h.turns.done(done('unrelated', [speech('Other audio')]));
    assert.equal(h.ended.length, 0);
    await h.turns.done(done('farewell', [speech('Goodbye')], { metadata }));
    assert.equal(h.ended.length, 1);
    assert.equal(h.sent.length, 1);
});
test('multiple completed tools generate one continuation, with all results available', async () => {
    const h = harness();
    await h.turns.done(done('r1', [call('get_current_time', 't1'), call('select_hyperflow_project', 't2')]));
    assert.deepEqual(h.executed, ['t1', 't2']);
    assert.equal(h.sent.length, 1);
});
test('cancelled response cannot execute tools or end a call', async () => {
    const h = harness();
    await h.turns.done(done('r1', [call()], { status: 'cancelled' }));
    assert.equal(h.executed.length, 0);
    assert.equal(h.ended.length, 0);
});
test('caller interruption during tool lookup prevents a stale continuation', async () => {
    let resolve;
    const h = harness(() => new Promise(r => { resolve = r; }));
    const pending = h.turns.done(done('r1', [call('select_hyperflow_project')]));
    h.interrupt();
    resolve({ name: 'select_hyperflow_project', output: {} });
    await pending;
    assert.equal(h.sent.length, 0);
});
test('verified call state resumes once after an intervening caller response completes',async()=>{
    for(const completeToolFirst of [true,false]){
        let resolve; const h=harness(()=>new Promise(r=>{resolve=r;}));
        h.turns.responseCreated({id:'verify'});
        const pending=h.turns.done(done('verify',[call('hyperflow_briefing','verification')]));
        h.interrupt();h.turns.speechStopped();h.turns.responseCreated({id:'waiting'});
        if(completeToolFirst){resolve({name:'hyperflow_briefing',output:{status:'verified'},continueAfterInterruption:true});await pending;assert.equal(h.sent.length,0);}
        await h.turns.done(done('waiting',[speech('Still processing')]));
        if(!completeToolFirst){resolve({name:'hyperflow_briefing',output:{status:'verified'},continueAfterInterruption:true});await pending;}
        assert.equal(h.sent.length,1);
        await h.turns.done(done('waiting',[speech('duplicate')]));assert.equal(h.sent.length,1);
        assert.deepEqual(h.executed,['verification']);
    }
});
test('a caller request to end the call suppresses deferred verification continuation',async()=>{
    let resolve; const h=harness(tool=>tool.name==='hyperflow_briefing'?new Promise(r=>{resolve=r;}):{name:'end_call',output:{}});
    const pending=h.turns.done(done('verify',[call('hyperflow_briefing')]));
    h.interrupt();h.turns.speechStopped();h.turns.responseCreated({id:'end'});
    await h.turns.done(done('end',[speech('Goodbye'),call('end_call','end')]));
    resolve({name:'hyperflow_briefing',continueAfterInterruption:true});await pending;
    assert.equal(h.sent.length,0);assert.equal(h.ended.length,1);
});
test('interrupted farewell cannot hang up a resumed conversation', async () => {
    const h = harness();
    await h.turns.done(done('r1', [call()]));
    const metadata = h.sent[0][0].metadata;
    h.interrupt();
    await h.turns.done(done('farewell', [speech('Goodbye')], { metadata }));
    assert.equal(h.ended.length, 0);
});
test('failed or silent farewell is not mistaken for successful speech', async () => {
    for (const response of [done('f', []), done('f', [speech('Bye')], { status: 'failed' })]) {
        const h = harness();
        await h.turns.done(done('r1', [call()]));
        await h.turns.done({ ...response, metadata: h.sent[0][0].metadata });
        assert.equal(h.ended.length, 0);
    }
});
test('project selection replaces awaiting-project instructions and old facts', () => {
    const initial = applyHyperFlowVoiceContext(DEFAULT_CONFIG, { instructions: 'Ask the caller to select a project.', greeting: 'Which project?', routing: { kind: 'clarification' } });
    const selected = applyHyperFlowVoiceContext(initial, { instructions: 'The selected project is Alpha.', greeting: 'Hello', routing: { kind: 'routed', projectId: 'a' }, project: { context: { code: 'alpha-secret' } } });
    const switched = applyHyperFlowVoiceContext(selected, { instructions: 'The selected project is Beta.', greeting: 'Hello', routing: { kind: 'routed', projectId: 'b' }, project: { context: { code: 'beta-secret' } } });
    assert.doesNotMatch(selected.systemMessage, /Ask the caller to select a project|dad jokes|rickrolling/);
    assert.doesNotMatch(switched.systemMessage, /alpha-secret|selected project is Alpha/);
    assert.match(switched.systemMessage, /beta-secret/);
});

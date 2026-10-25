// One continuation per completed tool response. Never confuse the tool-calling
// response with the separate farewell, and never repeat an already spoken close.
export function createVoiceTurns({ runTool, sendResponse, endAfterPlayback, generation, log = () => {} }) {
    const seen = new Set();
    let farewell = null;
    const activeResponses = new Map();
    let callerSpeaking = false;
    let awaitingCallerResponse = false;
    let pendingContinuation = false;
    let closing = false;
    const resumePending = () => {
        if (!pendingContinuation || callerSpeaking || awaitingCallerResponse || activeResponses.size || closing) return;
        pendingContinuation = false;
        log('deferred_tool_continuation', {});
        sendResponse();
    };
    const hasSpeech = (response) => (response.output || []).some(item =>
        item.type === 'message' && item.role === 'assistant' &&
        (item.content || []).some(part => ['audio', 'output_audio'].includes(part.type) && part.transcript?.trim()));

    return {
        interrupt() { farewell = null; closing = false; callerSpeaking = true; awaitingCallerResponse = true; },
        speechStopped() { callerSpeaking = false; resumePending(); },
        responseCreated(response) { if(response?.id) activeResponses.set(response.id,generation()); },
        async done(response) {
            if (!response?.id || seen.has(response.id)) return;
            seen.add(response.id);
            const responseEpoch = activeResponses.get(response.id);
            activeResponses.delete(response.id);
            if(responseEpoch === generation()) awaitingCallerResponse = false;
            if (seen.size > 1000) seen.delete(seen.values().next().value);
            log('response_done', { responseId: response.id, status: response.status });
            if (farewell && response.metadata?.voice_farewell === farewell.token) {
                const pending = farewell;
                farewell = null;
                if (response.status === 'completed' && hasSpeech(response)) {
                    log('farewell_completed', { responseId: response.id });
                    endAfterPlayback(pending.reason);
                } else log('farewell_incomplete', { responseId: response.id });
                return;
            }
            if (response.status !== 'completed') { resumePending(); return; }
            const calls = (response.output || []).filter(item => item.type === 'function_call');
            if (!calls.length) { resumePending(); return; }
            const epoch = generation();
            const results = [];
            for (const call of calls) {
                if (epoch !== generation()) break;
                results.push(await runTool(call));
            }
            if (epoch !== generation()) {
                if(results.some(result=>result?.continueAfterInterruption)) pendingContinuation = true;
                resumePending();
                return;
            }
            const ending = results.find(result => result?.name === 'end_call' && !result.error);
            if (ending) {
                closing = true;
                pendingContinuation = false;
                const reason = `end_call — ${ending.output?.reason || 'conversation finished'}`;
                if (hasSpeech(response)) {
                    log('closing_speech_already_generated', { responseId: response.id });
                    endAfterPlayback(reason);
                } else {
                    farewell = { token: response.id, reason };
                    sendResponse({ metadata: { voice_farewell: response.id }, tool_choice: 'none' }, true);
                }
            } else { pendingContinuation = false; sendResponse(); }
        },
    };
}

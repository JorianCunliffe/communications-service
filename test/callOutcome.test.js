import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyCallOutcome, classifyCallTranscript, deterministicCallOutcome } from '../callOutcome.js';

const transcript = (...segments) => ({ segments });
const caller = (text) => ({ role: 'user', text });
const assistant = (text) => ({ role: 'assistant', text });

describe('call business outcomes', () => {
    test('summary and legacy memory writes are gated behind verified eligibility', () => {
        const summary = readFileSync(new URL('../summarise.js', import.meta.url), 'utf8');
        const migration = readFileSync(new URL('../migrations/008_call_outcomes.sql', import.meta.url), 'utf8');
        assert.match(summary, /business_status !== 'success'/);
        assert.match(summary, /memory_eligible !== true/);
        assert.match(migration, /combined_history=nullif/);
        assert.match(migration, /summary=null/);
    });

    test('the outcome migration is portable to the deployed thread schema', () => {
        const migration = readFileSync(new URL('../migrations/008_call_outcomes.sql', import.meta.url), 'utf8');
        assert.doesNotMatch(migration, /unnest\([^\n]+\)\s+source_id/);
        assert.doesNotMatch(migration, /outstanding_source_ids='\{\}',updated_at=now\(\)/);
        assert.match(migration, /as sources\(source_communication_id\)/);
    });

    test('provider failures are terminal failures without consulting a transcript', () => {
        for (const [providerStatus, disposition] of [
            ['busy', 'busy'], ['no-answer', 'no_answer'], ['failed', 'provider_failed'], ['canceled', 'canceled'],
        ]) {
            const outcome = deterministicCallOutcome({ providerStatus });
            assert.equal(outcome.disposition, disposition);
            assert.equal(outcome.successful, false);
            assert.equal(outcome.memoryEligible, false);
            assert.equal(outcome.source, 'provider');
        }
    });

    test('Twilio answering-machine and fax detection fail closed', () => {
        const voicemail = deterministicCallOutcome({ providerStatus: 'completed', answeredBy: 'machine_end_beep' });
        assert.equal(voicemail.disposition, 'voicemail');
        assert.equal(voicemail.memoryEligible, false);
        assert.equal(deterministicCallOutcome({ providerStatus: 'completed', answeredBy: 'fax' }).disposition, 'fax');
    });

    test('transcript rules reject voicemail, full mailbox, wrong number and automated systems', () => {
        const cases = [
            ['The message bank is full. Please try again later.', 'voicemail'],
            ['Please leave a message after the tone.', 'voicemail'],
            ["You've called the wrong number.", 'wrong_number'],
            ['This is an automated service. Press 1 for accounts.', 'automated_system'],
        ];
        for (const [speech, disposition] of cases) {
            const outcome = deterministicCallOutcome({ providerStatus: 'completed', transcript: transcript(caller(speech)) });
            assert.equal(outcome.disposition, disposition, speech);
            assert.equal(outcome.successful, false);
            assert.equal(outcome.memoryEligible, false);
        }
    });

    test('assistant speech cannot make a call successful and greetings alone fail', () => {
        assert.equal(deterministicCallOutcome({
            providerStatus: 'completed', transcript: transcript(assistant('Will you attend Wednesday?'), caller('Hello')),
        }).disposition, 'no_meaningful_response');
        assert.equal(deterministicCallOutcome({
            providerStatus: 'completed', transcript: transcript(assistant('Will you attend Wednesday?')),
        }), null, 'the worker waits for a late caller transcript before timing out');
    });

    test('meaningful human speech is classified with strict structured output', async () => {
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-test';
        let request;
        try {
            const outcome = await classifyCallTranscript(transcript(
                assistant('Will you attend Wednesday?'), caller('Yes, I will be there in the afternoon.'),
            ), {
                fetchImpl: async (_url, options) => {
                    request = JSON.parse(options.body);
                    return {
                        ok: true,
                        json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({
                            disposition: 'human_completed', confidence: 0.98,
                            reason: 'The intended human answered the question', evidence: 'Yes, I will be there in the afternoon.',
                        }) }] }] }),
                    };
                },
            });
            assert.equal(outcome.successful, true);
            assert.equal(outcome.memoryEligible, true);
            assert.equal(outcome.failureCode, null);
            assert.equal(request.store, false);
            assert.equal(request.text.format.strict, true);
            assert.match(request.input[0].content, /untrusted evidence/);
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });

    test('ambiguous completed calls are model-classified and model failures remain errors for durable retry', async () => {
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'sk-test';
        try {
            const call = { status: 'completed', transcript: transcript(caller('I can talk now.')) };
            await assert.rejects(() => classifyCallOutcome(call, {
                fetchImpl: async () => ({ ok: false, status: 503 }),
            }), /HTTP 503/);
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });
});

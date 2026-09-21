import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel } from '../operationalIntelligence.js';
import { normalizePromiseEvidence } from '../promiseLedger.js';

test('classification receives only authored evidence, not raw quoted/forwarded history', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test';
    try {
        const source = { channel: 'email', direction: 'inbound', body: 'Thanks.\n> I will send the invoice tomorrow.' };
        const current = normalizePromiseEvidence(source);
        let payload;
        await classifyModel({ communication: { ...source, body_text: source.body }, current, context: {} }, {
            fetchImpl: async (_url, options) => {
                payload = JSON.parse(options.body);
                return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: '{"items":[]}' }] }] }));
            },
        });
        const evidence = JSON.parse(payload.input[1].content);
        assert.equal(evidence.current.turns[0].text, 'Thanks.');
        assert.doesNotMatch(payload.input[1].content, /send the invoice/);
        assert.equal(evidence.communication.body, undefined);
        assert.equal(evidence.communication.body_text, undefined);
    } finally {
        if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    }
});

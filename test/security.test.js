import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signatureMode } from '../auth.js';
import { safeFetch } from '../safeFetch.js';
import { normaliseCorrelation } from '../communicationModel.js';

test('Twilio signatures default to enforce when credentials exist', () => {
    const previousToken = process.env.TWILIO_AUTH_TOKEN;
    const previousMode = process.env.TWILIO_VALIDATE_SIGNATURES;
    process.env.TWILIO_AUTH_TOKEN = 'configured';
    delete process.env.TWILIO_VALIDATE_SIGNATURES;
    try { assert.equal(signatureMode(), 'enforce'); }
    finally {
        if (previousToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = previousToken;
        if (previousMode === undefined) delete process.env.TWILIO_VALIDATE_SIGNATURES; else process.env.TWILIO_VALIDATE_SIGNATURES = previousMode;
    }
});

test('safe fetch validates redirect destinations before following them', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    };
    try {
        await assert.rejects(() => safeFetch('https://8.8.8.8/start'), /private or reserved range/);
        assert.equal(calls, 1);
    } finally { globalThis.fetch = originalFetch; }
});

test('workflow project IDs stay external correlation', () => {
    assert.deepEqual(normaliseCorrelation({ project_id: 'workflow-project' }), { external_project_id: 'workflow-project' });
});

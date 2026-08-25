import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signatureMode } from '../auth.js';
import { createSafeLookup, safeFetch } from '../safeFetch.js';
import { describeDeliveryError } from '../eventOutbox.js';
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

test('safe lookup returns every validated address when Undici requests all addresses', async () => {
    const entries = [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    let resolverOptions;
    const resolver = async (_hostname, options) => {
        resolverOptions = options;
        return entries;
    };
    const result = await new Promise((resolve, reject) => {
        createSafeLookup(resolver)('example.com', { all: true, hints: 32 }, (error, addresses) => {
            if (error) reject(error); else resolve(addresses);
        });
    });

    assert.deepEqual(result, entries);
    assert.deepEqual(resolverOptions, { all: true, hints: 32 });
});

test('safe lookup preserves the single-address callback contract', async () => {
    const entry = { address: '93.184.216.34', family: 4 };
    const result = await new Promise((resolve, reject) => {
        createSafeLookup(async () => [entry])('example.com', { all: false }, (error, address, family) => {
            if (error) reject(error); else resolve({ address, family });
        });
    });

    assert.deepEqual(result, entry);
});

test('outbox diagnostics retain the native fetch failure cause', () => {
    const error = new TypeError('fetch failed', {
        cause: Object.assign(new TypeError('Invalid IP address: undefined'), { code: 'ERR_INVALID_IP_ADDRESS' }),
    });
    assert.equal(
        describeDeliveryError(error),
        'fetch failed (ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined)',
    );
});

test('workflow project IDs stay external correlation', () => {
    assert.deepEqual(normaliseCorrelation({ project_id: 'workflow-project' }), { external_project_id: 'workflow-project' });
});

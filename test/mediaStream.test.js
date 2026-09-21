import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import twilio from 'twilio';
import { storeCallConfig, takeCallConfig, peekCallConfig } from '../configResolver.js';

let child, base, output = '';
const token = 'isolated-twilio-token';
before(async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['index.js'], {
        cwd: new URL('../', import.meta.url),
        env: { PATH: process.env.PATH, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null',
            PORT: String(port), OPENAI_API_KEY: 'test-no-provider-access', PERSISTENCE_PROVIDER: 'none',
            TWILIO_AUTH_TOKEN: token, PUBLIC_URL: base, TWILIO_VALIDATE_SIGNATURES: 'off' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
        if (child.exitCode !== null) throw new Error(output);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Server did not start: ${output}`);
}, { timeout: 15000 });
after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
});

function probe({ signature, event } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/media-stream', {
            headers: signature ? { 'x-twilio-signature': signature } : {},
        });
        let opened = false;
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('Stream was not refused')); }, 3000);
        ws.on('open', () => { opened = true; if (event) ws.send(JSON.stringify(event)); });
        ws.on('unexpected-response', (_request, response) => {
            clearTimeout(timer); response.resume(); ws.terminate(); resolve({ status: response.statusCode, opened });
        });
        ws.on('close', code => { clearTimeout(timer); if (opened) resolve({ code, opened }); });
        ws.on('error', () => {});
    });
}
test('unsigned media upgrades fail even when HTTP signature mode is off', async () => {
    assert.deepEqual(await probe(), { status: 403, opened: false });
});
test('forged media signature is refused before upgrading', async () => {
    assert.deepEqual(await probe({ signature: 'forged' }), { status: 403, opened: false });
});
for (const suffix of ['', '/']) {
    test(`signed handshake${suffix ? ' with documented trailing slash' : ''} cannot start an unknown call`, async () => {
        const signature = twilio.getExpectedTwilioSignature(token, `${base}/media-stream${suffix}`, {});
        const result = await probe({ signature, event: { event: 'start', start: {
            callSid: `CA${'1'.repeat(32)}`, streamSid: `MZ${'2'.repeat(32)}`,
        } } });
        assert.deepEqual(result, { opened: true, code: 1008 });
        assert.doesNotMatch(output, /Connected to the OpenAI|session.created/);
    });
}
test('signed malformed start is refused', async () => {
    const signature = twilio.getExpectedTwilioSignature(token, `${base}/media-stream`, {});
    assert.deepEqual(await probe({ signature, event: { event: 'start', start: {} } }), { opened: true, code: 1008 });
});
test('approved call configuration can be claimed once, and expired entries are never returned', () => {
    const sid = `CA${'3'.repeat(32)}`;
    const config = { tenantId: 'test-tenant', model: 'test' };
    storeCallConfig(sid, config);
    assert.equal(peekCallConfig(sid), config);
    assert.equal(takeCallConfig(sid), config);
    assert.equal(takeCallConfig(sid), null);
    storeCallConfig(sid, config);
    const original = Date.now;
    const now = original();
    Date.now = () => now + 3600001;
    try { assert.equal(peekCallConfig(sid), null); assert.equal(takeCallConfig(sid), null); }
    finally { Date.now = original; }
});

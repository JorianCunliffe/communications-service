/**
 * Comprehensive test suite for the Twilio + OpenAI Realtime Voice Assistant.
 *
 * Run against a live server: node --test --test-reporter=spec test/suite.test.js
 * The server must be running on PORT (default 3000) before tests execute.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/** Wrap a WebSocket interaction in a Promise with a timeout. */
function wsPromise(url, wsOptions, handler, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, wsOptions);
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error(`WebSocket timed out after ${timeoutMs}ms (${url})`));
        }, timeoutMs);

        const done = (err) => {
            clearTimeout(timer);
            try { ws.terminate(); } catch (_) {}
            err ? reject(err) : resolve();
        };

        ws.on('error', (err) => done(new Error(`WebSocket error: ${err.message}`)));
        handler(ws, done);
    });
}

// ---------------------------------------------------------------------------
// 1. HTTP: Server health
// ---------------------------------------------------------------------------
describe('HTTP – server health', () => {
    test('GET / responds 200 with status message', async () => {
        const res = await fetch(`${BASE_URL}/`);
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
        const body = await res.json();
        assert.equal(
            body.message,
            'Twilio Media Stream Server is running!',
            'Unexpected status message'
        );
    });
});

// ---------------------------------------------------------------------------
// 2. HTTP: /incoming-call (TwiML)
// ---------------------------------------------------------------------------
describe('HTTP – /incoming-call TwiML', () => {
    test('POST /incoming-call returns 200 with XML content-type', async () => {
        const res = await fetch(`${BASE_URL}/incoming-call`, { method: 'POST' });
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
        const ct = res.headers.get('content-type') || '';
        assert.ok(ct.includes('xml'), `Expected XML content-type, got: ${ct}`);
    });

    test('GET /incoming-call also returns TwiML (Twilio uses both methods)', async () => {
        const res = await fetch(`${BASE_URL}/incoming-call`, { method: 'GET' });
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    });

    test('TwiML response contains required XML elements', async () => {
        const res = await fetch(`${BASE_URL}/incoming-call`, { method: 'POST' });
        const text = await res.text();

        assert.ok(text.includes('<?xml'), 'Missing XML declaration');
        assert.ok(text.includes('<Response>'), 'Missing <Response> root element');
        assert.ok(text.includes('<Connect>'), 'Missing <Connect> element');
        assert.ok(text.includes('<Stream'), 'Missing <Stream> element');
    });

    test('TwiML <Stream> URL points to /media-stream WebSocket endpoint', async () => {
        const res = await fetch(`${BASE_URL}/incoming-call`, {
            method: 'POST',
            headers: { host: `localhost:${PORT}` },
        });
        const text = await res.text();
        assert.ok(
            text.includes('/media-stream'),
            `<Stream> URL should contain /media-stream.\nGot TwiML:\n${text}`
        );
        assert.ok(
            text.includes('wss://'),
            '<Stream> URL should use wss:// (secure WebSocket required by Twilio)'
        );
    });
});

// ---------------------------------------------------------------------------
// 3. WebSocket: /media-stream connection
// ---------------------------------------------------------------------------
describe('WebSocket – /media-stream', () => {
    test('WebSocket connection to /media-stream opens successfully', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    assert.equal(ws.readyState, WebSocket.OPEN, 'readyState should be OPEN');
                    done();
                });
            }
        )
    );

    test('Server stays open after receiving Twilio "start" event', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    ws.send(JSON.stringify({
                        event: 'start',
                        start: { streamSid: 'test-stream-sid-001' },
                    }));

                    // Give the server 500 ms to process; if it crashes it closes the socket.
                    setTimeout(() => {
                        assert.equal(
                            ws.readyState,
                            WebSocket.OPEN,
                            'Connection should remain open after start event'
                        );
                        done();
                    }, 500);
                });

                ws.on('close', (code) => {
                    if (code !== 1000 && code !== 1005 && code !== undefined) {
                        done(new Error(`Server closed unexpectedly with code ${code}`));
                    }
                });
            }
        )
    );

    test('Server stays open after receiving Twilio "media" event', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    // First send start, then media (mirrors real Twilio sequence)
                    ws.send(JSON.stringify({
                        event: 'start',
                        start: { streamSid: 'test-stream-sid-002' },
                    }));

                    // Minimal mu-law audio payload (base64 of a few silent bytes)
                    const silentAudio = Buffer.alloc(160).toString('base64');
                    ws.send(JSON.stringify({
                        event: 'media',
                        media: {
                            timestamp: 20,
                            payload: silentAudio,
                        },
                    }));

                    setTimeout(() => {
                        assert.equal(
                            ws.readyState,
                            WebSocket.OPEN,
                            'Connection should remain open after media event'
                        );
                        done();
                    }, 500);
                });

                ws.on('close', (code) => {
                    if (code !== 1000 && code !== 1005 && code !== undefined) {
                        done(new Error(`Server closed unexpectedly with code ${code}`));
                    }
                });
            }
        )
    );

    test('Server handles Twilio "mark" event without error', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    ws.send(JSON.stringify({ event: 'mark', mark: { name: 'responsePart' } }));

                    setTimeout(() => {
                        assert.equal(
                            ws.readyState,
                            WebSocket.OPEN,
                            'Connection should remain open after mark event'
                        );
                        done();
                    }, 300);
                });
            }
        )
    );

    test('Server handles unknown event types without crashing', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    ws.send(JSON.stringify({ event: 'unknown_event_type', data: {} }));

                    setTimeout(() => {
                        assert.equal(
                            ws.readyState,
                            WebSocket.OPEN,
                            'Server should survive unknown event types'
                        );
                        done();
                    }, 300);
                });
            }
        )
    );

    test('Server handles malformed JSON without crashing', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    ws.send('this is not valid JSON {{{');

                    setTimeout(() => {
                        assert.equal(
                            ws.readyState,
                            WebSocket.OPEN,
                            'Server should survive malformed JSON messages'
                        );
                        done();
                    }, 300);
                });
            }
        )
    );
});

// ---------------------------------------------------------------------------
// 4. OpenAI Realtime API: direct connectivity
// ---------------------------------------------------------------------------
describe('OpenAI Realtime API – connectivity', () => {
    test('OPENAI_API_KEY environment variable is set', () => {
        assert.ok(OPENAI_API_KEY, 'OPENAI_API_KEY is not set — add it to Replit Secrets');
        assert.ok(
            OPENAI_API_KEY.startsWith('sk-'),
            `API key has unexpected format (should start with "sk-")`
        );
    });

    test('OpenAI Realtime API WebSocket connects and emits session.created', { timeout: 15000 }, () => {
        assert.ok(OPENAI_API_KEY, 'Skipping: OPENAI_API_KEY not set');

        return wsPromise(
            `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
            { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
            (ws, done) => {
                ws.on('open', () => {
                    // Connection opened — now wait for session.created
                });

                ws.on('message', (raw) => {
                    let msg;
                    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

                    if (msg.type === 'session.created') {
                        assert.ok(msg.session, 'session.created should include a session object');
                        assert.ok(msg.session.id, 'Session should have an id');
                        done(); // success
                    } else if (msg.type === 'error') {
                        done(new Error(
                            `OpenAI returned error: ${msg.error?.code} – ${msg.error?.message}`
                        ));
                    }
                });
            },
            12000
        );
    });

    test('OpenAI Realtime API accepts a session.update configuration', { timeout: 15000 }, () => {
        assert.ok(OPENAI_API_KEY, 'Skipping: OPENAI_API_KEY not set');

        return wsPromise(
            `wss://api.openai.com/v1/realtime?model=gpt-realtime`,
            { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } },
            (ws, done) => {
                let sessionCreated = false;

                ws.on('message', (raw) => {
                    let msg;
                    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

                    if (msg.type === 'session.created' && !sessionCreated) {
                        sessionCreated = true;

                        // Mirror the exact session.update the app sends
                        ws.send(JSON.stringify({
                            type: 'session.update',
                            session: {
                                type: 'realtime',
                                model: 'gpt-realtime',
                                output_modalities: ['audio'],
                                audio: {
                                    input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
                                    output: { format: { type: 'audio/pcmu' }, voice: 'alloy' },
                                },
                                instructions: 'You are a helpful assistant.',
                            },
                        }));
                    }

                    if (msg.type === 'session.updated') {
                        assert.ok(msg.session, 'session.updated should include updated session');
                        done();
                    }

                    if (msg.type === 'error') {
                        done(new Error(
                            `OpenAI error after session.update: ${msg.error?.code} – ${msg.error?.message}`
                        ));
                    }
                });
            },
            12000
        );
    });
});

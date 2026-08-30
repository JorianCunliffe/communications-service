/**
 * Comprehensive integration suite for Communications Service voice support.
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
            'Communications Service is running!',
            'Unexpected status message'
        );
    });
});

// Fetches a Twilio webhook the way Twilio would, signing the request when the
// credentials to do so are available. Without this the whole TwiML section
// fails against a server running TWILIO_VALIDATE_SIGNATURES=enforce — which is
// the mode this is all eventually meant to run in, so the suite has to be able
// to pass there. Unsigned rejection is asserted deliberately further down
// rather than falling out of every other test.
async function twilioFetch(path, { method = 'POST', params = {}, headers = {} } = {}) {
    const token = process.env.TWILIO_AUTH_TOKEN;
    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

    const query = method === 'GET' && Object.keys(params).length > 0
        ? `?${new URLSearchParams(params)}`
        : '';
    const signed = { ...headers };

    if (token && base) {
        // Signed against PUBLIC_URL — what Twilio signs — not the localhost
        // address the request is actually sent to.
        const { default: twilio } = await import('twilio');
        signed['X-Twilio-Signature'] = twilio.getExpectedTwilioSignature(
            token,
            `${base}${path}${query}`,
            method === 'GET' ? {} : params
        );
    }

    if (method === 'GET') return fetch(`${BASE_URL}${path}${query}`, { method, headers: signed });

    return fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...signed },
        body: new URLSearchParams(params),
    });
}

// ---------------------------------------------------------------------------
// 2. HTTP: /incoming-call (TwiML)
// ---------------------------------------------------------------------------
describe('HTTP – /incoming-call TwiML', () => {
    test('POST /incoming-call returns 200 with XML content-type', async () => {
        const res = await twilioFetch('/incoming-call');
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
        const ct = res.headers.get('content-type') || '';
        assert.ok(ct.includes('xml'), `Expected XML content-type, got: ${ct}`);
    });

    test('GET /incoming-call also returns TwiML (Twilio uses both methods)', async () => {
        const res = await twilioFetch('/incoming-call', { method: 'GET' });
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    });

    test('TwiML response contains required XML elements', async () => {
        const res = await twilioFetch('/incoming-call');
        const text = await res.text();

        assert.ok(text.includes('<?xml'), 'Missing XML declaration');
        assert.ok(text.includes('<Response>'), 'Missing <Response> root element');
        assert.ok(text.includes('<Connect>'), 'Missing <Connect> element');
        assert.ok(text.includes('<Stream'), 'Missing <Stream> element');
    });

    test('TwiML <Stream> URL points to /media-stream WebSocket endpoint', async () => {
        const res = await twilioFetch('/incoming-call', { headers: { host: `localhost:${PORT}` } });
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

    // Uses Twilio's documented start payload rather than a minimal stub: the
    // per-call config is looked up by start.callSid, so that field's presence
    // and position is load-bearing.
    // https://www.twilio.com/docs/voice/media-streams/websocket-messages
    test('Server stays open when "start" carries a callSid with no stored config (default fallback)', () =>
        wsPromise(
            `${WS_BASE}/media-stream`,
            {},
            (ws, done) => {
                ws.on('open', () => {
                    // Twilio always sends 'connected' before 'start'.
                    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));

                    ws.send(JSON.stringify({
                        event: 'start',
                        sequenceNumber: '1',
                        streamSid: 'MZtest0000000000000000000000004',
                        start: {
                            accountSid: 'ACtest0000000000000000000000004',
                            streamSid: 'MZtest0000000000000000000000004',
                            callSid: 'CAtest00000000000000000000000004',
                            tracks: ['inbound'],
                            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
                            customParameters: {},
                        },
                    }));

                    setTimeout(() => {
                        assert.equal(
                            ws.readyState,
                            WebSocket.OPEN,
                            'Connection should remain open when callSid has no stored config'
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
// 4. HTTP: /outbound-call guard rails
//
// These assert only that the endpoint refuses bad input — no call is placed.
// ---------------------------------------------------------------------------
describe('HTTP – /outbound-call guard rails', () => {
    const validBody = { to: '+15551230000', from: '+15551239999' };

    const postOutbound = (body, headers = {}) =>
        fetch(`${BASE_URL}/outbound-call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });

    test('rejects a request with no API key', async () => {
        const res = await postOutbound(validBody);
        assert.ok(
            res.status === 401 || res.status === 503,
            `Expected 401 (key set) or 503 (outbound not configured), got ${res.status}`
        );
    });

    test('rejects an incorrect API key', async () => {
        const res = await postOutbound(validBody, { 'x-api-key': 'definitely-not-the-key' });
        assert.ok(
            res.status === 401 || res.status === 503,
            `Expected 401 or 503, got ${res.status}`
        );
    });

    test('never places a call for an unauthenticated request', async () => {
        const res = await postOutbound(validBody, { 'x-api-key': 'definitely-not-the-key' });
        assert.notEqual(res.status, 201, 'Unauthenticated request must not create a call');
    });
});

// ---------------------------------------------------------------------------
// 5. HTTP: /health
// ---------------------------------------------------------------------------
describe('HTTP – /health', () => {
    test('GET /health reports status and feature wiring', async () => {
        const res = await fetch(`${BASE_URL}/health`);
        assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

        const body = await res.json();
        assert.equal(body.status, 'ok');
        assert.ok(body.persistenceProvider === null || ['supabase', 'postgres'].includes(body.persistenceProvider));
        assert.equal(typeof body.supabaseConfig, 'boolean', 'supabaseConfig should be a boolean');
        assert.equal(typeof body.postgresPersistence, 'boolean', 'postgresPersistence should be a boolean');
        assert.equal(typeof body.outboundCalls, 'boolean', 'outboundCalls should be a boolean');
    });
});

// ---------------------------------------------------------------------------
// 6. OpenAI Realtime API: direct connectivity
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

// ---------------------------------------------------------------------------
// 7. HTTP: management API (read paths)
// ---------------------------------------------------------------------------
//
// Everything here is read-only, so these run against the live database without
// changing it. The database-backed routes assert on shape rather than content:
// which contacts exist is not something the app guarantees, but the envelope,
// the paging fields and the status codes are.
//
// API_KEY is required. Without it the routes correctly return 503, which is not
// worth asserting on every run, so those tests skip instead.
const API_KEY = process.env.API_KEY;
const keyed = { headers: { 'X-API-Key': API_KEY || '' } };

describe('HTTP – management API auth', () => {
    test('rejects a request with no API key', async () => {
        const res = await fetch(`${BASE_URL}/api/tools`);
        assert.equal(res.status, 401, 'Unauthenticated reads must be rejected');
    });

    test('rejects an incorrect API key', async () => {
        const res = await fetch(`${BASE_URL}/api/tools`, { headers: { 'X-API-Key': 'nope' } });
        assert.equal(res.status, 401);
    });

    test('a key of the wrong length is rejected, not compared', async () => {
        // timingSafeEqual throws on mismatched lengths, so if the length check
        // is ever dropped this becomes a 500 rather than a 401.
        const res = await fetch(`${BASE_URL}/api/tools`, { headers: { 'X-API-Key': 'x' } });
        assert.equal(res.status, 401);
    });
});

describe('HTTP – management API tool registry', () => {
    test('GET /api/tools lists every tool with its availability', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/tools`, keyed);
        assert.equal(res.status, 200);
        const { data } = await res.json();

        assert.ok(Array.isArray(data) && data.length > 0, 'Expected at least one tool');
        for (const tool of data) {
            assert.ok(tool.name, 'Every tool needs a name');
            assert.ok(['builtin', 'http'].includes(tool.type), `Unexpected tool type ${tool.type}`);
            assert.equal(typeof tool.available, 'boolean');
            assert.ok(tool.parameters, 'Parameter schema must be exposed - it is what the model is asked for');
        }

        // An http tool must say which variable configures it, so an operator
        // seeing available:false knows what to set.
        for (const tool of data.filter((entry) => entry.type === 'http')) {
            assert.ok(tool.urlEnv, `${tool.name} must name its URL variable`);
        }
    });

    test('GET /api/tools/:name 404s on an unknown tool and says what is valid', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/tools/definitely_not_a_tool`, keyed);
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.ok(Array.isArray(body.valid) && body.valid.length > 0, 'A 404 must list the valid names');
    });

    test('GET /api/tools/names is not shadowed by the :name route', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/tools/names`, keyed);
        assert.equal(res.status, 200, 'The static route must win over the parametric one');
        const { data } = await res.json();
        assert.ok(Array.isArray(data));
    });
});

describe('HTTP – management API reads', () => {
    test('GET /api/contacts returns a paged envelope', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/contacts?limit=2`, keyed);
        // 503 means Supabase is off in this environment - a valid state for the
        // app, but nothing to assert a shape against.
        if (res.status === 503) return t.skip('Supabase not configured');

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(Array.isArray(body.data));
        assert.ok(body.data.length <= 2, 'limit must be honoured');
        assert.equal(body.limit, 2);
        assert.equal(body.offset, 0);
    });

    test('an over-large limit is clamped rather than refused', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/contacts?limit=99999`, keyed);
        if (res.status === 503) return t.skip('Supabase not configured');

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.limit <= 200, `Expected the limit to be clamped, got ${body.limit}`);
    });

    test('a non-E.164 path is a 400, not a 404', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        // A 404 would send someone hunting for a missing row instead of a typo.
        const res = await fetch(`${BASE_URL}/api/contacts/notaphonenumber`, keyed);
        assert.equal(res.status, 400);
    });

    test('an unknown but valid number is a 404', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/contacts/+19999999999`, keyed);
        if (res.status === 503) return t.skip('Supabase not configured');
        assert.equal(res.status, 404);
    });

    test('GET /api/calls accepts only known sort columns', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/calls?limit=1&sort=drop_table`, keyed);
        if (res.status === 503) return t.skip('Supabase not configured');

        assert.equal(res.status, 200, 'An unknown sort must fall back, not error');
        const body = await res.json();
        assert.equal(body.sort, 'started_at');
    });
});

describe('HTTP – management API config preview', () => {
    test('GET /api/config/resolve rejects a bad direction', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/config/resolve?from=%2B19999999999&direction=sideways`, keyed);
        assert.equal(res.status, 400);
    });

    test('GET /api/config/resolve requires at least one number', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/config/resolve`, keyed);
        assert.equal(res.status, 400);
    });

    test('GET /api/config/resolve returns a complete config and a tool audit', async (t) => {
        if (!API_KEY) return t.skip('API_KEY not set');

        const res = await fetch(`${BASE_URL}/api/config/resolve?from=%2B19999999999&to=%2B19999999998&direction=inbound`, keyed);
        assert.equal(res.status, 200);
        const body = await res.json();

        // Unknown numbers resolve to the app defaults rather than failing - the
        // same fallback the call path depends on.
        for (const field of ['model', 'voice', 'systemMessage', 'tools']) {
            assert.ok(field in body.config, `Resolved config is missing ${field}`);
        }
        assert.ok(Array.isArray(body.toolAudit));

        // Placeholders must already be substituted: returning {{name}} here
        // would misrepresent what the caller would actually hear.
        assert.ok(!/\{\{\w+\}\}/.test(body.config.systemMessage), 'Placeholders must be resolved');
    });
});

// ---------------------------------------------------------------------------
// 8. HTTP: Twilio webhook signatures
// ---------------------------------------------------------------------------
//
// The mode is a deploy-time setting, so these assert the contract that holds
// under whichever mode the server is running rather than forcing one. That is
// the useful thing to pin down: 'warn' must not reject real traffic, and
// 'enforce' must not accept forged traffic.
import twilio from 'twilio';

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

async function signatureModeFromHealth() {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    return body.twilioSignatures;
}

describe('HTTP – Twilio webhook signatures', () => {
    test('GET /health reports the signature mode', async () => {
        const mode = await signatureModeFromHealth();
        assert.ok(['off', 'warn', 'enforce'].includes(mode), `Unexpected signature mode ${mode}`);
    });

    test('an unsigned webhook is rejected under enforce and otherwise reaches tenant resolution', async () => {
        const mode = await signatureModeFromHealth();
        const res = await fetch(`${BASE_URL}/incoming-call`, { method: 'POST' });

        if (mode === 'enforce') {
            assert.equal(res.status, 403, 'Enforcing means an unsigned request must not reach the handler');
            const text = await res.text();
            // A forged request should learn nothing about why it failed.
            assert.equal(text.trim(), '', 'The rejection body must not explain itself');
        } else {
            assert.equal(res.status, 503, 'Warn and off reach the handler, which then fails closed without a trusted dialled-number tenant');
        }
    });

    test('a correctly signed webhook is accepted under every mode', async (t) => {
        if (!TWILIO_AUTH_TOKEN || !PUBLIC_URL) return t.skip('TWILIO_AUTH_TOKEN or PUBLIC_URL not set');

        // Signed against PUBLIC_URL, which is what Twilio signs — not the
        // localhost address the request is actually sent to. If this passes,
        // the server is reconstructing the signed URL the same way Twilio did,
        // which is the part that breaks behind a proxy.
        const params = { CallSid: 'CAtestsignature', From: '+15005550006', To: '+15005550006' };
        const signature = twilio.getExpectedTwilioSignature(
            TWILIO_AUTH_TOKEN,
            `${PUBLIC_URL.replace(/\/$/, '')}/call-status`,
            params
        );

        const res = await fetch(`${BASE_URL}/call-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Twilio-Signature': signature,
            },
            body: new URLSearchParams(params),
        });

        // /call-status answers 204 and updates nothing for a CallSid it has
        // never seen, so this is safe to run against the live database.
        assert.equal(res.status, 204, 'A genuinely signed webhook must be accepted');
    });

    test('a tampered body fails the signature under enforce', async (t) => {
        if (!TWILIO_AUTH_TOKEN || !PUBLIC_URL) return t.skip('TWILIO_AUTH_TOKEN or PUBLIC_URL not set');
        const mode = await signatureModeFromHealth();
        if (mode !== 'enforce') return t.skip(`Mode is "${mode}" — nothing is rejected`);

        const signed = { CallSid: 'CAtestsignature', CallStatus: 'completed' };
        const signature = twilio.getExpectedTwilioSignature(
            TWILIO_AUTH_TOKEN,
            `${PUBLIC_URL.replace(/\/$/, '')}/call-status`,
            signed
        );

        const res = await fetch(`${BASE_URL}/call-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Twilio-Signature': signature,
            },
            // Same signature, different payload.
            body: new URLSearchParams({ ...signed, CallStatus: 'failed' }),
        });

        assert.equal(res.status, 403);
    });
});

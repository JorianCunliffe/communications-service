import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, buildRealtimeUrl, buildSessionUpdate, buildTwiml } from './config.js';
import { resolveConfig, storeCallConfig, takeCallConfig, peekCallConfig, warmUp, warnIfSuppressed, ensureContact } from './configResolver.js';
import { recordCall, updateCallStatus, recordToolCall } from './callLog.js';
import { recordMessage } from './smsLog.js';
import { executeTool } from './tools.js';
import { E164, isAuthorized, rejectUnsignedTwilio, signatureMode } from './auth.js';
import apiRoutes from './api.js';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// The management API. Every route under /api requires the shared key and reads
// only — see api.js.
fastify.register(apiRoutes, { prefix: '/api' });

// Constants (per-call tunables live in config.js)
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// The commit this process is running, so a deployment can be identified without
// guessing. Resolved once at boot; deployments without a .git directory fall
// back to the package version.
const VERSION = (() => {
    try {
        return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch (_) {
        try {
            return `v${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version}`;
        } catch (__) {
            return 'unknown';
        }
    }
})();

// A fingerprint of the code actually running, for hosts where VERSION cannot
// identify it. Replit deployments carry no .git, so `git rev-parse` fails there
// and VERSION falls back to the package version — which is identical across
// every commit, making "is my change deployed?" unanswerable. Hashing the
// source needs no git, works on any host, and changes exactly when the code
// does. Files are hashed by name as well as content so a rename still moves it.
const BUILD = (() => {
    const SOURCES = [
        'index.js', 'config.js', 'configResolver.js', 'callLog.js', 'smsLog.js',
        'tools.js', 'auth.js', 'api.js', 'transcripts.js',
        'console.html', 'home.html', 'package.json',
    ];

    try {
        const hash = createHash('sha256');
        for (const file of SOURCES) {
            hash.update(file);
            try {
                // Line endings are normalised out. A Windows checkout stores
                // CRLF and a Linux deployment stores LF, so hashing raw bytes
                // made the same commit fingerprint differently on each host —
                // which defeated the point of comparing local to deployed.
                hash.update(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
            } catch (_) {
                // A missing file is itself part of the fingerprint.
                hash.update('<missing>');
            }
        }
        return hash.digest('hex').slice(0, 12);
    } catch (error) {
        console.warn(`Could not fingerprint source: ${error.message}`);
        return 'unknown';
    }
})();

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Static pages, read once at boot. Served from this app so their buttons are
// same-origin and can reach the API directly. They hold no secrets: the API key
// is entered by the operator and kept in their browser.
function loadPage(file) {
    try {
        return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    } catch (error) {
        console.warn(`${file} unavailable: ${error.message}`);
        return null;
    }
}

const HOME_HTML = loadPage('home.html');
const CONSOLE_HTML = loadPage('console.html');

// Root Route. A browser gets a landing page pointing at the console; everything
// else — curl, uptime checks, the test suite — keeps the original JSON.
fastify.get('/', async (request, reply) => {
    if (HOME_HTML && (request.headers.accept || '').includes('text/html')) {
        return reply.type('text/html').send(HOME_HTML);
    }
    reply.send({ message: 'Twilio Media Stream Server is running!', console: '/console' });
});

fastify.get('/console', async (request, reply) => {
    if (!CONSOLE_HTML) return reply.code(404).send({ error: 'Test console not available' });
    reply.type('text/html').send(CONSOLE_HTML);
});

// Health check: reports which optional features are wired up.
fastify.get('/health', async (request, reply) => {
    reply.send({
        status: 'ok',
        version: VERSION,
        build: BUILD,
        model: DEFAULT_CONFIG.model,
        playIntro: DEFAULT_CONFIG.playIntro,
        supabaseConfig: process.env.SUPABASE_CONFIG_ENABLED === 'true',
        outboundCalls: Boolean(process.env.API_KEY && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.PUBLIC_URL),
        // 'warn' means signatures are being checked and logged but nothing is
        // rejected yet — worth being able to see without reading the logs.
        twilioSignatures: signatureMode(),
    });
});

// Route options for the webhooks Twilio calls. They cannot present an API key,
// so they are verified by Twilio's own signature instead — see auth.js for why
// this defaults to logging rather than rejecting.
const twilioWebhook = {
    preHandler: async (request, reply) => {
        const rejected = rejectUnsignedTwilio(request, reply);
        if (rejected) return rejected;
    },
};

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', twilioWebhook, async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const config = await resolveConfig({ from: params.From, to: params.To, direction: 'inbound' });
    storeCallConfig(params.CallSid, config);
    console.log(`Incoming call ${params.CallSid || '(no CallSid)'} from ${params.From || 'unknown'} to ${params.To || 'unknown'}`);

    // Same record an outbound call gets, so both directions are inspectable.
    // Not awaited: a slow database write must not delay answering the call.
    // 'ringing' rather than 'initiated' — Twilio only fetches this once the
    // call is already coming in. /call-status carries it the rest of the way,
    // which needs the number's status callback pointed at this app.
    recordCall({
        callSid: params.CallSid,
        otherParty: params.From,
        direction: 'inbound',
        config,
        status: 'ringing',
        metadata: { to: params.To },
    });

    reply.type('text/xml').send(buildTwiml(config, request.headers.host));
});

// --- Outbound calls --------------------------------------------------------

// Fields a caller of /outbound-call may override per request.
const OVERRIDABLE_FIELDS = [
    'model', 'effort', 'voice', 'temperature', 'systemMessage',
    'introMessage', 'introMessage2', 'introVoice', 'greetingText', 'aiSpeaksFirst',
];

// E164 and isAuthorized now live in auth.js, so the management API enforces
// the same key with the same constant-time comparison.

fastify.post('/outbound-call', async (request, reply) => {
    if (!process.env.API_KEY) {
        console.warn('Rejected /outbound-call: API_KEY is not configured');
        return reply.code(503).send({ error: 'Outbound calling is not configured' });
    }
    if (!isAuthorized(request)) {
        return reply.code(401).send({ error: 'Invalid or missing X-API-Key' });
    }

    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_URL } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_URL) {
        console.error('Outbound call rejected: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or PUBLIC_URL is missing');
        return reply.code(503).send({ error: 'Outbound calling is not configured' });
    }

    const { to, from, overrides } = request.body || {};
    if (!E164.test(to || '')) return reply.code(400).send({ error: '"to" must be an E.164 number, e.g. +447700900123' });
    if (!E164.test(from || '')) return reply.code(400).send({ error: '"from" must be an E.164 number you own on Twilio' });

    if (overrides && typeof overrides === 'object') {
        const unknown = Object.keys(overrides).filter((key) => !OVERRIDABLE_FIELDS.includes(key));
        if (unknown.length > 0) {
            return reply.code(400).send({ error: `Unknown override field(s): ${unknown.join(', ')}` });
        }
    }

    // Line settings come from the number we call from; the person's own
    // settings and name come from the number we are calling.
    const resolved = await resolveConfig({ from, to, direction: 'outbound' });
    const config = { ...resolved, ...(overrides || {}) };

    // The callee gets a contact record so history attaches, and a note in the
    // log if they are marked do_not_contact. Neither blocks the call.
    ensureContact(to);
    warnIfSuppressed(to, 'outbound call');

    try {
        const base = PUBLIC_URL.replace(/\/$/, '');
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const call = await client.calls.create({
            to,
            from,
            url: `${base}/outbound-answer`,
            // Without this we never learn whether the callee answered, was busy,
            // or let it ring out — the call is otherwise fire-and-forget.
            statusCallback: `${base}/call-status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST',
        });

        // The media stream finds this via the same CallSid on its 'start' event.
        storeCallConfig(call.sid, config);
        console.log(`Outbound call ${call.sid} to ${to} from ${from}`);

        // Not awaited: a slow database write must not delay the response.
        recordCall({ callSid: call.sid, otherParty: to, direction: 'outbound', config, metadata: { from } });

        return reply.code(201).send({ callSid: call.sid, to, from, status: call.status });
    } catch (error) {
        console.error('Failed to place outbound call:', error.message);
        return reply.code(502).send({ error: 'Failed to place call', detail: error.message });
    }
});

fastify.post('/sms', async (request, reply) => {
    if (!process.env.API_KEY) {
        console.warn('Rejected /sms: API_KEY is not configured');
        return reply.code(503).send({ error: 'Messaging is not configured' });
    }
    if (!isAuthorized(request)) {
        return reply.code(401).send({ error: 'Invalid or missing X-API-Key' });
    }

    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        console.error('SMS rejected: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is missing');
        return reply.code(503).send({ error: 'Messaging is not configured' });
    }

    const { to, from, body } = request.body || {};
    if (!E164.test(to || '')) return reply.code(400).send({ error: '"to" must be an E.164 number, e.g. +447700900123' });
    if (!E164.test(from || '')) return reply.code(400).send({ error: '"from" must be an E.164 number you own on Twilio' });
    if (typeof body !== 'string' || body.trim() === '') return reply.code(400).send({ error: '"body" must be a non-empty message' });
    if (body.length > 1600) return reply.code(400).send({ error: '"body" must be 1600 characters or fewer' });

    ensureContact(to);
    warnIfSuppressed(to, 'SMS');

    try {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const message = await client.messages.create({ to, from, body });

        console.log(`SMS ${message.sid} to ${to} from ${from}`);

        // Not awaited: a slow database write must not delay the response.
        recordMessage({
            otherParty: to,
            twilioNumber: from,
            direction: 'outbound',
            body,
            messageSid: message.sid,
            status: message.status,
        });

        return reply.code(201).send({ messageSid: message.sid, to, from, status: message.status });
    } catch (error) {
        console.error('Failed to send SMS:', error.message);
        return reply.code(502).send({ error: 'Failed to send message', detail: error.message });
    }
});

// Twilio posts inbound messages here. Deliberately separate from POST /sms:
// that route sends, and requires an API key Twilio has no way to present.
//
// Replies with empty TwiML — nothing answers automatically yet, the message is
// only recorded. Unlike the send path this awaits the write: no one is waiting
// on the response, and the record is the only reason the endpoint exists. The
// 2.5s write timeout keeps it well inside Twilio's webhook budget.
fastify.all('/incoming-sms', twilioWebhook, async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const { From: from, To: to, Body: body, MessageSid: messageSid } = params;

    console.log(`Inbound SMS ${messageSid || '(no sid)'} from ${from || 'unknown'} to ${to || 'unknown'}`);

    ensureContact(from);
    await recordMessage({
        otherParty: from,
        twilioNumber: to,
        direction: 'inbound',
        body,
        messageSid,
        status: params.SmsStatus || params.MessageStatus,
    });

    reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<Response/>');
});

// Twilio fetches this once the callee answers.
fastify.all('/outbound-answer', twilioWebhook, async (request, reply) => {
    const params = { ...request.query, ...request.body };

    // Peek, don't consume: the media stream still needs this config when its
    // 'start' event arrives for the same CallSid.
    let config = peekCallConfig(params.CallSid);
    if (!config) {
        // Only if /outbound-call somehow didn't store one — re-resolve and
        // store so the media stream gets the same config (minus overrides).
        config = await resolveConfig({ from: params.From, to: params.To, direction: 'outbound' });
        storeCallConfig(params.CallSid, config);
    }

    console.log(`Outbound call ${params.CallSid || '(no CallSid)'} answered by ${params.To || 'unknown'}`);

    // No "please wait" intro: the callee picked up expecting us to speak.
    reply.type('text/xml').send(buildTwiml(config, request.headers.host, { includeIntro: false }));
});

// Twilio reports call progress here. Always answer 200 — a non-2xx makes Twilio
// retry, and nothing here is worth retrying.
fastify.all('/call-status', twilioWebhook, async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const duration = Number.parseInt(params.CallDuration, 10);

    console.log(`Call ${params.CallSid || '(no CallSid)'} is ${params.CallStatus || 'unknown'}${Number.isFinite(duration) ? ` after ${duration}s` : ''}`);

    await updateCallStatus({
        callSid: params.CallSid,
        status: params.CallStatus,
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
    });

    reply.code(204).send();
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let config = DEFAULT_CONFIG; // replaced by the per-call config on 'start'
        let openAiWs = null; // created on 'start', once the CallSid identifies the call
        let callSid = null; // recorded on 'start', so tool calls can be attributed

        // Tool call bookkeeping. call_id -> tool name, captured from
        // response.output_item.added because that event documents the name;
        // the arguments.done event carries it too but that field is undocumented.
        const pendingToolNames = new Map();

        // Bumped whenever the caller interrupts. A tool result that comes back
        // carrying a stale generation belongs to a response that no longer
        // exists, and is dropped rather than injected into a moved-on conversation.
        let toolGeneration = 0;

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = buildSessionUpdate(config);

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            if (config.aiSpeaksFirst) sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: config.greetingText
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                // A non-positive elapsed time would truncate at or before the
                // start of the item, which OpenAI rejects.
                if (lastAssistantItem && elapsedTime > 0) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;

                // The response being played has been cancelled, so any tool
                // still running for it is now answering a question the caller
                // has talked over.
                toolGeneration++;
            }
        };

        // Runs a tool the model asked for and hands the result back. Never
        // throws: executeTool resolves with an error rather than rejecting, so
        // a broken tool produces something the model can say out loud instead
        // of an exception that leaves the caller in silence.
        const handleToolCall = async (event) => {
            const toolCallId = event.call_id;
            const name = pendingToolNames.get(toolCallId) ?? event.name;
            pendingToolNames.delete(toolCallId);

            if (!toolCallId || !name) {
                console.warn('Tool call arrived with no name or call_id — ignoring');
                return;
            }

            let args = {};
            try {
                if (event.arguments) args = JSON.parse(event.arguments);
            } catch (_) {
                console.warn(`Tool ${name} sent arguments that would not parse: ${event.arguments}`);
            }

            const generation = toolGeneration;
            const { output, error, durationMs } = await executeTool(name, args, { callSid });
            console.log(`Tool ${name} ${error ? `failed: ${error}` : 'ok'} (${durationMs}ms)`);

            // Not awaited: the model is waiting on the result, not the audit row.
            recordToolCall({
                callSid, openAiCallId: toolCallId, name, args,
                result: output ?? null, error: error ?? null, durationMs,
            });

            if (generation !== toolGeneration) {
                console.log(`Discarding ${name} result — the caller interrupted while it ran`);
                return;
            }
            if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;

            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: toolCallId,
                    // Always a JSON string, including for failures, so the
                    // model gets a readable reason rather than an empty result.
                    output: JSON.stringify(error ? { error } : output),
                },
            }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        const handleOpenAiOpen = () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        };

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        const handleOpenAiMessage = (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.output_audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                // Tool calls. Unreachable unless this call advertised tools:
                // with none in session.update the model never emits these.
                if (response.type === 'response.output_item.added' && response.item?.type === 'function_call') {
                    if (response.item.call_id) pendingToolNames.set(response.item.call_id, response.item.name);
                }

                if (response.type === 'response.function_call_arguments.done') {
                    handleToolCall(response);
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        };

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        callSid = data.start.callSid || null;
                        console.log('Incoming stream has started', streamSid, data.start.callSid || '(no callSid)');

                        // Pick up the config stored by the TwiML webhook for this
                        // CallSid; streams without one (tests) keep the defaults.
                        config = takeCallConfig(data.start.callSid) || config;

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;

                        if (!openAiWs) connectToOpenAi();
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }

                        // An empty queue means everything we sent has finished
                        // playing, so the next response needs its own baseline.
                        // Without this the baseline stays at the first response
                        // of the call and a later interruption asks OpenAI to
                        // truncate past the end of the item it is playing.
                        if (markQueue.length === 0) {
                            responseStartTimestampTwilio = null;
                            lastAssistantItem = null;
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        const handleOpenAiClose = () => {
            console.log('Disconnected from the OpenAI Realtime API');
        };

        const handleOpenAiError = (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        };

        // Create the OpenAI WebSocket for this call. Deferred until the Twilio
        // 'start' event so the per-call config (looked up by CallSid) is known.
        const connectToOpenAi = () => {
            openAiWs = new WebSocket(buildRealtimeUrl(config), {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                }
            });

            openAiWs.on('open', handleOpenAiOpen);
            openAiWs.on('message', handleOpenAiMessage);
            openAiWs.on('close', handleOpenAiClose);
            openAiWs.on('error', handleOpenAiError);
        };
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);

    // Don't make the first caller pay for the cold connection.
    warmUp();
});

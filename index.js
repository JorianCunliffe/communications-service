import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import { timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, buildRealtimeUrl, buildSessionUpdate, buildTwiml } from './config.js';
import { resolveConfig, storeCallConfig, takeCallConfig, peekCallConfig, warmUp, warnIfSuppressed, ensureContact } from './configResolver.js';
import { recordCall, updateCallStatus } from './callLog.js';

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

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Test console. Served from this app so its buttons are same-origin and can
// reach the API directly. Holds no secrets: the API key is entered by the
// operator and kept in their browser.
const CONSOLE_HTML = (() => {
    try {
        return readFileSync(new URL('./console.html', import.meta.url), 'utf8');
    } catch (error) {
        console.warn(`Test console unavailable: ${error.message}`);
        return null;
    }
})();

fastify.get('/console', async (request, reply) => {
    if (!CONSOLE_HTML) return reply.code(404).send({ error: 'Test console not available' });
    reply.type('text/html').send(CONSOLE_HTML);
});

// Health check: reports which optional features are wired up.
fastify.get('/health', async (request, reply) => {
    reply.send({
        status: 'ok',
        version: VERSION,
        model: DEFAULT_CONFIG.model,
        playIntro: DEFAULT_CONFIG.playIntro,
        supabaseConfig: process.env.SUPABASE_CONFIG_ENABLED === 'true',
        outboundCalls: Boolean(process.env.API_KEY && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.PUBLIC_URL),
    });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const params = { ...request.query, ...request.body };
    const config = await resolveConfig({ from: params.From, to: params.To, direction: 'inbound' });
    storeCallConfig(params.CallSid, config);
    console.log(`Incoming call ${params.CallSid || '(no CallSid)'} from ${params.From || 'unknown'} to ${params.To || 'unknown'}`);

    reply.type('text/xml').send(buildTwiml(config, request.headers.host));
});

// --- Outbound calls --------------------------------------------------------

// Fields a caller of /outbound-call may override per request.
const OVERRIDABLE_FIELDS = [
    'model', 'effort', 'voice', 'temperature', 'systemMessage',
    'introMessage', 'introMessage2', 'introVoice', 'greetingText', 'aiSpeaksFirst',
];

const E164 = /^\+[1-9]\d{1,14}$/;

// Fails closed: without API_KEY set, the endpoint stays disabled rather than
// letting anyone place calls on this Twilio account.
function isAuthorized(request) {
    const expected = process.env.API_KEY;
    if (!expected) return false;

    const provided = request.headers['x-api-key'];
    if (typeof provided !== 'string') return false;

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

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

    // Outbound config is keyed on the number we are calling from.
    const resolved = await resolveConfig({ from, direction: 'outbound' });
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
        return reply.code(201).send({ messageSid: message.sid, to, from, status: message.status });
    } catch (error) {
        console.error('Failed to send SMS:', error.message);
        return reply.code(502).send({ error: 'Failed to send message', detail: error.message });
    }
});

// Twilio fetches this once the callee answers.
fastify.all('/outbound-answer', async (request, reply) => {
    const params = { ...request.query, ...request.body };

    // Peek, don't consume: the media stream still needs this config when its
    // 'start' event arrives for the same CallSid.
    let config = peekCallConfig(params.CallSid);
    if (!config) {
        // Only if /outbound-call somehow didn't store one — re-resolve and
        // store so the media stream gets the same config (minus overrides).
        config = await resolveConfig({ from: params.From, direction: 'outbound' });
        storeCallConfig(params.CallSid, config);
    }

    console.log(`Outbound call ${params.CallSid || '(no CallSid)'} answered by ${params.To || 'unknown'}`);

    // No "please wait" intro: the callee picked up expecting us to speak.
    reply.type('text/xml').send(buildTwiml(config, request.headers.host, { includeIntro: false }));
});

// Twilio reports call progress here. Always answer 200 — a non-2xx makes Twilio
// retry, and nothing here is worth retrying.
fastify.all('/call-status', async (request, reply) => {
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
            }
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

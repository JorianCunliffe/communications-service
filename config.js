// Central configuration for the voice assistant.
// DEFAULT_CONFIG is the single source of truth for every per-call tunable;
// callers without a specific config (and any lookup failure) fall back to it.

import { buildToolDefinitions } from './tools.js';

export const DEFAULT_CONFIG = {
    // OpenAI Realtime model. 'gpt-realtime-2' / 'gpt-realtime-2.1' also supported.
    model: 'gpt-realtime',

    // Reasoning effort: minimal | low | medium | high | xhigh.
    // Only sent when set — gpt-realtime (v1) does not accept it.
    effort: null,

    // Voice for the AI's spoken responses (OpenAI Realtime voice name).
    voice: 'alloy',

    // Controls the randomness of the AI's responses.
    temperature: 0.8,

    // The assistant's name, available to prompts as {{assistant}}.
    assistantName: 'Iris',

    // System prompt / instructions for the AI.
    systemMessage: 'You are Iris, a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.',

    // Whether Twilio speaks the intro lines below before the media stream
    // connects. Twilio's text-to-speech is a different voice from the
    // assistant's, so leaving this off keeps one voice across the whole call.
    // The lines are retained so it can be switched back on per number.
    playIntro: false,

    // Twilio <Say> lines played before the stream connects, and their voice.
    // Only used when playIntro is true.
    introMessage: 'Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open A I Realtime API',
    introMessage2: 'O.K. you can start talking!',
    introVoice: 'Google.en-US-Chirp3-HD-Aoede',

    // Instruction sent as a user message when the AI speaks first. Spoken in
    // the assistant's own voice, so this is where the call's opening line
    // belongs when playIntro is off.
    greetingText: 'Open by saying "Iris here." then greet {{name|the caller}} by name and ask how you can help. Keep the whole greeting to one or two short sentences.',

    // When true, the AI greets the caller (sends greetingText + response.create)
    // instead of waiting for the caller to speak.
    aiSpeaksFirst: true,

    // Names of tools the assistant may call, from the registry in tools.js.
    // Empty by default: with no tools advertised the model never emits a
    // function call, so the session and the call behave exactly as before.
    // Enable per contact or per line via inbound_/outbound_enabled_tools.
    tools: [],

    // --- Transcription -------------------------------------------------------
    // All off by default. Each one changes what happens to a real conversation,
    // so none of them turns on for everybody because a deploy happened.

    // Ask the Realtime session to transcribe the caller's audio, so both halves
    // of the call can be written to the call log as it happens. Costs a
    // transcription model on top of the call and adds one field to
    // session.update — see buildSessionUpdate for why that matters.
    liveTranscript: false,

    // Record the call through Twilio and transcribe the audio afterwards. The
    // audio is deleted once the transcript is stored.
    recordCalls: false,

    // Summarise a finished transcript into calls.summary and prepend a line to
    // the contact's combined_history, which is injected into future prompts.
    summarise: false,

    // --- History -------------------------------------------------------------
    // Budget for {{history}}, the real cross-channel record of what was said.
    // These only matter when a prompt actually contains that placeholder; a
    // prompt without it never triggers the lookup and never pays for it.

    // Turns kept, newest first. Enough for the last few exchanges without
    // handing the model a novel to read before it can say hello.
    historyLimit: 30,

    // Hard ceiling on the rendered block. A limit in turns alone is not a limit:
    // thirty turns of a long meeting transcript is a different size from thirty
    // text messages.
    historyMaxChars: 3000,

    // How far back to look. Something said two years ago is rarely the context
    // for this call, and fetching it costs the caller time on every one.
    historyDays: 90,
};

// The transcription model asked of the Realtime session when liveTranscript is
// on. Separate from the conversation model: this one only turns the caller's
// audio into text.
export const LIVE_TRANSCRIPT_MODEL = 'gpt-transcribe';

// Text fields that may contain placeholders.
const TEMPLATED_FIELDS = ['systemMessage', 'introMessage', 'introMessage2', 'greetingText'];

// {{token}} or {{token|fallback when empty}}
const PLACEHOLDER = /\{\{\s*(name|assistant|combined_history|history)\s*(?:\|([^}]*))?\}\}/gi;

// Default when a value is missing and no explicit fallback is given. A single
// default cannot suit every sentence: "Hi {{name}}" wants "there", but
// "speaking with {{name}}" would read as "speaking with there" — write
// {{name|the caller}} to choose per placeholder.
const IMPLICIT_FALLBACK = {
    name: 'there',
    assistant: 'the assistant',
    combined_history: 'No previous contact on record.',
    history: 'No previous contact on record.',
};

// Does this config ask for the real conversation history?
//
// The placeholder is the switch. There is no separate enable flag because there
// is nothing a flag could mean on its own: history that is fetched but not
// interpolated is a database query nobody reads, and a prompt asking for
// {{history}} with the flag off would silently say "no previous contact" about
// someone we have spoken to ten times. One thing to set, one place to look.
//
// Checked before the lookup runs, so a prompt without it makes no extra query
// and the call is byte-for-byte the call it was before this existed.
export function needsHistory(config) {
    return TEMPLATED_FIELDS.some((field) => {
        HISTORY_PLACEHOLDER.lastIndex = 0;
        return HISTORY_PLACEHOLDER.test(config?.[field] ?? '');
    });
}

const HISTORY_PLACEHOLDER = /\{\{\s*history\s*(?:\|[^}]*)?\}\}/gi;

// Fills placeholders from the caller's record and the active config.
export function renderTemplate(text, values = {}) {
    return String(text ?? '').replace(PLACEHOLDER, (_match, token, fallback) => {
        const key = token.toLowerCase();
        const value = values[key];
        if (value !== null && value !== undefined && String(value).trim() !== '') return String(value).trim();
        return fallback === undefined ? IMPLICIT_FALLBACK[key] : fallback.trim();
    });
}

// Applies the contact's details to a config's text fields. Returns the config
// unchanged — same object identity — when it holds no placeholders.
//
// `contact` is the row from public.contacts, or null for an unknown caller;
// every placeholder degrades to a readable fallback rather than leaking braces.
//
// `history` is the rendered cross-channel record, already delimited, or null.
// The caller fetches it — this module stays free of I/O so it can be tested
// without a database, and so nothing here can block a call by accident.
export function personaliseConfig(config, contact, history = null) {
    const needsRender = TEMPLATED_FIELDS.some((field) => {
        PLACEHOLDER.lastIndex = 0; // the regex is global; reset before testing
        return PLACEHOLDER.test(config[field] ?? '');
    });
    if (!needsRender) return config;

    const values = {
        name: contact?.name ?? null,
        assistant: config.assistantName ?? DEFAULT_CONFIG.assistantName,
        combined_history: contact?.combined_history ?? null,
        history,
    };

    const personalised = { ...config };
    for (const field of TEMPLATED_FIELDS) {
        personalised[field] = renderTemplate(config[field], values);
    }
    return personalised;
}

// Escape text before interpolating it into TwiML. Config values come from the
// database and from API request overrides, so an unescaped '&' or '<' would
// produce invalid XML and Twilio would fail the call.
export function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// TwiML that plays the intro lines then bridges the call into the media stream.
// Shared by the inbound and outbound answer routes.
//
// The intro is spoken by Twilio's text-to-speech, which is a different voice
// from the assistant's. Blank both intro messages to skip it entirely so the
// caller only ever hears the assistant — pair that with aiSpeaksFirst so the
// assistant opens the conversation itself.
export function buildTwiml(config, host, { includeIntro = true } = {}) {
    const INDENT = ' '.repeat(30);

    const spokenLines = includeIntro && config.playIntro
        ? [config.introMessage, config.introMessage2].filter((line) => String(line ?? '').trim() !== '')
        : [];

    const intro = spokenLines
        .map((line) => `<Say voice="${escapeXml(config.introVoice)}">${escapeXml(line)}</Say>`)
        .join(`\n${INDENT}<Pause length="1"/>\n${INDENT}`);

    return `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              ${intro ? `${intro}\n${INDENT}` : ''}<Connect>
                                  <Stream url="wss://${escapeXml(host)}/media-stream" />
                              </Connect>
                          </Response>`;
}

// WebSocket URL for the OpenAI Realtime API.
//
// Reasoning models (gpt-realtime-2 and later) steer with reasoning.effort in
// session.update rather than temperature, and reasoning models elsewhere in the
// API reject temperature outright. Sending it would fail the connection and
// kill the call, so it is omitted whenever effort is set.
export function buildRealtimeUrl(config) {
    const url = `wss://api.openai.com/v1/realtime?model=${config.model}`;
    return config.effort ? url : `${url}&temperature=${config.temperature}`;
}

// The session.update event sent after the OpenAI WebSocket opens.
export function buildSessionUpdate(config) {
    const session = {
        type: 'realtime',
        model: config.model,
        output_modalities: ["audio"],
        audio: {
            input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
            output: { format: { type: 'audio/pcmu' }, voice: config.voice },
        },
        instructions: config.systemMessage,
    };

    if (config.effort) {
        session.reasoning = { effort: config.effort };
    }

    // Transcription of the caller's audio, so the call log gets both halves of
    // the conversation. Set only when the call asks for it — the same rule the
    // tools below follow, and for the same reason: a call without the flag
    // sends exactly the payload it sent before this existed, so turning this on
    // for one contact cannot change how anyone else's call is set up.
    if (config.liveTranscript) {
        session.audio.input.transcription = { model: LIVE_TRANSCRIPT_MODEL };
    }

    // Only sent when a call actually has tools. Omitting the keys entirely
    // keeps this payload byte-identical to the long-standing one for every
    // call that has none, so enabling tools for one contact cannot change how
    // any other call is set up.
    const tools = buildToolDefinitions(config.tools);
    if (tools.length > 0) {
        session.tools = tools;
        session.tool_choice = 'auto';
    }

    return {
        type: 'session.update',
        session: session,
    };
}

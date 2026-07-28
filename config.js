// Central configuration for the voice assistant.
// DEFAULT_CONFIG is the single source of truth for every per-call tunable;
// callers without a specific config (and any lookup failure) fall back to it.

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
};

// Text fields that may contain {{name}} placeholders.
const TEMPLATED_FIELDS = ['systemMessage', 'introMessage', 'introMessage2', 'greetingText'];

const NAME_PLACEHOLDER = /\{\{\s*name\s*(?:\|([^}]*))?\}\}/gi;

// Fills {{name}} with the caller's name.
//
// The fallback for an unknown caller has to suit the sentence it sits in:
// "Hi {{name}}" wants "there", but "speaking with {{name}}" needs "the caller"
// or it reads as "speaking with there". Write {{name|the caller}} to choose,
// otherwise it falls back to "there".
export function renderTemplate(text, callerName) {
    return String(text ?? '').replace(NAME_PLACEHOLDER, (_match, fallback) =>
        callerName || (fallback === undefined ? 'there' : fallback.trim())
    );
}

// Applies the caller's name to a config's text fields. Returns the config
// unchanged — same object identity — when it holds no placeholders, so configs
// without templates stay byte-identical.
export function personaliseConfig(config, callerName) {
    const needsRender = TEMPLATED_FIELDS.some((field) => {
        NAME_PLACEHOLDER.lastIndex = 0; // the regex is global; reset before testing
        return NAME_PLACEHOLDER.test(config[field] ?? '');
    });
    if (!needsRender) return config;

    const personalised = { ...config };
    for (const field of TEMPLATED_FIELDS) {
        personalised[field] = renderTemplate(config[field], callerName);
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

    return {
        type: 'session.update',
        session: session,
    };
}

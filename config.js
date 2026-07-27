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
    systemMessage: 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.',

    // Twilio <Say> lines played before the stream connects, and their voice.
    introMessage: 'Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open A I Realtime API',
    introMessage2: 'O.K. you can start talking!',
    introVoice: 'Google.en-US-Chirp3-HD-Aoede',

    // Instruction sent as a user message when the AI speaks first.
    greetingText: 'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"',

    // When true, the AI greets the caller (sends greetingText + response.create)
    // instead of waiting for the caller to speak.
    aiSpeaksFirst: false,
};

// WebSocket URL for the OpenAI Realtime API.
export function buildRealtimeUrl(config) {
    return `wss://api.openai.com/v1/realtime?model=${config.model}&temperature=${config.temperature}`;
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

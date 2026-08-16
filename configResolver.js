// Resolves the per-call config and hands it from the TwiML webhook to the
// media-stream WebSocket, keyed by Twilio CallSid.
//
// Config lives in the selected database (public.phone_configs), one row per phone number in
// E.164. A row may describe an inbound caller (a personal override) or one of
// our Twilio lines (the default for anyone dialling it), so lookups try the
// caller first and fall back to the line, then to DEFAULT_CONFIG.
//
// Answering a call must never depend on persistence being reachable: every failure
// path here returns DEFAULT_CONFIG.

import { DEFAULT_CONFIG, personaliseConfig } from './config.js';
import { databaseProvider, getDatabase } from './database.js';

const LOOKUP_TIMEOUT_MS = 2500;
const WARM_UP_TIMEOUT_MS = 10000;
const ROW_CACHE_TTL_MS = 60 * 1000;

// Read env on first use, not at import time: ES module imports are evaluated
// before index.js calls dotenv.config(), so reading it here at module scope
// would silently see no credentials and disable config for every call.
function getClient() {
    return getDatabase();
}

// Maps a settings row onto DEFAULT_CONFIG. Works for contact_config and
// phone_configs alike — they mirror each other's columns.
//
// Within a row, a direction-specific column beats the generic call_* one, which
// in turn beats the app default. So outbound_call_prompt wins on an outbound
// call, otherwise call_system_prompt, otherwise DEFAULT_CONFIG.systemMessage.
export function rowToConfig(row, direction = 'inbound') {
    const set = (value) => value !== null && value !== undefined;
    // Falls through to the last value — the app default — even when that
    // default is itself null, so an unset effort stays null and not undefined.
    const pick = (...values) => {
        const found = values.find(set);
        return found === undefined ? values[values.length - 1] : found;
    };
    const outbound = direction === 'outbound';

    const prompt = outbound ? row.outbound_call_prompt : row.inbound_call_prompt;
    const greeting = outbound ? row.outbound_call_greeting : row.inbound_call_greeting;
    const speaksFirst = outbound ? row.outbound_ai_speaks_first : row.inbound_ai_speaks_first;
    const tools = outbound ? row.outbound_enabled_tools : row.inbound_enabled_tools;

    return {
        model: pick(row.model, DEFAULT_CONFIG.model),
        effort: pick(row.effort, DEFAULT_CONFIG.effort),
        voice: pick(row.call_voice, DEFAULT_CONFIG.voice),
        temperature: set(row.temperature) ? Number(row.temperature) : DEFAULT_CONFIG.temperature,
        systemMessage: pick(prompt, row.call_system_prompt, DEFAULT_CONFIG.systemMessage),
        playIntro: pick(row.play_intro, DEFAULT_CONFIG.playIntro),
        introMessage: pick(row.intro_message, DEFAULT_CONFIG.introMessage),
        introMessage2: pick(row.intro_message_2, DEFAULT_CONFIG.introMessage2),
        introVoice: pick(row.intro_voice, DEFAULT_CONFIG.introVoice),
        greetingText: pick(greeting, row.call_greeting, DEFAULT_CONFIG.greetingText),
        aiSpeaksFirst: pick(speaksFirst, row.ai_speaks_first, DEFAULT_CONFIG.aiSpeaksFirst),
        assistantName: pick(row.assistant_name, DEFAULT_CONFIG.assistantName),
        // An empty array is a deliberate "no tools on this direction", so it
        // has to beat the generic list rather than being treated as unset —
        // which is why this tests length instead of leaning on pick().
        tools: tools ?? row.enabled_tools ?? DEFAULT_CONFIG.tools,

        // Transcription switches. Nullable in the database so an unset column
        // falls through to the app default rather than reading as a deliberate
        // false — pick() already does exactly that.
        liveTranscript: pick(row.live_transcript_enabled, DEFAULT_CONFIG.liveTranscript),
        recordCalls: pick(row.call_recording_enabled, DEFAULT_CONFIG.recordCalls),
        summarise: pick(row.summarise_enabled, DEFAULT_CONFIG.summarise),

        // How much history {{history}} pulls in. No column exists for these
        // yet; an absent column reads as undefined, which pick() already treats
        // as unset, so they fall through to the defaults until the migration
        // adds them. Mapped now so adding the columns needs no code change.
        historyLimit: pick(row.history_limit, DEFAULT_CONFIG.historyLimit),
        historyMaxChars: pick(row.history_max_chars, DEFAULT_CONFIG.historyMaxChars),
        historyDays: pick(row.history_days, DEFAULT_CONFIG.historyDays),
        maxCallSeconds: pick(row.max_call_seconds, DEFAULT_CONFIG.maxCallSeconds),
        wrapUpSeconds: pick(row.wrap_up_seconds, DEFAULT_CONFIG.wrapUpSeconds),
    };
}

// phoneNumber -> { row, fetchedAt }. Caches misses (row: null) too, so unknown
// callers don't hit the database on every call.
const rowCache = new Map();

function cached(phoneNumber) {
    const entry = rowCache.get(phoneNumber);
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt >= ROW_CACHE_TTL_MS) {
        rowCache.delete(phoneNumber);
        return undefined;
    }
    return entry.row;
}

// Fetches every candidate in one round trip — the caller waits on this before
// any TwiML is returned, so a second sequential query would double the delay.
async function fetchRows(client, phoneNumbers, timeoutMs = LOOKUP_TIMEOUT_MS) {
    const query = client
        .from('phone_configs')
        .select('*')
        .in('twilio_number', phoneNumbers)
        .eq('call_enabled', true);

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Database lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
        const { data, error } = await Promise.race([query, timeout]);
        if (error) throw new Error(error.message);

        const byNumber = new Map((data ?? []).map((row) => [row.twilio_number, row]));
        const fetchedAt = Date.now();
        for (const phoneNumber of phoneNumbers) {
            rowCache.set(phoneNumber, { row: byNumber.get(phoneNumber) ?? null, fetchedAt });
        }
        return byNumber;
    } finally {
        clearTimeout(timer);
    }
}

// phoneNumber -> { contact, fetchedAt }
const contactCache = new Map();

// Fetches the contact, their settings and their history digest in one round
// trip. Never throws: losing this costs personalisation, not the call. Note
// contacts and contact_config have RLS enabled, so this needs the service-role
// key — with the anon key it returns null and everything falls back.
async function fetchContact(client, phoneNumber, timeoutMs = LOOKUP_TIMEOUT_MS) {
    const entry = contactCache.get(phoneNumber);
    if (entry && Date.now() - entry.fetchedAt < ROW_CACHE_TTL_MS) return entry.contact;

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`contact lookup timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
        const query = client
            .from('contacts')
            .select('id, name, combined_history, do_not_contact, contact_config(*)')
            .eq('phone_number', phoneNumber)
            .maybeSingle();

        const { data, error } = await Promise.race([query, timeout]);
        if (error) throw new Error(error.message);

        // PostgREST returns a one-to-one embed as an object or a single-element
        // array depending on how the relationship is detected.
        const config = Array.isArray(data?.contact_config) ? data.contact_config[0] : data?.contact_config;
        const contact = data ? { ...data, contact_config: config ?? null } : null;

        contactCache.set(phoneNumber, { contact, fetchedAt: Date.now() });
        return contact;
    } catch (error) {
        console.warn(`Contact lookup failed for ${phoneNumber}: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Outbound delivery is blocked for suppressed contacts. A narrowly-scoped
// override must carry an operator reason so it is visible in application logs.
export async function assertContactable(phoneNumber, context = 'outbound', override = null) {
    const client = getClient();
    if (!client || !phoneNumber) return null;
    const result = await client.from('contacts').select('id,name,do_not_contact').eq('phone_number', phoneNumber).maybeSingle();
    if (result.error) throw new Error(`Could not verify do_not_contact for ${phoneNumber}: ${result.error.message}`);
    const contact = result.data;
    if (!contact?.do_not_contact) return contact;
    if (override?.allowed === true && typeof override.reason === 'string' && override.reason.trim()) {
        console.warn(`do_not_contact override for ${contact.name || phoneNumber} during ${context}: ${override.reason.trim()}`);
        return contact;
    }
    const error = new Error(`${contact.name || phoneNumber} is marked do_not_contact`);
    error.code = 'DO_NOT_CONTACT';
    throw error;
}

export async function ensureContact(phoneNumber) {
    const client = getClient();
    if (!client || !phoneNumber) return null;
    const result = await client.rpc('ensure_communication_contact', { p_phone_number: phoneNumber });
    if (result.error) throw new Error(`Could not ensure contact for ${phoneNumber}: ${result.error.message}`);
    contactCache.delete(phoneNumber);
    return result.data;
}

// Prime the connection at boot. The first query of a process pays for DNS, the
// TLS handshake and client setup — measured at ~1.8s versus ~0.3s once warm,
// which is enough to blow the per-call timeout and silently fall back to
// defaults on the first call after every deploy. Runs in the background; the
// server does not wait for it.
export async function warmUp() {
    const client = getClient();
    if (!client) return;

    const started = Date.now();
    try {
        // A number that will never match: we want the round trip, not the row.
        await fetchRows(client, ['+00000000000'], WARM_UP_TIMEOUT_MS);
        rowCache.delete('+00000000000');
        console.log(`${databaseProvider() || 'Database'} config warmed up in ${Date.now() - started}ms`);
    } catch (error) {
        console.warn(`Database config warm-up failed after ${Date.now() - started}ms (${error.message}) — the first call may fall back to defaults`);
    }
}

// Resolve the config for a call. `from` is the caller, `to` the number dialled.
// Every exit runs through personaliseConfig, including the failure paths:
// DEFAULT_CONFIG itself contains a {{name}} placeholder, so returning it raw
// would send the literal braces to the model or to Twilio's text-to-speech.
//
// `createContact` exists for the management API's preview route: asking what
// would happen on a call must not be the thing that creates a contact record.
// The call path leaves it on.
export async function resolveConfig({ from, to, direction, createContact = true }) {
    const client = getClient();
    if (!client) return personaliseConfig(DEFAULT_CONFIG, null);

    const outbound = direction === 'outbound';

    // Inbound: the caller's own config wins, else the line they dialled.
    // Outbound: we are the caller, so `from` is our line.
    const candidates = (outbound ? [from] : [from, to]).filter(Boolean);

    // Whose record personalises the call: always the person on the other end,
    // which is `to` when we placed the call and `from` when they did. Keying
    // this on `from` either way looks up our own line on every outbound call,
    // so the callee's settings and name are never found.
    const otherParty = outbound ? to : from;

    if (candidates.length === 0 && !otherParty) return personaliseConfig(DEFAULT_CONFIG, null);

    let config = DEFAULT_CONFIG;
    let contact = null;

    try {
        const uncached = candidates.filter((phoneNumber) => cached(phoneNumber) === undefined);

        // Contact and line settings are fetched together, so the richer lookup
        // costs no more than the old one did.
        const [fetched, found] = await Promise.all([
            uncached.length > 0 ? fetchRows(client, uncached) : new Map(),
            otherParty ? fetchContact(client, otherParty) : null,
        ]);
        contact = found;

        // The person's own settings beat the line's, which beat the defaults.
        if (contact?.contact_config) {
            console.log(`Config from contact ${contact.name || otherParty} (${contact.contact_config.name || 'unnamed'})`);
            config = rowToConfig(contact.contact_config, direction);
        } else {
            const line = candidates.map((n) => fetched.get(n) ?? cached(n)).find(Boolean);
            if (line) {
                console.log(`Config from line ${line.twilio_number} (${line.name || 'unnamed'})${contact?.name ? `, caller is ${contact.name}` : ''}`);
                config = rowToConfig(line, direction);
            } else {
                console.log(`No config for ${candidates.join(' or ')} — using defaults`);
            }
        }

        // First contact with this number: atomically create the contact and
        // phone identity before provider persistence can reference them.
        if (!contact && otherParty && createContact) await ensureContact(otherParty);
    } catch (error) {
        console.error('Config lookup failed, using defaults:', error.message);
        return personaliseConfig(DEFAULT_CONFIG, contact);
    }

    // Note what this deliberately does not do: fetch conversation history.
    // Nothing on the path to answering a call should wait on it. The lookup is
    // started separately by startHistory() in realtimeSessions.js, runs while
    // the call is still being set up, and reaches the model after it has
    // already begun speaking.
    return personaliseConfig(config, contact);
}

// --- CallSid → config handoff ----------------------------------------------
// /incoming-call resolves the config before returning TwiML; the media-stream
// 'start' event picks it up via data.start.callSid. Entries expire so calls
// that never connect a stream don't leak memory.

const TTL_MS = 60 * 60 * 1000; // 1 hour
const callConfigs = new Map(); // callSid -> { config, storedAt }

export function storeCallConfig(callSid, config) {
    if (!callSid) return;
    sweepExpired();
    callConfigs.set(callSid, { config, storedAt: Date.now() });
}

export function takeCallConfig(callSid) {
    const entry = callSid ? callConfigs.get(callSid) : undefined;
    if (!entry) return null;
    callConfigs.delete(callSid);
    return entry.config;
}

// Read without consuming — for routes that run before the media stream claims
// the config (the outbound answer webhook).
export function peekCallConfig(callSid) {
    const entry = callSid ? callConfigs.get(callSid) : undefined;
    return entry ? entry.config : null;
}

function sweepExpired() {
    const cutoff = Date.now() - TTL_MS;
    for (const [sid, entry] of callConfigs) {
        if (entry.storedAt < cutoff) callConfigs.delete(sid);
    }
}

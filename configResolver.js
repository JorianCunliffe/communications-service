// Resolves the per-call config and hands it from the TwiML webhook to the
// media-stream WebSocket, keyed by Twilio CallSid.
//
// Config lives in Supabase (public.phone_configs), one row per phone number in
// E.164. A row may describe an inbound caller (a personal override) or one of
// our Twilio lines (the default for anyone dialling it), so lookups try the
// caller first and fall back to the line, then to DEFAULT_CONFIG.
//
// Answering a call must never depend on Supabase being reachable: every failure
// path here returns DEFAULT_CONFIG.

import { createClient } from '@supabase/supabase-js';
import { DEFAULT_CONFIG, personaliseConfig } from './config.js';

const LOOKUP_TIMEOUT_MS = 2500;
const WARM_UP_TIMEOUT_MS = 10000;
const ROW_CACHE_TTL_MS = 60 * 1000;

// Read env on first use, not at import time: ES module imports are evaluated
// before index.js calls dotenv.config(), so reading it here at module scope
// would silently see no credentials and disable config for every call.
let supabase; // undefined = not yet initialised, null = disabled

function getClient() {
    if (supabase !== undefined) return supabase;

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_CONFIG_ENABLED } = process.env;
    const requested = SUPABASE_CONFIG_ENABLED === 'true';
    const credentialed = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY);

    if (requested && !credentialed) {
        console.warn('SUPABASE_CONFIG_ENABLED is true but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing — using default config for every call.');
    }

    supabase = requested && credentialed
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
        : null;

    console.log(`Supabase call config ${supabase ? 'enabled' : 'disabled'}`);
    return supabase;
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
        timer = setTimeout(() => reject(new Error(`Supabase lookup timed out after ${timeoutMs}ms`)), timeoutMs);
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

// Creates a contact for a number we have never seen, so history can attach to
// it from the first interaction. Fire-and-forget: never awaited on the call
// path, and a failure is logged and ignored.
export function ensureContact(phoneNumber) {
    const client = getClient();
    if (!client || !phoneNumber) return;

    client
        .from('contacts')
        .upsert({ phone_number: phoneNumber }, { onConflict: 'phone_number', ignoreDuplicates: true })
        .then(({ error }) => {
            if (error) console.warn(`Could not create contact for ${phoneNumber}: ${error.message}`);
            else {
                contactCache.delete(phoneNumber); // so the next call sees the new row
                console.log(`Created contact for ${phoneNumber}`);
            }
        });
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
        console.log(`Supabase config warmed up in ${Date.now() - started}ms`);
    } catch (error) {
        console.warn(`Supabase config warm-up failed after ${Date.now() - started}ms (${error.message}) — the first call may fall back to defaults`);
    }
}

// Resolve the config for a call. `from` is the caller, `to` the number dialled.
// Every exit runs through personaliseConfig, including the failure paths:
// DEFAULT_CONFIG itself contains a {{name}} placeholder, so returning it raw
// would send the literal braces to the model or to Twilio's text-to-speech.
export async function resolveConfig({ from, to, direction }) {
    const client = getClient();
    if (!client) return personaliseConfig(DEFAULT_CONFIG, null);

    // Inbound: the caller's own config wins, else the line they dialled.
    // Outbound: we are the caller, so `from` is our line.
    const candidates = (direction === 'outbound' ? [from] : [from, to]).filter(Boolean);
    if (candidates.length === 0) return personaliseConfig(DEFAULT_CONFIG, null);

    let config = DEFAULT_CONFIG;
    let contact = null;

    try {
        const uncached = candidates.filter((phoneNumber) => cached(phoneNumber) === undefined);

        // Contact and line settings are fetched together, so the richer lookup
        // costs no more than the old one did.
        const [fetched, found] = await Promise.all([
            uncached.length > 0 ? fetchRows(client, uncached) : new Map(),
            from ? fetchContact(client, from) : null,
        ]);
        contact = found;

        // The person's own settings beat the line's, which beat the defaults.
        if (contact?.contact_config) {
            console.log(`Config from contact ${contact.name || from} (${contact.contact_config.name || 'unnamed'})`);
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

        // First contact from this number: create the record so history has
        // something to attach to. Not awaited — the call must not wait on it.
        if (!contact && from) ensureContact(from);
    } catch (error) {
        console.error('Config lookup failed, using defaults:', error.message);
        return personaliseConfig(DEFAULT_CONFIG, contact);
    }

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

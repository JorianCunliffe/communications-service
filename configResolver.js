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
import { DEFAULT_CONFIG } from './config.js';

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

// Maps a phone_configs row onto DEFAULT_CONFIG. Null/undefined columns fall
// back field by field, so a row only needs to set what it wants to change.
export function rowToConfig(row) {
    const pick = (value, fallback) => (value === null || value === undefined ? fallback : value);

    return {
        model: pick(row.model, DEFAULT_CONFIG.model),
        effort: pick(row.effort, DEFAULT_CONFIG.effort),
        voice: pick(row.call_voice, DEFAULT_CONFIG.voice),
        temperature: row.temperature === null || row.temperature === undefined
            ? DEFAULT_CONFIG.temperature
            : Number(row.temperature), // numeric arrives as a string
        systemMessage: pick(row.call_system_prompt, DEFAULT_CONFIG.systemMessage),
        introMessage: pick(row.intro_message, DEFAULT_CONFIG.introMessage),
        introMessage2: pick(row.intro_message_2, DEFAULT_CONFIG.introMessage2),
        introVoice: pick(row.intro_voice, DEFAULT_CONFIG.introVoice),
        greetingText: pick(row.call_greeting, DEFAULT_CONFIG.greetingText),
        aiSpeaksFirst: pick(row.ai_speaks_first, DEFAULT_CONFIG.aiSpeaksFirst),
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
export async function resolveConfig({ from, to, direction }) {
    const client = getClient();
    if (!client) return DEFAULT_CONFIG;

    // Inbound: the caller's own config wins, else the line they dialled.
    // Outbound: we are the caller, so `from` is our line.
    const candidates = (direction === 'outbound' ? [from] : [from, to]).filter(Boolean);
    if (candidates.length === 0) return DEFAULT_CONFIG;

    try {
        const uncached = candidates.filter((phoneNumber) => cached(phoneNumber) === undefined);
        const fetched = uncached.length > 0 ? await fetchRows(client, uncached) : new Map();

        // Candidate order is the precedence order.
        for (const phoneNumber of candidates) {
            const row = fetched.get(phoneNumber) ?? cached(phoneNumber);
            if (row) {
                console.log(`Config matched ${phoneNumber} (${row.name || 'unnamed'})`);
                return rowToConfig(row);
            }
        }
        console.log(`No config row for ${candidates.join(' or ')} — using defaults`);
    } catch (error) {
        console.error('Config lookup failed, using defaults:', error.message);
    }

    return DEFAULT_CONFIG;
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

// Resolves the per-call config and hands it from the TwiML webhook to the
// media-stream WebSocket, keyed by Twilio CallSid.

import { DEFAULT_CONFIG } from './config.js';

// Stub: always returns defaults. Replaced by a Supabase lookup (keyed by
// phone number) in a later step — the call sites won't need to change.
export async function resolveConfig({ from, to, direction }) {
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

function sweepExpired() {
    const cutoff = Date.now() - TTL_MS;
    for (const [sid, entry] of callConfigs) {
        if (entry.storedAt < cutoff) callConfigs.delete(sid);
    }
}

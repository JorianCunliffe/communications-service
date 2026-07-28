// Records calls in public.calls so a call's outcome can be inspected after the
// fact rather than inferred from logs.
//
// Every function here is fire-and-forget and swallows its own errors: logging a
// call must never delay or fail the call itself. Callers should not await these
// on the request path.

import { createClient } from '@supabase/supabase-js';

const WRITE_TIMEOUT_MS = 2500;

let client; // undefined = not yet initialised, null = disabled

// Built on first use, not at import time — index.js runs dotenv.config() after
// module evaluation, so reading credentials at module scope sees nothing.
function getClient() {
    if (client !== undefined) return client;

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_CONFIG_ENABLED } = process.env;
    client = SUPABASE_CONFIG_ENABLED === 'true' && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
        : null;

    return client;
}

async function withTimeout(query, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${WRITE_TIMEOUT_MS}ms`)), WRITE_TIMEOUT_MS);
    });

    try {
        const { error } = await Promise.race([query, timeout]);
        if (error) throw new Error(error.message);
    } finally {
        clearTimeout(timer);
    }
}

// Called once a call has been created or answered. `otherParty` is whoever we
// are talking to: the callee outbound, the caller inbound.
export async function recordCall({ callSid, otherParty, direction, config, metadata = {} }) {
    const db = getClient();
    if (!db || !callSid) return;

    try {
        await withTimeout(
            db.from('calls').upsert({
                twilio_call_sid: callSid,
                phone_number: otherParty || 'unknown',
                direction,
                status: 'initiated',
                system_prompt: config?.systemMessage ?? null,
                metadata: { model: config?.model, voice: config?.voice, effort: config?.effort, ...metadata },
                started_at: new Date().toISOString(),
            }, { onConflict: 'twilio_call_sid' }),
            'Call record insert'
        );
    } catch (error) {
        console.warn(`Could not record ${direction} call ${callSid}: ${error.message}`);
    }
}

// Called from Twilio's status callback as the call progresses.
export async function updateCallStatus({ callSid, status, durationSeconds }) {
    const db = getClient();
    if (!db || !callSid) return;

    const finished = ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status);
    const patch = { status };
    if (finished) patch.ended_at = new Date().toISOString();
    if (Number.isFinite(durationSeconds)) patch.duration_seconds = durationSeconds;

    try {
        await withTimeout(
            db.from('calls').update(patch).eq('twilio_call_sid', callSid),
            'Call status update'
        );
    } catch (error) {
        console.warn(`Could not update status for ${callSid}: ${error.message}`);
    }
}

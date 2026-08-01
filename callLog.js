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
        const { data, error } = await Promise.race([query, timeout]);
        if (error) throw new Error(error.message);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

// Called once a call has been created or answered. `otherParty` is whoever we
// are talking to: the callee outbound, the caller inbound. `status` is the
// call's state at the moment we record it — we create an outbound call
// ourselves, but only hear about an inbound one once it is already ringing.
export async function recordCall({ callSid, otherParty, direction, config, status = 'initiated', metadata = {} }) {
    const db = getClient();
    if (!db || !callSid) return;

    try {
        const row = {
            twilio_call_sid: callSid,
            phone_number: otherParty || 'unknown',
            direction,
            status,
            system_prompt: config?.systemMessage ?? null,
            metadata: { model: config?.model, voice: config?.voice, effort: config?.effort, ...metadata },
            started_at: new Date().toISOString(),
        };

        // Link the call to the contact, the way SMS threads are linked, so a
        // person's calls can be found without matching on phone number. Set
        // only when one exists: the upsert writes every column it is given, so
        // a null here would clear the link if this call were ever re-recorded.
        if (otherParty) {
            const contact = await withTimeout(
                db.from('contacts').select('id').eq('phone_number', otherParty).maybeSingle(),
                'Contact lookup for call record'
            );
            if (contact?.id) row.contact_id = contact.id;
        }

        await withTimeout(
            db.from('calls').upsert(row, { onConflict: 'twilio_call_sid' }),
            'Call record insert'
        );
    } catch (error) {
        console.warn(`Could not record ${direction} call ${callSid}: ${error.message}`);
    }
}

// Records one tool invocation and its result. Fire-and-forget like the rest of
// this module: the model is already being answered, and losing the audit row
// must not delay that. Stores the result, not just the fact of the call, so a
// conversation can be reconstructed afterwards.
export async function recordToolCall({ callSid, openAiCallId, name, args, result, error, durationMs }) {
    const db = getClient();
    if (!db || !name) return;

    try {
        const row = {
            twilio_call_sid: callSid ?? null,
            openai_call_id: openAiCallId ?? null,
            tool_name: name,
            arguments: args ?? null,
            result: result ?? null,
            error: error ?? null,
            duration_ms: Number.isFinite(durationMs) ? durationMs : null,
        };

        // Link to the call row when there is one, so tool calls can be read
        // back with the call instead of joined on the Twilio SID by hand.
        if (callSid) {
            const call = await withTimeout(
                db.from('calls').select('id').eq('twilio_call_sid', callSid).maybeSingle(),
                'Call lookup for tool call'
            );
            if (call?.id) row.call_id = call.id;
        }

        await withTimeout(db.from('tool_calls').insert(row), 'Tool call insert');
    } catch (error) {
        console.warn(`Could not record tool call ${name}: ${error.message}`);
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

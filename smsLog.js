// Records SMS in public.sms_messages so a conversation can be read back after
// the fact rather than reconstructed from logs.
//
// Threading is deliberately flat. sms_messages.thread_id is NOT NULL, so a
// thread row must exist, but nothing here ever splits one: sms_threads has a
// UNIQUE (phone_number, twilio_number), so each contact/line pair gets exactly
// one thread that is reused forever. The effect is a single running log per
// contact, and real threading can be layered on later without a migration.
//
// Every function is fire-and-forget and swallows its own errors: recording a
// message must never fail or delay sending one.

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

function withTimeout(query, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${WRITE_TIMEOUT_MS}ms`)), WRITE_TIMEOUT_MS);
    });

    return Promise.race([query, timeout]).finally(() => clearTimeout(timer));
}

// Finds or creates the one thread for this conversation and returns its id.
// The upsert doubles as the "touch" that keeps last_message_at current.
async function ensureThread(db, otherParty, twilioNumber) {
    const row = {
        phone_number: otherParty,
        twilio_number: twilioNumber,
        last_message_at: new Date().toISOString(),
    };

    // Link the thread to the contact when one exists. Set only when found: an
    // upsert writes every column it is given, so sending null here would clear
    // the link on an existing thread.
    const { data: contact } = await withTimeout(
        db.from('contacts').select('id').eq('phone_number', otherParty).maybeSingle(),
        'Contact lookup for SMS thread'
    );
    if (contact?.id) row.contact_id = contact.id;

    const { data, error } = await withTimeout(
        db.from('sms_threads')
            .upsert(row, { onConflict: 'phone_number,twilio_number' })
            .select('id')
            .single(),
        'SMS thread upsert'
    );

    if (error) throw new Error(error.message);
    return data.id;
}

// Records one message. `otherParty` is the contact's number in both directions;
// `twilioNumber` is always our line. Inbound messages come from a person, so
// they are the 'user' role; outbound ones are sent by the assistant.
export async function recordMessage({ otherParty, twilioNumber, direction, body, messageSid, status }) {
    const db = getClient();
    if (!db || !otherParty || !twilioNumber) return;

    try {
        const threadId = await ensureThread(db, otherParty, twilioNumber);

        const { error } = await withTimeout(
            db.from('sms_messages').insert({
                thread_id: threadId,
                twilio_message_sid: messageSid ?? null,
                direction,
                role: direction === 'inbound' ? 'user' : 'assistant',
                content: body ?? '',
                status: status ?? null,
            }),
            'SMS message insert'
        );

        if (error) throw new Error(error.message);
    } catch (error) {
        console.warn(`Could not record ${direction} SMS for ${otherParty}: ${error.message}`);
    }
}

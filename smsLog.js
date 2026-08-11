// Records SMS in public.sms_messages so a conversation can be read back after
// the fact rather than reconstructed from logs.
//
// sms_threads remains the provider-native phone/line log. Semantic threads are
// separate: communication_threads can span SMS, calls, email and any future
// channel while retaining an explicit purpose such as a Hyperflow Ask.
//
// Every function is fire-and-forget and swallows its own errors: recording a
// message must never fail or delay sending one.

import { createClient } from '@supabase/supabase-js';
import { normaliseCorrelation, normalisePurpose, prefixedId, resolveCommunicationThread } from './communicationModel.js';

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
export async function recordMessage({
    otherParty,
    twilioNumber,
    direction,
    body,
    messageSid,
    status,
    communicationId = prefixedId('comm'),
    purpose = null,
    correlation = {},
    threadId = null,
    callbackUrl = null,
    strict = false,
}) {
    const db = getClient();
    if (!db || !otherParty || !twilioNumber) {
        if (strict) throw new Error('Communications persistence is not configured');
        return null;
    }

    try {
        const canonicalPurpose = normalisePurpose(purpose);
        const canonicalCorrelation = normaliseCorrelation(correlation);
        const semantic = await resolveCommunicationThread({
            db,
            participantIdentity: otherParty,
            serviceIdentity: twilioNumber,
            direction,
            threadId,
            purpose: canonicalPurpose,
            correlation: canonicalCorrelation,
            callbackUrl,
        });
        const nativeThreadId = await ensureThread(db, otherParty, twilioNumber);

        const { error } = await withTimeout(
            db.from('sms_messages').insert({
                thread_id: nativeThreadId,
                twilio_message_sid: messageSid ?? null,
                direction,
                role: direction === 'inbound' ? 'user' : 'assistant',
                content: body ?? '',
                status: status ?? null,
                communication_id: communicationId,
                purpose: semantic.purpose,
                correlation: semantic.correlation,
                communication_thread_id: semantic.threadId,
                thread_link_type: semantic.linkType,
            }),
            'SMS message insert'
        );

        if (error) throw new Error(error.message);
        return {
            communicationId,
            threadId: semantic.threadId,
            purpose: semantic.purpose,
            correlation: semantic.correlation,
            callbackUrl: semantic.callbackUrl,
        };
    } catch (error) {
        if (strict) throw error;
        console.warn(`Could not record ${direction} SMS for ${otherParty}: ${error.message}`);
        return null;
    }
}

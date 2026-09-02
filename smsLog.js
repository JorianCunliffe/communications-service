// Records SMS in public.sms_messages so a conversation can be read back after
// the fact rather than reconstructed from logs.
//
// sms_threads remains the provider-native phone/line log. Semantic threads are
// separate: communication_threads can span SMS, calls, email and any future
// channel while retaining an explicit purpose such as a Hyperflow Ask.
//
// Every function is fire-and-forget and swallows its own errors: recording a
// message must never fail or delay sending one.

import { normaliseCorrelation, normalisePurpose, prefixedId, resolveCommunicationThread } from './communicationModel.js';
import { getDatabase } from './database.js';

const WRITE_TIMEOUT_MS = 2500;

function getClient() {
    return getDatabase();
}

export async function tenantForMessage(db, messageSid, tenantId = null) {
    if (!db || !messageSid) throw new Error('messageSid is required for SMS tenant resolution');
    let query = db.from('sms_messages').select('tenant_id').eq('twilio_message_sid', messageSid);
    if (tenantId) query = query.eq('tenant_id', tenantId);
    const { data, error } = await query.limit(2);
    if (error) throw new Error(`SMS tenant lookup failed: ${error.message}`);
    const matches = Array.isArray(data) ? data : (data ? [data] : []);
    if (matches.length !== 1) {
        const qualifier = tenantId ? ' for the supplied tenant' : '';
        throw new Error(`MessageSid did not resolve to exactly one message${qualifier}`);
    }
    return matches[0].tenant_id;
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
async function ensureThread(db, tenantId, otherParty, twilioNumber, personId = null) {
    const row = {
        tenant_id: tenantId,
        phone_number: otherParty,
        twilio_number: twilioNumber,
        last_message_at: new Date().toISOString(),
    };

    // Link the thread to the contact when one exists. Set only when found: an
    // upsert writes every column it is given, so sending null here would clear
    // the link on an existing thread.
    if (personId) {
        row.contact_id = personId;
    } else {
        const { data: contact } = await withTimeout(
            db.from('contacts').select('id').eq('tenant_id', tenantId).eq('phone_number', otherParty).maybeSingle(),
            'Contact lookup for SMS thread'
        );
        if (contact?.id) row.contact_id = contact.id;
    }

    const { data, error } = await withTimeout(
        db.from('sms_threads')
            .upsert(row, { onConflict: 'tenant_id,phone_number,twilio_number' })
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
    tenantId = null,
    strict = false,
}) {
    const db = getClient();
    if (!db || !otherParty || !twilioNumber) {
        if (strict) throw new Error('Communications persistence is not configured');
        return null;
    }

    try {
        const scopedTenant = tenantId || correlation?.tenant_id || db?.tenantId || process.env.LEGACY_TENANT_ID;
        if (!scopedTenant) throw new Error('tenant_id is required for SMS persistence');
        const canonicalPurpose = normalisePurpose(purpose);
        const canonicalCorrelation = normaliseCorrelation({ ...correlation, tenant_id: scopedTenant });
        const semantic = await resolveCommunicationThread({
            db,
            tenantId: scopedTenant,
            participantIdentity: otherParty,
            serviceIdentity: twilioNumber,
            direction,
            threadId,
            purpose: canonicalPurpose,
            correlation: canonicalCorrelation,
            callbackUrl,
        });
        const nativeThreadId = await ensureThread(db, scopedTenant, otherParty, twilioNumber, semantic.personId);

        const { error } = await withTimeout(
            db.from('sms_messages').insert({
                tenant_id: scopedTenant,
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

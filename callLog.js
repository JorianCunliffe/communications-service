// Records calls in public.calls so a call's outcome can be inspected after the
// fact rather than inferred from logs.
//
// Every function here is fire-and-forget and swallows its own errors: logging a
// call must never delay or fail the call itself. Callers should not await these
// on the request path.

import { normaliseCorrelation, normalisePurpose, prefixedId, resolveCommunicationThread } from './communicationModel.js';
import { callbackForThread, enqueueEvent } from './eventOutbox.js';
import { getDatabase } from './database.js';

const WRITE_TIMEOUT_MS = 2500;

function getClient() {
    return getDatabase();
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
export async function recordCall({
    callSid,
    otherParty,
    serviceIdentity = null,
    direction,
    config,
    status = 'initiated',
    metadata = {},
    communicationId = prefixedId('comm'),
    purpose = null,
    correlation = {},
    threadId = null,
    callbackUrl = null,
    strict = false,
}) {
    const db = getClient();
    if (!db || !callSid) {
        if (strict) throw new Error('Communications persistence is not configured');
        return null;
    }

    try {
        const semantic = await resolveCommunicationThread({
            db,
            participantIdentity: otherParty,
            serviceIdentity,
            direction,
            threadId,
            purpose: normalisePurpose(purpose),
            correlation: normaliseCorrelation(correlation),
            callbackUrl,
        });
        const row = {
            twilio_call_sid: callSid,
            phone_number: otherParty || 'unknown',
            direction,
            status,
            system_prompt: config?.systemMessage ?? null,
            // aiSpeaksFirst is carried because the recording pipeline needs it
            // later: it decides which diarised speaker is the assistant, and by
            // then the call's config is long gone.
            metadata: {
                model: config?.model, voice: config?.voice, effort: config?.effort,
                aiSpeaksFirst: config?.aiSpeaksFirst ?? null,
                summarise: config?.summarise ?? null,
                ...metadata,
            },
            started_at: new Date().toISOString(),
            communication_id: communicationId,
            purpose: semantic.purpose,
            correlation: semantic.correlation,
            communication_thread_id: semantic.threadId,
            thread_link_type: semantic.linkType,
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
        return {
            communicationId,
            threadId: semantic.threadId,
            purpose: semantic.purpose,
            correlation: semantic.correlation,
            callbackUrl: semantic.callbackUrl,
        };
    } catch (error) {
        if (strict) throw error;
        console.warn(`Could not record ${direction} call ${callSid}: ${error.message}`);
        return null;
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

// Stores a finished transcript against a call. Fire-and-forget like everything
// else here: it is written after the call has already ended, so nobody is
// waiting, and losing it must not raise into the WebSocket close handler.
//
// Only writes a non-empty transcript. A call where nobody spoke produces a
// valid transcript with no segments, and letting that overwrite a real one —
// from the recording pipeline, say, arriving later — would lose data.
export async function saveTranscript({ callSid, transcript, status = 'completed' }) {
    const db = getClient();
    if (!db || !callSid || !transcript?.segments?.length) return;

    try {
        await withTimeout(
            db.from('calls')
                .update({ transcript, transcription_status: status, transcription_error: null })
                .eq('twilio_call_sid', callSid),
            'Transcript update'
        );
        const lost = transcript.unintelligible
            ? `, ${transcript.unintelligible} turn(s) unintelligible`
            : '';
        console.log(`Stored ${transcript.segments.length}-segment transcript for ${callSid}${lost}`);

        const communication = await withTimeout(
            db.from('calls').select('communication_id,purpose,correlation,communication_thread_id')
                .eq('twilio_call_sid', callSid).maybeSingle(),
            'Transcript event lookup'
        );
        if (communication?.communication_id) {
            const destination = await callbackForThread(communication.communication_thread_id);
            await enqueueEvent({
                type: 'transcript.completed',
                communicationId: communication.communication_id,
                purpose: communication.purpose,
                correlation: communication.correlation || {},
                destination,
                payload: { channel: 'voice', transcript },
            });
            // A transcript is evidence, not proof that the intended human
            // answered. The durable call-outcome finalizer emits an Ask
            // response only after it has ruled out voicemail, wrong number,
            // automation and an empty/non-substantive interaction.
        }
    } catch (error) {
        console.warn(`Could not store transcript for ${callSid}: ${error.message}`);
    }
}

// Records that transcription was attempted and failed, so a call with no
// transcript can be told apart from a call nobody has tried to transcribe.
export async function saveTranscriptionError({ callSid, message }) {
    const db = getClient();
    if (!db || !callSid) return;

    try {
        await withTimeout(
            db.from('calls')
                .update({ transcription_status: 'failed', transcription_error: String(message).slice(0, 500) })
                .eq('twilio_call_sid', callSid),
            'Transcription error update'
        );
    } catch (error) {
        console.warn(`Could not record transcription failure for ${callSid}: ${error.message}`);
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
        return await withTimeout(
            db.from('calls').select('communication_id,purpose,correlation,communication_thread_id').eq('twilio_call_sid', callSid).maybeSingle(),
            'Call event lookup'
        );
    } catch (error) {
        console.warn(`Could not update status for ${callSid}: ${error.message}`);
        return null;
    }
}

// Stores Twilio's AnsweredBy signal separately from provider call status.
// Machine/fax is decisive failure evidence; "human" still requires transcript
// validation so a wrong number cannot become a successful call.
export async function recordAnswerDetection({ callSid, answeredBy, durationMs }) {
    const db = getClient();
    if (!db || !callSid || !answeredBy) return null;
    const metadataPatch = { answered_by: String(answeredBy) };
    if (Number.isFinite(durationMs)) metadataPatch.machine_detection_duration_ms = Number(durationMs);
    try {
        const current = await withTimeout(
            db.from('calls').select('metadata').eq('twilio_call_sid', callSid).maybeSingle(),
            'Answer detection lookup'
        );
        const updated = await withTimeout(
            db.from('calls').update({
                answered_by: String(answeredBy),
                metadata: { ...(current?.metadata || {}), ...metadataPatch },
            }).eq('twilio_call_sid', callSid).select('id').maybeSingle(),
            'Answer detection update'
        );
        return updated;
    } catch (error) {
        console.warn(`Could not store answer detection for ${callSid}: ${error.message}`);
        return null;
    }
}

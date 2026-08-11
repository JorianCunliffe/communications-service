// The recordings queue: rows in, transcripts out.
//
// A row is created the moment we learn audio exists — from Twilio's status
// callback, or from an API push — and a background sweeper drains the queue.
// Nothing transcribes inline, because transcription takes tens of seconds and
// every path that creates a row is a webhook or a request that has to answer
// immediately.
//
// The queue is a table rather than an in-memory list so a restart mid-job is
// recoverable, and so "why has this not been transcribed" is answerable by
// looking at a row instead of by reading logs that have rotated away.

import { getSupabase } from './configResolver.js';
import { transcribeAudio } from './transcribe.js';
import { toText, isEmpty } from './transcripts.js';
import { sourceFor } from './recordingSources.js';
import { saveTranscript, saveTranscriptionError } from './callLog.js';
import { summariseCall } from './summarise.js';

const SWEEP_INTERVAL_MS = 15 * 1000;
const MAX_ATTEMPTS = 5;

// A row left mid-flight by a restart. Long enough that a genuinely running job
// is never stolen — transcription is bounded at five minutes.
const STALE_CLAIM_MS = 15 * 60 * 1000;

// One at a time. Transcription is not latency-sensitive, and a burst of pushed
// recordings should not open twenty concurrent uploads on a small instance.
//
// Held as the in-flight promise rather than a boolean so that a second caller
// awaits the sweep already running instead of returning as though the work were
// done. Both the interval and the nudge after an enqueue call this, and
// "awaiting a sweep" has to mean the queue was actually drained.
let running = null;
let sweeper = null;

// Creates a row, or does nothing if this recording is already known. The unique
// index on (source, external_id) is what makes that safe: Twilio retries status
// callbacks and an MCP server will re-push, and neither should produce a second
// transcription of the same audio.
export async function enqueueRecording(recording) {
    const db = getSupabase();
    if (!db) return null;

    const row = {
        source: recording.source,
        external_id: recording.externalId ?? null,
        call_id: recording.callId ?? null,
        contact_id: recording.contactId ?? null,
        phone_number: recording.phoneNumber ?? null,
        media_url: recording.mediaUrl ?? null,
        media_auth: recording.mediaAuth ?? null,
        duration_seconds: recording.durationSeconds ?? null,
        channels: recording.channels ?? null,
        recorded_at: recording.recordedAt ?? new Date().toISOString(),
        status: recording.status ?? 'pending',
        participant_identities: recording.participants ?? [],
        calendar_event_id: recording.calendarEventId ?? null,
        project_id: recording.projectId ?? null,
        communication_thread_id: recording.threadId ?? null,
        title: recording.title ?? null,
        meeting_type: recording.meetingType ?? null,
        metadata: recording.metadata ?? {},
    };

    // A transcript supplied by the caller means there is nothing to transcribe.
    if (recording.transcript) {
        row.transcript = recording.transcript;
        row.transcript_text = toText(recording.transcript);
        row.provider = recording.transcript.provider ?? 'external';
        row.model = recording.transcript.model ?? null;
        row.status = 'done';
    }

    const { data, error } = await db
        .from('recordings')
        .upsert(row, { onConflict: 'source,external_id', ignoreDuplicates: true })
        .select('id, status')
        .maybeSingle();

    // Three outcomes, kept distinct on purpose. "Already known" is the normal
    // result of a retry and is not a problem; a database error is. Collapsing
    // both to null made a broken insert look exactly like successful
    // deduplication, which is how the missing index went unnoticed until the
    // queue was tested directly.
    if (error) {
        console.warn(`Could not enqueue ${recording.source} recording: ${error.message}`);
        return { error: error.message };
    }

    // ignoreDuplicates makes this ON CONFLICT DO NOTHING, which returns nothing
    // when the row already existed.
    if (!data) {
        console.log(`Recording ${recording.source}/${recording.externalId} already known — ignoring duplicate`);
        return { duplicate: true };
    }

    console.log(`Queued ${recording.source} recording ${recording.externalId ?? data.id} (${data.status})`);

    // A pushed recording should not wait up to a sweep interval.
    if (data.status === 'pending') setImmediate(() => sweepOnce());
    return { id: data.id };
}

// Takes one row and marks it in flight. A conditional update rather than a
// plain one: the status is part of the WHERE clause, so if anything else has
// already claimed this row the update matches nothing and we move on. That is
// the whole concurrency story, and it is enough for one process.
async function claimNext(db) {
    const nowIso = new Date().toISOString();
    const staleIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString();

    const { data: candidates, error } = await db
        .from('recordings')
        .select('*')
        .or(`and(status.eq.pending,next_attempt_at.lte.${nowIso}),and(status.eq.transcribing,claimed_at.lt.${staleIso})`)
        .order('next_attempt_at', { ascending: true })
        .limit(1);

    if (error) throw new Error(error.message);
    if (!candidates?.length) return null;

    const candidate = candidates[0];
    const { data: claimed, error: claimError } = await db
        .from('recordings')
        .update({ status: 'transcribing', claimed_at: nowIso, attempts: candidate.attempts + 1 })
        .eq('id', candidate.id)
        .eq('status', candidate.status) // lost the race if this no longer holds
        .select('*')
        .maybeSingle();

    if (claimError) throw new Error(claimError.message);
    if (claimed && candidate.status === 'transcribing') {
        console.warn(`Reclaimed recording ${claimed.id}, left mid-transcription by a restart`);
    }
    return claimed ?? null;
}

async function fail(db, recording, message) {
    const permanent = recording.attempts >= MAX_ATTEMPTS;
    // Backs off 30s, 60s, 2m, 4m… so a provider having a bad minute is not
    // hammered, and a genuinely broken row stops consuming sweeps.
    const delayMs = Math.min(30_000 * 2 ** Math.max(0, recording.attempts - 1), 15 * 60 * 1000);

    await db.from('recordings').update({
        status: permanent ? 'failed' : 'pending',
        error: String(message).slice(0, 1000),
        next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
    }).eq('id', recording.id);

    // The call row should say transcription was tried and did not work, so an
    // empty transcript is distinguishable from one nobody attempted.
    if (permanent && recording.call_id) {
        const { data: call } = await db.from('calls').select('twilio_call_sid').eq('id', recording.call_id).maybeSingle();
        if (call?.twilio_call_sid) await saveTranscriptionError({ callSid: call.twilio_call_sid, message });
    }

    console.warn(`Recording ${recording.id} ${permanent ? 'failed permanently' : `will retry in ${Math.round(delayMs / 1000)}s`}: ${message}`);
}

// The audio is deleted only here, after the transcript is committed. Ordering
// is the point: a crash between the two leaves audio that can be transcribed
// again, whereas the other order leaves nothing at all.
async function process(db, recording) {
    const source = sourceFor(recording.source);
    const started = Date.now();

    const { buffer, contentType, filename } = await source.fetch(recording);
    const transcript = await transcribeAudio({
        buffer,
        filename,
        contentType,
        speakerRoles: source.speakerRoles(recording),
        channel: recording.call_id ? 'call' : 'recording',
    });

    if (isEmpty(transcript)) throw new Error('Transcription returned no speech');

    const { error } = await db.from('recordings').update({
        status: 'done',
        transcript,
        transcript_text: toText(transcript),
        provider: transcript.provider,
        model: transcript.model,
        bytes: buffer.length,
        content_type: contentType,
        error: null,
    }).eq('id', recording.id);
    if (error) throw new Error(`Storing the transcript failed: ${error.message}`);

    // Project onto the call, if this recording belongs to one. saveTranscript
    // refuses an empty transcript, so it cannot blank a live one.
    if (recording.call_id) {
        const { data: call } = await db.from('calls').select('twilio_call_sid').eq('id', recording.call_id).maybeSingle();
        if (call?.twilio_call_sid) {
            await saveTranscript({ callSid: call.twilio_call_sid, transcript });
            // summariseCall is a no-op when a summary already exists, so a call
            // whose live transcript was summarised is not summarised twice.
            if (recording.metadata?.summarise) await summariseCall(call.twilio_call_sid);
        }
    }

    console.log(`Transcribed recording ${recording.id}: ${transcript.segments.length} segments in ${Date.now() - started}ms`);

    if (source.cleanup) {
        try {
            await source.cleanup(recording);
            await db.from('recordings').update({ media_url: null, metadata: { ...recording.metadata, audioDeleted: true } }).eq('id', recording.id);
            if (recording.call_id) await db.from('calls').update({ recording_status: 'deleted' }).eq('id', recording.call_id);
            console.log(`Deleted source audio for recording ${recording.id}`);
        } catch (error) {
            // The transcript is stored, which was the point. Undeleted audio is
            // a cost problem, not a data problem, and must not fail the job.
            console.warn(`Transcript stored but source audio remains for ${recording.id}: ${error.message}`);
        }
    }
}

export function sweepOnce() {
    const db = getSupabase();
    if (!db) return Promise.resolve();
    if (running) return running;

    running = (async () => {
        try {
            let recording;
            while ((recording = await claimNext(db))) {
                try {
                    await process(db, recording);
                } catch (error) {
                    await fail(db, recording, error.message);
                }
            }
        } catch (error) {
            console.warn(`Recording sweep failed: ${error.message}`);
        } finally {
            running = null;
        }
    })();

    return running;
}

export function startRecordingSweeper() {
    if (sweeper || !getSupabase()) return;
    sweeper = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
    sweeper.unref?.();
    console.log('Recording sweeper started');
}

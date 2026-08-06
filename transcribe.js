// Speech to text over a recording, normalised into the shared transcript shape.
//
// One provider today. The interface is a single function taking audio bytes and
// returning a transcript, so a second provider is a new branch here rather than
// a change anywhere else — nothing upstream knows what did the transcribing.
//
// Diarisation is the interesting part. A recording, unlike a live Realtime
// session, does not come with speaker attribution: it is one audio file with
// voices in it. The model returns speakers as A, B, C, which is honest but not
// useful on its own, so callers may pass a hint mapping those labels onto
// roles. Where no hint is available the labels are kept and the role stays
// 'unknown' — a wrong guess about who said what is worse than admitting the
// recording does not say.

import { buildTranscript } from './transcripts.js';

// The API rejects anything larger. Checked before uploading so the failure is a
// clear message rather than a rejected request after a long upload.
export const MAX_BYTES = 25 * 1024 * 1024;

const DEFAULT_MODEL = 'gpt-4o-transcribe-diarize';
const TIMEOUT_MS = 5 * 60 * 1000;

export function transcriptionModel() {
    return process.env.TRANSCRIBE_MODEL || DEFAULT_MODEL;
}

// Turns the provider's segments into ours. `speakerRoles` maps a provider label
// ('A') onto a role ('assistant'); anything unmapped stays 'unknown' with its
// original label intact, so a later pass can still work out who was who.
function normalise(payload, { model, speakerRoles = {}, channel = 'recording' }) {
    const segments = Array.isArray(payload?.segments) ? payload.segments : [];

    // A model that returns no segments but does return text still gave us the
    // conversation — better one unattributed block than nothing.
    if (segments.length === 0 && typeof payload?.text === 'string' && payload.text.trim() !== '') {
        return buildTranscript({
            channel,
            provider: 'openai',
            model,
            segments: [{ role: 'unknown', speaker: null, text: payload.text }],
        });
    }

    return buildTranscript({
        channel,
        provider: 'openai',
        model,
        language: payload?.language ?? null,
        segments: segments.map((segment) => ({
            role: speakerRoles[segment?.speaker] ?? 'unknown',
            speaker: segment?.speaker ?? null,
            text: segment?.text,
            // The API reports seconds; the shape uses milliseconds.
            startMs: Number.isFinite(segment?.start) ? segment.start * 1000 : null,
            endMs: Number.isFinite(segment?.end) ? segment.end * 1000 : null,
        })),
    });
}

// Transcribes audio. Throws on failure rather than returning an error shape:
// unlike a tool call during a conversation, nobody is waiting on this in real
// time, and the caller records the failure and retries.
export async function transcribeAudio({ buffer, filename = 'audio.mp3', contentType = 'audio/mpeg', speakerRoles, channel }) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    if (!buffer?.length) throw new Error('No audio to transcribe');
    if (buffer.length > MAX_BYTES) {
        // Deliberately a hard failure. Transcribing the first 25MB of a longer
        // recording would produce a transcript that looks complete and is not,
        // which is worse than a job that plainly did not run.
        throw new Error(`Recording is ${Math.round(buffer.length / 1024 / 1024)}MB; the limit is 25MB. Chunking is not implemented.`);
    }

    const model = transcriptionModel();
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: contentType }), filename);
    form.append('model', model);

    // Only the diarising model understands this format; asking for it from any
    // other model is an error rather than a graceful downgrade.
    if (model.includes('diarize')) {
        form.append('response_format', 'diarized_json');
        form.append('chunking_strategy', 'auto');
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Transcription failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
    }

    const payload = await response.json();
    return normalise(payload, { model, speakerRoles, channel });
}

// Exported for tests: the normalisation is where the shape decisions live, and
// it should be checkable without spending money on a transcription.
export const __normalise = normalise;

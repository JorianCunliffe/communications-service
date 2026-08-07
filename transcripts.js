// The one transcript shape, and nothing else.
//
// Two very different things produce transcripts here: the Realtime session,
// which knows exactly who said what because it is both parties, and a
// speech-to-text pass over a recording, which has to infer it. A third will
// arrive when Plaud pushes in its own already-transcribed notes. If each wrote
// its own structure, every consumer would grow a branch per producer.
//
// So they all converge here first. The segment fields are deliberately the ones
// the planned cross-channel context provider needs — { role, content, at,
// channel } — so a transcript is already the thing history is built from rather
// than something that has to be converted into it later.
//
// Pure functions only. No database, no network, no clock beyond what is passed
// in. This is the piece everything else depends on, which makes it the piece
// worth being able to test without any of the rest running.

export const TRANSCRIPT_VERSION = 1;

// Who a segment is attributed to. 'user' is whoever is not us; 'assistant' is
// Iris. 'unknown' is honest rather than convenient — a diarised recording of a
// meeting has speakers we cannot name, and guessing would be worse than saying
// so.
const ROLES = ['user', 'assistant', 'unknown'];

// Where the audio came from, for consumers that care.
const CHANNELS = ['call', 'sms', 'recording', 'other'];

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

// One turn. Text is required and everything else is optional, because a
// provider that gives only "who said what" is still useful — losing timing
// should cost ordering precision, not the whole transcript.
export function buildSegment({ role, speaker, text, startMs, endMs, at }) {
    const content = String(text ?? '').trim();
    if (content === '') return null; // empty turns are noise, not data

    return {
        role: ROLES.includes(role) ? role : 'unknown',
        // The raw label from the producer — 'caller', 'Speaker 1', a channel
        // number. Kept alongside role rather than replaced by it, because it is
        // the only way back to what the provider actually said.
        speaker: speaker ? String(speaker) : null,
        text: content,
        startMs: isFiniteNumber(startMs) ? Math.max(0, Math.round(startMs)) : null,
        endMs: isFiniteNumber(endMs) ? Math.max(0, Math.round(endMs)) : null,
        at: at ?? null,
    };
}

// Stable ordering by start time, with arrival order as the tiebreak.
//
// A segment with no start time takes the start of the last one that had one.
// The obvious alternative — "compare by index when either lacks a time" — is
// not a consistent comparator: with a timed segment, then an untimed one, then
// an earlier timed one, it says A<B, B<C and C<A at the same time, and the
// result depends on the sort implementation. Carrying the last known time
// forward keeps every comparison consistent and puts an untimed segment where
// it actually arrived, which is what the intent was.
export function orderSegments(segments) {
    let carried = 0;
    const keyed = segments.map((segment, index) => {
        if (isFiniteNumber(segment.startMs)) carried = segment.startMs;
        return { segment, index, sortAt: carried };
    });

    return keyed
        .sort((a, b) => (a.sortAt !== b.sortAt ? a.sortAt - b.sortAt : a.index - b.index))
        .map((entry) => entry.segment);
}

// Assembles a transcript. Segments that are empty or unusable are dropped here
// rather than by each caller.
export function buildTranscript({ channel = 'call', provider = null, model = null, language = null, segments = [] } = {}) {
    const usable = segments
        .map((segment) => (segment && typeof segment === 'object' && 'text' in segment ? buildSegment(segment) : null))
        .filter(Boolean);

    return {
        version: TRANSCRIPT_VERSION,
        channel: CHANNELS.includes(channel) ? channel : 'other',
        language,
        provider,
        model,
        segments: orderSegments(usable),
        // Turns that happened but produced no text.
        //
        // Empty turns stay out of `segments` — they are noise, and inventing a
        // placeholder would put words that were never said into a transcript
        // that later feeds prompts. But dropping them silently made a real call
        // unreadable: the caller spoke for 908ms, transcription came back with
        // nothing, and the stored transcript showed the assistant replying to
        // no one. "They said something we could not make out" and "they said
        // nothing" are different facts, and only one of them explains a reply.
        unintelligible: segments.length - usable.length,
    };
}

// True when there is nothing worth storing. A call where nobody spoke produces
// a valid transcript with no segments, and writing that over a real one would
// lose data — callers check this before saving.
export function isEmpty(transcript) {
    return !transcript || !Array.isArray(transcript.segments) || transcript.segments.length === 0;
}

// A speaker label for display and for the flattened text. Prefers what the
// producer called them, falls back to the role.
function label(segment) {
    if (segment.speaker) return segment.speaker;
    if (segment.role === 'assistant') return 'assistant';
    if (segment.role === 'user') return 'caller';
    return 'unknown';
}

// Flattens to plain text, for full-text search, for a summariser prompt, and
// for anywhere a human just wants to read the conversation.
export function toText(transcript) {
    if (isEmpty(transcript)) return '';
    return transcript.segments.map((segment) => `${label(segment)}: ${segment.text}`).join('\n');
}

// Rejects anything that is not this shape. Used on the ingest path, where the
// transcript arrives from outside — Plaud, or whatever an MCP server sends —
// and must not be trusted to be well formed just because it is JSON.
export function validate(transcript) {
    if (!transcript || typeof transcript !== 'object') return 'Transcript must be an object';
    if (!Array.isArray(transcript.segments)) return 'Transcript needs a segments array';
    if (transcript.segments.length === 0) return 'Transcript has no segments';

    for (const [index, segment] of transcript.segments.entries()) {
        if (!segment || typeof segment !== 'object') return `Segment ${index} is not an object`;
        if (typeof segment.text !== 'string' || segment.text.trim() === '') {
            return `Segment ${index} has no text`;
        }
    }
    return null;
}

// Normalises a transcript that came from outside into ours, keeping only fields
// we understand. An unrecognised role becomes 'unknown' rather than being
// rejected: a source that labels turns its own way is still worth ingesting.
export function fromExternal(raw, { channel = 'recording', provider = 'external' } = {}) {
    const segments = Array.isArray(raw?.segments) ? raw.segments : [];
    return buildTranscript({
        channel,
        provider: raw?.provider ?? provider,
        model: raw?.model ?? null,
        language: raw?.language ?? null,
        segments: segments.map((segment) => ({
            role: segment?.role,
            speaker: segment?.speaker,
            text: segment?.text ?? segment?.content,
            startMs: segment?.startMs ?? (isFiniteNumber(segment?.start) ? segment.start * 1000 : null),
            endMs: segment?.endMs ?? (isFiniteNumber(segment?.end) ? segment.end * 1000 : null),
            at: segment?.at ?? null,
        })),
    });
}

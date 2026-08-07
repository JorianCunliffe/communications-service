/**
 * Unit tests for the transcript shape.
 *
 * These need no server, no database and no network — that is the point of
 * transcripts.js being pure. Run with the rest of the suite, or alone:
 *   node --test --test-reporter=spec test/transcripts.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    TRANSCRIPT_VERSION,
    buildSegment,
    buildTranscript,
    orderSegments,
    isEmpty,
    toText,
    validate,
    fromExternal,
} from '../transcripts.js';

describe('transcripts – segments', () => {
    test('keeps text, role and timing', () => {
        const segment = buildSegment({ role: 'user', speaker: 'caller', text: 'hello', startMs: 100, endMs: 900 });
        assert.equal(segment.role, 'user');
        assert.equal(segment.speaker, 'caller');
        assert.equal(segment.text, 'hello');
        assert.equal(segment.startMs, 100);
        assert.equal(segment.endMs, 900);
    });

    test('drops an empty or whitespace-only turn', () => {
        // Speech detection fires on noise. A blank turn is not data, and
        // storing it would put empty lines through to the summariser.
        assert.equal(buildSegment({ role: 'user', text: '   ' }), null);
        assert.equal(buildSegment({ role: 'user', text: '' }), null);
        assert.equal(buildSegment({ role: 'user', text: null }), null);
    });

    test('an unrecognised role becomes unknown rather than being dropped', () => {
        // A source that labels turns its own way is still worth ingesting.
        assert.equal(buildSegment({ role: 'Speaker 1', text: 'hi' }).role, 'unknown');
        assert.equal(buildSegment({ text: 'hi' }).role, 'unknown');
    });

    test('trims text and rejects a negative or non-finite start', () => {
        assert.equal(buildSegment({ role: 'user', text: '  spaced  ' }).text, 'spaced');
        assert.equal(buildSegment({ role: 'user', text: 'x', startMs: -5 }).startMs, 0);
        assert.equal(buildSegment({ role: 'user', text: 'x', startMs: NaN }).startMs, null);
    });

    test('a numeric string is not a number', () => {
        // Deliberate, and it has already caught something real: Twilio sends
        // media.timestamp as a string, everything downstream coerced it
        // silently ("4820" - 100 works), and the first live transcript came
        // back with every start time null. The fix belongs at the boundary
        // where the wire format is known — see streamMs() in index.js — not in
        // loosening this. If a caller passes a string, it is a bug in the
        // caller, and this is what makes it visible instead of plausible.
        assert.equal(buildSegment({ role: 'user', text: 'x', startMs: '100' }).startMs, null);
        assert.equal(buildSegment({ role: 'user', text: 'x', startMs: Number('100') }).startMs, 100);
    });
});

describe('transcripts – ordering', () => {
    test('sorts by start time', () => {
        const ordered = orderSegments([
            { text: 'third', startMs: 3000 },
            { text: 'first', startMs: 1000 },
            { text: 'second', startMs: 2000 },
        ]);
        assert.deepEqual(ordered.map((s) => s.text), ['first', 'second', 'third']);
    });

    test('equal start times keep arrival order', () => {
        const ordered = orderSegments([
            { text: 'a', startMs: 1000 },
            { text: 'b', startMs: 1000 },
        ]);
        assert.deepEqual(ordered.map((s) => s.text), ['a', 'b']);
    });

    test('an untimed segment stays where it arrived', () => {
        // The comparator has to stay consistent here. Comparing untimed
        // segments by index while comparing timed ones by time produces a
        // relation where a < b, b < c and c < a simultaneously, and the result
        // then depends on the sort implementation.
        const ordered = orderSegments([
            { text: 'timed-late', startMs: 5000 },
            { text: 'untimed' },
            { text: 'timed-early', startMs: 1000 },
        ]);
        assert.equal(ordered[0].text, 'timed-early');
        assert.deepEqual(
            ordered.map((s) => s.text),
            ['timed-early', 'timed-late', 'untimed'],
            'An untimed segment inherits the time of the one before it'
        );
    });

    test('a fully untimed transcript keeps its original order', () => {
        const ordered = orderSegments([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
        assert.deepEqual(ordered.map((s) => s.text), ['one', 'two', 'three']);
    });
});

describe('transcripts – assembly', () => {
    test('builds a versioned transcript and orders its segments', () => {
        const transcript = buildTranscript({
            channel: 'call',
            provider: 'openai',
            model: 'gpt-transcribe',
            segments: [
                { role: 'assistant', text: 'Iris here.', startMs: 500 },
                { role: 'user', text: 'Hi Iris.', startMs: 2000 },
            ],
        });

        assert.equal(transcript.version, TRANSCRIPT_VERSION);
        assert.equal(transcript.channel, 'call');
        assert.equal(transcript.provider, 'openai');
        assert.equal(transcript.segments.length, 2);
        assert.equal(transcript.segments[0].text, 'Iris here.');
    });

    test('an unknown channel falls back to other rather than being kept', () => {
        assert.equal(buildTranscript({ channel: 'carrier-pigeon', segments: [{ text: 'x' }] }).channel, 'other');
    });

    test('empty and malformed segments are dropped during assembly', () => {
        const transcript = buildTranscript({
            segments: [{ text: 'kept' }, { text: '  ' }, null, undefined, { role: 'user' }, 'not an object'],
        });
        assert.equal(transcript.segments.length, 1);
        assert.equal(transcript.segments[0].text, 'kept');
    });

    test('counts turns that happened but produced no text', () => {
        // Observed live: the caller spoke for 908ms, transcription returned an
        // empty string, the turn was dropped, and the stored transcript showed
        // the assistant replying to nobody. The turn still must not appear in
        // segments — inventing text would put words nobody said into something
        // that later feeds prompts — but the fact that it happened is the only
        // thing that explains the reply.
        const transcript = buildTranscript({
            channel: 'call',
            segments: [
                { role: 'assistant', text: 'Iris here.', startMs: 1200 },
                { role: 'user', text: '', startMs: 4906 },
                { role: 'assistant', text: 'I can’t do that.', startMs: 5672 },
            ],
        });

        assert.equal(transcript.segments.length, 2, 'the empty turn stays out of the transcript');
        assert.equal(transcript.unintelligible, 1);
        assert.equal(transcript.segments.some((s) => s.text === ''), false);
    });

    test('a clean transcript reports nothing lost', () => {
        const transcript = buildTranscript({
            channel: 'call',
            segments: [{ role: 'user', text: 'hello', startMs: 0 }],
        });
        assert.equal(transcript.unintelligible, 0);
    });

    test('isEmpty distinguishes a silent call from a real one', () => {
        // A call where nobody spoke produces a valid transcript with no
        // segments. Saving that over a real one would lose data.
        assert.equal(isEmpty(buildTranscript({ segments: [] })), true);
        assert.equal(isEmpty(null), true);
        assert.equal(isEmpty(buildTranscript({ segments: [{ text: 'hello' }] })), false);
    });
});

describe('transcripts – flattening', () => {
    test('renders speaker-labelled lines', () => {
        const transcript = buildTranscript({
            segments: [
                { role: 'assistant', speaker: 'assistant', text: 'Iris here.', startMs: 0 },
                { role: 'user', speaker: 'caller', text: 'Hi.', startMs: 1000 },
            ],
        });
        assert.equal(toText(transcript), 'assistant: Iris here.\ncaller: Hi.');
    });

    test('falls back to the role when there is no speaker label', () => {
        const transcript = buildTranscript({
            segments: [{ role: 'user', text: 'Hi.' }, { role: 'assistant', text: 'Hello.' }],
        });
        assert.equal(toText(transcript), 'caller: Hi.\nassistant: Hello.');
    });

    test('an empty transcript flattens to an empty string, not "undefined"', () => {
        assert.equal(toText(buildTranscript({ segments: [] })), '');
        assert.equal(toText(null), '');
    });
});

describe('transcripts – external input', () => {
    test('rejects anything that is not this shape', () => {
        // This runs on the ingest path, where the transcript arrives from
        // outside and must not be trusted just because it parsed as JSON.
        assert.ok(validate(null));
        assert.ok(validate('a string'));
        assert.ok(validate({}));
        assert.ok(validate({ segments: 'not an array' }));
        assert.ok(validate({ segments: [] }));
        assert.ok(validate({ segments: [{ text: '' }] }));
        assert.equal(validate({ segments: [{ text: 'real' }] }), null);
    });

    test('names the offending segment so a bad payload can be fixed', () => {
        const reason = validate({ segments: [{ text: 'fine' }, { text: '' }] });
        assert.match(reason, /1/, 'The message should say which segment failed');
    });

    test('normalises second-based timings into milliseconds', () => {
        // Whisper-style output uses seconds; ours uses milliseconds.
        const transcript = fromExternal({
            segments: [{ speaker: 'Speaker 1', text: 'hello', start: 1.5, end: 3.25 }],
        });
        assert.equal(transcript.segments[0].startMs, 1500);
        assert.equal(transcript.segments[0].endMs, 3250);
    });

    test('accepts content as an alias for text', () => {
        const transcript = fromExternal({ segments: [{ content: 'from a chat-shaped payload' }] });
        assert.equal(transcript.segments[0].text, 'from a chat-shaped payload');
    });

    test('keeps the source speaker label alongside the normalised role', () => {
        const transcript = fromExternal({ segments: [{ speaker: 'Speaker 2', text: 'x' }] });
        assert.equal(transcript.segments[0].speaker, 'Speaker 2');
        assert.equal(transcript.segments[0].role, 'unknown', 'We cannot know who Speaker 2 is, and should not guess');
    });
});

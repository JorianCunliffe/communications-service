// Verifies 002_search_communications.sql actually landed and works.
//
// Run after applying the migration:  node migrations/verify-002.mjs
//
// The interesting checks replay the four searches from the call that prompted
// this migration. That call is the specification: "3500 Arcandy quote",
// "Arkendey", "$3,500" and "culvert", of which only the last one worked. Three
// of the four must now reach the message that holds the answer.
//
// Read-only. Nothing here writes.

import 'dotenv/config';
import { getSupabase } from '../configResolver.js';

const db = getSupabase();
if (!db) {
    console.error('Supabase is not configured — set SUPABASE_CONFIG_ENABLED, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
}

let failures = 0;
const pass = (name, detail = '') => console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
const fail = (name, detail) => { failures += 1; console.log(`  FAIL  ${name}  — ${detail}`); };
const note = (text) => console.log(`        ${text}`);

const ok = (detail = '') => ({ ok: true, detail });
const bad = (detail) => ({ ok: false, detail });

async function check(name, fn) {
    try {
        const verdict = await fn();
        if (!verdict || typeof verdict.ok !== 'boolean') {
            return fail(name, `check returned ${JSON.stringify(verdict)} instead of ok()/bad()`);
        }
        return verdict.ok ? pass(name, verdict.detail) : fail(name, verdict.detail);
    } catch (error) {
        fail(name, error.message);
    }
}

// Every query goes through here, because a PostgREST error arrives as a
// populated `error` beside a null `data`. Reading `data` without checking
// `error` reports a failed query as an empty result, which reads as "the
// feature is broken" when the truth is "the question was malformed".
async function must(promise) {
    const { data, error } = await promise;
    if (error) throw new Error(error.message);
    return data;
}

const search = (args) => must(db.rpc('search_communications', args));

console.log('\n--- 1. the schema changed ---');

await check('communications.body_them exists', async () => {
    const { error } = await db.from('communications').select('body_them').limit(1);
    return error ? bad(error.message) : ok();
});

await check('search_communications is callable', async () => {
    const rows = await search({ q: 'culvert', max_results: 5 });
    return Array.isArray(rows) ? ok(`returned ${rows.length} row(s)`) : bad('did not return a set');
});

await check('suggest_terms is callable', async () => {
    const rows = await must(db.rpc('suggest_terms', { q: 'culvert', max_results: 3 }));
    return Array.isArray(rows) ? ok() : bad('did not return a set');
});

console.log('\n--- 2. the backfill filled body_them ---');

await check('calls carry the caller half', async () => {
    const rows = await must(db.from('communications')
        .select('id, body_them').eq('channel', 'call').not('body_them', 'is', null).limit(1));
    return rows.length
        ? ok(`e.g. ${rows[0].body_them.slice(0, 50).replace(/\n/g, ' / ')}…`)
        : bad('every call has a null body_them — the trigger did not re-run, or no call has a user turn');
});

await check('the assistant half is excluded', async () => {
    const rows = await must(db.from('communications')
        .select('body_them').eq('channel', 'call').not('body_them', 'is', null).limit(20));
    const leaked = rows.filter((row) => /(^|\n)assistant:/i.test(row.body_them));
    return leaked.length === 0
        ? ok(`${rows.length} row(s) clean`)
        : bad(`${leaked.length} row(s) still contain assistant turns`);
});

await check('outbound sms has no caller half', async () => {
    const rows = await must(db.from('communications')
        .select('direction, body_them').eq('channel', 'sms'));
    const wrong = rows.filter((row) => row.direction === 'outbound' && row.body_them !== null);
    return wrong.length === 0
        ? ok(`${rows.length} sms row(s) consistent`)
        : bad(`${wrong.length} outbound message(s) counted as something the other party said`);
});

console.log('\n--- 3. the four searches from the call ---');

// Anchored on real content rather than an id, so the file stays runnable.
//
// Constrained to sms deliberately. Iris read the answer aloud on the call that
// failed to find it, so that transcript also contains "porous culvert" — and
// anchoring on the text alone picked the transcript, which made every search
// below assert that the failed call can find itself.
const [answer] = await must(db.from('communications')
    .select('id, body').eq('channel', 'sms').ilike('body', '%porous culvert%').limit(1));

if (!answer) {
    note('the "porous culvert" message is not in this database — skipping the replay');
    note('these checks are data-dependent by design: they replay one real call');
} else {
    const finds = async (q, extra = {}) => {
        const rows = await search({ q, max_results: 10, ...extra });
        const at = rows.findIndex((row) => row.id === answer.id);
        return { rows, at, hit: rows[at] };
    };

    // The headline regression. One mangled word used to veto two good ones.
    await check('"3500 Arcandy quote" reaches the answer', async () => {
        const { at, hit, rows } = await finds('3500 Arcandy quote');
        return at >= 0
            ? ok(`position ${at + 1} of ${rows.length}, matched_by ${hit.matched_by}`)
            : bad(`not in ${rows.length} result(s) — OR-ranking is not working`);
    });

    await check('"Arkendey" reaches the answer', async () => {
        const { at, hit, rows } = await finds('Arkendey');
        if (at < 0) return bad(`not in ${rows.length} result(s) — the trigram fallback is not working`);
        return ok(`position ${at + 1} of ${rows.length}, matched_by ${hit.matched_by}`);
    });

    await check('"$3,500" reaches the answer', async () => {
        const { at, hit, rows } = await finds('$3,500');
        if (at < 0) return bad(`not in ${rows.length} result(s) — punctuation is still not being stripped`);
        // Reaching it fuzzily is not good enough here. "$3,500" used to clean
        // to "500" — the comma became a space and the "3" was dropped as too
        // short — so the number matched nothing and only trigram similarity
        // carried the row through. That looked like a pass while the digits
        // were being mangled.
        return hit.matched_by === 'fuzzy'
            ? bad('matched only by similarity — the thousands separator is still splitting the number')
            : ok(`position ${at + 1} of ${rows.length}, matched_by ${hit.matched_by}`);
    });

    await check('"culvert" still works', async () => {
        const { at, rows } = await finds('culvert');
        return at >= 0 ? ok(`position ${at + 1} of ${rows.length}`) : bad('the one query that used to work now does not');
    });

    console.log('\n--- 4. the assistant no longer outranks the answer ---');

    await check('the answer beats the failed search that quoted it', async () => {
        const { rows, at } = await finds('3500 Arcandy quote');
        if (at < 0) return bad('the answer is not in the results at all');
        // The call in which Iris said "Arkendey" and "3,500 dollars" repeatedly
        // while finding nothing. Before the weighting change it ranked first.
        const echo = rows.findIndex((row) => row.channel === 'call' && /arkende|3,500/i.test(row.body ?? ''));
        if (echo < 0) return ok('no echoing call is indexed to compete with it');
        return at < echo
            ? ok(`answer at ${at + 1}, echoing transcript at ${echo + 1}`)
            : bad(`the echoing transcript at ${echo + 1} still outranks the answer at ${at + 1}`);
    });

    console.log('\n--- 5. did you mean ---');

    await check('"Arkendey" suggests the real spelling', async () => {
        const rows = await must(db.rpc('suggest_terms', { q: 'Arkendey', max_results: 5 }));
        const found = rows.find((row) => /arkendeith/i.test(row.term));
        return found
            ? ok(`${found.term} (${found.kind}, ${Number(found.score).toFixed(2)})`)
            : bad(`suggested ${rows.map((r) => r.term).join(', ') || 'nothing'}`);
    });
}

console.log('\n--- 6. filters and limits ---');

await check('a channel filter excludes other channels', async () => {
    const rows = await search({ q: null, channels: ['sms'], max_results: 25 });
    const wrong = rows.filter((row) => row.channel !== 'sms');
    return wrong.length === 0
        ? ok(`${rows.length} sms row(s), nothing else`)
        : bad(`${wrong.length} row(s) of another channel came back`);
});

await check('an empty query with a filter still returns rows', async () => {
    const rows = await search({ q: null, channels: ['sms'], max_results: 5 });
    if (!rows.length) return bad('no rows — a browse with no search term returns nothing');
    return rows.every((row) => row.matched_by === 'filter')
        ? ok(`${rows.length} row(s), all marked filter`)
        : bad('rows came back marked as text matches without a query');
});

await check('a date window excludes what is outside it', async () => {
    const rows = await search({ q: null, since: '2000-01-01', until: '2000-01-02', max_results: 5 });
    return rows.length === 0 ? ok('empty window is empty') : bad(`${rows.length} row(s) from outside the window`);
});

await check('max_results is honoured', async () => {
    const rows = await search({ q: null, max_results: 2 });
    return rows.length <= 2 ? ok(`asked 2, got ${rows.length}`) : bad(`asked 2, got ${rows.length}`);
});

await check('a term nobody said returns nothing', async () => {
    const rows = await search({ q: 'quarterly tax return depreciation schedule', max_results: 5 });
    return rows.length === 0 ? ok('clean miss') : bad(`${rows.length} row(s) — the fuzzy threshold is too loose`);
});

await check('results are ordered by rank', async () => {
    const rows = await search({ q: 'culvert quote Townsville', max_results: 10 });
    if (rows.length < 2) return ok(`only ${rows.length} row(s) — nothing to order`);
    const ordered = rows.every((row, i) => i === 0 || Number(rows[i - 1].rank) >= Number(row.rank));
    return ordered ? ok(`${rows.length} row(s) in descending rank`) : bad('rank is not monotonic');
});

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);

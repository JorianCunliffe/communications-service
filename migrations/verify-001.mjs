// Verifies 001_communications_search.sql actually landed and works.
//
// Run after applying the migration:  node migrations/verify-001.mjs
//
// This checks behaviour, not just presence. A table existing proves the DDL
// parsed; it does not prove the triggers fire, the backfill ran, full-text
// search returns anything, or a project attaches. Each of those has its own
// check, because each has failed independently in this codebase before.
//
// Writes only to a temporary project row, which it removes at the end.

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

// Explicit verdicts, because the obvious shortcut is a trap: if a bare string
// means "passed, with a detail", then a check that returns its error message
// to explain a failure reports PASS and prints the reason it failed beside it.
// This verifier did exactly that on its first run.
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

console.log('\n--- 1. schema exists ---');

// project_contacts is keyed on (project_id, contact_id) and has no id column,
// so each table names a column it actually has. Selecting a column that is not
// there fails with the same shape as the table being absent, which would report
// a missing migration when the migration is fine.
for (const [table, column] of [
    ['communications', 'id'],
    ['projects', 'id'],
    ['project_contacts', 'project_id'],
]) {
    await check(`table ${table}`, async () => {
        const { error } = await db.from(table).select(column).limit(1);
        return error ? bad(error.message) : ok();
    });
}

await check('contacts.is_principal', async () => {
    const { error } = await db.from('contacts').select('is_principal').limit(1);
    return error ? bad(error.message) : ok();
});

console.log('\n--- 2. the backfill ran ---');

const { count: callCount } = await db.from('calls').select('*', { count: 'exact', head: true });
const { count: smsCount } = await db.from('sms_messages').select('*', { count: 'exact', head: true });
const { count: commCount } = await db.from('communications').select('*', { count: 'exact', head: true });

await check('communications populated', async () => {
    if (!commCount) return bad('no rows — the backfill did not run, or every trigger swallowed an error');
    return ok(`${commCount} rows from ${callCount} calls + ${smsCount} sms`);
});

await check('every call was projected', async () => {
    const { count } = await db.from('communications')
        .select('*', { count: 'exact', head: true }).eq('source_table', 'calls');
    if (count === callCount) return ok(`${count}/${callCount}`);
    // A shortfall is the signature of a trigger that warned and returned.
    return bad(`only ${count} of ${callCount} calls reached the search surface`);
});

await check('bodies are not empty', async () => {
    const { data } = await db.from('communications')
        .select('id, body').eq('source_table', 'calls').not('body', 'is', null).limit(1);
    return data?.length
        ? ok(`e.g. ${data[0].body.slice(0, 60).replace(/\n/g, ' / ')}…`)
        : bad('every body is null — the transcript flattening produced nothing');
});

console.log('\n--- 3. full-text search works ---');

await check('websearch_to_tsquery over the index', async () => {
    const { data, error } = await db.from('communications')
        .select('id, occurred_at, channel').textSearch('search', 'Townsville', { type: 'websearch' }).limit(5);
    if (error) return bad(error.message);
    return data.length ? ok(`"Townsville" → ${data.length} row(s)`) : bad('no rows — the SMS mentioning it should match');
});

await check('a term nobody said returns nothing', async () => {
    const { data, error } = await db.from('communications')
        .select('id').textSearch('search', 'quarterly tax return', { type: 'websearch' }).limit(5);
    if (error) return bad(error.message);
    return data.length === 0 ? ok('clean miss') : bad(`${data.length} rows — unexpectedly matched`);
});

console.log('\n--- 4. triggers fire on write ---');

const { data: sample } = await db.from('calls')
    .select('id, twilio_call_sid, status').order('started_at', { ascending: false }).limit(1);

if (!sample?.length) {
    note('no calls to test against — skipping the live trigger check');
} else {
    const call = sample[0];
    await check('re-saving a call updates its communication', async () => {
        const { data: before } = await db.from('communications')
            .select('updated_at').eq('source_table', 'calls').eq('source_id', call.id).maybeSingle();
        if (!before) return bad('that call has no communications row at all');

        // A no-op write, purely to fire the trigger.
        await db.from('calls').update({ status: call.status }).eq('id', call.id);
        await new Promise((r) => setTimeout(r, 400));

        const { data: after } = await db.from('communications')
            .select('updated_at').eq('source_table', 'calls').eq('source_id', call.id).maybeSingle();
        return after.updated_at !== before.updated_at
            ? ok('updated_at moved')
            : bad('updated_at unchanged — the trigger did not fire (check UPDATE OF column list)');
    });

    await check('re-saving does not duplicate', async () => {
        const { count } = await db.from('communications')
            .select('*', { count: 'exact', head: true })
            .eq('source_table', 'calls').eq('source_id', call.id);
        return count === 1 ? ok('still one row') : bad(`${count} rows — the unique index is not holding`);
    });
}

console.log('\n--- 5. project attachment ---');

const TEST_PROJECT = `verify-001 scratch ${Date.now()}`;
let projectId = null;

try {
    // An alias certain to appear in this database, so the alias rule has
    // something real to catch. "Iris" is in the greeting of every call.
    const { data: created, error: createError } = await db.from('projects')
        .insert({ name: TEST_PROJECT, aliases: ['Townsville'], status: 'active' })
        .select('id').maybeSingle();

    if (createError) {
        fail('create a project', createError.message);
    } else {
        projectId = created.id;
        pass('create a project', TEST_PROJECT);

        await check('alias attaches a communication', async () => {
            // Re-project the SMS that mentions Townsville.
            const { data: msgs } = await db.from('sms_messages').select('id, content').ilike('content', '%Townsville%').limit(1);
            if (!msgs?.length) return bad('no message mentions Townsville — cannot test the alias rule');

            await db.from('sms_messages').update({ content: msgs[0].content }).eq('id', msgs[0].id);
            await new Promise((r) => setTimeout(r, 400));

            const { data: comm } = await db.from('communications')
                .select('project_id, project_link_reason')
                .eq('source_table', 'sms_messages').eq('source_id', msgs[0].id).maybeSingle();

            if (comm?.project_id !== projectId) return bad(`project_id is ${comm?.project_id ?? 'null'}, expected the test project`);
            if (comm.project_link_reason !== 'alias') return bad(`linked, but reason is "${comm.project_link_reason}" not "alias"`);
            return ok('linked by alias, reason recorded');
        });
    }
} finally {
    if (projectId) {
        // Detach first: on delete set null leaves project_link_reason behind,
        // which would read as an attachment to a project that no longer exists.
        await db.from('communications')
            .update({ project_id: null, project_link_reason: null })
            .eq('project_id', projectId);
        await db.from('projects').delete().eq('id', projectId);
        note(`cleaned up ${TEST_PROJECT}`);
    }
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);

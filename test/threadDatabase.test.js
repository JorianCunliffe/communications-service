import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { hashApiSecret } from '../auth.js';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import Fastify from 'fastify';
import { createPostgresClient } from '../database.js';
import v1Routes from '../v1.js';
import { canonicalEmail } from '../email.js';
import { ingestCanonicalInboundEmail } from '../emailWebhook.js';
import { createEmailReplyRoute } from '../emailReplyRoutes.js';
import { updateCallProjectContext } from '../callLog.js';

const tenantId = 'thread_integration_test';
const key = 'local-thread-integration-only';
const prior = { apiKey: process.env.API_KEY, tenant: process.env.LEGACY_TENANT_ID, persistence: process.env.PERSISTENCE_PROVIDER };
let sql;
let app;
let database;
let alex;
let blair;
let migrationCount;
const request = async (method, url, payload, headers = {}) => {
    const response = await app.inject({ method, url, payload, headers: { 'x-api-key': key, 'x-tenant-id': tenantId, ...headers } });
    return { status: response.statusCode, body: response.json() };
};
const postCommunication = async (body) => {
    const result = await request('POST', '/v1/communications', { direction: 'inbound', channel: 'email', ...body });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
};

before(async () => {
    process.env.API_KEY = key;
    process.env.LEGACY_TENANT_ID = tenantId;
    process.env.PERSISTENCE_PROVIDER = 'none';
    sql = new PGlite({ extensions: { pg_trgm } });
    await sql.query("select set_config('app.legacy_tenant_id',$1,false)", [tenantId]);
    const root = new URL('../migrations/', import.meta.url);
    const files = (await readdir(root)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
    for (const file of files) {
        const migration = (await readFile(new URL(file, root), 'utf8'))
            .replace(/create extension if not exists pgcrypto;/i, '-- PGlite has built-in gen_random_uuid, but no pgcrypto extension');
        try { await sql.exec(migration); }
        catch (error) { throw new Error(`Migration ${file}: ${error.message}`); }
    }
    migrationCount = files.length;
    database = createPostgresClient(sql);
    app = Fastify();
    await app.register(v1Routes, { prefix: '/v1', database });
    await app.ready();
    const createdAlex = await request('POST', '/v1/contacts', { name: 'Alex', identities: [
        { type: 'email', value: 'Alex@Example.com' }, { type: 'phone', value: '+61400000111' }
    ] });
    assert.equal(createdAlex.status, 201, JSON.stringify(createdAlex.body));
    alex = createdAlex.body.person_id;
    const createdBlair = await request('POST', '/v1/contacts', { name: 'Blair', identities: [
        { type: 'email', value: 'blair@example.com' }, { type: 'phone', value: '+61400000222' }
    ] });
    assert.equal(createdBlair.status, 201, JSON.stringify(createdBlair.body));
    blair = createdBlair.body.person_id;
});

after(async () => {
    await app?.close();
    await sql?.close();
    for (const [name, value] of [['API_KEY', prior.apiKey], ['LEGACY_TENANT_ID', prior.tenant], ['PERSISTENCE_PROVIDER', prior.persistence]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
});

describe('PostgreSQL-backed thread story', () => {
    test('applies the entire migration sequence and normalizes identities on real inserts', async () => {
        assert.equal(migrationCount, 22);
        const identities = (await sql.query('select normalized_value from communication_identities where person_id=$1', [alex])).rows;
        assert.ok(identities.some(row => row.normalized_value === 'alex@example.com'));
        assert.equal((await sql.query("select normalize_communication_identity('tel:+61 (400) 000-111') value")).rows[0].value, '+61400000111');
        assert.equal((await sql.query("select normalize_communication_identity('tel: +61 (400) 000-111') value")).rows[0].value, '+61400000111');
    });

    test('email, SMS, voice and recording join one project thread and persist scores and group participants', async () => {
        const now = new Date().toISOString();
        const email = await postCommunication({ identity: 'alex@example.com', subject: 'Alpha settlement', content: 'Confirm Alpha settlement timing', occurred_at: now,
            correlation: { external_project_id: 'alpha' }, participants: [{ identity: 'blair@example.com' }] });
        assert.equal(email.person_id, alex);
        const sms = await postCommunication({ channel: 'sms', identity: 'tel:+61 (400) 000-111', subject: 'Alpha settlement', content: 'Alpha settlement confirmed',
            occurred_at: now, correlation: { external_project_id: 'alpha' } });
        assert.equal(sms.thread_id, email.thread_id);
        const voice = await postCommunication({ channel: 'voice', identity: '+61400000111', subject: 'Alpha settlement', occurred_at: now, correlation: { external_project_id: 'alpha' } });
        assert.equal(voice.thread_id, email.thread_id);
        const recording = await postCommunication({ channel: 'recording', identity: 'blair@example.com', subject: 'Alpha settlement meeting', content: 'We agreed Alpha settlement timing',
            occurred_at: now, correlation: { external_project_id: 'alpha' }, participants: [{ identity: 'alex@example.com' }] });
        assert.equal(recording.thread_id, email.thread_id);
        const register = await request('GET', '/v1/thread-register?external_project_id=alpha');
        assert.equal(register.status, 200, JSON.stringify(register.body));
        const thread = register.body.data.find(row => row.thread_id === email.thread_id);
        assert.equal(thread.communications.length, 4);
        assert.ok(thread.participants.some(row => row.person_id === alex));
        assert.ok(thread.participants.some(row => row.person_id === blair));
        const blairThreads = await request('GET', `/v1/thread-register?person_id=${blair}&external_project_id=alpha`);
        assert.ok(blairThreads.body.data.some(row => row.thread_id === email.thread_id));
        assert.ok(thread.decisions.some(row => row.action === 'attached' && Array.isArray(row.candidate_scores) && row.candidate_scores.length));
        const candidates = await request('GET', `/v1/communications/${sms.communication_id}/thread-candidates`);
        assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
        assert.ok(candidates.body.candidates[0].signals.some(signal => signal.name === 'same_project'));
    });

    test('another project and a stale topic create separate threads', async () => {
        const beta = await postCommunication({ identity: 'alex@example.com', subject: 'Beta design', correlation: { external_project_id: 'beta' } });
        const old = await postCommunication({ identity: 'alex@example.com', subject: 'Old archived matter', occurred_at: '2020-01-01T00:00:00Z', correlation: { external_project_id: 'old' } });
        const fresh = await postCommunication({ identity: 'alex@example.com', subject: 'Unrelated new matter', correlation: { external_project_id: 'old' } });
        assert.notEqual(beta.thread_id, old.thread_id);
        assert.notEqual(old.thread_id, fresh.thread_id);
    });

    test('ordinary outbound replies can join, while explicit IDs and new Asks never fall through to inference', async () => {
        const first = await postCommunication({ identity: 'alex@example.com', subject: 'Explicit boundary', correlation: { external_project_id: 'explicit-boundary' } });
        const reply = await postCommunication({ direction: 'outbound', identity: 'alex@example.com', subject: 'Explicit boundary', correlation: { external_project_id: 'explicit-boundary' } });
        assert.equal(reply.thread_id, first.thread_id);
        const explicit = await postCommunication({ identity: 'alex@example.com', thread_id: 'thread_new_explicit', subject: 'Explicit boundary', correlation: { external_project_id: 'explicit-boundary' } });
        assert.equal(explicit.thread_id, 'thread_new_explicit');
        const ask = await postCommunication({ identity: 'alex@example.com', purpose: { type: 'human_ask', ask_id: 'ask_explicit_boundary' }, correlation: { external_project_id: 'explicit-boundary' } });
        assert.notEqual(ask.thread_id, first.thread_id);
        assert.notEqual(ask.thread_id, explicit.thread_id);
        const conflicted = await request('POST', '/v1/communications', { direction: 'inbound', channel: 'email', identity: 'alex@example.com', thread_id: first.thread_id,
            purpose: { type: 'human_ask', ask_id: 'ask_explicit_boundary' } });
        assert.notEqual(conflicted.status, 201);
        assert.match(conflicted.body.error, /already belongs to another thread/);
        const binding = (await sql.query('select thread_id from ask_bindings where tenant_id=$1 and ask_id=$2', [tenantId, 'ask_explicit_boundary'])).rows[0];
        assert.equal(binding.thread_id, ask.thread_id);
        const differentProject = await request('POST', '/v1/communications', { direction: 'inbound', channel: 'email', identity: 'alex@example.com', thread_id: first.thread_id,
            correlation: { external_project_id: 'not-explicit-boundary' } });
        assert.notEqual(differentProject.status, 201);
        assert.match(differentProject.body.error, /different project/);
    });

    test('an atomic correction moves only the selected row, repairs identity and trains the next match', async () => {
        const wrong = await postCommunication({ identity: 'mismatched@example.com', person_id: alex, subject: 'Gamma purchase', correlation: { external_project_id: 'gamma' } });
        const corrected = await request('POST', `/v1/communications/${wrong.communication_id}/rethread`, {
            create_new: true, reason_code: 'wrong_person', reason_detail: 'This address belongs to Blair', person_id: blair,
            update_identity: true, initiator_id: 'operator_test'
        });
        assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
        assert.notEqual(corrected.body.thread_id, wrong.thread_id);
        const canonical = await request('GET', `/v1/communications/${wrong.communication_id}`);
        assert.equal(canonical.body.person_id, blair);
        assert.equal(canonical.body.thread_id, corrected.body.thread_id);
        const members = (await sql.query('select thread_id from communication_thread_members where tenant_id=$1 and communication_row_id=(select id from communications where communication_id=$2)', [tenantId, wrong.communication_id])).rows;
        assert.deepEqual(members.map(row => row.thread_id), [corrected.body.thread_id]);
        const feedback = (await sql.query('select actor_id,reason_code from thread_resolution_feedback where communication_id=$1 and active', [wrong.communication_id])).rows[0];
        assert.deepEqual(feedback, { actor_id: JSON.stringify({ client_id: 'legacy', user_id: 'operator_test' }), reason_code: 'wrong_person' });
        const next = await postCommunication({ identity: 'mismatched@example.com', subject: 'Gamma purchase', correlation: { external_project_id: 'gamma' } });
        assert.equal(next.person_id, blair);
        assert.equal(next.thread_id, corrected.body.thread_id);
        const crossChannel = await postCommunication({ channel: 'sms', identity: '+61400000222', subject: 'Gamma purchase', correlation: { external_project_id: 'gamma' } });
        assert.equal(crossChannel.thread_id, corrected.body.thread_id);
        const oldThread = (await sql.query('select status from communication_threads where thread_id=$1', [wrong.thread_id])).rows[0];
        assert.equal(oldThread.status, 'closed');
    });

    test('thread detail edits persist without resolving an Ask or leaking across tenants', async () => {
        const communication = await postCommunication({ identity: 'alex@example.com', subject: 'Delta review', correlation: { external_project_id: 'delta' } });
        const edited = await request('PATCH', `/v1/threads/${communication.thread_id}`, { title: 'Delta design review', summary: 'A human-edited topic', external_project_id: 'delta-v2', initiator_id: 'operator_test' });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal(edited.body.title, 'Delta design review');
        const canonical = await request('GET', `/v1/communications/${communication.communication_id}`);
        assert.equal(canonical.body.correlation.external_project_id, 'delta-v2');
        const ask = await postCommunication({ identity: 'alex@example.com', purpose: { type: 'human_ask', ask_id: 'ask_integration' }, thread_id: 'thread_ask_integration' });
        const denied = await request('PATCH', `/v1/threads/${ask.thread_id}`, { status: 'resolved' });
        assert.equal(denied.status, 400);
        assert.match(denied.body.error, /Ask lifecycle/);
        const crossTenant = await request('GET', '/v1/thread-register', undefined, { 'x-tenant-id': 'another_tenant' });
        assert.equal(crossTenant.status, 403);
        const noAuth = await app.inject({ method: 'GET', url: '/v1/thread-register' });
        assert.equal(noAuth.statusCode, 401);
    });

    test('moving an inferred Ask reply cannot rebind the Ask or move its outbound request', async () => {
        const outbound = await postCommunication({ direction: 'outbound', identity: 'alex@example.com',
            purpose: { type: 'human_ask', ask_id: 'ask_keep_binding' }, thread_id: 'thread_keep_binding' });
        const inbound = await postCommunication({ identity: 'alex@example.com', thread_id: outbound.thread_id, content: 'A different topic' });
        const moved = await request('POST', `/v1/communications/${inbound.communication_id}/rethread`, { create_new: true, reason_code: 'wrong_topic' });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const binding = (await sql.query("select thread_id,status from ask_bindings where tenant_id=$1 and ask_id='ask_keep_binding'", [tenantId])).rows[0];
        assert.deepEqual(binding, { thread_id: outbound.thread_id, status: 'open' });
        const movedRow = await request('GET', `/v1/communications/${inbound.communication_id}`);
        assert.equal(movedRow.body.purpose, null);
        const denied = await request('POST', `/v1/communications/${outbound.communication_id}/rethread`, { create_new: true, reason_code: 'wrong_topic' });
        assert.equal(denied.status, 400);
        assert.match(denied.body.error, /Outbound Ask/);
    });

    test('SMS source corrections survive later provider updates without changing sibling messages', async () => {
        const source = await postCommunication({ channel: 'sms', identity: '+61400000111', subject: 'SMS source test', correlation: { external_project_id: 'sms-source' } });
        const native = (await sql.query('insert into sms_threads(tenant_id,phone_number,twilio_number,contact_id) values($1,$2,$3,$4) returning id', [tenantId, '+61400000111', '+61499999999', alex])).rows[0].id;
        await sql.query(`insert into sms_messages(tenant_id,thread_id,communication_id,direction,content,communication_thread_id,thread_link_type,person_id)
            values($1,$2,'comm_sms_source','inbound','A message',$3,'inferred',$4),($1,$2,'comm_sms_sibling','inbound','Another message',$3,'inferred',$4)`, [tenantId, native, source.thread_id, alex]);
        const corrected = await request('POST', '/v1/communications/comm_sms_source/rethread', { create_new: true, reason_code: 'wrong_person', person_id: blair });
        assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
        await sql.query("update sms_messages set status='delivered' where communication_id in ('comm_sms_source','comm_sms_sibling')");
        const rows = (await sql.query("select communication_id,person_id,thread_id,resolution from communications where communication_id in ('comm_sms_source','comm_sms_sibling')")).rows;
        const changed = rows.find(row => row.communication_id === 'comm_sms_source');
        const sibling = rows.find(row => row.communication_id === 'comm_sms_sibling');
        assert.equal(changed.person_id, blair);
        assert.equal(changed.thread_id, corrected.body.thread_id);
        assert.equal(changed.resolution.method, 'human_correction');
        assert.equal(sibling.person_id, alex);
        assert.equal(sibling.thread_id, source.thread_id);
    });

    test('recording projection preserves its correction after transcript reprocessing', async () => {
        const source = await postCommunication({ channel: 'recording', identity: 'alex@example.com', subject: 'Recorded planning', correlation: { external_project_id: 'record-source' } });
        await sql.query(`insert into recordings(tenant_id,source,external_id,communication_id,contact_id,communication_thread_id,thread_link_type,
            status,transcript_text,participant_identities,resolution,title)
            values($1,'integration','recording-source','comm_record_source',$2,$3,'inferred','done','Recorded planning discussion',$4::jsonb,$5::jsonb,'Recorded planning')`,
        [tenantId, alex, source.thread_id, JSON.stringify([{ identity_value: 'alex@example.com' }]), JSON.stringify({ confidence: 0.8, method: 'ranked_match' })]);
        const corrected = await request('POST', '/v1/communications/comm_record_source/rethread', { create_new: true, reason_code: 'wrong_topic' });
        assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
        await sql.query("update recordings set transcript_text='Corrected transcript text' where communication_id='comm_record_source'");
        const canonical = (await sql.query("select thread_id,resolution,body from communications where communication_id='comm_record_source'")).rows[0];
        assert.equal(canonical.thread_id, corrected.body.thread_id);
        assert.equal(canonical.resolution.method, 'human_correction');
        assert.equal(canonical.body, 'Corrected transcript text');
    });

    test('recording workflow project changes are rejected while ordinary edits preserve correlation', async () => {
        const source = await postCommunication({ channel: 'recording', identity: 'alex@example.com', subject: 'Recording workflow', correlation: { external_project_id: 'record-workflow' } });
        for (const suffix of ['one', 'two']) {
            await sql.query(`insert into recordings(tenant_id,source,external_id,communication_id,contact_id,communication_thread_id,
                status,transcript_text,metadata) values($1,'integration',$2,$3,$4,$5,'done','Planning',$6::jsonb)`,
            [tenantId, `workflow-${suffix}`, `comm_record_${suffix}`, alex, source.thread_id,
                JSON.stringify({ correlation: { external_project_id: 'record-workflow', run_id: `run_${suffix}`, task_id: `task_${suffix}` } })]);
        }
        const edited = await request('PATCH', `/v1/threads/${source.thread_id}`, { external_project_id: 'record-workflow-edited' });
        assert.equal(edited.status, 400, JSON.stringify(edited.body));
        assert.match(edited.body.error, /workflow owner/);
        assert.equal((await request('PATCH', `/v1/threads/${source.thread_id}`, { title: 'Reviewed recording' })).status, 200);
        await sql.query("update recordings set transcript_text='Reprocessed planning' where external_id in ('workflow-one','workflow-two')");
        for (const suffix of ['one', 'two']) {
            const row = (await sql.query('select correlation from communications where communication_id=$1', [`comm_record_${suffix}`])).rows[0];
            assert.equal(row.correlation.external_project_id, 'record-workflow');
            assert.equal(row.correlation.run_id, `run_${suffix}`);
            assert.equal(row.correlation.task_id, `task_${suffix}`);
        }
    });

    test('an unknown participant is not attributed to the thread owner and project alone is not enough', async () => {
        const existing = await postCommunication({ identity: 'alex@example.com', subject: 'Epsilon building consent', correlation: { external_project_id: 'epsilon' } });
        const unrelated = await postCommunication({ identity: 'unknown@example.com', subject: 'Completely different issue', correlation: { external_project_id: 'epsilon' } });
        assert.notEqual(unrelated.thread_id, existing.thread_id);
        assert.equal(unrelated.person_id, null);
        const related = await postCommunication({ identity: 'builder@example.com', subject: 'Epsilon building consent', correlation: { external_project_id: 'epsilon' } });
        assert.equal(related.thread_id, existing.thread_id);
        assert.equal(related.person_id, null);
    });

    test('moving a group communication carries every participant and removes stale participant evidence', async () => {
        const group = await postCommunication({ identity: 'alex@example.com', subject: 'Group move evidence',
            participants: [{ identity: 'blair@example.com' }], correlation: { external_project_id: 'group-move' } });
        await postCommunication({ identity: 'alex@example.com', thread_id: group.thread_id, subject: 'Alex only follow-up' });
        const moved = await request('POST', `/v1/communications/${group.communication_id}/rethread`, { create_new: true, reason_code: 'wrong_topic' });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const participants = (await sql.query('select thread_id,person_id,first_seen_at,last_seen_at from communication_thread_participants where tenant_id=$1 and thread_id in ($2,$3)',
            [tenantId, group.thread_id, moved.body.thread_id])).rows;
        assert.ok(participants.some(p => p.thread_id === moved.body.thread_id && p.person_id === alex));
        assert.ok(participants.some(p => p.thread_id === moved.body.thread_id && p.person_id === blair));
        assert.ok(!participants.some(p => p.thread_id === group.thread_id && p.person_id === blair));
        assert.ok(participants.every(p => new Date(p.first_seen_at) <= new Date(p.last_seen_at)));
        const reply = await postCommunication({ channel: 'sms', identity: '+61400000222', subject: 'Group move evidence', correlation: { external_project_id: 'group-move' } });
        assert.equal(reply.thread_id, moved.body.thread_id);
    });

    test('voice source correction survives later transcript and provider status updates', async () => {
        const source = await postCommunication({ channel: 'voice', identity: '+61400000111', subject: 'Voice correction', correlation: { external_project_id: 'voice-correction' } });
        await sql.query(`insert into calls(tenant_id,twilio_call_sid,phone_number,communication_id,contact_id,direction,status,communication_thread_id,thread_link_type)
            values($1,'CA_local_fixture','+61400000111','comm_voice_source',$2,'inbound','in-progress',$3,'inferred')`, [tenantId, alex, source.thread_id]);
        const moved = await request('POST', '/v1/communications/comm_voice_source/rethread', { create_new: true, reason_code: 'wrong_person', person_id: blair });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        await sql.query(`update calls set status='completed',transcript=$1::jsonb where communication_id='comm_voice_source'`,
            [JSON.stringify({ segments: [{ role: 'user', text: 'The planning meeting is confirmed.' }] })]);
        const row = (await sql.query("select thread_id,person_id,resolution,body from communications where communication_id='comm_voice_source'")).rows[0];
        assert.equal(row.thread_id, moved.body.thread_id);
        assert.equal(row.person_id, blair);
        assert.equal(row.resolution.method, 'human_correction');
        assert.match(row.body, /planning meeting is confirmed/);
    });

    test('native email replies follow corrected parents, exclude reply aliases, and scope provider IDs to a mailbox connection', async () => {
        const makeConnection = async suffix => {
            const connection = (await sql.query(`insert into provider_connections(tenant_id,provider,provider_account_id,credential_reference)
                values($1,'resend',$2,'env:LOCAL_FIXTURE_ONLY') returning *`, [tenantId, `native-${suffix}`])).rows[0];
            const identity = (await sql.query(`insert into service_identities(tenant_id,provider_connection_id,channel,address,can_receive,reply_domain)
                values($1,$2,'email',$3,true,'service.example') returning id`, [tenantId, connection.id, `inbox-${suffix}@service.example`])).rows[0].id;
            return { connection, identity };
        };
        const mailbox = await makeConnection('one');
        const ingest = async (id, extra = {}, selected = mailbox) => ingestCanonicalInboundEmail({
            db: database, tenantId, connection: selected.connection, serviceIdentityId: selected.identity,
            email: canonicalEmail({ provider_email_id: id, provider_conversation_id: 'native-conversation-id', message_id: `<${id}@example.com>`,
                from: 'native-parent@example.com', to: 'inbox-one@service.example', subject: 'Native routing discussion', text: 'A local fixture only.', ...extra }),
        });
        const first = await ingest('native-one');
        const second = await ingest('native-two');
        const third = await ingest('native-three');
        assert.equal(second.threadId, first.threadId);
        assert.equal(third.threadId, first.threadId);
        const moved = await request('POST', `/v1/communications/${third.communicationId}/rethread`, { create_new: true, reason_code: 'wrong_topic' });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const replyRoute = await createEmailReplyRoute(database, { tenantId, threadId: first.threadId, serviceIdentityId: mailbox.identity });
        const reply = await ingest('native-four', { in_reply_to: '<native-three@example.com>',
            references: '<native-one@example.com> <native-two@example.com>', to: `reply+${replyRoute.token}@service.example` });
        assert.equal(reply.threadId, moved.body.thread_id);
        const participants = (await sql.query('select identity_value from communication_thread_participants where thread_id=$1', [reply.threadId])).rows;
        assert.ok(participants.every(p => !p.identity_value.startsWith('reply+')));
        const otherMailbox = await makeConnection('two');
        const other = await ingest('native-other', { from: 'different-native-person@example.com', to: 'inbox-two@service.example' }, otherMailbox);
        assert.notEqual(other.threadId, reply.threadId);
        assert.notEqual(other.threadId, first.threadId);
    });

    test('a corrected outbound email keeps its own reply address without moving sibling routes or inheriting another Ask', async () => {
        const connection = (await sql.query(`insert into provider_connections(tenant_id,provider,provider_account_id,credential_reference)
            values($1,'resend','corrected-reply-route','env:LOCAL_FIXTURE_ONLY') returning *`, [tenantId])).rows[0];
        const identity = (await sql.query(`insert into service_identities(tenant_id,provider_connection_id,channel,address,can_receive,reply_domain)
            values($1,$2,'email','corrected-route@service.example',true,'service.example') returning id`, [tenantId, connection.id])).rows[0].id;
        const attachEmailSource = async (communication, messageId, replyAddress = null) => {
            const row = (await sql.query(`insert into email_messages(tenant_id,communication_id,thread_id,person_id,provider_connection_id,
                service_identity_id,provider_email_id,message_id,direction,from_addresses,to_addresses,reply_to_addresses,purpose,correlation,occurred_at)
                values($1,$2,$3,$4,$5,$6,$7,$7,'outbound','[{"address":"corrected-route@service.example"}]',
                '[{"address":"alex@example.com"}]',$8::jsonb,$9::jsonb,$10::jsonb,now()) returning id`,
            [tenantId, communication.communication_id, communication.thread_id, alex, connection.id, identity, messageId,
                JSON.stringify(replyAddress ? [{ address: replyAddress }] : []), JSON.stringify(communication.purpose), JSON.stringify(communication.correlation)])).rows[0];
            await sql.query("update communications set source_table='email_messages',source_id=$1 where communication_id=$2", [row.id, communication.communication_id]);
        };
        const source = await postCommunication({ direction: 'outbound', identity: 'alex@example.com', thread_id: 'thread_corrected_reply_route',
            subject: 'Reply address correction', correlation: { external_project_id: 'reply-correction-project' } });
        const ownRoute = await createEmailReplyRoute(database, { tenantId, threadId: source.thread_id, personId: alex, serviceIdentityId: identity });
        const siblingRoute = await createEmailReplyRoute(database, { tenantId, threadId: source.thread_id, personId: alex, serviceIdentityId: identity });
        const replyAddress = `reply+${ownRoute.token}@service.example`;
        await attachEmailSource(source, '<corrected-outbound@example.com>', replyAddress);
        const moved = await request('POST', `/v1/communications/${source.communication_id}/rethread`, { create_new: true, reason_code: 'wrong_topic' });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        const routes = (await sql.query('select id,thread_id from email_reply_routes where id in ($1,$2)', [ownRoute.route.id, siblingRoute.route.id])).rows;
        assert.equal(routes.find(row => row.id === ownRoute.route.id).thread_id, moved.body.thread_id);
        assert.equal(routes.find(row => row.id === siblingRoute.route.id).thread_id, source.thread_id);
        const ingest = (id, extra = {}) => ingestCanonicalInboundEmail({ db: database, tenantId, connection, serviceIdentityId: identity,
            email: canonicalEmail({ provider_email_id: id, from: 'alex@example.com', to: replyAddress, subject: 'Reply address correction',
                text: 'A local fixture reply without RFC reply headers.', ...extra }) });
        const reply = await ingest('corrected-route-reply');
        assert.equal(reply.threadId, moved.body.thread_id);

        const unrelatedAsk = await postCommunication({ direction: 'outbound', identity: 'alex@example.com',
            purpose: { type: 'human_ask', ask_id: 'ask_unrelated_reply_header' },
            correlation: { external_project_id: 'unrelated-reply-project', run_id: 'run_other', task_id: 'task_other' } });
        await attachEmailSource(unrelatedAsk, '<unrelated-ask@example.com>');
        const conflictingHeader = await ingest('corrected-route-conflicting-header', { in_reply_to: '<unrelated-ask@example.com>' });
        const canonical = (await request('GET', `/v1/communications/${conflictingHeader.communicationId}`)).body;
        assert.equal(conflictingHeader.threadId, moved.body.thread_id);
        assert.equal(canonical.purpose, null);
        assert.equal(canonical.correlation.external_project_id, 'reply-correction-project');
        assert.equal(canonical.correlation.run_id, undefined);
        assert.equal(canonical.correlation.task_id, undefined);
    });

    test('register pages threads and older communications without hiding quiet threads', async () => {
        const busy = await postCommunication({ identity: 'alex@example.com', thread_id: 'thread_page_busy', subject: 'Paged history', correlation: { external_project_id: 'paging' } });
        const quiet = await postCommunication({ identity: 'blair@example.com', thread_id: 'thread_page_quiet', subject: 'Quiet history', correlation: { external_project_id: 'paging' } });
        await sql.query(`insert into communications(tenant_id,communication_id,channel,direction,source_table,source_id,thread_id,thread_link_type,occurred_at,subject)
          select $1,'comm_page_'||n,'email','inbound','communications_api',gen_random_uuid(),$2,'explicit',now()-n*interval '1 minute','Older message '||n
          from generate_series(1,22) n`, [tenantId, busy.thread_id]);
        const first = await request('GET', '/v1/thread-register?external_project_id=paging&limit=1');
        const second = await request('GET', '/v1/thread-register?external_project_id=paging&limit=1&offset=1');
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.has_more, true);
        assert.equal(second.body.has_more, false);
        assert.notEqual(first.body.data[0].thread_id, second.body.data[0].thread_id);
        const all = await request('GET', '/v1/thread-register?external_project_id=paging');
        assert.equal(all.body.data.find(t => t.thread_id === quiet.thread_id).communications.length, 1);
        const busyPage = all.body.data.find(t => t.thread_id === busy.thread_id);
        assert.equal(busyPage.communications.length, 20);
        assert.equal(busyPage.communications_count, 23);
        const older = await request('GET', `/v1/thread-register?thread_id=${busy.thread_id}&communication_offset=20`);
        assert.equal(older.body.data.length, 1);
        assert.equal(older.body.data[0].communications.length, 3);
        assert.equal(new Set([...busyPage.communications, ...older.body.data[0].communications].map(c => c.communication_id)).size, 23);
        for (const query of ['offset=-1', 'communication_offset=1.5', 'offset=wat', 'person_id=not-a-uuid']) {
            assert.equal((await request('GET', `/v1/thread-register?${query}`)).status, 400);
        }
    });

    test('a live call project switch moves only the call and preserves the other project thread', async () => {
        const first = await postCommunication({ identity: 'alex@example.com', subject: 'Voice project A', correlation: { external_project_id: 'voice-project-a' } });
        const second = await postCommunication({ identity: 'alex@example.com', subject: 'Voice project B', correlation: { external_project_id: 'voice-project-b' } });
        await sql.query(`insert into calls(tenant_id,twilio_call_sid,phone_number,communication_id,contact_id,direction,status,communication_thread_id,thread_link_type,correlation)
            values($1,'CA_project_switch','+61400000111','comm_project_switch',$2,'inbound','in-progress',$3,'inferred',$4::jsonb)`,
        [tenantId, alex, first.thread_id, JSON.stringify({ tenant_id: tenantId, thread_id: first.thread_id, external_project_id: 'voice-project-a' })]);
        const selected = await updateCallProjectContext({ callSid: 'CA_project_switch', projectId: 'voice-project-b', tenantId, database });
        assert.equal(selected.thread_id, second.thread_id);
        const original = (await sql.query('select external_project_id from communication_threads where thread_id=$1', [first.thread_id])).rows[0];
        assert.equal(original.external_project_id, 'voice-project-a');
        const unchanged = (await sql.query('select correlation from communications where communication_id=$1', [first.communication_id])).rows[0];
        assert.equal(unchanged.correlation.external_project_id, 'voice-project-a');
        const moved = (await sql.query("select thread_id,correlation from communications where communication_id='comm_project_switch'")).rows[0];
        assert.equal(moved.thread_id, second.thread_id);
        assert.equal(moved.correlation.external_project_id, 'voice-project-b');
        const members = (await sql.query("select thread_id from communication_thread_members where communication_id='comm_project_switch'")).rows;
        assert.deepEqual(members.map(m => m.thread_id), [second.thread_id]);
    });

    test('simultaneous communications in a new conversation do not create competing threads', async () => {
        const [email, reply] = await Promise.all([
            postCommunication({ identity: 'alex@example.com', subject: 'Concurrent planning', correlation: { external_project_id: 'concurrent-project' } }),
            postCommunication({ identity: 'alex@example.com', subject: 'Concurrent planning', correlation: { external_project_id: 'concurrent-project' } }),
        ]);
        assert.equal(email.thread_id, reply.thread_id);
    });

    test('more than 100 threads page without gaps and deep history remains accessible', async () => {
        await sql.query(`insert into communication_threads(tenant_id,thread_id,external_project_id)
          select $1, 'thread_bulk_' || lpad(n::text,3,'0'), 'bulk-page' from generate_series(1,105) n`, [tenantId]);
        const first = await request('GET', '/v1/thread-register?external_project_id=bulk-page&limit=100');
        const second = await request('GET', '/v1/thread-register?external_project_id=bulk-page&limit=100&offset=100');
        assert.equal(first.body.data.length, 100); assert.equal(first.body.has_more, true);
        assert.equal(second.body.data.length, 5); assert.equal(second.body.has_more, false);
        assert.equal(new Set([...first.body.data,...second.body.data].map(row=>row.thread_id)).size,105);
    });

    test('cross-project moves require an explicit reason and cannot move workflow ownership', async () => {
        const a = await postCommunication({ identity: 'alex@example.com', correlation: { external_project_id: 'move-a' } });
        const b = await postCommunication({ identity: 'alex@example.com', correlation: { external_project_id: 'move-b' } });
        const path = `/v1/communications/${a.communication_id}/rethread`;
        const denied = await request('POST', path, { thread_id: b.thread_id, reason_code: 'wrong_topic' });
        assert.equal(denied.status,400); assert.match(denied.body.error,/wrong_project/);
        assert.equal((await request('POST',path,{ thread_id:b.thread_id,reason_code:'wrong_project' })).status,200);
        const bound = await postCommunication({ identity:'alex@example.com', correlation:{ external_project_id:'move-bound', run_id:'immutable_run', task_id:'immutable_task' } });
        const blocked = await request('POST',`/v1/communications/${bound.communication_id}/rethread`,{ thread_id:b.thread_id,reason_code:'wrong_project' });
        assert.equal(blocked.status,400); assert.match(blocked.body.error,/workflow owner/);
        const current = (await request('GET',`/v1/communications/${bound.communication_id}`)).body;
        assert.equal(current.correlation.run_id,'immutable_run'); assert.equal(current.thread_id,bound.thread_id);
        await sql.query("insert into tenants(tenant_id,name) values('foreign_thread_tenant','Foreign') on conflict do nothing");
        await sql.query("insert into communication_threads(tenant_id,thread_id) values('foreign_thread_tenant','thread_foreign_test')");
        assert.equal((await request('POST',path,{thread_id:'thread_foreign_test',reason_code:'wrong_project'})).status,400);
    });

    test('audit attributes the authenticated client and rejects untrusted user assertions', async () => {
        const secret = 'phase02-local-scoped-secret-only';
        await sql.query(`insert into api_clients(name,key_id,secret_hash,allowed_tenants,roles,capabilities)
          values('Phase 02 fixture','phase02_client',$1,$2::text[],'{}'::text[],$3::text[])`,
          [await hashApiSecret(secret), [tenantId], ['communications:read','communications:write']]);
        const communication = await postCommunication({ identity:'alex@example.com',correlation:{external_project_id:'audit-test'} });
        const headers = {'x-api-key':`phase02_client.${secret}`};
        const path = `/v1/communications/${communication.communication_id}/rethread`;
        assert.equal((await request('POST',path,{create_new:true,reason_code:'wrong_topic',initiator_id:'ceo-forged'},headers)).status,403);
        const moved = await request('POST',path,{create_new:true,reason_code:'wrong_topic'},headers);
        assert.equal(moved.status,200,JSON.stringify(moved.body));
        const audit = (await sql.query('select actor_id from thread_resolution_feedback where tenant_id=$1 and communication_id=$2 order by created_at desc limit 1',[tenantId,communication.communication_id])).rows[0];
        assert.deepEqual(JSON.parse(audit.actor_id),{client_id:'phase02_client',user_id:null});
        const fresh = await request('GET',`/v1/thread-register?thread_id=${moved.body.thread_id}`);
        assert.ok(fresh.body.data[0].corrections.some(row=>row.communication_id===communication.communication_id));
    });

    test('failed resolution rolls back thread, participant and decision writes', async () => {
        const before = (await sql.query('select count(*)::int as count from thread_resolution_decisions')).rows[0].count;
        const bad = await request('POST', '/v1/communications', { direction: 'inbound', channel: 'email', identity: 'rollback-fixture@example.com',
            thread_id: 'thread_rollback_fixture', participants: [{ identity: 'bad-person@example.com', person_id: '11111111-1111-4111-8111-111111111111' }] });
        assert.notEqual(bad.status, 201);
        assert.equal((await sql.query("select count(*)::int as count from communication_threads where thread_id='thread_rollback_fixture'")).rows[0].count, 0);
        assert.equal((await sql.query('select count(*)::int as count from thread_resolution_decisions')).rows[0].count, before);
        const badTime = await request('POST', '/v1/communications', { direction: 'inbound', channel: 'email', identity: 'rollback-fixture@example.com', occurred_at: 'not-a-date' });
        assert.equal(badTime.status, 400);
    });
});

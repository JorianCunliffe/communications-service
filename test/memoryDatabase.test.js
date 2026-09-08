import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhase02Database } from './fixtures/phase02Database.js';
import { hashApiSecret } from '../auth.js';
import { dueEvidence, sourceAllowed } from '../memorySafety.js';
const tenant='phase03_test',key='phase03-local-only';
let fixture,sql,app,person,one,two,hidden;
const request=async(method,url,body,headers={})=>{const r=await app.inject({method,url,payload:body,headers:{'x-api-key':key,'x-tenant-id':tenant,...headers}});return {status:r.statusCode,body:r.json()};};
const add=async body=>{const r=await request('POST','/v1/communications',{direction:'inbound',channel:'email',identity:'alex@example.com',...body});assert.equal(r.status,201,JSON.stringify(r.body));return r.body;};
before(async()=>{
 fixture=await createPhase02Database(tenant,key);({sql,app}=fixture);
 const p=await request('POST','/v1/contacts',{name:'Alex',identities:[{type:'email',value:'alex@example.com'}]});person=p.body.person_id;
 one=await add({thread_id:'thread_public',subject:'Public valuation',content:'I will send the valuation Friday.',correlation:{external_project_id:'alpha'}});
 two=await add({thread_id:'thread_other',subject:'Other project secret',content:'I will send confidential designs.',correlation:{external_project_id:'beta'}});
 hidden=await add({thread_id:'thread_public',subject:'Private board discussion',content:'I will sell the company.',correlation:{external_project_id:'alpha'},metadata:{private:true}});
 await sql.query("insert into communication_commitments(tenant_id,communication_id,thread_id,description,source_excerpt,due_at,promisor_contact_id) values($1,$2,$3,'Send valuation','I will send the valuation Friday.','2026-09-11T07:00:00Z',$4)",[tenant,one.communication_id,one.thread_id,person]);
 await sql.query("insert into communication_facts(tenant_id,fact_key,text,thread_id,source_communication_ids,contact_id) values($1,'valuation','Valuation pending',$2,$3::text[],$4)",[tenant,one.thread_id,[one.communication_id],person]);
});
after(async()=>fixture?.close());

test('person context restricts projects and private source expansion with source-linked promises',async()=>{
 const r=await request('POST','/v1/context/memory',{kind:'person',id:person,allowed_project_ids:['alpha']});
 assert.equal(r.status,200,JSON.stringify(r.body));
 const text=JSON.stringify(r.body);
 assert.ok(text.includes(one.communication_id)); assert.ok(!text.includes('Other project secret')); assert.ok(!text.includes('Private board discussion'));
 assert.equal(r.body.data.recent_facts.length,1);
 const promise=r.body.data.open_commitments[0];assert.equal(promise.due_at,null);assert.equal(promise.due_date_status,'inferred');assert.equal(promise.original_wording,'I will send the valuation Friday.');
 assert.ok(r.body.data.provenance.sources[one.communication_id]);
});

test('search does not expand into another person/project or disclose private thread summary',async()=>{
 await sql.query("update communication_threads set summary='Private board discussion',summary_source_ids=$1::text[] where thread_id=$2",[[hidden.communication_id],one.thread_id]);
 const r=await request('POST','/v1/context/memory',{kind:'search',query:'valuation',allowed_project_ids:['alpha']});assert.equal(r.status,200);
 assert.ok(!JSON.stringify(r.body).includes('Private board discussion'));
 const t=await request('POST','/v1/context/memory',{kind:'thread',id:one.thread_id,allowed_project_ids:['alpha']});
 assert.equal(t.body.data.summary,null);assert.equal(t.body.memory_status.state,'stale');
});

test('retracted facts and edited evidence disappear from person and loose-end views',async()=>{
 await sql.query("update communication_facts set status='retracted' where fact_key='valuation'");
 let r=await request('POST','/v1/context/memory',{kind:'person',id:person,allowed_project_ids:['alpha']});
 assert.equal(r.status,200);assert.equal(r.body.data.recent_facts.length,0);
 const before=await request('POST','/v1/context/memory',{kind:'loose_ends',allowed_project_ids:['alpha']});
 assert.ok(before.body.data.some(row=>row.original_wording==='I will send the valuation Friday.'));
 await sql.query("update communications set body='The earlier promise is withdrawn',updated_at=now()+interval '1 second' where communication_id=$1",[one.communication_id]);
 r=await request('POST','/v1/context/memory',{kind:'loose_ends',allowed_project_ids:['alpha']});
 assert.equal(r.status,200);assert.equal(r.body.data.length,0);assert.equal(r.body.memory_status.state,'stale');
 await sql.query("update communications set body='I will send the valuation Friday.',updated_at=now() where communication_id=$1",[one.communication_id]);
 await sql.query("update communication_commitments set updated_at=now() where communication_id=$1",[one.communication_id]);
 await sql.query("update communication_facts set status='active',updated_at=now() where fact_key='valuation'");
});

test('eligibility revocation hides derived promises and facts immediately',async()=>{
 await sql.query('update communications set memory_eligible=false where communication_id=$1',[one.communication_id]);
 const r=await request('POST','/v1/context/memory',{kind:'person',id:person,allowed_project_ids:['alpha']});assert.equal(r.status,200);
 assert.equal(r.body.data.open_commitments.length,0);assert.equal(r.body.data.recent_facts.length,0);
 await sql.query('update communications set memory_eligible=true where communication_id=$1',[one.communication_id]);
});

test('a correction suppresses stale derived thread associations without deleting raw evidence',async()=>{
 const move=await request('POST',`/v1/communications/${one.communication_id}/rethread`,{create_new:true,reason_code:'wrong_topic'});assert.equal(move.status,200);
 const r=await request('POST','/v1/context/memory',{kind:'thread',id:one.thread_id});assert.equal(r.status,200);
 assert.equal(r.body.data.commitments.length,0);assert.equal(r.body.data.facts.length,0);
 const raw=await request('GET',`/v1/communications/${one.communication_id}`);assert.equal(raw.status,200);assert.equal(raw.body.thread_id,move.body.thread_id);
});

test('untrusted private grants and other tenants are rejected',async()=>{
 const secret='phase03-test-scoped-secret-only';
 await sql.query("insert into api_clients(name,key_id,secret_hash,allowed_tenants,capabilities) values('P03','p03',$1,$2::text[],$3::text[])",[await hashApiSecret(secret),[tenant],['communications:read']]);
 const headers={'x-api-key':`p03.${secret}`};
 assert.equal((await request('POST','/v1/context/memory',{kind:'search',include_private:true},headers)).status,403);
 assert.equal((await request('POST','/v1/context/search',{query:'valuation'},headers)).status,200);
 assert.equal((await request('POST','/v1/context/memory',{kind:'search'},{...headers,'x-tenant-id':'other'})).status,403);
});

test('memory failure is explicit and raw ingestion remains available',async()=>{
 await sql.exec('alter table communication_facts rename to temporarily_unavailable_facts');
 try {
  assert.equal((await request('POST','/v1/context/memory',{kind:'search'})).status,503);
  const raw=await add({subject:'Persist during memory outage',content:'Raw communication still exists.',correlation:{external_project_id:'outage'}});
  assert.equal((await request('GET',`/v1/communications/${raw.communication_id}`)).status,200);
 } finally { await sql.exec('alter table temporarily_unavailable_facts rename to communication_facts'); }
});

test('only a matching explicit timezone timestamp is labelled explicit',()=>{
 assert.equal(dueEvidence({source_excerpt:'I will deliver tomorrow.',due_at:'2026-09-09T07:00:00Z'}).due_date_status,'inferred');
 assert.equal(dueEvidence({source_excerpt:'I will deliver at 2026-09-11T17:00:00+10:00.',due_at:'2026-09-11T07:00:00Z'}).due_date_status,'explicit');
 assert.equal(dueEvidence({source_excerpt:'I will deliver soon.',due_at:null}).due_date_status,'unspecified');
 assert.equal(dueEvidence({description:'Model paraphrase',due_at:null}).original_wording,null);
});


test('failed calls, automated messages and private flags fail closed',()=>{
 const base={memory_eligible:true,channel:'voice',correlation:{external_project_id:'alpha'}};
 for (const disposition of ['failed','voicemail','no_answer','spam','automatic_reply','bounce']) assert.equal(sourceAllowed({...base,disposition}),false);
 assert.equal(sourceAllowed({...base,metadata:{successful:false}}),false);
 assert.equal(sourceAllowed({...base,metadata:{private:true}},{include_private:'false'}),false);
 assert.equal(sourceAllowed(base,{allowed_project_ids:[]}),false);
 assert.equal(sourceAllowed(base,{allowed_project_ids:['alpha']}),true);
});

test('meeting notes remain available after the meeting and private meetings stay hidden',async()=>{
 const event=(await sql.query("insert into calendar_events(tenant_id,provider,provider_id,title,starts_at,metadata) values($1,'manual','p03_meeting','Valuation meeting','2026-01-01T00:00:00Z',$2::jsonb) returning id",[tenant,JSON.stringify({external_project_id:'alpha'})])).rows[0];
 const notes=await add({subject:'Transcribed valuation meeting',content:'Alex agreed to supply the valuation.',calendar_event_id:event.id,correlation:{external_project_id:'alpha'}});
 const read=()=>request('POST','/v1/context/memory',{kind:'meeting',id:event.id,allowed_project_ids:['alpha']});
 const context=await read();assert.equal(context.status,200);assert.ok(JSON.stringify(context.body).includes(notes.communication_id));
 await sql.query("update calendar_events set metadata=metadata || $2::jsonb where id=$1",[event.id,JSON.stringify({private:true})]);
 assert.equal((await read()).status,404);
});

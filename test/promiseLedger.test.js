import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createPhase02Database} from './fixtures/phase02Database.js';
import {tenantDatabase} from '../tenantContext.js';
import {normalizePromiseEvidence,fallbackPromises,validatePromises,processPromiseJob,readPromise,listPromises,reviewPromise,dueInterpretation} from '../promiseLedger.js';
const tenant='promise_test',key='promise-local-only';let fixture,sql,app,db,alice,bob;
const req=async(method,url,payload)=>{const r=await app.inject({method,url,payload,headers:{'x-api-key':key,'x-tenant-id':tenant}});assert.ok(r.statusCode<400,r.body);return r.json();};
const add=async(body={})=>req('POST','/v1/communications',{direction:'inbound',channel:'email',identity:'alice@example.com',content:'I will send the report Friday.',correlation:{external_project_id:'alpha'},...body});
async function claim(id){return (await sql.query("update promise_jobs set status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',attempts=attempts+1 where communication_id=$1 and source_revision=(select promise_revision from communications where communication_id=$1) returning *",[id])).rows[0];}
const extract=(source,normalized)=>fallbackPromises(source,normalized);
async function process(id,options={}){const j=await claim(id);await processPromiseJob(db,j,{extractor:extract,destination:null,...options});return j;}
before(async()=>{fixture=await createPhase02Database(tenant,key,{serverRoles:true});({sql,app}=fixture);db=tenantDatabase((await import('../database.js')).createPostgresClient(sql),tenant);
 alice=(await req('POST','/v1/contacts',{name:'Alice',identities:[{type:'email',value:'alice@example.com'}]})).person_id;
 bob=(await req('POST','/v1/contacts',{name:'Bob',identities:[{type:'email',value:'bob@example.com'}]})).person_id;
});
after(async()=>fixture?.close());

test('publisher sees the Promise Ledger composite key and replay preserves foreign keys',async()=>{
 const {readFile}=await import('node:fs/promises');
 const migration=await readFile(new URL('../migrations/039_promise_publish_constraint.sql',import.meta.url),'utf8');
 await sql.exec(migration);
 const key=await sql.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='communication_commitments'::regclass and conname='promise_tenant_id' and contype='u'");
 assert.equal(key.rows[0]?.definition,'UNIQUE (tenant_id, id)');
 const references=await sql.query("select count(*)::int n from pg_constraint where confrelid='communication_commitments'::regclass and conrelid in ('promise_evidence'::regclass,'promise_history'::regclass) and contype='f' and convalidated");
 assert.equal(references.rows[0].n,2);
});

test('we creates one joint promise with both participants, including unresolved local party',()=>{
 const s={body:"We'll send the report.",direction:'inbound',person_id:'alice',occurred_at:'2026-09-18T00:00:00Z'};
 const n=normalizePromiseEvidence(s),items=validatePromises(s,n,fallbackPromises(s,n));
 assert.equal(items.length,1);assert.equal(items[0].joint,true);assert.equal(items[0].promisor_parties.length,2);
 assert.deepEqual(items[0].promisor_parties.map(p=>p.person_id),[null,'alice']);
});
test('meeting we includes both named people; individual speaker remains individual',()=>{
 const s={metadata:{participants:[{id:'a',name:'Alice',personId:'alice'},{id:'b',name:'Bob',personId:'bob'}]},transcript:{segments:[
  {sourceSegmentId:'s1',speakerId:'a',text:'We will deliver the report.',role:'unknown'},
  {sourceSegmentId:'s2',speakerId:'b',text:'I will book the room.',role:'unknown'}]}};
 const n=normalizePromiseEvidence(s),items=validatePromises(s,n,fallbackPromises(s,n));
 assert.deepEqual(items[0].promisor_parties.map(p=>p.person_id),['alice','bob']);assert.equal(items[1].promisor_parties[0].person_id,'bob');
 assert.equal(items[1].promisee_parties[0].person_id,'alice');
});
test('sent promises and agent speech are captured, quoted requests and hypotheticals are excluded',()=>{
 for(const body of ['Can you send it?','If needed, I will send it.','She said "I will send it".','I will not send it.'])assert.equal(fallbackPromises({body,direction:'inbound'}).length,0);
 assert.equal(fallbackPromises({body:'I will send it.\nOn Friday Alice wrote:\nI will send another.',direction:'outbound'}).length,1);
 const s={channel:'voice',body:'assistant: I will email the report.\nuser: Thank you.',direction:'outbound'};const n=normalizePromiseEvidence(s);
 assert.equal(validatePromises(s,n,fallbackPromises(s,n))[0].origin,'agent');
 assert.equal(dueInterpretation('I will send it Friday.','2026-09-18T00:00:00Z').instant,null);
});
test('every source in a burst larger than the summary window gets a receipt',async()=>{
 for(let i=0;i<35;i++)await add({thread_id:'promise_burst',content:`I will deliver item ${i}.`});
 const result=await sql.query("select count(*)::int n from promise_jobs where source->>'thread_id'='promise_burst'");assert.equal(result.rows[0].n,35);
});
test('atomic extraction preserves IDs, records evidence/history, and rejects lost leases',async()=>{
 const c=await add({thread_id:'promise_atomic'});const job=await process(c.communication_id);
 const rows=await listPromises(db,{external_project_id:'alpha',thread_id:'promise_atomic'});assert.equal(rows.data.length,1);
 const p=rows.data[0];assert.equal(p.promisor_parties[0].person_id,alice);assert.equal(p.evidence.length,1);
 await assert.rejects(()=>processPromiseJob(db,job,{extractor:extract}),/lease changed/);
 const detail=await readPromise(db,p.id,{}, {history:true});assert.equal(detail.history.length,1);
});
test('source correction retains history and retracts obsolete evidence without closing an obligation',async()=>{
 const c=await add({thread_id:'promise_correction'});await process(c.communication_id);const p=(await listPromises(db,{thread_id:'promise_correction'})).data[0];
 await sql.query("update communications set body='Thank you.',body_them=null,updated_at=now() where communication_id=$1",[c.communication_id]);
 assert.equal((await readPromise(db,p.id)).source_current,false);
 await process(c.communication_id);const changed=await readPromise(db,p.id,{}, {history:true});
 assert.equal(changed.review_state,'retracted');assert.equal(changed.history.length,2);assert.equal(changed.evidence[0].active,false);
});
test('a source edit fences a worker that already holds a lease',async()=>{
 const c=await add({thread_id:'promise_stale'});const job=await claim(c.communication_id);
 await sql.query("update communications set body='I will send the revised version.',updated_at=now() where communication_id=$1",[c.communication_id]);
 const result=await processPromiseJob(db,job,{extractor:extract});assert.equal(result.outcome,'superseded');
 assert.equal((await sql.query('select count(*)::int n from communication_commitments where communication_id=$1',[c.communication_id])).rows[0].n,0);
});
test('privacy and project filtering apply to detail and history',async()=>{
 const c=await add({thread_id:'promise_private',metadata:{private:true}});await process(c.communication_id);
 const id=(await sql.query('select id from communication_commitments where communication_id=$1',[c.communication_id])).rows[0].id;
 assert.equal(await readPromise(db,id),null);assert.ok(await readPromise(db,id,{include_private:true}));
 assert.equal(await readPromise(db,id,{include_private:true,allowed_project_ids:['beta']}),null);
});
test('review is version checked and completed legacy status means only a claim',async()=>{
 const c=await add({thread_id:'promise_review'});await process(c.communication_id);const p=(await listPromises(db,{thread_id:'promise_review'})).data[0];
 const claimed=await req('POST',`/v1/commitments/${p.id}/status`,{status:'completed',expected_revision:p.revision,reason:'Sender says it is done'});
 assert.equal(claimed.observed_state,'completion_claimed');assert.equal(claimed.status,'open');
 await assert.rejects(()=>reviewPromise(db,p.id,{expected_revision:p.revision,action:'confirm',reason:'Reviewed'},'reviewer'),/revision changed/);
 const verified=await reviewPromise(db,p.id,{expected_revision:claimed.revision,action:'verify_fulfillment',reason:'Checked delivered report'},'reviewer');
 assert.equal(verified.observed_state,'fulfilled');assert.equal(verified.history.at(-1).actor,'reviewer');
});
test('joint speaker identity cannot reference another tenant',async()=>{
 const c=await add({thread_id:'promise_bad_person'});await process(c.communication_id);const p=(await listPromises(db,{thread_id:'promise_bad_person'})).data[0];
 await assert.rejects(()=>reviewPromise(db,p.id,{expected_revision:p.revision,action:'correct',reason:'Wrong person',patch:{promisor_parties:[{person_id:'00000000-0000-4000-8000-000000000001'}]}},'reviewer'),/unavailable/);
});
test('reconciliation backfill is idempotent and queue claim respects tenant feature flag',async()=>{
 const c=await add({thread_id:'promise_missing'});await sql.query('delete from promise_jobs where communication_id=$1',[c.communication_id]);
 const since='2000-01-01T00:00:00Z';assert.ok((await db.rpc('reconcile_promise_jobs',{p_since:since})).data>=1);
 assert.equal((await db.rpc('reconcile_promise_jobs',{p_since:since})).data,0);
 await sql.query("update tenants set metadata=jsonb_build_object('promise_ledger',jsonb_build_object('enabled',false)) where tenant_id=$1",[tenant]);
 assert.equal((await sql.query('select * from claim_promise_job()')).rows.length,0);
 await sql.query("update tenants set metadata='{}' where tenant_id=$1",[tenant]);
});
test('new tables and privileged functions are unavailable to public application roles',async()=>{
 for(const name of ['promise_jobs','promise_evidence','promise_history']) {
  assert.equal((await sql.query("select relrowsecurity from pg_class where relname=$1",[name])).rows[0].relrowsecurity,true);
  assert.equal((await sql.query("select has_table_privilege('anon',$1,'SELECT') allowed",[name])).rows[0].allowed,false);
 }
 assert.equal((await sql.query("select has_function_privilege('authenticated','claim_promise_job()','EXECUTE') allowed")).rows[0].allowed,false);
});

test('a cross-channel reaffirmation has one identity and multiple citations, with atomic revision events',async()=>{
 const c=await add({thread_id:'promise_channels'});await process(c.communication_id,{destination:'https://example.invalid/events'});
 const first=(await listPromises(db,{thread_id:'promise_channels'})).data[0];
 const sms=await add({channel:'sms',thread_id:'promise_channels',content:'I will send the report Friday.'});
 await process(sms.communication_id,{destination:'https://example.invalid/events',extractor:(source,n)=>fallbackPromises(source,n).map(x=>({...x,kind:'reaffirmed',target_id:first.id}))});
 const rows=(await listPromises(db,{thread_id:'promise_channels'})).data;assert.equal(rows.length,1);assert.equal(rows[0].evidence.length,2);
 assert.equal((await sql.query("select count(*)::int n from outbound_events where payload->'payload'->>'promise_id'=$1",[first.id])).rows[0].n,2);
});
test('model outage retains provisional promises and retries without multiplying identities/history',async()=>{
 const c=await add({thread_id:'promise_outage',content:'We will send the report.'});
 const options={extractor:async()=>{throw new Error('Provider offline');}};
 await process(c.communication_id,options);const first=(await listPromises(db,{thread_id:'promise_outage'})).data[0];
 await process(c.communication_id,options);const row=await readPromise(db,first.id,{}, {history:true});
 assert.equal(row.history.length,1);assert.equal(row.joint,true);
 const receipt=(await sql.query('select status,outcome from promise_jobs where communication_id=$1',[c.communication_id])).rows[0];
 assert.equal(receipt.status,'pending');assert.equal(receipt.outcome,'provisional');
});
test('local participant configuration resolves both joint promisors',async()=>{
 const policy=await req('POST','/v1/promises/policy',{expected_revision:0,enabled:true,shadow:true,project_ids:['alpha'],local_person_id:bob});
 assert.equal(policy.version,1);
 const c=await add({thread_id:'promise_both',content:'We will deliver the presentation.'});await process(c.communication_id);
 const row=(await listPromises(db,{thread_id:'promise_both'})).data[0];assert.deepEqual(row.promisor_parties.map(p=>p.person_id),[bob,alice]);
 assert.equal((await listPromises(db,{thread_id:'promise_both',person_id:bob,direction:'owing'})).data.length,1);
 const stale=await app.inject({method:'POST',url:'/v1/promises/policy',headers:{'x-api-key':key,'x-tenant-id':tenant},payload:{expected_revision:0,enabled:false,shadow:true,project_ids:['alpha'],local_person_id:bob}});
 assert.equal(stale.statusCode,409);
});
test('source history is immutable outside tenant erasure',async()=>{
 await assert.rejects(()=>sql.query("update promise_history set reason='rewritten'"),/append-only/);
});
test('shadow mode and historical backfill never send promise events',async()=>{
 const c=await add({thread_id:'promise_shadow'});await process(c.communication_id,{destination:'https://example.invalid/events'});
 assert.equal((await sql.query('select count(*)::int n from outbound_events where communication_id=$1',[c.communication_id])).rows[0].n,0);
 await sql.query("update tenants set metadata=jsonb_set(metadata,'{promise_ledger,shadow}','false') where tenant_id=$1",[tenant]);
 const old=await add({thread_id:'promise_historical'});await sql.query('update promise_jobs set backfill=true where communication_id=$1',[old.communication_id]);
 await process(old.communication_id,{destination:'https://example.invalid/events'});
 assert.equal((await sql.query('select count(*)::int n from outbound_events where communication_id=$1',[old.communication_id])).rows[0].n,0);
});

test('the production service role can commit ledger evidence without default Supabase grants',async()=>{
 const c=await add({thread_id:'promise_service_role'});const job=await claim(c.communication_id);
 await sql.query('set role service_role');
 try{const result=await processPromiseJob(db,job,{extractor:extract,destination:null});assert.equal(result.count,1);}
 finally{await sql.query('reset role');}
});

test('manual CRUD, condition review, evidence and tombstones form one revisioned aggregate',async()=>{
 let p=await req('POST','/v1/promises',{reason:'Phone agreement',patch:{description:'Send the report',external_project_id:'alpha',promisor_parties:[{person_id:alice,label:'Alice'}],promisee_parties:[{person_id:bob,label:'Bob'}]}});
 assert.equal(p.source_type,'manual');assert.equal(p.communication_id,null);assert.equal(p.source_current,true);assert.equal(p.history.length,1);
 p=await req('PATCH',`/v1/promises/${p.id}`,{expected_revision:p.revision,reason:'Clarified terms',patch:{description:'Send revised report',due:{instant:'2026-09-25T17:00:00+10:00',status:'confirmed'}}});
 const stale=await app.inject({method:'PATCH',url:`/v1/promises/${p.id}`,headers:{'x-api-key':key,'x-tenant-id':tenant},payload:{expected_revision:1,reason:'Old edit',patch:{description:'Wrong'}}});assert.equal(stale.statusCode,409);
 p=await req('POST',`/v1/promises/${p.id}/conditions`,{expected_revision:p.revision,reason:'Depends on materials',patch:{description:'Dave supplies materials'}});
 const condition=p.conditions[0];assert.equal(condition.status,'pending');
 const blocked=await app.inject({method:'POST',url:`/v1/promises/${p.id}/review`,headers:{'x-api-key':key,'x-tenant-id':tenant},payload:{expected_revision:p.revision,reason:'Done',action:'verify_fulfillment'}});assert.equal(blocked.statusCode,400);
 p=await req('PATCH',`/v1/promises/${p.id}/conditions/${condition.id}`,{expected_revision:p.revision,reason:'Received materials',patch:{status:'satisfied'}});
 p=await req('POST',`/v1/promises/${p.id}/evidence`,{expected_revision:p.revision,reason:'Delivery record',patch:{quote:'I checked the delivered report.'}});assert.equal(p.evidence.length,1);assert.equal(p.observed_state,'promised');
 p=await req('POST',`/v1/promises/${p.id}/review`,{expected_revision:p.revision,reason:'Personally verified delivery',action:'verify_fulfillment'});assert.equal(p.observed_state,'fulfilled');
 p=await req('DELETE',`/v1/promises/${p.id}`,{expected_revision:p.revision,reason:'Duplicate entry'});assert.ok(p.deleted_at);assert.equal(p.history.at(-1).action,'delete');
 const missing=await app.inject({method:'GET',url:`/v1/promises/${p.id}`,headers:{'x-api-key':key,'x-tenant-id':tenant}});assert.equal(missing.statusCode,404);
 const audit=await req('GET',`/v1/promises/${p.id}?include_deleted=true`);assert.equal(audit.evidence.length,1);
 await assert.rejects(()=>sql.query("update promise_evidence set quote='rewritten' where promise_id=$1",[p.id]),/immutable/);
});
test('deleted extraction stays suppressed after source revision and manual terms survive extraction',async()=>{
 const c=await add({thread_id:'crud_suppression'});await process(c.communication_id);
 let p=(await listPromises(db,{thread_id:'crud_suppression'})).data[0];
 p=await req('PATCH',`/v1/promises/${p.id}`,{expected_revision:p.revision,reason:'Agreed scope',patch:{description:'Human agreed description',promisee_parties:[{person_id:bob,label:'Bob'}]}});
 await sql.query("update communications set body=body||' Thanks.',updated_at=now() where communication_id=$1",[c.communication_id]);await process(c.communication_id);
 p=await readPromise(db,p.id);assert.equal(p.description,'Human agreed description');assert.equal(p.promisee_parties[0].person_id,bob);
 await req('DELETE',`/v1/promises/${p.id}`,{expected_revision:p.revision,reason:'Removed'});
 await sql.query("update communications set body=body||' Again.',updated_at=now() where communication_id=$1",[c.communication_id]);await process(c.communication_id);
 assert.equal((await listPromises(db,{thread_id:'crud_suppression'})).data.length,0);
});
test('CRUD rejects tenant foreign references and exposes no partial create',async()=>{
 await sql.query("insert into tenants(tenant_id,name) values('foreign_crud','Other')");
 const foreign=(await sql.query("insert into contacts(tenant_id,name) values('foreign_crud','Foreign') returning id")).rows[0].id;
 const before=(await sql.query('select count(*)::int n from communication_commitments')).rows[0].n;
 const r=await app.inject({method:'POST',url:'/v1/promises',headers:{'x-api-key':key,'x-tenant-id':tenant},payload:{reason:'Invalid',patch:{description:'Leak',promisor_parties:[{person_id:foreign,label:'Other'}]}}});assert.equal(r.statusCode,400);
 assert.equal((await sql.query('select count(*)::int n from communication_commitments')).rows[0].n,before);
});
test('association edits move current terms without rewriting original source evidence',async()=>{
 const c=await add({thread_id:'crud_move'});await process(c.communication_id);let p=(await listPromises(db,{thread_id:'crud_move'})).data[0];
 const original=p.evidence[0].quote;
 p=await req('PATCH',`/v1/promises/${p.id}`,{expected_revision:p.revision,reason:'Belongs to beta',patch:{external_project_id:'beta',thread_id:null}});
 assert.equal((await readPromise(db,p.id,{external_project_id:'alpha'})),null);
 const moved=await readPromise(db,p.id,{external_project_id:'beta',allowed_project_ids:['beta']});assert.equal(moved.evidence[0].quote,original);assert.equal(moved.original_wording,p.original_wording);
});
test('manual mutation emits a revision event and rolls back invalid status changes',async()=>{
 await sql.query("update tenants set metadata=jsonb_set(metadata,'{promise_ledger,shadow}','false') where tenant_id=$1",[tenant]);
 const result=await db.rpc('mutate_promise',{p_id:null,p_revision:null,p_actor:'tester',p_action:'create',p_reason:'Agreement',p_patch:{description:'Manual event',external_project_id:'alpha',promisor_parties:[{person_id:alice,label:'Alice'}]},p_destination:'https://example.invalid/events'});
 assert.equal(result.error,null);
 const p=result.data;const events=await sql.query("select payload from outbound_events where payload->'payload'->>'promise_id'=$1",[p.id]);assert.equal(events.rows.length,1);assert.equal(events.rows[0].payload.payload.revision,1);
 const bad=await db.rpc('mutate_promise',{p_id:p.id,p_revision:p.revision,p_actor:'tester',p_action:'update',p_reason:'Bypass',p_patch:{observed_state:'fulfilled'},p_destination:null});assert.ok(bad.error);assert.equal((await readPromise(db,p.id)).revision,1);
 let row=await req('POST',`/v1/promises/${p.id}/conditions`,{expected_revision:1,reason:'Dependency',patch:{description:'Input'}});
 row=await req('DELETE',`/v1/promises/${p.id}/conditions/${row.conditions[0].id}`,{expected_revision:row.revision,reason:'No longer needed'});assert.deepEqual(row.conditions,[]);
});

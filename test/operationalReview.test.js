import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createPhase02Database} from './fixtures/phase02Database.js';
import {tenantDatabase} from '../tenantContext.js';
import {createPostgresClient} from '../database.js';
import {classifyCommunication,evaluateFulfilment,validateCandidates} from '../operationalIntelligence.js';
import {readPromise,normalizePromiseEvidence,processPromiseJob} from '../promiseLedger.js';
let fixture,db,app,sql,alice;
const headers={'x-api-key':'operational-test','x-tenant-id':'operational'};
const request=async(method,url,payload,status=200)=>{const r=await app.inject({method,url,payload,headers});assert.equal(r.statusCode,status,r.body);return r.json();};
const candidate=(text,type='PROMISE',extra={})=>({type,segment_id:'body',source_text:text,summary:text,actor_ref:'counterparty',target_id:null,condition:null,confidence:0.95,due_text:null,...extra});
const ingest=async(text,thread='review-thread')=>request('POST','/v1/communications',{direction:'inbound',channel:'email',identity:'alice@example.com',content:text,thread_id:thread,correlation:{external_project_id:'alpha'}},201);
const classification=(c,items)=>classifyCommunication(db,{communication_id:c.communication_id},{},{classifier:async()=>({items})});
before(async()=>{fixture=await createPhase02Database('operational','operational-test',{serverRoles:true});({app,sql}=fixture);db=tenantDatabase(createPostgresClient(sql),'operational');alice=(await request('POST','/v1/contacts',{name:'Alice',identities:[{type:'email',value:'alice@example.com'}]},201)).person_id;});
after(async()=>fixture?.close());
test('conditional promise creates only speaker commitment and a separate expected deliverable',async()=>{
 const text='I will send the report if Dave provides the figures today.';const c=await ingest(text);
 await classification(c,[candidate(text,'CONDITIONAL_PROMISE',{condition:'Dave provides figures today'}),candidate(text,'EXPECTED_DELIVERABLE',{summary:'Figures from Dave',actor_ref:'local'})]);
 let s=await request('POST','/v1/review/sessions',{external_project_id:'alpha'});
 assert.equal(s.stage,'BRIEFING');s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});
 assert.equal(s.stage,'REVIEW');
 while(s.stage==='REVIEW'){const q=s.next_item;s=await request('POST',`/v1/review/sessions/${s.id}/respond`,{expected_revision:s.revision,review_item_id:q.id,request_id:q.id,utterance:'Yes, track it.',intent:'ACCEPT'});}
 const promises=(await sql.query('select * from communication_commitments')).rows;
 assert.equal(promises.length,1);assert.equal(promises[0].promisor_parties[0].person_id,alice);assert.equal(promises[0].conditions[0].status,'pending');
 assert.equal((await readPromise(db,promises[0].id)).source_current,true);
 assert.equal((await sql.query("select count(*)::int n from operational_objects where type='EXPECTED_DELIVERABLE'")).rows[0].n,1);
 const action=await request('POST',`/v1/review/sessions/${s.id}/actions`,{instruction:'Remind me to call Dave tomorrow.',request_id:'reminder-1'});
 assert.equal(action.status,'PENDING');assert.equal((await request('POST',`/v1/review/sessions/${s.id}/actions`,{instruction:'Remind me to call Dave tomorrow.',request_id:'reminder-1'})).id,action.id);
 s=await request('GET',`/v1/review/sessions/${s.id}`);s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});assert.equal(s.stage,'SUMMARY');assert.match(s.prompt,/queued/);
 s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});assert.equal(s.stage,'COMPLETED');
});
test('fulfilment evidence requires human confirmation and pending conditions block completion',async()=>{
 const p=(await sql.query('select * from communication_commitments limit 1')).rows[0];
 const c=await ingest('Attached is the completed report.');
 await evaluateFulfilment(db,p.id,{communication_id:c.communication_id},{},{evaluator:async()=>({assessment:'LIKELY_FULFILLED',confidence:0.96,reason:'The report was supplied',quote:'Attached is the completed report.',condition_id:null})});
 assert.notEqual((await readPromise(db,p.id)).observed_state,'fulfilled');
 let s=await request('POST','/v1/review/sessions',{});s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});
 const q=s.review_queue.find(q=>q.operation==='verify_fulfillment');const body={expected_revision:s.revision,review_item_id:q.id,request_id:'fulfil-1',utterance:'Yes, completed.',intent:'ACCEPT'};
 await request('POST',`/v1/review/sessions/${s.id}/respond`,body,400);
 assert.equal((await request('GET',`/v1/review/sessions/${s.id}`)).revision,s.revision);
 await request('PATCH',`/v1/promises/${p.id}/conditions/${p.conditions[0].id}`,{expected_revision:p.revision,reason:'Figures arrived',patch:{status:'satisfied'}});
 await request('POST',`/v1/review/sessions/${s.id}/respond`,body,409);
 s=await request('POST','/v1/review/sessions',{});s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});const fresh=s.review_queue.find(q=>q.operation==='verify_fulfillment');
 const accepted={...body,expected_revision:s.revision,review_item_id:fresh.id};
 const result=await request('POST',`/v1/review/sessions/${s.id}/respond`,accepted);
 assert.equal((await readPromise(db,p.id)).observed_state,'fulfilled');
 assert.equal((await request('POST',`/v1/review/sessions/${s.id}/respond`,accepted)).revision,result.revision);
});
test('source changes invalidate classification and review; idempotency keys cannot be reused for other sources',async()=>{
 const c=await ingest('I will book the room.','stale');await classification(c,[candidate('I will book the room.')]);
 let s=await request('POST','/v1/review/sessions',{thread_id:'stale'});s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});
 await sql.query("update communications set body='Never mind.' where communication_id=$1",[c.communication_id]);
 await request('POST',`/v1/review/sessions/${s.id}/respond`,{expected_revision:s.revision,review_item_id:s.next_item.id,request_id:'stale-response',intent:'ACCEPT',utterance:'Yes'},409);
 assert.equal((await request('GET','/v1/classifications/candidates?thread_id=stale')).length,0);
});
test('classification rejects invented quotes and promises attributed to another participant',()=>{
 const source={body:'I will send it.',direction:'inbound'};const n=normalizePromiseEvidence(source);
 assert.throws(()=>validateCandidates(source,n,{items:[candidate('made up')]}),/ungrounded/);
 assert.throws(()=>validateCandidates(source,n,{items:[candidate(source.body,'PROMISE',{actor_ref:'local'})]}),/speaker/);
});
test('new operational tables and functions deny public roles',async()=>{
 for(const role of ['anon','authenticated']){const r=await sql.query("select has_table_privilege($1,'review_sessions','select') ok, has_function_privilege($1,'respond_operational_review(text,uuid,text,integer,text,text,text,text,text)','execute') exec",[role]);assert.equal(r.rows[0].ok,false);assert.equal(r.rows[0].exec,false);}
 const s=(await sql.query('select id from review_sessions limit 1')).rows[0];
 const scoped=tenantDatabase(createPostgresClient(sql),'other');assert.equal((await scoped.from('review_sessions').select('*').eq('id',s.id)).data.length,0);
});

test('accepted candidate is not duplicated or downgraded by later legacy extraction',async()=>{
 const text='I will reserve the venue.';const c=await ingest(text,'later-worker');await classification(c,[candidate(text)]);
 let s=await request('POST','/v1/review/sessions',{thread_id:'later-worker'});s=await request('POST',`/v1/review/sessions/${s.id}/advance`,{expected_revision:s.revision});
 await request('POST',`/v1/review/sessions/${s.id}/respond`,{expected_revision:s.revision,review_item_id:s.next_item.id,request_id:'reserve',utterance:'Yes',intent:'ACCEPT'});
 const job=(await sql.query("update promise_jobs set status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes' where communication_id=$1 returning *",[c.communication_id])).rows[0];
 await processPromiseJob(db,job,{extractor:async()=>[{segment_id:'body',quote:text,description:text,kind:'promised',confidence:0.95}],destination:null});
 const rows=(await sql.query('select * from communication_commitments where communication_id=$1',[c.communication_id])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].review_state,'confirmed');
});

test('expected deliverables have a separate revisioned completion path',async()=>{
 const objects=await request('GET','/v1/operational-objects');const o=objects.find(x=>x.type==='EXPECTED_DELIVERABLE');
 const result=await request('POST',`/v1/operational-objects/${o.id}/resolve`,{expected_revision:o.revision,status:'FULFILLED',reason:'The figures arrived.'});
 assert.equal(result.status,'FULFILLED');assert.equal(result.history.length,1);
 await request('POST',`/v1/operational-objects/${o.id}/resolve`,{expected_revision:o.revision,status:'OPEN',reason:'Stale change'},409);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {redactExport} from '../tenantLifecycle.js';
import {createPhase02Database} from './fixtures/phase02Database.js';
test('tenant suspension, scoped export, local erasure and late-write tombstone use real PostgreSQL',async()=>{
 const f=await createPhase02Database('lifecycle_fixture','controlled_lifecycle_operator');
 const op=async(operation,revision,id)=> (await f.sql.query('select tenant_data_lifecycle($1,$2,$3,$4,$5) receipt',['lifecycle_fixture','controlled_operator',id,operation,revision])).rows[0].receipt;
 try{
  await f.sql.query("insert into tenants(tenant_id) values('other_fixture')");
  const contact=(await f.sql.query("insert into contacts(tenant_id,name,phone_number) values('lifecycle_fixture','Controlled contact','+61400000222') returning id")).rows[0];
  await f.sql.query("insert into contacts(tenant_id,name,phone_number) values('other_fixture','Other contact','+61400000333')");
  const sourceResponse=await f.app.inject({method:'POST',url:'/v1/communications',headers:{'x-api-key':'controlled_lifecycle_operator'},payload:{direction:'inbound',channel:'email',identity:'+61400000222',thread_id:'lifecycle_thread',content:'I will prepare the controlled report.',correlation:{external_project_id:'lifecycle_project'}}});
  assert.equal(sourceResponse.statusCode,201,sourceResponse.body);const source=sourceResponse.json();
  await f.sql.query("insert into communication_facts(tenant_id,fact_key,text,thread_id,source_communication_ids,contact_id) values('lifecycle_fixture','controlled_fact','Controlled report pending',$1,$2::text[],$3)",[source.thread_id,[source.communication_id],contact.id]);
  await f.sql.query("insert into communication_commitments(tenant_id,communication_id,thread_id,description,source_excerpt,promisor_contact_id) values('lifecycle_fixture',$1,$2,'Prepare report','I will prepare the controlled report.',$3)",[source.communication_id,source.thread_id,contact.id]);
  const suspended=await op('suspend',1,'suspend_0001');assert.equal(suspended.status,'suspended');
  assert.deepEqual(await op('suspend',1,'suspend_0001'),suspended);
  await assert.rejects(f.sql.query("insert into contacts(tenant_id,name) values('lifecycle_fixture','Late callback')"),/unavailable/);
  const page=(await f.sql.query("select export_tenant_data_page('lifecycle_fixture',2,'contacts',0) page")).rows[0].page;
  assert.equal(page.rows.length,1);assert.equal(page.rows[0].id,contact.id);assert.equal(page.nextOffset,null);
  await assert.rejects(f.sql.query("select export_tenant_data_page('lifecycle_fixture',2,'mailbox_oauth_credentials',0)"),/unavailable/);
  const erased=await op('erase_local',2,'erase_0001');assert.equal(erased.status,'closed');assert.equal(erased.externalCleanup,'not-performed');
  assert.equal((await f.sql.query("select count(*)::int n from contacts where tenant_id='lifecycle_fixture'")).rows[0].n,0);
  assert.equal((await f.sql.query("select count(*)::int n from contacts where tenant_id='other_fixture'")).rows[0].n,1);
  for(const table of ['communications','communication_threads','communication_facts','communication_commitments','communication_enrichment_jobs','thread_resolution_decisions'])assert.equal((await f.sql.query(`select count(*)::int n from ${table} where tenant_id='lifecycle_fixture'`)).rows[0].n,0,table);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/context/memory',headers:{'x-api-key':'controlled_lifecycle_operator'},payload:{kind:'person',id:contact.id}})).statusCode,403);
  const uncovered=(await f.sql.query("select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id' and table_name not in(select name from tenant_data_sets) and table_name not in('tenants','tenant_admin_audit','tenant_api_budgets','tenant_api_usage','tenant_lifecycle_receipts')")).rows;assert.deepEqual(uncovered,[]);
  assert.deepEqual(await op('erase_local',2,'erase_0001'),erased);
  await assert.rejects(op('resume',3,'resume_0001'),/cannot be reactivated/);
  await assert.rejects(f.sql.query("insert into contacts(tenant_id,name) values('lifecycle_fixture','Late callback')"),/unavailable/);
 }finally{await f.close();}
});

test('REST lifecycle enforces authority, revision and recovery while paused jobs do not starve another tenant',async()=>{
 const f=await createPhase02Database('lifecycle_http','controlled_lifecycle_operator');
 const h={'x-api-key':'controlled_lifecycle_operator'};
 const req=async(method,url,payload,headers=h)=>{const r=await f.app.inject({method,url,headers,...(payload?{payload}:{})});return{status:r.statusCode,body:r.json()};};
 try{
  await f.sql.query("insert into tenants(tenant_id) values('other_http')");
  await f.sql.query("insert into communication_enrichment_jobs(tenant_id,communication_id,job_type,status,next_attempt_at) values('lifecycle_http','fixture_comm','memory','pending',now()-interval '1 day'),('other_http','other_comm','memory','pending',now())");
  const client=await req('POST','/v1/tenant/clients',{operation:'create',keyId:'lifecycle_admin',name:'Limited administrator',roles:['admin'],capabilities:['communications:read','communications:write','tenant:manage'],secret:'controlled_lifecycle_fixture_secret_001',expiresAt:new Date(Date.now()+86400000).toISOString()});assert.equal(client.status,200);
  const limited={'x-api-key':'lifecycle_admin.controlled_lifecycle_fixture_secret_001','x-tenant-id':'lifecycle_http'};
  assert.equal((await req('POST','/v1/tenant/lifecycle',{operation:'erase_local',revision:1,requestId:'erase_limited',confirmation:'Erase Communications local tenant data'},limited)).status,403);
  const suspended=await req('POST','/v1/tenant/lifecycle',{operation:'suspend',revision:1,requestId:'suspend_http_01'});assert.equal(suspended.status,200,JSON.stringify(suspended));
  assert.equal((await req('GET','/v1/meetings')).status,403);
  assert.equal((await req('GET','/v1/tenant/lifecycle?dataset=contacts&revision=2',null,limited)).status,403);
  assert.equal((await req('GET','/v1/tenant/lifecycle?dataset=contacts&revision=2')).status,200);
  const claimed=(await f.sql.query('select * from claim_enrichment_job()')).rows;assert.equal(claimed.length,1);assert.equal(claimed[0].tenant_id,'other_http');
  const resumed=await req('POST','/v1/tenant/lifecycle',{operation:'resume',revision:2,requestId:'resume_http_01'});assert.equal(resumed.status,200);
  assert.equal((await req('GET','/v1/meetings')).status,200);
  await f.sql.query("insert into outbound_operations(tenant_id,idempotency_key,operation_type,request_hash,communication_id) values('lifecycle_http','pending_fixture','sms','fixture','pending_comm')");
  assert.equal((await req('POST','/v1/tenant/lifecycle',{operation:'suspend',revision:3,requestId:'suspend_http_02'})).status,409);
  assert.equal((await req('GET','/v1/tenant/lifecycle')).body.tenant.status,'active');
 }finally{await f.close();}
});

test('portable exports remove nested authentication material while preserving source text',()=>{
 assert.equal(redactExport('https://example.invalid/download?token=controlled'), '[redacted capability URL]');
 const row=redactExport({body:'A controlled promise',metadata:{apiKey:'secret',Authorization:'bearer',nested:[{access_token:'token',name:'Contact'}]}});
 assert.equal(row.body,'A controlled promise');assert.equal(row.metadata.apiKey,'[redacted]');assert.equal(row.metadata.nested[0].access_token,'[redacted]');assert.equal(row.metadata.nested[0].name,'Contact');
});

test('lifecycle tables and functions remain server-only under deployment roles',async()=>{
 const f=await createPhase02Database('lifecycle_roles','controlled_roles_key',{serverRoles:true});
 try{
  for(const role of ['anon','authenticated']){
   assert.equal((await f.sql.query("select has_table_privilege($1,'tenant_lifecycle_receipts','SELECT') allowed",[role])).rows[0].allowed,false);
   assert.equal((await f.sql.query("select has_function_privilege($1,'tenant_data_lifecycle(text,text,text,text,integer)','EXECUTE') allowed",[role])).rows[0].allowed,false);
  }
  await f.sql.query("insert into contacts(tenant_id,name) values('lifecycle_roles','Role fixture')");
  await f.sql.query('set role service_role');
  const suspended=(await f.sql.query("select tenant_data_lifecycle('lifecycle_roles','operator','roles_suspend','suspend',1) receipt")).rows[0].receipt;assert.equal(suspended.status,'suspended');
  const erased=(await f.sql.query("select tenant_data_lifecycle('lifecycle_roles','operator','roles_erase','erase_local',2) receipt")).rows[0].receipt;assert.equal(erased.status,'closed');
  assert.equal((await f.sql.query("select count(*)::int n from contacts where tenant_id='lifecycle_roles'")).rows[0].n,0);
 }finally{await f.sql.query('reset role');await f.close();}
});

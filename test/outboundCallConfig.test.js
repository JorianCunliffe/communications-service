import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresClient} from '../database.js';
import {freezeOutboundCallConfig,restoreOutboundCallConfig} from '../outboundCallConfig.js';
import {buildTwiml} from '../config.js';

test('approved briefing configuration survives worker/cache loss and media authorization is claimed once',async()=>{
 const sql=new PGlite();
 try {
  await sql.exec(`create table outbound_operations(id uuid primary key, tenant_id text, operation_type text,
    communication_id text,status text,provider_id text,audit_context jsonb not null default '{}',created_at timestamptz default now());`);
  const id='12345678-1234-1234-1234-123456789abc',sid='CA'+'1'.repeat(32),db=createPostgresClient(sql);
  await sql.query("insert into outbound_operations(id,tenant_id,operation_type,communication_id,status) values($1,'a','voice','comm_test','reserved')",[id]);
  const op=(await sql.query('select * from outbound_operations where id=$1',[id])).rows[0];
  const approved={tenantId:'a',communicationId:'comm_test',threadId:'thread_test',personId:'person_test',
    outboundTo:'+15550000001',serviceIdentity:'+15550000000',systemMessage:'Approved verification-first briefing',
    greetingText:'Welcome to the daily briefing',tools:['hyperflow_briefing'],briefingPrivate:true};
  const frozen=await freezeOutboundCallConfig(db,op,approved);
  assert.match(frozen.mediaCapability,/^[a-f0-9]{64}$/);
  const args={tenantId:'a',operationId:id,callSid:sid,from:approved.serviceIdentity,to:approved.outboundTo};
  const restored=await restoreOutboundCallConfig(db,args);
  assert.deepEqual(restored,frozen);
  assert.equal(restored.systemMessage,approved.systemMessage);
  assert.deepEqual(restored.tools,['hyperflow_briefing']);
  assert.match(buildTwiml(restored,'voice.example'),/Parameter name="operationId"/);
  assert.match(buildTwiml(restored,'voice.example'),/Parameter name="mediaCapability"/);
  await assert.rejects(restoreOutboundCallConfig(db,{...args,tenantId:'b'}),/unavailable/);
  await assert.rejects(restoreOutboundCallConfig(db,{...args,to:'+15550000002'}),/participants/);
  await assert.rejects(restoreOutboundCallConfig(db,{...args,callSid:'CA'+'2'.repeat(32)}),/unavailable/);
  await assert.rejects(restoreOutboundCallConfig(db,{...args,claimMedia:true,mediaCapability:'f'.repeat(64)}),/authorization/);
  const claims=await Promise.allSettled([1,2].map(()=>restoreOutboundCallConfig(db,{...args,claimMedia:true,mediaCapability:frozen.mediaCapability})));
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(claims.filter(r=>r.status==='rejected').length,1);
  await assert.rejects(restoreOutboundCallConfig(db,{...args,claimMedia:true,mediaCapability:frozen.mediaCapability}));
  const saved=(await sql.query('select * from outbound_operations where id=$1',[id])).rows[0];
  assert.deepEqual(await freezeOutboundCallConfig(db,saved,{...approved,systemMessage:'changed defaults'}),frozen);
  await sql.query("update outbound_operations set created_at=now()-interval '2 hours' where id=$1",[id]);
  await assert.rejects(restoreOutboundCallConfig(db,args),/unavailable/);
 } finally {await sql.close();}
});

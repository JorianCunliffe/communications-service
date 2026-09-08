import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhase02Database } from './fixtures/phase02Database.js';

test('tenant client lifecycle persists one audited claim, rotates, expires and isolates credentials',async()=>{
  const f=await createPhase02Database('client_fixture','controlled_operator_key');
  const headers={'x-api-key':'controlled_operator_key','x-tenant-id':'client_fixture'};
  const request=async(method,url,body,h=headers)=>{
    const r=await f.app.inject({method,url,headers:h,...(body?{payload:body}:{})});
    return {status:r.statusCode,body:r.json()};
  };
  const secret='controlled-fixture-secret-not-production-01';
  const input={operation:'create',keyId:'fixture_reader',name:'Controlled reader',secret,
    expiresAt:new Date(Date.now()+86400000).toISOString(),roles:['reader'],capabilities:['communications:read']};
  try{
    const created=await Promise.all([request('POST','/v1/tenant/clients',input),request('POST','/v1/tenant/clients',input)]);
    assert.deepEqual(created.map(r=>r.status),[200,200],JSON.stringify(created));
    assert.equal(created[0].body.item.key_id,created[1].body.item.key_id);
    assert.equal(created[0].body.item.secret_hash,undefined);
    assert.equal(created[0].body.item.request_hash,undefined);
    assert.equal((await f.sql.query("select count(*)::int n from tenant_admin_audit")).rows[0].n,1);
    const child={'x-api-key':`fixture_reader.${secret}`,'x-tenant-id':'client_fixture'};
    assert.equal((await request('GET','/v1/meetings',null,child)).status,200);
    assert.equal((await request('POST','/v1/tenant/usage',{revision:1,dailyLimit:2})).status,200);
    const budgeted=await Promise.all([request('GET','/v1/meetings',null,child),request('GET','/v1/meetings',null,child)]);
    assert.deepEqual(budgeted.map(r=>r.status).sort(),[200,429]);
    const usage=await request('GET','/v1/tenant/usage');
    assert.equal(usage.body.days[0].requests,2);
    assert.equal((await request('POST','/v1/tenant/usage',{revision:usage.body.policy.revision,dailyLimit:0})).status,200);
    assert.equal((await request('GET','/v1/tenant/clients',null,child)).status,403);
    assert.equal((await request('GET','/v1/meetings',null,{...child,'x-tenant-id':'other_fixture'})).status,403);
    assert.equal((await request('POST','/v1/tenant/clients',{...input,name:'Conflict'})).status,409);
    const newSecret='controlled-fixture-secret-not-production-02';
    const rotated=await request('POST','/v1/tenant/clients',{operation:'rotate',keyId:input.keyId,revision:1,secret:newSecret,expiresAt:input.expiresAt});
    assert.equal(rotated.status,200,JSON.stringify(rotated));
    assert.equal(rotated.body.item.revision,2);
    const repeated=await request('POST','/v1/tenant/clients',{operation:'rotate',keyId:input.keyId,revision:1,secret:newSecret,expiresAt:input.expiresAt});
    assert.equal(repeated.body.item.revision,2);assert.equal(repeated.body.item.rotation_hash,undefined);
    assert.equal((await request('GET','/v1/meetings',null,child)).status,401);
    const current={...child,'x-api-key':`fixture_reader.${newSecret}`};
    assert.equal((await request('GET','/v1/meetings',null,current)).status,200);
    assert.equal((await request('POST','/v1/tenant/clients',{operation:'revoke',keyId:input.keyId,revision:1})).status,409);
    await f.sql.query("update api_clients set expires_at=now()-interval '1 second' where key_id='fixture_reader'");
    assert.equal((await request('GET','/v1/meetings',null,current)).status,401);
    const revoked=await request('POST','/v1/tenant/clients',{operation:'revoke',keyId:input.keyId,revision:2});
    assert.equal(revoked.status,200);
    assert.equal((await request('POST','/v1/tenant/clients',{operation:'revoke',keyId:input.keyId,revision:2})).status,200);
    assert.equal((await request('GET','/v1/tenant/audit')).body.items.length,5);
    const list=await request('GET','/v1/tenant/clients');
    assert.equal(list.body.items.length,1);
    assert.equal(list.body.items[0].secret_hash,undefined);
    const grants=await f.sql.query("select has_function_privilege('public','public.manage_tenant_api_client(text,text,text,text,integer,jsonb)','EXECUTE') allowed");
    assert.equal(grants.rows[0].allowed,false);
  }finally{await f.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhase02Database} from './fixtures/phase02Database.js';
test('phone contact creation reuses trigger identity and rolls back conflicting identities',async()=>{
 const tenant='contact_test';const fixture=await createPhase02Database(tenant,'local-contact');
 const request=body=>fixture.app.inject({method:'POST',url:'/v1/contacts',headers:{'x-api-key':'local-contact','x-tenant-id':tenant},payload:body});
 try {
  const response=await request({name:'Carol',phone_number:'+61414022817'});
  assert.equal(response.statusCode,201,response.body);
  const id=response.json().person_id;
  const identities=await fixture.sql.query('select person_id,type,value,provider from communication_identities where tenant_id=$1',[tenant]);
  assert.deepEqual(identities.rows,[{person_id:id,type:'phone',value:'+61414022817',provider:'twilio'}]);
  const duplicate=await request({name:'Other',phone_number:'+61414022817'});
  assert.equal(duplicate.statusCode,500);
  const conflict=await request({name:'Imposter',identities:[{type:'phone',value:'+61414022817',provider:'twilio'}]});
  assert.equal(conflict.statusCode,500);
  assert.equal((await fixture.sql.query('select count(*)::int n from contacts where tenant_id=$1',[tenant])).rows[0].n,1);
  const extra=await request({name:'Pat',phone_number:'+61400000002',identities:[{type:'phone',value:'+61400000002',provider:'twilio',metadata:{label:'work'}},{type:'email',value:'pat@example.test'}]});
  assert.equal(extra.statusCode,201,extra.body);
  const metadata=await fixture.sql.query('select metadata from communication_identities where person_id=$1 and type=$2',[extra.json().person_id,'phone']);
  assert.equal(metadata.rows[0].metadata.label,'work');
 } finally {await fixture.close();}
});

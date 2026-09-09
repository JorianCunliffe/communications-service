import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhase02Database} from './fixtures/phase02Database.js';
import {createPostgresClient} from '../database.js';
import {resolveInboundVoiceThread} from '../inboundConversation.js';
test('inbound voice resumes one recent conversation but separates ambiguous cases and other people',async()=>{
 const tenant='continuity_test';const fixture=await createPhase02Database(tenant,'local-continuity');
 const db=createPostgresClient(fixture.sql);
 const request=async(url,payload)=>{const r=await fixture.app.inject({method:'POST',url,payload,headers:{'x-api-key':'local-continuity','x-tenant-id':tenant}});assert.ok(r.statusCode<300,r.body);return r.json();};
 try {
  const person=await request('/v1/contacts',{name:'Alex',identities:[{type:'phone',value:'+61400000001'},{type:'email',value:'alex@example.test'}]});
  const first=await request('/v1/communications',{direction:'inbound',channel:'email',identity:'alex@example.test',thread_id:'thread_alpha',content:'The status pack is due Wednesday.',correlation:{external_project_id:'alpha'}});
  const options={db,tenantId:tenant,personId:person.person_id,from:'+61400000001',to:'+61400000009',communicationId:'comm_voice_one'};
  const resumed=await resolveInboundVoiceThread(options);assert.equal(resumed.threadId,first.thread_id);
  await request('/v1/communications',{direction:'inbound',channel:'sms',identity:'+61400000001',thread_id:'thread_beta',content:'An unrelated invoice.',correlation:{external_project_id:'beta'}});
  const ambiguous=await resolveInboundVoiceThread({...options,communicationId:'comm_voice_two'});assert.notEqual(ambiguous.threadId,first.thread_id);assert.notEqual(ambiguous.threadId,'thread_beta');
  const other=await request('/v1/contacts',{name:'Pat',identities:[{type:'phone',value:'+61400000002'}]});
  const separate=await resolveInboundVoiceThread({...options,personId:other.person_id,from:'+61400000002',communicationId:'comm_voice_three'});assert.notEqual(separate.threadId,first.thread_id);
 } finally {await fixture.close();}
});

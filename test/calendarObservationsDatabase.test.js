import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPhase02Database} from './fixtures/phase02Database.js';
test('calendar observations are monotonic and tenant scoped, with exact contact enrichment and cancelled candidate exclusion',async()=>{
 const fixture=await createPhase02Database('calendar_fixture','calendar_key');
 try{
 const request=async(url,payload)=>fixture.app.inject({method:'POST',url,headers:{'x-api-key':'calendar_key','x-tenant-id':'calendar_fixture'},payload});
 const person=(await request('/v1/contacts',{name:'Alex',identities:[{type:'email',value:'alex@example.test'}]})).json().person_id;
 const event={provider:'google',provider_id:'calendar:event',title:'Supplier review',starts_at:'2026-09-10T00:00:00Z',ends_at:'2026-09-10T01:00:00Z',participants:[{type:'email',value:'ALEX@example.test'}],metadata:{external_project_id:'alpha',observed_at:'2026-09-08T10:00:00Z'}};
 let response=await request('/v1/calendar/events',event);assert.equal(response.statusCode,201,response.body);assert.equal(response.json().participants[0].contact_id,person);
 response=await request('/v1/calendar/events',{...event,title:'Corrected review',participants:[],metadata:{...event.metadata,status:'cancelled',observed_at:'2026-09-08T11:00:00Z'}});assert.equal(response.statusCode,201,response.body);
 response=await request('/v1/calendar/events',event);assert.equal(response.statusCode,201,response.body);assert.equal(response.json().stale,true);assert.equal(response.json().event.title,'Corrected review');assert.equal(response.json().participants.length,0);
 response=await request('/v1/calendar/events',{...event,metadata:{}});assert.equal(response.statusCode,400);
 response=await request('/v1/calendar/events',{...event,metadata:{...event.metadata,status:'cancelled',observed_at:'2026-09-08T12:00:00Z'}});assert.equal(response.statusCode,201,response.body);assert.equal(response.json().participants[0].contact_id,person);
 const candidates=await fixture.app.inject({method:'GET',url:`/v1/calendar/candidates?person_id=${person}&occurred_at=2026-09-10T00:30:00Z`,headers:{'x-api-key':'calendar_key','x-tenant-id':'calendar_fixture'}});assert.equal(candidates.statusCode,200);assert.deepEqual(candidates.json().calendarCandidates,[]);
 response=await request('/v1/calendar/events',{...event,provider_id:'bad-contact',participants:[{contact_id:'11111111-1111-4111-8111-111111111111'}]});assert.equal(response.statusCode,400);
 const rows=await fixture.sql.query('select * from calendar_events where tenant_id=$1',['other_tenant']);assert.equal(rows.rows.length,0);
 }finally{await fixture.close();}
});

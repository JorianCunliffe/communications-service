import test from 'node:test';import assert from 'node:assert/strict';
import{CommunicationsClient,CommunicationsApiError}from'../client/communications.js';
test('Communications client fixes tenant headers and returns uncertain outcomes without replay',async()=>{
 let calls=0;let sent;
 const client=new CommunicationsClient('https://example.com',{apiKey:'fixture',tenantId:'tenant-a',fetcher:async(url,init)=>{calls++;sent={url:String(url),init};return Response.json({error:'Uncertain provider operation'},{status:503});}});
 await assert.rejects(client.clientOperation({operation:'rotate',revision:2}),e=>e instanceof CommunicationsApiError&&e.status===503);
 assert.equal(calls,1);assert.equal(sent.init.headers['X-Tenant-Id'],'tenant-a');assert.equal(sent.init.redirect,'error');
 assert.equal(JSON.stringify(client).includes('fixture'),false);
 await assert.rejects(client.request('POST','https://other.example/v1/sms'),/relative/);
 assert.throws(()=>new CommunicationsClient('https://example.com',{apiKey:'fixture'}),/fixed tenant/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { usableOutlookCredential } from '../outlookMailbox.js';
import { syncOutlookMailbox } from '../mailboxService.js';
import { sealMailboxCredential, openMailboxCredential } from '../mailboxCrypto.js';
const fresh = {access_token:'old-access',refresh_token:'old-refresh',expires_at:Date.now()+3600000};
test('normal use retains valid token; forced refresh exchanges it and preserves rotation', async()=>{
 let calls=0;
 const refresh=async token=>{assert.equal(token,'old-refresh');calls++;return {access_token:'new-access',refresh_token:'new-refresh',expires_in:3600};};
 assert.equal((await usableOutlookCredential(fresh,{refresh})).refreshed,false);
 assert.equal(calls,0);
 const result=await usableOutlookCredential(fresh,{forceRefresh:true,refresh});
 assert.equal(calls,1); assert.equal(result.refreshed,true); assert.equal(result.credential.refresh_token,'new-refresh');
 assert.equal(fresh.access_token,'old-access');
});
test('forced refresh does not fall back to cached token after failure',async()=>{
 await assert.rejects(usableOutlookCredential(fresh,{forceRefresh:true,refresh:async()=>{throw Error('invalid_grant');}}),/invalid_grant/);
 await assert.rejects(usableOutlookCredential({access_token:'valid',expires_at:Date.now()+3600000},{forceRefresh:true}),/refresh token is unavailable/);
 const result=await usableOutlookCredential(fresh,{forceRefresh:true,refresh:async()=>({access_token:'new',expires_in:3600})});
 assert.equal(result.credential.refresh_token,'old-refresh');
});
test('forced sync saves encrypted rotated credentials, uses new token, and scopes tenant',async()=>{
 const keys=['MAILBOX_CREDENTIAL_ENCRYPTION_KEY','MICROSOFT_OAUTH_CLIENT_ID','MICROSOFT_OAUTH_CLIENT_SECRET','MICROSOFT_OAUTH_TENANT'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]])); const previousFetch=globalThis.fetch;
 process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
 process.env.MICROSOFT_OAUTH_CLIENT_ID='test-client';process.env.MICROSOFT_OAUTH_CLIENT_SECRET='test-secret';process.env.MICROSOFT_OAUTH_TENANT='organizations';
 const tenant='test-tenant',connection='test-connection',aad='communications-mailbox:'+tenant+':'+connection;
 const tables={provider_connections:[{tenant_id:tenant,id:connection,provider:'outlook',enabled:true,channels:['email'],provider_account_id:'test@example.com'}],service_identities:[{tenant_id:tenant,provider_connection_id:connection,channel:'email',can_receive:true,id:'identity'}],mailbox_oauth_credentials:[{tenant_id:tenant,provider_connection_id:connection,encrypted_payload:sealMailboxCredential(fresh,aad)}],mailbox_sync_state:[{tenant_id:tenant,provider_connection_id:connection}],mailbox_audit_events:[]};
 const db={rpc:async()=>({data:true,error:null}),from(table){let filters=[],action='select',payload;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},maybeSingle(){return q},single(){return q},upsert(v){action='upsert';payload=v;return q},update(v){action='update';payload=v;return q},insert(v){action='insert';payload=v;return q},then(resolve,reject){return Promise.resolve().then(()=>{const rows=tables[table]||[];let row=rows.find(r=>filters.every(([k,v])=>r[k]===v));if(action==='upsert'){row=rows.find(r=>r.provider_connection_id===payload.provider_connection_id);if(row)Object.assign(row,payload);else rows.push(payload);}if(action==='update'&&row)Object.assign(row,payload);if(action==='insert')rows.push(payload);return {data:row||null,error:null};}).then(resolve,reject)}};return q;}};
 let refreshCalls=0,graphCalls=0;
 globalThis.fetch=async(url,options)=>{url=String(url);if(url.includes('login.microsoftonline.com')){refreshCalls++;assert.equal(options.body.get('grant_type'),'refresh_token');assert.equal(options.body.get('refresh_token'),'old-refresh');return new Response(JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}),{status:200});}assert.ok(url.startsWith('https://graph.microsoft.com/'));assert.equal(options.headers.authorization,'Bearer new-access');graphCalls++;return new Response(JSON.stringify({value:[],'@odata.deltaLink':'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?cursor=test'}),{status:200});};
 try{
  await assert.rejects(syncOutlookMailbox(db,{tenantId:'other-tenant',connectionId:connection,forceRefresh:true}),/unavailable/);assert.equal(refreshCalls,0);
  const result=await syncOutlookMailbox(db,{tenantId:tenant,connectionId:connection,forceRefresh:true});
  assert.equal(result.token_refreshed,true);assert.equal(result.status,'healthy');assert.equal(refreshCalls,1);assert.ok(graphCalls>0);
  const stored=openMailboxCredential(tables.mailbox_oauth_credentials[0].encrypted_payload,aad);assert.equal(stored.refresh_token,'new-refresh');assert.equal(stored.access_token,'new-access');
  assert.equal(tables.mailbox_audit_events.at(-1).details.token_refreshed,true);assert.ok(!JSON.stringify(result).includes('new-access'));
 }finally{globalThis.fetch=previousFetch;for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}}
});

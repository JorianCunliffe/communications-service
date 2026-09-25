import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresClient } from '../database.js';
import { createMailboxDraft } from '../mailboxService.js';
import { sealMailboxCredential } from '../mailboxCrypto.js';

test('draft creation obeys the migrated SQL status constraint and replay never duplicates a provider draft', async()=>{
 const sql=new PGlite(); const oldKey=process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY;const oldFetch=globalThis.fetch;
 process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
 const tenant='draft-test',connection='00000000-0000-4000-8000-000000000099';let calls=0;
 try{
  await sql.exec("create table tenants(tenant_id text primary key); create table provider_connections(id uuid primary key,tenant_id text,provider text,enabled boolean,channels text[],provider_account_id text,unique(tenant_id,id)); create table mailbox_oauth_credentials(tenant_id text,provider_connection_id uuid,encrypted_payload text); create table mailbox_audit_events(tenant_id text,provider_connection_id uuid,actor_id text,action text,outcome text,details jsonb);");
  const migration=readFileSync(new URL('../migrations/016_connected_mailboxes.sql',import.meta.url),'utf8');
  const ddl=migration.match(/create table if not exists public\.mailbox_drafts \([\s\S]*?\n\);/i)?.[0];assert.ok(ddl);await sql.exec(ddl);
  await sql.query('insert into tenants values ($1)',[tenant]);
  await sql.query("insert into provider_connections values ($1,$2,'outlook',true,ARRAY['email'],'owner@example.com')",[connection,tenant]);
  await sql.query('insert into mailbox_oauth_credentials values ($1,$2,$3)',[tenant,connection,sealMailboxCredential({access_token:'fake-access',expires_at:Date.now()+3600000},'communications-mailbox:'+tenant+':'+connection)]);
  const db=createPostgresClient({query:async(text,params)=>{const r=await sql.query(text,params);return {...r,rowCount:r.affectedRows??r.rows.length};}});
  globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://graph.microsoft.com/v1.0/me/messages');assert.equal(options.method,'POST');const row=(await sql.query('select status from mailbox_drafts')).rows[0];assert.equal(row.status,'creating');calls++;return new Response(JSON.stringify({id:'provider-draft',conversationId:'thread-1'}),{status:201});};
  const input={tenantId:tenant,connectionId:connection,idempotencyKey:'draft-replay-test',request:{to:['enquirer@example.com'],subject:'Viewing enquiry',text:'Which property are you interested in?'}};
  const created=await createMailboxDraft(db,input);assert.equal(created.status,'created');assert.equal(created.provider_draft_id,'provider-draft');assert.equal(calls,1);
  const replay=await createMailboxDraft(db,input);assert.equal(replay.id,created.id);assert.equal(calls,1);
  await assert.rejects(createMailboxDraft(db,{...input,request:{...input.request,text:'Different'}}),/different draft content/);assert.equal(calls,1);
  await sql.query("update mailbox_drafts set status='creating'");
  await assert.rejects(createMailboxDraft(db,input),/reconciliation/);assert.equal(calls,1);
  await assert.rejects(createMailboxDraft(db,{...input,tenantId:'other-tenant'}),/unavailable/);assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY;else process.env.MAILBOX_CREDENTIAL_ENCRYPTION_KEY=oldKey;await sql.close();}
});

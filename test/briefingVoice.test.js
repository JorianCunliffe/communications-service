import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { callBriefing, withBriefing, publishBriefingVerification } from "../briefingVoice.js";
import {createVoiceTurns} from '../voiceTurns.js';
import {createBriefingTurnEvidence} from '../briefingTurnEvidence.js';

const spokenReadback=(evidence,{text='Exact proposal. Confirm this change?',played=true}={})=>{
  evidence.audio('readback',100);evidence.markSent('readback-mark','readback');evidence.audioDone('readback');evidence.transcript('readback',text);
  if(played)evidence.markPlayed('readback-mark',110);
};
test('readback validation rejection is explicit while transport failures remain uncertain',async()=>{
  const oldUrl=process.env.HYPERFLOW_EVENT_URL,oldSecret=process.env.COMMUNICATIONS_WEBHOOK_SECRET;
  process.env.HYPERFLOW_EVENT_URL='https://fixture.invalid/api/events';process.env.COMMUNICATIONS_WEBHOOK_SECRET='fixture-secret';
  const context={briefingPrivate:true,tenantId:'fixture',personId:'person',threadId:'thread',communicationId:'call',serviceIdentity:'line'};
  try{
    for(const error of ['Read the exact proposal aloud in full before requesting confirmation','Read the exact proposal and obtain a clear new confirmation from the caller','Wait for the caller to confirm after the complete readback']){
    const result=await callBriefing({operation:'confirm_change',id:'proposal'},context,{fetchBriefing:async()=>({ok:false,status:422,json:async()=>({error})})});
    assert.equal(result.status,'confirmation_rejected');assert.equal(result.confirmationAccepted,false);assert.match(result.nextStep,/change_result/);assert.match(result.nextStep,/Do not describe it as processing or saved/);
    }
    await assert.rejects(callBriefing({operation:'confirm_change',id:'proposal'},context,{fetchBriefing:async()=>{throw new Error('Network timeout');}}),/Network timeout/);
  }finally{if(oldUrl===undefined)delete process.env.HYPERFLOW_EVENT_URL;else process.env.HYPERFLOW_EVENT_URL=oldUrl;if(oldSecret===undefined)delete process.env.COMMUNICATIONS_WEBHOOK_SECRET;else process.env.COMMUNICATIONS_WEBHOOK_SECRET=oldSecret;}
});
test('confirmation keeps the fully played readback when an assistant acknowledgement follows the caller yes',()=>{
  const e=createBriefingTurnEvidence();spokenReadback(e);e.humanStarted(120);e.humanCommitted('yes');e.humanTranscript('yes','Yes',130);
  e.audio('ack',140);e.transcript('ack','I am saving that now');e.audioDone('ack');e.markSent('ack-mark','ack');e.markPlayed('ack-mark',150);
  assert.equal(e.evidence().assistant.text,'Exact proposal. Confirm this change?');
  assert.equal(e.evidence().assistant.playedAt,110);assert.equal(e.evidence().human.at,120);
});
test('late readback transcription uses actual playback times, not the transcript arrival time',()=>{
  const e=createBriefingTurnEvidence();e.audio('readback',100);e.markSent('m','readback');e.audioDone('readback');e.markPlayed('m',110);e.humanStarted(120);e.humanCommitted('yes');e.humanTranscript('yes','Yes',130);e.transcript('readback','The exact readback');
  assert.deepEqual(e.evidence().assistant,{text:'The exact readback',at:100,itemId:'readback',playedAt:110,interrupted:false});
});
test('interrupted or unplayed readbacks and their late playback echoes never authorise confirmation',()=>{
  const e=createBriefingTurnEvidence();spokenReadback(e,{played:false});e.humanStarted(105);e.humanCommitted('yes');e.markPlayed('readback-mark',110);e.humanTranscript('yes','Yes',120);assert.equal(e.evidence().assistant,null);
  const unspoken=createBriefingTurnEvidence();unspoken.transcript('readback','Exact proposal');unspoken.humanStarted(100);unspoken.humanCommitted('yes');unspoken.humanTranscript('yes','Yes',120);assert.equal(unspoken.evidence().assistant,null);
});
test('an unrelated assistant question and a later caller turn cannot reuse an older confirmation',()=>{
  const e=createBriefingTurnEvidence();spokenReadback(e);e.audio('question',115);e.transcript('question','Do you want a report?');e.audioDone('question');e.markSent('q','question');e.markPlayed('q',116);e.humanStarted(120);e.humanCommitted('old');e.humanStarted(130);e.humanCommitted('new');e.humanTranscript('old','Yes',140);
  assert.equal(e.evidence().human,null);e.humanTranscript('new','Wait',150);assert.equal(e.evidence().human.text,'Wait');assert.equal(e.evidence().assistant.text,'Do you want a report?');
});
test('confirmation waits for the matching caller transcript rather than reusing an older yes',async()=>{
  const e=createBriefingTurnEvidence();spokenReadback(e);e.humanStarted(120);e.humanCommitted('yes');const pending=e.waitForHuman(200);e.humanTranscript('yes','Yes',130);assert.equal((await pending).human.itemId,'yes');
});
import { applyHyperFlowVoiceContext } from "../hyperflowVoice.js";
import { buildToolDefinitions } from "../tools.js";
import { toolAuditArgs } from "../toolAudit.js";
import {persistCallOutcome} from '../callOutcome.js';
import {persistBriefingPrivacy} from '../callLog.js';
import {createPostgresClient} from '../database.js';
import {PGlite} from '@electric-sql/pglite';

test('verification completed after caller interruption remains trusted context without stale speech or repeated tools',async()=>{
  let finish,epoch=0;const sent=[],speech=[],executed=[];
  const turns=createVoiceTurns({generation:()=>epoch,sendResponse:x=>speech.push(x),endAfterPlayback:()=>{},runTool:async(call)=>{
    executed.push(call.name);const output=await new Promise(resolve=>{finish=resolve;});
    publishBriefingVerification({name:call.name,args:{operation:'verify_code',code:'SECRET'},output,privateCall:true,send:x=>sent.push(x)});
    return {name:call.name,output};
  }});
  const pending=turns.done({id:'verify-response',status:'completed',output:[{type:'function_call',name:'hyperflow_briefing',call_id:'verify'}]});
  epoch++;turns.interrupt();
  finish({status:'verified',sections:['tasks','approvals','reports','UNTRUSTED']});await pending;
  assert.equal(sent.length,1);assert.equal(speech.length,0);assert.deepEqual(executed,['hyperflow_briefing']);
  const message=JSON.stringify(sent[0]);assert.match(message,/SMS verification SUCCEEDED/);assert.match(message,/list_tasks/);assert.doesNotMatch(message,/SECRET|UNTRUSTED/);
  for(const input of [{error:'expired'},{output:{status:'code_sent'}},{privateCall:false},{name:'other'},{args:{operation:'list_tasks'}}]){
    assert.equal(publishBriefingVerification({name:'hyperflow_briefing',args:{operation:'verify_code'},output:{status:'verified'},privateCall:true,send:()=>assert.fail('must not assert verification'),...input}),false);
  }
});

test('briefing privacy saves by canonical communication ID, verifies the saved row and isolates tenants', async()=>{
  const sql=new PGlite();
  try {
    await sql.exec(`create table communications (
      id uuid primary key default gen_random_uuid(), tenant_id text not null,
      communication_id text not null, memory_eligible boolean not null default true,
      unique(tenant_id,communication_id));
      insert into communications(tenant_id,communication_id) values ('a','comm_private'),('b','comm_private');`);
    const db=createPostgresClient(sql);
    await persistBriefingPrivacy(db,'a','comm_private');
    const {rows}=await sql.query('select tenant_id,memory_eligible from communications order by tenant_id');
    assert.deepEqual(rows,[{tenant_id:'a',memory_eligible:false},{tenant_id:'b',memory_eligible:true}]);
    await assert.rejects(persistBriefingPrivacy(db,'a','comm_missing'),/could not be persisted/);
    await persistBriefingPrivacy(db,'a','comm_private');
  } finally {await sql.close();}
});

test('successful private briefing calls stay out of general memory after outcome persistence',async()=>{
  const outcome={successful:true,disposition:'human_conversation',memoryEligible:true,failureCode:null,reason:null,source:'test',confidence:1,evidence:{}};
  for(const privateCall of [false,true]){
    const call={id:'call1',purpose:{type:'coaching_session'},metadata:{briefingPrivate:privateCall}};let saved;
    const db={from:()=>{const q={update:(value)=>{saved={...call,...value};return q;},eq:()=>q,select:()=>q,maybeSingle:async()=>({data:saved,error:null})};return q;}};
    const result=await persistCallOutcome(db,call,outcome);
    assert.equal(result.successful,true);assert.equal(result.memory_eligible,!privateCall);
  }
});

test("verification secrets are redacted from both receptionist and briefing tool audits", () => {
  assert.deepEqual(toolAuditArgs("reception_verify", { code: "secret" }), {
    redacted: true,
  });
  assert.deepEqual(
    toolAuditArgs("hyperflow_briefing", {
      operation: "verify_code",
      code: "123456",
    }),
    { redacted: true },
  );
  assert.deepEqual(
    toolAuditArgs("hyperflow_briefing", { operation: "list_tasks" }),
    { operation: "list_tasks" },
  );
});

test("briefing is offered for enrolled coaching identities, with signed trusted provenance and allowlisted arguments", async () => {
  const keys = ["HYPERFLOW_EVENT_URL", "COMMUNICATIONS_WEBHOOK_SECRET"];
  const old = keys.map((k) => process.env[k]);
  process.env.HYPERFLOW_EVENT_URL = "https://hyperflow.example/api/events";
  process.env.COMMUNICATIONS_WEBHOOK_SECRET = "test-secret";
  try {
    const config = { personId: "person", tools: [], systemMessage: "Coaching", greetingText:"Let's start with what we agreed last time." };
    const enabled = withBriefing(config, { type: "coaching_session" },true);
    assert.equal(withBriefing(config,{type:'coaching_session'}),config);
    assert.equal(enabled.tools.includes("hyperflow_briefing"), true);
    assert.equal(enabled.briefingPromptVersion,'briefing-first.v2');
    assert.match(enabled.greetingText,/daily briefing.*tasks, approvals and reports.*verification code/);
    assert.doesNotMatch(enabled.greetingText,/what we agreed last time/);
    assert.match(enabled.systemMessage,/briefing is the first activity/);
    assert.equal(
      buildToolDefinitions(enabled.tools).some(
        (t) => t.name === "hyperflow_briefing",
      ),
      true,
    );
    assert.equal(withBriefing(config, { type: "test_call" }), config);
    assert.equal(
      withBriefing({ ...config, personId: null }, { type: "coaching_session" },true)
        .tools.length,
      0,
    );
    const context = {
      briefingPrivate: true,
      tenantId: "org",
      personId: "person",
      threadId: "thread",
      communicationId: "call",
      serviceIdentity: "+61000000000",
      briefingHumanTurn: { text: "confirm", at: 123 },
      briefingAssistantTurn: { text: "Readback", at: 122 },
    };
    const result = await callBriefing(
      {
        operation: "list_tasks",
        subject: "me",
        tenant_id: "evil",
        uid: "other",
        evidence: { text: "fabricated" },
      },
      context,
      {
        fetchBriefing: async (url, options, policy) => {
          assert.equal(url, "https://hyperflow.example/api/agent/briefing");
          assert.equal(policy.maxRedirects, 0);
          assert.deepEqual(policy.allowedHosts, ["hyperflow.example"]);
          const body = JSON.parse(options.body);
          assert.equal(body.tenant_id, "org");
          assert.equal(body.person_id, "person");
          assert.deepEqual(body.args, {
            operation: "list_tasks",
            subject: "me",
          });
          assert.deepEqual(body.evidence.human, context.briefingHumanTurn);
          assert.equal(
            options.headers["x-communications-signature-v2"],
            `sha256=${createHmac("sha256", "test-secret").update(`${options.headers["x-communications-timestamp"]}.${options.body}`).digest("hex")}`,
          );
          return { ok: true, json: async () => ({ items: [] }) };
        },
      },
    );
    assert.deepEqual(result, { items: [] });
    await assert.rejects(
      callBriefing({ operation: "report" }, { ...context, personId: null }),
      /Trusted personId/,
    );
    const inbound = applyHyperFlowVoiceContext(config, {
      greeting: "Hello",
      instructions: "Continue",
      captureEnabled: true, briefingEnabled:true,
    });
    assert.equal(inbound.tools.includes("hyperflow_briefing"), true);
    assert.equal(
      applyHyperFlowVoiceContext(config, {
        greeting: "Hello",
        instructions: "Continue",
      }).tools.includes("hyperflow_briefing"),
      false,
    );
  } finally {
    keys.forEach((k, i) =>
      old[i] === undefined ? delete process.env[k] : (process.env[k] = old[i]),
    );
  }
});

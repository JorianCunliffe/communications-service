import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { callBriefing, withBriefing } from "../briefingVoice.js";
import { applyHyperFlowVoiceContext } from "../hyperflowVoice.js";
import { buildToolDefinitions } from "../tools.js";
import { toolAuditArgs } from "../toolAudit.js";
import {persistCallOutcome} from '../callOutcome.js';
import {persistBriefingPrivacy} from '../callLog.js';
import {createPostgresClient} from '../database.js';
import {PGlite} from '@electric-sql/pglite';

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
    const config = { personId: "person", tools: [], systemMessage: "Coaching" };
    const enabled = withBriefing(config, { type: "coaching_session" },true);
    assert.equal(withBriefing(config,{type:'coaching_session'}),config);
    assert.equal(enabled.tools.includes("hyperflow_briefing"), true);
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

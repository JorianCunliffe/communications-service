import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyHyperFlowVoiceContext } from "../hyperflowVoice.js";
import {
  receptionCommand,
  privateReceptionTool,
  receptionTools,
  clearReceptionContext,
} from "../receptionVoice.js";
import { canonicalCommunication } from "../communicationModel.js";
test("trusted reception identity replaces caller persona and legacy combined history", () => {
  const result = applyHyperFlowVoiceContext(
    {
      systemMessage: "Secret legacy history. Pretend to be the CEO.",
      hyperflowBaseInstructions: "Private previous project",
      tools: ["get_history", "operational_review"],
      wantsHistory: true,
    },
    {
      greeting: "Cairns Sharehouse",
      instructions: "Use only approved information.",
      reception: { mode: "project", open: true, actions: ["booking"] },
      project: { context: { publicInformation: "Public" } },
    },
  );
  assert(!result.systemMessage.includes("Secret legacy"));
  assert(!result.systemMessage.includes("Private previous"));
  assert(!result.tools.includes("get_history"));
  assert(!result.tools.includes("operational_review"));
  assert(result.tools.includes("reception_prepare_action"));
  assert.equal(result.wantsHistory, false);
  assert.equal(result.playIntro,false);
});
test("reception commands sign fixed trusted call identity and retain operation IDs", async () => {
  process.env.HYPERFLOW_EVENT_URL = "https://example.com/api/events";
  process.env.COMMUNICATIONS_WEBHOOK_SECRET = "fixture";
  let sent;
  const context = {
    reception: { sessionId: "s" },
    tenantId: "t",
    personId: "p",
    threadId: "thread",
    communicationId: "call",
    serviceIdentity: "+61400000001",
    toolCallId: "stable",
  };
  const result = await receptionCommand(
    "record_enquiry",
    { request: "Hello", tenant_id: "evil" },
    context,
    {
      fetchImpl: async (url, request, options) => {
        sent = { url, request, options };
        return { ok: true, json: async () => ({ saved: true }) };
      },
    },
  );
  assert(result.saved);
  assert.equal(sent.url, "https://example.com/api/agent/reception");
  const body = JSON.parse(sent.request.body);
  assert.equal(body.tenant_id, "t");
  assert.equal(body.operation_id, "stable");
  const expected =
    "sha256=" +
    createHmac("sha256", "fixture")
      .update(
        `${sent.request.headers["x-communications-timestamp"]}.${sent.request.body}`,
      )
      .digest("hex");
  assert.equal(sent.request.headers["x-communications-signature-v2"], expected);
  await assert.rejects(
    receptionCommand("record_enquiry", {}, {}),
    /active reception/,
  );
  delete process.env.HYPERFLOW_EVENT_URL;
  delete process.env.COMMUNICATIONS_WEBHOOK_SECRET;
});
test("switch deletes prior model messages and tool outputs, retaining only current function call", () => {
  const messages = [],
    ids = new Set(["oldcaller", "oldtool", "oldassistant", "current"]);
  clearReceptionContext(
    { send: (v) => messages.push(JSON.parse(v)) },
    ids,
    "current",
  );
  assert.deepEqual([...ids], ["current"]);
  assert.equal(messages.length, 3);
  assert(messages.every((m) => m.type === "conversation.item.delete"));
});
test("model tools expose no arbitrary project, URL, code or permission channel", () => {
  assert(!Object.hasOwn(receptionTools, "record_segments"));
  for (const tool of Object.values(receptionTools)) {
    assert.equal(tool.parameters.additionalProperties, false);
    for (const key of [
      "projectId",
      "url",
      "credentials",
      "permissions",
      "tenant_id",
      "operation_id",
    ])
      assert(!Object.hasOwn(tool.parameters.properties, key));
  }
});
test("whole reception calls and verification SMS are not eligible cross-project memories", () => {
  for (const type of ["project_reception", "reception_verification"])
    assert.equal(
      canonicalCommunication({ purpose: { type }, memoryEligible: true })
        .outcome.memory_eligible,
      false,
    );
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert(source.includes("name==='reception_verify'?{redacted:true}:args"));
  assert(source.includes("privateReceptionSegments.has(s.id)"));
  assert(source.includes("!output?.reception"));
  const resolver = readFileSync(
    new URL("../configResolver.js", import.meta.url),
    "utf8",
  );
  assert(resolver.includes("combined_history:null"));
});

test("staff answers remain private even when the model prepares a known Ask directly", () => {
  assert(privateReceptionTool("reception_prepare_action", {kind:"ask"}));
  assert(privateReceptionTool("reception_pending_asks"));
  assert(!privateReceptionTool("reception_prepare_action", {kind:"booking"}));
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPhase02Database } from "./fixtures/phase02Database.js";
import { tenantDatabase } from "../tenantContext.js";
import { createPostgresClient } from "../database.js";
import {
  classifyCommunication,
  evaluateFulfilment,
  validateCandidates,
} from "../operationalIntelligence.js";
import {
  readPromise,
  normalizePromiseEvidence,
  processPromiseJob,
} from "../promiseLedger.js";
let fixture, db, app, sql, alice;
const headers = {
  "x-api-key": "operational-test",
  "x-tenant-id": "operational",
};
const request = async (method, url, payload, status = 200) => {
  const r = await app.inject({ method, url, payload, headers });
  assert.equal(r.statusCode, status, r.body);
  return r.json();
};
const candidate = (text, type = "PROMISE", extra = {}) => ({
  type,
  segment_id: "body",
  source_text: text,
  summary: text,
  actor_ref: "counterparty",
  target_id: null,
  condition: null,
  confidence: 0.95,
  due_text: null,
  ...extra,
});
test('malformed contact and project IDs are rejected without leaking database errors', async () => {
  for (const path of ['/v1/contacts/not-a-uuid', '/v1/contacts/not-a-uuid/memory', '/v1/projects/not-a-uuid/memory']) {
    const result = await request('GET', path, undefined, 400);
    assert.match(result.error, /^Invalid (contact|project) ID$/);
  }
});
const ingest = async (text, thread = "review-thread") =>
  request(
    "POST",
    "/v1/communications",
    {
      direction: "inbound",
      channel: "email",
      identity: "alice@example.com",
      content: text,
      thread_id: thread,
      correlation: { external_project_id: "alpha" },
    },
    201,
  );
const classification = (c, items) =>
  classifyCommunication(
    db,
    { communication_id: c.communication_id },
    {},
    { classifier: async () => ({ items }) },
  );
before(async () => {
  fixture = await createPhase02Database("operational", "operational-test", {
    serverRoles: true,
  });
  ({ app, sql } = fixture);
  db = tenantDatabase(createPostgresClient(sql), "operational");
  alice = (
    await request(
      "POST",
      "/v1/contacts",
      {
        name: "Alice",
        identities: [{ type: "email", value: "alice@example.com" }],
      },
      201,
    )
  ).person_id;
});
after(async () => fixture?.close());
test("conditional promise creates only speaker commitment and a separate expected deliverable", async () => {
  const text = "I will send the report if Dave provides the figures today.";
  const c = await ingest(text);
  await classification(c, [
    candidate(text, "CONDITIONAL_PROMISE", {
      condition: "Dave provides figures today",
    }),
    candidate(text, "EXPECTED_DELIVERABLE", {
      summary: "Figures from Dave",
      actor_ref: "local",
    }),
  ]);
  let s = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
  });
  assert.equal(s.stage, "BRIEFING");
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  assert.equal(s.stage, "REVIEW");
  while (s.stage === "REVIEW") {
    const q = s.next_item;
    s = await request("POST", `/v1/review/sessions/${s.id}/respond`, {
      expected_revision: s.revision,
      review_item_id: q.id,
      request_id: q.id,
      utterance: "Yes, track it.",
      intent: "ACCEPT",
    });
  }
  const promises = (await sql.query("select * from communication_commitments"))
    .rows;
  assert.equal(promises.length, 1);
  assert.equal(promises[0].promisor_parties[0].person_id, alice);
  assert.equal(promises[0].conditions[0].status, "pending");
  assert.equal((await readPromise(db, promises[0].id)).source_current, true);
  assert.equal(
    (
      await sql.query(
        "select count(*)::int n from operational_objects where type='EXPECTED_DELIVERABLE'",
      )
    ).rows[0].n,
    1,
  );
  const action = await request("POST", `/v1/review/sessions/${s.id}/actions`, {
    instruction: "Remind me to call Dave tomorrow.",
    request_id: "reminder-1",
  });
  assert.equal(action.status, "NEEDS_CLARIFICATION");
  assert.equal(
    (
      await request("POST", `/v1/review/sessions/${s.id}/actions`, {
        instruction: "Remind me to call Dave tomorrow.",
        request_id: "reminder-1",
      })
    ).id,
    action.id,
  );
  s = await request("GET", `/v1/review/sessions/${s.id}`);
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  assert.equal(s.stage, "SUMMARY");
  assert.match(s.prompt, /queued/);
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  assert.equal(s.stage, "COMPLETED");
});
test("fulfilment evidence requires human confirmation and pending conditions block completion", async () => {
  const p = (await sql.query("select * from communication_commitments limit 1"))
    .rows[0];
  const c = await ingest("Attached is the completed report.");
  await evaluateFulfilment(
    db,
    p.id,
    { communication_id: c.communication_id },
    {},
    {
      evaluator: async () => ({
        assessment: "LIKELY_FULFILLED",
        confidence: 0.96,
        reason: "The report was supplied",
        quote: "Attached is the completed report.",
        condition_id: null,
      }),
    },
  );
  assert.notEqual((await readPromise(db, p.id)).observed_state, "fulfilled");
  let s = await request("POST", "/v1/review/sessions", {});
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  const q = s.review_queue.find((q) => q.operation === "verify_fulfillment");
  const body = {
    expected_revision: s.revision,
    review_item_id: q.id,
    request_id: "fulfil-1",
    utterance: "Yes, completed.",
    intent: "ACCEPT",
  };
  await request("POST", `/v1/review/sessions/${s.id}/respond`, body, 400);
  assert.equal(
    (await request("GET", `/v1/review/sessions/${s.id}`)).revision,
    s.revision,
  );
  await request(
    "PATCH",
    `/v1/promises/${p.id}/conditions/${p.conditions[0].id}`,
    {
      expected_revision: p.revision,
      reason: "Figures arrived",
      patch: { status: "satisfied" },
    },
  );
  await request("POST", `/v1/review/sessions/${s.id}/respond`, body, 409);
  await evaluateFulfilment(
    db,
    p.id,
    { communication_id: c.communication_id },
    {},
    {
      evaluator: async () => ({
        assessment: "LIKELY_FULFILLED",
        confidence: 0.96,
        reason: "Report supplied",
        quote: "Attached is the completed report.",
        condition_id: null,
      }),
    },
  );
  s = await request("POST", "/v1/review/sessions", {});
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  const fresh = s.review_queue.find(
    (q) => q.operation === "verify_fulfillment",
  );
  const accepted = {
    ...body,
    expected_revision: s.revision,
    review_item_id: fresh.id,
  };
  const result = await request(
    "POST",
    `/v1/review/sessions/${s.id}/respond`,
    accepted,
  );
  assert.equal((await readPromise(db, p.id)).observed_state, "fulfilled");
  assert.equal(
    (await request("POST", `/v1/review/sessions/${s.id}/respond`, accepted))
      .revision,
    result.revision,
  );
});
test("source changes invalidate classification and review; idempotency keys cannot be reused for other sources", async () => {
  const c = await ingest("I will book the room.", "stale");
  await classification(c, [candidate("I will book the room.")]);
  let s = await request("POST", "/v1/review/sessions", { thread_id: "stale" });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  await sql.query(
    "update communications set body='Never mind.' where communication_id=$1",
    [c.communication_id],
  );
  await request(
    "POST",
    `/v1/review/sessions/${s.id}/respond`,
    {
      expected_revision: s.revision,
      review_item_id: s.next_item.id,
      request_id: "stale-response",
      intent: "ACCEPT",
      utterance: "Yes",
    },
    409,
  );
  assert.equal(
    (await request("GET", "/v1/classifications/candidates?thread_id=stale"))
      .length,
    0,
  );
});
test("classification rejects invented quotes and promises attributed to another participant", () => {
  const source = { body: "I will send it.", direction: "inbound" };
  const n = normalizePromiseEvidence(source);
  assert.throws(
    () => validateCandidates(source, n, { items: [candidate("made up")] }),
    /ungrounded/,
  );
  assert.throws(
    () =>
      validateCandidates(source, n, {
        items: [candidate(source.body, "PROMISE", { actor_ref: "local" })],
      }),
    /speaker/,
  );
});
test("new operational tables and functions deny public roles", async () => {
  for (const role of ["anon", "authenticated"]) {
    const r = await sql.query(
      "select has_table_privilege($1,'review_sessions','select') ok, has_function_privilege($1,'respond_operational_review(text,uuid,text,integer,text,text,text,text,text,jsonb)','execute') exec",
      [role],
    );
    assert.equal(r.rows[0].ok, false);
    assert.equal(r.rows[0].exec, false);
  }
  const s = (await sql.query("select id from review_sessions limit 1")).rows[0];
  const scoped = tenantDatabase(createPostgresClient(sql), "other");
  assert.equal(
    (await scoped.from("review_sessions").select("*").eq("id", s.id)).data
      .length,
    0,
  );
});

test("accepted candidate is not duplicated or downgraded by later legacy extraction", async () => {
  const text = "I will reserve the venue.";
  const c = await ingest(text, "later-worker");
  await classification(c, [candidate(text)]);
  let s = await request("POST", "/v1/review/sessions", {
    thread_id: "later-worker",
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  await request("POST", `/v1/review/sessions/${s.id}/respond`, {
    expected_revision: s.revision,
    review_item_id: s.next_item.id,
    request_id: "reserve",
    utterance: "Yes",
    intent: "ACCEPT",
  });
  const job = (
    await sql.query(
      "update promise_jobs set status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes' where communication_id=$1 returning *",
      [c.communication_id],
    )
  ).rows[0];
  await processPromiseJob(db, job, {
    extractor: async () => [
      {
        segment_id: "body",
        quote: text,
        description: text,
        kind: "promised",
        confidence: 0.95,
      },
    ],
    destination: null,
  });
  const rows = (
    await sql.query(
      "select * from communication_commitments where communication_id=$1",
      [c.communication_id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].review_state, "confirmed");
});

test("expected deliverables have a separate revisioned completion path", async () => {
  const objects = await request("GET", "/v1/operational-objects");
  const o = objects.find((x) => x.type === "EXPECTED_DELIVERABLE");
  const result = await request(
    "POST",
    `/v1/operational-objects/${o.id}/resolve`,
    {
      expected_revision: o.revision,
      status: "FULFILLED",
      reason: "The figures arrived.",
    },
  );
  assert.equal(result.status, "FULFILLED");
  assert.equal(result.history.length, 1);
  await request(
    "POST",
    `/v1/operational-objects/${o.id}/resolve`,
    { expected_revision: o.revision, status: "OPEN", reason: "Stale change" },
    409,
  );
});

test("one event yields two conditions and fulfilment; retries reuse receipt; one session confirms all", async () => {
  const text =
    "I will deliver the analysis if figures arrive and the scope is approved.";
  const c = await ingest(text, "multi");
  await classification(c, [
    candidate(text, "CONDITIONAL_PROMISE", { condition: "Figures arrive" }),
  ]);
  let s = await request("POST", "/v1/review/sessions", { thread_id: "multi" });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/respond`, {
    expected_revision: s.revision,
    review_item_id: s.next_item.id,
    request_id: "multi-create",
    utterance: "Yes",
    intent: "ACCEPT",
  });
  let p = (
    await sql.query(
      "select * from communication_commitments where description=$1",
      [text],
    )
  ).rows[0];
  await request("POST", `/v1/promises/${p.id}/conditions`, {
    expected_revision: p.revision,
    reason: "Track scope",
    patch: { description: "Scope approved" },
  });
  p = await readPromise(db, p.id);
  const event = await ingest(
    "Figures received, scope approved, and the final analysis is delivered.",
    "other-thread",
  );
  const evaluator = async () => ({
    assessments: [
      ...p.conditions.map((c) => ({
        assessment: "CONDITION_LIKELY_SATISFIED",
        condition_id: c.id,
        confidence: 0.97,
        reason: c.description,
        quote: "Figures received, scope approved",
      })),
      {
        assessment: "LIKELY_FULFILLED",
        condition_id: null,
        confidence: 0.97,
        reason: "Analysis delivered",
        quote: "the final analysis is delivered.",
      },
    ],
  });
  const first = await evaluateFulfilment(
    db,
    p.id,
    { communication_id: event.communication_id },
    {},
    { evaluator },
  );
  const repeat = await evaluateFulfilment(
    db,
    p.id,
    { communication_id: event.communication_id },
    {},
    {
      evaluator: () => {
        throw Error("Must reuse receipt");
      },
    },
  );
  assert.equal(first.receipt.id, repeat.receipt.id);
  assert.equal(first.assessments.length, 3);
  s = await request("POST", "/v1/review/sessions", { thread_id: "multi" }); // cross-thread evidence requires project-wide scope
  s = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  for (const operation of [
    "condition_update",
    "condition_update",
    "verify_fulfillment",
  ]) {
    const q = s.review_queue.find(
      (q) =>
        q.promise_id === p.id &&
        q.status === "PENDING" &&
        q.operation === operation,
    );
    assert.ok(q, operation);
    s = await request("POST", `/v1/review/sessions/${s.id}/respond`, {
      expected_revision: s.revision,
      review_item_id: q.id,
      request_id: q.id,
      utterance: "Yes, confirmed.",
      intent: "ACCEPT",
    });
  }
  assert.equal((await readPromise(db, p.id)).observed_state, "fulfilled");
  assert.equal(s.responses.filter((r) => r.object_id === p.id).length, 3);
});

test("partial progress, dated snooze and explicit correction persist without fulfilling or clearing due date", async () => {
  const p = await request(
    "POST",
    "/v1/promises",
    {
      reason: "Track work",
      patch: {
        description: "Deliver two parts",
        promisor_parties: [{ person_id: alice, label: "Alice" }],
        promisee_parties: [],
        external_project_id: "alpha",
        due: {
          status: "confirmed",
          date_candidate: "2026-01-01",
          timezone: "Australia/Brisbane",
        },
      },
    },
    201,
  );
  let s = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
    request_id: "durable-start",
  });
  assert.equal(
    (
      await request("POST", "/v1/review/sessions", {
        external_project_id: "alpha",
        request_id: "durable-start",
      })
    ).id,
    s.id,
  );
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  let q = s.review_queue.find((q) => q.promise_id === p.id);
  assert.ok(q);
  const body = {
    expected_revision: s.revision,
    review_item_id: q.id,
    request_id: "partial",
    utterance: "Only the first part is complete",
    intent: "PARTIAL",
  };
  s = await request("POST", `/v1/review/sessions/${s.id}/respond`, body);
  assert.notEqual((await readPromise(db, p.id)).observed_state, "fulfilled");
  let next = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
  });
  assert.ok(!next.review_queue.some((q) => q.promise_id === p.id));
  await sql.query(
    "update review_tasks set snoozed_until=now()-interval '1 second' where item_id=$1",
    [q.id],
  );
  next = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
  });
  next = await request("POST", `/v1/review/sessions/${next.id}/advance`, {
    expected_revision: next.revision,
  });
  q = next.review_queue.find((q) => q.promise_id === p.id);
  next = await request("POST", `/v1/review/sessions/${next.id}/respond`, {
    expected_revision: next.revision,
    review_item_id: q.id,
    request_id: "correction",
    utterance: "Call it deliver the remaining part",
    intent: "CORRECT",
    details: { patch: { description: "Deliver the remaining part" } },
  });
  const changed = await readPromise(db, p.id);
  assert.equal(changed.description, "Deliver the remaining part");
  assert.equal(changed.due_interpretation.date_candidate, "2026-01-01");
  assert.ok(next.change_summary.some((c) => c.object_id === p.id));
});

test("low confidence cannot commit; snooze hides across sessions and preserves original answer", async () => {
  const c = await ingest("I will prepare the slides.", "snooze");
  await classification(c, [candidate("I will prepare the slides.")]);
  let s = await request("POST", "/v1/review/sessions", { thread_id: "snooze" });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  const body = {
    expected_revision: s.revision,
    review_item_id: s.next_item.id,
    request_id: "uncertain",
    utterance: "Maybe",
    intent: "ACCEPT",
    confidence: 0.3,
  };
  assert.equal(
    (await request("POST", `/v1/review/sessions/${s.id}/respond`, body))
      .requires_clarification,
    true,
  );
  const snoozed_until = new Date(Date.now() + 86400000).toISOString();
  await request("POST", `/v1/review/sessions/${s.id}/respond`, {
    ...body,
    confidence: 1,
    request_id: "snooze",
    utterance: "Ask tomorrow",
    intent: "SNOOZE",
    details: { snoozed_until },
  });
  const again = await request("POST", "/v1/review/sessions", {
    thread_id: "snooze",
  });
  assert.equal(again.review_queue.length, 0);
  assert.equal(
    (
      await sql.query("select history from review_tasks where item_id=$1", [
        body.review_item_id,
      ])
    ).rows[0].history[0].utterance,
    "Ask tomorrow",
  );
});

test("action dispatch requires resolved authorization; callback receipts are monotonic", async () => {
  const s = await request("POST", "/v1/review/sessions", {
    external_project_id: "empty",
  });
  await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  process.env.REVIEW_ACTION_DISPATCH_ENABLED = "true";
  process.env.HYPERFLOW_EVENT_URL = "https://example.com/events";
  try {
    const action = await request(
      "POST",
      `/v1/review/sessions/${s.id}/actions`,
      {
        request_id: "resolved-task",
        instruction: "Create a task",
        authorized: true,
        proposal: {
          version: "review-action.v1",
          type: "task",
          project_id: "empty",
          parameters: { title: "Draft report" },
        },
      },
    );
    assert.equal(action.status, "QUEUED");
    await request(
      "POST",
      `/v1/review/actions/${action.id}/result`,
      { status: "SUCCEEDED", receipt_id: "bad", result: {} },
      400,
    );
    const body = {
      status: "SUCCEEDED",
      receipt_id: "receipt-1",
      result: {
        provider_id: "task:123",
        completed_at: new Date().toISOString(),
        summary: "Task created",
      },
    };
    assert.equal(
      (await request("POST", `/v1/review/actions/${action.id}/result`, body))
        .status,
      "SUCCEEDED",
    );
    assert.equal(
      (await request("POST", `/v1/review/actions/${action.id}/result`, body))
        .status,
      "SUCCEEDED",
    );
    await request(
      "POST",
      `/v1/review/actions/${action.id}/result`,
      { status: "FAILED", receipt_id: "receipt-2", result: {} },
      409,
    );
  } finally {
    delete process.env.REVIEW_ACTION_DISPATCH_ENABLED;
    delete process.env.HYPERFLOW_EVENT_URL;
  }
});

test("canonical owner binding includes counterparty evidence and revoked projects deny resume", async () => {
  const { reviewIdentity } = await import("../reviewIdentity.js");
  const { session } = await import("../reviewEngine.js");
  await sql.query(
    "update tenants set metadata=metadata||jsonb_build_object('promise_ledger',jsonb_build_object('local_person_id',$1::text,'review_owners',jsonb_build_object('legacy:user:test-user',jsonb_build_object('enabled',true,'person_id',$1::text,'project_ids',jsonb_build_array('alpha'))))) where tenant_id='operational'",
    [alice],
  );
  try {
    const identity = await reviewIdentity(
      db,
      { keyId: "legacy" },
      { initiator_id: "test-user" },
    );
    assert.equal(identity.owner, `person:${alice}`);
    const c = await ingest(
      "I will prepare the owner scope example.",
      "owner-scope",
    );
    await classification(c, [
      candidate("I will prepare the owner scope example."),
    ]);
    const s = await request("POST", "/v1/review/sessions", {
      initiator_id: "test-user",
      external_project_id: "alpha",
    });
    assert.ok(
      s.review_queue.some((q) => q.question.includes("owner scope example")),
    );
    assert.equal(
      (await session(db, s.id, `person:${alice}`, identity.scope)).id,
      s.id,
    );
    await assert.rejects(
      session(db, s.id, "person:other", identity.scope),
      /unavailable/,
    );
    await sql.query(
      "update tenants set metadata=jsonb_set(metadata,'{promise_ledger,review_owners,legacy:user:test-user,project_ids}','[]') where tenant_id='operational'",
    );
    await request(
      "GET",
      `/v1/review/sessions/${s.id}?initiator_id=test-user`,
      undefined,
      403,
    );
  } finally {
    await sql.query(
      "update tenants set metadata=metadata-'promise_ledger' where tenant_id='operational'",
    );
  }
});

test("expected deliverable arrival in another thread remains a separate human-confirmed object", async () => {
  const { evaluateExpectedDeliverable } =
    await import("../operationalIntelligence.js");
  const c = await ingest("Please send the budget.", "expectation");
  await classification(c, [
    candidate("Please send the budget.", "EXPECTED_DELIVERABLE"),
  ]);
  let s = await request("POST", "/v1/review/sessions", {
    thread_id: "expectation",
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/respond`, {
    expected_revision: s.revision,
    review_item_id: s.next_item.id,
    request_id: "expect-create",
    utterance: "Track the expected budget",
    intent: "ACCEPT",
  });
  const o = (
    await sql.query(
      "select * from operational_objects where communication_id=$1",
      [c.communication_id],
    )
  ).rows[0];
  const event = await ingest(
    "Here is the completed budget: total is 100.",
    "budget-arrival",
  );
  await evaluateExpectedDeliverable(
    db,
    o.id,
    { communication_id: event.communication_id },
    {},
    {
      evaluator: async () => ({
        assessments: [
          {
            assessment: "LIKELY_FULFILLED",
            confidence: 0.97,
            reason: "Budget supplied",
            quote: "total is 100.",
            condition_id: null,
          },
        ],
      }),
    },
  );
  s = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  const q = s.review_queue.find((q) => q.object_id === o.id && q.candidate_id);
  assert.ok(q);
  await request("POST", `/v1/review/sessions/${s.id}/respond`, {
    expected_revision: s.revision,
    review_item_id: q.id,
    request_id: "budget-arrived",
    utterance: "Yes, it arrived",
    intent: "ACCEPT",
  });
  assert.equal(
    (
      await sql.query("select status from operational_objects where id=$1", [
        o.id,
      ])
    ).rows[0].status,
    "FULFILLED",
  );
  assert.equal(
    (
      await sql.query(
        "select count(*)::int n from communication_commitments where communication_id=$1",
        [c.communication_id],
      )
    ).rows[0].n,
    0,
  );
});

test("mutation failure rolls back condition, evidence, history and queue together", async () => {
  const p = await request(
    "POST",
    "/v1/promises",
    {
      reason: "Regression",
      patch: {
        description: "Transactional report",
        promisor_parties: [{ person_id: alice, label: "Alice" }],
        promisee_parties: [],
        external_project_id: "alpha",
      },
    },
    201,
  );
  const conditional = await request("POST", `/v1/promises/${p.id}/conditions`, {
    expected_revision: p.revision,
    reason: "Wait for source",
    patch: { description: "Data arrives" },
  });
  const event = await ingest("Rollback-only evidence arrived.", "rollback");
  await evaluateFulfilment(
    db,
    p.id,
    { communication_id: event.communication_id },
    {},
    {
      evaluator: async () => ({
        assessment: "CONDITION_LIKELY_SATISFIED",
        confidence: 0.98,
        reason: "Data arrived",
        quote: "Rollback-only evidence arrived.",
        condition_id: conditional.conditions[0].id,
      }),
    },
  );
  let s = await request("POST", "/v1/review/sessions", {
    external_project_id: "alpha",
  });
  s = await request("POST", `/v1/review/sessions/${s.id}/advance`, {
    expected_revision: s.revision,
  });
  const q = s.review_queue.find((q) => q.promise_id === p.id);
  await sql.exec(
    "create function reject_test_evidence() returns trigger language plpgsql as $$ begin if new.quote='Rollback-only evidence arrived.' then raise exception 'Injected persistence failure';end if;return new;end $$;create trigger reject_test_evidence before insert on promise_evidence for each row execute function reject_test_evidence();",
  );
  try {
    await request(
      "POST",
      `/v1/review/sessions/${s.id}/respond`,
      {
        expected_revision: s.revision,
        review_item_id: q.id,
        request_id: "rollback",
        utterance: "Yes",
        intent: "ACCEPT",
      },
      400,
    );
    assert.equal((await readPromise(db, p.id)).revision, conditional.revision);
    assert.equal((await readPromise(db, p.id)).conditions[0].status, "pending");
    assert.equal(
      (await request("GET", `/v1/review/sessions/${s.id}`)).revision,
      s.revision,
    );
  } finally {
    await sql.exec(
      "drop trigger reject_test_evidence on promise_evidence;drop function reject_test_evidence();",
    );
  }
});

test("review candidates scan past unrelated private rows instead of losing visible work", async () => {
  const hidden = await ingest("Private work", "scale-hidden");
  await sql.query(
    "update communications set metadata=metadata||'{\"private\":true}'::jsonb where communication_id=$1",
    [hidden.communication_id],
  );
  const source = (
    await sql.query("select * from communications where communication_id=$1", [
      hidden.communication_id,
    ])
  ).rows[0];
  await sql.query(
    "insert into operational_candidates(tenant_id,communication_id,source_revision,item) select 'operational',$1,$2,jsonb_build_object('type','STATUS_UPDATE','summary','Private','source_text','Private work','evidence_key','scale-'||n) from generate_series(1,505) n",
    [hidden.communication_id, source.promise_revision],
  );
  const c = await ingest("I will finish the visible work.", "scale-visible");
  await classification(c, [candidate("I will finish the visible work.")]);
  const rows = await request("GET", "/v1/classifications/candidates");
  assert.ok(rows.some((r) => r.communication_id === c.communication_id));
  assert.ok(!rows.some((r) => r.communication_id === hidden.communication_id));
  await sql.query(
    "delete from operational_candidates where communication_id=$1",
    [hidden.communication_id],
  );
});

test("owner bindings survive promise-policy updates and callback reporting survives review pause", async () => {
  const policy = await request("GET", "/v1/promises/policy");
  const updated = await request("POST", "/v1/review/owners", {
    expected_revision: policy.version || 0,
    binding_key: "legacy:user:persisted-owner",
    person_id: alice,
    enabled: true,
    project_ids: ["alpha"],
  });
  const changed = await request("POST", "/v1/promises/policy", {
    expected_revision: updated.version,
    enabled: false,
    shadow: true,
    project_ids: ["alpha"],
    local_person_id: alice,
  });
  assert.equal(
    changed.review_owners["legacy:user:persisted-owner"].person_id,
    alice,
  );
  process.env.OWNER_REVIEW_ENABLED = "false";
  try {
    await request("POST", "/v1/review/sessions", {}, 503);
    const a = (
      await sql.query(
        "select * from review_actions where status='SUCCEEDED' limit 1",
      )
    ).rows[0];
    assert.ok(a);
    const result = await request("POST", `/v1/review/actions/${a.id}/result`, {
      status: a.status,
      receipt_id: a.receipt_id,
      result: a.result,
    });
    assert.equal(result.id, a.id);
  } finally {
    delete process.env.OWNER_REVIEW_ENABLED;
  }
});

test('source snapshots replace holds, fence delayed syncs and isolate owner/project/tenant coverage', async () => {
  const { storeReviewSources, readReviewSources } = await import('../reviewSources.js');
  const now = new Date();
  const identity = {owner:`person:${alice}`,scope:{allowed_project_ids:['alpha'],person_id:alice}};
  const base = {source:'holds',project_id:'alpha',state:'current',observed_at:new Date(now.getTime()-2000).toISOString(),items:[{id:'hold-1',project_id:'alpha',status:'waiting'}]};
  await storeReviewSources(db,identity,{snapshots:[base]},now);
  assert.equal((await readReviewSources(db,identity.owner,identity.scope,now)).holds.items.length,1);
  await storeReviewSources(db,identity,{snapshots:[{...base,observed_at:now.toISOString(),items:[]}]},now);
  await storeReviewSources(db,identity,{snapshots:[base]},now);
  assert.equal((await readReviewSources(db,identity.owner,identity.scope,now)).holds.items.length,0);
  assert.equal((await readReviewSources(db,'person:other',identity.scope,now)).holds.state,'not_configured');
  assert.equal((await readReviewSources(db,identity.owner,{allowed_project_ids:[]},now)).holds.items.length,0);
  assert.equal((await readReviewSources(tenantDatabase(createPostgresClient(sql),'other'),identity.owner,identity.scope,now)).holds.items.length,0);
  await assert.rejects(storeReviewSources(db,identity,{snapshots:[{...base,project_id:'forbidden'}]},now),/unavailable/);
  await assert.rejects(storeReviewSources(db,{...identity,owner:'client:legacy'},{snapshots:[base]},now),/canonical/);
  await assert.rejects(storeReviewSources(db,identity,{snapshots:[{...base,items:[{id:'x',project_id:'alpha',status:'resolved'}]}]},now),/open holds/);
  const window = {start:new Date(now.getTime()-86400000).toISOString(),end:new Date(now.getTime()+86400000).toISOString()};
  await storeReviewSources(db,identity,{snapshots:[{...base,source:'calendar',coverage_window:window,items:[]}]},now);
  assert.equal((await readReviewSources(db,identity.owner,identity.scope,now)).calendar.state,'current');
  assert.equal((await readReviewSources(db,identity.owner,{allowed_project_ids:['alpha','beta']},now)).calendar.state,'not_configured');
  assert.equal((await readReviewSources(db,identity.owner,identity.scope,new Date(now.getTime()+3600001))).calendar.state,'stale');
  await storeReviewSources(db,identity,{snapshots:[{...base,source:'calendar',state:'unavailable',observed_at:now.toISOString(),items:[]}]},now);
  assert.equal((await readReviewSources(db,identity.owner,identity.scope,now)).calendar.state,'unavailable');
  assert.deepEqual(await readReviewSources(db,identity.owner,{...identity.scope,thread_id:'one'},now),{});
});

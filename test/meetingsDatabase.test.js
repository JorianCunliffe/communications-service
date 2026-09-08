import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhase02Database } from "./fixtures/phase02Database.js";
import { createPostgresClient } from "../database.js";
import { tenantDatabase } from "../tenantContext.js";
import { storeCommitments, counterpartyContent } from "../enrichment.js";

const payload = () => ({
  source: "generic",
  externalId: "meeting-one",
  sourceVersion: "v1",
  title: "Two project review",
  occurredAt: "2026-09-08T09:00:00+10:00",
  attendees: [
    { id: "alex", name: "Alex", email: "alex@example.com" },
    { id: "unknown", name: "Speaker 2" },
  ],
  topics: [
    {
      id: "alpha-topic",
      title: "Alpha report",
      projectId: "alpha",
      segments: [
        {
          id: "s1",
          speakerId: "alex",
          text: "I will send the report Friday.",
          startMs: 0,
        },
      ],
    },
    {
      id: "beta-topic",
      title: "Beta delivery",
      projectId: "beta",
      segments: [
        {
          id: "s2",
          speakerId: "unknown",
          text: "Delivery date is still unclear.",
          startMs: 5000,
        },
      ],
    },
  ],
});
test("transcribed meeting imports preserve topic isolation, versions, duplicates and uncertain speakers", async () => {
  const tenant = "p05_fixture",
    key = "p05-local";
  const { app, sql, close } = await createPhase02Database(tenant, key);
  const request = (method, url, body) =>
    app.inject({
      method,
      url: "/v1" + url,
      headers: { "x-api-key": key, "x-tenant-id": tenant },
      payload: body,
    });
  try {
    const contact = await request("POST", "/contacts", {
      name: "Alex",
      identities: [{ type: "email", value: "alex@example.com" }],
    });
    assert.equal(contact.statusCode, 201, contact.body);
    const first = await request("POST", "/meetings", payload());
    assert.equal(first.statusCode, 201, first.body);
    const imported = first.json();
    const listed = await request("GET", "/meetings");
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().data[0].id, imported.id);
    assert.equal(imported.topics.length, 2);
    assert.notEqual(imported.topics[0].threadId, imported.topics[1].threadId);
    const duplicate = await request("POST", "/meetings", payload());
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().id, imported.id);
    assert.equal(
      (
        await sql.query(
          "select count(*)::int n from communications where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
      2,
    );
    const get = await request("GET", "/meetings/" + imported.id);
    assert.equal(get.statusCode, 200, get.body);
    assert.equal(
      get.json().metadata.attendees[0].identityStatus,
      "matched_exact",
    );
    assert.equal(get.json().metadata.attendees[1].identityStatus, "unresolved");
    assert.equal(
      get.json().metadata.topics[0].transcript.segments[0].attribution,
      "source_claim",
    );
    const db = tenantDatabase(createPostgresClient(sql), tenant);
    const evidence = (
      await sql.query(
        "select * from communications where communication_id=$1",
        [imported.topics[0].communicationId],
      )
    ).rows[0];
    assert.match(counterpartyContent(evidence), /Alex: I will send/);
    await storeCommitments(db, evidence, {});
    await storeCommitments(db, evidence, {});
    const promises = (
      await sql.query(
        "select * from communication_commitments where communication_id=$1",
        [evidence.communication_id],
      )
    ).rows;
    assert.equal(promises.length, 1);
    assert.equal(promises[0].promisor_contact_id, null);
    assert.match(promises[0].source_excerpt, /I will send the report/);
    const sameVersion = payload();
    sameVersion.topics[0].segments[0].text = "Changed text";
    assert.equal(
      (await request("POST", "/meetings", sameVersion)).statusCode,
      409,
    );
    const differentProvider = { ...payload(), source: "plaud" };
    const suspect = await request("POST", "/meetings", differentProvider);
    assert.equal(suspect.statusCode, 409, suspect.body);
    assert.equal(suspect.json().details.status, "needs_duplicate_review");
    const crossScope = {
      ...payload(),
      sourceVersion: "v2",
      expectedVersion: 1,
      allowedProjectIds: ["alpha"],
    };
    assert.equal(
      (await request("POST", "/meetings", crossScope)).statusCode,
      409,
    );
    const badThread = payload();
    badThread.externalId = "bad-thread";
    badThread.topics[0].threadId = imported.topics[1].threadId;
    assert.equal(
      (await request("POST", "/meetings", badThread)).statusCode,
      409,
    );
    const security = (
      await sql.query(
        "select relrowsecurity from pg_class where relname='recording_revisions'",
      )
    ).rows[0];
    assert.equal(security.relrowsecurity, true);
    assert.equal(
      (
        await sql.query(
          "select prosecdef from pg_proc where proname='ingest_transcribed_meeting'",
        )
      ).rows[0].prosecdef,
      false,
    );
    const corrected = payload();
    corrected.sourceVersion = "v2";
    corrected.expectedVersion = 1;
    corrected.topics[0].segments[0].text =
      "Correction: report remains a proposal.";
    const correction = await request("POST", "/meetings", corrected);
    assert.equal(correction.statusCode, 201, correction.body);
    assert.equal(
      correction.json().topics[0].communicationId,
      imported.topics[0].communicationId,
    );
    assert.equal(
      correction.json().topics[0].threadId,
      imported.topics[0].threadId,
    );
    const correctedEvidence = (
      await sql.query(
        "select * from communications where communication_id=$1",
        [evidence.communication_id],
      )
    ).rows[0];
    await storeCommitments(
      db,
      correctedEvidence,
      {},
      undefined,
      undefined,
      true,
    );
    assert.equal(
      (
        await sql.query(
          "select count(*)::int n from communication_commitments where communication_id=$1",
          [evidence.communication_id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await sql.query("select count(*)::int n from recording_revisions"))
        .rows[0].n,
      2,
    );
    const removed = {
      ...corrected,
      sourceVersion: "v3",
      expectedVersion: 2,
      topics: [corrected.topics[0]],
    };
    assert.equal((await request("POST", "/meetings", removed)).statusCode, 201);
    assert.equal(
      (
        await sql.query(
          "select memory_eligible from communications where communication_id=$1",
          [imported.topics[1].communicationId],
        )
      ).rows[0].memory_eligible,
      false,
    );
    const foreign = await app.inject({
      method: "GET",
      url: "/v1/meetings/" + imported.id,
      headers: { "x-api-key": key, "x-tenant-id": "foreign" },
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(
      (await sql.query("select count(*)::int n from outbound_operations"))
        .rows[0].n,
      0,
    );
  } finally {
    await close();
  }
});

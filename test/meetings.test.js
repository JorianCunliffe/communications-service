import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMeeting } from "../meetings.js";
const input = () => ({
  source: "generic",
  externalId: "one",
  sourceVersion: "1",
  title: "Review",
  occurredAt: "2026-09-08T09:00:00+10:00",
  attendees: [],
  topics: [
    {
      id: "a",
      title: "Report",
      projectId: "alpha",
      segments: [{ id: "s", text: "I will write the report." }],
    },
  ],
});
test("meeting evidence fingerprint ignores provider receipts and asserted authority", () => {
  const first = normalizeMeeting(input());
  const other = normalizeMeeting({
    ...input(),
    source: "other",
    sourceVersion: "2",
    actor: "forged",
    approved: true,
  });
  assert.equal(first.fingerprint, other.fingerprint);
  assert.notEqual(first.key, other.key);
  assert.equal(other.actor, null);
  assert.equal(other.approved, undefined);
});
test("meeting validation rejects ambiguous dates, invalid timing and truncated identities", () => {
  for (const occurredAt of ["2026-02-30T09:00:00Z", "2026-09-08T09:00:00"])
    assert.throws(
      () => normalizeMeeting({ ...input(), occurredAt }),
      /date|timezone/,
    );
  assert.throws(
    () => normalizeMeeting({ ...input(), externalId: "x".repeat(201) }),
    /exceeds/,
  );
  for (const times of [
    { startMs: 10, endMs: 9 },
    { startMs: -1 },
    { endMs: "20" },
  ]) {
    const data = input();
    Object.assign(data.topics[0].segments[0], times);
    assert.throws(() => normalizeMeeting(data), /Segment/);
  }
});
test("meeting speaker claims must reference a supplied attendee", () => {
  const data = input();
  data.topics[0].segments[0].speakerId = "invented";
  assert.throws(() => normalizeMeeting(data), /Speaker reference/);
  delete data.topics[0].segments[0].speakerId;
  assert.equal(
    normalizeMeeting(data).topics[0].segments[0].speaker,
    "Unknown speaker",
  );
});

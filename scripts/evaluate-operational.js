// Opt-in live evaluation. Synthetic fixtures are a development baseline, never
// a substitute for a consented, representative release corpus.
import { readFile } from "node:fs/promises";
import {
  classifyModel,
  classificationOutputSchema,
} from "../operationalIntelligence.js";
import { normalizePromiseEvidence } from "../promiseLedger.js";
import { createHash } from "node:crypto";
if (!process.argv.includes("--live"))
  throw new Error(
    "Use --live with OPENAI_API_KEY to run the real model evaluation",
  );
const cases = JSON.parse(
  await readFile(
    new URL("../evaluation/operational-corpus.json", import.meta.url),
    "utf8",
  ),
);
const rows = [];
let truePositive = 0,
  falsePositive = 0,
  falseNegative = 0,
  actors = 0,
  actorCases = 0;
for (const example of cases) {
  const source = {
    body: example.body,
    direction: "inbound",
    channel: "email",
    occurred_at: "2026-09-20T02:00:00Z",
  };
  const started = Date.now();
  const result = await classifyModel({
    communication: source,
    current: normalizePromiseEvidence(source),
    context: { timezone: "Australia/Brisbane", existing_promises: [] },
  });
  const types = [
    ...new Set(
      result.items.filter((i) => i.type !== "NONE").map((i) => i.type),
    ),
  ];
  truePositive += types.filter((t) => example.expected.includes(t)).length;
  falsePositive += types.filter((t) => !example.expected.includes(t)).length;
  falseNegative += example.expected.filter((t) => !types.includes(t)).length;
  if (example.actor) {
    actorCases++;
    if (
      result.items.some(
        (i) =>
          i.actor_ref === example.actor && example.expected.includes(i.type),
      )
    )
      actors++;
  }
  rows.push({
    id: example.id,
    expected: example.expected,
    actual: types,
    latency_ms: Date.now() - started,
    findings: result.items,
  });
}
console.log(
  JSON.stringify(
    {
      corpus: "synthetic-development.v1",
      measured_at: new Date().toISOString(),
      model: process.env.PROMISE_MODEL || "gpt-5.4-mini",
      contract_sha256: createHash("sha256")
        .update(JSON.stringify(classificationOutputSchema))
        .digest("hex"),
      precision: truePositive / (truePositive + falsePositive || 1),
      recall: truePositive / (truePositive + falseNegative || 1),
      actor_accuracy: actors / (actorCases || 1),
      release_approved: false,
      limitations: [
        "Small synthetic baseline",
        "Date resolution, attachment accuracy and multi-channel reconciliation need representative labelled examples",
        "Set release thresholds after inspecting this baseline",
      ],
      cases: rows,
    },
    null,
    2,
  ),
);

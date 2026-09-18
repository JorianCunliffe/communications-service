# Promise ledger implementation

Implemented locally on 2026-09-18 from Communications `b1eb0b0`, with the HyperFlow consumer in the sibling `hyperflow-5` workspace. No production migration, model evaluation on customer data, or provider sends were performed.

## Accepted behavior

- Communications owns promises and source evidence. HyperFlow owns accepted obligations, Asks and business fulfillment decisions.
- A promise using **we** has joint promisors: both conversational participants. Unknown identity stays as a participant slot, never a fabricated contact. In a multi-party meeting, the participating group is retained. Individual promises retain their specific speaker.
- Capture human statements from either direction and externally communicated agent speech. Preserve meeting segment/speaker provenance. Exclude drafts, failed/audit-only conversations, automated messages and retracted sources.
- One source revision gets one durable receipt independently of the rolling summary window. Processing is asynchronous and can be pending, complete, superseded, excluded, provisional or failed.
- Re-extraction and source correction retain history. An LLM outage leaves provisional explicit evidence and retries; it does not establish that old promises have disappeared.
- Relative dates retain wording, source time, timezone/interpretation and an optional date candidate. No default 5 pm deadline is imposed. Review can confirm an explicit-offset due instant.
- Completion claims do not fulfill HyperFlow obligations. Ledger review and source changes are version checked and audited.

## Main changes

`migrations/028_promise_ledger.sql` extends the existing commitment aggregate and adds `promise_jobs`, `promise_evidence` and immutable `promise_history`. It preserves legacy IDs and status evidence. Queue writes occur with canonical source writes; leases and source revisions fence stale workers. Result/history/outbox writes commit together. All new tables participate in tenant lifecycle controls and export/deletion, enable RLS, and deny anonymous/authenticated direct access. Explicit service grants are tested without host-specific defaults.

`promiseLedger.js` normalizes email/SMS/voice/meeting evidence, extracts and validates cited promises, applies the joint-party rule, runs the independent worker and exposes scoped ledger/detail/coverage/review services. The existing `memorySafety.js` path delegates ledger records to this source validation. Legacy enrichment remains available outside enabled pilot scope and cannot rewrite audited ledger records.

`v1.js` exposes the ledger APIs documented in `docs/API_REFERENCE.md`. The legacy commitment status endpoint now requires `expected_revision` and a reason; `completed` records a completion claim. Upgrade direct status writers before enabling the release.

HyperFlow adds a Promise ledger section to Obligations, with person/thread/project context, owed/owing filters, unresolved review, joint participant correction, deadline confirmation, source-association correction, source quotes/history and processing coverage. Import into an operational obligation remains an explicit candidate review. Joint source parties remain attached to that candidate; the existing operational workflow still asks the reviewer to agree its responsible owner and beneficiary.

The shared `promise.changed` fixture defines minimal signed evidence events. HyperFlow deduplicates by aggregate revision, handles out-of-order events and flags accepted-source divergence without rewriting terms or advancing flows. Accepted-obligation reads also reconcile current ledger revisions to recover missed events.

## Rollout

1. Deploy Communications with the repository migration runner (`npm run db:migrate`); migration 028 is additive. Its file was scaffolded with Supabase CLI and adapted to this repository's ordered PostgreSQL runner. Do not use a generic schema diff against the deployed database.
2. Deploy the HyperFlow consumer. Existing scopes and tenant membership stay authoritative; private evidence remains excluded from this UI.
3. Read `GET /v1/promises/policy`. Configure a pilot through `POST /v1/promises/policy`, using the current `expected_revision`, `enabled:true`, `shadow:true`, one `project_ids` entry and the canonical `local_person_id`. Local identity is needed to name both sides of a two-party promise automatically. Unconfigured tenants default to disabled; source receipts are still queued.
4. The worker queues missing canonical revisions from the last 30 days in bounded batches. For older explicit backfill, call `/v1/promises/backfill` repeatedly until `queued=0`. Backfill suppresses live promise events regardless of shadow mode.
5. Review the pilot's precision/recall, participant attribution, duplicate matches, processing lag and cost against actual source material. Fixture tests establish behavior, not production model quality. Check failed receipts via `/v1/promises/coverage`; retry a repaired failure through `/v1/promises/retry`.
6. Turn shadow mode off after acceptance and expand project scope deliberately. An explicit `project_ids:null` means all projects. Set `enabled:false` to pause extraction while preserving jobs/history and compatible reads.

Environment: existing `OPENAI_API_KEY`; optional `PROMISE_MODEL`, defaulting through `MEMORY_MODEL`; existing signed outbox destination and secret for change delivery. No browser secrets or new external service are introduced.

## Local verification

- Communications unit suite: 310 passing tests, including 18 ledger tests.
- Ledger tests cover joint named/unresolved parties, individual meeting speakers, sent/agent promises, quotation/negation exclusions, more than 30 sources, lease/source fences, correction history, privacy/project scope, concurrent reviews, cross-tenant parties, replay-safe backfill, feature flags, cross-channel reaffirmation, provisional retries, shadow suppression, immutable history and service-role grants.
- Communications full database suite and HyperFlow regression/build results are recorded in the accompanying HyperFlow implementation note.
- Browser fixture `hyperflow-5/tests/fixtures/promise-ledger.html` exercises the actual React component with fake transport and Firebase disabled. Verified desktop/mobile rendering, joint-party detail, extraction confirmation, coverage and candidate selection; no browser errors reported.

Production activation and a real-data pilot remain deployment steps. No claim is made that production schema, worker configuration or model quality has been verified by these local tests.

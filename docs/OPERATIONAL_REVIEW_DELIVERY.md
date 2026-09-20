# Operational review delivery — 20 September 2026

## Delivery status

This change implements the review and execution code across Communications Service and Hyperflow. It is **not evidence of a completed production rollout**. The original plan's live acceptance and model-quality gates remain open. No production migration, real email, calendar write, or model call was performed in this workspace.

### Implemented

- Multi-assessment evaluation, source/promise revisions, citation checking, separate run receipts and condition-specific finding keys. Retries reuse persisted results. Pending findings update on newer evaluated revisions without duplicating equivalent questions.
- Atomic condition confirmation and dependent queue revisions. Concurrent sessions reconcile recorded condition decisions and already-settled candidates; unrelated edits mark questions stale. Evidence, history, task state and the review response commit together.
- Explicit description/deadline proposals; omitted deadlines remain unchanged. Human corrections use existing validated ledger mutations for participants, description, conditions, supersession and reopening. Project changes remain on the explicitly scoped CRUD API.
- Partial-progress evidence, explicit corrections, dated snoozes, durable dismissals, times raised and decision history. A partial answer never fulfils a promise. Rejected classification evidence is suppressed in the legacy review path.
- Canonical `person:<contact UUID>` ownership using server-configured credential bindings. Voice and authenticated web can resume the same session. Scope is checked again on every read and mutation. Person relevance is separated from communication access.
- Idempotent session creation, an optional `max_items` review budget, scoped review watermarks, explanatory priority factors, and completed-hold/reply filtering.
- Paginated candidate/source scans and batched cross-thread evaluation within matching project/participant boundaries. Requests and expected deliverables have a separate arrival-evidence and human-confirmation path.
- Freshness reporting with explicit unavailable/stale/not-configured states. No unavailable calendar is described as empty. Verified attachment extraction metadata can support exact attachment citations; filename-only evidence remains insufficient.
- Typed action proposals, clarification and explicit authorization, replacement of clarified instructions, a recoverable READY/QUEUED/RUNNING/terminal lifecycle, executor-specific capability checks and immutable terminal receipt semantics.
- Hyperflow signed-event consumer, current owner/project authorization, execution leases, stable request hashes, persisted request JSON, result-before-callback persistence, and scheduler recovery. Email reuses Communications idempotency; calendar reuses approved calendar proposals and provider reconciliation. Tasks/reminders are stored in Hyperflow and surfaced in the owner-review panel.
- Shared briefing/questions/next-actions web and voice session state. Close-out reports actual ledger changes, clarification, queued/running work, failures, deferred questions and stale work.
- Separate classification, owner review, voice and dispatch switches. Pausing dispatch preserves actions and outbox history; READY actions are dispatched when re-enabled.
- Shared action schema/fixture in both repositories and a runnable live-model evaluation harness with a small, explicitly synthetic development corpus.

## Verification

Run from Communications Service:

```sh
npm ci
npm run test:unit
npm run test:db
```

The database suite applies migrations 000–037 on a real PostgreSQL-compatible engine (PGlite). Regression tests cover the original two defects, atomic rollback, partial progress, deadline preservation, durable snooze, session recovery, current ownership/scope, cross-thread expected arrivals, private rows exceeding the former 500-row cap, and callback conflicts. Unit and database suites overlap; their counts must not be added as unique tests.

Run from Hyperflow:

```sh
npm ci
npm test
npm run lint
npm run build
```

The new executor tests cover duplicate delivery, concurrent workers, changed payloads, revoked ownership, uncertain execution, result/callback separation, canonical request hashing and the shared contract fixture. These are substituted-provider tests, not proof of a live send or diary change.

## Deployment and configuration

1. Deploy Communications Service and run its existing `npm run db:migrate` runner with the production `DATABASE_URL`. New migrations are **031–037**. Existing migrations are unchanged.
2. Deploy Hyperflow and its Firebase database rules. New server-only tenant roots are `review_execution`, `review_work` and `review_owner_bindings`; they are included in tenant data lifecycle handling.
3. Configure review-owner bindings in the tenant's `metadata.promise_ledger.review_owners`. The key is `<API key ID>:user:<trusted asserted user ID>` (or just `<API key ID>` for a dedicated single-owner client). Values contain `enabled`, `person_id`, `project_ids`, and optional `include_private`. For Hyperflow the trusted user ID is the verified Firebase UID. The Hyperflow credential needs `threads:actor:assert`; private review also requires `memory:private`. An arbitrary body field cannot select the owner.
4. Configure bindings through `POST /v1/review/owners` with a `tenant:manage` credential, passing `expected_revision`, `binding_key`, `person_id`, `project_ids`, `enabled`, and optional `include_private`. The normal promise-policy endpoint preserves these bindings. Voice additionally requires the existing `voice_review_enabled`, `local_person_id` and configured project policy.
5. Configure Hyperflow `review_owner_bindings/<encoded tenant>/<encoded person:UUID>` with `{ "enabled": true, "uid": "<Firebase UID>", "project_ids": ["<project ID>"] }`. Keys use `encodeURIComponent(...).replace(/\./g, '%2E')`, matching other server roots. Membership and project existence are rechecked before execution.
6. Configure signed Communications-to-Hyperflow delivery, and give the executor callback credential the additional `review:execute` capability. Retain existing email send policy and calendar-grant checks.
7. Set `REVIEW_ACTION_EXECUTION_ENABLED=true` in Hyperflow, then `REVIEW_ACTION_DISPATCH_ENABLED=true` in Communications Service only after the bounded pilot is ready. Both are opt-in. The Hyperflow scheduler retries persisted uncertain executions and undelivered completion receipts.

Additional controls:

| Setting | Effect |
| --- | --- |
| `PROMISE_CLASSIFICATION_ENABLED=false` | Stops new classification calls |
| `OWNER_REVIEW_ENABLED=false` | Pauses owner review while preserving executor receipt processing |
| `VOICE_REVIEW_ENABLED=false` | Pauses the voice interface independently |
| `REVIEW_ACTION_DISPATCH_ENABLED` | Only literal `true` allows review-action outbox dispatch |
| `REVIEW_ACTION_EXECUTION_ENABLED` | Only literal `true` allows Hyperflow execution/reconciliation |

For source freshness, `metadata.review_sources` accepts `calendar`, `holds`, `unanswered` and `attachments` observations with `last_success_at`, `coverage_window`, and optional `error`. Populate these only from a verified synchronization process; a single event observation is not evidence of complete calendar coverage. Existing event/hold ingestion remains usable without a completeness claim.

Attachment evidence uses `communication_attachments.metadata.extraction` containing `status: "complete"`, `source_revision`, `extractor`, `text`, and the SHA-256 of that exact text. A missing or mismatched extraction stays metadata-only. This release consumes extraction results; it does not install an OCR/document-extraction provider.

## Action contract

`POST /v1/review/sessions/:id/actions` preserves the instruction. Without a complete proposal it returns `NEEDS_CLARIFICATION`. A confirmed example:

```json
{
  "request_id": "unique-request-id",
  "instruction": "Remind me to check Dave's figures",
  "authorized": true,
  "proposal": {
    "version": "review-action.v1",
    "type": "reminder",
    "project_id": "project-id",
    "timezone": "Australia/Brisbane",
    "parameters": {
      "text": "Check Dave's figures",
      "scheduled_at": "2026-09-22T09:00:00+10:00"
    }
  }
}
```

Use `replaces_action_id` and a **new** request ID when resolving an incomplete instruction. Retrying the same request ID requires the same instruction/proposal. Web reminders appear in the owner-review panel; no SMS, push or phone reminder delivery is implied.

Email/follow-up requires a resolved contact, subject and body. The service resolves the email address from its own contacts. A successful send receipt means provider acceptance for sending, not recipient delivery. Calendar execution requires an already-approved exact proposal (`calendar_key`, `proposal_id`, `hash`, `expected_revision`); the review must not bypass calendar approval or availability checks.

## Open release gates and remaining integration work

- Production migrations, Firebase rules, owner mappings and actual provider credentials must be verified after deployment.
- Calendar completeness, operational hold synchronization and attachment extraction depend on deployed upstream adapters. The current code reports these limitations; it does not fabricate missing source coverage. Calendar remains based on ingested observations and unanswered detection on explicit response metadata plus observed replies.
- The synthetic model corpus is a starting point. A consented/de-identified representative corpus, measured date/reconciliation/attachment quality and agreed release thresholds are still required. Run `node scripts/evaluate-operational.js --live` with `OPENAI_API_KEY` to record a real baseline; do not call substituted model tests model accuracy.
- Verify a real reminder, a specifically approved test email and an approved calendar change, including lost-callback recovery, before expanding live dispatch. No external messages were sent by this implementation task.
- Complete the uninterrupted owner-review scenario by voice and web in the configured environment. The web panel was build/type checked; authenticated browser and live voice acceptance remain to be evidenced.

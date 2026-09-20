# Promise intelligence and operational review

Implements the September 20 promise/classification and conversation plan on top of the existing promise ledger. Apply migration `030_operational_review.sql` with `npm run db:migrate` before starting this code. Existing migration files and promise CRUD contracts are unchanged.

## Architecture and contracts

`operationalIntelligence.js` normalizes stored communications, loads tenant-scoped participants and context, invokes a schema-constrained classifier, validates exact source quotations, and stores idempotent candidates. It covers all thirteen classifications. Requests and expected deliverables do not become promises. The canonical stored communication wins over caller-supplied body/context/identity claims. All existing channel ingestion paths can feed the classifier, including transcripts.

`reviewEngine.js` consumes the ledger and candidates. It assembles calendar observations, promises, conditions, expected outputs, unanswered communications explicitly marked `metadata.requires_response`, and workflow notifications marked `metadata.hold_requires_human`. Coverage fields distinguish ingested observations from live provider availability. It does not infer that an empty calendar means a user is free.

`reviewVoice.js` adapts the same engine to the existing Realtime voice tool registry. Enable the `operational_review` tool in the owner's contact configuration. The tenant must explicitly enable voice review and configure `local_person_id` matching the resolved caller. This uses the existing caller identity trust model; deployments requiring stronger identity assurance should authenticate the caller before enabling owner review. It is never advertised by default.

Schemas: `contracts/operational-classification-input.schema.json` and `contracts/operational-classification-output.schema.json`. Public classification receipts include canonical request/source revision and validated items; items add resolved actors, counterparties, due interpretation, proposed action and evidence key to the model output contract.

## Enable automated processing

Read `/v1/promises/policy`, then POST its current `expected_revision` with:

```json
{
  "expected_revision": 0,
  "enabled": true,
  "shadow": true,
  "project_ids": ["your-project-id"],
  "local_person_id": "canonical-contact-uuid",
  "timezone": "Australia/Brisbane",
  "operational_intelligence": true,
  "voice_review_enabled": false
}
```

Use the actual current version, project and contact IDs. Requires `tenant:manage`. `OPENAI_API_KEY` and optionally `PROMISE_MODEL` configure the existing Responses API client. The additional classifier and evidence evaluator run through the existing leased promise job worker; failures retry and ultimately remain visible in promise coverage. Historical sources need explicit backfill. The first release evaluates up to 20 related active promises per source, and retrieves a bounded recent context. Beyond that, use explicit evaluation calls.

## API sequence

All routes use the existing tenant authentication and read/write capabilities. `include_private` additionally requires `memory:private`. For per-user sessions behind a shared API client, supply the same `initiator_id` on every request; asserting it requires `threads:actor:assert`. Otherwise sessions belong to the API client. Session revision protects concurrent devices.

1. Ingest a real communication with the existing `/v1/communications` or meeting/email/SMS APIs.
2. `POST /v1/classifications` with `{"communication":{"communication_id":"..."},"classification_request_id":"..."}`. Reusing a key for another source revision returns 409. Classification proposes candidates only.
3. `GET /v1/classifications/candidates` returns currently visible pending candidates.
4. `POST /v1/promises/:id/evaluate` with `{"communication_id":"..."}` evaluates a later event separately. Likely fulfilment or condition satisfaction creates a review candidate, never verified fulfilment. The evaluator receives attachment metadata, not fabricated attachment contents.
5. `GET /v1/review/briefing` or `/v1/review/items` inspects the review without starting a conversation.
6. `POST /v1/review/sessions` with optional person/project/thread filters and timezone. This returns a BRIEFING session, prompt, revision and queue.
7. Present the briefing, then `POST /v1/review/sessions/:id/advance` with `expected_revision`.
8. Ask the returned question. `POST /v1/review/sessions/:id/respond` with:

```json
{
  "expected_revision": 1,
  "review_item_id": "returned-item-id",
  "request_id": "unique-answer-id",
  "utterance": "Yes, I sent it yesterday.",
  "intent": "ACCEPT"
}
```

Use `REJECT` or `DEFER` for those answers. Missing/ambiguous intent produces clarification and no write. Voice maps a clear human answer into this contract and preserves the utterance. The alias `/v1/review/items/:id/respond` accepts `session_id` in the body. Candidate acceptance, promise mutation, history and queue progress share one SQL transaction. Pending conditions block fulfilment. Changed evidence or revisions reject a stale answer. Repeated request IDs with the same payload are idempotent; different payloads conflict.

9. At NEXT_ACTIONS, explicitly ask the user for instructions. `POST /v1/review/sessions/:id/actions` with `instruction` and unique `request_id` creates a durable PENDING action. Reuse the key after timeouts.
10. Advance to SUMMARY, present confirmed decisions, queued/successful/failed instruction counts and deferred items, then advance to COMPLETED. The last completed review is the next briefing's change watermark. `GET /v1/review/sessions/:id` resumes across channels/devices with the same authorized owner.

## Actions and integration boundary

Actions are durable handoffs to the configured Hyperflow executor. `HYPERFLOW_EVENT_URL` causes an atomic `review.action.requested` outbox event with `action_id`, session, instruction, owner and scope. Existing outbox delivery signs and retries it with `COMMUNICATIONS_WEBHOOK_SECRET`. No destination means it stays available for polling through `/v1/review/sessions/:id/actions`.

The receiving executor must interpret the instruction, resolve recipients and dates, execute its existing email/calendar/reminder/task primitives, and report `SUCCEEDED` or `FAILED` to `POST /v1/review/actions/:id/result`. This callback requires a tenant-authorized write client and accepts an optional `result` object. Delivery of an event is not execution success. This repository does not invent provider connections or claim that a reminder/email/calendar change occurred merely because it was queued. Live executor support and provider credentials must be connected before these instructions execute end to end.

## Promise compatibility

Existing CRUD, condition, evidence, history and review endpoints remain valid. Explicit aliases add `/confirm`, `/fulfil`, `/cancel`, `/reopen`, `/supersede` and `/reject-fulfilment`. Supply current `expected_revision` and reason. Supersede also needs `patch.related_promise_id` referencing a visible replacement.

The response `lifecycle` maps existing fields into PROPOSED, OPEN, CONDITION_PENDING, READY, FULFILMENT_SUSPECTED, FULFILLED, OVERDUE, CANCELLED and SUPERSEDED without changing the legacy `status` contract. Existing `completion_claimed` maps to FULFILMENT_SUSPECTED; separately evaluated evidence is exposed in the review queue. Date-only deadlines use the recorded timezone and become overdue after that local date, without an invented 5pm deadline. Due estimates remain unconfirmed until a human confirms them. Queries accept lifecycle `status`, `due_before`, `promisor`, `promisee`, `external_project_id`, and existing filters. Follow `next` even if a filtered page is empty.

Requests, offers, decisions, deadlines and expected deliverables accepted during review are stored separately in `operational_objects`. Unresolved changes are retained for review, not applied to guessed targets. Conditions keep natural-language descriptions authoritative.

## Validation and rollout

`npm run test:unit` includes PostgreSQL-compatible PGlite integration tests for the complete conditional promise → expected output → evidence → human review flow, idempotency, concurrency, source revisions, immutable history, tenant scoping and public-role denial. `npm run test:db` exercises the remaining database integration paths. Tests substitute classifier/evaluator output and do not call paid models or communication providers.

Rollout requires running the migration, setting model credentials, opting in tenant policy and connecting the action executor. Voice additionally needs the configured tool and owner policy. Live phone, model and provider behaviour needs a smoke test in the deployed environment; local tests do not establish it.

Accepted non-promise objects can be read through `GET /v1/operational-objects` and resolved with `POST /v1/operational-objects/:id/resolve` (`expected_revision`, `status: OPEN|FULFILLED|CANCELLED`, `reason`). Changes preserve actor/reason history. Overdue requests and deliverables also receive an arrival-confirmation question in review sessions.

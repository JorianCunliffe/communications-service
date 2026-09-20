# Operational Review Completion Plan

Status: proposed implementation plan; no changes in this plan are implemented by this document.

Date: 2026-09-20  
Repositories: Communications Service (primary); Hyperflow5 (action execution and review UI integration)  
Reviewed baseline: Communications Service main at c4e5c000da0b1e8f4cf5ffa048c3a6a34b610167

## 1. Goal

Complete the promise intelligence and owner-review experience already introduced by migration 030.

The first release milestone is one uninterrupted owner review that can:

1. Detect my conditional promise to send Dave a report.
2. Track Dave's figures as an expected deliverable without inventing a promise from Dave.
3. Detect the figures arriving and ask me to confirm the condition.
4. Detect my report being delivered and ask me to confirm fulfilment.
5. Apply both confirmations in the same review session.
6. Accept a new instruction, resolve its details and execute it.
7. Close with an accurate account of completed changes, queued or failed actions, and deferred questions.

AI proposes consequential changes; a human authorizes them. A queued instruction or delivered webhook is never proof of completed execution.

## 2. Starting point and confirmed gaps

The existing implementation provides promise CRUD, conditions, evidence, history, classification candidates, fulfilment evaluation, review-session APIs, an action outbox and an opt-in voice tool.

The previous test runs passed 322 unit-suite tests and 74 database-suite tests. These suites overlap; the counts are not a combined unique-test total. They use substituted model output and do not prove live model accuracy or provider execution.

| Gap | Evidence from review | Priority |
| --- | --- | --- |
| Related review questions become stale | Reproduced: accepting a condition increments the promise revision; the fulfilment question in the same session then returns 409 | P0 |
| One event cannot reliably produce several findings | Reproduced: condition and fulfilment evaluations for the same event/promise revision share a request key and only one candidate survives; evaluator output is also singular | P0 |
| Incomplete change semantics | CHANGE currently proposes a due-field correction; other terms are not supported and absent date information can replace an existing deadline | P0 |
| Limited human answers | Responses are ACCEPT, REJECT or DEFER; partial completion, corrections and dated snoozes have no complete conversational contract | P1 |
| Basic review continuity | Deferral is session-local; voice and API owner identifiers differ | P1 |
| Owner-context omissions | Voice uses owner person filtering while source visibility often uses the counterparty identity | P0 |
| Action execution unverified | Instructions are queued for an external executor; the new event consumer and live completion loop have not been established in this review | P1 |
| Incomplete briefing inputs | Calendar uses ingested observations; unanswered messages and holds depend on explicit metadata | P1 |
| Model and matching quality unmeasured | Matching is primarily within a thread; attachment content is not inspected | P1 |
| Rollout state unverified | Production migration, feature policy and provider smoke tests need checking | Release gate |

## 3. Architectural boundaries

| Component | Responsibility |
| --- | --- |
| Communications Service | Communication evidence, canonical promises and expectations, classification proposals, review state, human decisions, action requests and execution receipts |
| Hyperflow | Consume authorized action requests, resolve execution requirements, run email/calendar/reminder/task primitives and report outcomes |
| Voice and web interfaces | Present the same session, capture human wording, propose structured intent, ask clarifying questions and render actual results |
| Provider adapters | Perform provider operations and return authoritative identifiers and execution evidence |

Keep existing promise APIs compatible. Add new migrations rather than modifying any applied migration. Inspect Hyperflow's existing primitives and event handlers before deciding which new components it needs; do not assume that a consumer for the new event already exists.

## 4. Delivery order

| Phase | Deliverable | Dependency |
| --- | --- | --- |
| A | Correct multi-finding evaluation and dependent review questions | Existing implementation |
| B | Explicit change proposals and richer human responses | A |
| C | Durable review tasks and cross-channel owner identity | A; coordinate with B |
| D | Reliable briefing inputs and broader evidence matching | A and C |
| E | Executable next actions with completion receipts | B and C |
| F | Accurate conversation presentation and close-out | B–E |
| G | Realistic evaluation, staged rollout and live acceptance | All preceding phases |

Each phase should be independently reviewable. Phase A and owner-scope fixes in C must precede enabling the expanded review for live users.

## 5. Phase A — Review correctness

### A1. Return multiple evidence findings

Change fulfilment evaluation output from one assessment to an assessments array. Each finding should identify:

- Promise ID and the promise revision evaluated.
- Source communication ID and source revision.
- Assessment kind: fulfilment, condition satisfaction or insufficient evidence.
- Condition ID when applicable.
- Evidence quotation/references, confidence and explanation.
- Proposed human operation.

Permit multiple conditions and fulfilment evidence from one event. Retain the source revision in every finding and reject unsupported citations.

Separate evaluation-run identity from individual finding identity. A retry of the same run must reuse its receipt; distinct findings must not collide. Include assessment kind and condition ID in finding deduplication. Define how a newer promise revision supersedes stale pending findings without multiplying equivalent questions.

### A2. Refresh dependent questions atomically

After a confirmed operation, update the canonical promise and reconcile all pending questions for that promise in the session within the same transaction.

- Refresh expected revisions when a question remains valid.
- Remove or mark resolved questions made redundant by the decision.
- Unlock fulfilment confirmation after required conditions are satisfied.
- Rebuild proposals whose meaning depends on changed terms.
- Refresh outstanding questions in other sessions on their next read.
- Preserve real concurrency protection: an unrelated external change must trigger re-evaluation, not blind acceptance.
- Preserve the original human answer and an audit record of queue changes.

### Acceptance tests

- One event yields two condition findings and a fulfilment finding without collisions.
- Repeating evaluation creates no duplicate findings.
- Confirm condition, then fulfilment in one session without a stale-revision error.
- Pending conditions still prevent premature fulfilment.
- Concurrent sessions cannot apply a consequential operation twice.
- Source edits invalidate affected findings.
- Failure during mutation rolls back ledger, evidence, queue and outbox updates together.

## 6. Phase B — Explicit proposals and human intent

### B1. Field-level change proposals

Introduce a versioned proposal contract containing target ID, expected revision, evidence, proposed operations and changes.

Each changed field includes its previous value, proposed value and reason. Support:

- Deadline, date-only precision and timezone.
- Commitment description and deliverable.
- Promisor and promisees, using resolved contacts.
- Condition creation, amendment, satisfaction, failure or waiver.
- Cancellation, supersession and reopening.

Omitted fields mean unchanged. Clearing a field must be explicit and confirmed. Participant or project changes require fresh authorization and identity validation.

Distinguish accepting an existing promise from merely acknowledging an update. Review the rejection path when a classification candidate and a legacy extracted promise refer to the same source, so rejection does not cause the same proposal to reappear immediately.

### B2. Richer human-response contract

Preserve utterance, interpreted intent, confidence, clarification state and proposed operations separately from the committed result.

Support confirmation, rejection, partial completion, field correction, reassignment, dated snooze and a request for follow-up. Partial completion must not silently fulfil the whole promise.

Examples:

| Human answer | Required interpretation |
| --- | --- |
| “Yes, but only the first part.” | Record partial progress; clarify the remaining deliverable |
| “No, move it to Monday.” | Propose a deadline change, with a resolved date and timezone |
| “Ask me tomorrow morning.” | Resolve a snooze time and persist it |
| “That's Dave's responsibility.” | Clarify whether this corrects attribution or requests reassignment; do not invent Dave's commitment |
| “Follow up with him.” | Resolve the person and proposed action before execution |

### Acceptance tests

- A description-only change preserves the deadline.
- Explicit deadline removal differs from missing date information.
- Ambiguous dates and people generate clarification.
- Low-confidence interpretation never commits a consequential change.
- Partial completion preserves outstanding work.
- Rejected candidates do not immediately return through a second extraction path.
- Cross-tenant or unauthorized participant/project changes are rejected.

## 7. Phase C — Durable review tasks and owner continuity

### C1. Persistent tasks

Promote questions requiring ongoing attention into durable review tasks referenced by sessions. Track object and proposal identity, status, priority, snoozed-until time, times raised, last-raised time and decision history.

Support PENDING, SNOOZED, RESOLVED and DISMISSED, with explicit reopening rules. New evidence may reopen an item; a routine briefing rebuild must not undo dismissal or snooze.

### C2. Shared authenticated owner identity

Introduce a canonical review-owner identity that is independent of voice, API client or device. Map trusted credentials and verified caller context to this identity; never accept an arbitrary caller-supplied owner ID.

Separate:

- Who is reviewing.
- Whose commitments are relevant.
- Which projects and private information that person may access.

Fix owner-scoped source retrieval so communications associated with Dave remain eligible when they concern my promises. Revalidate current access when resuming a session; stored session scope must not preserve revoked access.

### Acceptance tests

- Start in voice and continue the same authorized session on web.
- Another user cannot resume it by knowing its ID.
- Revoked project access takes effect on resume.
- Owner review includes both inbound and outbound evidence concerning their promises.
- Snoozed questions remain hidden until due across sessions and channels.
- Repeated session-start requests can recover the existing session after a timeout.

## 8. Phase D — Briefing completeness and evidence matching

### D1. Freshness and coverage

For each briefing source, return last successful observation/sync, coverage window and availability state: current, stale, unavailable or not configured.

Connect or verify calendar synchronization, unanswered-communication detection and Hyperflow hold ingestion. Resolve completed holds and replies rather than relying on permanent flags. Never describe unavailable calendar data as an empty calendar.

Distinguish my commitments, others' explicit promises, expected deliverables and requests awaiting acceptance. Scope the “since last review” watermark appropriately; completing one project's review must not hide changes in another.

### D2. Matching and practical scale

Extend candidate retrieval beyond the current thread using authorized participants, project, deliverable similarity, dates and recency. Include existing requests and expected deliverables in reconciliation.

Add pagination and batching so limits of 20 related promises, 500 candidates or 500 communications cannot silently omit relevant work. Return truncation/coverage information wherever a bound remains.

Evaluate attachment contents through approved extraction paths when available, with provenance. Filename-only evidence remains weak evidence. Match arrivals against expected deliverables as well as promises.

Complete priority factors: urgency, external people waiting, project importance, meeting dependencies, repeated questions and uncertainty. Keep the scoring explainable.

### Acceptance tests

- A phone promise can match fulfilment in an email assigned to a different thread.
- Similar promises involving different people or projects remain separate.
- A busy tenant does not lose visible items because unrelated rows fill a pre-filter limit.
- Calendar sync failure is visible in the spoken briefing.
- A completed workflow hold disappears.
- Extracted attachment evidence points back to the actual attachment and source.

## 9. Phase E — Executable next actions

### E1. Structured action contract

Retain the user's instruction and add a versioned action proposal with:

- Action ID, idempotency key, owner and review-session IDs.
- Action type: reminder, email, calendar operation, task or follow-up.
- Resolved targets and typed parameters.
- Timezone and resolved schedule.
- Clarification and authorization state.
- Source proposal/decision references.

Clarify missing recipients, ambiguous dates, conflicting meetings and incomplete instructions before execution. Reuse existing contact and calendar resolution rather than inventing identities or availability.

### E2. Hyperflow execution and receipts

Implement or verify the review.action.requested consumer in Hyperflow. Validate the contract and tenant authorization, deduplicate delivery, execute an approved primitive, and send a completion receipt.

Use an execution lifecycle such as NEEDS_CLARIFICATION, READY, QUEUED, RUNNING, SUCCEEDED, FAILED and CANCELLED. Include retryability, provider IDs, execution timestamps and a user-readable outcome.

Design for provider success followed by callback failure: a retry must reconcile the provider result or reuse its idempotency key rather than sending again. Verify executor callback authority and reject conflicting or stale terminal receipts.

### Acceptance tests

- An actual reminder is scheduled and its identifier is returned.
- A confirmed follow-up email reaches the intended recipient once.
- Calendar creation/change is confirmed by the provider.
- Duplicate webhook deliveries and callbacks do not duplicate effects.
- Provider success followed by a lost callback is recovered safely.
- Failed actions remain visible with a useful next step.
- A delivered event remains queued/running until execution is evidenced.

## 10. Phase F — Conversation usability

Preserve the three user-facing stages: briefing, questions, then next actions and close-out.

- Present an immediate, concise briefing before questioning.
- Ask one clear question at a time, with enough evidence to decide.
- Handle interruption, correction, “skip this” and “come back later.”
- Offer a time-bounded review and explain what remains.
- Summarize actual object changes, not just accepted-answer counts.
- Distinguish completed provider actions, pending actions, failures and snoozes.
- Resume safely after disconnection, including uncertain tool outcomes.
- End the call only after the user has finished and the session state is saved.

Acceptance: a person can complete the milestone scenario by voice without knowing IDs, lifecycle states or API terminology. A web interface must render the same decisions and remaining work.

## 11. Phase G — Evaluation and release gates

### Model evaluation

Build a consented or de-identified communications corpus covering individual/joint promises, conditional promises, requests, offers, quoted speech, ambiguous dates, deadline changes, cancellations, partial completion, attachments and multi-channel continuations.

Measure extraction precision/recall, actor attribution, date interpretation, reconciliation accuracy, fulfilment proposal quality and unnecessary review questions. Record model/prompt versions and inspect failures. Establish release thresholds from the baseline before expanding the pilot; do not treat mocked-model tests as this evaluation.

### Automated verification

Add regression cases for every confirmed gap. Retain database transaction, idempotency, tenant-isolation, privacy, revision and migration tests. Add cross-repository action-contract tests and voice/web session-ownership tests. Test realistic queue sizes and provider/callback failure sequences.

### Staged rollout

1. Verify production code, migration state, credentials and tenant policy.
2. Apply new migrations using the repository runner; never rewrite applied migrations.
3. Run classification in shadow mode and inspect proposals.
4. Enable human review for one owner and a bounded project scope.
5. Execute sandbox/test actions and verify receipts.
6. Enable voice and controlled live actions.
7. Complete the real end-to-end milestone before widening access.

Observe queue age, failed jobs, model latency/cost, duplicate rates, clarification frequency, stale-session conflicts and execution outcomes.

Provide separate switches for classification, owner review, voice and action dispatch. Disabling dispatch must preserve queued work and audit history. Prefer forward-compatible rollback by disabling features; do not delete ledger history.

## 12. Definition of done

- [ ] Both reproduced review defects are fixed and regression-tested.
- [ ] Field-level changes preserve untouched terms.
- [ ] Partial answers, corrections and dated snoozes work.
- [ ] One authorized owner can resume across voice and web.
- [ ] Owner evidence is complete within explicitly reported coverage.
- [ ] Matching covers promises and expected deliverables across channels.
- [ ] Briefings report source freshness and limitations.
- [ ] At least one real reminder, email and calendar action has a verified execution receipt.
- [ ] Duplicate delivery and uncertain provider outcomes are handled safely.
- [ ] Close-out explains actual changes and remaining work.
- [ ] Model quality is measured on representative examples.
- [ ] Production rollout and the uninterrupted owner-review scenario are evidenced.

Completing this plan should establish a dependable owner-review loop. Broader autonomous orchestration remains a later stage.

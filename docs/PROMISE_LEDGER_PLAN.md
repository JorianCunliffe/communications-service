# Promise ledger: repository review and implementation plan

Date: 2026-09-18. Recommendations accepted for implementation. User override: “we” is a joint promise by both participants; unresolved identities remain explicit participant slots. See docs/implementation/PROMISE_LEDGER.md for implementation and rollout evidence.

## Recommendation

Make promise capture a standard, asynchronous part of every eligible communication's ingestion. Communications Service should own the evidence-backed promise ledger: who promised what, to whom, in which thread and project, when, and what subsequent communications say about it. HyperFlow should continue to own accepted operational obligations and decisions about fulfillment.

Extend the existing extracted-commitments foundation. Do not create another contact directory, thread authority, memory service, or competing business approval mechanism.

“Every channel” means every supported channel passes through the same capture contract. Every source revision must reach a recorded outcome: promises found, none found, excluded with reason, pending, or failed. It does not mean every message contains a promise or that every promise can immediately be attributed to a known person and project.

## Review baseline and limits

- Reviewed `C:/Users/joria/OneDrive/Documents/ChatGPT/communications-service` at `b1eb0b000f3af97b5c033e5f6648262b6ef5559a`. It was clean before this planning document.
- The second checkout at `C:/Users/joria/OneDrive/Documents/communications-service` is older, at `7ba163a`, with untracked implementation documentation. Use the newer checkout as the implementation baseline unless repository ownership indicates otherwise; preserve the older checkout.
- Inspected HyperFlow's commitment architecture and source adapter in the current workspace to check consumer compatibility.
- Ran `node --test --test-reporter=spec test/memory.test.js test/memoryDatabase.test.js test/meetings.test.js test/meetingsDatabase.test.js`: 41 passed, zero failed. Database tests use local PGlite fixtures, with no provider actions.
- This establishes source behavior and a focused local baseline. It does not establish production migration state, worker health, extraction quality on real conversations, or deployed ledger contents.

## What exists and where the gaps are

| Area | Current implementation | Gap for the requested ledger |
|---|---|---|
| Storage | `migrations/005_communications_enrichment.sql:13` defines `communication_commitments`: source communication, thread, promisor/promisee contacts, description, due time, confidence, quote, status and timestamps. Migration 009 adds tenant scoping and uniqueness. | No direct project field, source revision, segment citation, versioned promise terms, or append-only change history. |
| Extraction | `enrichment.js:59` and `:175` combine a first-person promise regex with model extraction and quote validation. | Requires “I will/I'll/we will/we'll”; misses acceptance such as “Yes, Friday works” and other forms of commitment. Regex alone is insufficient to distinguish action promises from quoted or hypothetical statements. |
| Attribution | `counterpartyContent` at `enrichment.js:77` prefers counterparty speech; the writer uses the source communication's person/contact as promisor. | Sent email/SMS promises and assistant-made promises are excluded by design. The writer does not populate promisee. A single communication person cannot represent multiple meeting speakers. |
| Processing | Canonical communication writes enqueue enrichment; the worker starts in `index.js`. It has leases, retries and a deterministic extraction fallback. | Migration 009 coalesces jobs by thread and `processJob` reads at most 30 recent communications. This cannot guarantee per-source coverage. The queue trigger catches errors and emits warnings, so capture needs reconciliation as well as queueing. |
| Meetings | `meetings.js` and migration 022 preserve source versions, separate project topics, transcript segments, attendee identities and uncertain speaker attribution. | The extractor consumes flattened canonical text, not segment-level speaker identity. Meeting imports can yield unattributed promises despite having structured speaker metadata available. |
| Identity | Existing contacts and `communication_identities` support stable people across channels. Meeting attendee matching retains unresolved/conflicting identities. | Ledger attribution must distinguish a known participant from proof that the participant spoke. A name, email and phone should be contact attributes, not a requirement to capture evidence. |
| Updates | Storage matches source communication plus description. Re-enrichment may delete obsolete open/unknown rows and preserves terminal rows. | Description changes can change identity; repeating a promise in another channel creates another source row. Deletion loses ledger history. No durable relationship between initial promise, amendment and completion claim. |
| Dates | Existing parsing uses `CONTEXT_TIMEZONE`, defaulting to Brisbane, with assumed times. `memorySafety.js` exposes uncertain dates as candidates. | Preserve original wording, timezone basis and precision; do not turn an inferred date into an agreed deadline. |
| Read/write APIs | Memory, thread/person/project context and loose ends expose extracted commitments. `v1.js:1221` accepts legacy status updates. | No dedicated, exhaustive, paginated promise ledger. Status mutation has no promise revision, actor/reason history, or evidence requirement in the handler. |
| Consumer | HyperFlow imports evidence as candidates and owns accepted obligations, review Asks and fulfillment. Candidate identity derives from project plus source promise ID. | Preserve stable IDs and the evidence-only contract. There is no existing promise-change subscription to automatically refresh accepted-source warnings. |

Relevant ownership contracts: Communications `docs/architecture/BOUNDARIES.md`; HyperFlow `docs/architecture/COMMITMENTS.md` and `lib/commitments/sources.ts`.

## Decisions to settle before implementation

| Decision | Recommended default | Consequence |
|---|---|---|
| What is the ledger authoritative for? | Communications records promises and evidence; HyperFlow records acceptance and verified fulfillment. | Capturing a promise never approves a workflow, accepts commercial terms, or closes an operational obligation. Changing this boundary would require a larger cross-service redesign. |
| Whose promises count? | Capture both human sides and identifiable meeting participants. Capture an assistant's externally communicated promise as agent-origin evidence, with represented party/authority unresolved unless trusted metadata establishes it. | Supports both “owed to me” and “owed by me.” Drafts, internal model output and suggested replies do not count as communicated promises. Sent-message delivery state remains separate. |
| What language counts? | Explicit action promises plus clear acceptance of a preceding request; keep requests, intentions, suggestions and conditional offers distinct. | Define a labelled evaluation set before choosing confidence thresholds. Ambiguous and conditional statements remain review candidates. |
| Must person, thread and project be known immediately? | Preserve a candidate with unresolved associations; only show it as fully linked once resolved. Reuse canonical person IDs and thread resolution. | Unknown speakers or absent projects do not lose evidence and do not trigger invented identities or project assignments. |
| Are organizations and groups promisors? | MVP uses canonical people. “We” is one joint promise by both conversation participants, retaining unresolved identity slots when necessary. Multi-party meeting references use the participating group. | First-class organization promises can be a later extension if required. |
| What does automatic capture require from a reviewer? | Capture automatically; route uncertainty and corrections to review. Business acceptance stays explicit. | Human approval is not required for every ledger entry, but low-confidence attribution must remain visible. |
| How is completion determined? | Later communication may record “completion claimed”; a reviewer or existing HyperFlow process verifies fulfillment. | “Sent it” can be evidence without automatically proving delivery, acceptance or satisfaction of the promise. Overdue is derived from a sufficiently supported due date. |
| How are deadlines interpreted? | Record original wording, candidate date, timezone, precision and assumptions. Use tenant/project timezone when explicitly configured. | “Friday” remains a date interpretation, with no silently agreed 5 pm deadline. |
| How far back should extraction run? | Pilot on a selected project and recent 30-day history, then expand after quality/cost review. | Historical processing uses original occurrence time and explicit backfill markers; avoid notifications for historical entries by default. |
| Where will users review the ledger? | HyperFlow owns the primary UI, grouped by project/person/thread, with an unresolved review queue. Communications exposes the authoritative API. | Confirm whether a standalone Communications console view is also needed; do not build two full review products by default. |

The ownership boundary, both-side/agent coverage, unresolved-association behavior, and completion authority are the first decisions to settle. Other defaults can be refined during the pilot.

## Proposed record model

Use `communication_commitments` as the compatible current-state record and retain existing IDs. Add supporting records through additive migrations:

1. **Promise aggregate:** tenant, stable ID, revision, description/deliverable, promisor and promisee canonical person IDs when known, origin (human/agent), attribution certainty, current thread, namespaced project reference, extraction/review state and observed lifecycle state. Keep a compatibility mapping for legacy status rather than treating it as accepted business state.
2. **Evidence:** promise ID, source communication ID and source revision/hash, source occurrence time, source segment ID or text offsets, speaker reference, quote, attribution method, extractor/model/prompt version and confidence. Support several evidence records for one promise and several promises in one source.
3. **History:** append-only events for extraction, confirmation, correction, source retraction, attribution/link changes, amendments, claimed completion and reviewer decisions. Record actor, reason, prior revision and event time. Append-only business history remains subject to tenant retention/deletion policy.
4. **Processing receipt/job:** tenant, communication, source revision and extractor version, processing state, attempts/lease, completion outcome and error/skip reason. Separate these durable extraction jobs from coalesced summary work.

Keep Communications' internal project UUID and HyperFlow's external project identifier distinct. Use the existing correlation contract and an explicit reference namespace; do not copy HyperFlow project authority into Communications.

Store uncertain deadline interpretation separately from confirmed terms. Resolve names/email/phone from canonical contacts at read time where authorized; evidence preserves the source's speaker label rather than copying a new directory into each promise.

For the MVP, one promise has one current primary thread/project association, with evidence able to come from multiple communications and channels. Changes to that association require an audited correction. Ambiguous cross-project matching requires review.

## Implementation sequence

### 1. Lock contracts and fixtures

Confirm the decision table and define promise, request, acceptance, amendment, completion claim and verified fulfillment. Add versioned API/event fixtures and a labelled set of real-but-redacted examples covering all intended channels, both sides, uncertain identities, quoted history and relative dates.

Inventory all legacy status writers and memory consumers before changing semantics. Confirm deployed schema/worker readiness read-only before release planning.

**Gate:** agreed lifecycle, actor rules, API shape and expected outputs for the examples.

### 2. Add stable storage and complete processing coverage

Add revisions, associations, evidence/history and durable source-processing receipts. Register new tables in `tenantContext.js` and tenant lifecycle export/deletion handling; apply the existing tenant and private-evidence access model to every read/write. Use tenant-consistent foreign references, constrained service access and RLS for exposed tables.

Enqueue extraction transactionally with canonical source persistence, or use a transactional outbox. Keep provider ingestion independent of model availability. Add a reconciliation sweep for missing projections/jobs/receipts so caught trigger failures cannot silently drop work. Define distinct source-content and association revisions so status/derived writes do not cause extraction loops.

Write results, history, receipt completion and downstream events atomically. Verify source revision and lease ownership at commit time; stale workers must not publish results for replaced evidence. Support retries, exhausted-job visibility and explicit reprocessing.

**Gate:** replaying a source is idempotent; all sources in a burst exceeding 30 messages receive a processing outcome; worker crashes and concurrent source corrections lose no work.

### 3. Normalize evidence and implement promise extraction

Build one evidence interface with authored text/segments, author or speaker, occurrence time, source revision, thread/project references and eligibility. Preserve channel-specific facts:

- Email: separate new author text from quoted history, forwards and signatures; distinguish received/sent messages from drafts and automated mail.
- SMS: resolve sender/recipient roles for both directions; preserve provider replay identity.
- Voice: use structured turns and counterparty/assistant roles; retain call outcome eligibility and provenance.
- Meetings/recordings: consume preserved segment IDs, timestamps and speaker claims from the recording instead of attributing the entire transcript to one contact. Keep private/retracted-topic behavior.

Extract structured candidate promises with exact citations and separate attribution/date confidence. Validate source spans and speaker references after model output. Extend beyond the current first-person regex without relaxing protections against requests, quotation, negation, hypotheticals and transcript instructions. Retain source-grounded fallback extraction as explicitly provisional when richer extraction fails.

Keep promise identity independent of model paraphrasing. Match evidence replay by stable source/span identity. Treat cross-message semantic matching as a separate reconciliation step: attach reaffirmations to an existing promise only when evidence is strong; otherwise propose a possible duplicate. Never merge solely because wording is similar.

**Gate:** quality passes the agreed labelled set, with separate results by channel and by attribution correctness; no silent guesses about unknown speakers.

### 4. Implement evidence evolution and review

Handle amendments, cancellations, completion claims and retractions as new evidence/history events. Source corrections supersede evidence instead of deleting history. Keep prior terms visible and avoid rewriting human-confirmed terms automatically. Route uncertain relationship matches to review.

Add version-checked mutations with actor/reason/evidence and role checks. Adapt the legacy status route to this service with documented compatibility semantics; do not leave an unaudited second writer. Update memory safety and derived views to validate all cited evidence and current associations, including speaker-based person scoping for meetings.

**Gate:** changed/retracted transcripts and rethreading cannot expose stale or unauthorized evidence; concurrent reviewer updates cannot overwrite one another.

### 5. Expose the ledger and integrate HyperFlow

Add paginated list/detail/history APIs with person, thread, project, direction, observed status, review state and date filters. Include processing coverage so an empty result is distinguishable from pending or failed extraction. Expose unresolved entries only within authorized source scope.

Add signed, versioned promise-change events using the existing event outbox; identify aggregate revision and source references, with minimal sensitive payload. Define consumer deduplication, out-of-order handling and replay/cursor recovery. Publish discovery and change events, including source retraction and association changes.

Preserve existing memory consumers and source IDs. HyperFlow can create or refresh idempotent candidates, show owed/owing and unresolved views, and flag changed evidence on accepted obligations. It must not turn source statuses into operational fulfillment. Imported historical events must not generate unsolicited follow-ups.

**Gate:** one promise reaffirmed across channels appears once with multiple citations; accepted HyperFlow terms survive source changes, with a visible divergence warning.

### 6. Backfill, evaluate and roll out

Ship behind tenant/project feature flags. Backfill existing commitments without changing their IDs or treating old `completed` as verified business fulfillment. Mark unsupported historical attribution/version information as unknown. Re-extract from available canonical sources in bounded, resumable batches.

Start with shadow extraction on a pilot project. Review precision/recall, attribution errors, incorrect merges, missing-source receipts, processing lag, retries and cost. Agree numerical quality and latency targets before expansion. Rollback disables new extraction/consumption while retaining evidence/history and compatible reads.

**Gate:** acceptable channel-specific quality, complete source-processing accounting, replay-safe backfill and no tenant/project/privacy regressions.

## Acceptance scenarios

- Email, SMS, voice and meeting versions of the same promise produce attributable, source-linked candidates.
- A human's sent message is captured; an unsent draft is not. Agent-origin promises are clearly identified and never imply authority by themselves.
- Requests, quoted old messages, negated/hypothetical promises, assistant confirmations and provider receipts do not become accepted promises.
- Two speakers in one meeting receive separate attribution; an unknown speaker remains unresolved; “we” records both participants jointly, preserving any unresolved identities.
- A promise without a project is retained for authorized review and can later be linked with history.
- More than 30 messages in one thread, provider redelivery and historical import all yield complete processing receipts without duplicate promises.
- The same promise repeated in another channel can gain supporting evidence; two similar but distinct promises remain separate.
- A corrected/retracted transcript, identity correction, or thread/project move updates evidence safely without erasing history or silently changing accepted obligations.
- Relative deadlines retain their wording and assumptions. “Done” becomes a completion claim until appropriately verified.
- Model outage, queue failure, stale lease and consumer outage recover through retries/reconciliation without dropping evidence or duplicating downstream candidates.
- Tenant isolation, project access, private meeting visibility and tenant export/deletion cover aggregates, evidence, history, jobs and events.

## First implementation slice

After the first four decisions are settled, implement stable IDs/history, per-source revision processing, and source-grounded extraction/read APIs across the existing four channel families. Then add cross-message amendment/completion reconciliation and HyperFlow review subscriptions. Each slice should deliver complete coverage for its declared semantics; avoid shipping the current rolling summary window as an exhaustive ledger.

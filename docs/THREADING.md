# Ranked conversation threading

Release 2.4.0 adds explainable grouping and an operator correction loop. Communications owns the people, identities and conversation history; HyperFlow still owns workflow intent and Ask completion. The wire contract stays at version `2.0`.

## Human communication model

A person is not a conversation, a channel is not a conversation, and a project can contain many conversations. A thread is a bounded conversation that may include several people and channels. Each communication has one primary thread; participant identities are recorded independently of the primary contact.

- A quick SMS after an email or phone call can continue the same topic.
- A different known project stays separate even when the person and channel are unchanged.
- A group reply can come from any recorded participant. Trusted email replies can introduce another participant without changing the existing people's identities.
- A long gap weakens continuity. Strong ongoing project/topic evidence may still justify continuing a thread.
- A close ranking or an ambiguous identity creates a new thread instead of silently choosing between plausible conversations.
- Explicit thread IDs and Ask bindings take precedence. Creating a new Ask does not attach it to an unrelated open Ask.

Ordinary inbound and outbound activity can be inferred. Voice and SMS provider records, inbound/outbound email, generic communication ingestion, and supplied recording/meeting transcripts all feed the same resolver. An authorized live-call project selection can move the call to the selected project's thread without retagging other communications in the previous thread. A workflow-bound Ask is not reassigned by that operation.

## Ranking

Candidates are open, tenant-owned threads found through normalized identities, known people, group participants, or explicit project context. Candidate retrieval is bounded (20 per primary identity/person/project path and 50 through group participants). This is a practical candidate shortlist, not an exhaustive semantic search of every historic thread.

| Evidence | Score contribution |
| --- | ---: |
| Applicable preferred human correction | +30 |
| Exact normalized participant identity | +45 |
| Known person overlap | +30 |
| Additional overlapping people | +10 each, capped at +20 |
| All known people in a group are covered | +10 |
| Same known internal or external project | +35 |
| Same most-recent channel | +8 |
| Same person switching channels within 24 hours | +10 |
| Shared topic terms | +6 each, capped at +24 |
| Activity within 6 hours / 24 hours / 72 hours / 14 days | +25 / +18 / +12 / +5 |
| Gap of 14–30 / over 30 / over 90 days | −15 / −60 / −120 |

A known project conflict, disjoint known people, or applicable human rejection excludes a candidate. A sender without identity/person overlap needs at least two shared topic terms before other evidence can support a match. A match needs score ≥65 and a lead of ≥12 over the next eligible candidate.

Topic comparison uses normalized lexical terms, not an LLM or an embedding call. Scores and confidence are inspectable heuristics, not calibrated probabilities. No network model/provider request occurs during ranking. The activity clock is the communication's occurrence time, so importing an old transcript does not make it appear to have happened today.

The decision stores its method, confidence, margin, input facts and top ten candidate scores/signals. The candidate endpoint can also recompute alternatives against current state. An old recorded decision and a newly recomputed ranking need not be identical after later messages or corrections.

## Quiet human feedback

In HyperFlow, open **Settings → Communications → Conversation thread register**. It is collapsed by default and only fetches when opened.

1. Filter by project, person or status; page older threads when needed. Search applies to the currently loaded page. Open a thread to inspect its communications and decision history.
2. Edit its title, summary, project or non-Ask status. Ask lifecycle remains owned by the workflow.
3. Choose **Review / move** on a mismatched communication. Inspect candidate scores, choose an existing destination or a new separate thread, and record why.
4. Optionally correct the person. The separate identity-repair checkbox explicitly associates that communication's email/phone identity with the selected person for future matching. It is not required for a one-message correction.
5. Save. Only that communication moves. Its group participant evidence follows it, and obsolete participant evidence is removed from the source. Provider updates must preserve the correction.

The register pages 100 threads at a time and 20 communications per history request. Older communications remain reviewable through **Load older communications**. History previews are bounded; the canonical APIs remain the source for complete communication content.

Feedback is contextual:

- Identity/person evidence can work across channels, including a repaired email-to-phone/person mapping.
- Known project context narrows the rule to that project.
- “Different topic” requires a shared topic term before the rule applies again.
- “Keep these channels separate” only applies to the corrected channel.
- “Separate conversation in time” expires after 14 days.
- The rejected destination is excluded and the corrected destination receives a preference. Other safety exclusions still apply.
- A later correction to the same communication supersedes its earlier active feedback. No model is retrained and no retrospective bulk rethreading is performed.

Corrections do not send, delete or replay messages, call providers, resolve Asks, or replay already-delivered workflow events. Moving an inferred open-Ask response away clears that response's inherited purpose/run/task link; the Ask stays bound to its original thread. Outbound Ask requests and terminal Ask associations require the workflow owner rather than this correction operation.

## Persistence and compatibility

Migration `019_ranked_thread_resolution.sql` adds normalized identities, participant evidence, decision/feedback records, register fields and read/correction/edit functions. Canonical and provider IDs remain unchanged; no existing public route is removed. Existing HyperFlow send, callback, event and authentication contracts remain in place.

Direct PostgreSQL resolution uses a short transaction plus a tenant-scoped advisory lock. A failed resolution rolls back its thread/participant/decision writes. Corrections and register edits are transactional and take the same lock. Adapters without transaction support serialize resolutions within one application process; cross-process serialization on those adapters has not been verified. Provider delivery itself is never held inside the ranking transaction and retains the existing idempotency/reconciliation rules.

Project edits on workflow-bound records are rejected by migration 020; non-project edits preserve correlation. Source-table updates for voice, SMS and recordings preserve corrected canonical links. SMS person overrides are per-message, not a rewrite of every message on the same native phone thread. Email replies to a corrected exact parent follow that correction; provider conversation IDs are scoped to their mailbox connection. Correcting an outbound email also moves its recorded current-format opaque reply route, so replies without RFC reply headers follow the correction. Other messages' reply routes, expiry and revocation remain unchanged.

## Verification and rollout

Run from Communications:

```sh
npm run test:unit
npm run test:db
```

The database suite applies migrations 000–021 to isolated PGlite PostgreSQL and exercises actual Fastify authentication, SQL functions, constraints, and provider-table projections. It covers group and project separation, cross-channel continuation, ranking, corrections/identity repair, Ask protection, voice/SMS/recording updates, email reply anchors, paging, live-call project reassignment, overlapping HTTP requests, and failed-resolution rollback. PGlite is an embedded single-connection fixture; this is not a production multi-node load test.

HyperFlow verification uses its full test suite, TypeScript checks and production build, plus `tests/ui/thread-register.html` with synthetic data. Browser checks cover collapsed loading, saved editor values, old-history loading, score explanations, explicit identity repair and the moved communication's destination. The fixture never authenticates to real services or sends communications.

Production acceptance still requires:

- publish the intended Communications source and apply migrations through 021 before serving it, approving only a generated database plan with no truncation, deletion, or dropped records;
- verify the live build fingerprint and an authenticated register read against the intended production database;
- deploy the matching HyperFlow proxy/UI and verify the register under authenticated membership;
- run a controlled cross-channel communication story and inspect the stored membership, correction, subsequent matching and correlated HyperFlow event results;
- use explicit approved recipients before any real email, SMS or voice delivery.

Local test success, a health response, and a source push are different evidence from production migration, authenticated data-flow or provider-delivery success.


See [Phase 02 record](implementation/P02.md) for migration 020, actor assertion capability, project safeguards and local acceptance limits.

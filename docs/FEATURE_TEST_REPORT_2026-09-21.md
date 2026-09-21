# Feature test report — 21 September 2026

## Outcome

The Replit deployment is running and its PostgreSQL health check passes. Testing found a high-priority unauthenticated voice-stream entry point, malformed-ID validation failures, and classification quality gaps. This is not an all-features production sign-off.

Target: https://communications-service.replit.app

Live version: v2.8.2; build: `c93330ac005e`. Replit source includes deployment fix commit `8d4d6f1`; the local equivalent is `543a2c9`.

Tests were executed through the Replit browser shell and the live browser console. Production checks used existing authorized credentials, read-only requests, invalid/unauthorized requests, and a bounded synthetic WebSocket probe. Isolated tests ran without production credentials. No real emails, SMS messages, or telephone calls were sent. No production source/configuration changes were made during testing.

## Results

| Test layer | Result |
| --- | --- |
| Isolated repository tests | 377 passed; 54 suites across 28 files; zero failed, skipped, or cancelled; 25.2 seconds |
| Main live HTTP feature/security checks | 78 of 79 passed; malformed contact UUID returned 500 |
| Additional live checks | Health and config resolution passed; malformed person-memory and project-memory UUIDs also returned 500 |
| Twilio HTTP signature checks | Valid signed unknown-call callback returned 204; altered signed body returned 403; signed unknown inbound line returned 503 with Hangup and no media stream |
| Voice WebSocket security | Failed: unauthenticated connection and fabricated start were accepted |
| Browser console | Page loads, blank call/SMS validation works, no browser warning/error logs observed |
| Production dependency audit | Zero known vulnerabilities reported by npm audit at test time |
| Real-model synthetic classification | 9 of 12 cases matched expected type sets; precision 63.6%, recall 77.8%, actor accuracy 100% on actor-labelled cases |

The test counts are not summed with other npm scripts, which overlap. `test/suite.test.js` was excluded from the isolated run because it expects a running service and can initiate provider sessions. HTTP and voice transport checks were performed separately.

## Findings

### High: unauthenticated voice-stream entry point

`/media-stream` accepted a WebSocket connection without credentials or a Twilio signature. A single synthetic start event with an invented CallSid remained connected for the bounded 2.5-second observation. The client then terminated it. No audio was supplied and no real call identifier was used.

Code corroboration: `index.js:816` registers the WebSocket route without signature prevalidation; its start handler around line 1403 falls back to default configuration when no stored call configuration exists, then calls `startOrAdoptSession()`. This creates a plausible route to unauthorized, billable realtime sessions. Actual charges and customer-data access were not demonstrated. Ordinary Twilio HTTP webhook signature enforcement passed and does not cover this gap.

Recommended correction: authenticate the WebSocket upgrade and require a valid, approved call binding before opening a model session. Add negative tests for unsigned connections, fabricated CallSids, and replay. The standalone transport suite currently expects the missing-config fallback, so that expectation also needs revision.

### Medium: malformed resource IDs produce server errors

These authenticated GET requests returned 500 with PostgreSQL UUID error text instead of a client validation response:

- `/v1/contacts/not-a-uuid`
- `/v1/contacts/not-a-uuid/memory`
- `/v1/projects/not-a-uuid/memory`

The contact detail route at `v1.js:1047` passes the parameter directly into the database query. Validate UUIDs consistently before database access and return 400/422 without internal database error details. Promise and meeting invalid-ID checks already returned 400 as expected.

### Classification quality needs work before enabling automation

The existing `scripts/evaluate-operational.js --live` harness used `gpt-5.4-mini` on its 12 synthetic development examples. Three mismatches occurred:

| Example | Expected | Actual |
| --- | --- | --- |
| Offer of help | OFFER | CONDITIONAL_PROMISE |
| Quoted prior promise | No new finding | PROMISE |
| Attachment claim | STATUS_UPDATE | REQUEST and EXPECTED_DELIVERABLE |

The quoted-text error can create false commitments. Precision and recall are type-level metrics from the existing harness, not production accuracy estimates. This small synthetic sample does not establish date resolution, attachment verification, multichannel reconciliation, or customer-domain accuracy. The harness explicitly reports `release_approved: false`.

## Feature coverage

| Feature area | Verification performed | Remaining live limitation |
| --- | --- | --- |
| Persistence and migrations | Database, tenant-scoping, ledger and FK regression suites; live PostgreSQL health and authenticated data reads | No destructive production migration/restore exercise |
| Calls and realtime voice | Call/recording APIs, config resolver, call outcome, voice-turn and transcript tests; signed webhook checks; bounded WebSocket probe | No real inbound/outbound call, audio quality, interruption, recording playback or human handoff verification |
| SMS and communications | Communications/inbox/detail reads, isolated message behavior, authentication rejection, console validation | No actual carrier delivery or inbound handset round trip |
| Email and mailboxes | Email, policy and mailbox suites; live policy/mailbox APIs | Tested tenant has no connected mailbox; policy is draft-only |
| Contacts, context and memory | Lists/details, person memory, context search, memory search, isolated memory tests | UUID validation defects above; no production contact/memory writes |
| Meetings and calendar | Meeting APIs and calendar candidates; isolated event/observation and meeting database suites | No external calendar sync round trip |
| Threads and loose ends | Thread register, detail where available, candidates, loose ends, filters and pagination; database suites | No production reassignment/mutation exercised |
| Promise Ledger | List/detail/query/coverage/policy, conditions/evidence/history; ledger database and lifecycle tests | Disabled/shadow configuration in tested tenant; no live acceptance/fulfilment lifecycle |
| Operational review | Sources, classifications, operational objects, briefing/items reads; isolated review tests; real-model synthetic evaluation | Owner-specific downstream UI and representative user review workflows not verified |
| Tenant administration | Client, usage, lifecycle and audit reads; lifecycle/operations suites; cross-tenant rejection tests | No production tenant/client creation, suspension or deletion |
| Tools, events and scheduling | Tool registry/names, call tools, event reads; tool, outbox and scheduler suites | No external tool side effects or downstream event-consumer delivery exercised |
| Web console | Live landing page/health badges, console render, blank-input validation, browser logs | Valid-recipient delivery flows not run |

The main HTTP suite also verified invalid API keys, missing authentication, cross-tenant headers/query parameters, unsigned Twilio webhooks, invalid filters/pagination/phone values, unknown IDs, limits, and unauthenticated mutation rejection.

## Observed tenant configuration

The authenticated legacy tenant returned:

- Mailboxes: empty list.
- Email policy: `mode: draft_only`, `configuredMode: null`, `version: unconfigured`.
- Promise policy: `enabled: false`, `shadow: true`, empty `project_ids`, `local_person_id: null`, `version: 0`.

These observations apply to the tested tenant, not necessarily every tenant. API availability alone does not establish that these workflows are enabled. Feature configuration was left unchanged.

## Evidence and reproduction

Replit temporary evidence files:

- `/tmp/codex-comprehensive-tests.log` and `.exit`
- `/tmp/codex-live-features.mjs`, `/tmp/codex-live-features.log`, `/tmp/codex-live-feature-results.json`
- `/tmp/codex-voice-security.json`
- `/tmp/codex-dependency-audit.json`
- `/tmp/codex-model-evaluation.json` and `.err`

These temporary files may disappear when the workspace restarts. This report preserves the observed findings without credentials or customer records.

Isolated tests enumerated all `test/*.test.js` except `suite.test.js`, then invoked Node with `--test --test-concurrency=2 --test-reporter=spec` and an environment containing only PATH, NODE_ENV=test and PERSISTENCE_PROVIDER=none. The dependency audit used `npm audit --omit=dev --json`.

Final live `/health` returned 200 with `ok`, the same build fingerprint, PostgreSQL persistence enabled and Twilio HTTP signatures set to enforce.

Actual email/SMS/call delivery tests remain pending designated test recipients. Load/stress, disaster recovery, exhaustive browser compatibility, and external application end-to-end tests were not performed. Resolve the WebSocket issue first, then validation and classifier gaps; enable tenant workflows only with their intended ownership/scope configuration and verify provider delivery using designated recipients.

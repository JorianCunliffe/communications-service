# Communications Service

Purpose-aware, channel-independent communication memory with production Twilio SMS and voice adapters, OpenAI Realtime voice conversations, Supabase persistence, cross-channel Ask threads, first-class calendar context, provenance-backed facts and commitments, and durable outbound events.

The canonical API is `/v1`. Provider identifiers such as Twilio `SM…` and `CA…` SIDs are retained for traceability, but callers address communications with provider-independent `comm_…` IDs.

> Implementation status: the source, migrations, and tests are present in this repository. A deployment must apply migrations `001` through `006` and configure Supabase before `/v1` can persist or retrieve communications memory.

## Documentation

- [Complete API reference](docs/API_REFERENCE.md)
- [Environment template](.env.example)
- [Memory search migration](migrations/006_memory_search.sql)

## Architecture

Four rules define the service boundary:

1. Hyperflow owns intent and workflow state.
2. Communications owns people, channel identities, delivery, transcripts, and communication history.
3. IDs and events cross the boundary; databases do not.
4. Explicit correlation wins; limited inference is only used when it is unambiguous.

### Ask is purpose, not metadata

`purpose` explains why a communication exists. A Hyperflow Ask is therefore represented directly:

```json
{
  "communication_id": "comm_82",
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_93bc"
  }
}
```

That Ask can span channels and multiple communications:

```text
ask_93bc
  └─ thread_a1
      ├─ outbound SMS: Can you approve the revised budget?
      ├─ inbound SMS: Can you send the supplier breakdown?
      ├─ outbound SMS: Here it is…
      ├─ incoming voice call
      └─ transcript: Okay, approved.
```

An inbound reply emits `ask.response.received`; it does not resolve the Ask. Hyperflow decides whether the reply actually answers the question and calls:

```http
POST /v1/asks/ask_93bc/resolve
X-API-Key: …
Content-Type: application/json

{ "communication_id": "comm_final_answer" }
```

The database function resolves the Ask binding, thread, and final communication in one transaction. Direct forms bypass Communications and enter Hyperflow at `respondToAsk()` directly.

### HyperFlow integration contract

HyperFlow is a consumer of this API, not a shared-database component. A compatible HyperFlow client must:

- authenticate outbound Communications requests with `X-API-Key`;
- send SMS as `POST /v1/messages` with `to`, `from`, and `body`;
- send calls as `POST /v1/calls` with `to`, `from`, and allow-listed `overrides`;
- read the canonical `communication_id` response field (an `id` field is not returned);
- deliver SMS/voice Asks through those channel endpoints with `purpose.type: "human_ask"`, `purpose.ask_id`, and an HTTPS `callback_url`;
- keep email/web-form Ask delivery in HyperFlow until an email provider adapter exists here;
- verify `X-Communications-Signature` over the raw webhook body, deduplicate `event_id`, and accept at-least-once delivery;
- treat `sms.delivered` and `call.completed` as success, `call.failed` as failure, and inspect `sms.sent.payload.status` for Twilio SMS failure statuses; and
- call `POST /v1/asks/:askId/resolve` only after HyperFlow has accepted a specific reply as the final answer.

There is deliberately no `POST /v1/asks` delivery endpoint. Ask is semantic purpose attached to a real channel communication, not a separate transport. See the [API reference integration section](docs/API_REFERENCE.md#hyperflow-consumer-contract) for payload and event details.

### Thread correlation order

For each communication, the service uses this order:

1. Explicit `thread_id` or `correlation.thread_id`.
2. Existing `ask_bindings` entry for `purpose.ask_id`.
3. For inbound communication only, exactly one open thread for the participant identity.
4. Otherwise, no inferred thread.

If a person has two open Ask threads, the service does not guess. The sender must provide an explicit thread or Ask ID.

## What is implemented

| Area | Current implementation |
|---|---|
| Canonical communications | Universal `comm_…` IDs; voice, SMS, email, WhatsApp, Slack, Teams, and recording shapes |
| Provider delivery | Twilio outbound SMS and voice |
| Provider ingestion | Twilio inbound SMS, calls, call status, message status, and recordings |
| Voice | OpenAI Realtime bidirectional audio over Twilio Media Streams |
| Purpose and correlation | First-class `purpose`; allow-listed workflow correlation fields |
| Ask threads | Explicit Ask binding, safe reply correlation, transactional resolution |
| People and identities | Existing contacts plus multiple channel identities per person |
| Context | Chronological call/SMS/recording history and ranked communication search |
| Memory layer | Calendar context, explainable thread expansion, summaries/current state, commitments, facts, and loose ends |
| Memory views | Before-meeting, person, project, and enriched thread read models |
| Enrichment | Durable asynchronous queue; raw communication storage never waits for model extraction |
| Events | Durable Supabase outbox, exponential retry, optional HMAC signature |
| Management | Read/audit API for contacts, lines, calls, tools, history, and recordings |
| Operator UI | Landing page, visible version/build marker, and test console |

Only Twilio currently performs outbound delivery. `POST /v1/communications` lets future email, Slack, Teams, WhatsApp, or other adapters record canonical communication data without changing the public model.

## Quick start

### 1. Install

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Minimum startup configuration:

```dotenv
OPENAI_API_KEY=sk-...
PORT=5050
```

The process exits when `OPENAI_API_KEY` is absent. Without Supabase, voice can still use built-in configuration, but communications are not persisted and `/v1` returns `503`.

### 2. Apply the database migrations

Run these in order in the Supabase SQL editor:

1. `migrations/001_communications_search.sql`
2. `migrations/002_search_communications.sql`
3. `migrations/003_communications_api.sql`
4. `migrations/004_calendar_memory.sql`
5. `migrations/005_communications_enrichment.sql`
6. `migrations/006_memory_search.sql`

Then configure:

```dotenv
SUPABASE_CONFIG_ENABLED=true
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Migration `003` adds the canonical API contract. Migrations `004`–`006` add calendar/recording relationships, the durable memory-enrichment queue, facts, commitments, thread state provenance, and explainable thread-aware search.

### Memory ingestion and retrieval

Calendar systems push provider-neutral, idempotent events to `POST /v1/calendar/events`. External Plaud/native recordings continue through `POST /api/recordings`; participants, calendar, project, and thread relationships are retained by the existing recording queue and canonical projection.

Useful read models:

```text
POST /v1/context/search
GET  /v1/threads/:threadId
GET  /v1/loose-ends
GET  /v1/calendar/events/:eventId/context
GET  /v1/contacts/:personId/memory
GET  /v1/projects/:projectId/memory
```

Search results distinguish direct matches from `thread_context` expansion and return the ranking components. Facts, commitments, summaries, and current state always carry source communication IDs.

### 3. Configure protected APIs

```dotenv
API_KEY=replace-with-a-long-random-secret
```

All `/v1` and `/api` routes require `X-API-Key`. If `API_KEY` is missing, protected routes return `503`; if it is wrong or absent from a configured deployment, they return `401`.

### 4. Configure Twilio delivery

```dotenv
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
PUBLIC_URL=https://communications.example.com
TWILIO_VALIDATE_SIGNATURES=warn
```

Configure the Twilio number:

| Twilio setting | URL |
|---|---|
| Voice: a call comes in | `POST https://<host>/incoming-call` |
| Voice: call status changes | `POST https://<host>/call-status` |
| Messaging: a message comes in | `POST https://<host>/incoming-sms` |

Outbound calls and messages attach their status callbacks programmatically. If the number belongs to a Twilio Messaging Service, configure the inbound message webhook on that service.

Start in `warn`, confirm real callbacks validate in the logs, then use `enforce`. Signature enforcement depends on `PUBLIC_URL` matching the externally visible URL exactly.

### 5. Start

```powershell
node index.js
```

Open:

- `http://localhost:5050/` — service landing page and visible build marker
- `http://localhost:5050/console` — operator call/SMS test console
- `http://localhost:5050/health` — machine-readable health and feature wiring

## First Ask over SMS

```bash
curl -X POST https://communications.example.com/v1/messages \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+61400000000",
    "from": "+61411111111",
    "body": "Can you approve the revised $180k budget?",
    "purpose": {
      "type": "human_ask",
      "ask_id": "ask_93bc"
    },
    "correlation": {
      "tenant_id": "tenant_1",
      "run_id": "run_8",
      "task_id": "task_12",
      "hold_id": "hold_5"
    },
    "callback_url": "https://hyperflow.example.com/api/communications/events"
  }'
```

Example response:

```json
{
  "communication_id": "comm_7d0d7cc95c8946aa80c68d6ed8431dd7",
  "channel": "sms",
  "direction": "outbound",
  "person_id": null,
  "occurred_at": "2026-08-11T07:30:00.000Z",
  "content": "Can you approve the revised $180k budget?",
  "transcript": null,
  "summary": null,
  "provider": "twilio",
  "provider_id": "SM…",
  "correlation": {
    "tenant_id": "tenant_1",
    "run_id": "run_8",
    "task_id": "task_12",
    "hold_id": "hold_5",
    "thread_id": "thread_…"
  },
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_93bc"
  },
  "resolution": null
}
```

## Canonical communication contract

Supported channels:

```text
voice | sms | email | whatsapp | slack | teams | recording
```

Supported directions:

```text
inbound | outbound
```

Allowed correlation fields:

```text
tenant_id | project_id | run_id | task_id | hold_id |
thread_id | calendar_event_id | person_id
```

`ask_id` deliberately is not correlation metadata. It belongs under `purpose`.

## Durable events

Set a deployment-wide destination, pass a per-thread HTTPS callback URL, or both:

```dotenv
HYPERFLOW_EVENT_URL=https://hyperflow.example.com/api/communications/events
COMMUNICATIONS_WEBHOOK_SECRET=replace-with-a-shared-secret
```

The outbox:

- persists the complete event before delivery;
- delivers batches of up to 20 every 15 seconds;
- retries up to 12 times with exponential backoff from 5 seconds to 1 hour;
- accepts only public HTTPS destinations after DNS/private-address checks;
- includes `X-Communications-Event-Id`;
- includes `X-Communications-Signature: sha256=<hex>` when a secret is configured.

Delivery is at least once. Consumers should deduplicate by `event_id`.

Implemented event types:

```text
communication.created     communication.received
sms.sent                  sms.delivered             sms.received
call.started              call.answered             call.completed
call.failed               transcript.completed      summary.completed
ask.response.received     ask.resolved
```

No destination means no outbox row is created.

## Environment variables

| Variable | Required when | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | Always | Required at process startup; Realtime voice and summaries/transcription use it |
| `PORT` | Optional | Listen port; default `5050` |
| `API_KEY` | Using `/v1`, `/api`, `/sms`, `/outbound-call` | Shared `X-API-Key` secret |
| `SUPABASE_CONFIG_ENABLED` | Persistence/config enabled | Must be exactly `true` |
| `SUPABASE_URL` | Supabase enabled | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase enabled | Service role; required because tables use RLS |
| `TWILIO_ACCOUNT_SID` | Twilio delivery/signing | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio delivery/signing | Twilio auth token |
| `PUBLIC_URL` | Outbound voice and webhook verification | Exact public base URL, without a required trailing slash |
| `TWILIO_VALIDATE_SIGNATURES` | Optional | `off`, `warn`, or `enforce`; defaults to `warn` when the auth token exists |
| `PRECONNECT_REALTIME` | Optional | Set `false` to disable early Realtime connection |
| `GREETING_MODE` | Optional | `instructions` by default; `item` restores the legacy greeting mode |
| `CONTEXT_TIMEZONE` | Optional | IANA zone used for history grouping; default `Australia/Brisbane` |
| `SUMMARY_MODEL` | Optional | Summary model; default `gpt-5.4-mini` |
| `MEMORY_MODEL` | Optional | Structured memory extraction model; defaults to `SUMMARY_MODEL`, then `gpt-5.4-mini` |
| `TRANSCRIBE_MODEL` | Optional | Diarized transcription model; default `gpt-4o-transcribe-diarize` |
| `CALENDAR_CANDIDATE_WINDOW_MINUTES` | Optional | Nearby-event candidate window; default `120` minutes |
| `MEMORY_SEARCH_*` | Optional | Testable text/person/project/thread/calendar/recency ranking weights |
| `HYPERFLOW_EVENT_URL` | Optional | Default durable event destination |
| `COMMUNICATIONS_WEBHOOK_SECRET` | Optional | HMAC-SHA256 event signing secret |
| `TOOL_<NAME>_URL` | Per HTTP tool | Makes that tool available to the voice model |
| `RECORDING_SOURCE_<NAME>_HOSTS` | Optional | Comma-separated host allow-list for external recording media |

## Data model

| Table | Responsibility |
|---|---|
| `contacts` | Current person/contact record and primary phone configuration link |
| `communication_identities` | Many phone/email/Slack/WhatsApp/Teams identities for one person |
| `calls` | Provider call state, prompt, transcript, summary, and canonical linkage |
| `sms_threads` / `sms_messages` | Native Twilio phone-line history |
| `recordings` | Durable recording/transcription queue |
| `communications` | Canonical provider-independent projection and search surface |
| `communication_threads` | Cross-channel thread state, purpose, correlation, and callback destination |
| `communication_thread_members` | Explicit/native/inferred communication membership |
| `ask_bindings` | External Ask-to-thread binding and resolution state |
| `outbound_events` | Durable webhook payload, retry, and delivery state |
| `projects` / `project_contacts` | Optional project association for contextual retrieval |
| `calendar_events` / `calendar_event_participants` | Idempotent provider events and resolved/unresolved attendees |
| `communication_commitments` | Promise/request state with due date and source excerpt |
| `communication_facts` | Active, superseded, or retracted claims with source communication IDs |
| `communication_enrichment_jobs` | Recoverable asynchronous summary/state/fact/commitment work |

The original provider tables remain because they contain channel-specific details. Database triggers project calls and SMS into `communications` without using provider SIDs as public identifiers.

## Security

- Protected APIs fail closed when `API_KEY` is absent.
- API keys are compared in constant time.
- Twilio callbacks support signature enforcement.
- External recording URLs and event destinations reject private, loopback, link-local, carrier NAT, multicast, reserved, and cloud-metadata addresses.
- Supabase service-role credentials belong in deployment secrets, never source control.
- `purpose.token`, when supplied, is persisted and included in event payloads. Treat it as a secret-bearing capability and scope/rotate it accordingly.

## Operational limitations

- Only Twilio currently sends communications; other channels enter through provider adapters using `POST /v1/communications`.
- Memory enrichment is asynchronous and eventually consistent. A newly stored communication may appear in search before its summary, facts, commitments, or current state exist.
- Direct Plaud network sync requires an injected authenticated adapter because no undocumented Plaud API is assumed. The generic idempotent recording endpoint is production-ready for pushes.
- Config CRUD for legacy contact and phone-line settings is not implemented; `/api` provides read/audit endpoints.
- Outbound SMS/calls are accepted by Twilio before the strict persistence write completes. There is no idempotency-key contract yet, so clients must investigate a `502` before blindly retrying a billable send.
- Event delivery is at least once and the current worker does not lease rows across multiple service instances. Consumers must deduplicate `event_id`.
- Applying migration files is an operational step; committed SQL does not prove the live Supabase schema has been updated.
- Full integration tests require a running server and real provider credentials. Unit tests do not place calls or send SMS.

## Testing

Unit tests:

```powershell
npm.cmd run test:unit
```

The full suite expects a running server and includes live OpenAI Realtime connectivity checks:

```powershell
npm.cmd test
```

The purpose/thread suite verifies:

- `human_ask` requires `ask_id`;
- `ask_id` is not accepted as random correlation metadata;
- explicit thread IDs are preserved;
- one open Ask can correlate an incoming call after an SMS;
- two open Asks remain ambiguous;
- `/v1` fails closed without API and database configuration;
- the migration contains the canonical ID, identity, thread, Ask, resolution, and outbox contracts.
- calendar ingestion is idempotent and retains unresolved identities;
- Plaud normalization feeds the existing recording contract;
- thread context is explainable and unrelated threads are excluded;
- commitments, due dates, loose ends, fact provenance, and supersession work as specified.

## Repository map

| Path | Role |
|---|---|
| `index.js` | Fastify server, Twilio webhooks, voice bridge, health/UI |
| `v1.js` | Canonical Communications API |
| `api.js` | Legacy management/audit and recording-ingest API |
| `communicationModel.js` | IDs, purpose/correlation validation, canonical shape, thread resolution |
| `eventOutbox.js` | Durable event enqueue and delivery worker |
| `callLog.js` / `smsLog.js` | Provider persistence and canonical linkage |
| `context.js` | Chronological history and ranked retrieval integration |
| `calendar.js` / `calendarProviders.js` | Canonical calendar ingestion, exact identity resolution, and candidates |
| `memory.js` | Thread-aware search, loose ends, and person/project/event memory views |
| `enrichment.js` | Durable structured summary/state/fact/commitment worker |
| `plaud.js` | Plaud adapter contract and recording normalization |
| `migrations/` | Supabase schema and verification scripts |
| `docs/API_REFERENCE.md` | Endpoint-by-endpoint API contract |

## License

See [LICENSE](LICENSE).

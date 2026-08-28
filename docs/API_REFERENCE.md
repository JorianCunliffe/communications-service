# Communications Service API Reference

Updated: 27 August 2026

This reference documents the HTTP and WebSocket surface implemented by `index.js`, `v1.js`, and `api.js`.

## Base URL

```text
https://<your-communications-host>
```

JSON is used for protected APIs. Twilio webhook endpoints accept form-encoded POST bodies or query parameters and return TwiML or an empty response as appropriate.

## Authentication

### Protected service APIs

Every `/v1` and `/api` route requires:

```http
X-API-Key: <API_KEY>
```

The compatibility `API_KEY` is restricted to `LEGACY_TENANT_ID`. New scoped credentials use `X-API-Key: <key_id>.<secret>` and also require:

```http
X-Tenant-Id: tenant_1
```

The requested tenant must be present in the client's `allowed_tenants`. Any body or query tenant value must agree with the header. The authenticated tenant is injected into writes and durable events; callers cannot override it.

Scoped clients also need `communications:read` for GET `/v1`, `communications:write` for mutations, and `email:send` for `POST /v1/emails`. Management routes use `management:read` and `management:write`. The compatibility key has `*` capability.

The legacy `POST /sms` and `POST /outbound-call` routes use the same header.

| Condition | Status | Body |
|---|---:|---|
| `API_KEY` is not configured | `503` | `{ "error": "<feature> is not configured" }` |
| Header is missing or wrong | `401` | `{ "error": "Invalid or missing X-API-Key" }` |
| Tenant is missing for a scoped client | `400` | `{ "error": "tenant_id or X-Tenant-Id is required" }` |
| Client is not allowed for the tenant | `403` | `{ "error": "API client is not allowed for this tenant" }` |
| Legacy key has no tenant mapping | `503` | `{ "error": "LEGACY_TENANT_ID is required for the legacy API key" }` |
| `/v1` needs persistence but it is disabled | `503` | `{ "error": "Communications persistence is not configured" }` |
| `/api` needs persistence but it is disabled | `503` | Error plus required provider configuration detail |

`GET /api/tools`, `GET /api/tools/names`, and `GET /api/tools/:name` still require the API key even though they do not require database persistence.

### Persistence provider

All persistent APIs support either Supabase or direct PostgreSQL. Replit Database uses the direct PostgreSQL path:

```dotenv
PERSISTENCE_PROVIDER=postgres
DATABASE_URL=postgresql://...
```

Supabase uses `PERSISTENCE_PROVIDER=supabase`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. The legacy `SUPABASE_CONFIG_ENABLED=true` switch remains supported. Databases require migrations `000` through `010`; `LEGACY_TENANT_ID` must be set before migration `009` backfills and locks existing rows.

### Twilio webhooks

Twilio endpoints use `X-Twilio-Signature`, controlled by `TWILIO_VALIDATE_SIGNATURES`:

| Mode | Behavior |
|---|---|
| `off` | No verification |
| `warn` | Verify and log failures without rejecting; explicit migration-only mode |
| `enforce` | Reject invalid or missing signatures with `403`; default when `TWILIO_AUTH_TOKEN` exists |

Validation uses `PUBLIC_URL` plus the raw request path. The configured public URL must match the URL Twilio signs.

## Common types

### Communication

All canonical read and create responses use:

```json
{
  "contract_version": "2.0",
  "tenant_id": "tenant_1",
  "communication_id": "comm_7d0d7cc95c8946aa80c68d6ed8431dd7",
  "thread_id": "thread_93bc",
  "channel": "sms",
  "direction": "outbound",
  "person_id": "6b31dfc4-a25b-482b-bd06-623ee1289f39",
  "occurred_at": "2026-08-11T07:30:00.000Z",
  "content": "Can you approve the revised budget?",
  "transcript": null,
  "summary": null,
  "provider": "twilio",
  "provider_id": "SM…",
  "correlation": {
    "tenant_id": "tenant_1",
    "run_id": "run_8",
    "thread_id": "thread_…"
  },
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_93bc"
  },
  "resolution": null,
  "outcome": {
    "business_status": "success",
    "disposition": "human_completed",
    "successful": true,
    "memory_eligible": true,
    "failure_code": null,
    "failure_reason": null,
    "source": "transcript_model",
    "confidence": 0.98,
    "detected_at": "2026-08-26T07:30:20.000Z"
  }
}
```

`tenant_id`, `communication_id`, and `thread_id` are stable top-level contract fields. `provider_id` is diagnostic/provider identity. `outcome` is always present in the canonical shape; fields may be `null` for channels without a finalized business outcome. For voice, `business_status` is `pending`, `success`, or `failed`. Only `disposition: human_completed` is successful and memory eligible.

### Channel

```text
voice | sms | email | whatsapp | slack | teams | recording
```

### Direction

```text
inbound | outbound
```

### Purpose

`purpose` is optional. When present it must be an object with a non-empty string `type`.

For a Human Ask:

```json
{
  "type": "human_ask",
  "ask_id": "ask_93bc",
  "token": "optional-opaque-capability"
}
```

`ask_id` is required for `human_ask`. Additional purpose fields are preserved. A supplied token is persisted and appears in event payloads.

### Correlation

Only these optional string fields are retained:

```json
{
  "tenant_id": "tenant_1",
  "external_project_id": "workflow_project_42",
  "run_id": "run_8",
  "task_id": "task_12",
  "hold_id": "hold_5",
  "thread_id": "thread_…",
  "calendar_event_id": "event_9",
  "person_id": "person_21"
}
```

Unknown correlation keys are ignored. Present values must be strings. `ask_id` belongs in `purpose`, not correlation. Top-level `project_id` is the internal project UUID. The deprecated `correlation.project_id` alias is normalized to `external_project_id` and is never written to the UUID foreign key.

### Semantic request fields

The following optional fields are accepted by `POST /v1/communications`, `POST /v1/messages`, and `POST /v1/calls`:

| Field | Type | Behavior |
|---|---|---|
| `purpose` | object | First-class reason for the communication |
| `correlation` | object | Allow-listed cross-system IDs |
| `metadata` | object | Used as a backward-compatible correlation source only when `correlation` is absent; generic communication writes also store it as provider metadata |
| `thread_id` | string | Explicit semantic thread ID |
| `callback_url` | HTTPS URL | Per-thread durable event destination |
| `project_id` | UUID | Internal Communications project foreign key |

Outbound SMS/calls additionally accept `override_do_not_contact: true` only with a non-empty `override_reason`. The override is logged and retained in the outbound operation audit context; without both fields a suppressed contact returns `409` before Twilio is called.

## Canonical `/v1` API

All endpoints in this section require the API key and configured database persistence.

### List communications

```http
GET /v1/communications
```

Query parameters:

| Name | Type | Notes |
|---|---|---|
| `limit` | integer | Default `50`, clamped to `1…200` |
| `cursor` | ISO timestamp | Return rows older than this value; use `next_cursor` from the previous response |
| `channel` | Channel | Exact match; unknown channel returns `400` |
| `thread_id` | string | Exact semantic thread |
| `ask_id` | string | Exact `purpose.ask_id` |
| `person_id` | UUID | Exact canonical person/contact ID |
| `business_status` | string | Exact `pending`, `success`, or `failed` call outcome state |
| `disposition` | string | Exact finalized call disposition |
| `successful` | boolean string | `true` or `false`; other values are ignored |
| `memory_eligible` | boolean string | `true` or `false`; other values are ignored |

Newest communications are returned first. `next_cursor` is `null` when there is no full next page.

```json
{
  "data": [
    { "communication_id": "comm_…", "channel": "sms", "direction": "inbound" }
  ],
  "count": 1,
  "limit": 50,
  "next_cursor": null
}
```

### Record a canonical communication

```http
POST /v1/communications
```

This records an interaction performed or received by a provider adapter. It does not send through email, Slack, Teams, WhatsApp, or any other provider.

Required fields:

| Field | Type |
|---|---|
| `channel` | Channel |
| `direction` | Direction |

Optional fields:

| Field | Type | Notes |
|---|---|---|
| `identity` | string | Participant identity used for thread correlation |
| `service_identity` | string | Receiving/sending service identity |
| `person_id` | UUID | Existing `contacts.id`; also used as participant identity when `identity` is absent |
| `occurred_at` | ISO timestamp | Defaults to now |
| `subject` | string | Stored in canonical search row; not returned by the current canonical serializer |
| `content` | string | Canonical body |
| `summary` | string | Optional summary |
| `provider` | string | Provider name |
| `provider_id` | string | Provider-native identifier |
| `metadata` | object | Provider-specific metadata; also legacy semantic source when `correlation` is absent |
| `purpose`, `correlation`, `thread_id`, `callback_url` | — | See common semantic fields |

Response: `201` plus a Communication.

When `calendar_event_id` resolves to a stored calendar event, the canonical row retains that first-class relationship and inherits the event's explicit thread/project when they were not separately supplied. When no event is explicit and the person is known, the response also includes conservative `calendarCandidates`; candidates are never auto-linked.

Events:

- `communication.created`
- `communication.received` for inbound records
- `ask.response.received` for inbound Human Ask records

### Read a communication

```http
GET /v1/communications/:communicationId
```

Returns a Communication or `404 { "error": "Communication not found" }`.

### Mark communication disposition

```http
POST /v1/communications/:communicationId/disposition
```

Body: `{ "disposition": "spam", "memory_eligible": false }`. Supported dispositions are `candidate_human_response`, `human`, `spam`, `bounce`, `automatic_reply`, `mailing_list`, `unsubscribe_intent`, `system_generated`, `archived`, and `unassigned`. Non-human dispositions cannot be marked memory eligible. Email triage and canonical communication state are updated together at the service layer.

### Triaged inbox

```http
GET /v1/inbox
```

Returns tenant-scoped inbound communications newest first. `limit` is `1…200`; `cursor` is the prior `next_cursor` ISO timestamp. Optional `channel` and `disposition` filters are exact matches.

### Requeue memory enrichment

```http
POST /v1/communications/:communicationId/enrich
```

Creates or resets the durable `memory` enrichment job. It does not run model extraction inline. Returns the queued job, `404` when the communication does not exist, or `409` when the communication is audit-only with `memory_eligible: false`.

### Send SMS

```http
POST /v1/messages
Idempotency-Key: stable-workflow-operation-id
```

Required body:

```json
{
  "to": "+61400000000",
  "from": "+61411111111",
  "body": "Can you approve the revised budget?"
}
```

`to` and `from` must be E.164. `body` must contain `1…1600` characters. Semantic request fields may be added.

Requirements:

- configured Supabase or PostgreSQL communications persistence
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `PUBLIC_URL` is optional for sending, but required to attach `/message-status`
- a stable `Idempotency-Key` header

Response: `201` plus a canonical SMS Communication.

The idempotency key is bound to the normalized outbound request. An identical completed retry returns `200` with the original response and does not send another SMS. Reuse for a different request or an operation whose provider outcome is uncertain returns `409`.

Events:

- `communication.created`
- `sms.sent`
- later `sms.delivered` or `sms.failed` when Twilio reports a terminal status

Provider failures and strict persistence failures are returned as `502` with `Failed to send message: …`.

### Read an SMS communication

```http
GET /v1/messages/:communicationId
```

Returns the Communication only when its channel is `sms`; otherwise returns `404 { "error": "Message not found" }`.

### Send email

```http
POST /v1/emails
X-API-Key: <key_id>.<secret>
X-Tenant-Id: tenant_1
Idempotency-Key: stable-workflow-operation-id
Content-Type: application/json
```

```json
{
  "service_identity_id": "a96e0f1a-09ca-471d-9dc3-853bbb822bf8",
  "to": ["person@example.com"],
  "subject": "Approval needed",
  "text": "Can you approve the revised budget?",
  "purpose": { "type": "human_ask", "ask_id": "ask_93bc" },
  "correlation": {
    "external_project_id": "project_42",
    "run_id": "run_8",
    "task_id": "task_12"
  },
  "callback_url": "https://hyperflow.example.com/api/events"
}
```

`from` may be used instead of `service_identity_id`, but it must resolve to exactly one tenant-owned identity with `can_send=true`. `to` is required. `cc`, `bcc`, `reply_to`, `html`, `person_id`, `provider_connection_id`, and common semantic fields are optional. At least one of `text` or `html` is required. HTML is sanitized before storage and delivery.

Requirements:

- `EMAIL_ENABLED=true`
- an enabled tenant-owned Resend `provider_connections` row whose `channels` contains `email`
- a matching sending `service_identities` row
- the deployment secret referenced by `credential_reference`, normally `env:RESEND_API_KEY`
- a stable `Idempotency-Key`

Response: `202` plus the canonical email Communication. An identical completed retry returns `200`; key reuse with different content returns `409`. Provider acceptance emits `email.accepted`; signed provider webhooks later emit `email.delivered` or `email.failed`.

When the identity has `reply_domain`, the service creates a random reply capability, stores only its SHA-256 hash, and sends `reply+<opaque-token>@<reply-domain>` as Reply-To. Routes expire after 30 days by default and can be revoked.

### Read an email communication

```http
GET /v1/emails/:communicationId
```

Returns the canonical Communication plus its safe `email` record. Raw provider webhook bodies remain separate in `webhook_receipts`.

### Place a voice call

```http
POST /v1/calls
Idempotency-Key: stable-workflow-operation-id
```

Required body:

```json
{
  "to": "+61400000000",
  "from": "+61411111111"
}
```

Optional `overrides` is shallow-merged over resolved call configuration. Allowed keys are `model`, `effort`, `voice`, `temperature`, `systemMessage`, `introMessage`, `introMessage2`, `introVoice`, `greetingText`, `aiSpeaksFirst`, and `liveTranscript`; unknown keys return `400`.

Requirements:

- configured Supabase or PostgreSQL communications persistence
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `PUBLIC_URL`
- a stable `Idempotency-Key` header

Response: `201` plus a canonical voice Communication.

An identical completed retry returns `200` with the original response and does not place another call. Key conflicts or operations whose provider outcome is uncertain return `409`.

Events:

- `communication.created`
- `call.started`
- later `call.answered`, followed by exactly one `call.completed` or `call.failed` business outcome
- later `transcript.completed` and optionally `summary.completed`
- `ask.response.received` only after a Human Ask call is verified as `human_completed`

Twilio `CallStatus=completed` means the provider call ended; it is not itself business success. The durable finalizer combines provider status, optional Twilio answering-machine/fax detection, transcript safety rules, and strict structured classification. `call.completed` is emitted only for `human_completed`. Voicemail, wrong number, no answer, busy, fax, automated system, provider failure, canceled, missing/non-meaningful response, and safely unclassified calls emit `call.failed` and remain `memory_eligible: false`.

Failures are returned as `502` with `Failed to place call: …`.

### Read a voice communication

```http
GET /v1/calls/:communicationId
```

Returns the Communication only when its channel is `voice`; otherwise returns `404 { "error": "Call not found" }`.

### List people/contacts

```http
GET /v1/contacts
```

Returns up to 200 raw contact rows ordered by name:

```json
{ "data": [] }
```

There is currently no pagination or search parameter.

### Create a person/contact

```http
POST /v1/contacts
```

```json
{
  "name": "Jim Example",
  "phone_number": "+61400000000",
  "identities": [
    { "type": "email", "value": "jim@example.com", "provider": "smtp" },
    { "type": "slack", "value": "U123", "provider": "slack" }
  ]
}
```

`name` is required. Each identity requires non-empty string `type` and `value`. A phone identity must be E.164. When `phone_number` exists and is not repeated in `identities`, a Twilio phone identity is added automatically.

Response: `201` with the created contact, `person_id`, and identity rows.

Contact creation and identity insertion are currently separate writes rather than one transaction.

### Read a person/contact

```http
GET /v1/contacts/:personId
```

Returns the raw contact row, `person_id`, and `identities`, or `404`.

### Person memory

```http
GET /v1/contacts/:personId/memory
```

Returns the person, active threads, open commitments, active recent facts, recent communications, and upcoming calendar events. Unknown person returns `404`.

### Project memory

```http
GET /v1/projects/:projectId/memory
```

Returns the project, associated people, related threads, active facts, open commitments, recent communications, and calendar events. This is a read model, not project-management state. Unknown project returns `404`.

## Calendar context

### Ingest an event

```http
POST /v1/calendar/events
```

```json
{
  "provider": "google",
  "provider_id": "native-event-123",
  "title": "Smith Street valuation meeting",
  "starts_at": "2026-08-13T10:30:00+10:00",
  "ends_at": "2026-08-13T11:00:00+10:00",
  "location": "Cairns office",
  "project_id": "project UUID",
  "thread_id": "thread_...",
  "participants": [
    { "type": "email", "value": "jim@example.com", "response_status": "accepted" },
    { "type": "email", "value": "unknown@example.com" }
  ],
  "metadata": {}
}
```

`provider + provider_id` is idempotent. Participants resolve only by an exact existing channel identity. Unknown and ambiguous identities are retained with `contact_id: null`; write ingestion never fuzzy-merges people.

Response: `201 { "event": {}, "participants": [] }` for both creates and idempotent updates.

### Find nearby event candidates

```http
GET /v1/calendar/candidates?person_id=<uuid>&occurred_at=<timestamp>&window_minutes=120
```

Returns same-participant events inside the time window with an explainable reason and confidence. Multiple plausible candidates remain candidates and are never assigned automatically.

### Before-meeting context

```http
GET /v1/calendar/events/:eventId/context
```

`eventId` may be the internal UUID or a unique provider ID. Returns:

```json
{
  "event": {},
  "participants": [],
  "recent_threads": [],
  "open_commitments": [],
  "recent_facts": [],
  "recent_communications": []
}
```

### Search context

```http
POST /v1/context/search
```

```json
{
  "query": "Smith Street valuation",
  "person_id": "6b31dfc4-a25b-482b-bd06-623ee1289f39",
  "project_id": "project UUID when used",
  "thread_id": "thread_...",
  "calendar_event_id": "calendar event UUID",
  "since": "2026-07-01T00:00:00Z",
  "until": "2026-09-01T00:00:00Z",
  "channels": ["sms", "voice"],
  "include": {
    "communications": true,
    "threads": true,
    "facts": true,
    "commitments": false,
    "calendar": true
  },
  "limit": 20
}
```

`contact_id` is accepted as an alias for `person_id`. `limit` defaults to 20 and is clamped to `1…100`.

```json
{
  "communications": [],
  "threads": [],
  "facts": [],
  "calendar_events": [],
  "commitments": [],
  "query_context": {
    "filters": {},
    "include": {},
    "weights": {}
  }
}
```

`communications` still comes from the enhanced `search_communications` database function. Each direct result is labelled `relationship_to_query: "direct_match"` and includes `score` plus `score_reasons`. Other communications from a matched thread may be included as `thread_context` with the direct communication ID in `via`; they do not inherit the match score.

Threads rank only when at least one member ranks. Facts default to active only. Calendar context defaults on; commitments are opt-in to keep the default response compact. Existing request fields remain compatible.

### Read a semantic thread

```http
GET /v1/threads/:threadId
```

Returns the original thread fields for compatibility plus:

```json
{
  "thread": {},
  "communications": [],
  "calendar_events": [],
  "participants": [],
  "summary": null,
  "current_state": null,
  "commitments": [],
  "facts": [],
  "provenance": {
    "summary": ["comm_..."],
    "current_state": ["comm_..."],
    "facts": {},
    "commitments": {}
  }
}
```

Communications are chronological. Missing enrichment is returned as null/empty rather than failing the thread read.

### List loose ends

```http
GET /v1/loose-ends?person_id=<uuid>&project_id=<uuid>&limit=100
```

Returns open commitments, unresolved Human Ask bindings, and conservative explicit outstanding thread state. Each item carries source communication IDs where available.

### Update commitment status

```http
POST /v1/commitments/:commitmentId/status
Content-Type: application/json

{ "status": "completed" }
```

Statuses: `open`, `completed`, `cancelled`, `superseded`, `unknown`. Terminal states set `resolved_at`; reopening clears it.

### Retract or reactivate a fact

```http
POST /v1/facts/:factId/status
Content-Type: application/json

{ "status": "retracted" }
```

Manual statuses are `active` and `retracted`. Enrichment automatically creates a new fact and marks the prior active fact `superseded`; it never deletes historical provenance.

### Resolve a Human Ask

```http
POST /v1/asks/:askId/resolve
```

```json
{
  "communication_id": "comm_final_answer"
}
```

The communication must be a member of the Ask's thread. The database function atomically:

1. adds an `ask_resolved` resolution to the selected communication;
2. resolves `ask_bindings` with `resolved_by`;
3. resolves the semantic thread.

Response:

```json
{
  "ask_id": "ask_93bc",
  "status": "resolved",
  "communication_id": "comm_final_answer",
  "thread_id": "thread_…",
  "resolved_at": "2026-08-11T08:00:00.000Z"
}
```

Errors:

- `400` missing communication ID or communication is not in the Ask thread
- `404` Ask has no binding
- `409` Ask is cancelled or was resolved by a different communication
- `500` transactional database failure

Event: `ask.resolved`.

Repeating the same resolution with the same `communication_id` is idempotent and returns success with `"duplicate": true`; it does not emit another resolution event.

### Inspect event outbox

```http
GET /v1/events
```

Returns the 100 newest raw `outbound_events` rows. This includes destination, payload, attempts, status, retry time, error, and delivery timestamps.

```http
POST /v1/events/:eventId/requeue
```

Resets a failed event to `pending`, clears its lease, error, and attempt count, and returns the requeued row. Requeueing does not change the event ID; consumers must continue to deduplicate by `event_id`.

## Thread and Ask behavior

Resolution order:

1. `thread_id` or `correlation.thread_id`
2. existing `ask_bindings.ask_id`
3. one and only one open thread for an inbound participant identity
4. no thread when zero or multiple candidates exist

Explicit links use confidence `1`. The limited participant inference uses confidence `0.8`. Link types are `native`, `explicit`, or `inferred`.

An inbound Ask communication emits a candidate response event. It never changes Ask status automatically.

## Asynchronous memory enrichment

Every canonical communication with text is queued in `communication_enrichment_jobs` by a failure-isolated database trigger. The worker uses the OpenAI Responses API with strict Structured Outputs to derive conservative thread summary/current state, explicit commitments, active facts, and outstanding dependencies. Transcript text is treated as untrusted evidence rather than instructions.

The queue is durable, reclaims stale work, retries failures with backoff, and preserves a rerun request when a communication changes during processing. Obvious explicit commitments are extracted conservatively even if the model call is temporarily unavailable. Raw communication persistence and provider webhooks never wait for enrichment.

All derived claims retain source `comm_*` IDs. A newer fact with the same `fact_key` supersedes the old row without deleting it. Re-enrichment never reopens a commitment already completed or cancelled by a human.

## Durable event webhooks

An event is queued only when either:

- the thread has a per-request `callback_url`; or
- `HYPERFLOW_EVENT_URL` is configured.

Per-thread callback wins over the deployment default.

### Envelope

```json
{
  "contract_version": "2.0",
  "tenant_id": "tenant_1",
  "event_id": "evt_8aef…",
  "communication_id": "comm_7d0d…",
  "type": "ask.response.received",
  "occurred_at": "2026-08-11T07:45:00.000Z",
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_93bc"
  },
  "correlation": {
    "tenant_id": "tenant_1",
    "thread_id": "thread_…"
  },
  "payload": {
    "ask_id": "ask_93bc",
    "channel": "sms",
    "content": "Can you send the supplier breakdown?"
  }
}
```

### Headers

```http
Content-Type: application/json
X-Communications-Event-Id: evt_…
X-Communications-Contract-Version: 2.0
X-Communications-Tenant-Id: tenant_1
X-Communications-Timestamp: 1787800000
X-Communications-Signature: sha256=<hex HMAC of raw JSON body>
X-Communications-Signature-V2: sha256=<hex HMAC of timestamp + "." + raw JSON body>
```

`COMMUNICATIONS_WEBHOOK_SECRET` is required whenever a durable destination is configured. The original raw-body signature remains during migration; new consumers should validate the timestamped V2 signature, reject stale timestamps, and deduplicate `event_id`.

### Delivery policy

- public HTTPS destinations only;
- DNS results are checked for private/reserved addresses;
- every redirect target is revalidated and optional `COMMUNICATIONS_WEBHOOK_HOSTS` is enforced;
- 15-second delivery timeout;
- batches of 20;
- sweeper interval 15 seconds;
- maximum 12 attempts;
- exponential delay starting at 5 seconds, capped at 1 hour;
- states: `pending`, `retrying`, `delivered`, `failed`.
- database leases prevent concurrent claims across service instances;
- permanent HTTP 4xx responses fail immediately; `408`, `425`, `429`, and 5xx responses retry.

Delivery is at least once. Deduplicate on `event_id`.

### HyperFlow consumer contract

The following requirements are normative for a HyperFlow deployment consuming this API.

#### Outbound requests

- Use `X-API-Key: <API_KEY>`. `Authorization: Bearer` is not accepted by protected Communications routes.
- Send `X-Tenant-Id` with tenant-scoped credentials and verify the response/event tenant matches the workflow tenant.
- Supply a stable `Idempotency-Key` for each workflow action that can create a billable SMS, call, or email.
- For SMS, call `POST /v1/messages` with `to`, `from`, and `body`. The fields `content` and a missing `from` number are invalid.
- For voice, call `POST /v1/calls` with `to`, `from`, and any approved voice configuration under `overrides`. A top-level `instruction` field is not the call configuration contract.
- For email, call `POST /v1/emails` with a tenant-owned service identity, recipients, subject, body, purpose, and correlation.
- Read `communication_id` from the canonical response. Consumers may temporarily accept a legacy `id` alias from other adapters, but this service does not emit it.
- Provide an HTTPS `callback_url` per request when callbacks must return to a specific HyperFlow environment. Otherwise the deployment-wide `HYPERFLOW_EVENT_URL` is used.

#### Ask delivery and resolution

There is no `POST /v1/asks` delivery route. Send an SMS or voice Ask through its real channel endpoint and include:

```json
{
  "purpose": {
    "type": "human_ask",
    "ask_id": "ask_123",
    "token": "optional-capability-token"
  },
  "correlation": {
    "tenant_id": "tenant_1",
    "external_project_id": "workflow_project_1",
    "run_id": "run_1",
    "task_id": "REVIEW_1",
    "person_id": "person_1"
  },
  "callback_url": "https://hyperflow.example.com/api/events"
}
```

HyperFlow must resolve `person_id` to an unambiguous channel destination before sending. Communications will not guess between multiple identities. Direct web-form delivery remains a HyperFlow responsibility; email delivery and generic reply classification are owned here when email is enabled.

An `ask.response.received` event is evidence, not resolution. For SMS, response text is in `payload.content`; for voice, evidence is in `payload.transcript`, and the event is emitted only after the call is verified as `human_completed`. Failed-call transcripts are audit-only and never become Ask response evidence. HyperFlow should validate/interpret eligible evidence, persist its own Ask decision, then call `POST /v1/asks/:askId/resolve` with the accepted `communication_id`. That final call should be retried durably so the two systems cannot silently diverge.

#### Event intake

- Verify `X-Communications-Signature` against the exact raw request bytes. `COMMUNICATIONS_WEBHOOK_SECRET` is required whenever durable event delivery is configured.
- Prefer `X-Communications-Signature-V2`, which signs `<X-Communications-Timestamp>.<raw-body>`; reject stale timestamps while retaining raw-body verification during migration.
- Reject events whose top-level `tenant_id` does not match the target workflow tenant.
- The envelope does not include a `source` field. A dedicated, signature-verified HyperFlow endpoint may normalize the source to `communications` after verification.
- Deduplicate by `event_id`; delivery is at least once.
- Use an explicit terminal mapping: `sms.delivered` and `call.completed` are success; `sms.failed` and `call.failed` are failure. `sms.sent`, `call.started`, `call.answered`, and transcript/summary events are nonterminal.
- Preserve all correlation values. Workflow actions should supply `tenant_id`, `external_project_id`, `run_id`, and `task_id` so a terminal event can identify exactly one pending run.
- During the transition, event envelopes also include `correlation.project_id` as an alias of `external_project_id`; new consumers should prefer the explicit field.

Contract tests should use these real request, response, and event shapes. A mock returning `{ "id": "comm_..." }`, accepting bearer authentication, or exposing `/v1/asks` does not test compatibility with this service.

### Event types

| Type | Emitted when |
|---|---|
| `communication.created` | Canonical communication is persisted |
| `communication.received` | Generic inbound canonical communication is recorded |
| `sms.sent` | Twilio accepts SMS or reports a nonterminal status |
| `sms.delivered` | Twilio reports delivered |
| `sms.failed` | Twilio reports failed or undelivered |
| `sms.received` | Inbound SMS is persisted |
| `call.started` | Call record starts or Twilio reports a nonterminal state |
| `call.answered` | Twilio reports answered |
| `call.completed` | Outcome finalizer verifies a meaningful response from the intended human; payload disposition is `human_completed` |
| `call.failed` | Outcome finalizer detects voicemail, wrong number, no answer, busy, fax, automated system, provider failure, cancellation, no meaningful response, or an unclassifiable call |
| `transcript.completed` | Voice transcript is stored |
| `summary.completed` | Voice summary is stored |
| `ask.response.received` | Inbound Ask SMS/generic communication is stored, or Ask voice transcript completes |
| `ask.resolved` | Hyperflow explicitly resolves the Ask with a final communication |

## Legacy direct delivery routes

These are preserved for compatibility. New integrations should use `/v1/messages` and `/v1/calls` to receive canonical IDs and semantic fields.

### Place a call

```http
POST /outbound-call
X-API-Key: …
Idempotency-Key: stable-operation-id
```

```json
{
  "to": "+61400000000",
  "from": "+61411111111",
  "overrides": {
    "voice": "cedar",
    "aiSpeaksFirst": true
  }
}
```

The legacy route requires configured database persistence and allow-lists override keys. Response:

```json
{ "callSid": "CA…", "communication_id": "comm_…", "to": "+61400000000", "from": "+61411111111", "status": "queued" }
```

### Send SMS

```http
POST /sms
X-API-Key: …
Idempotency-Key: stable-operation-id
```

```json
{
  "to": "+61400000000",
  "from": "+61411111111",
  "body": "Hello"
}
```

This route also requires configured database persistence. Response:

```json
{ "messageSid": "SM…", "communication_id": "comm_…", "to": "+61400000000", "from": "+61411111111", "status": "queued" }
```

## Email provider webhook

```http
POST /webhooks/email/:provider/:connectionId
```

Currently `provider` must be `resend`. This route does not accept API authentication or a request-supplied tenant. It loads the provider connection by opaque UUID, verifies the exact raw body using the connection's referenced Svix secret, and derives `tenant_id` from that trusted connection.

Verified deliveries are stored immutably in `webhook_receipts`, deduplicated by provider connection plus `svix-id`, and queued in `communication_jobs`. The route returns `200` immediately; normalization, body retrieval, safe HTML storage, attachment metadata, thread resolution, triage, canonical communication creation, and event emission happen asynchronously. A valid replay returns `200` with `duplicate: true` and never creates a second communication.

Inbound thread resolution is ordered: opaque reply route, provider/RFC reply headers, explicit Ask/thread, exactly one open tenant/person/mailbox thread, otherwise unassigned. Bounce, spam, mailing-list, and automatic-reply classifications are memory-ineligible and never emit `ask.response.received`.

When `EMAIL_ENABLED` is false the route returns `404`. Invalid signatures return a deliberately generic `400`.

## Twilio webhook routes

These routes accept both GET and POST where the implementation uses `all`.

| Route | Purpose | Response |
|---|---|---|
| `GET/POST /incoming-call` | Resolve inbound call config, record call, start preconnection/history/recording | TwiML with Media Stream |
| `GET/POST /outbound-answer` | Answer an outbound call and start the voice stream | TwiML with Media Stream |
| `GET/POST /incoming-sms` | Persist inbound message, correlate thread, queue events | Empty TwiML `<Response/>` |
| `GET/POST /message-status` | Update SMS provider status and queue status event | `204` |
| `GET/POST /call-status` | Update call state/duration and queue lifecycle event | `204` |
| `GET/POST /recording-status` | Queue completed Twilio recording or mark absent recording skipped | `204` |

### Media stream

```text
WS /media-stream
```

Twilio connects using `wss://`. This is the bidirectional audio bridge to the OpenAI Realtime API.

## Public/operator routes

### Root

```http
GET /
```

With `Accept: text/html`, returns the landing page. Other clients receive:

```json
{
  "message": "Communications Service is running!",
  "console": "/console",
  "api": "/v1"
}
```

### Console

```http
GET /console
```

Returns the same-origin operator call/SMS test console.

### Health

```http
GET /health
```

Example:

```json
{
  "status": "ok",
  "version": "089d3cb",
  "build": "12-character-source-fingerprint",
  "model": "gpt-realtime",
  "playIntro": false,
  "persistenceProvider": "postgres",
  "supabaseConfig": false,
  "postgresPersistence": true,
  "outboundCalls": true,
  "communicationsApi": true,
  "memoryEnrichment": true,
  "callOutcomeClassification": true,
  "answeringMachineDetection": true,
  "durableEvents": true,
  "email": { "enabled": false, "providerPipeline": true },
  "twilioSignatures": "enforce",
  "preconnect": { "enabled": true, "pending": 0 }
}
```

`persistenceProvider` is `supabase`, `postgres`, or `null`. `supabaseConfig` is retained for existing health consumers and `postgresPersistence` identifies the direct PostgreSQL adapter used by Replit Database. These fields report configured clients, not a live database query. `outboundCalls` specifically reflects API key, Twilio credentials, and `PUBLIC_URL`. `memoryEnrichment` and `callOutcomeClassification` do not prove migrations are applied. `email.enabled` reflects only `EMAIL_ENABLED`; `providerPipeline` reflects persistence, not provider-row or secret validity. `durableEvents` requires both `HYPERFLOW_EVENT_URL` and `COMMUNICATIONS_WEBHOOK_SECRET`; per-thread callbacks may still work when it reports `false`.

## Management and recording API (`/api`)

All routes require `X-API-Key`. Unless noted, they require configured database persistence. List endpoints use `limit` (default 50, maximum 200) and `offset`.

### Tools

| Method | Route | Result |
|---|---|---|
| `GET` | `/api/tools` | Tool registry plus availability; no database required |
| `GET` | `/api/tools/names` | Registered tool names; no database required |
| `GET` | `/api/tools/:name` | One tool or `404` with valid names; no database required |

### Contacts and history

Phone path parameters must be E.164.

| Method | Route | Query | Result |
|---|---|---|---|
| `GET` | `/api/contacts` | `limit`, `offset`, `search`, `tag` | Paged contacts with exact count |
| `GET` | `/api/contacts/:phone` | — | Contact, embedded config, derived inbound/outbound config |
| `GET` | `/api/contacts/:phone/config` | — | Config row or `config: null` |
| `GET` | `/api/contacts/:phone/tools` | — | Configured/effective tool names and audit |
| `GET` | `/api/contacts/:phone/messages` | `limit`, `offset` | Paged SMS joined through native thread |
| `GET` | `/api/contacts/:phone/history` | `channels`, `since`, `maxChars`, `limit` | Chronological turns, rendered text, exact prompt block, errors |

Readable history channels are currently `call`, `sms`, and `recording`; planned provider labels are reported separately by the endpoint.

### Phone lines

| Method | Route | Result |
|---|---|---|
| `GET` | `/api/lines` | Paged `phone_configs` |
| `GET` | `/api/lines/:phone` | Line, derived directional config, and `appliesToCalls` |
| `GET` | `/api/lines/:phone/tools` | Configured/effective tool audit |

### Calls

| Method | Route | Query | Result |
|---|---|---|---|
| `GET` | `/api/calls` | `limit`, `offset`, `phone`, `direction`, `status`, `business_status`, `disposition`, `successful`, `memory_eligible`, `sort` | Paged raw call rows including provider and verified business outcome; sort allows `started_at`, `ended_at`, `duration_seconds`, `status` |
| `GET` | `/api/calls/:callSid` | — | Provider call, flattened transcript, tool calls, recording summaries |
| `GET` | `/api/calls/:callSid/tools` | — | Tool-call audit rows |

These routes use Twilio Call SID, unlike canonical `/v1/calls/:communicationId`.

### Configuration preview

```http
GET /api/config/resolve?from=%2B61411111111&to=%2B61400000000&direction=outbound
```

At least one of `from` or `to` is required. `direction` defaults to `inbound`. This is read-only and does not create a contact. It returns the resolved call configuration, tool audit, and a note that resolver rows are cached for 60 seconds.

### Recordings

| Method | Route | Query | Result |
|---|---|---|---|
| `GET` | `/api/recordings` | `limit`, `offset`, `source`, `status`, `phone` | Paged recording summaries without full transcript JSON |
| `GET` | `/api/recordings/:id` | — | Full recording row |
| `POST` | `/api/recordings` | — | Queue external media or ingest an existing transcript |
| `POST` | `/api/recordings/:id/transcribe` | — | Reset attempts and requeue transcription |

Recording ingest example:

```json
{
  "source": "plaud",
  "externalId": "plaud_123",
  "contactPhone": "+61400000000",
  "mediaUrl": "https://public-media.example.com/recording.mp3",
  "useProviderAuth": true,
  "durationSeconds": 120,
  "recordedAt": "2026-08-11T06:00:00.000Z",
  "participants": [
    { "type": "email", "value": "jim@example.com" }
  ],
  "calendarEventId": "native-event-123",
  "projectId": "project UUID",
  "threadId": "thread_...",
  "title": "Smith Street valuation meeting",
  "meetingType": "meeting",
  "metadata": {}
}
```

Rules:

- `source` is required and `twilio` is rejected here;
- provide `mediaUrl` or a validated transcript;
- `mediaBase64` currently returns `501`;
- remote URLs and every redirect must be public HTTPS and pass DNS/SSRF checks;
- `useProviderAuth: true` selects fixed server-side `RECORDING_SOURCE_<SOURCE>_TOKEN`; callers cannot name environment variables;
- duplicate `(source, externalId)` returns `200 { "duplicate": true, … }`;
- new queue item returns `201` with `pending`, or `done` for a supplied transcript.
- exact participant identities resolve to contacts; unknown identities remain on the recording;
- calendar/project/thread/title/meeting type remain first-class through canonical projection;
- a supplied transcript skips retranscription and immediately becomes a searchable canonical recording communication;
- `source: "plaud"` requires `externalId` and uses this same queue. The repository does not assume undocumented Plaud network endpoints.

## Status and error conventions

| Status | Typical meaning |
|---:|---|
| `200` | Read or idempotent duplicate result |
| `201` | Communication, provider send/call, contact, or recording created |
| `204` | Twilio status callback accepted |
| `400` | Invalid field, channel, direction, phone, or relationship |
| `401` | Missing/wrong API key |
| `403` | Twilio signature rejected in enforce mode |
| `404` | Requested communication/contact/thread/recording/Ask binding not found |
| `409` | Idempotency conflict/in-progress operation, suppressed contact, or terminal Ask conflict |
| `422` | Invalid transcript or unsafe recording URL |
| `501` | Inline base64 recording not implemented |
| `502` | Provider, persistence, or management database operation failed |
| `503` | Required API key, persistence, or provider configuration absent |

Errors are JSON unless the endpoint is a Twilio webhook rejection:

```json
{ "error": "Human-readable message", "detail": "Optional provider/database detail" }
```

## Known contract limitations

- Billable creates require idempotency keys. A process failure in the narrow gap between provider acceptance and provider-ID persistence remains deliberately ambiguous and requires operator reconciliation; automatic retries are blocked rather than risking a duplicate charge.
- Canonical list endpoints do not yet expose cursor pagination.
- Generic communication responses currently omit stored `subject` and raw metadata.
- Memory enrichment is asynchronous and eventually consistent; raw communication search may lead derived facts/state.
- Native Plaud polling requires an injected authenticated adapter; external Plaud pushes are supported immediately.
- `/v1/calls` trusts authenticated `overrides`; the legacy call route has the stricter allow-list.

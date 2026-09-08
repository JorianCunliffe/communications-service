# Application boundaries and authority — Phase 01

Contract version: email authority 1.0. Application ownership is unchanged.

| Authoritative owner | Owns | Must not own |
|---|---|---|
| Communications Service | Canonical people/identities, communications and cross-channel threads, providers, mailbox credentials/drafts, transcripts, existing facts/promise extraction, memory/search/enrichment, delivery receipts | HyperFlow project permissions, accepted business obligations, workflow decisions, reports or publication workflows |
| HyperFlow | Organization membership/project scope, business intent and delegation, Asks and run transitions, schedules, operational obligations, business integration actions and product UI | Duplicate people/thread authority, provider transport clients or a second memory database |

Services exchange scoped REST requests and signed canonical events; neither reads or writes the other's database. Explicit thread/Ask bindings win over inferred similarity. A transport acknowledgement, extracted promise or successful phone outcome cannot itself constitute workflow approval or verified fulfillment.

## Email ceiling

Both backends accept the non-secret server setting `EMAIL_SEND_POLICY_BY_TENANT`, a JSON object keyed by exact tenant/organization ID. Values are `draft_only` or `allow_send`. Example for isolated fixtures:

```json
{"ceo":"draft_only","sender":"allow_send"}
```

Configure the real CEO ID as draft_only in **both** deployments before claiming end-to-end production enforcement. Never place this in browser settings, Project Data, a request body or a VITE variable. Do not copy the literal fixture ID into production.

HyperFlow defaults unlisted organizations to draft-only. An explicit server allow_send entry is only a ceiling; existing route authentication, tenant checks and action/review policy still apply. Communications preserves existing independent tenants' behavior when unlisted, with its existing email:send capability requirement. This compatibility difference is deliberate and pinned in `contracts/email-authority.v1.json`. A configured Communications restriction wins over wildcard/admin credentials. Malformed configuration fails closed with HTTP 503; configured denial uses 403.

HyperFlow checks its shared outgoing email client, covering direct send requests, workflow actions, Ask emails and agent/digest send fallback. Provider-native drafting is unchanged. Send-only paths are held as errors with actionable draft-only text; they are not silently converted into drafts or reported delivered. Existing mailbox draft paths remain available. Communications checks before send processing and again at the provider boundary.

The transport setting cannot replace HyperFlow's business approval. Conversely, HyperFlow cannot override a Communications ceiling. Both configurations must agree for the same tenant. Pending send requests must be reconciled before replay after policy changes.

## Authentication and scope

- HyperFlow derives organization membership from verified Firebase identity. Direct task execution requires a project in that organization; direct email dispatch verifies its project as well. Body-supplied tenant/approval/policy values confer no authority.
- Communications derives tenant scope from the authenticated client. Named clients require allowed_tenants and capabilities; legacy credentials remain single-tenant. Ordinary read/write requirements still apply.
- POST /v1/messages additionally requires sms:send. POST /v1/calls additionally requires voice:call. POST /v1/emails already requires email:send. Draft creation uses email:draft. Wildcard clients retain their channel capabilities, subject to the email ceiling.
- Before upgrading scoped clients, grant only the channels they are intended to use. A draft-only client should never receive wildcard merely to resolve an authorization error.
- communications:read is a tenant-wide service grant, not a project-limited end-user grant. HyperFlow must validate person/project access before selecting context; this phase does not introduce a new external memory UI. The P03 audit must verify bounded memory views before expanding them.
- Existing person-project grants, voice context guards, signed webhook verification and idempotency remain authoritative. SMS/voice capabilities permit channel access, not arbitrary financial or commercial decisions.

## Compatibility and release order

This phase branches from current GitHub main, preserving the newer Communications end_call change and HyperFlow acceptance documentation. Unpublished ranked-threading changes remain in their original checkout for Phase 02; the policy branch does not pretend to include them.

Deploy Communications support and configure the real tenant restriction first, then HyperFlow. Check config agreement and run non-delivery authorization probes. Test actual delivery only against controlled authorized targets. No schema migration or memory extraction is required.

API callers should handle 403 as a policy denial rather than retry indefinitely, and 503 as invalid/unavailable configuration. Existing accepted operations retain their receipts. Rollback must preserve a transport-side draft-only restriction; never restore an unrestricted sender simply to remove a UI error.


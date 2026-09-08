# Application boundaries and authority — Phase 01

Contract version: email authority 1.1. Memory remains in Communications Service.

| Authoritative owner | Responsibility |
|---|---|
| Communications Service | Canonical people/identities, cross-channel threads, providers, mailbox credentials/drafts, transcripts, existing memory/extraction/search/enrichment, delivery receipts and persisted account email authority |
| HyperFlow | Organization membership and project access, delegation and business approval, Asks, accepted operational commitments, workflow/run transitions, schedules, reporting and product UI |

Services exchange scoped REST requests and signed canonical events. Neither accesses the other's database. HyperFlow displays Communications context without creating a competing contact, thread or memory authority. Explicit thread/Ask bindings take precedence over inferred similarity. An extracted promise, delivery receipt or phone outcome is evidence; it does not itself approve a workflow or prove a business commitment fulfilled. Calendar context remains in Communications; booking decisions and business integration actions remain in HyperFlow.

## Account email authority

Every organization can select `draft_only` or `allow_send`. This is an organization/account setting, not a hard-coded CEO exception or an individual mailbox setting. Unconfigured accounts default to draft-only. HyperFlow Settings exposes the option; verified organization owners/admins may save it, members may read it. The CEO's first organization therefore starts draft-only without having to guess its ID.

Communications stores the selection in existing `tenants.metadata.email_send_policy`, with an opaque `email_policy_version`. No new service or schema migration is needed. HyperFlow accesses this through REST, not Firebase duplication. GET returns `{mode, configuredMode, version}`; POST accepts `{mode, version}`. Compare-and-swap against the previous metadata prevents lost updates; stale writes return 409 and require reload. Unrelated metadata is preserved.

The optional backend `EMAIL_SEND_POLICY_BY_TENANT` JSON map remains an operator override: exact tenant values are `draft_only` or `allow_send`. A draft-only restriction in either the saved setting or either backend wins. An explicit operator allow can initialize an account's authority but cannot broaden a saved draft-only setting. Unset maps default to `{}`; malformed configuration fails closed with 503. UI shows both selected and effective modes so an operator ceiling is visible.

HyperFlow reads the authoritative policy before outgoing email. Communications checks at the HTTP send handler and immediately before provider dispatch. Policy denial returns 403 with actionable draft-only text. Send-only actions/Ask deliveries fail explicitly; they do not claim delivery or silently become drafts. Existing mailbox draft paths remain available. Policy changes govern subsequent checks; they cannot recall a provider request already in flight.

`allow_send` grants no new project access or workflow approval. Existing recipient, purpose, capability, review and idempotency checks still apply. SMS and phone grants remain separate. The existing automatic reply policy also remains separate from this account email ceiling.

## Authentication and API

- HyperFlow GET/POST `/api/communications/email-policy` uses verified Firebase organization membership. Writes require owner/admin. Body-supplied organization IDs, approval and policy claims confer no additional authority.
- Communications GET/POST `/v1/tenant-policy/email` uses authenticated tenant scope. Reads require `communications:read`; writes require `communications:write` plus `tenant:policy:manage`. These are service-client grants; HyperFlow separately checks the human role. Legacy wildcard access remains single-tenant.
- POST `/v1/messages` additionally requires `sms:send`; POST `/v1/calls` additionally requires `voice:call`; POST `/v1/emails` requires `email:send`. Draft creation uses `email:draft`. Wildcard clients remain subject to saved email authority.
- Direct HyperFlow task and email requests verify the project belongs to the authenticated organization. Existing person/project grants and private voice-context guards remain in force. Tenant-wide `communications:read` is not a project-scoped end-user grant; the P03 context audit must close remaining read-surface gaps before expansion.
- Shared canonical event fixtures remain owned by Communications; HyperFlow consumes them. Keep shared fixtures semantically identical. Prefer additive fields; breaking changes require a versioned fixture and consumer verification in both repositories. The Phase 01 OpenAPI files supplement the existing full API references.

## Release and recovery

This branch starts from current remote main, preserving newer Communications `end_call` support and HyperFlow acceptance documentation. Unpublished ranked-threading/Register work remains in the original checkouts for Phase 02.

Deploy Communications first, then HyperFlow. Existing unconfigured sending accounts will become draft-only: inventory accounts and explicitly retain `allow_send` only where already authorized before rollout. Do not grant wildcard to bypass missing scoped capabilities. Confirm the intended client has policy-management permission before enabling the settings UI.

Missing policy storage/support fails closed. Handle 403 without automatic retry; 409 requires reload; 503 indicates configuration/storage/service availability. Keep Communications enforcement during HyperFlow rollback. Reconcile uncertain provider receipts before retrying an accepted operation. Local fixtures prove contracts and enforcement paths, not production configuration or provider delivery.

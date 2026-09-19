# Promise Ledger CRUD

Apply migration `029_promise_crud.sql` before deploying this API, then deploy the HyperFlow client. The regular `npm run db:migrate` runner includes it. No Firebase schema or rules changes are required. Existing review, query, coverage and extraction endpoints remain available.

All requests require the existing tenant-scoped API credential. Actor identity comes from the authenticated client; asserting `initiator_id` requires `threads:actor:assert`. HyperFlow derives tenant, accessible projects and initiator from authenticated membership. Source privacy and eligibility remain enforced.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/promises` | Create a manual promise |
| GET | `/v1/promises` | List; cursor `after`, project/person/thread filters |
| GET | `/v1/promises/:id` | Detail with evidence and history |
| PATCH | `/v1/promises/:id` | Edit current terms |
| DELETE | `/v1/promises/:id` | Tombstone; preserve evidence/history |
| GET/POST | `/v1/promises/:id/conditions` | Read/add conditions |
| PATCH/DELETE | `/v1/promises/:id/conditions/:conditionId` | Edit/remove condition |
| GET/POST | `/v1/promises/:id/evidence` | Read/attach evidence |
| GET | `/v1/promises/:id/history` | Read audit history |

Writes use `{ "reason": "...", "expected_revision": 3, "patch": {...} }`. Creation omits expected_revision. Delete needs reason and revision but no patch. Missing reason or invalid fields produce 400; inaccessible/missing records 404; stale revisions 409. Refresh and review before retrying a conflict. Do not blindly retry a create after an uncertain network outcome.

Creation example:

```json
{
  "reason": "Agreed during our meeting",
  "patch": {
    "description": "Send Dave the report",
    "external_project_id": "project-alpha",
    "promisor_parties": [{"label": "Jorian", "person_id": null}],
    "promisee_parties": [{"label": "Dave", "person_id": null}]
  }
}
```

Editable terms: `description`, `promisor_parties`, `promisee_parties`, `joint`, `due`, `external_project_id`, `project_id`, `thread_id`, `related_promise_id`. UUID relationships are tenant checked. Use null to clear optional associations, `{}` to clear due, `[]` to clear promisees. At least one promisor is required; joint promises require two. Unresolved parties require a label. Original quotes, provenance, status, source revision and actor cannot be set through generic PATCH. Due instants require an explicit timezone offset.

A condition has a generated UUID, description, status (`pending`, `satisfied`, `waived`), update actor and time. Create supplies description; update supplies description and/or status. A condition does **not** create a promise on the other party's behalf. Verification of fulfillment is blocked while any condition is pending.

Evidence POST supplies `patch.quote` (up to 10,000 characters), optionally `patch.communication_id`. Linked evidence requires an eligible, visible tenant communication and an exact quote in its current body. Without a communication, it records a human assertion. Evidence content is immutable; source invalidation may only change its active flag. Evidence attachment does not imply fulfillment. Use the existing `POST /:id/review` with `action: "verify_fulfillment"` and a reason for explicit human verification.

Every mutation runs atomically with the parent revision, append-only history and configured `promise.changed` outbox event. Existing shadow/backfill and destination/project event policies still apply. Manual promises have null communication provenance and `source_type: "manual"`; event consumers must support null communication IDs. Current terms own project/thread association, while immutable source snapshots retain original provenance and privacy checks.

Deleted promises disappear from normal detail/list/memory reads. `include_deleted=true` allows audit retrieval within the same access scope. Tombstones retain extraction evidence keys so replay of the same source evidence cannot restore the promise. Changed wording representing different evidence can still produce a new review candidate. There is no restore or hard-delete API; tenant lifecycle erasure remains the deletion mechanism for stored evidence/history.

Tests: `node --test test/promiseLedger.test.js`; full unit regression: `npm run test:unit`.

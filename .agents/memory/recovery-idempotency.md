---
name: Recovery idempotency
description: Why reviewed recovery must let a paused workflow retry its original operation safely, and why persisted hash bindings need canonical ordering.
---

A reviewed recovery must preserve the failed operation's immutable history while letting an unchanged retry of its original operation key resolve to a verified, scoped, completed successor receipt. Such replay must not apply another provider mutation.

**Why:** Paused HyperFlow runs retry stable operation keys. Requiring a permanently different operation identity after recovery leaves the existing run blocked and risks duplicate work.

**How to apply:** Check the original request hash first. Return historical results only from completed recovery receipts with matching source, scope, payload, version, and durable result linkage. An unchanged original retry may also reconcile one already-authorized uncertain successor after its leases expire: preserve its binding, read fresh provider evidence, and finalize atomically under the exact active claim. Never interpret uncertainty itself as success, and do not rewrite the original failure.

A refreshed post-write preview hash is not a new recovery authorization requirement for resuming an existing uncertain receipt.

**Why:** The stored review hash describes the pre-write draft that authorized that specific operation. Rebinding it to a post-write preview or requiring a new key would abandon the original operation and risk duplicate writes.

**How to apply:** Validate the existing successor's source, scope, request hash, payload, base revision and claim before reading the provider. Verify its effective requested fields against fresh complete provider evidence, and preserve its original review hash and key through normal finalization. An ambiguous link or changed substantive content stays blocked.

Hash persisted nested metadata using an explicitly reconstructed field order compatible with the original hash algorithm, not the property order returned from storage.

**Why:** PostgreSQL JSONB can reorder object keys. An in-memory receipt store preserves insertion order and can mask a production-only failure to recognize a legitimate recovery.

**How to apply:** Include a real JSONB round-trip in receipt replay regression tests. Preserve historical hash compatibility when canonicalizing metadata; do not silently change the hashing algorithm for existing operations.

Lease checks must handle valid native PostgreSQL `Date` objects as well as serialized ISO timestamp strings, while rejecting missing or invalid values.

**Why:** The native `pg` timestamp parser returns `Date` objects and the adapter preserves them. String-only expiry checks can classify an expired lease as active indefinitely; JSON-based fixtures hide that production-only difference.

**How to apply:** Test lease boundaries through the native PostgreSQL adapter and both timestamp representations, including future, expired, missing and invalid values. Do not change stored leases merely to work around a representation mismatch.
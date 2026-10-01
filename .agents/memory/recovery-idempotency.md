---
name: Recovery idempotency
description: Why reviewed recovery must let a paused workflow retry its original operation safely, and why persisted hash bindings need canonical ordering.
---

A reviewed recovery must preserve the failed operation's immutable history while letting an unchanged retry of its original operation key resolve to a verified, scoped, completed successor receipt. Such replay must not apply another provider mutation.

**Why:** Paused HyperFlow runs retry stable operation keys. Requiring a permanently different operation identity after recovery leaves the existing run blocked and risks duplicate work.

**How to apply:** Check the original request hash first. Resolve only completed recovery receipts with matching source, scope, payload, version, and durable result linkage. Never interpret an incomplete or unrelated recovery as success, and do not rewrite the original failure to make it appear successful.

Hash persisted nested metadata using an explicitly reconstructed field order compatible with the original hash algorithm, not the property order returned from storage.

**Why:** PostgreSQL JSONB can reorder object keys. An in-memory receipt store preserves insertion order and can mask a production-only failure to recognize a legitimate recovery.

**How to apply:** Include a real JSONB round-trip in receipt replay regression tests. Preserve historical hash compatibility when canonicalizing metadata; do not silently change the hashing algorithm for existing operations.
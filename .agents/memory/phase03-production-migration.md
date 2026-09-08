---
name: Phase 03 production migration
description: Safe publication constraint for the ranked-threading migrations.
---

For the Phase 03 ranked-threading release, do not accept Replit's generic schema plan if it proposes truncating `communication_identities`. Select **Skip database changes** during Publish and let the existing production start command run the repository migrations transactionally.

**Why:** The generic schema comparison sees the new non-null normalized identity field but not the migration's ordered backfill, so its worst-case plan truncates existing identities. The repository migration adds the nullable field, backfills every existing identity, and only then makes it non-null.

**How to apply:** Before publication, require a validated development backup and clean tests. During Publish, skip generic database changes. Verify the production start command applies the pending migrations, then confirm their checksums, retained identity rows, and API routes with read-only probes.
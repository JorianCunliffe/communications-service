---
name: Phase 03 production migration
description: Safe publication constraint for the ranked-threading migrations.
---

For the Phase 03 ranked-threading release, do not accept Replit's generic schema plan if it proposes truncating `communication_identities`. The current Publishing UI cannot skip database changes, so migration 021 must provide the safe default that makes the generated plan additive.

**Why:** Without a default, the generic schema comparison sees the new non-null normalized identity field but not migration 019's ordered backfill, so its worst-case plan truncates existing identities. Migration 021 exposes a harmless default to the publisher; migration 019 still backfills real values and installs the trigger.

**How to apply:** Before approval, require a validated backup, clean tests, and a generated plan with no truncations, removals, destructive SQL, or warnings. After publication, verify the runner records migrations 019-021, preserves identity rows and values, and activates the expected API routes.
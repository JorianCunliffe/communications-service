# Mailbox draft publication repair — 16 September 2026

Replit's generated development-to-production schema diff omitted the standalone
unique indexes required by migration 026's composite foreign keys. Production
remained on migrations 000–025 after the failed publish.

Migration 027 promotes those indexes to explicit table constraints, preserving
their names and the existing foreign keys. It leaves already-applied migration
026 unchanged. Local checks passed: 292 unit tests and 44 database tests,
including constraint visibility and idempotent replay.

The regenerated Replit plan then included both keys but put the existing-table
`mailbox_drafts_tenant_id_id_unique` constraint after its dependent foreign key.
To resolve this deployment ordering issue, that single additive constraint was
applied first in the production SQL console:

```sql
ALTER TABLE public.mailbox_drafts
  ADD CONSTRAINT mailbox_drafts_tenant_id_id_unique UNIQUE (tenant_id,id);
```

Catalog verification confirmed `UNIQUE (tenant_id, id)` and preserved all 39
existing draft rows. Production settings showed seven-day point-in-time
recovery enabled. The SQL console was returned to read-only mode afterward.
No data was truncated or deleted, and no migration-history rows were fabricated.

A subsequent regenerated publish diff confirmed both referenced unique keys
exist before their foreign keys, no removals or truncations, and no warnings.
The publisher still marks the additive rollout as potentially non-backward
compatible. Publication and startup migration completion must be verified
separately; the schema preview alone does not prove a successful deployment.

## Verified production outcome

Publication completed successfully. At 07:00:06 UTC, production recorded 026
and 027 with checksums matching the Replit workspace files. The server listened
on port 3000 at 07:00:13 UTC. Public `/health` returned HTTP 200, `status: ok`,
version `v2.8.2`, and build `87fc4c96a1ec`, matching the source fingerprint.

Read-only production verification confirmed both unique constraints, both
validated composite foreign keys, all five draft-update/lifecycle functions,
and all four expected lifecycle triggers. The draft count remained 39.

The separate HyperFlow scheduler HTTP 500 recurred at 07:00:15 UTC and remains
unresolved by this database publication repair. No live email or call tests
were performed.

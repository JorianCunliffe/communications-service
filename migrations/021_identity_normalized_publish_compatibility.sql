-- Keep Replit's generated development-to-production schema plan additive.
-- Migration 019 backfills normalized_value before making it non-null and its
-- trigger remains authoritative for every insert or value change. A harmless
-- default lets the publisher add the column without truncating existing rows;
-- the ordered migration runner then replaces the default for each real value.

begin;

alter table public.communication_identities
  alter column normalized_value set default '';

commit;
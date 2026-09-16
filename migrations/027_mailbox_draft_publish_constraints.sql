-- Expose the composite referenced keys as table constraints so Replit's
-- development-to-production schema diff preserves them with the foreign keys.
-- Keep migration 026 immutable and reuse its existing unique indexes.
begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mailbox_drafts'::regclass
      and conname = 'mailbox_drafts_tenant_id_id_unique'
      and contype = 'u'
  ) then
    alter table public.mailbox_drafts
      add constraint mailbox_drafts_tenant_id_id_unique
      unique using index mailbox_drafts_tenant_id_id_unique;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.mailbox_draft_update_receipts'::regclass
      and conname = 'mailbox_draft_update_receipts_tenant_id_id_unique'
      and contype = 'u'
  ) then
    alter table public.mailbox_draft_update_receipts
      add constraint mailbox_draft_update_receipts_tenant_id_id_unique
      unique using index mailbox_draft_update_receipts_tenant_id_id_unique;
  end if;
end $$;

commit;

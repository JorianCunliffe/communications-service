-- Expose the referenced composite key to Replit's schema publisher.
-- Preserve migration 028 and its existing index, including FK dependencies.
begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.communication_commitments'::regclass
      and conname = 'promise_tenant_id'
      and contype = 'u'
  ) then
    alter table public.communication_commitments
      add constraint promise_tenant_id unique using index promise_tenant_id;
  end if;
end $$;

commit;

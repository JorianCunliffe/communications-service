begin;
create table public.review_source_snapshots (
 id uuid not null unique default gen_random_uuid(),
 tenant_id text not null references tenants(tenant_id), owner_id text not null,
 project_id text not null, source text not null check(source in ('calendar','holds')),
 observed_at timestamptz not null, observation jsonb not null,
 primary key(tenant_id,owner_id,project_id,source)
);
insert into tenant_data_sets(name,exportable) values('review_source_snapshots',true);
create trigger tenant_data_write_guard before insert or update or delete on public.review_source_snapshots for each row execute function guard_tenant_data_write();
alter table public.review_source_snapshots enable row level security;
revoke all on public.review_source_snapshots from public;
create function public.store_review_sources(p_tenant_id text,p_owner_id text,p_snapshots jsonb)
returns jsonb language plpgsql as $$
declare s jsonb;
begin
 for s in select value from jsonb_array_elements(p_snapshots) loop
  insert into review_source_snapshots(tenant_id,owner_id,project_id,source,observed_at,observation)
  values(p_tenant_id,p_owner_id,s->>'project_id',s->>'source',(s->>'observed_at')::timestamptz,s)
  on conflict(tenant_id,owner_id,project_id,source) do update
  set observed_at=excluded.observed_at,observation=excluded.observation
  where review_source_snapshots.observed_at<excluded.observed_at;
 end loop;
 return jsonb_build_object('stored',true);
end $$;
revoke all on function public.store_review_sources(text,text,jsonb) from public;
do $$ declare r text; begin
 foreach r in array array['anon','authenticated'] loop
  if exists(select 1 from pg_roles where rolname=r) then
   execute format('revoke all on public.review_source_snapshots from %I',r);
   execute format('revoke all on function public.store_review_sources(text,text,jsonb) from %I',r);
  end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant all on public.review_source_snapshots to service_role;
  grant execute on function public.store_review_sources(text,text,jsonb) to service_role;
 end if;
end $$;
commit;

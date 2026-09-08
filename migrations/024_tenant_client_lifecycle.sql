-- Created with Supabase CLI; renamed for this application's ordered migration runner.
begin;
alter table public.api_clients add column if not exists managed_tenant_id text references public.tenants(tenant_id);
alter table public.api_clients add column if not exists revision integer not null default 1;
alter table public.api_clients add column if not exists expires_at timestamptz;
alter table public.api_clients add column if not exists request_hash text;
alter table public.api_clients add column if not exists rotation_hash text;
create index if not exists api_clients_managed_tenant_key on public.api_clients(managed_tenant_id,key_id);
create table if not exists public.tenant_admin_audit (
  tenant_id text not null references public.tenants(tenant_id),
  id uuid not null default gen_random_uuid(),
  actor text not null, operation text not null, resource_id text not null,
  revision integer not null, created_at timestamptz not null default now(),
  primary key(tenant_id,id)
);
create index if not exists tenant_admin_audit_time on public.tenant_admin_audit(tenant_id,created_at,id);
alter table public.tenant_admin_audit enable row level security;

create or replace function public.manage_tenant_api_client(
 p_tenant_id text,p_actor text,p_operation text,p_key_id text,p_expected_revision integer,p_client jsonb
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare c public.api_clients%rowtype;
begin
  -- Serialize creation and rotation of the same globally unique key without a delete/recreate gap.
  perform pg_advisory_xact_lock(hashtext('api_client:'||p_key_id));
  select * into c from public.api_clients where key_id=p_key_id for update;
  if p_operation='create' then
    if c.id is not null then
      if c.managed_tenant_id=p_tenant_id and c.request_hash=p_client->>'request_hash' then
        return to_jsonb(c)-'secret_hash'-'request_hash'-'rotation_hash';
      end if;
      raise exception 'Client identity conflict' using errcode='40001';
    end if;
    insert into public.api_clients(key_id,name,secret_hash,allowed_tenants,roles,capabilities,managed_tenant_id,expires_at,request_hash)
    values(p_key_id,p_client->>'name',p_client->>'secret_hash',array[p_tenant_id],
      array(select jsonb_array_elements_text(p_client->'roles')),
      array(select jsonb_array_elements_text(p_client->'capabilities')),p_tenant_id,
      (p_client->>'expires_at')::timestamptz,p_client->>'request_hash') returning * into c;
  else
    if c.id is null or c.managed_tenant_id is distinct from p_tenant_id then
      raise exception 'Managed client not found' using errcode='P0002';
    end if;
    if p_operation='revoke' and c.revoked_at is not null then return to_jsonb(c)-'secret_hash'-'request_hash'-'rotation_hash'; end if;
    if p_operation='rotate' and c.revoked_at is null and c.rotation_hash=p_client->>'rotation_hash' then return to_jsonb(c)-'secret_hash'-'request_hash'-'rotation_hash'; end if;
    if c.revision<>p_expected_revision then raise exception 'Client version changed' using errcode='40001'; end if;
    if p_operation='revoke' then
      update public.api_clients set revoked_at=now(),revision=revision+1 where id=c.id returning * into c;
    elsif p_operation='rotate' and c.revoked_at is null then
      update public.api_clients set secret_hash=p_client->>'secret_hash',expires_at=(p_client->>'expires_at')::timestamptz,
        rotation_hash=p_client->>'rotation_hash',
        revision=revision+1 where id=c.id returning * into c;
    else raise exception 'Client operation is unavailable' using errcode='40001'; end if;
  end if;
  insert into public.tenant_admin_audit(tenant_id,actor,operation,resource_id,revision)
    values(p_tenant_id,p_actor,'client.'||p_operation,p_key_id,c.revision);
  return to_jsonb(c)-'secret_hash'-'request_hash'-'rotation_hash';
end; $$;
revoke all on function public.manage_tenant_api_client(text,text,text,text,integer,jsonb) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on public.tenant_admin_audit from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on public.tenant_admin_audit from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select,insert on public.tenant_admin_audit to service_role';
    execute 'grant execute on function public.manage_tenant_api_client(text,text,text,text,integer,jsonb) to service_role';
  end if;
end $$;
create table if not exists public.tenant_api_budgets (
 tenant_id text primary key references public.tenants(tenant_id),daily_limit integer not null default 0 check(daily_limit between 0 and 1000000),revision integer not null default 1
);
create table if not exists public.tenant_api_usage (
 tenant_id text not null references public.tenants(tenant_id),day date not null,requests integer not null default 0,clients jsonb not null default '{}',primary key(tenant_id,day)
);
alter table public.tenant_api_budgets enable row level security;
alter table public.tenant_api_usage enable row level security;
create or replace function public.claim_tenant_api_request(p_tenant_id text,p_key_id text,p_revision integer)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare policy public.tenant_api_budgets%rowtype; total integer; utc_day date:=(now() at time zone 'UTC')::date;
begin
 if not exists(select 1 from public.api_clients where key_id=p_key_id and managed_tenant_id=p_tenant_id and revision=p_revision and revoked_at is null and expires_at>now()) then
   raise exception 'API credential changed' using errcode='28000';
 end if;
 insert into public.tenant_api_budgets(tenant_id) values(p_tenant_id) on conflict do nothing;
 select * into policy from public.tenant_api_budgets where tenant_id=p_tenant_id for update;
 select requests into total from public.tenant_api_usage where tenant_id=p_tenant_id and day=utc_day;
 if policy.daily_limit>0 and coalesce(total,0)>=policy.daily_limit then raise exception 'API request budget exhausted' using errcode='P0001'; end if;
 insert into public.tenant_api_usage(tenant_id,day,requests,clients) values(p_tenant_id,utc_day,1,jsonb_build_object(p_key_id,1))
 on conflict(tenant_id,day) do update set requests=tenant_api_usage.requests+1,
 clients=jsonb_set(tenant_api_usage.clients,array[p_key_id],to_jsonb(coalesce((tenant_api_usage.clients->>p_key_id)::integer,0)+1));
 return jsonb_build_object('day',utc_day,'requests',coalesce(total,0)+1,'daily_limit',policy.daily_limit);
end; $$;
create or replace function public.set_tenant_api_budget(p_tenant_id text,p_actor text,p_revision integer,p_daily_limit integer)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare policy public.tenant_api_budgets%rowtype;
begin
 insert into public.tenant_api_budgets(tenant_id) values(p_tenant_id) on conflict do nothing;
 select * into policy from public.tenant_api_budgets where tenant_id=p_tenant_id for update;
 if policy.revision<>p_revision then raise exception 'Budget version changed' using errcode='40001'; end if;
 update public.tenant_api_budgets set daily_limit=p_daily_limit,revision=revision+1 where tenant_id=p_tenant_id returning * into policy;
 insert into public.tenant_admin_audit(tenant_id,actor,operation,resource_id,revision) values(p_tenant_id,p_actor,'budget.update','api_budget',policy.revision);
 return to_jsonb(policy);
end; $$;
revoke all on function public.claim_tenant_api_request(text,text,integer),public.set_tenant_api_budget(text,text,integer,integer) from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on public.tenant_api_budgets,public.tenant_api_usage from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on public.tenant_api_budgets,public.tenant_api_usage from authenticated'; end if;
 if exists(select 1 from pg_roles where rolname='service_role') then
  execute 'grant select,insert,update on public.tenant_api_budgets,public.tenant_api_usage to service_role';
  execute 'grant execute on function public.claim_tenant_api_request(text,text,integer),public.set_tenant_api_budget(text,text,integer,integer) to service_role';
 end if;
end $$;
commit;

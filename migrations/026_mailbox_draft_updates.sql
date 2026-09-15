-- Durable, tenant-scoped in-place mailbox draft updates. This migration is
-- intentionally self-contained: claims, leases, finalization and stale
-- release all use the same schema and transaction boundaries.
begin;

alter table public.mailbox_drafts
  add column if not exists revision integer not null default 1,
  add column if not exists active_update_id uuid,
  add column if not exists active_update_lease_until timestamptz;

create unique index if not exists mailbox_drafts_tenant_id_id_unique
  on public.mailbox_drafts(tenant_id,id);

create table if not exists public.mailbox_draft_update_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  provider_connection_id uuid not null,
  mailbox_draft_id uuid not null,
  idempotency_key text not null,
  request_hash text not null,
  update_request jsonb not null default '{}',
  base_revision integer not null check(base_revision > 0),
  status text not null default 'reserved'
    check(status in('reserved','applying','updated','failed','uncertain')),
  lease_until timestamptz,
  result jsonb,
  last_error text,
  error_status integer,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider_connection_id,mailbox_draft_id,idempotency_key),
  foreign key(tenant_id,provider_connection_id)
    references public.provider_connections(tenant_id,id) on delete restrict,
  foreign key(tenant_id,mailbox_draft_id)
    references public.mailbox_drafts(tenant_id,id) on delete restrict
);

alter table public.mailbox_draft_update_receipts
  drop constraint if exists mailbox_draft_update_receipts_status_check;
alter table public.mailbox_draft_update_receipts
  add constraint mailbox_draft_update_receipts_status_check
  check(status in('reserved','applying','updated','failed','uncertain'));
alter table public.mailbox_draft_update_receipts
  add column if not exists update_request jsonb not null default '{}',
  add column if not exists lease_until timestamptz,
  add column if not exists error_code text;

create unique index if not exists mailbox_draft_update_receipts_tenant_id_id_unique
  on public.mailbox_draft_update_receipts(tenant_id,id);
alter table public.mailbox_drafts
  drop constraint if exists mailbox_drafts_active_update_fk;
alter table public.mailbox_drafts
  add constraint mailbox_drafts_active_update_fk
  foreign key(tenant_id,active_update_id)
  references public.mailbox_draft_update_receipts(tenant_id,id)
  on delete set null;
create index if not exists mailbox_draft_update_receipts_tenant_time
  on public.mailbox_draft_update_receipts(tenant_id,created_at desc);

alter table public.mailbox_draft_update_receipts enable row level security;
revoke all on public.mailbox_draft_update_receipts from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on public.mailbox_draft_update_receipts from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on public.mailbox_draft_update_receipts from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select, insert, update, delete on public.mailbox_draft_update_receipts to service_role';
  end if;
end $$;

insert into public.tenant_data_sets(name,exportable)
values ('mailbox_draft_update_receipts',true)
on conflict (name) do nothing;
drop trigger if exists zzzz_tenant_lifecycle on public.mailbox_draft_update_receipts;
create trigger zzzz_tenant_lifecycle
before insert or update or delete on public.mailbox_draft_update_receipts
for each row execute function public.guard_tenant_data_write();

-- Lifecycle operations must not suspend/erase while a provider outcome can
-- still be reconciled. The draft/receipt delete guards also cover erase_local,
-- whose FK-safe deletion pass would otherwise remove the evidence first.
create or replace function public.guard_mailbox_draft_update_lifecycle() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare tid text; draft_active uuid; receipt_active boolean;
begin
  tid:=case when TG_OP='DELETE' then old.tenant_id else new.tenant_id end;
  if TG_OP='DELETE' then
    if TG_TABLE_NAME='mailbox_drafts' then
      draft_active:=old.active_update_id;
      receipt_active:=exists(select 1 from public.mailbox_draft_update_receipts r
        where r.tenant_id=old.tenant_id and r.mailbox_draft_id=old.id
          and (r.status='uncertain' or (r.status='applying' and (r.lease_until is null or r.lease_until>now()))));
    else
      draft_active:=null;
      receipt_active:=old.status in('applying','uncertain');
    end if;
    if draft_active is not null or receipt_active then
      raise exception 'Reconcile active or uncertain draft update before lifecycle operation'
        using errcode='55000';
    end if;
  end if;
  return case when TG_OP='DELETE' then old else new end;
end $$;
drop trigger if exists zzzz_mailbox_draft_update_lifecycle on public.mailbox_drafts;
create trigger zzzz_mailbox_draft_update_lifecycle
before delete on public.mailbox_drafts
for each row execute function public.guard_mailbox_draft_update_lifecycle();
drop trigger if exists zzzz_mailbox_receipt_update_lifecycle on public.mailbox_draft_update_receipts;
create trigger zzzz_mailbox_receipt_update_lifecycle
before delete on public.mailbox_draft_update_receipts
for each row execute function public.guard_mailbox_draft_update_lifecycle();

create or replace function public.guard_mailbox_tenant_lifecycle() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.status in('suspended','closed') and old.status is distinct from new.status
     and (
       exists(select 1 from public.mailbox_drafts d where d.tenant_id=new.tenant_id and d.active_update_id is not null)
       or exists(select 1 from public.mailbox_draft_update_receipts r where r.tenant_id=new.tenant_id
         and (r.status='uncertain' or (r.status='applying' and (r.lease_until is null or r.lease_until>now()))))
     ) then
    raise exception 'Reconcile active or uncertain draft update before lifecycle operation'
      using errcode='55000';
  end if;
  return new;
end $$;
drop trigger if exists mailbox_tenant_lifecycle_draft_guard on public.tenants;
create trigger mailbox_tenant_lifecycle_draft_guard
before update on public.tenants
for each row execute function public.guard_mailbox_tenant_lifecycle();

create or replace function public.claim_mailbox_draft_update(
  p_tenant_id text, p_provider_connection_id uuid, p_mailbox_draft_id uuid,
  p_receipt_id uuid, p_expected_revision integer, p_lease_seconds integer default 90
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare claimed boolean;
begin
  update public.mailbox_drafts d
     set active_update_id=p_receipt_id,
         active_update_lease_until=now()+make_interval(secs=>greatest(90,least(p_lease_seconds,300))),
         updated_at=now()
   where d.tenant_id=p_tenant_id and d.provider_connection_id=p_provider_connection_id
     and d.id=p_mailbox_draft_id and d.revision=p_expected_revision
     and d.active_update_id is null
     and exists(select 1 from public.mailbox_draft_update_receipts r
       where r.tenant_id=p_tenant_id and r.provider_connection_id=p_provider_connection_id
         and r.mailbox_draft_id=p_mailbox_draft_id and r.id=p_receipt_id
         and r.status='reserved' and r.base_revision=p_expected_revision)
     and not exists(select 1 from public.mailbox_draft_update_receipts busy
       where busy.tenant_id=p_tenant_id and busy.mailbox_draft_id=p_mailbox_draft_id
         and busy.status in('applying','uncertain'));
  claimed:=found;
  if claimed then
    update public.mailbox_draft_update_receipts
       set status='applying',
           lease_until=(select active_update_lease_until from public.mailbox_drafts where id=p_mailbox_draft_id),
           updated_at=now()
     where tenant_id=p_tenant_id and id=p_receipt_id;
  end if;
  return claimed;
end $$;

create or replace function public.finalize_mailbox_draft_update(
  p_tenant_id text, p_provider_connection_id uuid, p_mailbox_draft_id uuid,
  p_receipt_id uuid, p_provider_draft_id text, p_provider_message_id text,
  p_provider_thread_id text, p_expected_revision integer, p_result jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare draft public.mailbox_drafts%rowtype; receipt_result jsonb;
begin
  select * into draft from public.mailbox_drafts
   where tenant_id=p_tenant_id and provider_connection_id=p_provider_connection_id
     and id=p_mailbox_draft_id and provider_draft_id=p_provider_draft_id
     and revision=p_expected_revision
     and (active_update_id=p_receipt_id or (active_update_id is null and exists(
       select 1 from public.mailbox_draft_update_receipts r where r.tenant_id=p_tenant_id
       and r.id=p_receipt_id and r.status='uncertain'))) for update;
  if not found then raise exception 'Mailbox draft revision or update claim changed' using errcode='40001'; end if;
  if not exists(select 1 from public.mailbox_draft_update_receipts where tenant_id=p_tenant_id
      and provider_connection_id=p_provider_connection_id and mailbox_draft_id=p_mailbox_draft_id
      and id=p_receipt_id and status in('applying','uncertain')) then
    raise exception 'Mailbox draft update receipt is not finalizable' using errcode='40001';
  end if;
  update public.mailbox_drafts set
    provider_draft_id=p_provider_draft_id,
    provider_message_id=coalesce(p_provider_message_id,provider_message_id),
    provider_thread_id=coalesce(p_provider_thread_id,provider_thread_id),
    revision=revision+1, active_update_id=null, active_update_lease_until=null,
    last_error=null, updated_at=now()
   where tenant_id=p_tenant_id and id=p_mailbox_draft_id returning * into draft;
  receipt_result:=jsonb_set(coalesce(p_result,'{}'::jsonb),'{revision}',to_jsonb(draft.revision),true);
  receipt_result:=jsonb_set(receipt_result,'{updated_at}',to_jsonb(draft.updated_at::text),true);
  update public.mailbox_draft_update_receipts set status='updated',result=receipt_result,
    lease_until=null,last_error=null,error_status=null,error_code=null,updated_at=now()
   where tenant_id=p_tenant_id and id=p_receipt_id;
  return receipt_result;
end $$;

create or replace function public.release_mailbox_draft_update(
  p_tenant_id text, p_provider_connection_id uuid, p_mailbox_draft_id uuid,
  p_receipt_id uuid, p_error text, p_error_status integer default 409,
  p_error_code text default 'DRAFT_RECONCILIATION_REQUIRED', p_force_stale boolean default false
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare released boolean;
begin
  if p_error_code='DRAFT_RECONCILIATION_REQUIRED' then
    raise exception 'Unproven provider outcomes require manual reconciliation'
      using errcode='55000';
  end if;
  if p_force_stale and p_error_status not in(400,401,403,404,409,422) then
    raise exception 'Only deterministic provider failures may release a draft claim'
      using errcode='55000';
  end if;
  if not p_force_stale and exists(select 1 from public.mailbox_drafts where tenant_id=p_tenant_id
      and id=p_mailbox_draft_id and active_update_id=p_receipt_id and active_update_lease_until>now()) then
    raise exception 'Draft update lease is still active' using errcode='55000';
  end if;
  update public.mailbox_drafts set active_update_id=null,active_update_lease_until=null,updated_at=now()
   where tenant_id=p_tenant_id and provider_connection_id=p_provider_connection_id
     and id=p_mailbox_draft_id and (active_update_id=p_receipt_id or active_update_id is null);
  get diagnostics released=row_count;
  update public.mailbox_draft_update_receipts set status='failed',last_error=left(p_error,500),
    error_status=p_error_status,error_code=p_error_code,lease_until=null,updated_at=now()
   where tenant_id=p_tenant_id and provider_connection_id=p_provider_connection_id
     and mailbox_draft_id=p_mailbox_draft_id and id=p_receipt_id
     and status in('reserved','applying','uncertain');
  return released;
end $$;

do $$
begin
  revoke execute on function public.claim_mailbox_draft_update(text,uuid,uuid,uuid,integer,integer) from public;
  revoke execute on function public.finalize_mailbox_draft_update(text,uuid,uuid,uuid,text,text,text,integer,jsonb) from public;
  revoke execute on function public.release_mailbox_draft_update(text,uuid,uuid,uuid,text,integer,text,boolean) from public;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function public.claim_mailbox_draft_update(text,uuid,uuid,uuid,integer,integer) to service_role;
    grant execute on function public.finalize_mailbox_draft_update(text,uuid,uuid,uuid,text,text,text,integer,jsonb) to service_role;
    grant execute on function public.release_mailbox_draft_update(text,uuid,uuid,uuid,text,integer,text,boolean) to service_role;
  end if;
end $$;

commit;
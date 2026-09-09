-- Tenant-owned lifecycle; no HyperFlow records or provider resources are erased here.
begin;
alter table public.tenants add column if not exists lifecycle_revision integer not null default 1;
create table public.tenant_data_sets(name text primary key,exportable boolean not null);
insert into public.tenant_data_sets values
('contacts',true),
('contact_config',false),
('phone_configs',false),
('calls',true),
('sms_threads',true),
('sms_messages',true),
('tool_calls',true),
('recordings',true),
('projects',true),
('project_contacts',true),
('communications',true),
('communication_identities',true),
('communication_threads',true),
('communication_thread_members',true),
('ask_bindings',false),
('outbound_operations',true),
('outbound_events',true),
('calendar_events',true),
('calendar_event_participants',true),
('communication_commitments',true),
('communication_facts',true),
('communication_enrichment_jobs',true),
('call_outcome_jobs',true),
('provider_connections',false),
('service_identities',true),
('webhook_receipts',false),
('communication_jobs',true),
('communication_attachments',true),
('email_messages',true),
('email_reply_routes',false),
('mailbox_oauth_credentials',false),
('mailbox_sync_state',true),
('mailbox_oauth_states',false),
('mailbox_drafts',true),
('mailbox_audit_events',true),
('communication_thread_participants',true),
('thread_resolution_decisions',true),
('thread_resolution_feedback',true),
('recording_revisions',true);
create table public.tenant_lifecycle_receipts(
 tenant_id text not null references public.tenants(tenant_id),request_id text not null,
 operation text not null,actor text not null,revision integer not null,
 receipt jsonb not null,created_at timestamptz not null default now(),
 primary key(tenant_id,request_id)
);
create index tenant_lifecycle_receipts_time on public.tenant_lifecycle_receipts(tenant_id,created_at desc);
alter table public.tenant_data_sets enable row level security;
alter table public.tenant_lifecycle_receipts enable row level security;

-- All ordinary writers, including background jobs and late callbacks, share the
-- tenant row lock. A closed/suspended tenant cannot be repopulated after erasure.
create or replace function public.guard_tenant_data_write() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare tid text; state text;
begin
 tid:=case when TG_OP='DELETE' then old.tenant_id else new.tenant_id end;
 if current_setting('app.tenant_lifecycle_write',true)=tid then
   if TG_OP='DELETE' then return old; else return new; end if;
 end if;
 select status into state from public.tenants where tenant_id=tid for share;
 if state is distinct from 'active' then raise exception 'Tenant data is unavailable' using errcode='55000'; end if;
 if TG_OP='UPDATE' and new.tenant_id is distinct from old.tenant_id then raise exception 'Tenant ownership is immutable' using errcode='42501'; end if;
 if TG_OP='DELETE' then return old; else return new; end if;
end $$;
do $$ declare item record; begin
 for item in select name from public.tenant_data_sets loop
  execute format('create trigger zzzz_tenant_lifecycle before insert or update or delete on public.%I for each row execute function public.guard_tenant_data_write()',item.name);
 end loop;
end $$;

create or replace function public.tenant_data_lifecycle(p_tenant_id text,p_actor text,p_request_id text,p_operation text,p_revision integer)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare tenant public.tenants%rowtype; previous public.tenant_lifecycle_receipts%rowtype;
 item record; n bigint; counts jsonb:='{}'; result jsonb; remaining integer; progressed boolean; pass integer;
begin
 select * into tenant from public.tenants where tenant_id=p_tenant_id for update;
 if not found then raise exception 'Tenant not found' using errcode='P0002'; end if;
 select * into previous from public.tenant_lifecycle_receipts where tenant_id=p_tenant_id and request_id=p_request_id;
 if found then
  if previous.operation<>p_operation or previous.actor<>p_actor then raise exception 'Request identity conflict' using errcode='40001'; end if;
  return previous.receipt;
 end if;
 if tenant.lifecycle_revision<>p_revision then raise exception 'Tenant version changed' using errcode='40001'; end if;
 if p_operation not in ('suspend','resume','erase_local') then raise exception 'Unknown lifecycle operation' using errcode='22023'; end if;
 if tenant.status='closed' then raise exception 'An erased tenant cannot be reactivated' using errcode='55000'; end if;
 if p_operation='suspend' then
  if exists(select 1 from public.outbound_operations where tenant_id=p_tenant_id and status='reserved')
    or exists(select 1 from public.calls where tenant_id=p_tenant_id and status in('queued','ringing','in-progress','initiated'))
    or exists(select 1 from public.mailbox_sync_state where tenant_id=p_tenant_id and status='syncing')
    or exists(select 1 from public.mailbox_drafts where tenant_id=p_tenant_id and status='creating') then
    raise exception 'Reconcile active or uncertain provider operations before suspension' using errcode='55000';
  end if;
  for item in select name from public.tenant_data_sets where name in('outbound_events','communication_enrichment_jobs','call_outcome_jobs','communication_jobs','recordings') loop
   execute format('select count(*) from public.%I where tenant_id=$1 and lease_expires_at>now()',item.name) into n using p_tenant_id;
   if n>0 then raise exception 'Wait for active worker leases before suspension' using errcode='55000'; end if;
  end loop;
  update public.tenants set status='suspended',lifecycle_revision=lifecycle_revision+1,updated_at=now() where tenant_id=p_tenant_id;
 elsif p_operation='resume' then
  update public.tenants set status='active',lifecycle_revision=lifecycle_revision+1,updated_at=now() where tenant_id=p_tenant_id;
 else
  if tenant.status<>'suspended' then raise exception 'Suspend and review the export before erasure' using errcode='55000'; end if;
  perform set_config('app.tenant_lifecycle_write',p_tenant_id,true);
  for item in select name from public.tenant_data_sets loop
   execute format('select count(*) from public.%I where tenant_id=$1',item.name) into n using p_tenant_id;
   counts:=counts||jsonb_build_object(item.name,n);
  end loop;
  -- FK-safe passes. A constrained table is retried after its children; any
  -- unresolved cycle aborts the entire transaction without partial erasure.
  for pass in 1..60 loop
   remaining:=0;progressed:=false;
   for item in select name from public.tenant_data_sets order by name loop
    begin
     execute format('delete from public.%I where tenant_id=$1',item.name) using p_tenant_id;
     get diagnostics n=row_count; if n>0 then progressed:=true; end if;
    exception when foreign_key_violation then remaining:=remaining+1;
    end;
   end loop;
   exit when remaining=0;
   if not progressed then raise exception 'Tenant foreign-key dependencies require operator review' using errcode='55000'; end if;
  end loop;
  if remaining>0 then raise exception 'Tenant erasure did not converge' using errcode='55000'; end if;
  for item in select name from public.tenant_data_sets loop
   execute format('select count(*) from public.%I where tenant_id=$1',item.name) into n using p_tenant_id;
   if n<>0 then raise exception 'Tenant erasure left residual business records' using errcode='55000'; end if;
  end loop;
  delete from public.api_clients where managed_tenant_id=p_tenant_id;
  update public.tenants set status='closed',name=null,metadata='{}',lifecycle_revision=lifecycle_revision+1,updated_at=now() where tenant_id=p_tenant_id;
  perform set_config('app.tenant_lifecycle_write','',true);
 end if;
 select * into tenant from public.tenants where tenant_id=p_tenant_id;
 result:=jsonb_build_object('owner','communications-service','requestId',p_request_id,'operation',p_operation,'status',tenant.status,'revision',tenant.lifecycle_revision,'deletedRows',counts,'externalCleanup','not-performed','hyperflowCleanup','not-performed','retained','tenant tombstone, usage and administration/lifecycle receipts');
 insert into public.tenant_lifecycle_receipts(tenant_id,request_id,operation,actor,revision,receipt) values(p_tenant_id,p_request_id,p_operation,p_actor,tenant.lifecycle_revision,result);
 return result;
end $$;

create or replace function public.export_tenant_data_page(p_tenant_id text,p_revision integer,p_dataset text,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare tenant public.tenants%rowtype; rows jsonb; total bigint;
begin
 select * into tenant from public.tenants where tenant_id=p_tenant_id for share;
 if tenant.status is distinct from 'suspended' or tenant.lifecycle_revision<>p_revision then raise exception 'Current suspended tenant revision required' using errcode='40001'; end if;
 if not exists(select 1 from public.tenant_data_sets where name=p_dataset and exportable) then raise exception 'Dataset unavailable for export' using errcode='42501'; end if;
 if p_offset<0 or p_offset>10000000 then raise exception 'Invalid export offset' using errcode='22023'; end if;
 execute format('select coalesce(jsonb_agg(row),''[]'') from (select to_jsonb(t) row from public.%I t where tenant_id=$1 order by to_jsonb(t)::text offset $2 limit 50) x',p_dataset) into rows using p_tenant_id,p_offset;
 if octet_length(rows::text)>3500000 then raise exception 'Export page requires operator file export' using errcode='54000'; end if;
 execute format('select count(*) from public.%I where tenant_id=$1',p_dataset) into total using p_tenant_id;
 return jsonb_build_object('owner','communications-service','dataset',p_dataset,'revision',p_revision,'offset',p_offset,'rows',rows,'nextOffset',case when p_offset+50<total then p_offset+50 else null end,'total',total);
end $$;
revoke all on public.tenant_data_sets,public.tenant_lifecycle_receipts from public;
revoke execute on function public.tenant_data_lifecycle(text,text,text,text,integer),public.export_tenant_data_page(text,integer,text,integer),public.guard_tenant_data_write() from public;
do $$ declare item record; begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on public.tenant_data_sets,public.tenant_lifecycle_receipts from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on public.tenant_data_sets,public.tenant_lifecycle_receipts from authenticated; end if;
 if exists(select 1 from pg_roles where rolname='service_role') then
  -- Some hosts do not install Supabase's broad default table grants. Grant only
  -- the server role the table operations used by the security-invoker lifecycle.
  for item in select name from public.tenant_data_sets loop
   execute format('grant select,delete on public.%I to service_role',item.name);
  end loop;
  grant select,update on public.tenants to service_role;
  grant select,delete on public.api_clients to service_role;
  grant select on public.tenant_data_sets to service_role;
  grant select,insert on public.tenant_lifecycle_receipts to service_role;
  grant execute on function public.tenant_data_lifecycle(text,text,text,text,integer),public.export_tenant_data_page(text,integer,text,integer),public.guard_tenant_data_write() to service_role;
 end if;
end $$;

create or replace function public.claim_outbound_events(p_limit int default 20,p_lease_seconds int default 60)
returns setof public.outbound_events language plpgsql as $$
begin
  return query with candidates as (
    select event_id from public.outbound_events where tenant_id in (select tenant_id from public.tenants where status='active') and (status in('pending','retrying') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<now()))  order by created_at for update skip locked limit p_limit
  ) update public.outbound_events e set lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
    from candidates c where e.event_id=c.event_id returning e.*;
end $$;

create or replace function public.claim_enrichment_job(p_lease_seconds int default 900)
returns setof public.communication_enrichment_jobs language plpgsql as $$
begin
  return query with candidate as (
    select id from public.communication_enrichment_jobs where tenant_id in (select tenant_id from public.tenants where status='active') and (status in('pending','processing') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<now()))  order by next_attempt_at for update skip locked limit 1
  ) update public.communication_enrichment_jobs j set status='processing',claimed_at=now(),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds),rerun_requested=false,updated_at=now()
    from candidate c where j.id=c.id returning j.*;
end $$;

create or replace function public.claim_recording(p_lease_seconds int default 900)
returns setof public.recordings language plpgsql as $$
begin
  return query with candidate as (
    select id from public.recordings where tenant_id in (select tenant_id from public.tenants where status='active') and (status in('pending','transcribing') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<now()))  order by next_attempt_at for update skip locked limit 1
  ) update public.recordings r set status='transcribing',claimed_at=now(),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
    from candidate c where r.id=c.id returning r.*;
end $$;

create or replace function public.claim_call_outcome_job(p_lease_seconds int default 120)
returns setof public.call_outcome_jobs language plpgsql as $$
begin
  return query with candidate as (
    select id from public.call_outcome_jobs
     where tenant_id in (select tenant_id from public.tenants where status='active') and (status in ('pending','processing') and next_attempt_at<=now()
       and (lease_expires_at is null or lease_expires_at<now()))  order by next_attempt_at for update skip locked limit 1
  ) update public.call_outcome_jobs j set
      status='processing',claimed_at=now(),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      rerun_requested=false,updated_at=now()
    from candidate c where j.id=c.id returning j.*;
end $$;

create or replace function public.claim_communication_jobs(p_limit int default 20,p_lease_seconds int default 60)
returns setof public.communication_jobs language plpgsql as $$
begin
  return query
  with candidates as (
    select id from public.communication_jobs
     where tenant_id in (select tenant_id from public.tenants where status='active') and ((status='pending' and next_attempt_at<=now()) or (status='processing' and lease_expires_at<now()))  order by next_attempt_at,created_at for update skip locked limit greatest(1,least(p_limit,100))
  )
  update public.communication_jobs j set status='processing',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,10)),updated_at=now()
  from candidates c where j.id=c.id returning j.*;
end $$;

commit;

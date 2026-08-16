-- Security, idempotency, lifecycle and worker-safety rectification.
-- Additive and safe to run repeatedly after 001-006.

begin;

-- Keep the public comm_* ID distinct from the internal UUID row ID.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='communication_thread_members' and column_name='communication_id')
     and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='communication_thread_members' and column_name='communication_row_id') then
    alter table public.communication_thread_members rename column communication_id to communication_row_id;
  end if;
end $$;
alter table public.communication_thread_members add column if not exists communication_id text;
update public.communication_thread_members m set communication_id=c.communication_id
from public.communications c where c.id=m.communication_row_id and m.communication_id is null;
create index if not exists communication_thread_members_public_id on public.communication_thread_members(communication_id);

-- Provider retries project onto one canonical communication.
with duplicates as (
  select id,provider_id,row_number() over(partition by provider,provider_id order by occurred_at desc,id desc) as position
  from public.communications where provider is not null and provider_id is not null
)
update public.communications c set metadata=coalesce(c.metadata,'{}')||jsonb_build_object('duplicate_provider_id',d.provider_id),provider_id=null
from duplicates d where c.id=d.id and d.position>1;
create unique index if not exists communications_provider_identity_unique
  on public.communications(provider, provider_id) where provider is not null and provider_id is not null;

-- Creating a phone contact also creates its identity in the same transaction.
create or replace function public.sync_contact_phone_identity()
returns trigger language plpgsql as $$
begin
  if new.phone_number is not null and new.phone_number <> '' then
    insert into public.communication_identities(person_id,type,value,provider)
    values(new.id,'phone',new.phone_number,'twilio')
    on conflict(type,value,provider) do update set person_id=excluded.person_id,updated_at=now();
  end if;
  return new;
end $$;
drop trigger if exists contacts_sync_phone_identity on public.contacts;
create trigger contacts_sync_phone_identity after insert or update of phone_number on public.contacts
for each row execute function public.sync_contact_phone_identity();

create or replace function public.ensure_communication_contact(p_phone_number text)
returns uuid language plpgsql as $$
declare person_id uuid;
begin
  insert into public.contacts(phone_number) values(p_phone_number)
  on conflict(phone_number) do update set phone_number=excluded.phone_number
  returning id into person_id;
  return person_id;
end $$;

create or replace function public.create_communication_contact(p_name text,p_phone_number text,p_identities jsonb default '[]')
returns jsonb language plpgsql as $$
declare person public.contacts%rowtype; identity jsonb;
begin
  insert into public.contacts(name,phone_number) values(p_name,p_phone_number) returning * into person;
  for identity in select * from jsonb_array_elements(coalesce(p_identities,'[]')) loop
    insert into public.communication_identities(person_id,type,value,provider,metadata)
    values(person.id,identity->>'type',identity->>'value',nullif(identity->>'provider',''),coalesce(identity->'metadata','{}'))
    on conflict(type,value,provider) do update set person_id=excluded.person_id,metadata=excluded.metadata,updated_at=now();
  end loop;
  return to_jsonb(person);
end $$;

-- Billable provider actions are reserved before the provider is called.
create table if not exists public.outbound_operations(
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  operation_type text not null check(operation_type in('sms','voice')),
  request_hash text not null,
  communication_id text not null,
  status text not null default 'reserved' check(status in('reserved','provider_sent','completed','failed')),
  provider_id text,
  provider_status text,
  audit_context jsonb not null default '{}',
  response jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz,
  unique(operation_type,idempotency_key)
);
alter table public.outbound_operations enable row level security;
alter table public.outbound_operations add column if not exists audit_context jsonb not null default '{}';
drop function if exists public.reserve_outbound_operation(text,text,text,text);
create or replace function public.reserve_outbound_operation(p_idempotency_key text,p_operation_type text,p_request_hash text,p_communication_id text,p_audit_context jsonb default '{}')
returns jsonb language plpgsql as $$
declare operation public.outbound_operations%rowtype;
begin
  insert into public.outbound_operations(idempotency_key,operation_type,request_hash,communication_id,audit_context)
  values(p_idempotency_key,p_operation_type,p_request_hash,p_communication_id,coalesce(p_audit_context,'{}'))
  on conflict(operation_type,idempotency_key) do nothing returning * into operation;
  if found then return to_jsonb(operation)||jsonb_build_object('claimed',true); end if;
  select * into operation from public.outbound_operations
    where operation_type=p_operation_type and idempotency_key=p_idempotency_key for update;
  if operation.request_hash <> p_request_hash then return jsonb_build_object('conflict',true); end if;
  return to_jsonb(operation)||jsonb_build_object('claimed',false);
end $$;

-- Terminal Asks are immutable and identical resolution retries succeed.
create or replace function public.resolve_communication_ask(p_ask_id text,p_communication_id text)
returns jsonb language plpgsql as $$
declare binding public.ask_bindings%rowtype; communication public.communications%rowtype; resolved_time timestamptz:=now();
begin
  select * into binding from public.ask_bindings where ask_id=p_ask_id for update;
  if not found then raise exception 'Ask % is not bound to a communication thread',p_ask_id; end if;
  if binding.status='resolved' then
    if binding.resolved_by=p_communication_id then
      return jsonb_build_object('ask_id',p_ask_id,'status','resolved','communication_id',binding.resolved_by,'thread_id',binding.thread_id,'resolved_at',binding.resolved_at,'duplicate',true);
    end if;
    raise exception 'Ask % was resolved by a different communication',p_ask_id;
  end if;
  if binding.status<>'open' then raise exception 'Ask % is %',p_ask_id,binding.status; end if;
  select * into communication from public.communications where communication_id=p_communication_id;
  if not found or communication.thread_id is distinct from binding.thread_id then raise exception 'Communication % is not in Ask % thread',p_communication_id,p_ask_id; end if;
  update public.communications set resolution=jsonb_build_object('type','ask_resolved','ask_id',p_ask_id,'resolved_at',resolved_time),updated_at=resolved_time where communication_id=p_communication_id;
  update public.ask_bindings set status='resolved',resolved_by=p_communication_id,resolved_at=resolved_time,updated_at=resolved_time where ask_id=p_ask_id;
  update public.communication_threads set status='resolved',resolved_at=resolved_time,last_activity_at=greatest(last_activity_at,resolved_time) where thread_id=binding.thread_id;
  return jsonb_build_object('ask_id',p_ask_id,'status','resolved','communication_id',p_communication_id,'thread_id',binding.thread_id,'resolved_at',resolved_time);
end $$;

create or replace function public.link_communication_thread()
returns trigger language plpgsql as $$
declare binding_status text; thread_status text; already_member boolean;
begin
  if new.thread_id is null then return new; end if;
  select status into thread_status from public.communication_threads where thread_id=new.thread_id for update;
  select exists(select 1 from public.communication_thread_members where thread_id=new.thread_id and communication_row_id=new.id) into already_member;
  if thread_status<>'open' and not already_member then raise exception 'Thread % is terminal and cannot accept a new communication',new.thread_id; end if;
  insert into public.communication_thread_members(thread_id,communication_row_id,communication_id,confidence,link_type)
  values(new.thread_id,new.id,new.communication_id,case when new.thread_link_type='inferred' then 0.8 else 1 end,coalesce(new.thread_link_type,'explicit'))
  on conflict(thread_id,communication_row_id) do update set communication_id=excluded.communication_id,confidence=excluded.confidence,link_type=excluded.link_type;
  update public.communication_threads set last_activity_at=greatest(last_activity_at,new.occurred_at),purpose=coalesce(new.purpose,purpose),correlation=correlation||coalesce(new.correlation,'{}') where thread_id=new.thread_id;
  if new.purpose->>'type'='human_ask' then
    select status into binding_status from public.ask_bindings where ask_id=new.purpose->>'ask_id' for update;
    if binding_status is not null and binding_status<>'open' then
      if not already_member then raise exception 'Ask % is terminal and cannot be rebound',new.purpose->>'ask_id'; end if;
    else
      insert into public.ask_bindings(ask_id,thread_id,tenant_id,purpose) values(new.purpose->>'ask_id',new.thread_id,new.correlation->>'tenant_id',new.purpose)
      on conflict(ask_id) do update set thread_id=excluded.thread_id,purpose=excluded.purpose,tenant_id=coalesce(excluded.tenant_id,public.ask_bindings.tenant_id),updated_at=now()
      where public.ask_bindings.status='open';
    end if;
  end if;
  return new;
end $$;

-- Calendar event and participant snapshot commit atomically; participants
-- absent from a later provider snapshot are removed.
create or replace function public.ingest_calendar_event(p_event jsonb)
returns jsonb language plpgsql as $$
declare stored public.calendar_events%rowtype; participant jsonb; participant_rows jsonb:='[]'; person uuid; organiser_person uuid; organiser jsonb:=p_event->'organiser'; inserted public.calendar_event_participants%rowtype;
begin
  if nullif(p_event->>'organiserContactId','') is not null then organiser_person:=(p_event->>'organiserContactId')::uuid;
  elsif organiser is not null then
    if nullif(coalesce(organiser->>'contactId',organiser->>'contact_id'),'') is not null then organiser_person:=coalesce(organiser->>'contactId',organiser->>'contact_id')::uuid;
    else select min(person_id) into organiser_person from public.communication_identities
      where type=lower(coalesce(organiser->>'identityType',organiser->>'identity_type',organiser->>'type'))
        and value=coalesce(organiser->>'identityValue',organiser->>'identity_value',organiser->>'value',organiser->>'email',organiser->>'phone')
      having count(distinct person_id)=1;
    end if;
  end if;
  insert into public.calendar_events(provider,provider_id,title,description,starts_at,ends_at,location,organiser_contact_id,project_id,communication_thread_id,metadata,updated_at)
  values(p_event->>'provider',p_event->>'providerId',p_event->>'title',p_event->>'description',(p_event->>'startsAt')::timestamptz,
    nullif(p_event->>'endsAt','')::timestamptz,p_event->>'location',organiser_person,nullif(p_event->>'projectId','')::uuid,p_event->>'threadId',coalesce(p_event->'metadata','{}'),now())
  on conflict(provider,provider_id) do update set title=excluded.title,description=excluded.description,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
    location=excluded.location,organiser_contact_id=excluded.organiser_contact_id,project_id=excluded.project_id,communication_thread_id=excluded.communication_thread_id,metadata=excluded.metadata,updated_at=now()
  returning * into stored;
  delete from public.calendar_event_participants where event_id=stored.id;
  for participant in
    select value from jsonb_array_elements(coalesce(p_event->'participants','[]'))
    union all select p_event->'organiser' where p_event->'organiser' is not null
  loop
    person:=null;
    if nullif(coalesce(participant->>'contactId',participant->>'contact_id'),'') is not null then
      person:=coalesce(participant->>'contactId',participant->>'contact_id')::uuid;
    else
      select min(person_id) into person from public.communication_identities
       where type=lower(coalesce(participant->>'identityType',participant->>'identity_type',participant->>'type'))
         and value=coalesce(participant->>'identityValue',participant->>'identity_value',participant->>'value',participant->>'email',participant->>'phone')
       having count(distinct person_id)=1;
    end if;
    if person is null and nullif(coalesce(participant->>'identityValue',participant->>'identity_value',participant->>'value',participant->>'email',participant->>'phone'),'') is null then
      raise exception 'Every calendar participant needs contact_id or an identity value';
    end if;
    inserted:=null;
    insert into public.calendar_event_participants(event_id,contact_id,identity_type,identity_value,response_status,metadata)
    values(stored.id,person,lower(coalesce(participant->>'identityType',participant->>'identity_type',participant->>'type')),
      coalesce(participant->>'identityValue',participant->>'identity_value',participant->>'value',participant->>'email',participant->>'phone'),
      coalesce(participant->>'responseStatus',participant->>'response_status'),coalesce(participant->'metadata','{}'))
    on conflict do nothing
    returning * into inserted;
    if inserted.id is not null then participant_rows:=participant_rows||jsonb_build_array(to_jsonb(inserted)); end if;
  end loop;
  return jsonb_build_object('event',to_jsonb(stored),'participants',participant_rows);
end $$;

-- Leases make queue claims safe across multiple service instances.
alter table public.outbound_events add column if not exists lease_token uuid;
alter table public.outbound_events add column if not exists lease_expires_at timestamptz;
alter table public.communication_enrichment_jobs add column if not exists lease_token uuid;
alter table public.communication_enrichment_jobs add column if not exists lease_expires_at timestamptz;
alter table public.recordings add column if not exists lease_token uuid;
alter table public.recordings add column if not exists lease_expires_at timestamptz;

create or replace function public.claim_outbound_events(p_limit int default 20,p_lease_seconds int default 60)
returns setof public.outbound_events language plpgsql as $$
begin
  return query with candidates as (
    select event_id from public.outbound_events where status in('pending','retrying') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<now()) order by created_at for update skip locked limit p_limit
  ) update public.outbound_events e set lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
    from candidates c where e.event_id=c.event_id returning e.*;
end $$;

create or replace function public.claim_enrichment_job(p_lease_seconds int default 900)
returns setof public.communication_enrichment_jobs language plpgsql as $$
begin
  return query with candidate as (
    select id from public.communication_enrichment_jobs where status in('pending','processing') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<now()) order by next_attempt_at for update skip locked limit 1
  ) update public.communication_enrichment_jobs j set status='processing',claimed_at=now(),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds),rerun_requested=false,updated_at=now()
    from candidate c where j.id=c.id returning j.*;
end $$;

create or replace function public.claim_recording(p_lease_seconds int default 900)
returns setof public.recordings language plpgsql as $$
begin
  return query with candidate as (
    select id from public.recordings where status in('pending','transcribing') and next_attempt_at<=now()
      and (lease_expires_at is null or lease_expires_at<now()) order by next_attempt_at for update skip locked limit 1
  ) update public.recordings r set status='transcribing',claimed_at=now(),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
    from candidate c where r.id=c.id returning r.*;
end $$;

-- Coalesce enrichment to the latest state of each thread.
alter table public.communication_enrichment_jobs add column if not exists scope_key text;
update public.communication_enrichment_jobs j set scope_key=coalesce(c.thread_id,c.communication_id)
from public.communications c where c.communication_id=j.communication_id and j.scope_key is null;
delete from public.communication_enrichment_jobs older using public.communication_enrichment_jobs newer
where older.scope_key=newer.scope_key and older.job_type=newer.job_type and older.scope_key is not null
  and (older.updated_at,older.id)<(newer.updated_at,newer.id);
create unique index if not exists communication_enrichment_scope_unique on public.communication_enrichment_jobs(scope_key,job_type) where scope_key is not null;
create or replace function public.queue_communication_enrichment()
returns trigger language plpgsql as $$
declare job_scope text:=coalesce(new.thread_id,new.communication_id);
begin
  if nullif(coalesce(new.body,new.summary,''),'') is null then return new; end if;
  insert into public.communication_enrichment_jobs(communication_id,scope_key,job_type,status,next_attempt_at,updated_at)
  values(new.communication_id,job_scope,'memory','pending',now(),now())
  on conflict(scope_key,job_type) where scope_key is not null do update set communication_id=excluded.communication_id,
    status=case when public.communication_enrichment_jobs.status='processing' then 'processing' else 'pending' end,
    rerun_requested=public.communication_enrichment_jobs.status='processing',attempts=case when public.communication_enrichment_jobs.status='processing' then public.communication_enrichment_jobs.attempts else 0 end,
    last_error=null,next_attempt_at=now(),updated_at=now();
  return new;
exception when others then raise warning 'could not queue enrichment for %: %',new.communication_id,sqlerrm; return new;
end $$;

create or replace function public.requeue_communication_enrichment(p_communication_id text)
returns jsonb language plpgsql as $$
declare communication public.communications%rowtype; job public.communication_enrichment_jobs%rowtype; job_scope text;
begin
  select * into communication from public.communications where communication_id=p_communication_id;
  if not found then raise exception 'Communication % not found',p_communication_id; end if;
  job_scope:=coalesce(communication.thread_id,communication.communication_id);
  insert into public.communication_enrichment_jobs(communication_id,scope_key,job_type,status,next_attempt_at,updated_at)
  values(p_communication_id,job_scope,'memory','pending',now(),now())
  on conflict(scope_key,job_type) where scope_key is not null do update set communication_id=excluded.communication_id,status='pending',attempts=0,
    last_error=null,rerun_requested=false,next_attempt_at=now(),updated_at=now(),lease_token=null,lease_expires_at=null
  returning * into job;
  return to_jsonb(job);
end $$;

commit;

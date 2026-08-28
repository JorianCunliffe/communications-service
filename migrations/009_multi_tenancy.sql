-- First-class tenant ownership for every Communications domain row.
-- LEGACY_TENANT_ID is injected as app.legacy_tenant_id by scripts/migrate.js.

begin;

create table if not exists public.tenants (
  tenant_id text primary key,
  name text,
  status text not null default 'active' check (status in ('active','suspended','closed')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare legacy text := nullif(current_setting('app.legacy_tenant_id', true), '');
begin
  if legacy is null then
    raise exception 'LEGACY_TENANT_ID must be configured before migration 009';
  end if;
  insert into public.tenants(tenant_id,name) values(legacy,'Legacy tenant') on conflict do nothing;
end $$;

do $$
declare
  legacy text := current_setting('app.legacy_tenant_id', true);
  table_name text;
  owned_tables text[] := array[
    'contacts','contact_config','phone_configs','calls','sms_threads','sms_messages','tool_calls','recordings',
    'projects','project_contacts','communications','communication_identities','communication_threads',
    'communication_thread_members','ask_bindings','outbound_operations','outbound_events','calendar_events',
    'calendar_event_participants','communication_commitments','communication_facts',
    'communication_enrichment_jobs','call_outcome_jobs'
  ];
begin
  foreach table_name in array owned_tables loop
    execute format('alter table public.%I add column if not exists tenant_id text', table_name);
    execute format('update public.%I set tenant_id=$1 where tenant_id is null', table_name) using legacy;
    execute format('alter table public.%I alter column tenant_id set not null', table_name);
    begin
      execute format('alter table public.%I add constraint %I foreign key (tenant_id) references public.tenants(tenant_id) on delete restrict',
        table_name, table_name || '_tenant_fk');
    exception when duplicate_object then null;
    end;
    execute format('create index if not exists %I on public.%I(tenant_id)', table_name || '_tenant_idx', table_name);
  end loop;
end $$;

-- Composite keys make it impossible to attach a row to a parent owned by a
-- different tenant, even if privileged application code supplies valid UUIDs.
create unique index if not exists contacts_tenant_id_unique on public.contacts(tenant_id,id);
create unique index if not exists projects_tenant_id_unique on public.projects(tenant_id,id);
create unique index if not exists threads_tenant_id_unique on public.communication_threads(tenant_id,thread_id);
create unique index if not exists communications_tenant_row_unique on public.communications(tenant_id,id);
create unique index if not exists calendar_events_tenant_id_unique on public.calendar_events(tenant_id,id);
create unique index if not exists calls_tenant_id_unique on public.calls(tenant_id,id);

do $$ begin
  alter table public.contact_config add constraint contact_config_tenant_contact_fk foreign key(tenant_id,contact_id) references public.contacts(tenant_id,id) on delete cascade;
  alter table public.communication_identities add constraint identities_tenant_person_fk foreign key(tenant_id,person_id) references public.contacts(tenant_id,id) on delete cascade;
  alter table public.project_contacts add constraint project_contacts_tenant_project_fk foreign key(tenant_id,project_id) references public.projects(tenant_id,id) on delete cascade;
  alter table public.project_contacts add constraint project_contacts_tenant_contact_fk foreign key(tenant_id,contact_id) references public.contacts(tenant_id,id) on delete cascade;
  alter table public.calls add constraint calls_tenant_contact_fk foreign key(tenant_id,contact_id) references public.contacts(tenant_id,id);
  alter table public.sms_threads add constraint sms_threads_tenant_contact_fk foreign key(tenant_id,contact_id) references public.contacts(tenant_id,id);
  alter table public.communications add constraint communications_tenant_contact_fk foreign key(tenant_id,contact_id) references public.contacts(tenant_id,id);
  alter table public.communications add constraint communications_tenant_person_fk foreign key(tenant_id,person_id) references public.contacts(tenant_id,id);
  alter table public.communications add constraint communications_tenant_project_fk foreign key(tenant_id,project_id) references public.projects(tenant_id,id);
  alter table public.communications add constraint communications_tenant_thread_fk foreign key(tenant_id,thread_id) references public.communication_threads(tenant_id,thread_id);
  alter table public.ask_bindings add constraint ask_bindings_tenant_thread_fk foreign key(tenant_id,thread_id) references public.communication_threads(tenant_id,thread_id) on delete cascade;
exception when duplicate_object then null;
end $$;

-- Tenant-local identities and provider IDs may legitimately be equal in two
-- accounts. Internal UUID/source identifiers remain globally unique.
alter table public.contacts drop constraint if exists contacts_phone_number_key;
drop index if exists public.contacts_phone_number_unique;
create unique index if not exists contacts_tenant_phone_unique on public.contacts(tenant_id,phone_number) where phone_number is not null;
create index if not exists contacts_tenant_email on public.contacts(tenant_id,lower(email)) where email is not null;

alter table public.contact_config drop constraint if exists contact_config_contact_id_key;
create unique index if not exists contact_config_tenant_contact_unique on public.contact_config(tenant_id,contact_id);
alter table public.phone_configs drop constraint if exists phone_configs_twilio_number_key;
create unique index if not exists phone_configs_tenant_number_unique on public.phone_configs(tenant_id,twilio_number);
alter table public.calls drop constraint if exists calls_twilio_call_sid_key;
create unique index if not exists calls_tenant_sid_unique on public.calls(tenant_id,twilio_call_sid);
alter table public.sms_threads drop constraint if exists sms_threads_phone_number_twilio_number_key;
create unique index if not exists sms_threads_tenant_route_unique on public.sms_threads(tenant_id,phone_number,twilio_number);
alter table public.sms_messages drop constraint if exists sms_messages_twilio_message_sid_key;
create unique index if not exists sms_messages_tenant_sid_unique on public.sms_messages(tenant_id,twilio_message_sid) where twilio_message_sid is not null;
alter table public.recordings drop constraint if exists recordings_source_external_id_key;
create unique index if not exists recordings_tenant_source_unique on public.recordings(tenant_id,source,external_id) where external_id is not null;

drop index if exists public.projects_name_unique;
create unique index if not exists projects_tenant_name_unique on public.projects(tenant_id,lower(name));
alter table public.project_contacts drop constraint if exists project_contacts_pkey;
alter table public.project_contacts add primary key (tenant_id,project_id,contact_id);

alter table public.communication_identities drop constraint if exists communication_identities_type_value_provider_key;
create unique index if not exists communication_identities_tenant_value_unique
  on public.communication_identities(tenant_id,type,value,coalesce(provider,''));
create unique index if not exists communication_threads_tenant_id_unique on public.communication_threads(tenant_id,thread_id);
alter table public.ask_bindings drop constraint if exists ask_bindings_pkey;
alter table public.ask_bindings add primary key (tenant_id,ask_id);

drop index if exists public.communications_provider_identity_unique;
create unique index if not exists communications_tenant_provider_unique
  on public.communications(tenant_id,provider,provider_id) where provider is not null and provider_id is not null;
create unique index if not exists communications_tenant_public_id_unique on public.communications(tenant_id,communication_id);

alter table public.outbound_operations drop constraint if exists outbound_operations_operation_type_idempotency_key_key;
alter table public.outbound_operations drop constraint if exists outbound_operations_operation_type_check;
alter table public.outbound_operations add constraint outbound_operations_operation_type_check check(operation_type in('sms','voice','email'));
create unique index if not exists outbound_operations_tenant_idempotency_unique
  on public.outbound_operations(tenant_id,operation_type,idempotency_key);

drop index if exists public.outbound_events_dedupe_unique;
create unique index if not exists outbound_events_tenant_dedupe_unique on public.outbound_events(tenant_id,dedupe_key) where dedupe_key is not null;
alter table public.calendar_events drop constraint if exists calendar_events_provider_provider_id_key;
create unique index if not exists calendar_events_tenant_provider_unique on public.calendar_events(tenant_id,provider,provider_id);
drop index if exists public.calendar_participant_identity_unique;
create unique index if not exists calendar_participant_tenant_identity_unique
  on public.calendar_event_participants(tenant_id,event_id,coalesce(identity_type,''),coalesce(identity_value,''),coalesce(contact_id::text,''));
alter table public.communication_commitments drop constraint if exists communication_commitments_communication_id_description_key;
create unique index if not exists communication_commitments_tenant_unique on public.communication_commitments(tenant_id,communication_id,description);
alter table public.communication_enrichment_jobs drop constraint if exists communication_enrichment_jobs_communication_id_job_type_key;
create unique index if not exists communication_enrichment_tenant_unique on public.communication_enrichment_jobs(tenant_id,communication_id,job_type);
drop index if exists public.communication_enrichment_scope_unique;
create unique index if not exists communication_enrichment_tenant_scope_unique
  on public.communication_enrichment_jobs(tenant_id,scope_key,job_type) where scope_key is not null;

-- API credentials can be authorized for one or more tenants without storing a
-- recoverable secret.
create table if not exists public.api_clients (
  id uuid primary key default gen_random_uuid(),
  key_id text not null unique,
  name text not null,
  secret_hash text not null,
  allowed_tenants text[] not null,
  roles text[] not null default '{}',
  capabilities text[] not null default '{}',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  check (cardinality(allowed_tenants) > 0)
);
alter table public.api_clients enable row level security;

-- Tenant-safe outbound reservation. The legacy signature is removed so no
-- caller can accidentally reserve outside an authenticated tenant.
drop function if exists public.reserve_outbound_operation(text,text,text,text,jsonb);
create or replace function public.reserve_outbound_operation(
  p_tenant_id text,p_idempotency_key text,p_operation_type text,p_request_hash text,p_communication_id text,p_audit_context jsonb default '{}'
) returns jsonb language plpgsql as $$
declare operation public.outbound_operations%rowtype;
begin
  if not exists(select 1 from public.tenants where tenant_id=p_tenant_id and status='active') then raise exception 'Unknown or inactive tenant'; end if;
  insert into public.outbound_operations(tenant_id,idempotency_key,operation_type,request_hash,communication_id,audit_context)
  values(p_tenant_id,p_idempotency_key,p_operation_type,p_request_hash,p_communication_id,coalesce(p_audit_context,'{}'))
  on conflict(tenant_id,operation_type,idempotency_key) do nothing returning * into operation;
  if found then return to_jsonb(operation)||jsonb_build_object('claimed',true); end if;
  select * into operation from public.outbound_operations
   where tenant_id=p_tenant_id and operation_type=p_operation_type and idempotency_key=p_idempotency_key for update;
  if operation.request_hash <> p_request_hash then return jsonb_build_object('conflict',true); end if;
  return to_jsonb(operation)||jsonb_build_object('claimed',false);
end $$;

-- Child projections inherit tenant ownership from their trusted parent. This
-- keeps legacy database triggers safe while all direct service writes also
-- provide tenant_id explicitly.
create or replace function public.inherit_communication_tenant()
returns trigger language plpgsql as $$
begin
  if new.tenant_id is not null then return new; end if;
  case tg_table_name
    when 'sms_messages' then select tenant_id into new.tenant_id from public.sms_threads where id=new.thread_id;
    when 'tool_calls' then select tenant_id into new.tenant_id from public.calls where id=new.call_id;
    when 'project_contacts' then select tenant_id into new.tenant_id from public.projects where id=new.project_id;
    when 'communication_thread_members' then select tenant_id into new.tenant_id from public.communication_threads where thread_id=new.thread_id;
    when 'ask_bindings' then select tenant_id into new.tenant_id from public.communication_threads where thread_id=new.thread_id;
    when 'calendar_event_participants' then select tenant_id into new.tenant_id from public.calendar_events where id=new.event_id;
    when 'communication_enrichment_jobs' then select tenant_id into new.tenant_id from public.communications where communication_id=new.communication_id;
    when 'call_outcome_jobs' then select tenant_id into new.tenant_id from public.calls where id=new.call_id;
    when 'communication_commitments' then select tenant_id into new.tenant_id from public.communications where communication_id=new.communication_id;
    when 'communications' then
      if new.source_table='calls' then select tenant_id into new.tenant_id from public.calls where id=new.source_id;
      elsif new.source_table='sms_messages' then select tenant_id into new.tenant_id from public.sms_messages where id=new.source_id;
      elsif new.source_table='recordings' then select tenant_id into new.tenant_id from public.recordings where id=new.source_id;
      end if;
    else null;
  end case;
  if new.tenant_id is null then raise exception 'tenant_id could not be inherited for public.%',tg_table_name; end if;
  return new;
end $$;

create or replace function public.queue_communication_enrichment()
returns trigger language plpgsql as $$
declare job_scope text;
begin
  if nullif(coalesce(new.body,new.summary,''),'') is null or new.memory_eligible is not true then return new; end if;
  job_scope:=coalesce(new.thread_id,new.communication_id);
  insert into public.communication_enrichment_jobs(tenant_id,communication_id,scope_key,job_type,status,next_attempt_at,updated_at,skip_reason)
  values(new.tenant_id,new.communication_id,job_scope,'memory','pending',now(),now(),null)
  on conflict(tenant_id,scope_key,job_type) where scope_key is not null do update set
    communication_id=excluded.communication_id,
    status=case when public.communication_enrichment_jobs.status='processing' then 'processing' else 'pending' end,
    rerun_requested=public.communication_enrichment_jobs.status='processing',
    attempts=case when public.communication_enrichment_jobs.status='processing' then public.communication_enrichment_jobs.attempts else 0 end,
    last_error=null,skip_reason=null,next_attempt_at=now(),updated_at=now();
  return new;
exception when others then raise warning 'could not queue enrichment for %: %',new.communication_id,sqlerrm; return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['sms_messages','tool_calls','project_contacts','communication_thread_members','ask_bindings',
    'calendar_event_participants','communication_enrichment_jobs','call_outcome_jobs','communication_commitments','communications'] loop
    execute format('drop trigger if exists %I on public.%I',table_name||'_inherit_tenant',table_name);
    execute format('create trigger %I before insert on public.%I for each row execute function public.inherit_communication_tenant()',table_name||'_inherit_tenant',table_name);
  end loop;
end $$;

drop function if exists public.create_communication_contact(text,text,jsonb);
create or replace function public.create_communication_contact(p_tenant_id text,p_name text,p_phone_number text,p_identities jsonb default '[]')
returns jsonb language plpgsql as $$
declare person public.contacts%rowtype; identity jsonb;
begin
  insert into public.contacts(tenant_id,name,phone_number) values(p_tenant_id,p_name,p_phone_number) returning * into person;
  for identity in select * from jsonb_array_elements(coalesce(p_identities,'[]')) loop
    insert into public.communication_identities(tenant_id,person_id,type,value,provider,metadata)
    values(p_tenant_id,person.id,identity->>'type',lower(identity->>'value'),nullif(identity->>'provider',''),coalesce(identity->'metadata','{}'));
  end loop;
  return to_jsonb(person);
end $$;

create or replace function public.sync_contact_phone_identity()
returns trigger language plpgsql as $$
begin
  if nullif(new.phone_number,'') is not null then
    insert into public.communication_identities(tenant_id,person_id,type,value,provider)
    values(new.tenant_id,new.id,'phone',new.phone_number,'twilio') on conflict do nothing;
    update public.communication_identities set person_id=new.id,updated_at=now()
     where tenant_id=new.tenant_id and type='phone' and value=new.phone_number and provider='twilio';
  end if;
  return new;
end $$;

drop function if exists public.ensure_communication_contact(text);
create or replace function public.ensure_communication_contact(p_tenant_id text,p_phone_number text)
returns uuid language plpgsql as $$
declare person_id uuid;
begin
  select id into person_id from public.contacts where tenant_id=p_tenant_id and phone_number=p_phone_number;
  if person_id is null then
    insert into public.contacts(tenant_id,phone_number) values(p_tenant_id,p_phone_number) returning id into person_id;
  end if;
  return person_id;
end $$;

drop function if exists public.resolve_communication_ask(text,text);
create or replace function public.resolve_communication_ask(p_tenant_id text,p_ask_id text,p_communication_id text)
returns jsonb language plpgsql as $$
declare binding public.ask_bindings%rowtype; communication public.communications%rowtype; resolved_time timestamptz:=now();
begin
  select * into binding from public.ask_bindings where tenant_id=p_tenant_id and ask_id=p_ask_id for update;
  if not found then raise exception 'Ask % is not bound to a communication thread',p_ask_id; end if;
  if binding.status='resolved' then
    if binding.resolved_by=p_communication_id then return to_jsonb(binding)||jsonb_build_object('duplicate',true); end if;
    raise exception 'Ask % was resolved by a different communication',p_ask_id;
  end if;
  if binding.status<>'open' then raise exception 'Ask % is %',p_ask_id,binding.status; end if;
  select * into communication from public.communications where tenant_id=p_tenant_id and communication_id=p_communication_id;
  if not found or communication.thread_id is distinct from binding.thread_id then raise exception 'Communication % is not in Ask % thread',p_communication_id,p_ask_id; end if;
  update public.communications set resolution=jsonb_build_object('type','ask_resolved','ask_id',p_ask_id,'resolved_at',resolved_time),updated_at=resolved_time
   where tenant_id=p_tenant_id and communication_id=p_communication_id;
  update public.ask_bindings set status='resolved',resolved_by=p_communication_id,resolved_at=resolved_time,updated_at=resolved_time
   where tenant_id=p_tenant_id and ask_id=p_ask_id;
  update public.communication_threads set status='resolved',resolved_at=resolved_time,last_activity_at=greatest(last_activity_at,resolved_time)
   where tenant_id=p_tenant_id and thread_id=binding.thread_id;
  return jsonb_build_object('tenant_id',p_tenant_id,'ask_id',p_ask_id,'status','resolved','communication_id',p_communication_id,
    'thread_id',binding.thread_id,'resolved_at',resolved_time);
end $$;

create or replace function public.link_communication_thread()
returns trigger language plpgsql as $$
declare binding_status text; thread_status text; already_member boolean;
begin
  if new.thread_id is null then return new; end if;
  select status into thread_status from public.communication_threads where tenant_id=new.tenant_id and thread_id=new.thread_id for update;
  if thread_status is null then raise exception 'Thread % is not in tenant %',new.thread_id,new.tenant_id; end if;
  select exists(select 1 from public.communication_thread_members where tenant_id=new.tenant_id and thread_id=new.thread_id and communication_row_id=new.id) into already_member;
  if thread_status<>'open' and not already_member then raise exception 'Thread % is terminal and cannot accept a new communication',new.thread_id; end if;
  insert into public.communication_thread_members(tenant_id,thread_id,communication_row_id,communication_id,confidence,link_type)
  values(new.tenant_id,new.thread_id,new.id,new.communication_id,case when new.thread_link_type='inferred' then 0.8 else 1 end,coalesce(new.thread_link_type,'explicit'))
  on conflict(thread_id,communication_row_id) do update set communication_id=excluded.communication_id,confidence=excluded.confidence,link_type=excluded.link_type;
  update public.communication_threads set last_activity_at=greatest(last_activity_at,new.occurred_at),purpose=coalesce(new.purpose,purpose),
    correlation=correlation||coalesce(new.correlation,'{}') where tenant_id=new.tenant_id and thread_id=new.thread_id;
  if new.purpose->>'type'='human_ask' then
    select status into binding_status from public.ask_bindings where tenant_id=new.tenant_id and ask_id=new.purpose->>'ask_id' for update;
    if binding_status is not null and binding_status<>'open' then
      if not already_member then raise exception 'Ask % is terminal and cannot be rebound',new.purpose->>'ask_id'; end if;
    else
      insert into public.ask_bindings(tenant_id,ask_id,thread_id,purpose) values(new.tenant_id,new.purpose->>'ask_id',new.thread_id,new.purpose)
      on conflict(tenant_id,ask_id) do update set thread_id=excluded.thread_id,purpose=excluded.purpose,updated_at=now()
      where public.ask_bindings.status='open';
    end if;
  end if;
  return new;
end $$;

drop function if exists public.requeue_communication_enrichment(text);
create or replace function public.requeue_communication_enrichment(p_tenant_id text,p_communication_id text)
returns jsonb language plpgsql as $$
declare communication public.communications%rowtype; job public.communication_enrichment_jobs%rowtype; job_scope text;
begin
  select * into communication from public.communications where tenant_id=p_tenant_id and communication_id=p_communication_id;
  if not found then raise exception 'Communication % not found',p_communication_id; end if;
  if communication.memory_eligible is not true then raise exception 'Communication % is not eligible for memory enrichment',p_communication_id; end if;
  job_scope:=coalesce(communication.thread_id,communication.communication_id);
  insert into public.communication_enrichment_jobs(tenant_id,communication_id,scope_key,job_type,status,next_attempt_at,updated_at,skip_reason)
  values(p_tenant_id,p_communication_id,job_scope,'memory','pending',now(),now(),null)
  on conflict(tenant_id,scope_key,job_type) where scope_key is not null do update set communication_id=excluded.communication_id,status='pending',attempts=0,
    last_error=null,skip_reason=null,rerun_requested=false,next_attempt_at=now(),updated_at=now(),lease_token=null,lease_expires_at=null
  returning * into job;
  return to_jsonb(job);
end $$;

drop function if exists public.search_communications(text,uuid,uuid,timestamptz,timestamptz,text[],int,real,text,uuid);
create or replace function public.search_communications(
  p_tenant_id text,q text default null,contact uuid default null,project uuid default null,since timestamptz default null,
  until timestamptz default null,channels text[] default null,max_results int default 5,fuzzy_threshold real default 0.35,
  thread text default null,calendar_event uuid default null
) returns table (
  id uuid,communication_id text,channel text,occurred_at timestamptz,direction text,contact_id uuid,project_id uuid,
  thread_id text,calendar_event_id uuid,subject text,summary text,body text,rank real,matched_by text
) language plpgsql stable as $$
declare cleaned text; tsq tsquery;
begin
  cleaned:=btrim(regexp_replace(regexp_replace(lower(coalesce(q,'')),'([0-9]),([0-9])','\1\2','g'),'[^a-z0-9 ]',' ','g'));
  if cleaned<>'' then select to_tsquery('english',string_agg(w||':*','|')) into tsq from unnest(string_to_array(cleaned,' ')) w where w<>'' and length(w)>1; end if;
  perform set_config('pg_trgm.word_similarity_threshold',fuzzy_threshold::text,true);
  return query select * from (
    select c.id,c.communication_id,c.channel,c.occurred_at,c.direction,c.contact_id,c.project_id,c.thread_id,c.calendar_event_id,
      c.subject,c.summary,c.body,(coalesce(ts_rank(c.search,tsq,1),0)+coalesce(word_similarity(cleaned,coalesce(c.body_them,c.body,'')),0)*0.05)::real rank,
      case when tsq is null then 'filter' when c.search@@tsq and cleaned <% coalesce(c.body,'') then 'both' when c.search@@tsq then 'text' else 'fuzzy' end matched_by
    from public.communications c where c.tenant_id=p_tenant_id and c.memory_eligible is true
      and (contact is null or c.contact_id=contact) and (project is null or c.project_id=project)
      and (thread is null or c.thread_id=thread) and (calendar_event is null or c.calendar_event_id=calendar_event)
      and (since is null or c.occurred_at>=since) and (until is null or c.occurred_at<until)
      and (channels is null or c.channel=any(channels)) and (tsq is null or c.search@@tsq or cleaned <% coalesce(c.body,''))
  ) hit order by hit.rank desc,hit.occurred_at desc limit greatest(1,least(coalesce(max_results,5),100));
end $$;

drop function if exists public.suggest_terms(text,int);
create or replace function public.suggest_terms(p_tenant_id text,q text,max_results int default 3)
returns table(term text,kind text,score real) language sql stable as $$
  with candidates as (
    select c.name term,'contact' kind from public.contacts c where c.tenant_id=p_tenant_id and nullif(c.name,'') is not null
    union all select p.name,'project' from public.projects p where p.tenant_id=p_tenant_id
    union all select unnest(p.aliases),'project' from public.projects p where p.tenant_id=p_tenant_id
    union all select distinct w,'said' from (
      select coalesce(c.body_them,c.body,'') t from public.communications c where c.tenant_id=p_tenant_id order by c.occurred_at desc limit 200
    ) recent,lateral unnest(regexp_split_to_array(lower(regexp_replace(recent.t,'[^a-z0-9]+',' ','g')),' ')) w where length(w)>=4
  ) select candidates.term,candidates.kind,similarity(lower(q),lower(candidates.term))::real score from candidates
    where candidates.term<>'' and similarity(lower(q),lower(candidates.term))>0.25
    order by score desc,candidates.term limit greatest(1,least(coalesce(max_results,3),10));
$$;

drop function if exists public.ingest_calendar_event(jsonb);
create or replace function public.ingest_calendar_event(p_tenant_id text,p_event jsonb)
returns jsonb language plpgsql as $$
declare stored public.calendar_events%rowtype; participant jsonb; participant_rows jsonb:='[]'; person uuid; inserted public.calendar_event_participants%rowtype;
begin
  insert into public.calendar_events(tenant_id,provider,provider_id,title,description,starts_at,ends_at,location,organiser_contact_id,project_id,communication_thread_id,metadata,updated_at)
  values(p_tenant_id,p_event->>'provider',p_event->>'providerId',p_event->>'title',p_event->>'description',(p_event->>'startsAt')::timestamptz,
    nullif(p_event->>'endsAt','')::timestamptz,p_event->>'location',nullif(p_event->>'organiserContactId','')::uuid,
    nullif(p_event->>'projectId','')::uuid,p_event->>'threadId',coalesce(p_event->'metadata','{}'),now())
  on conflict(tenant_id,provider,provider_id) do update set title=excluded.title,description=excluded.description,starts_at=excluded.starts_at,
    ends_at=excluded.ends_at,location=excluded.location,organiser_contact_id=excluded.organiser_contact_id,project_id=excluded.project_id,
    communication_thread_id=excluded.communication_thread_id,metadata=excluded.metadata,updated_at=now()
  returning * into stored;
  delete from public.calendar_event_participants where tenant_id=p_tenant_id and event_id=stored.id;
  for participant in select value from jsonb_array_elements(coalesce(p_event->'participants','[]')) loop
    person:=nullif(coalesce(participant->>'contactId',participant->>'contact_id'),'')::uuid;
    if person is null then
      select min(person_id) into person from public.communication_identities where tenant_id=p_tenant_id
       and type=lower(coalesce(participant->>'identityType',participant->>'identity_type',participant->>'type'))
       and value=coalesce(participant->>'identityValue',participant->>'identity_value',participant->>'value',participant->>'email',participant->>'phone')
       having count(distinct person_id)=1;
    end if;
    insert into public.calendar_event_participants(tenant_id,event_id,contact_id,identity_type,identity_value,response_status,metadata)
    values(p_tenant_id,stored.id,person,lower(coalesce(participant->>'identityType',participant->>'identity_type',participant->>'type')),
      coalesce(participant->>'identityValue',participant->>'identity_value',participant->>'value',participant->>'email',participant->>'phone'),
      coalesce(participant->>'responseStatus',participant->>'response_status'),coalesce(participant->'metadata','{}')) returning * into inserted;
    participant_rows:=participant_rows||jsonb_build_array(to_jsonb(inserted));
  end loop;
  return jsonb_build_object('event',to_jsonb(stored),'participants',participant_rows);
end $$;

-- Existing direct client roles remain denied. Backend service credentials own
-- tenant scoping in application code and are never handed to browser clients.
do $$
begin
  if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on public.tenants, public.api_clients from anon'; end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on public.tenants, public.api_clients from authenticated'; end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on public.tenants, public.api_clients to service_role';
  end if;
end $$;

commit;

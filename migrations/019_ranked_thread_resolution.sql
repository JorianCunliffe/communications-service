-- Explainable, correctable communication threading.
-- Threads keep a lightweight register of people, channels and projects;
-- every automatic decision records its candidates and human corrections are
-- durable negative/positive evidence for later resolutions.

begin;

create or replace function public.lock_communication_thread_resolution(p_tenant_id text)
returns void language sql as $$
  select pg_advisory_xact_lock(hashtext('communication_thread_resolution'),hashtext(p_tenant_id));
$$;

create or replace function public.normalize_communication_identity(p_value text)
returns text language plpgsql immutable strict as $$
declare cleaned text:=lower(btrim(p_value)); digits text;
begin
  if cleaned='' then return ''; end if;
  if position('@' in cleaned)>0 then return cleaned; end if;
  cleaned:=btrim(regexp_replace(cleaned,'^(tel|sms|whatsapp):','','i'));
  if cleaned ~ '^[+0-9().[:space:]-]+$' and length(regexp_replace(cleaned,'[^0-9]','','g'))>=6 then
    digits:=regexp_replace(cleaned,'[^0-9]','','g');
    if left(cleaned,1)='+' then return '+'||digits; end if;
    if left(digits,2)='00' then return '+'||substr(digits,3); end if;
    return digits;
  end if;
  return lower(btrim(p_value));
end $$;

alter table public.communication_identities add column if not exists normalized_value text;
update public.communication_identities set normalized_value=public.normalize_communication_identity(value)
 where normalized_value is null or normalized_value<>public.normalize_communication_identity(value);
alter table public.communication_identities alter column normalized_value set not null;
create index if not exists communication_identities_tenant_normalized
  on public.communication_identities(tenant_id,normalized_value,person_id);
create or replace function public.set_normalized_communication_identity()
returns trigger language plpgsql as $$
begin new.normalized_value:=public.normalize_communication_identity(new.value); return new; end $$;
drop trigger if exists communication_identities_normalize on public.communication_identities;
create trigger communication_identities_normalize before insert or update of value on public.communication_identities
  for each row execute function public.set_normalized_communication_identity();

alter table public.communication_threads add column if not exists external_project_id text;
alter table public.communication_threads add column if not exists project_id uuid;
alter table public.communication_threads add column if not exists primary_channel text;
alter table public.communication_threads add column if not exists last_channel text;
alter table public.communication_threads add column if not exists last_subject text;
alter table public.communication_threads add column if not exists resolution_confidence real;
alter table public.communication_threads add column if not exists resolution_method text;

create index if not exists communication_threads_tenant_project_open
  on public.communication_threads(tenant_id,external_project_id,last_activity_at desc)
  where status='open' and external_project_id is not null;
create index if not exists communication_threads_tenant_internal_project_open
  on public.communication_threads(tenant_id,project_id,last_activity_at desc)
  where status='open' and project_id is not null;
create index if not exists email_messages_tenant_connection_conversation
  on public.email_messages(tenant_id,provider_connection_id,provider_conversation_id,occurred_at desc)
  where provider_conversation_id is not null;
alter table public.communication_threads drop constraint if exists communication_threads_tenant_person_fk;
alter table public.communication_threads add constraint communication_threads_tenant_person_fk
  foreign key(tenant_id,person_id) references public.contacts(tenant_id,id) on delete set null (person_id);
alter table public.communication_threads drop constraint if exists communication_threads_tenant_project_fk;
alter table public.communication_threads add constraint communication_threads_tenant_project_fk
  foreign key(tenant_id,project_id) references public.projects(tenant_id,id) on delete set null (project_id);

create table if not exists public.communication_thread_participants (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           text not null references public.tenants(tenant_id) on delete restrict,
  thread_id           text not null,
  person_id           uuid,
  identity_value      text not null,
  normalized_identity text not null,
  channel             text not null,
  role                text not null default 'participant',
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  foreign key(tenant_id,thread_id) references public.communication_threads(tenant_id,thread_id) on delete cascade,
  foreign key(tenant_id,person_id) references public.contacts(tenant_id,id) on delete set null (person_id),
  unique(tenant_id,thread_id,channel,normalized_identity)
);
create index if not exists communication_thread_participants_person
  on public.communication_thread_participants(tenant_id,person_id,thread_id) where person_id is not null;
create index if not exists communication_thread_participants_identity
  on public.communication_thread_participants(tenant_id,normalized_identity,thread_id);
create or replace function public.preserve_thread_participant_times()
returns trigger language plpgsql as $$
begin
  new.first_seen_at:=least(old.first_seen_at,new.first_seen_at);
  new.last_seen_at:=greatest(old.last_seen_at,new.last_seen_at);
  new.person_id:=coalesce(new.person_id,old.person_id);
  return new;
end $$;
drop trigger if exists thread_participant_times on public.communication_thread_participants;
create trigger thread_participant_times before update on public.communication_thread_participants
  for each row execute function public.preserve_thread_participant_times();

create table if not exists public.thread_resolution_decisions (
  resolution_id       text primary key default public.prefixed_id('trd'),
  tenant_id           text not null references public.tenants(tenant_id) on delete restrict,
  communication_id    text,
  selected_thread_id  text,
  action              text not null check(action in ('attached','created','corrected','updated')),
  method              text not null,
  confidence          real not null check(confidence between 0 and 1),
  score_margin        real,
  candidate_scores    jsonb not null default '[]',
  input               jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  foreign key(tenant_id,selected_thread_id) references public.communication_threads(tenant_id,thread_id) on delete set null (selected_thread_id)
);
create index if not exists thread_resolution_decisions_communication
  on public.thread_resolution_decisions(tenant_id,communication_id,created_at desc);
create index if not exists thread_resolution_decisions_thread
  on public.thread_resolution_decisions(tenant_id,selected_thread_id,created_at desc);

create table if not exists public.thread_resolution_feedback (
  feedback_id         uuid primary key default gen_random_uuid(),
  tenant_id           text not null references public.tenants(tenant_id) on delete restrict,
  communication_id    text not null,
  resolution_id       text,
  from_thread_id      text,
  to_thread_id        text not null,
  person_id           uuid,
  identity_value      text,
  normalized_identity text,
  channel             text,
  external_project_id text,
  project_id          uuid,
  topic_terms         text[] not null default '{}',
  reason_code         text not null check(reason_code in (
    'wrong_person','wrong_project','wrong_topic','time_gap','channel_boundary','duplicate_thread','other'
  )),
  reason_detail       text,
  actor_id            text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  foreign key(tenant_id,from_thread_id) references public.communication_threads(tenant_id,thread_id) on delete set null (from_thread_id),
  foreign key(tenant_id,to_thread_id) references public.communication_threads(tenant_id,thread_id) on delete cascade,
  foreign key(tenant_id,person_id) references public.contacts(tenant_id,id) on delete set null (person_id),
  foreign key(tenant_id,project_id) references public.projects(tenant_id,id) on delete set null (project_id),
  foreign key(resolution_id) references public.thread_resolution_decisions(resolution_id) on delete set null
);
create index if not exists thread_resolution_feedback_matching
  on public.thread_resolution_feedback(tenant_id,normalized_identity,person_id,external_project_id,channel,created_at desc)
  where active=true;
create index if not exists thread_resolution_feedback_person
  on public.thread_resolution_feedback(tenant_id,person_id) where active=true and person_id is not null;
create index if not exists thread_resolution_feedback_project
  on public.thread_resolution_feedback(tenant_id,project_id) where active=true and project_id is not null;
create index if not exists thread_resolution_feedback_external_project
  on public.thread_resolution_feedback(tenant_id,external_project_id) where active=true and external_project_id is not null;
create index if not exists thread_resolution_feedback_from_thread
  on public.thread_resolution_feedback(tenant_id,from_thread_id,created_at desc);
create index if not exists thread_resolution_feedback_to_thread
  on public.thread_resolution_feedback(tenant_id,to_thread_id,created_at desc);

update public.communication_threads set external_project_id=correlation->>'external_project_id'
 where external_project_id is null and nullif(correlation->>'external_project_id','') is not null;

with identity_people as (
  select t.tenant_id,t.thread_id,(array_agg(distinct i.person_id))[1] person_id
  from public.communication_threads t join public.communication_identities i
    on i.tenant_id=t.tenant_id
   and i.normalized_value=public.normalize_communication_identity(t.participant_identity)
  where t.person_id is null and nullif(t.participant_identity,'') is not null
  group by t.tenant_id,t.thread_id having count(distinct i.person_id)=1
)
update public.communication_threads t set person_id=p.person_id
from identity_people p where t.tenant_id=p.tenant_id and t.thread_id=p.thread_id;

with latest as (
  select distinct on (tenant_id,thread_id) tenant_id,thread_id,project_id,channel,subject
  from public.communications where thread_id is not null
  order by tenant_id,thread_id,occurred_at desc
)
update public.communication_threads t set
  project_id=coalesce(t.project_id,l.project_id),
  primary_channel=coalesce(t.primary_channel,l.channel),
  last_channel=coalesce(l.channel,t.last_channel,t.primary_channel),
  last_subject=coalesce(t.last_subject,l.subject)
from latest l where t.tenant_id=l.tenant_id and t.thread_id=l.thread_id;

insert into public.communication_thread_participants(
  tenant_id,thread_id,person_id,identity_value,normalized_identity,channel,role,first_seen_at,last_seen_at
)
select t.tenant_id,t.thread_id,t.person_id,t.participant_identity,public.normalize_communication_identity(t.participant_identity),
       coalesce(t.last_channel,t.primary_channel,'other'),'participant',t.created_at,t.last_activity_at
from public.communication_threads t
where nullif(t.participant_identity,'') is not null
on conflict(tenant_id,thread_id,channel,normalized_identity) do update set
  person_id=coalesce(excluded.person_id,public.communication_thread_participants.person_id),
  last_seen_at=greatest(excluded.last_seen_at,public.communication_thread_participants.last_seen_at);

insert into public.communication_thread_participants(
  tenant_id,thread_id,person_id,identity_value,normalized_identity,channel,role,first_seen_at,last_seen_at
)
select c.tenant_id,c.thread_id,c.person_id,'person:'||c.person_id::text,'person:'||c.person_id::text,
       c.channel,'participant',min(c.occurred_at),max(c.occurred_at)
from public.communications c
where c.thread_id is not null and c.person_id is not null
group by c.tenant_id,c.thread_id,c.person_id,c.channel
on conflict(tenant_id,thread_id,channel,normalized_identity) do update set
  first_seen_at=least(excluded.first_seen_at,public.communication_thread_participants.first_seen_at),
  last_seen_at=greatest(excluded.last_seen_at,public.communication_thread_participants.last_seen_at);

alter table public.communications drop constraint if exists communications_thread_link_type_check;
alter table public.communications add constraint communications_thread_link_type_check
  check(thread_link_type in ('native','explicit','inferred','corrected'));
alter table public.calls drop constraint if exists calls_thread_link_type_check;
alter table public.calls add constraint calls_thread_link_type_check
  check(thread_link_type in ('native','explicit','inferred','corrected'));
alter table public.sms_messages drop constraint if exists sms_messages_thread_link_type_check;
alter table public.sms_messages add constraint sms_messages_thread_link_type_check
  check(thread_link_type in ('native','explicit','inferred','corrected'));
alter table public.communication_thread_members drop constraint if exists communication_thread_members_link_type_check;
alter table public.communication_thread_members add constraint communication_thread_members_link_type_check
  check(link_type in ('native','explicit','inferred','corrected'));
alter table public.recordings add column if not exists thread_link_type text;
alter table public.recordings add column if not exists resolution jsonb;
alter table public.recordings drop constraint if exists recordings_thread_link_type_check;
alter table public.recordings add constraint recordings_thread_link_type_check
  check(thread_link_type in ('native','explicit','inferred','corrected'));

-- A provider-native SMS thread can outlive an identity correction. Keep the
-- person on each message so correcting one row does not rewrite its siblings.
alter table public.sms_messages add column if not exists person_id uuid;
alter table public.sms_messages add column if not exists resolution jsonb;
alter table public.sms_messages drop constraint if exists sms_messages_tenant_person_fk;
alter table public.sms_messages add constraint sms_messages_tenant_person_fk
  foreign key(tenant_id,person_id) references public.contacts(tenant_id,id) on delete set null (person_id);
update public.sms_messages m set person_id=c.person_id,resolution=c.resolution
from public.communications c where c.tenant_id=m.tenant_id and c.source_table='sms_messages' and c.source_id=m.id;
create or replace function public.project_sms_to_communications()
returns trigger language plpgsql as $$
declare who uuid; counterparty text;
begin
  select coalesce(new.person_id,contact_id),phone_number into who,counterparty
    from public.sms_threads where tenant_id=new.tenant_id and id=new.thread_id;
  insert into public.communications(
    tenant_id,communication_id,channel,source_table,source_id,contact_id,person_id,occurred_at,direction,
    body,body_them,provider,provider_id,purpose,correlation,thread_id,thread_link_type,resolution,metadata
  ) values (
    new.tenant_id,coalesce(new.communication_id,public.prefixed_id('comm')),'sms','sms_messages',new.id,who,who,
    coalesce(new.created_at,now()),new.direction,new.content,case when new.direction='inbound' then new.content else null end,
    'twilio',new.twilio_message_sid,new.purpose,new.correlation,new.communication_thread_id,new.thread_link_type,new.resolution,
    jsonb_build_object('twilio_message_sid',new.twilio_message_sid,'status',new.status,'participant_identity',counterparty,
      'participant_identities',jsonb_build_array(counterparty))
  ) on conflict(source_table,source_id) do update set
    communication_id=excluded.communication_id,contact_id=excluded.contact_id,person_id=excluded.person_id,
    occurred_at=excluded.occurred_at,direction=excluded.direction,body=excluded.body,body_them=excluded.body_them,
    provider=excluded.provider,provider_id=excluded.provider_id,purpose=excluded.purpose,correlation=excluded.correlation,
    thread_id=excluded.thread_id,thread_link_type=excluded.thread_link_type,resolution=excluded.resolution,
    metadata=excluded.metadata,updated_at=now();
  return new;
end $$;
drop trigger if exists sms_to_communications on public.sms_messages;
create trigger sms_to_communications after insert or update of content,thread_id,created_at,status,purpose,correlation,
  communication_thread_id,thread_link_type,person_id,resolution on public.sms_messages
  for each row execute function public.project_sms_to_communications();

create or replace function public.link_communication_thread()
returns trigger language plpgsql as $$
declare binding_status text; thread_status text; already_member boolean; member_confidence real;
begin
  if new.thread_id is null then return new; end if;
  select status into thread_status from public.communication_threads
   where tenant_id=new.tenant_id and thread_id=new.thread_id for update;
  if thread_status is null then raise exception 'Thread % is not in tenant %',new.thread_id,new.tenant_id; end if;
  select exists(select 1 from public.communication_thread_members
    where tenant_id=new.tenant_id and thread_id=new.thread_id and communication_row_id=new.id) into already_member;
  if thread_status<>'open' and not already_member then
    raise exception 'Thread % is terminal and cannot accept a new communication',new.thread_id;
  end if;
  delete from public.communication_thread_members
    where tenant_id=new.tenant_id and communication_row_id=new.id and thread_id<>new.thread_id;
  if tg_op='UPDATE' and old.thread_id is distinct from new.thread_id and old.thread_id is not null then
    update public.communication_threads t set
      last_activity_at=coalesce((select max(c.occurred_at) from public.communications c
        where c.tenant_id=new.tenant_id and c.thread_id=t.thread_id),t.created_at),
      status=case when coalesce(t.purpose->>'type','')<>'human_ask' and not exists(
        select 1 from public.communications c where c.tenant_id=new.tenant_id and c.thread_id=t.thread_id) then 'closed' else t.status end
    where t.tenant_id=new.tenant_id and t.thread_id=old.thread_id;
  end if;
  member_confidence:=case when new.thread_link_type='inferred'
    then greatest(0,least(1,coalesce(nullif(new.resolution->>'confidence','')::real,0.8))) else 1 end;
  insert into public.communication_thread_members(
    tenant_id,thread_id,communication_row_id,communication_id,confidence,link_type
  ) values (new.tenant_id,new.thread_id,new.id,new.communication_id,member_confidence,coalesce(new.thread_link_type,'explicit'))
  on conflict(thread_id,communication_row_id) do update set communication_id=excluded.communication_id,
    confidence=excluded.confidence,link_type=excluded.link_type;
  update public.communication_threads set last_activity_at=greatest(last_activity_at,new.occurred_at),
    purpose=coalesce(new.purpose,purpose),correlation=correlation||coalesce(new.correlation,'{}')
   where tenant_id=new.tenant_id and thread_id=new.thread_id;
  if new.purpose->>'type'='human_ask' then
    select status into binding_status from public.ask_bindings
     where tenant_id=new.tenant_id and ask_id=new.purpose->>'ask_id' for update;
    if binding_status is not null and binding_status<>'open' then
      if not already_member then raise exception 'Ask % is terminal and cannot be rebound',new.purpose->>'ask_id'; end if;
    else
      insert into public.ask_bindings(tenant_id,ask_id,thread_id,purpose)
      values(new.tenant_id,new.purpose->>'ask_id',new.thread_id,new.purpose)
      on conflict(tenant_id,ask_id) do update set thread_id=excluded.thread_id,purpose=excluded.purpose,updated_at=now()
      where public.ask_bindings.status='open';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists communications_link_thread on public.communications;
create trigger communications_link_thread
  after insert or update of thread_id,thread_link_type,purpose,correlation,resolution on public.communications
  for each row execute function public.link_communication_thread();

alter table public.communication_thread_participants enable row level security;
alter table public.thread_resolution_decisions enable row level security;
alter table public.thread_resolution_feedback enable row level security;

create or replace function public.project_recording_to_communications()
returns trigger language plpgsql as $$
declare flat text; spoke text; merged_correlation jsonb;
begin
  if new.call_id is not null or new.status is distinct from 'done' then return new; end if;
  select string_agg(coalesce(seg->>'role','unknown')||': '||coalesce(seg->>'text',''),E'\n' order by ord),
         string_agg(coalesce(seg->>'text',''),E'\n' order by ord) filter(where seg->>'role'='user')
    into flat,spoke from jsonb_array_elements(coalesce(new.transcript->'segments','[]'::jsonb))
      with ordinality as t(seg,ord);
  merged_correlation:=coalesce(new.metadata->'correlation','{}'::jsonb)
    ||jsonb_strip_nulls(jsonb_build_object('project_id',new.project_id,'thread_id',new.communication_thread_id,
         'calendar_event_id',new.calendar_event_id));
  insert into public.communications(
    tenant_id,communication_id,channel,source_table,source_id,contact_id,person_id,project_id,calendar_event_id,
    occurred_at,subject,body,body_them,provider,provider_id,correlation,thread_id,thread_link_type,resolution,metadata
  ) values (
    new.tenant_id,coalesce(new.communication_id,public.prefixed_id('comm')),'recording','recordings',new.id,
    new.contact_id,new.contact_id,new.project_id,new.calendar_event_id,coalesce(new.recorded_at,new.created_at,now()),
    new.title,coalesce(flat,new.transcript_text),spoke,new.source,new.external_id,merged_correlation,
    new.communication_thread_id,coalesce(new.thread_link_type,case when new.communication_thread_id is null then null else 'explicit' end),
    new.resolution,coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('source',new.source,'external_id',new.external_id,
      'participants',new.participant_identities,'participant_identities',
      coalesce((select jsonb_agg(p->>'identity_value') from jsonb_array_elements(new.participant_identities) p
                where nullif(p->>'identity_value','') is not null),'[]'::jsonb),'meeting_type',new.meeting_type)
  ) on conflict(source_table,source_id) do update set
    communication_id=excluded.communication_id,contact_id=excluded.contact_id,person_id=excluded.person_id,
    project_id=excluded.project_id,calendar_event_id=excluded.calendar_event_id,occurred_at=excluded.occurred_at,
    subject=excluded.subject,body=excluded.body,body_them=excluded.body_them,provider=excluded.provider,
    provider_id=excluded.provider_id,correlation=excluded.correlation,thread_id=excluded.thread_id,
    thread_link_type=excluded.thread_link_type,resolution=excluded.resolution,metadata=excluded.metadata,updated_at=now();
  return new;
exception when others then
  raise warning 'communications projection failed for recording %: %',new.id,sqlerrm; return new;
end $$;
drop trigger if exists recordings_to_communications on public.recordings;
create trigger recordings_to_communications
  after insert or update of transcript,transcript_text,status,contact_id,participant_identities,calendar_event_id,
    project_id,communication_thread_id,thread_link_type,resolution,title,meeting_type on public.recordings
  for each row execute function public.project_recording_to_communications();
update public.recordings set status=status where status='done';

create or replace function public.correct_communication_thread(
  p_tenant_id text,
  p_communication_id text,
  p_to_thread_id text default null,
  p_create_new boolean default false,
  p_reason_code text default 'other',
  p_reason_detail text default null,
  p_actor_id text default null,
  p_person_id uuid default null,
  p_update_identity boolean default false,
  p_project_id uuid default null,
  p_external_project_id text default null
) returns jsonb language plpgsql as $$
declare
  communication public.communications%rowtype;
  old_thread public.communication_threads%rowtype;
  destination public.communication_threads%rowtype;
  new_thread_id text;
  decision_id text;
  effective_person_id uuid;
  effective_project_id uuid;
  effective_external_project_id text;
  communication_identity text;
  corrected_correlation jsonb;
  corrected_purpose jsonb;
  corrected_resolution jsonb;
  feedback_terms text[];
begin
  if (p_to_thread_id is null) = (p_create_new is false) then
    raise exception 'Supply exactly one of p_to_thread_id or p_create_new=true';
  end if;
  perform public.lock_communication_thread_resolution(p_tenant_id);
  if p_reason_code not in ('wrong_person','wrong_project','wrong_topic','time_gap','channel_boundary','duplicate_thread','other') then
    raise exception 'Unknown thread correction reason';
  end if;
  if p_update_identity and p_person_id is null then raise exception 'Identity correction requires p_person_id'; end if;

  select * into communication from public.communications
   where tenant_id=p_tenant_id and communication_id=p_communication_id for update;
  if not found then raise exception 'Communication % not found',p_communication_id; end if;
  if p_person_id is not null and not exists(
    select 1 from public.contacts where tenant_id=p_tenant_id and id=p_person_id
  ) then raise exception 'Corrected person % not found',p_person_id; end if;
  if p_project_id is not null and not exists(
    select 1 from public.projects where tenant_id=p_tenant_id and id=p_project_id
  ) then raise exception 'Corrected project % not found',p_project_id; end if;
  if communication.thread_id is not null then
    select * into old_thread from public.communication_threads
     where tenant_id=p_tenant_id and thread_id=communication.thread_id;
  end if;

  if communication.purpose->>'type'='human_ask' then
    if communication.direction='outbound' then
      raise exception 'Outbound Ask communications must remain in their workflow thread';
    end if;
    if exists(select 1 from public.ask_bindings where tenant_id=p_tenant_id
      and ask_id=communication.purpose->>'ask_id' and status<>'open') then
      raise exception 'A terminal Ask association must be corrected by the workflow owner';
    end if;
  end if;

  if communication.source_table='calls' then
    select phone_number into communication_identity from public.calls
     where tenant_id=p_tenant_id and id=communication.source_id;
  elsif communication.source_table='sms_messages' then
    select t.phone_number into communication_identity from public.sms_messages m join public.sms_threads t
      on t.tenant_id=m.tenant_id and t.id=m.thread_id
     where m.tenant_id=p_tenant_id and m.id=communication.source_id;
  elsif communication.source_table='email_messages' then
    select case when communication.direction='outbound'
      then coalesce(to_addresses->0->>'address',case when jsonb_typeof(to_addresses->0)='string' then to_addresses->>0 end)
      else coalesce(from_addresses->0->>'address',case when jsonb_typeof(from_addresses->0)='string' then from_addresses->>0 end) end
      into communication_identity from public.email_messages
     where tenant_id=p_tenant_id and id=communication.source_id;
  elsif communication.source_table='recordings' then
    select coalesce(phone_number,participant_identities->0->>'identity_value') into communication_identity
      from public.recordings where tenant_id=p_tenant_id and id=communication.source_id;
  else
    communication_identity:=communication.metadata->>'participant_identity';
  end if;
  communication_identity:=coalesce(communication_identity,old_thread.participant_identity);

  if not p_create_new then
    select * into destination from public.communication_threads
     where tenant_id=p_tenant_id and thread_id=p_to_thread_id for update;
    if not found then raise exception 'Destination thread % not found',p_to_thread_id; end if;
    if destination.status <> 'open' then raise exception 'Destination thread % is not open',p_to_thread_id; end if;
    new_thread_id:=destination.thread_id;
    if p_project_id is not null and destination.project_id is not null and destination.project_id<>p_project_id then
      raise exception 'Corrected project conflicts with destination thread project';
    end if;
    if p_external_project_id is not null and destination.external_project_id is not null
       and destination.external_project_id<>p_external_project_id then
      raise exception 'Corrected external project conflicts with destination thread project';
    end if;
  else
    new_thread_id:=public.prefixed_id('thread');
  end if;

  -- A thread is a group, not proof that an unknown sender is its primary person.
  effective_person_id:=coalesce(p_person_id,communication.person_id,communication.contact_id);
  effective_project_id:=coalesce(p_project_id,destination.project_id,communication.project_id);
  effective_external_project_id:=coalesce(nullif(p_external_project_id,''),destination.external_project_id,
    communication.correlation->>'external_project_id',old_thread.external_project_id);
  corrected_correlation:=jsonb_strip_nulls(coalesce(communication.correlation,'{}')
    ||jsonb_build_object('thread_id',new_thread_id,'external_project_id',effective_external_project_id));
  corrected_purpose:=case when destination.purpose is not null then destination.purpose
    when communication.purpose->>'type'='human_ask' then null else communication.purpose end;
  if communication.purpose->>'type'='human_ask' and corrected_purpose is distinct from communication.purpose then
    corrected_correlation:=(corrected_correlation-'run_id'-'task_id')||coalesce(destination.correlation,'{}')
      ||jsonb_build_object('thread_id',new_thread_id);
  end if;
  corrected_resolution:=jsonb_build_object('type','thread_corrected','method','human_correction','confidence',1,
    'reason_code',p_reason_code,'corrected_at',now());

  if p_create_new then
    insert into public.communication_threads(
      tenant_id,thread_id,status,person_id,participant_identity,service_identity,purpose,correlation,
      project_id,external_project_id,primary_channel,last_channel,last_subject,last_activity_at,resolution_confidence,resolution_method
    ) values (
      p_tenant_id,new_thread_id,'open',effective_person_id,communication_identity,old_thread.service_identity,
      corrected_purpose,corrected_correlation,effective_project_id,effective_external_project_id,communication.channel,
      communication.channel,communication.subject,communication.occurred_at,1,'human_correction'
    ) returning * into destination;
  else
    update public.communication_threads set
      person_id=coalesce(person_id,effective_person_id),project_id=coalesce(project_id,effective_project_id),
      external_project_id=coalesce(external_project_id,effective_external_project_id),
      last_activity_at=greatest(last_activity_at,communication.occurred_at),
      last_channel=case when communication.occurred_at>=last_activity_at then communication.channel else last_channel end,
      last_subject=case when communication.occurred_at>=last_activity_at then coalesce(communication.subject,last_subject) else last_subject end,
      resolution_confidence=1,resolution_method='human_correction'
     where tenant_id=p_tenant_id and thread_id=new_thread_id returning * into destination;
  end if;

  delete from public.communication_thread_members
   where tenant_id=p_tenant_id and communication_row_id=communication.id and thread_id is distinct from new_thread_id;

  update public.communications set thread_id=new_thread_id,thread_link_type='corrected',
      person_id=effective_person_id,contact_id=effective_person_id,
      project_id=effective_project_id,correlation=corrected_correlation,purpose=corrected_purpose,
      resolution=corrected_resolution,updated_at=now()
   where tenant_id=p_tenant_id and id=communication.id;
  if communication.source_table='calls' then
    update public.calls set communication_thread_id=new_thread_id,thread_link_type='corrected',contact_id=effective_person_id,
      correlation=corrected_correlation,purpose=corrected_purpose
     where tenant_id=p_tenant_id and id=communication.source_id;
  elsif communication.source_table='sms_messages' then
    update public.sms_messages set communication_thread_id=new_thread_id,thread_link_type='corrected',correlation=corrected_correlation,
      person_id=effective_person_id,resolution=corrected_resolution,purpose=corrected_purpose
      where tenant_id=p_tenant_id and id=communication.source_id;
  elsif communication.source_table='email_messages' then
    update public.email_messages set thread_id=new_thread_id,person_id=effective_person_id,correlation=corrected_correlation,purpose=corrected_purpose
     where tenant_id=p_tenant_id and id=communication.source_id;
    -- A reply may contain only our opaque Reply-To address, without RFC reply
    -- headers. Move only routes recorded on this outbound message, never every
    -- route on the old thread. Expiry/revocation and receiving identity survive.
    if communication.direction='outbound' then
      update public.email_reply_routes r set thread_id=new_thread_id,person_id=effective_person_id,
        ask_id=case when corrected_purpose->>'type'='human_ask' then corrected_purpose->>'ask_id' end
       where r.tenant_id=p_tenant_id and exists(
        select 1 from public.email_messages m
        cross join lateral jsonb_array_elements(case when jsonb_typeof(m.reply_to_addresses)='array'
          then m.reply_to_addresses else '[]'::jsonb end) address
        where m.tenant_id=p_tenant_id and m.id=communication.source_id and m.service_identity_id=r.service_identity_id
          and r.token_hash=encode(sha256(convert_to((regexp_match(lower(btrim(coalesce(address->>'address',
            case when jsonb_typeof(address)='string' then address#>>'{}' end))),
            '^reply\+([a-z0-9_-]{20,})@[^@]+$'))[1],'UTF8')),'hex')
      );
    end if;
  elsif communication.source_table='recordings' then
    update public.recordings set communication_thread_id=new_thread_id,thread_link_type='corrected',
      contact_id=effective_person_id,project_id=effective_project_id,
      metadata=coalesce(metadata,'{}')||jsonb_build_object('correlation',corrected_correlation),
      resolution=corrected_resolution
     where tenant_id=p_tenant_id and id=communication.source_id;
  end if;

  if communication.thread_id is not null and communication.thread_id<>new_thread_id then
    update public.communication_threads t set
      last_activity_at=coalesce((select max(c.occurred_at) from public.communications c
        where c.tenant_id=p_tenant_id and c.thread_id=t.thread_id),t.created_at),
      last_channel=(select c.channel from public.communications c where c.tenant_id=p_tenant_id and c.thread_id=t.thread_id order by c.occurred_at desc limit 1),
      last_subject=(select c.subject from public.communications c where c.tenant_id=p_tenant_id and c.thread_id=t.thread_id order by c.occurred_at desc limit 1),
      status=case when coalesce(t.purpose->>'type','')<>'human_ask' and not exists(
        select 1 from public.communications c where c.tenant_id=p_tenant_id and c.thread_id=t.thread_id) then 'closed' else t.status end,
      resolution_method='human_correction_source'
     where t.tenant_id=p_tenant_id and t.thread_id=communication.thread_id;
  end if;

  if p_update_identity and nullif(communication_identity,'') is not null then
    update public.communication_identities set person_id=effective_person_id,updated_at=now()
      where tenant_id=p_tenant_id and normalized_value=public.normalize_communication_identity(communication_identity);
    if not found then
      insert into public.communication_identities(tenant_id,person_id,type,value,metadata)
      values(p_tenant_id,effective_person_id,case when position('@' in communication_identity)>0 then 'email'
        when public.normalize_communication_identity(communication_identity) ~ '^\+?[0-9]+$' then 'phone' else communication.channel end,
        communication_identity,jsonb_build_object('source','human_thread_correction','actor_id',p_actor_id));
    end if;
    update public.communication_thread_participants set person_id=effective_person_id
     where tenant_id=p_tenant_id and normalized_identity=public.normalize_communication_identity(communication_identity);
  end if;
  if nullif(communication_identity,'') is not null then
    insert into public.communication_thread_participants(
      tenant_id,thread_id,person_id,identity_value,normalized_identity,channel,role,first_seen_at,last_seen_at
    ) values (
      p_tenant_id,new_thread_id,effective_person_id,communication_identity,
      public.normalize_communication_identity(communication_identity),communication.channel,'participant',communication.occurred_at,communication.occurred_at
    ) on conflict(tenant_id,thread_id,channel,normalized_identity) do update set
      person_id=excluded.person_id,last_seen_at=greatest(public.communication_thread_participants.last_seen_at,excluded.last_seen_at);
  end if;

  -- Move the whole message's participant evidence, not just its first sender.
  -- Other communications in the source thread keep their own participants.
  insert into public.communication_thread_participants(
    tenant_id,thread_id,person_id,identity_value,normalized_identity,channel,role,first_seen_at,last_seen_at
  )
  select p_tenant_id,new_thread_id,p.person_id,p.identity_value,p.normalized_identity,p.channel,p.role,
         communication.occurred_at,communication.occurred_at
  from public.communication_thread_participants p
  where p.tenant_id=p_tenant_id and p.thread_id=communication.thread_id
    and p.normalized_identity is distinct from public.normalize_communication_identity(communication_identity)
    and exists(select 1 from jsonb_array_elements_text(coalesce(communication.metadata->'participant_identities','[]')) i(value)
      where public.normalize_communication_identity(i.value)=p.normalized_identity)
  on conflict(tenant_id,thread_id,channel,normalized_identity) do update set
    person_id=coalesce(excluded.person_id,public.communication_thread_participants.person_id),
    first_seen_at=least(excluded.first_seen_at,public.communication_thread_participants.first_seen_at),
    last_seen_at=greatest(excluded.last_seen_at,public.communication_thread_participants.last_seen_at);

  if communication.thread_id is not null and communication.thread_id<>new_thread_id then
    delete from public.communication_thread_participants p
    where p.tenant_id=p_tenant_id and p.thread_id=communication.thread_id and not exists(
      select 1 from public.communications c where c.tenant_id=p_tenant_id and c.thread_id=p.thread_id
      and ((p.person_id is not null and c.person_id=p.person_id)
        or public.normalize_communication_identity(c.metadata->>'participant_identity')=p.normalized_identity
        or exists(select 1 from jsonb_array_elements_text(coalesce(c.metadata->'participant_identities','[]')) i(value)
          where public.normalize_communication_identity(i.value)=p.normalized_identity))
    );
    update public.communication_threads t set
      person_id=case when exists(select 1 from public.communication_thread_participants p
        where p.tenant_id=p_tenant_id and p.thread_id=t.thread_id and p.person_id=t.person_id) then t.person_id
        else (select c.person_id from public.communications c where c.tenant_id=p_tenant_id and c.thread_id=t.thread_id
          and c.person_id is not null order by c.occurred_at desc limit 1) end,
      participant_identity=case when exists(select 1 from public.communication_thread_participants p
        where p.tenant_id=p_tenant_id and p.thread_id=t.thread_id
        and p.normalized_identity=public.normalize_communication_identity(t.participant_identity)) then t.participant_identity
        else (select p.identity_value from public.communication_thread_participants p where p.tenant_id=p_tenant_id
          and p.thread_id=t.thread_id order by p.last_seen_at desc limit 1) end
    where t.tenant_id=p_tenant_id and t.thread_id=communication.thread_id;
  end if;

  insert into public.thread_resolution_decisions(
    tenant_id,communication_id,selected_thread_id,action,method,confidence,score_margin,candidate_scores,input
  ) values (p_tenant_id,p_communication_id,new_thread_id,'corrected','human_correction',1,null,'[]',
    jsonb_build_object('reason_code',p_reason_code,'reason_detail',p_reason_detail)) returning resolution_id into decision_id;

  update public.thread_resolution_feedback set active=false
   where tenant_id=p_tenant_id and communication_id=p_communication_id and active=true;

  select coalesce(array_agg(term),'{}') into feedback_terms
  from (
    select distinct term
    from unnest(regexp_split_to_array(lower(coalesce(communication.subject,'')||' '||
      left(coalesce(communication.body_them,communication.body,''),1000)),'[^a-z0-9]+')) as words(term)
    where length(term)>=3 and term not in ('about','after','again','also','before','could','from','have','into',
      'just','please','that','the','their','there','they','this','with','would','your')
    order by term
    limit 20
  ) topic_words;

  insert into public.thread_resolution_feedback(
    tenant_id,communication_id,resolution_id,from_thread_id,to_thread_id,person_id,identity_value,normalized_identity,channel,
    external_project_id,project_id,topic_terms,reason_code,reason_detail,actor_id
  ) values (
    p_tenant_id,p_communication_id,decision_id,communication.thread_id,new_thread_id,effective_person_id,
    communication_identity,public.normalize_communication_identity(communication_identity),communication.channel,effective_external_project_id,effective_project_id,
    feedback_terms,
    p_reason_code,p_reason_detail,p_actor_id
  );

  return jsonb_build_object('communication_id',p_communication_id,'from_thread_id',communication.thread_id,
    'thread_id',new_thread_id,'person_id',effective_person_id,'project_id',effective_project_id,
    'external_project_id',effective_external_project_id,'resolution_id',decision_id,'corrected',true);
end $$;

-- Page threads and each thread's history independently. A busy thread must not
-- consume the global history limit and hide other threads' communications.
create or replace function public.read_communication_thread_register(
  p_tenant_id text,
  p_status text default 'open',
  p_person_id uuid default null,
  p_project_id uuid default null,
  p_external_project_id text default null,
  p_thread_id text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_communication_offset integer default 0
) returns jsonb language sql stable as $$
  with page as (
    select t.* from public.communication_threads t
    where t.tenant_id=p_tenant_id
      and (p_status='all' or t.status=p_status)
      and (p_thread_id is null or t.thread_id=p_thread_id)
      and (p_project_id is null or t.project_id=p_project_id)
      and (p_external_project_id is null or t.external_project_id=p_external_project_id)
      and (p_person_id is null or t.person_id=p_person_id or exists(
        select 1 from public.communication_thread_participants p
        where p.tenant_id=p_tenant_id and p.thread_id=t.thread_id and p.person_id=p_person_id))
    order by t.last_activity_at desc,t.thread_id desc
    limit least(200,greatest(1,p_limit))+1 offset greatest(0,p_offset)
  ), selected as (
    select * from page order by last_activity_at desc,thread_id desc limit least(200,greatest(1,p_limit))
  ), entries as (
    select t.last_activity_at,t.thread_id,to_jsonb(t)||jsonb_build_object(
      'participants',coalesce((select jsonb_agg(to_jsonb(p) order by p.last_seen_at desc)
        from public.communication_thread_participants p where p.tenant_id=p_tenant_id and p.thread_id=t.thread_id),'[]'),
      'communications',coalesce((select jsonb_agg(to_jsonb(c)) from (
        select communication_id,thread_id,channel,direction,person_id,project_id,occurred_at,subject,summary,left(body,2000) as body,resolution
        from public.communications where tenant_id=p_tenant_id and thread_id=t.thread_id
        order by occurred_at desc,communication_id desc limit 20 offset greatest(0,p_communication_offset)
      ) c),'[]'),
      'communications_count',(select count(*) from public.communications where tenant_id=p_tenant_id and thread_id=t.thread_id),
      'decisions',coalesce((select jsonb_agg(to_jsonb(d)) from (
        select * from public.thread_resolution_decisions where tenant_id=p_tenant_id and selected_thread_id=t.thread_id
        order by created_at desc,resolution_id desc limit 20
      ) d),'[]'),
      'corrections',coalesce((select jsonb_agg(to_jsonb(f)) from (
        select * from public.thread_resolution_feedback where tenant_id=p_tenant_id
          and (to_thread_id=t.thread_id or from_thread_id=t.thread_id)
        order by created_at desc,feedback_id desc limit 50
      ) f),'[]')
    ) as entry from selected t
  ) select jsonb_build_object(
    'data',coalesce((select jsonb_agg(entry order by last_activity_at desc,thread_id desc) from entries),'[]'),
    'count',(select count(*) from selected),
    'has_more',(select count(*) from page)>least(200,greatest(1,p_limit))
  );
$$;

create or replace function public.update_communication_thread_register(
  p_tenant_id text,
  p_thread_id text,
  p_patch jsonb,
  p_actor_id text default null
) returns jsonb language plpgsql as $$
declare
  target public.communication_threads%rowtype;
  updated public.communication_threads%rowtype;
  next_status text;
  next_project_id uuid;
  decision_id text;
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb then
    raise exception 'A non-empty register patch is required';
  end if;
  perform public.lock_communication_thread_resolution(p_tenant_id);
  if exists(select 1 from jsonb_object_keys(p_patch) as entries(key)
            where key not in ('title','summary','status','project_id','external_project_id')) then
    raise exception 'Register patch contains an unsupported field';
  end if;
  select * into target from public.communication_threads
   where tenant_id=p_tenant_id and thread_id=p_thread_id for update;
  if not found then raise exception 'Thread % not found',p_thread_id; end if;
  next_status:=case when p_patch ? 'status' then p_patch->>'status' else target.status end;
  if next_status not in ('open','resolved','closed') then raise exception 'Unknown thread status'; end if;
  if next_status<>target.status and target.purpose->>'type'='human_ask' then
    raise exception 'Human Ask thread status is controlled by the Ask lifecycle';
  end if;
  next_project_id:=case when p_patch ? 'project_id' then nullif(p_patch->>'project_id','')::uuid else target.project_id end;
  if next_project_id is not null and not exists(
    select 1 from public.projects where tenant_id=p_tenant_id and id=next_project_id
  ) then raise exception 'Project % not found',next_project_id; end if;

  update public.communication_threads set
    title=case when p_patch ? 'title' then nullif(p_patch->>'title','') else title end,
    summary=case when p_patch ? 'summary' then nullif(p_patch->>'summary','') else summary end,
    status=next_status,
    project_id=next_project_id,
    external_project_id=case when p_patch ? 'external_project_id' then nullif(p_patch->>'external_project_id','') else external_project_id end,
    correlation=case when p_patch ? 'external_project_id' then
      jsonb_strip_nulls(coalesce(correlation,'{}')||jsonb_build_object('external_project_id',nullif(p_patch->>'external_project_id','')))
      else correlation end,
    resolved_at=case when next_status='open' then null when next_status<>target.status then now() else resolved_at end,
    resolution_method='human_register_edit'
   where tenant_id=p_tenant_id and thread_id=p_thread_id returning * into updated;

  if p_patch ? 'project_id' or p_patch ? 'external_project_id' then
    update public.communications set
      project_id=case when p_patch ? 'project_id' then next_project_id else project_id end,
      correlation=case when p_patch ? 'external_project_id' then
        jsonb_strip_nulls(coalesce(correlation,'{}')||jsonb_build_object('external_project_id',updated.external_project_id))
        else correlation end,updated_at=now()
     where tenant_id=p_tenant_id and thread_id=p_thread_id;
    update public.calls set correlation=jsonb_strip_nulls(coalesce(correlation,'{}')
      ||jsonb_build_object('external_project_id',updated.external_project_id))
     where tenant_id=p_tenant_id and id in (
       select source_id from public.communications where tenant_id=p_tenant_id and thread_id=p_thread_id and source_table='calls');
    update public.sms_messages set correlation=jsonb_strip_nulls(coalesce(correlation,'{}')
      ||jsonb_build_object('external_project_id',updated.external_project_id))
     where tenant_id=p_tenant_id and id in (
       select source_id from public.communications where tenant_id=p_tenant_id and thread_id=p_thread_id and source_table='sms_messages');
    update public.email_messages set correlation=jsonb_strip_nulls(coalesce(correlation,'{}')
      ||jsonb_build_object('external_project_id',updated.external_project_id))
     where tenant_id=p_tenant_id and id in (
       select source_id from public.communications where tenant_id=p_tenant_id and thread_id=p_thread_id and source_table='email_messages');
    update public.recordings set
      project_id=case when p_patch ? 'project_id' then next_project_id else project_id end,
      metadata=case when p_patch ? 'external_project_id' then
        coalesce(metadata,'{}')||jsonb_build_object('correlation',
          jsonb_strip_nulls(coalesce(metadata->'correlation','{}')||jsonb_build_object('external_project_id',updated.external_project_id)))
        else metadata end
     where tenant_id=p_tenant_id and id in (
       select source_id from public.communications where tenant_id=p_tenant_id and thread_id=p_thread_id and source_table='recordings');
  end if;

  insert into public.thread_resolution_decisions(
    tenant_id,selected_thread_id,action,method,confidence,candidate_scores,input
  ) values (p_tenant_id,p_thread_id,'updated','human_register_edit',1,'[]',
    jsonb_build_object('patch',p_patch,'actor_id',p_actor_id)) returning resolution_id into decision_id;
  return to_jsonb(updated)||jsonb_build_object('resolution_id',decision_id,'updated',true);
end $$;

commit;

-- Communications Service v1 contract, durable events, channel identities and
-- explicit Ask-aware threads. Safe to run repeatedly after 001 and 002.

begin;

create or replace function public.prefixed_id(prefix text)
returns text language sql volatile as $$
  select prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

-- A contact is the service's current person record. Identities make phone a
-- channel address rather than the identity of the person themselves.
create table if not exists public.communication_identities (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.contacts(id) on delete cascade,
  type        text not null,
  value       text not null,
  provider    text,
  verified_at timestamptz,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (type, value, provider)
);
create index if not exists communication_identities_person
  on public.communication_identities(person_id);

insert into public.communication_identities (person_id, type, value, provider)
select id, 'phone', phone_number, 'twilio'
from public.contacts
where phone_number is not null and phone_number <> ''
on conflict (type, value, provider) do nothing;

create table if not exists public.communication_threads (
  thread_id            text primary key default public.prefixed_id('thread'),
  title                text,
  participant_identity text,
  service_identity     text,
  status               text not null default 'open' check (status in ('open', 'resolved', 'closed')),
  purpose              jsonb,
  correlation          jsonb not null default '{}',
  callback_url         text,
  summary              text,
  created_at           timestamptz not null default now(),
  last_activity_at     timestamptz not null default now(),
  resolved_at          timestamptz,
  check (purpose is null or jsonb_typeof(purpose) = 'object')
);
create index if not exists communication_threads_participant_open
  on public.communication_threads(participant_identity, last_activity_at desc)
  where status = 'open';

create table if not exists public.ask_bindings (
  ask_id        text primary key,
  thread_id     text not null references public.communication_threads(thread_id) on delete cascade,
  tenant_id     text,
  status        text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  purpose       jsonb not null,
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (purpose->>'type' = 'human_ask' and nullif(purpose->>'ask_id', '') is not null)
);

alter table public.communications add column if not exists communication_id text;
alter table public.communications add column if not exists provider text;
alter table public.communications add column if not exists provider_id text;
alter table public.communications add column if not exists person_id uuid references public.contacts(id) on delete set null;
alter table public.communications add column if not exists purpose jsonb;
alter table public.communications add column if not exists correlation jsonb not null default '{}';
alter table public.communications add column if not exists thread_id text references public.communication_threads(thread_id) on delete set null;
alter table public.communications add column if not exists thread_link_type text check (thread_link_type in ('native','explicit','inferred'));
alter table public.communications add column if not exists resolution jsonb;

update public.communications
set communication_id = public.prefixed_id('comm')
where communication_id is null;
update public.communications set person_id = contact_id where person_id is null and contact_id is not null;
update public.communications
set provider = case when channel in ('call', 'sms') then 'twilio' else provider end,
    provider_id = coalesce(provider_id, metadata->>'twilio_call_sid', metadata->>'twilio_message_sid', metadata->>'external_id')
where provider is null or provider_id is null;

alter table public.communications alter column communication_id set default public.prefixed_id('comm');
alter table public.communications alter column communication_id set not null;
create unique index if not exists communications_public_id_unique on public.communications(communication_id);
create index if not exists communications_thread on public.communications(thread_id, occurred_at);
create index if not exists communications_purpose_ask
  on public.communications((purpose->>'ask_id')) where purpose->>'type' = 'human_ask';

do $$ begin
  alter table public.communications add constraint communications_purpose_shape check (
    purpose is null or (
      jsonb_typeof(purpose) = 'object'
      and nullif(purpose->>'type', '') is not null
      and (purpose->>'type' <> 'human_ask' or nullif(purpose->>'ask_id', '') is not null)
    )
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.communication_thread_members (
  thread_id        text not null references public.communication_threads(thread_id) on delete cascade,
  communication_id uuid not null references public.communications(id) on delete cascade,
  confidence       real not null default 1 check (confidence >= 0 and confidence <= 1),
  link_type        text not null default 'explicit' check (link_type in ('native', 'explicit', 'inferred')),
  created_at       timestamptz not null default now(),
  primary key (thread_id, communication_id)
);

create table if not exists public.outbound_events (
  event_id         text primary key default public.prefixed_id('evt'),
  communication_id text,
  type             text not null,
  destination      text not null,
  payload          jsonb not null,
  attempts         int not null default 0,
  status           text not null default 'pending' check (status in ('pending', 'retrying', 'delivered', 'failed')),
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index if not exists outbound_events_due
  on public.outbound_events(status, next_attempt_at) where status in ('pending', 'retrying');

-- Hyperflow calls this only after its resolver decides a communication truly
-- answers the Ask. One transaction marks exactly that communication, binding
-- and thread; a follow-up question can never partially close the workflow.
create or replace function public.resolve_communication_ask(p_ask_id text, p_communication_id text)
returns jsonb language plpgsql as $$
declare
  binding public.ask_bindings%rowtype;
  communication public.communications%rowtype;
  resolved_at timestamptz := now();
begin
  select * into binding from public.ask_bindings where ask_id = p_ask_id for update;
  if not found then raise exception 'Ask % is not bound to a communication thread', p_ask_id; end if;
  if binding.status = 'resolved' then raise exception 'Ask % is already resolved', p_ask_id; end if;

  select * into communication from public.communications where communication_id = p_communication_id;
  if not found or communication.thread_id is distinct from binding.thread_id then
    raise exception 'Communication % is not in Ask % thread', p_communication_id, p_ask_id;
  end if;

  update public.communications
     set resolution = jsonb_build_object('type','ask_resolved','ask_id',p_ask_id,'resolved_at',resolved_at),
         updated_at = resolved_at
   where communication_id = p_communication_id;
  update public.ask_bindings
     set status='resolved', resolved_by=p_communication_id, resolved_at=resolved_at, updated_at=resolved_at
   where ask_id=p_ask_id;
  update public.communication_threads
     set status='resolved', resolved_at=resolved_at, last_activity_at=greatest(last_activity_at,resolved_at)
   where thread_id=binding.thread_id;

  return jsonb_build_object('ask_id',p_ask_id,'status','resolved','communication_id',p_communication_id,
                            'thread_id',binding.thread_id,'resolved_at',resolved_at);
end $$;

-- Carry the canonical contract on the provider source rows so projection is
-- lossless and provider SIDs never become the public identity.
alter table if exists public.calls add column if not exists communication_id text default public.prefixed_id('comm');
alter table if exists public.calls add column if not exists purpose jsonb;
alter table if exists public.calls add column if not exists correlation jsonb not null default '{}';
alter table if exists public.calls add column if not exists communication_thread_id text references public.communication_threads(thread_id) on delete set null;
alter table if exists public.calls add column if not exists thread_link_type text check (thread_link_type in ('native','explicit','inferred'));

alter table if exists public.sms_messages add column if not exists communication_id text default public.prefixed_id('comm');
alter table if exists public.sms_messages add column if not exists purpose jsonb;
alter table if exists public.sms_messages add column if not exists correlation jsonb not null default '{}';
alter table if exists public.sms_messages add column if not exists communication_thread_id text references public.communication_threads(thread_id) on delete set null;
alter table if exists public.sms_messages add column if not exists thread_link_type text check (thread_link_type in ('native','explicit','inferred'));

create or replace function public.link_communication_thread()
returns trigger language plpgsql as $$
begin
  if new.thread_id is null then return new; end if;

  insert into public.communication_thread_members(thread_id, communication_id, confidence, link_type)
  values (new.thread_id, new.id, case when new.thread_link_type='inferred' then 0.8 else 1 end,
          coalesce(new.thread_link_type,'explicit'))
  on conflict (thread_id, communication_id) do update
    set confidence=excluded.confidence, link_type=excluded.link_type;

  update public.communication_threads
     set last_activity_at = greatest(last_activity_at, new.occurred_at),
         purpose = coalesce(new.purpose, purpose),
         correlation = correlation || coalesce(new.correlation, '{}'::jsonb)
   where thread_id = new.thread_id;

  if new.purpose->>'type' = 'human_ask' then
    insert into public.ask_bindings(ask_id, thread_id, tenant_id, purpose)
    values (new.purpose->>'ask_id', new.thread_id, new.correlation->>'tenant_id', new.purpose)
    on conflict (ask_id) do update
      set thread_id = excluded.thread_id, purpose = excluded.purpose,
          tenant_id = coalesce(excluded.tenant_id, public.ask_bindings.tenant_id), updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists communications_link_thread on public.communications;
create trigger communications_link_thread
  after insert or update of thread_id, thread_link_type, purpose, correlation on public.communications
  for each row execute function public.link_communication_thread();

create or replace function public.project_call_to_communications()
returns trigger language plpgsql as $$
declare flat text; spoke text;
begin
  select string_agg(coalesce(seg->>'role','unknown') || ': ' || coalesce(seg->>'text',''), E'\n' order by ord),
         string_agg(coalesce(seg->>'text',''), E'\n' order by ord) filter (where seg->>'role' = 'user')
    into flat, spoke
    from jsonb_array_elements(coalesce(new.transcript->'segments','[]'::jsonb)) with ordinality as t(seg,ord);

  insert into public.communications
    (communication_id, channel, source_table, source_id, contact_id, person_id, occurred_at, direction,
     body, body_them, summary, provider, provider_id, purpose, correlation, thread_id, thread_link_type, metadata)
  values
    (coalesce(new.communication_id, public.prefixed_id('comm')), 'voice', 'calls', new.id, new.contact_id, new.contact_id,
     coalesce(new.started_at,now()), new.direction, flat, spoke, new.summary, 'twilio', new.twilio_call_sid,
     new.purpose, new.correlation, new.communication_thread_id, new.thread_link_type,
     coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object('twilio_call_sid',new.twilio_call_sid,'status',new.status))
  on conflict (source_table, source_id) do update set
    communication_id=excluded.communication_id, contact_id=excluded.contact_id, person_id=excluded.person_id,
    occurred_at=excluded.occurred_at, direction=excluded.direction, body=excluded.body, body_them=excluded.body_them,
    summary=excluded.summary, provider=excluded.provider, provider_id=excluded.provider_id, purpose=excluded.purpose,
    correlation=excluded.correlation, thread_id=excluded.thread_id, thread_link_type=excluded.thread_link_type,
    metadata=excluded.metadata, updated_at=now();
  return new;
exception when others then
  raise warning 'communications projection failed for call %: %', new.id, sqlerrm; return new;
end $$;

drop trigger if exists calls_to_communications on public.calls;
create trigger calls_to_communications
  after insert or update of transcript, summary, contact_id, started_at, status, purpose, correlation, communication_thread_id, thread_link_type on public.calls
  for each row execute function public.project_call_to_communications();

create or replace function public.project_sms_to_communications()
returns trigger language plpgsql as $$
declare who uuid;
begin
  select contact_id into who from public.sms_threads where id = new.thread_id;
  insert into public.communications
    (communication_id, channel, source_table, source_id, contact_id, person_id, occurred_at, direction,
     body, body_them, provider, provider_id, purpose, correlation, thread_id, thread_link_type, metadata)
  values
    (coalesce(new.communication_id, public.prefixed_id('comm')), 'sms', 'sms_messages', new.id, who, who,
     coalesce(new.created_at,now()), new.direction, new.content,
     case when new.direction='inbound' then new.content else null end,
     'twilio', new.twilio_message_sid, new.purpose, new.correlation, new.communication_thread_id, new.thread_link_type,
     jsonb_build_object('twilio_message_sid',new.twilio_message_sid,'status',new.status))
  on conflict (source_table, source_id) do update set
    communication_id=excluded.communication_id, contact_id=excluded.contact_id, person_id=excluded.person_id,
    occurred_at=excluded.occurred_at, direction=excluded.direction, body=excluded.body, body_them=excluded.body_them,
    provider=excluded.provider, provider_id=excluded.provider_id, purpose=excluded.purpose,
    correlation=excluded.correlation, thread_id=excluded.thread_id, thread_link_type=excluded.thread_link_type,
    metadata=excluded.metadata, updated_at=now();
  return new;
exception when others then
  raise warning 'communications projection failed for sms %: %', new.id, sqlerrm; return new;
end $$;

drop trigger if exists sms_to_communications on public.sms_messages;
create trigger sms_to_communications
  after insert or update of content, thread_id, created_at, status, purpose, correlation, communication_thread_id, thread_link_type on public.sms_messages
  for each row execute function public.project_sms_to_communications();

alter table public.communication_identities enable row level security;
alter table public.communication_threads enable row level security;
alter table public.communication_thread_members enable row level security;
alter table public.ask_bindings enable row level security;
alter table public.outbound_events enable row level security;

-- Re-project existing provider rows with their new canonical IDs.
update public.calls set status = status;
update public.sms_messages set content = content;

commit;

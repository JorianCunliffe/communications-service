-- One searchable row per communication, whatever channel produced it.
--
-- Why this exists: searching used to run in process over the newest N turns,
-- so anything older could not be found at all - not ranked low, invisible.
-- That is survivable with forty calls and useless once history is every email
-- and document between two parties. Matching moves into Postgres, where
-- contact, project, date and text become one query with one index behind it.
--
-- Apply with: Supabase dashboard -> SQL Editor -> paste -> Run.
-- Safe to run more than once; every statement is guarded.

begin;

-- --------------------------------------------------------------------------
-- 1. Entity resolution
-- --------------------------------------------------------------------------

-- "Bruce" is a name, not an identifier. Trigram search returns candidates so
-- two Bruces can be disambiguated out loud, rather than the closest match
-- being picked silently and the wrong history being read out.
create extension if not exists pg_trgm;
create index if not exists contacts_name_trgm on public.contacts using gin (name gin_trgm_ops);

-- Who may ask across contacts, rather than only about their own history.
--
-- Caller ID is spoofable. This is a convenience boundary, not a secret-keeping
-- one, and it should not be the only thing standing between a stranger and
-- your correspondence.
alter table public.contacts add column if not exists is_principal boolean not null default false;

-- --------------------------------------------------------------------------
-- 2. Projects
-- --------------------------------------------------------------------------

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- What it is actually called out loud: 'Arkendeith', 'the subdivision',
  -- 'lot 42'. Used when nothing more explicit ties a conversation to it.
  aliases     text[] not null default '{}',
  status      text not null default 'active',
  description text,
  started_at  timestamptz,
  ended_at    timestamptz,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists projects_name_unique on public.projects (lower(name));
create index if not exists projects_name_trgm on public.projects using gin (name gin_trgm_ops);

create table if not exists public.project_contacts (
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  role       text,
  created_at timestamptz not null default now(),
  primary key (project_id, contact_id)
);

-- --------------------------------------------------------------------------
-- 3. The search surface
-- --------------------------------------------------------------------------

create table if not exists public.communications (
  id           uuid primary key default gen_random_uuid(),
  channel      text not null,               -- call | sms | recording | email | slack
  -- Back to the row this came from, so anything surprising is traceable to a
  -- source rather than guessed at.
  source_table text not null,
  source_id    uuid not null,
  contact_id   uuid references public.contacts(id) on delete set null,
  project_id   uuid references public.projects(id) on delete set null,
  -- Which rule attached it: explicit | contact | alias. A wrong association
  -- should be explainable, not mysterious.
  project_link_reason text,
  occurred_at  timestamptz not null,
  direction    text,
  subject      text,                        -- email subject, call headline
  body         text,                        -- flattened transcript / message text
  summary      text,
  metadata     jsonb not null default '{}',
  -- Weighted: a hit in a summary means more than a passing mention halfway
  -- through a transcript, and ts_rank uses these.
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body,    '')), 'C')
  ) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per source row, so re-projecting the same call is an update rather
-- than a duplicate. This is what makes the backfill and the triggers safe to
-- run repeatedly.
create unique index if not exists communications_source_unique
  on public.communications (source_table, source_id);
create index if not exists communications_search   on public.communications using gin (search);
create index if not exists communications_contact  on public.communications (contact_id, occurred_at desc);
create index if not exists communications_project  on public.communications (project_id, occurred_at desc);
create index if not exists communications_occurred on public.communications (occurred_at desc);

alter table public.projects         enable row level security;
alter table public.project_contacts enable row level security;
alter table public.communications   enable row level security;

-- --------------------------------------------------------------------------
-- 4. Attaching a communication to a project
-- --------------------------------------------------------------------------

-- Three rules in priority order, and the row records which one caught it.
--   explicit - something set project_id deliberately
--   contact  - the other party belongs to exactly one project
--   alias    - the text names the project
--
-- "Exactly one" matters: a contact on three projects tells us nothing about
-- which one a given call was about, and guessing would attach real
-- conversations to the wrong job.
create or replace function public.attach_communication_project()
returns trigger language plpgsql as $$
declare
  found_id uuid;
  member_of int;
  haystack text;
begin
  if new.project_id is not null then
    new.project_link_reason := coalesce(new.project_link_reason, 'explicit');
    return new;
  end if;

  if new.contact_id is not null then
    select count(*) into member_of
      from public.project_contacts where contact_id = new.contact_id;

    if member_of = 1 then
      select project_id into found_id
        from public.project_contacts where contact_id = new.contact_id;
      new.project_id := found_id;
      new.project_link_reason := 'contact';
      return new;
    end if;
  end if;

  haystack := coalesce(new.subject, '') || ' ' || coalesce(new.summary, '') || ' ' || coalesce(new.body, '');

  select p.id into found_id
    from public.projects p
   where p.status = 'active'
     and exists (
       select 1
         from unnest(array_append(p.aliases, p.name)) as alias
        where alias <> ''
          -- escaped, so an alias containing % or _ matches literally
          and haystack ilike '%' || replace(replace(alias, '%', '\%'), '_', '\_') || '%'
     )
   limit 1;

  if found_id is not null then
    new.project_id := found_id;
    new.project_link_reason := 'alias';
  end if;

  return new;
end $$;

drop trigger if exists communications_attach_project on public.communications;
create trigger communications_attach_project
  before insert or update on public.communications
  for each row execute function public.attach_communication_project();

-- --------------------------------------------------------------------------
-- 5. Projecting the existing tables in
-- --------------------------------------------------------------------------
--
-- Triggers rather than application code, so the search surface cannot go stale
-- when something other than the app writes - a backfill, the management API,
-- or a hand-edit in the dashboard.
--
-- Note for the call path: these fire on writes to public.calls, which happen
-- while a call is live. They are after-row, operate on one small array, and do
-- no I/O. Worth knowing they are there all the same.

create or replace function public.project_call_to_communications()
returns trigger language plpgsql as $$
declare
  flat text;
begin
  select string_agg(
           coalesce(seg->>'role', 'unknown') || ': ' || coalesce(seg->>'text', ''),
           E'\n' order by ord)
    into flat
    from jsonb_array_elements(coalesce(new.transcript->'segments', '[]'::jsonb))
         with ordinality as t(seg, ord);

  insert into public.communications
    (channel, source_table, source_id, contact_id, occurred_at, direction, body, summary, metadata)
  values
    ('call', 'calls', new.id, new.contact_id, coalesce(new.started_at, now()), new.direction,
     flat, new.summary,
     jsonb_build_object('twilio_call_sid', new.twilio_call_sid, 'status', new.status))
  on conflict (source_table, source_id) do update
     set contact_id  = excluded.contact_id,
         occurred_at = excluded.occurred_at,
         direction   = excluded.direction,
         body        = excluded.body,
         summary     = excluded.summary,
         metadata    = excluded.metadata,
         updated_at  = now();
  return new;
end $$;

drop trigger if exists calls_to_communications on public.calls;
create trigger calls_to_communications
  after insert or update of transcript, summary, contact_id, started_at, status on public.calls
  for each row execute function public.project_call_to_communications();

create or replace function public.project_sms_to_communications()
returns trigger language plpgsql as $$
declare
  who uuid;
begin
  -- A message carries no phone number of its own; the thread holds the party.
  select contact_id into who from public.sms_threads where id = new.thread_id;

  insert into public.communications
    (channel, source_table, source_id, contact_id, occurred_at, direction, body, metadata)
  values
    ('sms', 'sms_messages', new.id, who, coalesce(new.created_at, now()), new.direction,
     new.content, jsonb_build_object('twilio_message_sid', new.twilio_message_sid))
  on conflict (source_table, source_id) do update
     set contact_id  = excluded.contact_id,
         occurred_at = excluded.occurred_at,
         direction   = excluded.direction,
         body        = excluded.body,
         updated_at  = now();
  return new;
end $$;

drop trigger if exists sms_to_communications on public.sms_messages;
create trigger sms_to_communications
  after insert or update of content, thread_id, created_at on public.sms_messages
  for each row execute function public.project_sms_to_communications();

create or replace function public.project_recording_to_communications()
returns trigger language plpgsql as $$
declare
  flat text;
begin
  -- A recording attached to a call was already projected onto that call, so
  -- indexing it again would return everything twice.
  if new.call_id is not null then return new; end if;
  if new.status is distinct from 'done' then return new; end if;

  select string_agg(
           coalesce(seg->>'role', 'unknown') || ': ' || coalesce(seg->>'text', ''),
           E'\n' order by ord)
    into flat
    from jsonb_array_elements(coalesce(new.transcript->'segments', '[]'::jsonb))
         with ordinality as t(seg, ord);

  insert into public.communications
    (channel, source_table, source_id, contact_id, occurred_at, body, metadata)
  values
    ('recording', 'recordings', new.id, new.contact_id,
     coalesce(new.recorded_at, new.created_at, now()),
     coalesce(flat, new.transcript_text),
     jsonb_build_object('source', new.source, 'external_id', new.external_id))
  on conflict (source_table, source_id) do update
     set contact_id  = excluded.contact_id,
         occurred_at = excluded.occurred_at,
         body        = excluded.body,
         metadata    = excluded.metadata,
         updated_at  = now();
  return new;
end $$;

drop trigger if exists recordings_to_communications on public.recordings;
create trigger recordings_to_communications
  after insert or update of transcript, transcript_text, status, contact_id on public.recordings
  for each row execute function public.project_recording_to_communications();

-- --------------------------------------------------------------------------
-- 6. Backfill
-- --------------------------------------------------------------------------
-- Re-saving each row makes its trigger fire, which keeps one definition of how
-- a row becomes a communication rather than a second copy of the logic here
-- that could drift from it.

-- Each column named here must appear in its trigger's UPDATE OF list, or the
-- write happens and the trigger never fires. calls has no updated_at column,
-- so status stands in.
update public.calls        set status  = status;
update public.sms_messages set content = content;
update public.recordings   set status  = status;

commit;

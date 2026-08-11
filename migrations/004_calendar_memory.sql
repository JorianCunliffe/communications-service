-- Calendar context and recording correlation for Communications Memory v2.
-- Apply after 003. Safe to run repeatedly.

begin;

create table if not exists public.calendar_events (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null,
  provider_id             text not null,
  title                   text not null,
  description             text,
  starts_at               timestamptz not null,
  ends_at                 timestamptz,
  location                text,
  organiser_contact_id    uuid references public.contacts(id) on delete set null,
  project_id              uuid references public.projects(id) on delete set null,
  communication_thread_id text references public.communication_threads(thread_id) on delete set null,
  metadata                jsonb not null default '{}',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (provider, provider_id),
  check (ends_at is null or ends_at >= starts_at)
);
create index if not exists calendar_events_time on public.calendar_events(starts_at, ends_at);
create index if not exists calendar_events_project on public.calendar_events(project_id, starts_at desc);
create index if not exists calendar_events_thread on public.calendar_events(communication_thread_id, starts_at desc);

create table if not exists public.calendar_event_participants (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.calendar_events(id) on delete cascade,
  contact_id      uuid references public.contacts(id) on delete set null,
  identity_type   text,
  identity_value  text,
  response_status text,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (contact_id is not null or nullif(identity_value, '') is not null)
);
create unique index if not exists calendar_participant_identity_unique
  on public.calendar_event_participants(event_id, coalesce(identity_type, ''), coalesce(identity_value, ''), coalesce(contact_id::text, ''));
create index if not exists calendar_participants_contact on public.calendar_event_participants(contact_id, event_id);

alter table public.communications add column if not exists calendar_event_id uuid references public.calendar_events(id) on delete set null;
create index if not exists communications_calendar_event on public.communications(calendar_event_id, occurred_at desc);

alter table public.recordings add column if not exists communication_id text default public.prefixed_id('comm');
update public.recordings set communication_id=public.prefixed_id('comm') where communication_id is null;
alter table public.recordings alter column communication_id set not null;
create unique index if not exists recordings_communication_id_unique on public.recordings(communication_id);
alter table public.recordings add column if not exists participant_identities jsonb not null default '[]'::jsonb;
alter table public.recordings add column if not exists calendar_event_id uuid references public.calendar_events(id) on delete set null;
alter table public.recordings add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.recordings add column if not exists communication_thread_id text references public.communication_threads(thread_id) on delete set null;
alter table public.recordings add column if not exists title text;
alter table public.recordings add column if not exists meeting_type text;

-- Preserve first-class recording relationships when the existing queue
-- projects a completed external recording into canonical communications.
create or replace function public.project_recording_to_communications()
returns trigger language plpgsql as $$
declare flat text; spoke text; merged_correlation jsonb;
begin
  if new.call_id is not null then return new; end if;
  if new.status is distinct from 'done' then return new; end if;

  select string_agg(coalesce(seg->>'role','unknown') || ': ' || coalesce(seg->>'text',''), E'\n' order by ord),
         string_agg(coalesce(seg->>'text',''), E'\n' order by ord) filter (where seg->>'role' = 'user')
    into flat, spoke
    from jsonb_array_elements(coalesce(new.transcript->'segments','[]'::jsonb)) with ordinality as t(seg,ord);

  merged_correlation := coalesce(new.metadata->'correlation', '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
         'project_id', new.project_id,
         'thread_id', new.communication_thread_id,
         'calendar_event_id', new.calendar_event_id));

  insert into public.communications
    (communication_id, channel, source_table, source_id, contact_id, person_id, project_id,
     calendar_event_id, occurred_at, subject, body, body_them, provider, provider_id,
     correlation, thread_id, thread_link_type, metadata)
  values
    (coalesce(new.communication_id, public.prefixed_id('comm')), 'recording', 'recordings', new.id,
     new.contact_id, new.contact_id, new.project_id, new.calendar_event_id,
     coalesce(new.recorded_at,new.created_at,now()), new.title, coalesce(flat,new.transcript_text), spoke,
     new.source, new.external_id, merged_correlation, new.communication_thread_id,
     case when new.communication_thread_id is null then null else 'explicit' end,
     coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
       'source',new.source,'external_id',new.external_id,'participants',new.participant_identities,
       'meeting_type',new.meeting_type))
  on conflict (source_table, source_id) do update set
    communication_id=excluded.communication_id, contact_id=excluded.contact_id, person_id=excluded.person_id,
    project_id=excluded.project_id, calendar_event_id=excluded.calendar_event_id,
    occurred_at=excluded.occurred_at, subject=excluded.subject, body=excluded.body, body_them=excluded.body_them,
    provider=excluded.provider, provider_id=excluded.provider_id, correlation=excluded.correlation,
    thread_id=excluded.thread_id, thread_link_type=excluded.thread_link_type,
    metadata=excluded.metadata, updated_at=now();
  return new;
exception when others then
  raise warning 'communications projection failed for recording %: %', new.id, sqlerrm; return new;
end $$;

drop trigger if exists recordings_to_communications on public.recordings;
create trigger recordings_to_communications
  after insert or update of transcript, transcript_text, status, contact_id, participant_identities,
    calendar_event_id, project_id, communication_thread_id, title, meeting_type on public.recordings
  for each row execute function public.project_recording_to_communications();

alter table public.calendar_events enable row level security;
alter table public.calendar_event_participants enable row level security;

update public.recordings set status = status where status = 'done';

commit;

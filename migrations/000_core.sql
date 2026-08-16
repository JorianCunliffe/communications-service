-- Core Communications Service tables.
--
-- This migration makes a blank PostgreSQL database, including Replit's
-- managed PostgreSQL database, ready for migrations 001 through 007. It is
-- intentionally provider-neutral and safe to run repeatedly.

begin;

create extension if not exists pgcrypto;

create table if not exists public.contacts (
  id               uuid primary key default gen_random_uuid(),
  name             text,
  phone_number     text,
  email            text,
  whatsapp_number text,
  slack_id         text,
  combined_history text,
  do_not_contact   boolean not null default false,
  tags             text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists contacts_phone_number_unique
  on public.contacts(phone_number);
create index if not exists contacts_email on public.contacts(lower(email));

create table if not exists public.contact_config (
  id                         uuid primary key default gen_random_uuid(),
  contact_id                 uuid not null unique references public.contacts(id) on delete cascade,
  name                       text,
  model                      text,
  effort                     text,
  call_voice                 text,
  temperature                real,
  call_system_prompt         text,
  inbound_call_prompt        text,
  outbound_call_prompt       text,
  play_intro                 boolean,
  intro_message              text,
  intro_message_2            text,
  intro_voice                text,
  call_greeting              text,
  inbound_call_greeting      text,
  outbound_call_greeting     text,
  ai_speaks_first            boolean,
  inbound_ai_speaks_first    boolean,
  outbound_ai_speaks_first   boolean,
  assistant_name             text,
  enabled_tools              text[],
  inbound_enabled_tools      text[],
  outbound_enabled_tools     text[],
  live_transcript_enabled    boolean,
  call_recording_enabled     boolean,
  summarise_enabled          boolean,
  history_limit              integer,
  history_max_chars          integer,
  history_days               integer,
  max_call_seconds           integer,
  wrap_up_seconds            integer,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists public.phone_configs (
  id                         uuid primary key default gen_random_uuid(),
  twilio_number              text not null unique,
  name                       text,
  call_enabled               boolean not null default true,
  model                      text,
  effort                     text,
  call_voice                 text,
  temperature                real,
  call_system_prompt         text,
  inbound_call_prompt        text,
  outbound_call_prompt       text,
  play_intro                 boolean,
  intro_message              text,
  intro_message_2            text,
  intro_voice                text,
  call_greeting              text,
  inbound_call_greeting      text,
  outbound_call_greeting     text,
  ai_speaks_first            boolean,
  inbound_ai_speaks_first    boolean,
  outbound_ai_speaks_first   boolean,
  assistant_name             text,
  enabled_tools              text[],
  inbound_enabled_tools      text[],
  outbound_enabled_tools     text[],
  live_transcript_enabled    boolean,
  call_recording_enabled     boolean,
  summarise_enabled          boolean,
  history_limit              integer,
  history_max_chars          integer,
  history_days               integer,
  max_call_seconds           integer,
  wrap_up_seconds            integer,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists public.calls (
  id                   uuid primary key default gen_random_uuid(),
  twilio_call_sid      text not null unique,
  contact_id           uuid references public.contacts(id) on delete set null,
  phone_number         text not null,
  direction            text,
  status               text,
  system_prompt        text,
  metadata             jsonb not null default '{}',
  transcript           jsonb,
  summary              text,
  started_at           timestamptz not null default now(),
  ended_at             timestamptz,
  duration_seconds     integer,
  transcription_status text,
  transcription_error text,
  recording_sid        text,
  recording_status     text,
  created_at           timestamptz not null default now()
);
create index if not exists calls_contact_started on public.calls(contact_id, started_at desc);
create index if not exists calls_phone_started on public.calls(phone_number, started_at desc);

create table if not exists public.sms_threads (
  id              uuid primary key default gen_random_uuid(),
  phone_number    text not null,
  twilio_number   text not null,
  contact_id      uuid references public.contacts(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (phone_number, twilio_number)
);
create index if not exists sms_threads_contact on public.sms_threads(contact_id, last_message_at desc);

create table if not exists public.sms_messages (
  id                 uuid primary key default gen_random_uuid(),
  thread_id          uuid not null references public.sms_threads(id) on delete cascade,
  twilio_message_sid text unique,
  direction          text,
  role               text,
  content            text not null,
  status             text,
  created_at         timestamptz not null default now()
);
create index if not exists sms_messages_thread_created on public.sms_messages(thread_id, created_at);

create table if not exists public.tool_calls (
  id               uuid primary key default gen_random_uuid(),
  call_id          uuid references public.calls(id) on delete cascade,
  twilio_call_sid  text,
  openai_call_id   text,
  tool_name        text not null,
  arguments        jsonb,
  result           jsonb,
  error            text,
  duration_ms      integer,
  created_at       timestamptz not null default now()
);
create index if not exists tool_calls_call on public.tool_calls(call_id, created_at);

create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  source           text not null,
  external_id      text,
  call_id          uuid references public.calls(id) on delete set null,
  contact_id       uuid references public.contacts(id) on delete set null,
  phone_number     text,
  media_url        text,
  media_auth       text,
  duration_seconds integer,
  channels         integer,
  recorded_at      timestamptz,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  error            text,
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  transcript       jsonb,
  transcript_text  text,
  provider         text,
  model            text,
  bytes            bigint,
  content_type     text,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists recordings_due on public.recordings(status, next_attempt_at);
create index if not exists recordings_contact on public.recordings(contact_id, recorded_at desc);

-- Supabase exposes the public schema through PostgREST, so new core tables
-- fail closed there. The service uses the service role. A direct PostgreSQL
-- connection created and migrated by the owning Replit role bypasses RLS.
alter table public.contacts       enable row level security;
alter table public.contact_config enable row level security;
alter table public.phone_configs  enable row level security;
alter table public.calls          enable row level security;
alter table public.sms_threads    enable row level security;
alter table public.sms_messages   enable row level security;
alter table public.tool_calls     enable row level security;
alter table public.recordings     enable row level security;

commit;

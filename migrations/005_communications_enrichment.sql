-- Durable memory enrichment, facts and commitments. Apply after 004.

begin;

alter table public.communication_threads add column if not exists summary_updated_at timestamptz;
alter table public.communication_threads add column if not exists summary_source_ids text[] not null default '{}';
alter table public.communication_threads add column if not exists current_state text;
alter table public.communication_threads add column if not exists current_state_updated_at timestamptz;
alter table public.communication_threads add column if not exists current_state_source_ids text[] not null default '{}';
alter table public.communication_threads add column if not exists outstanding_dependency text;
alter table public.communication_threads add column if not exists outstanding_source_ids text[] not null default '{}';

create table if not exists public.communication_commitments (
  id                  uuid primary key default gen_random_uuid(),
  communication_id    text not null,
  thread_id           text references public.communication_threads(thread_id) on delete set null,
  promisor_contact_id uuid references public.contacts(id) on delete set null,
  promisee_contact_id uuid references public.contacts(id) on delete set null,
  description         text not null,
  due_at              timestamptz,
  status              text not null default 'open' check (status in ('open','completed','cancelled','superseded','unknown')),
  confidence          real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_excerpt      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  unique (communication_id, description)
);
create index if not exists communication_commitments_open on public.communication_commitments(status, due_at) where status='open';
create index if not exists communication_commitments_thread on public.communication_commitments(thread_id, updated_at desc);

create table if not exists public.communication_facts (
  id                       uuid primary key default gen_random_uuid(),
  fact_key                 text not null,
  text                     text not null,
  contact_id               uuid references public.contacts(id) on delete set null,
  project_id               uuid references public.projects(id) on delete set null,
  thread_id                text references public.communication_threads(thread_id) on delete set null,
  source_communication_ids text[] not null,
  confidence               real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status                   text not null default 'active' check (status in ('active','superseded','retracted')),
  superseded_by            uuid references public.communication_facts(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (cardinality(source_communication_ids) > 0)
);
create index if not exists communication_facts_active on public.communication_facts(status, updated_at desc) where status='active';
create index if not exists communication_facts_thread on public.communication_facts(thread_id, updated_at desc);
create index if not exists communication_facts_project on public.communication_facts(project_id, updated_at desc);
create index if not exists communication_facts_contact on public.communication_facts(contact_id, updated_at desc);

create table if not exists public.communication_enrichment_jobs (
  id               uuid primary key default gen_random_uuid(),
  communication_id text not null,
  job_type         text not null default 'memory',
  status           text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  rerun_requested  boolean not null default false,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  unique (communication_id, job_type)
);
alter table public.communication_enrichment_jobs add column if not exists rerun_requested boolean not null default false;
create index if not exists communication_enrichment_due
  on public.communication_enrichment_jobs(status, next_attempt_at) where status in ('pending','processing');

-- Queue enrichment beside the canonical projection. Exceptions are swallowed:
-- a broken secondary queue may never abort raw communication persistence.
create or replace function public.queue_communication_enrichment()
returns trigger language plpgsql as $$
begin
  if nullif(coalesce(new.body, new.summary, ''), '') is null then return new; end if;
  insert into public.communication_enrichment_jobs(communication_id, job_type, status, next_attempt_at, updated_at)
  values (new.communication_id, 'memory', 'pending', now(), now())
  on conflict (communication_id, job_type) do update
    set status=case when public.communication_enrichment_jobs.status='processing' then 'processing' else 'pending' end,
        rerun_requested=case when public.communication_enrichment_jobs.status='processing' then true else false end,
        attempts=case when public.communication_enrichment_jobs.status='processing' then public.communication_enrichment_jobs.attempts else 0 end,
        last_error=null, next_attempt_at=now(), updated_at=now();
  return new;
exception when others then
  raise warning 'could not queue enrichment for %: %', new.communication_id, sqlerrm; return new;
end $$;

drop trigger if exists communications_queue_enrichment on public.communications;
create trigger communications_queue_enrichment
  after insert or update of body, summary on public.communications
  for each row execute function public.queue_communication_enrichment();

alter table public.communication_commitments enable row level security;
alter table public.communication_facts enable row level security;
alter table public.communication_enrichment_jobs enable row level security;

insert into public.communication_enrichment_jobs(communication_id)
select communication_id from public.communications where nullif(coalesce(body, summary, ''), '') is not null
on conflict (communication_id, job_type) do nothing;

commit;

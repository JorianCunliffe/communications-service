-- Separate provider completion from a verified human communication outcome.
-- Failed voice attempts remain auditable but cannot feed semantic memory.

begin;

alter table public.calls add column if not exists answered_by text;
alter table public.calls add column if not exists business_status text not null default 'pending';
alter table public.calls add column if not exists disposition text;
alter table public.calls add column if not exists successful boolean;
alter table public.calls add column if not exists memory_eligible boolean not null default false;
alter table public.calls add column if not exists failure_code text;
alter table public.calls add column if not exists failure_reason text;
alter table public.calls add column if not exists outcome_source text;
alter table public.calls add column if not exists outcome_confidence real;
alter table public.calls add column if not exists outcome_evidence text;
alter table public.calls add column if not exists outcome_detected_at timestamptz;
alter table public.calls add column if not exists terminal_event_id text;
alter table public.calls add column if not exists terminal_event_type text;
alter table public.calls add column if not exists terminal_event_emitted_at timestamptz;
alter table public.calls add column if not exists history_recorded_at timestamptz;

alter table public.calls drop constraint if exists calls_business_status_check;
alter table public.calls add constraint calls_business_status_check check (business_status in ('pending','success','failed'));
alter table public.calls drop constraint if exists calls_disposition_check;
alter table public.calls add constraint calls_disposition_check check (disposition is null or disposition in (
  'human_completed','voicemail','wrong_number','no_answer','busy','fax','automated_system',
  'no_meaningful_response','provider_failed','canceled','unclassified'
));
alter table public.calls drop constraint if exists calls_outcome_confidence_check;
alter table public.calls add constraint calls_outcome_confidence_check check (
  outcome_confidence is null or (outcome_confidence >= 0 and outcome_confidence <= 1)
);
create index if not exists calls_business_outcome on public.calls(business_status,disposition,started_at desc);

alter table public.communications add column if not exists business_status text;
alter table public.communications add column if not exists disposition text;
alter table public.communications add column if not exists successful boolean;
alter table public.communications add column if not exists memory_eligible boolean not null default true;
alter table public.communications add column if not exists failure_code text;
alter table public.communications add column if not exists failure_reason text;
alter table public.communications add column if not exists outcome_source text;
alter table public.communications add column if not exists outcome_confidence real;
alter table public.communications add column if not exists outcome_detected_at timestamptz;
create index if not exists communications_memory_eligible on public.communications(memory_eligible,occurred_at desc);
create index if not exists communications_disposition on public.communications(disposition,occurred_at desc);

alter table public.outbound_events add column if not exists dedupe_key text;
create unique index if not exists outbound_events_dedupe_unique on public.outbound_events(dedupe_key);

create table if not exists public.call_outcome_jobs (
  id               uuid primary key default gen_random_uuid(),
  call_id          uuid not null unique references public.calls(id) on delete cascade,
  status           text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  rerun_requested  boolean not null default false,
  last_error       text,
  lease_token      uuid,
  lease_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index if not exists call_outcome_jobs_due on public.call_outcome_jobs(status,next_attempt_at)
  where status in ('pending','processing');
alter table public.call_outcome_jobs enable row level security;

create or replace function public.queue_call_outcome_finalization()
returns trigger language plpgsql as $$
begin
  if new.status not in ('completed','busy','failed','no-answer','canceled')
     or coalesce(new.business_status,'pending') <> 'pending' then
    return new;
  end if;
  insert into public.call_outcome_jobs(call_id,status,next_attempt_at,updated_at)
  values(new.id,'pending',now(),now())
  on conflict(call_id) do update set
    status=case when public.call_outcome_jobs.status='processing' then 'processing' else 'pending' end,
    rerun_requested=public.call_outcome_jobs.status='processing',
    attempts=case when public.call_outcome_jobs.status='processing' then public.call_outcome_jobs.attempts else 0 end,
    last_error=null,next_attempt_at=now(),updated_at=now();
  return new;
exception when others then
  raise warning 'could not queue call outcome for %: %',new.id,sqlerrm;
  return new;
end $$;

drop trigger if exists calls_queue_outcome on public.calls;
create trigger calls_queue_outcome
  after insert or update of status,transcript,transcription_status,answered_by,business_status on public.calls
  for each row execute function public.queue_call_outcome_finalization();

create or replace function public.claim_call_outcome_job(p_lease_seconds int default 120)
returns setof public.call_outcome_jobs language plpgsql as $$
begin
  return query with candidate as (
    select id from public.call_outcome_jobs
     where status in ('pending','processing') and next_attempt_at<=now()
       and (lease_expires_at is null or lease_expires_at<now())
     order by next_attempt_at for update skip locked limit 1
  ) update public.call_outcome_jobs j set
      status='processing',claimed_at=now(),attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      rerun_requested=false,updated_at=now()
    from candidate c where j.id=c.id returning j.*;
end $$;

-- Project provider calls into the canonical cross-channel table, including the
-- business outcome used by APIs and memory eligibility guards.
create or replace function public.project_call_to_communications()
returns trigger language plpgsql as $$
declare flat text; spoke text;
begin
  select string_agg(coalesce(seg->>'role','unknown') || ': ' || coalesce(seg->>'text',''), E'\n' order by ord),
         string_agg(coalesce(seg->>'text',''), E'\n' order by ord) filter (where seg->>'role' in ('user','caller','customer','participant'))
    into flat, spoke
    from jsonb_array_elements(coalesce(new.transcript->'segments','[]'::jsonb)) with ordinality as t(seg,ord);

  insert into public.communications
    (communication_id,channel,source_table,source_id,contact_id,person_id,occurred_at,direction,
     body,body_them,summary,provider,provider_id,purpose,correlation,thread_id,thread_link_type,metadata,
     business_status,disposition,successful,memory_eligible,failure_code,failure_reason,outcome_source,
     outcome_confidence,outcome_detected_at)
  values
    (coalesce(new.communication_id,public.prefixed_id('comm')),'voice','calls',new.id,new.contact_id,new.contact_id,
     coalesce(new.started_at,now()),new.direction,flat,spoke,new.summary,'twilio',new.twilio_call_sid,
     new.purpose,new.correlation,new.communication_thread_id,new.thread_link_type,
     coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object('twilio_call_sid',new.twilio_call_sid,'provider_status',new.status,'answered_by',new.answered_by),
     new.business_status,new.disposition,new.successful,new.memory_eligible,new.failure_code,new.failure_reason,
     new.outcome_source,new.outcome_confidence,new.outcome_detected_at)
  on conflict(source_table,source_id) do update set
    communication_id=excluded.communication_id,contact_id=excluded.contact_id,person_id=excluded.person_id,
    occurred_at=excluded.occurred_at,direction=excluded.direction,body=excluded.body,body_them=excluded.body_them,
    summary=excluded.summary,provider=excluded.provider,provider_id=excluded.provider_id,purpose=excluded.purpose,
    correlation=excluded.correlation,thread_id=excluded.thread_id,thread_link_type=excluded.thread_link_type,
    metadata=excluded.metadata,business_status=excluded.business_status,disposition=excluded.disposition,
    successful=excluded.successful,memory_eligible=excluded.memory_eligible,failure_code=excluded.failure_code,
    failure_reason=excluded.failure_reason,outcome_source=excluded.outcome_source,
    outcome_confidence=excluded.outcome_confidence,outcome_detected_at=excluded.outcome_detected_at,updated_at=now();
  return new;
exception when others then
  raise warning 'communications projection failed for call %: %',new.id,sqlerrm;
  return new;
end $$;

drop trigger if exists calls_to_communications on public.calls;
create trigger calls_to_communications
  after insert or update of transcript,summary,contact_id,started_at,status,purpose,correlation,
    communication_thread_id,thread_link_type,business_status,disposition,successful,memory_eligible,
    failure_code,failure_reason,outcome_source,outcome_confidence,outcome_detected_at,answered_by on public.calls
  for each row execute function public.project_call_to_communications();

-- Conservative historical backfill. Provider failures and obvious failed-call
-- transcripts are excluded immediately. Every other completed call stays
-- pending and is reclassified by the same durable worker as a new call; a
-- historical transcript is never declared successful merely because it exists.
update public.calls set
  business_status='failed',successful=false,memory_eligible=false,
  disposition=case
    when status='busy' then 'busy' when status='no-answer' then 'no_answer'
    when status='canceled' then 'canceled' else 'provider_failed' end,
  failure_code=case
    when status='busy' then 'busy' when status='no-answer' then 'no_answer'
    when status='canceled' then 'canceled' else 'provider_failed' end,
  failure_reason='Historical provider failure',outcome_source='historical_backfill',outcome_confidence=1,summary=null,
  outcome_detected_at=coalesce(ended_at,now())
where status in ('busy','failed','no-answer','canceled') and business_status='pending';

update public.calls set
  business_status='failed',successful=false,memory_eligible=false,
  disposition=case when transcript::text ~* 'wrong number|got the wrong|called the wrong' then 'wrong_number' else 'voicemail' end,
  failure_code=case when transcript::text ~* 'wrong number|got the wrong|called the wrong' then 'wrong_number' else 'voicemail' end,
  failure_reason='Historical transcript matched a failed-call safety rule',outcome_source='historical_backfill',summary=null,
  outcome_confidence=0.98,outcome_detected_at=coalesce(ended_at,now())
where status='completed' and business_status='pending'
  and transcript::text ~* 'message bank|mailbox.{0,20}full|voice.?mail|leave.{0,20}message|after the (tone|beep)|wrong number|got the wrong|called the wrong';

-- Refresh every canonical voice projection with the new outcome columns.
-- This also queues unresolved completed calls for durable classification.
update public.calls set status=status;

alter table public.communication_enrichment_jobs add column if not exists skip_reason text;

create or replace function public.queue_communication_enrichment()
returns trigger language plpgsql as $$
declare job_scope text:=coalesce(new.thread_id,new.communication_id);
begin
  if new.memory_eligible is not true or nullif(coalesce(new.body,new.summary,''),'') is null then return new; end if;
  insert into public.communication_enrichment_jobs(communication_id,scope_key,job_type,status,next_attempt_at,updated_at,skip_reason)
  values(new.communication_id,job_scope,'memory','pending',now(),now(),null)
  on conflict(scope_key,job_type) where scope_key is not null do update set communication_id=excluded.communication_id,
    status=case when public.communication_enrichment_jobs.status='processing' then 'processing' else 'pending' end,
    rerun_requested=public.communication_enrichment_jobs.status='processing',attempts=case when public.communication_enrichment_jobs.status='processing' then public.communication_enrichment_jobs.attempts else 0 end,
    last_error=null,skip_reason=null,next_attempt_at=now(),updated_at=now();
  return new;
exception when others then raise warning 'could not queue enrichment for %: %',new.communication_id,sqlerrm; return new;
end $$;

create or replace function public.requeue_communication_enrichment(p_communication_id text)
returns jsonb language plpgsql as $$
declare communication public.communications%rowtype; job public.communication_enrichment_jobs%rowtype; job_scope text;
begin
  select * into communication from public.communications where communication_id=p_communication_id;
  if not found then raise exception 'Communication % not found',p_communication_id; end if;
  if communication.memory_eligible is not true then raise exception 'Communication % is not eligible for memory enrichment',p_communication_id; end if;
  job_scope:=coalesce(communication.thread_id,communication.communication_id);
  insert into public.communication_enrichment_jobs(communication_id,scope_key,job_type,status,next_attempt_at,updated_at,skip_reason)
  values(p_communication_id,job_scope,'memory','pending',now(),now(),null)
  on conflict(scope_key,job_type) where scope_key is not null do update set communication_id=excluded.communication_id,status='pending',attempts=0,
    last_error=null,skip_reason=null,rerun_requested=false,next_attempt_at=now(),updated_at=now(),lease_token=null,lease_expires_at=null
  returning * into job;
  return to_jsonb(job);
end $$;

-- Remove failed calls from every derived-memory surface while preserving the
-- raw communication and transcript for operational audit.
update public.communication_enrichment_jobs j set
  status='done',completed_at=coalesce(completed_at,now()),skip_reason='memory_ineligible',
  lease_token=null,lease_expires_at=null,updated_at=now()
from public.communications c where c.communication_id=j.communication_id and c.memory_eligible is not true;

update public.communication_commitments k set status='cancelled',resolved_at=coalesce(resolved_at,now()),updated_at=now()
from public.communications c where c.communication_id=k.communication_id and c.memory_eligible is not true
  and k.status in ('open','unknown');

update public.communication_facts f set status='retracted',updated_at=now()
where f.status='active' and not exists (
  select 1 from unnest(f.source_communication_ids) as sources(source_communication_id)
  join public.communications c on c.communication_id=sources.source_communication_id
  where c.memory_eligible is true
);

update public.communication_facts f set
  source_communication_ids=array(
    select sources.source_communication_id
    from unnest(f.source_communication_ids) as sources(source_communication_id)
    join public.communications c on c.communication_id=sources.source_communication_id
    where c.memory_eligible is true
  ),updated_at=now()
where exists (
  select 1 from unnest(f.source_communication_ids) as sources(source_communication_id)
  join public.communications c on c.communication_id=sources.source_communication_id
  where c.memory_eligible is not true
) and exists (
  select 1 from unnest(f.source_communication_ids) as sources(source_communication_id)
  join public.communications c on c.communication_id=sources.source_communication_id
  where c.memory_eligible is true
);

update public.communication_threads t set
  summary=null,summary_updated_at=null,summary_source_ids='{}',
  current_state=null,current_state_updated_at=null,current_state_source_ids='{}',
  outstanding_dependency=null,outstanding_source_ids='{}'
where exists (
  select 1
  from unnest(t.summary_source_ids || t.current_state_source_ids || t.outstanding_source_ids) as sources(source_communication_id)
  join public.communications c on c.communication_id=sources.source_communication_id
  where c.memory_eligible is not true
);

-- Legacy call history lines predate source IDs, so a voicemail line cannot be
-- removed surgically. Remove call lines for contacts with historical calls;
-- the outcome worker rebuilds bounded lines only for verified successful calls.
update public.contacts p set combined_history=nullif(btrim(regexp_replace(
  coalesce(p.combined_history,''),'(^|\n)[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]+call[[:space:]]+[^\n]*','','g'
)), '')
where exists (select 1 from public.calls c where c.contact_id=p.id);

insert into public.communication_enrichment_jobs(communication_id,scope_key,job_type,status,next_attempt_at,updated_at)
select distinct on (c.thread_id) c.communication_id,c.thread_id,'memory','pending',now(),now()
from public.communications c
where c.thread_id is not null and c.memory_eligible is true and nullif(coalesce(c.body,c.summary,''),'') is not null
order by c.thread_id,c.occurred_at desc
on conflict(scope_key,job_type) where scope_key is not null do update set
  communication_id=excluded.communication_id,status='pending',attempts=0,last_error=null,skip_reason=null,
  rerun_requested=false,next_attempt_at=now(),updated_at=now(),lease_token=null,lease_expires_at=null;

-- Memory search is semantic, so ineligible audit-only communications are never
-- returned or used to expand a thread.
drop function if exists public.search_communications(text,uuid,uuid,timestamptz,timestamptz,text[],int,real,text,uuid);
create or replace function public.search_communications(
  q text default null,contact uuid default null,project uuid default null,since timestamptz default null,
  until timestamptz default null,channels text[] default null,max_results int default 5,fuzzy_threshold real default 0.35,
  thread text default null,calendar_event uuid default null
)
returns table (
  id uuid,communication_id text,channel text,occurred_at timestamptz,direction text,contact_id uuid,project_id uuid,
  thread_id text,calendar_event_id uuid,subject text,summary text,body text,rank real,matched_by text
)
language plpgsql stable as $$
declare cleaned text; tsq tsquery;
begin
  cleaned:=lower(coalesce(q,''));
  cleaned:=regexp_replace(cleaned,'([0-9]),([0-9])','\1\2','g');
  cleaned:=btrim(regexp_replace(regexp_replace(cleaned,'[^a-z0-9 ]',' ','g'),'\s+',' ','g'));
  if cleaned<>'' then select to_tsquery('english',string_agg(w || ':*','|')) into tsq
    from unnest(string_to_array(cleaned,' ')) as w where w<>'' and length(w)>1; end if;
  perform set_config('pg_trgm.word_similarity_threshold',fuzzy_threshold::text,true);
  return query select * from (
    select c.id,c.communication_id,c.channel,c.occurred_at,c.direction,c.contact_id,c.project_id,c.thread_id,
      c.calendar_event_id,c.subject,c.summary,c.body,
      (coalesce(ts_rank(c.search,tsq,1),0)+coalesce(word_similarity(cleaned,coalesce(c.body_them,c.body,'')),0)*0.05)::real as rank,
      case when tsq is null then 'filter' when c.search@@tsq and cleaned <% coalesce(c.body,'') then 'both'
        when c.search@@tsq then 'text' else 'fuzzy' end as matched_by
    from public.communications c where c.memory_eligible is true
      and (contact is null or c.contact_id=contact) and (project is null or c.project_id=project)
      and (thread is null or c.thread_id=thread) and (calendar_event is null or c.calendar_event_id=calendar_event)
      and (since is null or c.occurred_at>=since) and (until is null or c.occurred_at<until)
      and (channels is null or c.channel=any(channels))
      and (tsq is null or c.search@@tsq or cleaned <% coalesce(c.body,''))
  ) hit order by hit.rank desc,hit.occurred_at desc
  limit greatest(1,least(coalesce(max_results,5),100));
end $$;

commit;

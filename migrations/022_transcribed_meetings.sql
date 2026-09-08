-- Extend the existing recording store with revision receipts and topic recordings.
-- Generated with the Supabase CLI, named for this repository's ordered runner.
begin;

create unique index if not exists recordings_tenant_row_unique on public.recordings(tenant_id,id);
create table if not exists public.recording_revisions (
  tenant_id text not null references public.tenants(tenant_id),
  recording_id uuid not null,
  version integer not null check(version>0),
  source_version text not null,
  fingerprint text not null,
  payload jsonb not null,
  actor text not null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,recording_id,version),
  unique(tenant_id,recording_id,source_version),
  foreign key(tenant_id,recording_id) references public.recordings(tenant_id,id) on delete cascade
);
create index if not exists recording_revisions_fingerprint on public.recording_revisions(tenant_id,fingerprint);
alter table public.recording_revisions enable row level security;

create or replace function public.ingest_transcribed_meeting(p_tenant_id text,p_meeting jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare
  head public.recordings%rowtype; child public.recordings%rowtype;
  prior public.recording_revisions%rowtype;
  topic jsonb; current_version integer; next_version integer;
  topic_thread text; existing_thread text; existing_project text;
  topics jsonb:='[]'::jsonb; duplicate_ids jsonb; metadata_value jsonb;
  child_external text; kept_ids uuid[]:='{}'; removed public.recordings%rowtype;
begin
  if nullif(p_tenant_id,'') is null or nullif(p_meeting->>'key','') is null
     or jsonb_array_length(p_meeting->'topics') not between 1 and 20 then raise exception 'Invalid meeting input'; end if;
  -- Serialize bounded imports within a tenant, including cross-provider duplicate checks.
  perform pg_advisory_xact_lock(hashtext('meeting-import:'||p_tenant_id));
  select * into head from public.recordings where tenant_id=p_tenant_id
    and source='meeting_transcript' and external_id='meeting:'||(p_meeting->>'key') for update;
  current_version:=coalesce((head.metadata->>'version')::integer,0);
  if jsonb_typeof(p_meeting->'allowedProjectIds')='array' and (
    exists(select 1 from jsonb_array_elements(p_meeting->'topics') t where not ((p_meeting->'allowedProjectIds') ? (t->>'projectId')))
    or exists(select 1 from jsonb_array_elements(coalesce(head.metadata->'topics','[]'::jsonb)) t where not ((p_meeting->'allowedProjectIds') ? (t->>'projectId')))
  ) then raise exception 'Meeting project scope changed or is inaccessible'; end if;
  if head.id is not null then
    select * into prior from public.recording_revisions where tenant_id=p_tenant_id
      and recording_id=head.id and source_version=p_meeting->>'sourceVersion';
    if prior.recording_id is not null then
      if prior.fingerprint<>p_meeting->>'fingerprint' then raise exception 'Provider version already has different content'; end if;
      return jsonb_build_object('id',head.id,'version',current_version,'duplicate',true,'recordedVersion',prior.version);
    end if;
  end if;
  if current_version<>coalesce((p_meeting->>'expectedVersion')::integer,0) then raise exception 'Meeting version changed; reload before correction'; end if;
  select jsonb_agg(recording_id) into duplicate_ids from (
    select distinct r.recording_id from public.recording_revisions r where r.tenant_id=p_tenant_id
      and r.fingerprint=p_meeting->>'fingerprint' and (head.id is null or r.recording_id<>head.id) limit 10
  ) matches;
  if duplicate_ids is not null and not (coalesce(p_meeting->>'duplicateDecision','')='separate' and length(coalesce(p_meeting->>'duplicateReason',''))>0) then
    return jsonb_build_object('status','needs_duplicate_review','matches',duplicate_ids);
  end if;
  next_version:=current_version+1;
  if head.id is null then
    insert into public.recordings(tenant_id,source,external_id,status,title,recorded_at,metadata)
    values(p_tenant_id,'meeting_transcript','meeting:'||(p_meeting->>'key'),'skipped',p_meeting->>'title',
      (p_meeting->>'occurredAt')::timestamptz,jsonb_build_object('kind','meeting_manifest')) returning * into head;
  end if;
  for topic in select value from jsonb_array_elements(p_meeting->'topics') loop
    child_external:=head.id::text||':topic:'||(topic->>'id');
    select * into child from public.recordings where tenant_id=p_tenant_id and source='meeting_transcript' and external_id=child_external for update;
    existing_thread:=null; existing_project:=null;
    if child.id is not null then
      select c.thread_id,c.correlation->>'external_project_id' into existing_thread,existing_project
        from public.communications c where c.tenant_id=p_tenant_id and c.communication_id=child.communication_id;
      if existing_project is distinct from topic->>'projectId' then raise exception 'Topic project changed; use the audited thread correction route'; end if;
      if nullif(topic->>'threadId','') is not null and existing_thread is distinct from topic->>'threadId' then
        raise exception 'Topic thread changed; use the audited thread correction route'; end if;
    end if;
    topic_thread:=coalesce(existing_thread,nullif(topic->>'threadId',''));
    if topic_thread is not null then
      if not exists(select 1 from public.communication_threads t where t.tenant_id=p_tenant_id and t.thread_id=topic_thread
        and t.external_project_id=topic->>'projectId' and (t.status='open' or child.id is not null)) then
        raise exception 'Thread is not available in the topic project'; end if;
    else
      topic_thread:=public.prefixed_id('thread');
      insert into public.communication_threads(tenant_id,thread_id,title,external_project_id,primary_channel,last_channel,correlation,resolution_method)
      values(p_tenant_id,topic_thread,topic->>'title',topic->>'projectId','recording','recording',
        jsonb_build_object('external_project_id',topic->>'projectId'),'meeting_topic');
    end if;
    metadata_value:=jsonb_build_object('kind','meeting_topic','meeting_id',head.id,'topic_id',topic->>'id','meeting_version',next_version,
      'source',p_meeting->>'source','source_version',p_meeting->>'sourceVersion','references',p_meeting->'references',
      'visibility',p_meeting->>'visibility','private',p_meeting->>'visibility'='private',
      'correlation',jsonb_build_object('external_project_id',topic->>'projectId','thread_id',topic_thread));
    if child.id is null then
      insert into public.recordings(tenant_id,source,external_id,status,title,recorded_at,transcript,transcript_text,
        provider,participant_identities,communication_thread_id,thread_link_type,calendar_event_id,metadata)
      values(p_tenant_id,'meeting_transcript',child_external,'done',topic->>'title',(p_meeting->>'occurredAt')::timestamptz,
        topic->'transcript',topic->>'transcriptText',p_meeting->>'source',p_meeting->'attendees',topic_thread,'explicit',(p_meeting->>'calendarEventId')::uuid,metadata_value)
      returning * into child;
    else
      update public.recordings set status='done',title=topic->>'title',recorded_at=(p_meeting->>'occurredAt')::timestamptz,
        transcript=topic->'transcript',transcript_text=topic->>'transcriptText',provider=p_meeting->>'source',
        participant_identities=p_meeting->'attendees',communication_thread_id=topic_thread,calendar_event_id=(p_meeting->>'calendarEventId')::uuid,metadata=metadata_value,updated_at=now()
      where tenant_id=p_tenant_id and id=child.id returning * into child;
    end if;
    -- The legacy projection trigger catches errors; an atomic ingest must not silently succeed without evidence.
    if not exists(select 1 from public.communications c where c.tenant_id=p_tenant_id and c.communication_id=child.communication_id
      and c.thread_id=topic_thread and c.metadata->>'meeting_version'=next_version::text) then raise exception 'Meeting evidence projection failed'; end if;
    -- Incoming source material is evidence for proposals, never verified speaker identity.
    -- Preserve the producer's speaker labels rather than flattening every line to 'unknown'.
    update public.communications set memory_eligible=true,direction='inbound',
      body=topic->>'transcriptText',body_them=null,updated_at=now()
      where tenant_id=p_tenant_id and communication_id=child.communication_id;
    kept_ids:=array_append(kept_ids,child.id);
    topics:=topics||jsonb_build_array(topic||jsonb_build_object('recordingId',child.id,'communicationId',child.communication_id,'threadId',topic_thread));
  end loop;
  for removed in select * from public.recordings where tenant_id=p_tenant_id and metadata->>'meeting_id'=head.id::text and not(id=any(kept_ids)) loop
    update public.recordings set status='skipped',metadata=metadata||jsonb_build_object('retracted',true),updated_at=now()
      where tenant_id=p_tenant_id and id=removed.id;
    update public.communications set memory_eligible=false,metadata=metadata||jsonb_build_object('retracted',true),updated_at=now()
      where tenant_id=p_tenant_id and communication_id=removed.communication_id;
  end loop;
  metadata_value:=p_meeting||jsonb_build_object('kind','meeting_manifest','version',next_version,'topics',topics);
  update public.recordings set title=p_meeting->>'title',recorded_at=(p_meeting->>'occurredAt')::timestamptz,metadata=metadata_value,updated_at=now()
    where tenant_id=p_tenant_id and id=head.id;
  insert into public.recording_revisions(tenant_id,recording_id,version,source_version,fingerprint,payload,actor)
    values(p_tenant_id,head.id,next_version,p_meeting->>'sourceVersion',p_meeting->>'fingerprint',metadata_value,p_meeting->>'actor');
  return jsonb_build_object('id',head.id,'version',next_version,'duplicate',false,'topics',topics);
end $$;
revoke all on function public.ingest_transcribed_meeting(text,jsonb) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant all on public.recording_revisions to service_role;
    grant execute on function public.ingest_transcribed_meeting(text,jsonb) to service_role;
  end if;
end $$;
commit;

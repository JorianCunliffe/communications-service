begin;
create or replace function public.ingest_calendar_event(p_tenant_id text,p_event jsonb)
returns jsonb language plpgsql as $$
declare stored public.calendar_events%rowtype; participant jsonb; participant_rows jsonb:='[]'; person uuid; inserted public.calendar_event_participants%rowtype;
begin
  if nullif(p_event->>'projectId','') is not null and not exists(select 1 from public.projects where tenant_id=p_tenant_id and id=(p_event->>'projectId')::uuid) then raise exception 'Calendar project is outside tenant'; end if;
  if nullif(p_event->>'organiserContactId','') is not null and not exists(select 1 from public.contacts where tenant_id=p_tenant_id and id=(p_event->>'organiserContactId')::uuid) then raise exception 'Calendar organiser is outside tenant'; end if;
  if nullif(p_event->>'threadId','') is not null and not exists(select 1 from public.communication_threads where tenant_id=p_tenant_id and thread_id=p_event->>'threadId') then raise exception 'Calendar thread is outside tenant'; end if;
  -- Serialize all observations of one tenant/provider event, including its participant snapshot.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id || ':' || (p_event->>'provider') || ':' || (p_event->>'providerId'),0));
  select * into stored from public.calendar_events where tenant_id=p_tenant_id and provider=p_event->>'provider' and provider_id=p_event->>'providerId';
  if stored.id is not null and stored.metadata->>'observed_at' is not null then
    if p_event->'metadata'->>'observed_at' is null then
      raise exception 'A versioned calendar observation requires observed_at';
    end if;
    if (stored.metadata->>'observed_at')::timestamptz >= (p_event->'metadata'->>'observed_at')::timestamptz then
      select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) into participant_rows from public.calendar_event_participants p where p.tenant_id=p_tenant_id and p.event_id=stored.id;
      return jsonb_build_object('event',to_jsonb(stored),'participants',participant_rows,'stale',true);
    end if;
  end if;
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
    if person is not null and not exists(select 1 from public.contacts where tenant_id=p_tenant_id and id=person) then raise exception 'Calendar participant is outside tenant'; end if;
    if person is null then
      select min(person_id::text)::uuid into person from public.communication_identities where tenant_id=p_tenant_id
       and type=lower(coalesce(participant->>'identityType',participant->>'identity_type',participant->>'type'))
       and normalized_value=lower(trim(coalesce(participant->>'identityValue',participant->>'identity_value',participant->>'value',participant->>'email',participant->>'phone')))
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
commit;

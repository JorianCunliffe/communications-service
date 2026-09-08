-- Phase 02: additive correction safeguards; keep migration 019 immutable.
begin;

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
  if effective_project_id is distinct from communication.project_id
     or effective_external_project_id is distinct from coalesce(communication.correlation->>'external_project_id',old_thread.external_project_id) then
    if p_reason_code <> 'wrong_project' then
      raise exception 'Cross-project correction requires the wrong_project reason';
    end if;
    if communication.purpose->>'type'='human_ask' or communication.correlation ? 'run_id' or communication.correlation ? 'task_id' then
      raise exception 'Workflow-bound project changes require the workflow owner';
    end if;
  end if;
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

  if next_project_id is distinct from target.project_id
     or (p_patch ? 'external_project_id' and nullif(p_patch->>'external_project_id','') is distinct from target.external_project_id) then
    if target.purpose->>'type'='human_ask' or exists (
      select 1 from public.communications where tenant_id=p_tenant_id and thread_id=p_thread_id
      and (purpose->>'type'='human_ask' or correlation ? 'run_id' or correlation ? 'task_id')
    ) then raise exception 'Workflow-bound project changes require the workflow owner'; end if;
  end if;
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

begin;
create or replace function public.mutate_promise(p_tenant_id text,p_id uuid,p_revision integer,p_actor text,p_action text,p_reason text,p_patch jsonb,p_destination text default null)
returns jsonb language plpgsql as $$
declare p public.communication_commitments%rowtype; v jsonb; party jsonb; cid uuid; c public.communications%rowtype;
begin
 if nullif(trim(p_actor),'') is null or nullif(trim(p_reason),'') is null then raise exception 'Actor and reason required'; end if;
 if p_action='create' then
  insert into public.communication_commitments(tenant_id,description,source_type,ledger_version,review_state,terms_edited)
  values(p_tenant_id,'New promise','manual',1,'confirmed',true) returning * into p;
 else
  select * into p from public.communication_commitments where tenant_id=p_tenant_id and id=p_id for update;
  if not found or p.deleted_at is not null then raise exception 'Promise not found' using errcode='P0002'; end if;
  if p_revision is null or p.revision<>p_revision then raise exception 'Promise revision changed' using errcode='40001'; end if;
  p.revision:=p.revision+1;
 end if;
 if p_action in('create','update') then
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in('description','promisor_parties','promisee_parties','due','external_project_id','project_id','thread_id','related_promise_id','joint')) then raise exception 'Unsupported terms'; end if;
  v:=to_jsonb(p)|| (p_patch-'due');
  if p_patch ? 'due' then v:=v||jsonb_build_object('due_interpretation',p_patch->'due'); end if;
  p:=jsonb_populate_record(p,v);
  if nullif(trim(p.description),'') is null or length(p.description)>1000 then raise exception 'Description required (max 1000)'; end if;
  if jsonb_typeof(p.promisor_parties)<>'array' or jsonb_array_length(p.promisor_parties) not between 1 and 100 or jsonb_typeof(p.promisee_parties)<>'array' or jsonb_array_length(p.promisee_parties)>100 then raise exception 'Invalid participants'; end if;
  if p.joint and jsonb_array_length(p.promisor_parties)<2 then raise exception 'A joint promise requires both participants'; end if;
  for party in select value from jsonb_array_elements(p.promisor_parties||p.promisee_parties) loop
   if jsonb_typeof(party)<>'object' or (nullif(party->>'person_id','') is null and nullif(trim(party->>'label'),'') is null) then raise exception 'Participant ID or label required'; end if;
   if nullif(party->>'person_id','') is not null and not exists(select 1 from public.contacts where tenant_id=p_tenant_id and id=(party->>'person_id')::uuid) then raise exception 'Participant unavailable'; end if;
  end loop;
  if p.project_id is not null and not exists(select 1 from public.projects where tenant_id=p_tenant_id and id=p.project_id) then raise exception 'Project unavailable'; end if;
  if p.thread_id is not null and not exists(select 1 from public.communication_threads where tenant_id=p_tenant_id and thread_id=p.thread_id) then raise exception 'Thread unavailable'; end if;
  if p.related_promise_id is not null and (p.related_promise_id=p.id or not exists(select 1 from public.communication_commitments where tenant_id=p_tenant_id and id=p.related_promise_id and deleted_at is null)) then raise exception 'Related promise unavailable'; end if;
  if jsonb_typeof(p.due_interpretation)<>'object' then raise exception 'Invalid due interpretation'; end if;
  p.terms_edited:=true;
 elsif p_action='delete' then
  p.deleted_at:=now();p.deleted_by:=p_actor;p.deleted_reason:=p_reason;p.review_state:='deleted';p.observed_state:='deleted';
 elsif p_action in('condition_create','condition_update','condition_delete') then
  if p_action='condition_create' then
   cid:=gen_random_uuid();v:=jsonb_build_object('id',cid,'description',p_patch->>'description','status','pending');
  else
   cid:=(p_patch->>'id')::uuid;
   select value into v from jsonb_array_elements(p.conditions) where value->>'id'=cid::text;
   if v is null then raise exception 'Condition not found' using errcode='P0002'; end if;
   v:=v||(p_patch-'id');
  end if;
  if nullif(trim(v->>'description'),'') is null or length(v->>'description')>1000 or v->>'status' not in('pending','satisfied','waived','failed') then raise exception 'Invalid condition'; end if;
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in('id','description','status')) then raise exception 'Unsupported condition field'; end if;
  select coalesce(jsonb_agg(value),'[]') into p.conditions from jsonb_array_elements(p.conditions) where value->>'id'<>cid::text;
  if p_action<>'condition_delete' then p.conditions:=p.conditions||jsonb_build_array(v||jsonb_build_object('updated_by',p_actor,'updated_at',now())); end if;
 elsif p_action='evidence_add' then
  if nullif(trim(p_patch->>'quote'),'') is null or length(p_patch->>'quote')>10000 then raise exception 'Evidence text required (max 10000)'; end if;
  if nullif(p_patch->>'communication_id','') is not null then
   select * into c from public.communications where tenant_id=p_tenant_id and communication_id=p_patch->>'communication_id' for share;
   if not found or not c.memory_eligible or position(p_patch->>'quote' in coalesce(c.body,'')||coalesce(c.body_them,''))=0 then raise exception 'Source or quote unavailable'; end if;
  end if;
  insert into public.promise_evidence(tenant_id,promise_id,communication_id,source_revision,evidence_key,quote,speaker,kind,source,extractor_version,confidence)
  values(p_tenant_id,p.id,c.communication_id,c.promise_revision,gen_random_uuid()::text,p_patch->>'quote',jsonb_build_object('actor',p_actor),'human_evidence',case when c.communication_id is null then '{}'::jsonb else public.promise_source(c) end,'human',1);
 else raise exception 'Invalid mutation';
 end if;
 update public.communication_commitments set description=p.description,promisor_parties=p.promisor_parties,promisee_parties=p.promisee_parties,
 promisor_contact_id=nullif(p.promisor_parties->0->>'person_id','')::uuid,promisee_contact_id=nullif(p.promisee_parties->0->>'person_id','')::uuid,
 due_interpretation=p.due_interpretation,due_at=(p.due_interpretation->>'instant')::timestamptz,external_project_id=p.external_project_id,project_id=p.project_id,
 thread_id=p.thread_id,related_promise_id=p.related_promise_id,joint=p.joint,terms_edited=p.terms_edited,conditions=p.conditions,
 deleted_at=p.deleted_at,deleted_by=p.deleted_by,deleted_reason=p.deleted_reason,review_state=p.review_state,observed_state=p.observed_state,revision=p.revision,updated_at=now()
 where tenant_id=p_tenant_id and id=p.id returning * into p;
 perform public.record_promise_change(p,p_action,p_actor,p_reason,p_destination,false);
 return to_jsonb(p);
end $$;

create or replace function public.review_promise(p_tenant_id text,p_id uuid,p_revision integer,p_actor text,p_action text,p_reason text,p_patch jsonb,p_destination text default null)
returns jsonb language plpgsql as $$
declare p public.communication_commitments%rowtype; party jsonb;
begin
 select * into p from public.communication_commitments where tenant_id=p_tenant_id and id=p_id for update;
 if not found or p.deleted_at is not null then raise exception 'Promise not found' using errcode='P0002'; end if;
 if p_revision is null or p.revision<>p_revision then raise exception 'Promise revision changed' using errcode='40001'; end if;
 if p_action in('confirm','verify_fulfillment') and p.source_type<>'manual' and p.ledger_version is not null and not exists(select 1 from public.communications c
  where c.tenant_id=p_tenant_id and c.communication_id=p.communication_id and c.promise_revision=p.source_revision and c.memory_eligible=true) then
  raise exception 'Promise source changed' using errcode='40001';
 end if;
 if length(trim(p_reason))<1 or nullif(p_actor,'') is null then raise exception 'Actor and reason required'; end if;
 if p_action not in('confirm','dismiss','completion_claimed','verify_fulfillment','cancel','correct') then raise exception 'Invalid promise action'; end if;
 if p_action='verify_fulfillment' and exists(select 1 from jsonb_array_elements(p.conditions) v where v->>'status' in('pending','failed')) then raise exception 'Resolve pending conditions before fulfillment'; end if;
 if p_patch ? 'promisor_parties' then
  if jsonb_array_length(p_patch->'promisor_parties') not between 1 and 100 then raise exception 'Promise participants required'; end if;
  if p.joint and jsonb_array_length(p_patch->'promisor_parties')<2 then raise exception 'A joint promise requires both participants'; end if;
  for party in select value from jsonb_array_elements(p_patch->'promisor_parties') loop
   if nullif(party->>'person_id','') is not null and not exists(select 1 from public.contacts where tenant_id=p_tenant_id and id=(party->>'person_id')::uuid) then raise exception 'Promise participant unavailable' using errcode='42501'; end if;
  end loop;
 end if;
 update public.communication_commitments set revision=revision+1,ledger_version=1,updated_at=now(),terms_edited=terms_edited or p_patch<>'{}'::jsonb,
  review_state=case when p_action='dismiss' then 'dismissed' when p_action in('confirm','correct','verify_fulfillment') then 'confirmed' else review_state end,
  observed_state=case when p_action='verify_fulfillment' then 'fulfilled' when p_action='cancel' then 'cancelled' when p_action='completion_claimed' then 'completion_claimed' else observed_state end,
  status=case when p_action='verify_fulfillment' then 'completed' when p_action in('cancel','dismiss') then 'cancelled' else status end,
  resolved_at=case when p_action in('verify_fulfillment','cancel','dismiss') then now() else resolved_at end,
  promisor_parties=coalesce(p_patch->'promisor_parties',promisor_parties),due_interpretation=coalesce(p_patch->'due',due_interpretation)
 where id=p.id returning * into p;
 perform public.record_promise_change(p,p_action,p_actor,p_reason,p_destination,false);
 return to_jsonb(p);
end $$;


commit;

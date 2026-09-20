-- Uses the repository's ordered migration runner (not Supabase CLI migrations).
begin;
create table public.operational_classifications (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references tenants(tenant_id),
 request_id text not null, communication_id text not null, source_revision integer not null,
 items jsonb not null, created_at timestamptz not null default now(), unique(tenant_id,request_id)
);
create table public.operational_candidates (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references tenants(tenant_id),
 communication_id text not null, source_revision integer not null, item jsonb not null,
 status text not null default 'PENDING' check(status in('PENDING','ACCEPTED','REJECTED')),
 object_id uuid, created_at timestamptz not null default now(), reviewed_at timestamptz
);
create unique index operational_candidate_evidence on operational_candidates(tenant_id,communication_id,source_revision,(item->>'evidence_key'));
create table public.operational_objects (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references tenants(tenant_id),
 type text not null, data jsonb not null, communication_id text not null, source_revision integer not null,
 status text not null default 'OPEN' check(status in('OPEN','FULFILLED','CANCELLED')), history jsonb not null default '[]', revision integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.review_sessions (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references tenants(tenant_id),
 owner_id text not null, scope jsonb not null, stage text not null default 'BRIEFING'
 check(stage in('PREPARING','BRIEFING','REVIEW','NEXT_ACTIONS','SUMMARY','COMPLETED')),
 briefing jsonb not null, review_queue jsonb not null, actions_created jsonb not null default '[]',
 responses jsonb not null default '[]', revision integer not null default 1,
 started_at timestamptz not null default now(), completed_at timestamptz
);
create table public.review_actions (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references tenants(tenant_id),
 session_id uuid not null references review_sessions(id), request_id text not null,
 instruction text not null, status text not null default 'PENDING' check(status in('PENDING','SUCCEEDED','FAILED')),
 result jsonb, created_at timestamptz not null default now(), unique(tenant_id,session_id,request_id)
);
create index operational_pending on operational_candidates(tenant_id,status,created_at);
create index review_owner on review_sessions(tenant_id,owner_id,started_at);

create function public.store_operational_classification(p_tenant_id text,p_request_id text,p_communication_id text,p_source_revision integer,p_items jsonb)
returns jsonb language plpgsql as $$
declare r operational_classifications%rowtype; c communications%rowtype; i jsonb;
begin
 select * into c from communications where tenant_id=p_tenant_id and communication_id=p_communication_id for share;
 if not found or c.promise_revision<>p_source_revision or not c.memory_eligible then raise exception 'Source changed' using errcode='40001'; end if;
 perform pg_advisory_xact_lock(hashtext(p_tenant_id),hashtext(p_request_id));
 select * into r from operational_classifications where tenant_id=p_tenant_id and request_id=p_request_id;
 if found then
  if r.communication_id<>p_communication_id or r.source_revision<>p_source_revision then raise exception 'Request conflict' using errcode='40001'; end if;
  return to_jsonb(r);
 end if;
 insert into operational_classifications(tenant_id,request_id,communication_id,source_revision,items) values(p_tenant_id,p_request_id,p_communication_id,p_source_revision,p_items) returning * into r;
 for i in select value from jsonb_array_elements(p_items) loop
  insert into operational_candidates(tenant_id,communication_id,source_revision,item) values(p_tenant_id,p_communication_id,p_source_revision,i) on conflict do nothing;
 end loop;
 return to_jsonb(r);
end $$;

create function public.transition_operational_promise(p_tenant_id text,p_id uuid,p_revision integer,p_actor text,p_action text,p_reason text,p_patch jsonb default '{}')
returns jsonb language plpgsql as $$
declare p communication_commitments%rowtype;
begin
 select * into p from communication_commitments where tenant_id=p_tenant_id and id=p_id and deleted_at is null for update;
 if not found then raise exception 'Promise not found' using errcode='P0002'; end if;
 if p_revision is null or p.revision<>p_revision then raise exception 'Promise revision changed' using errcode='40001'; end if;
 if nullif(trim(p_reason),'') is null or nullif(trim(p_actor),'') is null then raise exception 'Actor and reason required'; end if;
 if p_action not in('reopen','supersede','reject_fulfilment') then raise exception 'Invalid transition'; end if;
 if p_action='supersede' and not exists(select 1 from communication_commitments where tenant_id=p_tenant_id and id=(p_patch->>'related_promise_id')::uuid and id<>p_id and deleted_at is null) then raise exception 'Replacement promise required'; end if;
 update communication_commitments set revision=revision+1,observed_state=case when p_action='supersede' then 'superseded' else 'promised' end,
 status=case when p_action='supersede' then 'cancelled' else 'open' end,review_state='confirmed',
 related_promise_id=case when p_action='supersede' then (p_patch->>'related_promise_id')::uuid else related_promise_id end,
 resolved_at=case when p_action='supersede' then now() else null end,updated_at=now()
 where tenant_id=p_tenant_id and id=p_id returning * into p;
 perform record_promise_change(p,p_action,p_actor,p_reason,null,false);
 return to_jsonb(p);
end $$;

-- Queue response, canonical mutation and session progress commit or roll back together.
create function public.respond_operational_review(p_tenant_id text,p_session_id uuid,p_owner_id text,p_revision integer,p_item_id text,p_intent text,p_utterance text,p_request_id text,p_destination text default null)
returns jsonb language plpgsql as $$
declare s review_sessions%rowtype; q jsonb; c operational_candidates%rowtype; source communications%rowtype;
 p communication_commitments%rowtype; v jsonb; result jsonb; pid uuid; act text; patch jsonb;
begin
 select * into s from review_sessions where tenant_id=p_tenant_id and id=p_session_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Session unavailable' using errcode='P0002'; end if;
 select value into v from jsonb_array_elements(s.responses) where value->>'request_id'=p_request_id;
 if v is not null then
  if v->>'item_id'<>p_item_id or v->>'intent'<>p_intent or v->>'utterance'<>p_utterance then raise exception 'Response request conflict' using errcode='40001'; end if;
  return to_jsonb(s);
 end if;
 if p_revision is null or s.revision<>p_revision or s.stage<>'REVIEW' then raise exception 'Session revision or stage changed' using errcode='40001'; end if;
 select value into q from jsonb_array_elements(s.review_queue) where value->>'id'=p_item_id and value->>'status'='PENDING';
 if q is null then raise exception 'Review item unavailable'; end if;
 if p_intent not in('ACCEPT','REJECT','DEFER') then raise exception 'Explicit ACCEPT, REJECT or DEFER required'; end if;
 if p_intent<>'DEFER' then
  if q->>'candidate_id' is not null then
   select * into c from operational_candidates where tenant_id=p_tenant_id and id=(q->>'candidate_id')::uuid for update;
   if not found or c.status<>'PENDING' then raise exception 'Candidate already reviewed' using errcode='40001'; end if;
   select * into source from communications where tenant_id=p_tenant_id and communication_id=c.communication_id for share;
   if not found or source.promise_revision<>c.source_revision or not source.memory_eligible then raise exception 'Evidence changed; refresh review' using errcode='40001'; end if;
  end if;
  if q->>'object_id' is not null then
   select to_jsonb(o) into v from operational_objects o where tenant_id=p_tenant_id and id=(q->>'object_id')::uuid for update;
   if v is null or (v->>'revision')::integer<>(q->>'expected_revision')::integer then raise exception 'Expected output changed' using errcode='40001'; end if;
   select * into source from communications where tenant_id=p_tenant_id and communication_id=v->>'communication_id' for share;
   if not found or not source.memory_eligible or source.promise_revision<>(v->>'source_revision')::integer then raise exception 'Expected output source changed' using errcode='40001'; end if;
  end if;
  pid:=nullif(q->>'promise_id','')::uuid;
  if pid is not null then
   select * into p from communication_commitments where tenant_id=p_tenant_id and id=pid and deleted_at is null for update;
   if not found or p.revision<>(q->>'expected_revision')::integer then raise exception 'Promise changed; refresh review' using errcode='40001'; end if;
  end if;
  if p_intent='ACCEPT' then
   if q->>'type'='CANDIDATE' and pid is null and c.item->>'type' in('PROMISE','CONDITIONAL_PROMISE') then
    -- Serialize acceptance across sessions; exact source wording links existing ledger evidence.
    perform pg_advisory_xact_lock(hashtext(p_tenant_id),hashtext(c.communication_id));
    select * into p from communication_commitments where tenant_id=p_tenant_id and communication_id=c.communication_id and source_excerpt=c.item->>'source_text' and deleted_at is null limit 1 for update;
    if found then pid:=p.id;
    else
     patch:=jsonb_build_object('description',c.item->>'summary','promisor_parties',jsonb_build_array(c.item->'actor'),'promisee_parties',coalesce(c.item->'counterparties','[]'),'due',coalesce(c.item->'due','{}'),'thread_id',source.thread_id,'external_project_id',source.correlation->>'external_project_id');
     result:=mutate_promise(p_tenant_id,null,null,p_owner_id,'create',p_utterance,patch,p_destination);pid:=(result->>'id')::uuid;
     update communication_commitments set communication_id=source.communication_id,source_revision=source.promise_revision,source_type='communication',source_excerpt=c.item->>'source_text',evidence_key=c.item->>'ledger_evidence_key',revision=revision+1 where tenant_id=p_tenant_id and id=pid;
    end if;
    select * into p from communication_commitments where tenant_id=p_tenant_id and id=pid;
    if not exists(select 1 from promise_history where tenant_id=p_tenant_id and promise_id=pid and revision=p.revision) then perform record_promise_change(p,'PROMISE_CREATED',p_owner_id,p_utterance,p_destination,false); end if;
    insert into promise_evidence(tenant_id,promise_id,communication_id,source_revision,evidence_key,quote,speaker,kind,source,extractor_version,confidence)
    values(p_tenant_id,pid,source.communication_id,source.promise_revision,c.item->>'ledger_evidence_key',c.item->>'source_text',c.item->'actor',case when c.item->>'type'='CONDITIONAL_PROMISE' then 'conditional' else 'promised' end,promise_source(source),'operational-v1',(c.item->>'confidence')::real) on conflict do nothing;
    if p.review_state<>'confirmed' then
     result:=review_promise(p_tenant_id,pid,p.revision,p_owner_id,'confirm',p_utterance,'{}',p_destination);
     select * into p from communication_commitments where tenant_id=p_tenant_id and id=pid;
    end if;
    if c.item->>'type'='CONDITIONAL_PROMISE' and not exists(select 1 from jsonb_array_elements(p.conditions) x where x->>'description'=c.item->>'condition') then
     result:=mutate_promise(p_tenant_id,pid,p.revision,p_owner_id,'condition_create',p_utterance,jsonb_build_object('description',c.item->>'condition','status','pending'),p_destination);
    end if;
   elsif pid is not null then
    act:=q->>'operation';patch:=coalesce(q->'patch','{}');
    if act in('confirm','verify_fulfillment','cancel','correct') then result:=review_promise(p_tenant_id,pid,p.revision,p_owner_id,act,p_utterance,patch,p_destination);
    elsif act='condition_update' then result:=mutate_promise(p_tenant_id,pid,p.revision,p_owner_id,act,p_utterance,patch,p_destination);
    elsif act='acknowledge' then result:=jsonb_build_object('recorded',true);
    else raise exception 'Unsupported review operation'; end if;
   elsif q->>'object_id' is not null then
    update operational_objects set status='FULFILLED',revision=revision+1,updated_at=now(),history=history||jsonb_build_array(jsonb_build_object('actor',p_owner_id,'reason',p_utterance,'status','FULFILLED','at',now())) where tenant_id=p_tenant_id and id=(q->>'object_id')::uuid and revision=(q->>'expected_revision')::integer returning id into pid;
    if not found then raise exception 'Expected output changed' using errcode='40001'; end if;
   else
    insert into operational_objects(tenant_id,type,data,communication_id,source_revision) values(p_tenant_id,c.item->>'type',c.item,c.communication_id,c.source_revision) returning id into pid;
   end if;
  elsif p_intent='REJECT' and pid is not null and c.id is null then
   if q->>'operation'='confirm' then result:=review_promise(p_tenant_id,pid,p.revision,p_owner_id,'dismiss',p_utterance,'{}',p_destination);
   elsif q->>'operation'='verify_fulfillment' then result:=transition_operational_promise(p_tenant_id,pid,p.revision,p_owner_id,'reject_fulfilment',p_utterance,'{}'); end if;
  end if;
  if c.id is not null then update operational_candidates set status=case when p_intent='ACCEPT' then 'ACCEPTED' else 'REJECTED' end,object_id=pid,reviewed_at=now() where id=c.id; end if;
 end if;
 select jsonb_agg(case when value->>'id'=p_item_id then value||jsonb_build_object('status',case when p_intent='DEFER' then 'DEFERRED' else 'RESOLVED' end) else value end) into s.review_queue from jsonb_array_elements(s.review_queue);
 s.responses:=s.responses||jsonb_build_array(jsonb_build_object('request_id',p_request_id,'item_id',p_item_id,'intent',p_intent,'utterance',p_utterance,'object_id',pid,'at',now()));
 update review_sessions set review_queue=s.review_queue,responses=s.responses,revision=revision+1,
 stage=case when exists(select 1 from jsonb_array_elements(s.review_queue) x where x->>'status'='PENDING') then 'REVIEW' else 'NEXT_ACTIONS' end
 where id=s.id returning * into s;
 return to_jsonb(s);
end $$;

-- Server-only tables and functions, also scoped structurally by tenantDatabase.
do $$ declare t text; r text; f regprocedure; begin
 foreach t in array array['operational_classifications','operational_candidates','operational_objects','review_sessions','review_actions'] loop
  insert into tenant_data_sets(name,exportable) values(t,true) on conflict do nothing;
  execute format('create trigger tenant_data_write_guard before insert or update or delete on public.%I for each row execute function guard_tenant_data_write()',t);
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public',t);
  foreach r in array array['anon','authenticated'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on public.%I from %I',t,r); end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant all on public.%I to service_role',t); end if;
 end loop;
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('store_operational_classification','respond_operational_review','transition_operational_promise') loop
  execute format('revoke all on function %s from public',f);
  foreach r in array array['anon','authenticated'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r); end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant execute on function %s to service_role',f); end if;
 end loop;
end $$;
create function public.queue_review_action(p_tenant_id text,p_session_id uuid,p_owner_id text,p_request_id text,p_instruction text,p_destination text default null)
returns jsonb language plpgsql as $$
declare s review_sessions%rowtype; a review_actions%rowtype; eid text; payload jsonb;
begin
 select * into s from review_sessions where tenant_id=p_tenant_id and id=p_session_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Session unavailable'; end if;
 select * into a from review_actions where tenant_id=p_tenant_id and session_id=p_session_id and request_id=p_request_id;
 if found then
  if a.instruction<>p_instruction then raise exception 'Action request conflict' using errcode='40001'; end if;
  return to_jsonb(a);
 end if;
 if s.stage<>'NEXT_ACTIONS' then raise exception 'Session is not accepting actions' using errcode='40001'; end if;
 insert into review_actions(tenant_id,session_id,request_id,instruction) values(p_tenant_id,p_session_id,p_request_id,p_instruction) returning * into a;
 update review_sessions set actions_created=actions_created||jsonb_build_array(a.id),revision=revision+1 where id=s.id;
 if p_destination is not null then
  eid:=prefixed_id('evt');
  payload:=jsonb_build_object('contract_version','2.0','tenant_id',p_tenant_id,'event_id',eid,'type','review.action.requested','occurred_at',now(),'payload',jsonb_build_object('action_id',a.id,'session_id',s.id,'instruction',p_instruction,'owner_id',p_owner_id,'scope',s.scope));
  insert into outbound_events(tenant_id,event_id,type,destination,payload,dedupe_key) values(p_tenant_id,eid,'review.action.requested',p_destination,payload,'review-action:'||a.id);
 end if;
 return to_jsonb(a);
end $$;
revoke all on function public.queue_review_action(text,uuid,text,text,text,text) from public;
do $$ declare r text; begin
 foreach r in array array['anon','authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function public.queue_review_action(text,uuid,text,text,text,text) from %I',r); end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.queue_review_action(text,uuid,text,text,text,text) to service_role; end if;
end $$;
commit;

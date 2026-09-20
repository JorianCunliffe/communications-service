-- Forward-only operational review correctness and durable decisions.
begin;
create table public.review_tasks (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references tenants(tenant_id),
 owner_id text not null, item_id text not null, status text not null default 'PENDING'
 check(status in('PENDING','SNOOZED','RESOLVED','DISMISSED')),
 priority integer not null default 0, snoozed_until timestamptz,
 times_raised integer not null default 0, last_raised_at timestamptz,
 history jsonb not null default '[]', unique(tenant_id,owner_id,item_id)
);
insert into tenant_data_sets(name,exportable) values('review_tasks',true);
create trigger tenant_data_write_guard before insert or update or delete on public.review_tasks for each row execute function guard_tenant_data_write();
alter table public.review_tasks enable row level security;
revoke all on public.review_tasks from public;
alter table review_sessions add column request_id text;
create unique index review_session_request on review_sessions(tenant_id,owner_id,request_id) where request_id is not null;
-- Replace the old signature so PostgREST and direct PostgreSQL resolve identically.
drop function public.respond_operational_review(text,uuid,text,integer,text,text,text,text,text);
create or replace function public.respond_operational_review(p_tenant_id text,p_session_id uuid,p_owner_id text,p_revision integer,p_item_id text,p_intent text,p_utterance text,p_request_id text,p_destination text default null,p_details jsonb default '{}')
returns jsonb language plpgsql as $$
declare s review_sessions%rowtype; q jsonb; c operational_candidates%rowtype; source communications%rowtype;
 p communication_commitments%rowtype; v jsonb; result jsonb; pid uuid; act text; patch jsonb; original_revision integer; next_revision integer; details jsonb; task_status text;
begin
 select * into s from review_sessions where tenant_id=p_tenant_id and id=p_session_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Session unavailable' using errcode='P0002'; end if;
 select value into v from jsonb_array_elements(s.responses) where value->>'request_id'=p_request_id;
 if v is not null then
  if v->>'item_id'<>p_item_id or v->>'intent'<>p_intent or v->>'utterance'<>p_utterance or coalesce(v->'details','{}')<>p_details then raise exception 'Response request conflict' using errcode='40001'; end if;
  return to_jsonb(s);
 end if;
 if p_revision is null or s.revision<>p_revision or s.stage<>'REVIEW' then raise exception 'Session revision or stage changed' using errcode='40001'; end if;
 select value into q from jsonb_array_elements(s.review_queue) where value->>'id'=p_item_id and value->>'status'='PENDING';
 if q is null then raise exception 'Review item unavailable'; end if;
 if p_intent not in('ACCEPT','REJECT','DEFER','SNOOZE','PARTIAL','CORRECT') then raise exception 'Explicit ACCEPT, REJECT or DEFER required'; end if;
 if p_intent not in('DEFER','SNOOZE') then
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
  original_revision:=p.revision;
  if p_intent='PARTIAL' then
   if pid is null then raise exception 'Partial progress requires a promise'; end if;
   result:=mutate_promise(p_tenant_id,pid,p.revision,p_owner_id,'evidence_add',p_utterance,jsonb_build_object('quote',p_utterance),p_destination);
  elsif p_intent='CORRECT' then
   if pid is null then raise exception 'Correction requires a promise'; end if;
   act:=coalesce(p_details->>'operation','update');patch:=p_details->'patch';
   if act in('update','condition_create','condition_update','condition_delete') then result:=mutate_promise(p_tenant_id,pid,p.revision,p_owner_id,act,p_utterance,patch,p_destination);
   elsif act in('reopen','supersede') then result:=transition_operational_promise(p_tenant_id,pid,p.revision,p_owner_id,act,p_utterance,patch);
   else raise exception 'Unsupported correction'; end if;
  elsif p_intent='ACCEPT' then
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
    if act='correct' then result:=mutate_promise(p_tenant_id,pid,p.revision,p_owner_id,'update',p_utterance,patch,p_destination);
    elsif act in('confirm','verify_fulfillment','cancel') then result:=review_promise(p_tenant_id,pid,p.revision,p_owner_id,act,p_utterance,patch,p_destination);
    elsif act='condition_update' then result:=mutate_promise(p_tenant_id,pid,p.revision,p_owner_id,act,p_utterance,patch,p_destination);
    elsif act='acknowledge' then result:=jsonb_build_object('recorded',true);
    else raise exception 'Unsupported review operation'; end if;
   elsif q->>'object_id' is not null then
    update operational_objects set status='FULFILLED',revision=revision+1,updated_at=now(),history=history||jsonb_build_array(jsonb_build_object('actor',p_owner_id,'reason',p_utterance,'status','FULFILLED','at',now())) where tenant_id=p_tenant_id and id=(q->>'object_id')::uuid and revision=(q->>'expected_revision')::integer returning id into pid;
    if not found then raise exception 'Expected output changed' using errcode='40001'; end if;
    select to_jsonb(o) into result from operational_objects o where tenant_id=p_tenant_id and id=pid;
   else
    insert into operational_objects(tenant_id,type,data,communication_id,source_revision) values(p_tenant_id,c.item->>'type',c.item,c.communication_id,c.source_revision) returning id into pid;
    select to_jsonb(o) into result from operational_objects o where tenant_id=p_tenant_id and id=pid;
   end if;
  elsif p_intent='REJECT' and pid is not null and c.id is null then
   if q->>'operation'='confirm' then result:=review_promise(p_tenant_id,pid,p.revision,p_owner_id,'dismiss',p_utterance,'{}',p_destination);
   elsif q->>'operation'='verify_fulfillment' then result:=transition_operational_promise(p_tenant_id,pid,p.revision,p_owner_id,'reject_fulfilment',p_utterance,'{}'); end if;
  end if;
  if c.id is not null and pid is not null and p_intent='ACCEPT' and q->>'promise_id' is not null then
   insert into promise_evidence(tenant_id,promise_id,communication_id,source_revision,evidence_key,quote,speaker,kind,source,extractor_version,confidence)
   values(p_tenant_id,pid,c.communication_id,c.source_revision,c.item->>'evidence_key',c.item->>'source_text',jsonb_build_object('reviewer',p_owner_id),c.item->>'type',promise_source(source),'operational-review.v2',coalesce((c.item->>'confidence')::real,1)) on conflict do nothing;
  end if;
  if c.id is not null and p_intent<>'PARTIAL' then update operational_candidates set status=case when p_intent in('ACCEPT','CORRECT') then 'ACCEPTED' else 'REJECTED' end,object_id=pid,reviewed_at=now() where id=c.id; end if;
 end if;
 -- Update only causally dependent questions at the revision actually read above.
 -- External edits still fail their original revision comparison.
 if original_revision is not null and pid is not null then
  select revision into next_revision from communication_commitments where tenant_id=p_tenant_id and id=pid;
 end if;
 select coalesce(jsonb_agg(case
  when value->>'id'=p_item_id then value||jsonb_build_object('status',case when p_intent in('DEFER','SNOOZE','PARTIAL') then 'DEFERRED' else 'RESOLVED' end)
  when value->>'status'='PENDING' and value->>'promise_id'=pid::text and (value->>'expected_revision')::integer=original_revision and next_revision<>original_revision then
   value||jsonb_build_object('expected_revision',next_revision,'status',case
    when p_intent='CORRECT' or q->>'operation' in('cancel','verify_fulfillment','correct') then 'STALE'
    else 'PENDING' end)
  else value end),'[]') into s.review_queue from jsonb_array_elements(s.review_queue);
 task_status:=case when p_intent='REJECT' then 'DISMISSED' when p_intent in('DEFER','SNOOZE','PARTIAL') then 'SNOOZED' else 'RESOLVED' end;
 if p_intent='SNOOZE' and (p_details->>'snoozed_until' is null or (p_details->>'snoozed_until')::timestamptz<=now()) then raise exception 'Future snooze instant required'; end if;
 insert into review_tasks(tenant_id,owner_id,item_id,status,snoozed_until,history)
 values(p_tenant_id,p_owner_id,p_item_id,task_status,case when task_status='SNOOZED' then coalesce((p_details->>'snoozed_until')::timestamptz,now()+interval '1 day') end,
 jsonb_build_array(jsonb_build_object('intent',p_intent,'utterance',p_utterance,'details',p_details,'result_revision',next_revision,'at',now())))
 on conflict(tenant_id,owner_id,item_id) do update set status=excluded.status,snoozed_until=excluded.snoozed_until,history=review_tasks.history||excluded.history;
 s.responses:=s.responses||jsonb_build_array(jsonb_build_object('request_id',p_request_id,'item_id',p_item_id,'intent',p_intent,'utterance',p_utterance,'details',p_details,'object_id',pid,'result',result,'previous_revision',original_revision,'result_revision',next_revision,'operation',case when p_intent='PARTIAL' then 'partial_progress' when p_intent='CORRECT' then coalesce(p_details->>'operation','update') else coalesce(q->>'operation',case when q->>'object_id' is not null then 'expected_deliverable_fulfilled' else 'track_expected_deliverable' end) end,'at',now()));
 update review_sessions set review_queue=s.review_queue,responses=s.responses,revision=revision+1,
 stage=case when exists(select 1 from jsonb_array_elements(s.review_queue) x where x->>'status'='PENDING') then 'REVIEW' else 'NEXT_ACTIONS' end
 where id=s.id returning * into s;
 return to_jsonb(s);
end $$;

revoke all on function public.respond_operational_review(text,uuid,text,integer,text,text,text,text,text,jsonb) from public;
do $$ declare r text; begin
 foreach r in array array['anon','authenticated'] loop
  if exists(select 1 from pg_roles where rolname=r) then
   execute format('revoke all on public.review_tasks from %I',r);
   execute format('revoke all on function public.respond_operational_review(text,uuid,text,integer,text,text,text,text,text,jsonb) from %I',r);
  end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant all on public.review_tasks to service_role;
  grant execute on function public.respond_operational_review(text,uuid,text,integer,text,text,text,text,text,jsonb) to service_role;
 end if;
end $$;
create or replace function public.store_operational_classification(p_tenant_id text,p_request_id text,p_communication_id text,p_source_revision integer,p_items jsonb)
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
  insert into operational_candidates(tenant_id,communication_id,source_revision,item) values(p_tenant_id,p_communication_id,p_source_revision,i) on conflict(tenant_id,communication_id,source_revision,(item->>'evidence_key')) do update set item=excluded.item where operational_candidates.status='PENDING' and coalesce((excluded.item->>'target_revision')::integer,0)>coalesce((operational_candidates.item->>'target_revision')::integer,0);
 end loop;
 return to_jsonb(r);
end $$;


commit;

begin;
-- A different session may settle the same candidate. Refresh its presentation
-- without reapplying it. Only recorded condition confirmations can advance a
-- dependent question's revision; other term edits require fresh evaluation.
create function public.refresh_review_session(p_tenant_id text,p_session_id uuid,p_owner_id text)
returns jsonb language plpgsql as $$
declare s review_sessions%rowtype;q jsonb;queue jsonb:='[]';p communication_commitments%rowtype;v integer;changed boolean:=false;c operational_candidates%rowtype;r jsonb;t review_tasks%rowtype;
begin
 select * into s from review_sessions where tenant_id=p_tenant_id and id=p_session_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Session unavailable';end if;
 for q in select value from jsonb_array_elements(s.review_queue) loop
  if q->>'status'='PENDING' then
   select * into t from review_tasks where tenant_id=p_tenant_id and owner_id=p_owner_id and item_id=q->>'id';
   if found and t.status='SNOOZED' and t.snoozed_until>now() then q:=q||jsonb_build_object('status','DEFERRED');changed:=true;end if;
   if q->>'candidate_id' is not null then
    select * into c from operational_candidates where tenant_id=p_tenant_id and id=(q->>'candidate_id')::uuid;
    if c.status<>'PENDING' then q:=q||jsonb_build_object('status','RESOLVED');changed:=true;end if;
   end if;
   if q->>'promise_id' is not null and q->>'status'='PENDING' then
    select * into p from communication_commitments where tenant_id=p_tenant_id and id=(q->>'promise_id')::uuid and deleted_at is null;
    v:=(q->>'expected_revision')::integer;
    if p.revision<>v then
     while v<p.revision loop
      select answer into r from review_sessions other cross join lateral jsonb_array_elements(other.responses) answer
      where other.tenant_id=p_tenant_id and answer->>'object_id'=p.id::text and (answer->>'previous_revision')::integer=v
      and answer->>'operation'='condition_update' and answer->>'intent'='ACCEPT' and (answer->>'result_revision')::integer>v limit 1;
      if r is null then exit;end if;
      v:=(r->>'result_revision')::integer;
     end loop;
     q:=q||jsonb_build_object('expected_revision',v,'status',case when v=p.revision then 'PENDING' else 'STALE' end);changed:=true;
    end if;
   end if;
  end if;
  queue:=queue||jsonb_build_array(q);
 end loop;
 if changed then
  update review_sessions set review_queue=queue,revision=revision+1,
   responses=responses||jsonb_build_array(jsonb_build_object('intent','QUEUE_REFRESH','at',now(),'previous_queue',s.review_queue,'new_queue',queue)),
   stage=case when stage='REVIEW' and not exists(select 1 from jsonb_array_elements(queue) pending_item where pending_item->>'status'='PENDING') then 'NEXT_ACTIONS' else stage end
  where id=s.id returning * into s;
 end if;
 return to_jsonb(s);
end $$;
revoke all on function public.refresh_review_session(text,uuid,text) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function public.refresh_review_session(text,uuid,text) from %I',r);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.refresh_review_session(text,uuid,text) to service_role;end if;
end $$;
commit;

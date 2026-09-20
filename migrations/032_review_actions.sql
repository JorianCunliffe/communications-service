begin;
alter table review_actions drop constraint review_actions_status_check;
alter table review_actions add constraint review_actions_status_check check(status in('PENDING','NEEDS_CLARIFICATION','READY','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'));
alter table review_actions add column proposal jsonb not null default '{}', add column receipt_id text, add column updated_at timestamptz not null default now();
drop function public.queue_review_action(text,uuid,text,text,text,text);
create function public.queue_review_action(p_tenant_id text,p_session_id uuid,p_owner_id text,p_request_id text,p_instruction text,p_destination text default null,p_proposal jsonb default '{}',p_replaces uuid default null)
returns jsonb language plpgsql as $$
declare s review_sessions%rowtype; a review_actions%rowtype; eid text; payload jsonb; ready boolean;
begin
 select * into s from review_sessions where tenant_id=p_tenant_id and id=p_session_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Session unavailable'; end if;
 select * into a from review_actions where tenant_id=p_tenant_id and session_id=p_session_id and request_id=p_request_id for update;
 if found then
  if a.instruction<>p_instruction or a.proposal<>p_proposal then raise exception 'Action request conflict' using errcode='40001'; end if;
  return to_jsonb(a);
 end if;
 if s.stage<>'NEXT_ACTIONS' then raise exception 'Session is not accepting actions' using errcode='40001'; end if;
 if p_replaces is not null then
  update review_actions set status='CANCELLED',result=jsonb_build_object('summary','Replaced by clarified instruction','request_id',p_request_id) where tenant_id=p_tenant_id and id=p_replaces and session_id=p_session_id and status='NEEDS_CLARIFICATION';
  if not found then raise exception 'Clarification target changed' using errcode='40001';end if;
 end if;
 ready:=p_proposal->>'authorization'='CONFIRMED' and jsonb_array_length(coalesce(p_proposal->'clarification','["missing"]'))=0;
 insert into review_actions(tenant_id,session_id,request_id,instruction,proposal,status)
 values(p_tenant_id,p_session_id,p_request_id,p_instruction,p_proposal,case when ready then case when p_destination is not null then 'QUEUED' else 'READY' end else 'NEEDS_CLARIFICATION' end) returning * into a;
 update review_sessions set actions_created=actions_created||jsonb_build_array(a.id),revision=revision+1 where id=s.id;
 if ready and p_destination is not null then
  eid:=prefixed_id('evt');
  payload:=jsonb_build_object('contract_version','2.0','tenant_id',p_tenant_id,'event_id',eid,'type','review.action.requested','occurred_at',now(),
   'payload',jsonb_build_object('contract_version','review-action.v1','action_id',a.id,'idempotency_key',a.id,'session_id',s.id,'instruction',p_instruction,'owner_id',p_owner_id,'scope',s.scope,'proposal',p_proposal));
  insert into outbound_events(tenant_id,event_id,type,destination,payload,dedupe_key) values(p_tenant_id,eid,'review.action.requested',p_destination,payload,'review-action:'||a.id);
 end if;
 return to_jsonb(a);
end $$;
create function public.record_review_action_result(p_tenant_id text,p_id uuid,p_status text,p_receipt_id text,p_result jsonb)
returns jsonb language plpgsql as $$
declare a review_actions%rowtype;
begin
 select * into a from review_actions where tenant_id=p_tenant_id and id=p_id for update;
 if not found then raise exception 'Action unavailable'; end if;
 if a.receipt_id=p_receipt_id then
  if a.status<>p_status or a.result<>p_result then raise exception 'Receipt conflict' using errcode='40001'; end if;
  return to_jsonb(a);
 end if;
 if a.status in('SUCCEEDED','FAILED','CANCELLED') or a.status not in('QUEUED','RUNNING') then raise exception 'Action state conflict' using errcode='40001'; end if;
 if p_status not in('RUNNING','SUCCEEDED','FAILED','CANCELLED') then raise exception 'Invalid execution status'; end if;
 update review_actions set status=p_status,receipt_id=p_receipt_id,result=p_result,updated_at=now() where id=a.id returning * into a;
 return to_jsonb(a);
end $$;
do $$ declare f regprocedure;r text;begin
 for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('queue_review_action','record_review_action_result') loop
 execute format('revoke all on function %s from public',f);
 foreach r in array array['anon','authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then execute format('grant execute on function %s to service_role',f);end if;
 end loop;
end $$;
commit;

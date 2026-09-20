begin;
create function public.dispatch_ready_review_actions(p_destination text,p_limit integer default 20)
returns integer language plpgsql as $$
declare a review_actions%rowtype;s review_sessions%rowtype;eid text;n integer:=0;
begin
 if nullif(p_destination,'') is null then return 0;end if;
 for a in select r.* from review_actions r join tenants t on t.tenant_id=r.tenant_id
  where r.status='READY' and t.status='active' order by r.created_at limit least(greatest(p_limit,1),100) for update of r skip locked loop
  select * into s from review_sessions where id=a.session_id and tenant_id=a.tenant_id;
  eid:=prefixed_id('evt');
  insert into outbound_events(tenant_id,event_id,type,destination,payload,dedupe_key)
  values(a.tenant_id,eid,'review.action.requested',p_destination,jsonb_build_object('contract_version','2.0','tenant_id',a.tenant_id,'event_id',eid,'type','review.action.requested','occurred_at',now(),
   'payload',jsonb_build_object('contract_version','review-action.v1','action_id',a.id,'idempotency_key',a.id,'session_id',s.id,'instruction',a.instruction,'owner_id',s.owner_id,'scope',s.scope,'proposal',a.proposal)),'review-action:'||a.id) on conflict do nothing;
  update review_actions set status='QUEUED',updated_at=now() where id=a.id;n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.dispatch_ready_review_actions(text,integer) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function public.dispatch_ready_review_actions(text,integer) from %I',r);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.dispatch_ready_review_actions(text,integer) to service_role;end if;
end $$;
commit;

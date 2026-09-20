begin;
create function public.create_review_session(p_tenant_id text,p_owner_id text,p_request_id text,p_scope jsonb,p_briefing jsonb)
returns jsonb language plpgsql as $$
declare s review_sessions%rowtype;q jsonb;
begin
 if p_request_id is not null then
  perform pg_advisory_xact_lock(hashtext(p_tenant_id),hashtext(p_owner_id||p_request_id));
  select * into s from review_sessions where tenant_id=p_tenant_id and owner_id=p_owner_id and request_id=p_request_id;
  if found then
   if s.scope<>p_scope then raise exception 'Session request scope conflict' using errcode='40001';end if;
   return to_jsonb(s);
  end if;
 end if;
 insert into review_sessions(tenant_id,owner_id,request_id,scope,briefing,review_queue)
 values(p_tenant_id,p_owner_id,p_request_id,p_scope,p_briefing,p_briefing->'review_queue') returning * into s;
 for q in select value from jsonb_array_elements(s.review_queue) loop
  insert into review_tasks(tenant_id,owner_id,item_id,priority,times_raised,last_raised_at)
  values(p_tenant_id,p_owner_id,q->>'id',coalesce((q->>'priority')::integer,0),1,now())
  on conflict(tenant_id,owner_id,item_id) do update set times_raised=review_tasks.times_raised+1,last_raised_at=now(),priority=excluded.priority;
 end loop;
 return to_jsonb(s);
end $$;
revoke all on function public.create_review_session(text,text,text,jsonb,jsonb) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function public.create_review_session(text,text,text,jsonb,jsonb) from %I',r);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.create_review_session(text,text,text,jsonb,jsonb) to service_role;end if;
end $$;
commit;

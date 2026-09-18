-- Applied by the repository's ordered PostgreSQL migration runner as 028.
begin;
alter table public.communications add column promise_revision integer not null default 1;
alter table public.communication_commitments
 add column ledger_version integer,
 add column revision integer not null default 1,
 add column external_project_id text,
 add column project_id uuid references public.projects(id),
 add column promisor_parties jsonb not null default '[]',
 add column promisee_parties jsonb not null default '[]',
 add column origin text not null default 'human',
 add column review_state text not null default 'needs_review',
 add column observed_state text not null default 'promised',
 add column due_interpretation jsonb not null default '{}',
 add column source_revision integer,
 add column evidence_key text,
 add column related_promise_id uuid,
 add column joint boolean not null default false;
create unique index promise_evidence_key on public.communication_commitments(tenant_id,communication_id,evidence_key) where evidence_key is not null;
create index promise_ledger_project on public.communication_commitments(tenant_id,external_project_id,id);
create unique index promise_tenant_id on public.communication_commitments(tenant_id,id);

create table public.promise_jobs (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references public.tenants(tenant_id),
 communication_id text not null, source_revision integer not null, extractor_version text not null default 'promise-v1',
 source jsonb not null, status text not null default 'pending' check(status in('pending','processing','done','failed')),
 outcome text, attempts integer not null default 0, lease_token uuid, lease_expires_at timestamptz,
 next_attempt_at timestamptz not null default now(), last_error text, backfill boolean not null default false,
 created_at timestamptz not null default now(), completed_at timestamptz,
 unique(tenant_id,communication_id,source_revision,extractor_version)
);
create index promise_jobs_due on public.promise_jobs(next_attempt_at,created_at) where status in('pending','processing');
create table public.promise_evidence (
 id uuid primary key default gen_random_uuid(), tenant_id text not null,
 promise_id uuid not null, communication_id text not null, source_revision integer not null,
 evidence_key text not null, segment_id text, quote text not null, speaker jsonb not null,
 kind text not null, active boolean not null default true, source jsonb not null,
 extractor_version text not null, confidence real not null check(confidence between 0 and 1),
 created_at timestamptz not null default now(),
 foreign key(tenant_id,promise_id) references public.communication_commitments(tenant_id,id) on delete cascade,
 unique(tenant_id,promise_id,communication_id,source_revision,evidence_key)
);
create index promise_evidence_source on public.promise_evidence(tenant_id,communication_id,source_revision);
create table public.promise_history (
 id uuid primary key default gen_random_uuid(), tenant_id text not null, promise_id uuid not null,
 revision integer not null, action text not null, actor text not null, reason text not null, data jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(tenant_id,promise_id) references public.communication_commitments(tenant_id,id) on delete cascade,
 unique(tenant_id,promise_id,revision)
);

-- Capture structured speaker attribution alongside the canonical source revision.
create function public.promise_source(c public.communications) returns jsonb language plpgsql stable as $$
declare transcript jsonb; email_parties jsonb;
begin
 if c.source_table='recordings' then select r.transcript into transcript from public.recordings r where r.id=c.source_id and r.tenant_id=c.tenant_id;
 elsif c.source_table='calls' then select r.transcript into transcript from public.calls r where r.id=c.source_id and r.tenant_id=c.tenant_id;
 elsif c.source_table='email_messages' then select jsonb_build_object('from',r.from_addresses,'to',r.to_addresses,'delivery_status',r.delivery_status)
  into email_parties from public.email_messages r where r.id=c.source_id and r.tenant_id=c.tenant_id;
 end if;
 return jsonb_build_object('communication_id',c.communication_id,'tenant_id',c.tenant_id,'source_revision',c.promise_revision,
 'channel',c.channel,'direction',c.direction,'body',c.body,'body_them',c.body_them,'occurred_at',c.occurred_at,
 'person_id',coalesce(c.person_id,c.contact_id),'thread_id',c.thread_id,'project_id',c.project_id,
 'correlation',c.correlation,'metadata',c.metadata,'disposition',c.disposition,'memory_eligible',c.memory_eligible,
 'transcript',transcript,'email_parties',email_parties);
end $$;

create function public.version_promise_source() returns trigger language plpgsql as $$
begin
 if TG_OP='UPDATE' then
  if (to_jsonb(new)-array['updated_at','promise_revision','search_vector','search_text','summary']) is distinct from
     (to_jsonb(old)-array['updated_at','promise_revision','search_vector','search_text','summary'])
     or (new.source_table in('recordings','calls') and new.updated_at is distinct from old.updated_at) then
   new.promise_revision:=old.promise_revision+1;
  else new.promise_revision:=old.promise_revision; end if;
 end if;
 return new;
end $$;
create trigger z_promise_source_version before update on public.communications for each row execute function public.version_promise_source();
create function public.queue_promise_source() returns trigger language plpgsql as $$
begin
 insert into public.promise_jobs(tenant_id,communication_id,source_revision,source)
 values(new.tenant_id,new.communication_id,new.promise_revision,public.promise_source(new)) on conflict do nothing;
 return new;
end $$;
create trigger zz_queue_promise_source after insert or update on public.communications for each row execute function public.queue_promise_source();

-- Reconciliation also provides resumable, bounded historical backfill. No live events for these receipts.
create function public.reconcile_promise_jobs(p_tenant_id text,p_since timestamptz default now()-interval '30 days',p_limit integer default 500)
returns integer language plpgsql as $$
declare n integer;
begin
 insert into public.promise_jobs(tenant_id,communication_id,source_revision,source,backfill)
 select c.tenant_id,c.communication_id,c.promise_revision,public.promise_source(c),true from public.communications c
 where c.tenant_id=p_tenant_id and c.occurred_at>=p_since and not exists(select 1 from public.promise_jobs j where
 j.tenant_id=c.tenant_id and j.communication_id=c.communication_id and j.source_revision=c.promise_revision and j.extractor_version='promise-v1')
 order by c.occurred_at,c.communication_id limit least(greatest(p_limit,1),1000) on conflict do nothing;
 get diagnostics n=row_count; return n;
end $$;

create function public.claim_promise_job() returns setof public.promise_jobs language sql as $$
 with chosen as(select j.id from public.promise_jobs j join public.tenants t using(tenant_id)
 where t.status='active' and coalesce(t.metadata->'promise_ledger'->>'enabled','false')='true'
 and (t.metadata->'promise_ledger'->'project_ids' is null or t.metadata->'promise_ledger'->'project_ids' ? (j.source->'correlation'->>'external_project_id'))
 and j.next_attempt_at<=now() and (j.status='pending' or (j.status='processing' and j.lease_expires_at<now()))
 order by j.created_at,j.id for update of j skip locked limit 1)
 update public.promise_jobs j set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
 from chosen where j.id=chosen.id returning j.*;
$$;

create function public.record_promise_change(p public.communication_commitments,p_action text,p_actor text,p_reason text,p_destination text default null,p_backfill boolean default false)
returns void language plpgsql as $$
declare eid text:=public.prefixed_id('evt'); body jsonb;
begin
 insert into public.promise_history(tenant_id,promise_id,revision,action,actor,reason,data)
 values(p.tenant_id,p.id,p.revision,p_action,p_actor,p_reason,to_jsonb(p));
 if p_destination is not null and not p_backfill and p.external_project_id is not null
 and coalesce((select metadata->'promise_ledger'->>'shadow' from public.tenants where tenant_id=p.tenant_id),'false')<>'true' then
  body:=jsonb_build_object('contract_version','2.0','tenant_id',p.tenant_id,'event_id',eid,'type','promise.changed','communication_id',p.communication_id,
  'occurred_at',now(),'correlation',jsonb_build_object('tenant_id',p.tenant_id,'external_project_id',p.external_project_id,'project_id',p.external_project_id),
  'payload',jsonb_build_object('contract_version','promise-ledger.v1','promise_id',p.id,'revision',p.revision,'action',p_action,'evidence_only',true));
  insert into public.outbound_events(tenant_id,event_id,communication_id,type,destination,payload,dedupe_key)
  values(p.tenant_id,eid,p.communication_id,'promise.changed',p_destination,body,'promise:'||p.id||':'||p.revision) on conflict do nothing;
 end if;
end $$;

create function public.configure_promise_ledger(p_tenant_id text,p_revision integer,p_policy jsonb)
returns jsonb language plpgsql as $$
declare t public.tenants%rowtype; policy jsonb;
begin
 select * into t from public.tenants where tenant_id=p_tenant_id for update;
 if t.status is distinct from 'active' then raise exception 'Tenant unavailable' using errcode='42501'; end if;
 if coalesce((t.metadata->'promise_ledger'->>'version')::integer,0)<>p_revision then raise exception 'Policy revision changed' using errcode='40001'; end if;
 if jsonb_typeof(p_policy->'enabled')<>'boolean' or jsonb_typeof(p_policy->'shadow')<>'boolean'
 or (p_policy->'project_ids'<>'null'::jsonb and jsonb_typeof(p_policy->'project_ids')<>'array') then raise exception 'Invalid policy'; end if;
 if nullif(p_policy->>'local_person_id','') is not null and not exists(select 1 from public.contacts
  where tenant_id=p_tenant_id and id=(p_policy->>'local_person_id')::uuid) then raise exception 'Local participant unavailable'; end if;
 policy:=p_policy||jsonb_build_object('version',p_revision+1);
 update public.tenants set metadata=jsonb_set(coalesce(metadata,'{}'),'{promise_ledger}',policy) where tenant_id=p_tenant_id;
 return policy;
end $$;

create function public.commit_promise_job(p_tenant_id text,p_job_id uuid,p_lease uuid,p_items jsonb,p_outcome text,p_destination text default null)
returns jsonb language plpgsql as $$
declare j public.promise_jobs%rowtype; c public.communications%rowtype; p public.communication_commitments%rowtype;
 item jsonb; party jsonb; pid uuid; found_ids uuid[]:='{}'; n integer:=0; prior public.communication_commitments%rowtype;
begin
 select * into j from public.promise_jobs where tenant_id=p_tenant_id and id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease or j.lease_expires_at<now() then raise exception 'Promise lease changed' using errcode='40001'; end if;
 select * into c from public.communications where tenant_id=p_tenant_id and communication_id=j.communication_id for share;
 if not found or c.promise_revision<>j.source_revision then
  update public.promise_jobs set status='done',outcome='superseded',completed_at=now(),lease_token=null,lease_expires_at=null where id=j.id;
  return jsonb_build_object('outcome','superseded');
 end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100 then raise exception 'Invalid extraction batch'; end if;
 -- Serialize a thread's reconciliation, including two different channel jobs.
 perform pg_advisory_xact_lock(hashtext(p_tenant_id),hashtext(coalesce(c.thread_id,c.communication_id)));
 if p_outcome<>'provisional' then
  update public.promise_evidence set active=false where tenant_id=p_tenant_id and communication_id=c.communication_id and source_revision<>c.promise_revision;
 end if;
 for item in select value from jsonb_array_elements(p_items) loop
  if nullif(item->>'quote','') is null or nullif(item->>'evidence_key','') is null or nullif(item->>'description','') is null then raise exception 'Missing promise evidence'; end if;
  for party in select value from jsonb_array_elements((item->'promisor_parties')||(item->'promisee_parties')) loop
   if nullif(party->>'person_id','') is not null and not exists(select 1 from public.contacts where tenant_id=p_tenant_id and id=(party->>'person_id')::uuid) then raise exception 'Promise participant unavailable' using errcode='42501'; end if;
  end loop;
  select * into p from public.communication_commitments where tenant_id=p_tenant_id and communication_id=c.communication_id
   and (evidence_key=item->>'evidence_key' or (ledger_version is null and source_excerpt=item->>'quote')) order by created_at limit 1 for update;
  if p.id is null and nullif(item->>'target_id','') is not null then
   select * into p from public.communication_commitments where tenant_id=p_tenant_id and id=(item->>'target_id')::uuid
   and thread_id=c.thread_id and external_project_id is not distinct from c.correlation->>'external_project_id'
   and promisor_parties=item->'promisor_parties' and review_state<>'retracted' for update;
  end if;
  prior:=p;
  if p.id is not null and exists(select 1 from public.promise_evidence e where e.tenant_id=p_tenant_id and e.promise_id=p.id
   and e.communication_id=c.communication_id and e.source_revision=c.promise_revision and e.evidence_key=item->>'evidence_key' and e.kind=item->>'kind') then
   found_ids:=array_append(found_ids,p.id); n:=n+1; continue;
  end if;
  if p.id is null then
   insert into public.communication_commitments(tenant_id,communication_id,thread_id,description,source_excerpt,status,
    ledger_version,source_revision,evidence_key,external_project_id,project_id,promisor_parties,promisee_parties,promisor_contact_id,promisee_contact_id,
    origin,joint,review_state,observed_state,due_interpretation,confidence)
   values(p_tenant_id,c.communication_id,c.thread_id,left(item->>'description',1000),left(item->>'quote',1000),'open',1,c.promise_revision,
    item->>'evidence_key',c.correlation->>'external_project_id',c.project_id,item->'promisor_parties',item->'promisee_parties',
    nullif(item->'promisor_parties'->0->>'person_id','')::uuid,nullif(item->'promisee_parties'->0->>'person_id','')::uuid,
    item->>'origin',coalesce((item->>'joint')::boolean,false),'needs_review',item->>'kind',coalesce(item->'due','{}'),(item->>'confidence')::real)
   on conflict(tenant_id,communication_id,description) do update set ledger_version=1,revision=communication_commitments.revision+1
   returning * into p;
  else
   update public.communication_commitments set ledger_version=1,revision=revision+1,
    source_revision=case when communication_id=c.communication_id then c.promise_revision else source_revision end,
    evidence_key=coalesce(evidence_key,item->>'evidence_key'),
    thread_id=case when communication_id=c.communication_id then c.thread_id else thread_id end,
    external_project_id=case when communication_id=c.communication_id then c.correlation->>'external_project_id' else external_project_id end,
    project_id=case when communication_id=c.communication_id then c.project_id else project_id end,
    promisor_parties=case when review_state='confirmed' then promisor_parties else item->'promisor_parties' end,
    promisee_parties=case when review_state='confirmed' then promisee_parties else item->'promisee_parties' end,
    origin=item->>'origin',joint=coalesce((item->>'joint')::boolean,false),
    review_state=case when review_state='confirmed' then 'changed' else 'needs_review' end,
    observed_state=case when item->>'kind'='reaffirmed' then observed_state else item->>'kind' end,
    due_interpretation=case when review_state='confirmed' then due_interpretation else coalesce(item->'due','{}') end,
    updated_at=now() where id=p.id returning * into p;
  end if;
  insert into public.promise_evidence(tenant_id,promise_id,communication_id,source_revision,evidence_key,segment_id,quote,speaker,kind,source,extractor_version,confidence)
  values(p_tenant_id,p.id,c.communication_id,c.promise_revision,item->>'evidence_key',item->>'segment_id',item->>'quote',item->'speaker',item->>'kind',j.source,j.extractor_version,(item->>'confidence')::real)
  on conflict do nothing;
  perform public.record_promise_change(p,case when prior.id is null then 'extracted' else 'evidence_changed' end,'extractor:'||j.extractor_version,'Source-backed extraction',p_destination,j.backfill);
  found_ids:=array_append(found_ids,p.id); n:=n+1;
 end loop;
 -- Keep history when a corrected source no longer contains its previous promise.
 for p in select * from public.communication_commitments k where tenant_id=p_tenant_id and (communication_id=c.communication_id
  or exists(select 1 from public.promise_evidence e where e.tenant_id=p_tenant_id and e.promise_id=k.id and e.communication_id=c.communication_id))
  and not(id=any(found_ids)) and review_state<>'retracted' and p_outcome<>'provisional' for update loop
  update public.communication_commitments set revision=revision+1,ledger_version=1,
   source_revision=case when communication_id=c.communication_id then c.promise_revision else source_revision end,
   review_state=case when review_state in('confirmed','changed') or exists(select 1 from public.promise_evidence e
    where e.tenant_id=p_tenant_id and e.promise_id=p.id and e.active) then 'changed' else 'retracted' end,updated_at=now()
  where id=p.id returning * into p;
  perform public.record_promise_change(p,'source_retracted','extractor:promise-v1','Source no longer supports this promise',p_destination,j.backfill);
 end loop;
 update public.promise_jobs set status=case when p_outcome='provisional' then case when attempts>=5 then 'failed' else 'pending' end else 'done' end,
 outcome=p_outcome,completed_at=case when p_outcome='provisional' then null else now() end,lease_token=null,lease_expires_at=null,
 next_attempt_at=now()+interval '1 minute',last_error=case when p_outcome='provisional' then 'Model unavailable; provisional explicit extraction retained; retry required' else null end where id=j.id;
 return jsonb_build_object('outcome',p_outcome,'count',n);
end $$;

create function public.guard_promise_history() returns trigger language plpgsql as $$
begin
 if TG_OP='DELETE' and current_setting('app.tenant_lifecycle_write',true)=old.tenant_id then return old; end if;
 raise exception 'Promise history is append-only' using errcode='42501';
end $$;
create trigger promise_history_immutable before update or delete on public.promise_history for each row execute function public.guard_promise_history();

create function public.review_promise(p_tenant_id text,p_id uuid,p_revision integer,p_actor text,p_action text,p_reason text,p_patch jsonb,p_destination text default null)
returns jsonb language plpgsql as $$
declare p public.communication_commitments%rowtype; party jsonb;
begin
 select * into p from public.communication_commitments where tenant_id=p_tenant_id and id=p_id for update;
 if not found then raise exception 'Promise not found' using errcode='P0002'; end if;
 if p.revision<>p_revision then raise exception 'Promise revision changed' using errcode='40001'; end if;
 if p_action in('confirm','verify_fulfillment') and p.ledger_version is not null and not exists(select 1 from public.communications c
  where c.tenant_id=p_tenant_id and c.communication_id=p.communication_id and c.promise_revision=p.source_revision and c.memory_eligible=true) then
  raise exception 'Promise source changed' using errcode='40001';
 end if;
 if length(trim(p_reason))<1 or nullif(p_actor,'') is null then raise exception 'Actor and reason required'; end if;
 if p_action not in('confirm','dismiss','completion_claimed','verify_fulfillment','cancel','correct') then raise exception 'Invalid promise action'; end if;
 if p_patch ? 'promisor_parties' then
  if jsonb_array_length(p_patch->'promisor_parties') not between 1 and 100 then raise exception 'Promise participants required'; end if;
  if p.joint and jsonb_array_length(p_patch->'promisor_parties')<2 then raise exception 'A joint promise requires both participants'; end if;
  for party in select value from jsonb_array_elements(p_patch->'promisor_parties') loop
   if nullif(party->>'person_id','') is not null and not exists(select 1 from public.contacts where tenant_id=p_tenant_id and id=(party->>'person_id')::uuid) then raise exception 'Promise participant unavailable' using errcode='42501'; end if;
  end loop;
 end if;
 update public.communication_commitments set revision=revision+1,ledger_version=1,updated_at=now(),
  review_state=case when p_action='dismiss' then 'dismissed' when p_action in('confirm','correct','verify_fulfillment') then 'confirmed' else review_state end,
  observed_state=case when p_action='verify_fulfillment' then 'fulfilled' when p_action='cancel' then 'cancelled' when p_action='completion_claimed' then 'completion_claimed' else observed_state end,
  status=case when p_action='verify_fulfillment' then 'completed' when p_action in('cancel','dismiss') then 'cancelled' else status end,
  resolved_at=case when p_action in('verify_fulfillment','cancel','dismiss') then now() else resolved_at end,
  promisor_parties=coalesce(p_patch->'promisor_parties',promisor_parties),due_interpretation=coalesce(p_patch->'due',due_interpretation)
 where id=p.id returning * into p;
 perform public.record_promise_change(p,p_action,p_actor,p_reason,p_destination,false);
 return to_jsonb(p);
end $$;

-- Legacy IDs/statuses survive migration; terminal legacy state is not verified fulfillment.
update public.communication_commitments k set external_project_id=c.correlation->>'external_project_id',project_id=c.project_id,
 promisor_parties=jsonb_build_array(jsonb_build_object('person_id',k.promisor_contact_id,'role','counterparty','label','Legacy promisor')),
 promisee_parties=jsonb_build_array(jsonb_build_object('person_id',k.promisee_contact_id,'role','local','label','Legacy beneficiary')),
 observed_state=case when k.status='completed' then 'completion_claimed' when k.status='cancelled' then 'cancelled' else 'promised' end
 from public.communications c where c.tenant_id=k.tenant_id and c.communication_id=k.communication_id;
insert into public.promise_history(tenant_id,promise_id,revision,action,actor,reason,data)
 select tenant_id,id,revision,'legacy_import','migration:028','Legacy status is evidence, not verified fulfillment',to_jsonb(k) from public.communication_commitments k;

do $$ declare t text; f record; role_name text; begin
 if exists(select 1 from pg_roles where rolname='service_role') then
  grant select,insert,update on public.communication_commitments,public.outbound_events to service_role;
  grant select,update on public.communications to service_role;
 end if;
 foreach t in array array['promise_jobs','promise_evidence','promise_history'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public',t);
  insert into public.tenant_data_sets values(t,true);
  execute format('create trigger zzzz_tenant_lifecycle before insert or update or delete on public.%I for each row execute function public.guard_tenant_data_write()',t);
  foreach role_name in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute format('revoke all on public.%I from %I',t,role_name);
    if role_name='service_role' then execute format('grant select,insert,update,delete on public.%I to service_role',t); end if;
   end if;
  end loop;
 end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('promise_source','version_promise_source','queue_promise_source','reconcile_promise_jobs','claim_promise_job','record_promise_change','commit_promise_job','review_promise','guard_promise_history','configure_promise_ledger') loop
  execute format('revoke all on function %s from public',f.signature);
  foreach role_name in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute format('revoke all on function %s from %I',f.signature,role_name);
    if role_name='service_role' then execute format('grant execute on function %s to service_role',f.signature); end if;
   end if;
  end loop;
 end loop;
end $$;
commit;

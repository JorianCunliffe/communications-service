begin;
create function public.configure_review_owner(p_tenant_id text,p_revision integer,p_key text,p_binding jsonb)
returns jsonb language plpgsql as $$
declare t tenants%rowtype;policy jsonb;
begin
 select * into t from tenants where tenant_id=p_tenant_id for update;
 if t.status is distinct from 'active' then raise exception 'Tenant unavailable';end if;
 policy:=coalesce(t.metadata->'promise_ledger','{}');
 if coalesce((policy->>'version')::integer,0)<>p_revision then raise exception 'Owner policy changed' using errcode='40001';end if;
 if not exists(select 1 from contacts where tenant_id=p_tenant_id and id=(p_binding->>'person_id')::uuid) then raise exception 'Owner contact unavailable';end if;
 policy:=policy||jsonb_build_object('review_owners',coalesce(policy->'review_owners','{}'));
 policy:=jsonb_set(policy,array['review_owners',p_key],p_binding,true)||jsonb_build_object('version',p_revision+1);
 update tenants set metadata=jsonb_set(coalesce(metadata,'{}'),'{promise_ledger}',policy) where tenant_id=p_tenant_id;
 return policy;
end $$;
revoke all on function public.configure_review_owner(text,integer,text,jsonb) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function public.configure_review_owner(text,integer,text,jsonb) from %I',r);end if;
 end loop;
 if exists(select 1 from pg_roles where rolname='service_role') then grant execute on function public.configure_review_owner(text,integer,text,jsonb) to service_role;end if;
end $$;
create or replace function public.configure_promise_ledger(p_tenant_id text,p_revision integer,p_policy jsonb)
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
 policy:=coalesce(t.metadata->'promise_ledger','{}')||p_policy||jsonb_build_object('version',p_revision+1);
 update public.tenants set metadata=jsonb_set(coalesce(metadata,'{}'),'{promise_ledger}',policy) where tenant_id=p_tenant_id;
 return policy;
end $$;


commit;

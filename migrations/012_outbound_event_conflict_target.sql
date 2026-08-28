-- The PostgreSQL adapter emits ON CONFLICT (tenant_id,dedupe_key). PostgreSQL
-- cannot infer a partial unique index for that conflict target unless the same
-- predicate is present in the INSERT. A regular unique index remains safe here:
-- PostgreSQL permits multiple NULL dedupe keys, while non-NULL keys stay unique
-- within a tenant.

drop index if exists public.outbound_events_tenant_dedupe_unique;
create unique index outbound_events_tenant_dedupe_unique
  on public.outbound_events(tenant_id,dedupe_key);

-- Retry terminal calls that migration 011 requeued before the corrected index
-- was available. This is idempotent and preserves already-delivered calls.
insert into public.call_outcome_jobs
  (tenant_id,call_id,status,attempts,last_error,next_attempt_at,updated_at,
   completed_at,claimed_at,lease_token,lease_expires_at,rerun_requested)
select
  c.tenant_id,c.id,'pending',0,null,now(),now(),null,null,null,null,false
from public.calls c
where c.business_status in ('success','failed')
  and c.communication_id is not null
  and c.terminal_event_emitted_at is null
on conflict(call_id) do update set
  tenant_id=excluded.tenant_id,
  status='pending',attempts=0,last_error=null,next_attempt_at=now(),updated_at=now(),
  completed_at=null,claimed_at=null,lease_token=null,lease_expires_at=null,rerun_requested=false;

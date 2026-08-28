-- Terminal call events use a tenant-scoped dedupe key. Migration 009 changed
-- the unique index to (tenant_id,dedupe_key); requeue calls that reached a
-- business outcome while the service still used the obsolete single-column
-- conflict target so their terminal event can be emitted exactly once.

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

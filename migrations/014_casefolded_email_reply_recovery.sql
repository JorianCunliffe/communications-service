-- Versions before 2.2.4 generated mixed-case reply tokens and then normalised
-- their email addresses to lowercase. Requeue only the jobs stranded by that
-- exact routing failure now that the recorded outbound Reply-To can recover the
-- legacy route without weakening tenant or route uniqueness checks.

update public.communication_jobs j set
  status='pending',attempts=0,last_error=null,next_attempt_at=now(),updated_at=now(),
  completed_at=null,lease_token=null,lease_expires_at=null
from public.webhook_receipts r
where j.tenant_id=r.tenant_id and j.receipt_id=r.id
  and (j.status in ('pending','failed')
       or (j.status='processing' and (j.lease_expires_at is null or j.lease_expires_at<now())))
  and j.last_error='Inbound address did not resolve to exactly one trusted receiving identity'
  and r.provider_event_type='email.received';

update public.webhook_receipts set
  processing_status='pending',processed_at=null,last_error=null
where processing_status in ('pending','failed')
  and provider_event_type='email.received'
  and last_error='Inbound address did not resolve to exactly one trusted receiving identity';

-- Migration 010 allowed the retrieved message recipient to overwrite the
-- verified SMTP envelope recipient. Requeue only jobs stranded by that exact
-- routing failure so the corrected normalizer can recover them after deploy.

update public.communication_jobs j set
  status='pending',attempts=0,last_error=null,next_attempt_at=now(),updated_at=now(),
  completed_at=null,lease_token=null,lease_expires_at=null
from public.webhook_receipts r
where j.tenant_id=r.tenant_id and j.receipt_id=r.id
  and j.status='failed'
  and j.last_error='Inbound address did not resolve to exactly one trusted receiving identity'
  and r.provider_event_type='email.received';

update public.webhook_receipts set
  processing_status='pending',processed_at=null,last_error=null
where processing_status='failed'
  and provider_event_type='email.received'
  and last_error='Inbound address did not resolve to exactly one trusted receiving identity';

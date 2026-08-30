-- Once legacy reply routing was repaired, normalization reached an old insert
-- path that incorrectly included the provider attachment array in the email
-- row. Attachments belong in communication_attachments. Requeue only jobs that
-- failed with that exact schema error after the corrected insert is deployed.

update public.communication_jobs j set
  status='pending',attempts=0,last_error=null,next_attempt_at=now(),updated_at=now(),
  completed_at=null,lease_token=null,lease_expires_at=null
from public.webhook_receipts r
where j.tenant_id=r.tenant_id and j.receipt_id=r.id
  and (j.status in ('pending','failed')
       or (j.status='processing' and (j.lease_expires_at is null or j.lease_expires_at<now())))
  and j.last_error='column "attachments" of relation "email_messages" does not exist'
  and r.provider_event_type='email.received';

update public.webhook_receipts set
  processing_status='pending',processed_at=null,last_error=null
where processing_status in ('pending','failed')
  and provider_event_type='email.received'
  and last_error='column "attachments" of relation "email_messages" does not exist';

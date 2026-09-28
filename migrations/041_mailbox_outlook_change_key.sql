-- Saved provider version, committed atomically with the service revision.
begin;
alter table public.mailbox_drafts add column if not exists provider_change_key text;

create or replace function public.finalize_mailbox_draft_update(
  p_tenant_id text, p_provider_connection_id uuid, p_mailbox_draft_id uuid,
  p_receipt_id uuid, p_provider_draft_id text, p_provider_message_id text,
  p_provider_thread_id text, p_expected_revision integer, p_result jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare draft public.mailbox_drafts%rowtype; receipt_result jsonb;
begin
  select * into draft from public.mailbox_drafts
   where tenant_id=p_tenant_id and provider_connection_id=p_provider_connection_id
     and id=p_mailbox_draft_id and provider_draft_id=p_provider_draft_id
     and revision=p_expected_revision
     and (active_update_id=p_receipt_id or (active_update_id is null and exists(
       select 1 from public.mailbox_draft_update_receipts r where r.tenant_id=p_tenant_id
       and r.id=p_receipt_id and r.status='uncertain'))) for update;
  if not found then raise exception 'Mailbox draft revision or update claim changed' using errcode='40001'; end if;
  if not exists(select 1 from public.mailbox_draft_update_receipts where tenant_id=p_tenant_id
      and provider_connection_id=p_provider_connection_id and mailbox_draft_id=p_mailbox_draft_id
      and id=p_receipt_id and status in('applying','uncertain')) then
    raise exception 'Mailbox draft update receipt is not finalizable' using errcode='40001';
  end if;
  update public.mailbox_drafts set
    provider_draft_id=p_provider_draft_id,
    provider_message_id=coalesce(p_provider_message_id,provider_message_id),
    provider_thread_id=coalesce(p_provider_thread_id,provider_thread_id),
    provider_change_key=nullif(p_result->>'provider_change_key',''),
    revision=revision+1, active_update_id=null, active_update_lease_until=null,
    last_error=null, updated_at=now()
   where tenant_id=p_tenant_id and id=p_mailbox_draft_id returning * into draft;
  receipt_result:=jsonb_set(coalesce(p_result,'{}'::jsonb),'{revision}',to_jsonb(draft.revision),true);
  receipt_result:=jsonb_set(receipt_result,'{updated_at}',to_jsonb(draft.updated_at::text),true);
  update public.mailbox_draft_update_receipts set status='updated',result=receipt_result,
    lease_until=null,last_error=null,error_status=null,error_code=null,updated_at=now()
   where tenant_id=p_tenant_id and id=p_receipt_id;
  return receipt_result;
end $$;

commit;

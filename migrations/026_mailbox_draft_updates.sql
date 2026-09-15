-- Durable, idempotent provider-native mailbox draft revisions.

begin;

alter table public.outbound_operations
  drop constraint if exists outbound_operations_operation_type_check;

alter table public.outbound_operations
  add constraint outbound_operations_operation_type_check
  check (operation_type in ('sms','voice','email','mailbox_draft_update'));

commit;
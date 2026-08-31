-- Provider-neutral mailbox cursor for Gmail history IDs and Microsoft Graph delta links.

begin;

alter table public.mailbox_sync_state
  add column if not exists provider_cursor text;

update public.mailbox_sync_state
   set provider_cursor=history_id
 where provider_cursor is null
   and history_id is not null;

commit;

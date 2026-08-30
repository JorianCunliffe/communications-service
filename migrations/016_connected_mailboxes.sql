-- Tenant-owned connected mailboxes, encrypted OAuth material, sync state and drafts.

begin;

create table if not exists public.mailbox_oauth_credentials (
  provider_connection_id uuid primary key references public.provider_connections(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  encrypted_payload text not null,
  key_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider_connection_id),
  foreign key(tenant_id,provider_connection_id)
    references public.provider_connections(tenant_id,id) on delete cascade
);

create table if not exists public.mailbox_sync_state (
  provider_connection_id uuid primary key references public.provider_connections(id) on delete cascade,
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  history_id text,
  watch_expiration timestamptz,
  status text not null default 'pending' check(status in('pending','healthy','syncing','degraded','expired','revoked')),
  last_attempt_at timestamptz,
  last_successful_sync_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider_connection_id),
  foreign key(tenant_id,provider_connection_id)
    references public.provider_connections(tenant_id,id) on delete cascade
);

create table if not exists public.mailbox_oauth_states (
  nonce_hash text primary key,
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  initiator_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.mailbox_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  provider_connection_id uuid not null references public.provider_connections(id) on delete restrict,
  communication_id text,
  provider_draft_id text,
  provider_message_id text,
  provider_thread_id text,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'creating' check(status in('creating','created','failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider_connection_id,idempotency_key),
  foreign key(tenant_id,provider_connection_id)
    references public.provider_connections(tenant_id,id) on delete restrict
);

create table if not exists public.mailbox_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  provider_connection_id uuid references public.provider_connections(id) on delete set null,
  actor_id text,
  action text not null,
  outcome text not null check(outcome in('accepted','succeeded','failed','ignored')),
  details jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

create index if not exists mailbox_sync_due
  on public.mailbox_sync_state(status,watch_expiration,last_successful_sync_at);
create index if not exists mailbox_audit_tenant_time
  on public.mailbox_audit_events(tenant_id,occurred_at desc);
create index if not exists mailbox_oauth_states_expiry
  on public.mailbox_oauth_states(expires_at) where used_at is null;

create or replace function public.consume_mailbox_oauth_state(
  p_tenant_id text,
  p_nonce_hash text,
  p_initiator_id text
) returns boolean language plpgsql as $$
declare changed integer;
begin
  update public.mailbox_oauth_states
     set used_at=now()
   where tenant_id=p_tenant_id
     and nonce_hash=p_nonce_hash
     and initiator_id=p_initiator_id
     and used_at is null
     and expires_at>now();
  get diagnostics changed = row_count;
  return changed=1;
end $$;

create or replace function public.claim_mailbox_sync(
  p_tenant_id text,
  p_provider_connection_id uuid,
  p_lease_seconds int default 300
) returns boolean language plpgsql as $$
declare changed integer;
begin
  update public.mailbox_sync_state
     set status='syncing',last_attempt_at=now(),last_error=null,updated_at=now()
   where tenant_id=p_tenant_id
     and provider_connection_id=p_provider_connection_id
     and (status<>'syncing' or last_attempt_at is null or last_attempt_at<now()-make_interval(secs=>greatest(p_lease_seconds,30)));
  get diagnostics changed = row_count;
  return changed=1;
end $$;

alter table public.mailbox_oauth_credentials enable row level security;
alter table public.mailbox_sync_state enable row level security;
alter table public.mailbox_oauth_states enable row level security;
alter table public.mailbox_drafts enable row level security;
alter table public.mailbox_audit_events enable row level security;

revoke execute on function public.consume_mailbox_oauth_state(text,text,text) from public;
revoke execute on function public.claim_mailbox_sync(text,uuid,integer) from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on public.mailbox_oauth_credentials, public.mailbox_sync_state, public.mailbox_oauth_states, public.mailbox_drafts, public.mailbox_audit_events from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on public.mailbox_oauth_credentials, public.mailbox_sync_state, public.mailbox_oauth_states, public.mailbox_drafts, public.mailbox_audit_events from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant select, insert, update, delete on public.mailbox_oauth_credentials, public.mailbox_sync_state, public.mailbox_oauth_states, public.mailbox_drafts, public.mailbox_audit_events to service_role';
    execute 'grant execute on function public.consume_mailbox_oauth_state(text,text,text) to service_role';
    execute 'grant execute on function public.claim_mailbox_sync(text,uuid,integer) to service_role';
  end if;
end $$;

commit;

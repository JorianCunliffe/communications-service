-- Provider-owned email delivery, immutable webhook receipts and opaque replies.

begin;

create table if not exists public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  provider text not null,
  provider_account_id text not null,
  display_name text,
  credential_reference text not null,
  webhook_secret_reference text,
  webhook_verification jsonb not null default '{}',
  channels text[] not null default '{}',
  default_callback_url text,
  enabled boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider,provider_account_id),
  check (default_callback_url is null or default_callback_url like 'https://%')
);

create table if not exists public.service_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  provider_connection_id uuid not null references public.provider_connections(id) on delete cascade,
  channel text not null,
  address text not null,
  display_name text,
  can_send boolean not null default false,
  can_receive boolean not null default false,
  is_default boolean not null default false,
  reply_domain text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,channel,address)
);

create table if not exists public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  provider_connection_id uuid not null references public.provider_connections(id) on delete restrict,
  provider_event_id text not null,
  provider_event_type text,
  raw_body text not null,
  raw_payload jsonb,
  signature_headers jsonb not null default '{}',
  received_at timestamptz not null default now(),
  verified_at timestamptz not null,
  processing_status text not null default 'pending' check(processing_status in('pending','processing','processed','ignored','failed')),
  processed_at timestamptz,
  last_error text,
  unique(provider_connection_id,provider_event_id)
);

create table if not exists public.communication_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  receipt_id uuid not null unique references public.webhook_receipts(id) on delete cascade,
  job_type text not null default 'email_normalize',
  status text not null default 'pending' check(status in('pending','processing','done','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  communication_id text not null,
  thread_id text,
  person_id uuid references public.contacts(id) on delete set null,
  purpose jsonb,
  correlation jsonb not null default '{}',
  callback_url text,
  receipt_id uuid references public.webhook_receipts(id) on delete set null,
  provider_connection_id uuid not null references public.provider_connections(id) on delete restrict,
  service_identity_id uuid references public.service_identities(id) on delete set null,
  provider_email_id text,
  provider_conversation_id text,
  message_id text,
  in_reply_to text,
  references_header text[] not null default '{}',
  direction text not null check(direction in('inbound','outbound')),
  from_addresses jsonb not null default '[]',
  to_addresses jsonb not null default '[]',
  cc_addresses jsonb not null default '[]',
  bcc_addresses jsonb not null default '[]',
  reply_to_addresses jsonb not null default '[]',
  subject text,
  text_body text,
  sanitized_html text,
  headers jsonb not null default '{}',
  spam_results jsonb not null default '{}',
  authentication_results jsonb not null default '{}',
  triage_class text,
  automated boolean not null default false,
  bounce boolean not null default false,
  memory_eligible boolean not null default true,
  delivery_status text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists email_messages_tenant_provider_unique
  on public.email_messages(tenant_id,provider_connection_id,provider_email_id) where provider_email_id is not null;
create index if not exists email_messages_tenant_threading
  on public.email_messages(tenant_id,message_id,in_reply_to,provider_conversation_id);

create table if not exists public.communication_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  communication_id text not null,
  email_message_id uuid references public.email_messages(id) on delete cascade,
  provider_attachment_id text,
  filename text,
  content_type text,
  size_bytes bigint,
  content_disposition text,
  content_id text,
  storage_reference text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.email_reply_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(tenant_id) on delete restrict,
  token_hash text not null unique,
  thread_id text not null,
  ask_id text,
  person_id uuid references public.contacts(id) on delete set null,
  service_identity_id uuid not null references public.service_identities(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists email_reply_routes_tenant_thread on public.email_reply_routes(tenant_id,thread_id,expires_at desc);

create index if not exists provider_connections_tenant on public.provider_connections(tenant_id,provider,enabled);
create index if not exists service_identities_tenant on public.service_identities(tenant_id,channel,address);
create index if not exists webhook_receipts_tenant_status on public.webhook_receipts(tenant_id,processing_status,received_at);
create index if not exists communication_jobs_due on public.communication_jobs(status,next_attempt_at) where status in('pending','processing');

create unique index if not exists provider_connections_tenant_id_unique on public.provider_connections(tenant_id,id);
create unique index if not exists service_identities_tenant_id_unique on public.service_identities(tenant_id,id);
create unique index if not exists webhook_receipts_tenant_id_unique on public.webhook_receipts(tenant_id,id);
create unique index if not exists email_messages_tenant_id_unique on public.email_messages(tenant_id,id);
do $$ begin
  alter table public.service_identities add constraint service_identities_tenant_connection_fk
    foreign key(tenant_id,provider_connection_id) references public.provider_connections(tenant_id,id);
  alter table public.webhook_receipts add constraint webhook_receipts_tenant_connection_fk
    foreign key(tenant_id,provider_connection_id) references public.provider_connections(tenant_id,id);
  alter table public.communication_jobs add constraint communication_jobs_tenant_receipt_fk
    foreign key(tenant_id,receipt_id) references public.webhook_receipts(tenant_id,id);
  alter table public.email_messages add constraint email_messages_tenant_connection_fk
    foreign key(tenant_id,provider_connection_id) references public.provider_connections(tenant_id,id);
  alter table public.email_messages add constraint email_messages_tenant_identity_fk
    foreign key(tenant_id,service_identity_id) references public.service_identities(tenant_id,id);
  alter table public.communication_attachments add constraint attachments_tenant_email_fk
    foreign key(tenant_id,email_message_id) references public.email_messages(tenant_id,id);
  alter table public.email_reply_routes add constraint reply_routes_tenant_identity_fk
    foreign key(tenant_id,service_identity_id) references public.service_identities(tenant_id,id);
exception when duplicate_object then null;
end $$;

create or replace function public.claim_communication_jobs(p_limit int default 20,p_lease_seconds int default 60)
returns setof public.communication_jobs language plpgsql as $$
begin
  return query
  with candidates as (
    select id from public.communication_jobs
     where (status='pending' and next_attempt_at<=now()) or (status='processing' and lease_expires_at<now())
     order by next_attempt_at,created_at for update skip locked limit greatest(1,least(p_limit,100))
  )
  update public.communication_jobs j set status='processing',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,10)),updated_at=now()
  from candidates c where j.id=c.id returning j.*;
end $$;

alter table public.provider_connections enable row level security;
alter table public.service_identities enable row level security;
alter table public.webhook_receipts enable row level security;
alter table public.communication_jobs enable row level security;
alter table public.email_messages enable row level security;
alter table public.communication_attachments enable row level security;
alter table public.email_reply_routes enable row level security;

-- Supabase no longer guarantees that newly-created public tables receive Data
-- API grants. Keep browser roles denied while granting the backend service-role
-- client exactly the table and RPC access used by the Communications service.
revoke execute on function public.claim_communication_jobs(integer,integer) from public;
do $$
begin
  if exists(select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on public.provider_connections, public.service_identities, public.webhook_receipts, public.communication_jobs, public.email_messages, public.communication_attachments, public.email_reply_routes from anon';
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on public.provider_connections, public.service_identities, public.webhook_receipts, public.communication_jobs, public.email_messages, public.communication_attachments, public.email_reply_routes from authenticated';
  end if;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on public.provider_connections, public.service_identities, public.webhook_receipts, public.communication_jobs, public.email_messages, public.communication_attachments, public.email_reply_routes to service_role';
    execute 'grant execute on function public.claim_communication_jobs(integer,integer) to service_role';
  end if;
end $$;

commit;

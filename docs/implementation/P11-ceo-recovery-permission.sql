-- Operator-reviewed production setup, not an automatic migration.
-- Authorized and applied 2026-09-09: grants only tenant:manage to the existing CEO integration.
-- No tenant:erase, role, tenant list, secret or email-policy change.
-- Run in Communications production; one atomic update plus audit, safe on replay.
with changed as (
  update public.api_clients
  set capabilities=array_append(capabilities,'tenant:manage'), revision=revision+1
  where key_id='client_fb0b19dca185e6ae'
    and allowed_tenants=array['org_1786407621909']::text[]
    and roles=array['admin']::text[]
    and managed_tenant_id is null and revoked_at is null and revision=1
    and capabilities=array['communications:read','communications:write','email:send',
      'management:read','management:write','email:draft','mailbox:manage']::text[]
  returning key_id,revision
)
insert into public.tenant_admin_audit(tenant_id,actor,operation,resource_id,revision)
select 'org_1786407621909','operator:phase11-ceo-recovery-20260909',
  'client.grant.tenant_manage',key_id,revision from changed
returning tenant_id,operation,resource_id,revision;

-- Verify the resulting scoped grant and the authenticated HyperFlow recovery read.
-- A zero-row result requires inspection, not a broader update.

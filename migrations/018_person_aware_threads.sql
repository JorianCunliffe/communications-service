-- Resolve semantic threads across a person's verified channel identities.
-- Existing threads are backfilled only when their communications or recorded
-- participant identity resolve to exactly one tenant-owned person.

begin;

alter table public.communication_threads
  add column if not exists person_id uuid;

with member_people as (
  select m.tenant_id, m.thread_id, (array_agg(distinct c.person_id))[1] as person_id
  from public.communication_thread_members m
  join public.communications c
    on c.tenant_id=m.tenant_id and c.id=m.communication_row_id
  where c.person_id is not null
  group by m.tenant_id,m.thread_id
  having count(distinct c.person_id)=1
)
update public.communication_threads t
set person_id=p.person_id
from member_people p
where t.tenant_id=p.tenant_id and t.thread_id=p.thread_id and t.person_id is null;

with identity_people as (
  select t.tenant_id,t.thread_id,(array_agg(distinct i.person_id))[1] as person_id
  from public.communication_threads t
  join public.communication_identities i
    on i.tenant_id=t.tenant_id and lower(i.value)=lower(t.participant_identity)
  where t.person_id is null and nullif(t.participant_identity,'') is not null
  group by t.tenant_id,t.thread_id
  having count(distinct i.person_id)=1
)
update public.communication_threads t
set person_id=p.person_id
from identity_people p
where t.tenant_id=p.tenant_id and t.thread_id=p.thread_id and t.person_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname='communication_threads_tenant_person_fk'
  ) then
    alter table public.communication_threads
      add constraint communication_threads_tenant_person_fk
      foreign key(tenant_id,person_id) references public.contacts(tenant_id,id) on delete set null;
  end if;
end $$;

create index if not exists communication_threads_tenant_person_open
  on public.communication_threads(tenant_id,person_id,last_activity_at desc)
  where status='open' and person_id is not null;

commit;

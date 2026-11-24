begin;

alter table public.phone_configs
  add column line_role text not null default 'existing' check (line_role in ('existing','client','caller_override')),
  add column sms_enabled boolean not null default true;

-- Historical and rolling-deployment writers both record the trusted Twilio leg here.
alter table public.calls add column twilio_number text generated always as (
  case when direction='inbound' and metadata->>'to' ~ '^\+[1-9][0-9]{1,14}$' then metadata->>'to'
       when direction='outbound' and metadata->>'from' ~ '^\+[1-9][0-9]{1,14}$' then metadata->>'from' end
) stored;
create index calls_line_history on public.calls(tenant_id,twilio_number,phone_number,started_at desc);
create index sms_threads_line_clients on public.sms_threads(tenant_id,twilio_number,phone_number);

create function public.phone_line_history(p_tenant_id text, p_line text, p_client text,
  p_before timestamptz, p_before_id text, p_limit integer, p_about text, p_since timestamptz, p_until timestamptz)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  with legs as (
    select c.id, 'calls' as source, c.phone_number as client, c.status
    from public.calls c where c.tenant_id=p_tenant_id and c.twilio_number=p_line
      and (p_client is null or c.phone_number=p_client)
      and coalesce(c.metadata->>'briefingPrivate','false') <> 'true'
    union all
    select m.id, 'sms_messages', t.phone_number, m.status
    from public.sms_threads t join public.sms_messages m on m.thread_id=t.id and m.tenant_id=t.tenant_id
    where t.tenant_id=p_tenant_id and t.twilio_number=p_line and (p_client is null or t.phone_number=p_client)
  ), events as (
    select c.communication_id, c.occurred_at, c.channel, c.direction, legs.client, legs.status,
      case when c.memory_eligible then left(coalesce(nullif(c.summary,''),c.body,''),4000) end as content
    from legs join public.communications c on c.tenant_id=p_tenant_id and c.source_id=legs.id and c.source_table=legs.source
    where coalesce(c.purpose->>'type','') not in ('briefing_verification','reception_verification','project_reception')
      and not (c.metadata @> '{"private":true}' or c.metadata @> '{"retracted":true}' or c.metadata @> '{"intake_pending":true}')
      and coalesce(c.metadata->>'visibility','') not in ('private','restricted')
      and (p_client is null or c.memory_eligible)
      and (not c.memory_eligible or (coalesce(c.disposition,'') not in ('spam','bounce','automatic_reply','mailing_list','system_generated','voicemail','no_answer','failed')
           and (c.channel <> 'voice' or not (c.metadata @> '{"successful":false}' or c.metadata @> '{"memory_eligible":false}'))))
      and (p_before_id is null or (c.occurred_at,c.communication_id)<
        (coalesce(p_before,(select a.occurred_at from public.communications a where a.tenant_id=p_tenant_id and a.communication_id=p_before_id)),p_before_id))
      and (p_since is null or c.occurred_at>=p_since) and (p_until is null or c.occurred_at<p_until)
      and (p_about is null or (c.memory_eligible and strpos(lower(concat_ws(' ',c.summary,c.body)),lower(p_about))>0))
    order by c.occurred_at desc,c.communication_id desc limit least(greatest(p_limit,1),101)
  ) select coalesce(jsonb_agg(to_jsonb(events) order by occurred_at desc,communication_id desc),'[]'::jsonb) from events
$$;
revoke all on function public.phone_line_history(text,text,text,timestamptz,text,integer,text,timestamptz,timestamptz) from public;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant execute on function public.phone_line_history(text,text,text,timestamptz,text,integer,text,timestamptz,timestamptz) to service_role;
  end if;
end $$;

commit;

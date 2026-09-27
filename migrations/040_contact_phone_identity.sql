-- The contact phone trigger already inserts the Twilio identity. Reuse only
-- identities belonging to the newly created person; never reassign another person.
create or replace function public.create_communication_contact(p_tenant_id text,p_name text,p_phone_number text,p_identities jsonb default '[]')
returns jsonb language plpgsql as $$
declare person public.contacts%rowtype; identity jsonb;
begin
  insert into public.contacts(tenant_id,name,phone_number) values(p_tenant_id,p_name,p_phone_number) returning * into person;
  for identity in select * from jsonb_array_elements(coalesce(p_identities,'[]')) loop
    update public.communication_identities
      set metadata=coalesce(identity->'metadata','{}'),updated_at=now()
      where tenant_id=p_tenant_id and person_id=person.id
        and type=identity->>'type' and value=lower(identity->>'value')
        and coalesce(provider,'')=coalesce(nullif(identity->>'provider',''),'');
    if not found then
      insert into public.communication_identities(tenant_id,person_id,type,value,provider,metadata)
      values(p_tenant_id,person.id,identity->>'type',lower(identity->>'value'),nullif(identity->>'provider',''),coalesce(identity->'metadata','{}'));
    end if;
  end loop;
  return to_jsonb(person);
end $$;

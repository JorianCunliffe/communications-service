-- Extend the existing primary communications search for explainable memory
-- retrieval. This replaces the function in 002; it does not create a second
-- communications search surface.

begin;

drop function if exists public.search_communications(text,uuid,uuid,timestamptz,timestamptz,text[],int,real);

create or replace function public.search_communications(
  q                 text        default null,
  contact           uuid        default null,
  project           uuid        default null,
  since             timestamptz default null,
  until             timestamptz default null,
  channels          text[]      default null,
  max_results       int         default 5,
  fuzzy_threshold   real        default 0.35,
  thread            text        default null,
  calendar_event    uuid        default null
)
returns table (
  id                uuid,
  communication_id  text,
  channel           text,
  occurred_at       timestamptz,
  direction         text,
  contact_id        uuid,
  project_id        uuid,
  thread_id         text,
  calendar_event_id uuid,
  subject           text,
  summary           text,
  body              text,
  rank              real,
  matched_by        text
)
language plpgsql stable as $$
declare cleaned text; tsq tsquery;
begin
  cleaned := lower(coalesce(q, ''));
  cleaned := regexp_replace(cleaned, '([0-9]),([0-9])', '\1\2', 'g');
  cleaned := btrim(regexp_replace(regexp_replace(cleaned, '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'));
  if cleaned <> '' then
    select to_tsquery('english', string_agg(w || ':*', '|')) into tsq
      from unnest(string_to_array(cleaned, ' ')) as w where w <> '' and length(w) > 1;
  end if;
  perform set_config('pg_trgm.word_similarity_threshold', fuzzy_threshold::text, true);

  return query select * from (
    select c.id, c.communication_id, c.channel, c.occurred_at, c.direction, c.contact_id, c.project_id,
           c.thread_id, c.calendar_event_id, c.subject, c.summary, c.body,
           (coalesce(ts_rank(c.search, tsq, 1),0)
             + coalesce(word_similarity(cleaned,coalesce(c.body_them,c.body,'')),0)*0.05)::real as rank,
           case when tsq is null then 'filter'
                when c.search @@ tsq and cleaned <% coalesce(c.body,'') then 'both'
                when c.search @@ tsq then 'text' else 'fuzzy' end as matched_by
      from public.communications c
     where (contact is null or c.contact_id=contact)
       and (project is null or c.project_id=project)
       and (thread is null or c.thread_id=thread)
       and (calendar_event is null or c.calendar_event_id=calendar_event)
       and (since is null or c.occurred_at>=since)
       and (until is null or c.occurred_at<until)
       and (channels is null or c.channel=any(channels))
       and (tsq is null or c.search @@ tsq or cleaned <% coalesce(c.body,''))
  ) hit order by hit.rank desc, hit.occurred_at desc
  limit greatest(1,least(coalesce(max_results,5),100));
end $$;

commit;

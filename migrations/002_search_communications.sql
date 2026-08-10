-- Search that survives a voice query.
--
-- Why this exists: on a real call Iris took 66 seconds and four searches to
-- find a two-line SMS. The searches were "3500 Arcandy quote", "Arkendey",
-- "$3,500" and finally "culvert". Only the last one worked. Three separate
-- defects, all measured against this database:
--
--   1. Every word had to match, so one word the caller's speech mangled
--      ("arcandy") vetoed two that were correct ("3500", "quote").
--   2. No fuzzy matching, so "Arkendey" could not reach "Arkendeith". Speech
--      recognition mangling an unusual proper noun is the normal case, not an
--      edge case.
--   3. The caller and the assistant were indexed at the same weight, so a call
--      in which Iris repeatedly said "Arkendey" and "3,500 dollars" while
--      finding nothing now outranks the message that holds the answer.
--
-- Measured after the fixes below, against the same four queries: the first one
-- returns the right message, ranked. "Arcandy" alone still misses at 0.25
-- word similarity, and the threshold is not being dropped to 0.2 to catch it,
-- because that starts matching noise.
--
-- Apply with: Supabase dashboard -> SQL Editor -> paste -> Run.
-- Safe to run more than once; every statement is guarded.

begin;

-- --------------------------------------------------------------------------
-- 1. Separate what the caller said from what the assistant said
-- --------------------------------------------------------------------------
-- The assistant repeats the caller's words back constantly - "I'm checking the
-- record for Arkendey" - so a transcript is evidence of the search as much as
-- of the conversation. Indexing both sides equally lets a failed search rank
-- above the answer it failed to find.

alter table public.communications add column if not exists body_them text;

-- The generated column has to be dropped to be redefined. This also drops the
-- GIN index on it, which is recreated below.
alter table public.communications drop column if exists search;
alter table public.communications add column search tsvector generated always as (
  setweight(to_tsvector('english', coalesce(subject,   '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary,   '')), 'B') ||
  -- What the other party actually said, at twice the weight of the transcript
  -- as a whole. ts_rank's defaults are C = 0.2 and D = 0.1.
  setweight(to_tsvector('english', coalesce(body_them, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(body,      '')), 'D')
) stored;

create index if not exists communications_search on public.communications using gin (search);

-- Trigram index so the fuzzy half of the search is indexable rather than a
-- sequential scan over every transcript.
create index if not exists communications_body_trgm
  on public.communications using gin (body gin_trgm_ops);
create index if not exists communications_body_them_trgm
  on public.communications using gin (body_them gin_trgm_ops);

-- --------------------------------------------------------------------------
-- 2. Teach the projections to fill it
-- --------------------------------------------------------------------------
-- Same error-swallowing contract as 001: these fire on writes to public.calls,
-- which happen mid-call, and an AFTER trigger that raises aborts the statement
-- that fired it. A failed projection must cost an index entry, never a
-- transcript.

create or replace function public.project_call_to_communications()
returns trigger language plpgsql as $$
declare
  flat  text;
  spoke text;
begin
  select string_agg(
           coalesce(seg->>'role', 'unknown') || ': ' || coalesce(seg->>'text', ''),
           E'\n' order by ord)
    into flat
    from jsonb_array_elements(coalesce(new.transcript->'segments', '[]'::jsonb))
         with ordinality as t(seg, ord);

  -- The caller's turns alone.
  select string_agg(coalesce(seg->>'text', ''), E'\n' order by ord)
    into spoke
    from jsonb_array_elements(coalesce(new.transcript->'segments', '[]'::jsonb))
         with ordinality as t(seg, ord)
   where seg->>'role' = 'user';

  insert into public.communications
    (channel, source_table, source_id, contact_id, occurred_at, direction, body, body_them, summary, metadata)
  values
    ('call', 'calls', new.id, new.contact_id, coalesce(new.started_at, now()), new.direction,
     flat, spoke, new.summary,
     jsonb_build_object('twilio_call_sid', new.twilio_call_sid, 'status', new.status))
  on conflict (source_table, source_id) do update
     set contact_id  = excluded.contact_id,
         occurred_at = excluded.occurred_at,
         direction   = excluded.direction,
         body        = excluded.body,
         body_them   = excluded.body_them,
         summary     = excluded.summary,
         metadata    = excluded.metadata,
         updated_at  = now();
  return new;
exception when others then
  raise warning 'communications projection failed for call %: %', new.id, sqlerrm;
  return new;
end $$;

create or replace function public.project_sms_to_communications()
returns trigger language plpgsql as $$
declare
  who uuid;
begin
  select contact_id into who from public.sms_threads where id = new.thread_id;

  insert into public.communications
    (channel, source_table, source_id, contact_id, occurred_at, direction, body, body_them, metadata)
  values
    ('sms', 'sms_messages', new.id, who, coalesce(new.created_at, now()), new.direction,
     new.content,
     -- An inbound message is entirely the other party speaking.
     case when new.direction = 'inbound' then new.content else null end,
     jsonb_build_object('twilio_message_sid', new.twilio_message_sid))
  on conflict (source_table, source_id) do update
     set contact_id  = excluded.contact_id,
         occurred_at = excluded.occurred_at,
         direction   = excluded.direction,
         body        = excluded.body,
         body_them   = excluded.body_them,
         updated_at  = now();
  return new;
exception when others then
  raise warning 'communications projection failed for sms %: %', new.id, sqlerrm;
  return new;
end $$;

create or replace function public.project_recording_to_communications()
returns trigger language plpgsql as $$
declare
  flat  text;
  spoke text;
begin
  if new.call_id is not null then return new; end if;
  if new.status is distinct from 'done' then return new; end if;

  select string_agg(
           coalesce(seg->>'role', 'unknown') || ': ' || coalesce(seg->>'text', ''),
           E'\n' order by ord)
    into flat
    from jsonb_array_elements(coalesce(new.transcript->'segments', '[]'::jsonb))
         with ordinality as t(seg, ord);

  select string_agg(coalesce(seg->>'text', ''), E'\n' order by ord)
    into spoke
    from jsonb_array_elements(coalesce(new.transcript->'segments', '[]'::jsonb))
         with ordinality as t(seg, ord)
   where seg->>'role' = 'user';

  insert into public.communications
    (channel, source_table, source_id, contact_id, occurred_at, body, body_them, metadata)
  values
    ('recording', 'recordings', new.id, new.contact_id,
     coalesce(new.recorded_at, new.created_at, now()),
     coalesce(flat, new.transcript_text), spoke,
     jsonb_build_object('source', new.source, 'external_id', new.external_id))
  on conflict (source_table, source_id) do update
     set contact_id  = excluded.contact_id,
         occurred_at = excluded.occurred_at,
         body        = excluded.body,
         body_them   = excluded.body_them,
         metadata    = excluded.metadata,
         updated_at  = now();
  return new;
exception when others then
  raise warning 'communications projection failed for recording %: %', new.id, sqlerrm;
  return new;
end $$;

-- --------------------------------------------------------------------------
-- 3. The search itself
-- --------------------------------------------------------------------------
-- One query does contact, project, channel, date and text together, because
-- the voice model is bad at orchestrating several narrow lookups and good at
-- asking one broad question.
--
-- Text matching is deliberately forgiving in two ways:
--
--   OR, not AND. Every word is a prefix term joined with '|', and ts_rank
--   sorts by how much of the question a row answers. A mangled word costs a
--   row some rank; it cannot veto the row.
--
--   Trigram fallback. A row whose text contains a word close enough to the
--   query is a candidate even with no lexeme in common, which is what lets
--   "Arkendey" reach "Arkendeith" (word similarity 0.78).

create or replace function public.search_communications(
  q               text        default null,
  contact         uuid        default null,
  project         uuid        default null,
  since           timestamptz default null,
  until           timestamptz default null,
  channels        text[]      default null,
  max_results     int         default 5,
  fuzzy_threshold real        default 0.35
)
returns table (
  id          uuid,
  channel     text,
  occurred_at timestamptz,
  direction   text,
  contact_id  uuid,
  project_id  uuid,
  subject     text,
  summary     text,
  body        text,
  rank        real,
  matched_by  text
)
language plpgsql
stable
as $$
declare
  cleaned text;
  tsq     tsquery;
begin
  -- Punctuation out, so "$3,500" and "3500" are the same question. Speech
  -- recognition inserts commas and currency symbols the caller never said.
  cleaned := btrim(regexp_replace(
               lower(regexp_replace(coalesce(q, ''), '[^a-z0-9 ]', ' ', 'gi')),
               '\s+', ' ', 'g'));

  if cleaned <> '' then
    select to_tsquery('english', string_agg(w || ':*', '|'))
      into tsq
      from unnest(string_to_array(cleaned, ' ')) as w
     where w <> '' and length(w) > 1;
  end if;

  -- Local to the transaction, so the '<%' operator can use the trigram index
  -- at the threshold this call asked for.
  perform set_config('pg_trgm.word_similarity_threshold', fuzzy_threshold::text, true);

  return query
  select * from (
    select c.id,
           c.channel,
           c.occurred_at,
           c.direction,
           c.contact_id,
           c.project_id,
           c.subject,
           c.summary,
           c.body,
           (coalesce(ts_rank(c.search, tsq), 0)
              -- A small nudge, not a second ranking. Fuzzy matching is here to
              -- make a row reachable; full text still decides the order.
              + coalesce(word_similarity(cleaned, coalesce(c.body_them, c.body, '')), 0) * 0.05
           )::real as rank,
           case
             when tsq is null                       then 'filter'
             when c.search @@ tsq
              and cleaned <% coalesce(c.body, '')   then 'both'
             when c.search @@ tsq                   then 'text'
             else                                        'fuzzy'
           end as matched_by
      from public.communications c
     where (contact  is null or c.contact_id  = contact)
       and (project  is null or c.project_id  = project)
       and (since    is null or c.occurred_at >= since)
       and (until    is null or c.occurred_at <  until)
       and (channels is null or c.channel = any (channels))
       and (tsq is null
            or c.search @@ tsq
            or cleaned <% coalesce(c.body, ''))
  ) hit
  order by hit.rank desc, hit.occurred_at desc
  limit greatest(1, least(coalesce(max_results, 5), 25));
end $$;

-- --------------------------------------------------------------------------
-- 4. "Did you mean"
-- --------------------------------------------------------------------------
-- So a miss can offer the spelling instead of asking the caller to recite
-- letters down the phone, which is what happened on the call that prompted
-- this migration.
--
-- Known limit: the 'said' source scans the 200 most recent rows. Names and
-- aliases are trigram-indexed and scale; the body scan does not, and should be
-- replaced by a maintained vocabulary table before this database gets large.

create or replace function public.suggest_terms(
  q           text,
  max_results int default 3
)
returns table (term text, kind text, score real)
language sql
stable
as $$
  with candidates as (
    select c.name as term, 'contact' as kind
      from public.contacts c
     where c.name is not null and c.name <> ''
    union all
    select p.name, 'project' from public.projects p
    union all
    select unnest(p.aliases), 'project' from public.projects p
    union all
    select distinct w, 'said'
      from (select coalesce(c.body_them, c.body, '') as t
              from public.communications c
             order by c.occurred_at desc
             limit 200) recent,
           lateral unnest(
             regexp_split_to_array(lower(regexp_replace(recent.t, '[^a-z0-9]+', ' ', 'g')), ' ')
           ) as w
     where length(w) >= 4
  )
  select candidates.term,
         candidates.kind,
         similarity(lower(q), lower(candidates.term))::real as score
    from candidates
   where candidates.term <> ''
     and similarity(lower(q), lower(candidates.term)) > 0.25
   order by score desc, candidates.term
   limit greatest(1, least(coalesce(max_results, 3), 10));
$$;

-- --------------------------------------------------------------------------
-- 5. Backfill
-- --------------------------------------------------------------------------
-- body_them is null on every existing row until its trigger runs again. Same
-- columns as 001: each must appear in that trigger's UPDATE OF list, and calls
-- has no updated_at, so status stands in.

update public.calls        set status  = status;
update public.sms_messages set content = content;
update public.recordings   set status  = status;

commit;

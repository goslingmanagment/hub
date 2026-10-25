-- agency-hub:rollback-compatible — a new table: the previous image never names it, and its Hi writes as before.
-- 0320_ai_persona_openers.sql
--
-- The first messages a persona's Hi starts from (owner, 2026-10-25): the
-- owner's own openers, each with an id for good, so the hub can count how
-- fans answer each one. Hi on an empty chat draws one per variant, and the
-- generation's record names the ids it drew
-- (params.contextManifest.greetingOpeners); the greeting the chatter sent
-- names its generation (client_greetings), and the fan's answers and money
-- follow from there.
--
-- A text is never edited or deleted: the owner switches one off and adds
-- another, so the counts stay with the words they counted.
--
-- - `audience`: 'any', or 'bare': only a fan with nothing to hook on, a
--   default username and no other name, no bio, no picture;
-- - `local_from_hour` / `local_to_hour` / `local_time_zone`: the hours of the
--   day it may go out in, [from, to) in that IANA zone, across midnight when
--   from > to; all three null: any time.

set local lock_timeout = '5s';

create table ai_persona_openers (
  id bigserial primary key,
  persona_key text not null references ai_personas(key),
  body text not null,
  audience text not null default 'any',
  local_from_hour smallint,
  local_to_hour smallint,
  local_time_zone text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_persona_openers_body_check check (
    length(body) between 1 and 500 and body ~ '\S' and body !~ '[\r\n]'
  ),
  constraint ai_persona_openers_audience_check check (audience in ('any', 'bare')),
  constraint ai_persona_openers_hours_check check (
    (local_from_hour is null and local_to_hour is null and local_time_zone is null)
    or (
      local_from_hour between 0 and 23 and local_to_hour between 0 and 23
      and local_from_hour <> local_to_hour
      and length(local_time_zone) between 1 and 64
    )
  )
);

create index ai_persona_openers_persona_idx on ai_persona_openers (persona_key, id);

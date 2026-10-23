-- agency-hub:rollback-compatible — a new table, a new column with a constant default and a new incident kind; the previous image never names them and its inserts still pass.
-- 0301_publication_checks.sql
--
-- Publications (docs/plans/2026-10-23-wall-posts, plan PR 5a): did it go out.
--
--   publication_checks   every read Hub made to learn a publication's fate on
--                        the platform: 10 minutes after its time ("verify"),
--                        a story OnlyFans still prepares at +1 h and +6 h, and
--                        the search for an "unknown" one (spec §8.2,
--                        "search"). One row per check: what it concluded,
--                        why, the post it found and the evidence (the
--                        owner actions it read through, whose responses are
--                        journaled in observations first). Never updated.
--
--   ofapi_action_intents.origin
--                        "publication_read" marks the reads Hub makes for
--                        publications itself, so they do not bury the
--                        owner's own actions on the OFAPI actions screen.
--
-- A publication Hub proved did not go out pages the owner as its own
-- incident kind, one latch per page; the owner closes it on the screen.

set local lock_timeout = '5s';

alter type notification_incident_kind add value if not exists 'publication_not_published';

alter table ofapi_action_intents
  add column origin text not null default 'owner',
  add constraint ofapi_action_intents_origin_check check (origin in ('owner', 'publication_read'));

create table publication_checks (
  id bigserial primary key,
  publication_id bigint not null references publications(id) on delete restrict,
  page_id bigint not null references pages(id) on delete restrict,
  kind text not null,
  outcome text not null,
  reason text,
  platform_post_ref text,
  evidence jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint publication_checks_kind_check check (kind in ('verify', 'search')),
  constraint publication_checks_outcome_check check (outcome in (
    'published', 'processing', 'scheduled', 'not_published', 'unknown', 'not_found', 'read_failed'
  ))
);

create index publication_checks_publication_idx on publication_checks (publication_id, id);
create index publication_checks_page_idx on publication_checks (page_id, created_at);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'read_only') then
    grant select on publication_checks to read_only;
  end if;
end $$;

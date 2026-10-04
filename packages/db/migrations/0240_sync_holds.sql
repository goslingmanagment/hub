-- 0240_sync_holds.sql
--
-- Fansly Sync Engine, step 4 (plan §15 row 4, owner decision №26 «таблица
-- удержаний»; step 3b 4-1): the hold set. One row per hold of a page, a route
-- or a resource file, instead of the page row's one hold slot
-- (`sync_pages.hold_kind` … `hold_detail`, with a second hold carried inside
-- the detail) and its `resource_holds` JSON (the resource breakers by file and
-- the route-state namespace `route:state`).
--
--   scope 'page', key ''          what stops every request of the page:
--     kind 'auth' | 'identity_mismatch'   the credentials hold (until
--                                         'infinity': only an identity proof
--                                         sent after its latest refusal
--                                         clears it); at most one per page
--     kind 'network'                      the network back-off, until its end;
--                                         it stands beside a credentials hold
--                                         as a row of its own
--   scope 'route', key <route>    a route of the page after a 429
--                                 (`apps/runtime/src/sync/fansly/routes.ts`):
--     kind 'route_hold'                   no send on the route before `until`
--     kind 'route_budget'                 the route's durable state: the
--                                         ladder step of its next 429
--                                         (`ladder_step`), its slowdown and
--                                         newest 429 (`detail`), and the
--                                         revision a raise compares against
--                                         (`revision`); no end
--   scope 'resource', key <file>  kind 'resource_breaker': the file's breaker
--                                 until `until`, on ladder step `ladder_step`
--
-- The engine's one hold evaluator (`engine/admission.ts`) reads these rows and
-- nothing else. Every writer of this release also keeps the old columns in
-- step with them (the previous image reads only those: a rollback must not
-- fail open), and a page's rows are re-read from the old columns whenever its
-- ownership is acquired and the two disagree — which is how the state the
-- previous image left reaches the table (it may write a hold after this
-- migration ran, and after a rollback). So the table starts empty here.
--
-- Page-owned like the other engine tables (RESTRICT on the page; the erasure
-- deletes the rows by page). No telemetry: a row is state, never pruned.
--
-- Purely additive, IF NOT EXISTS; the previous image never names the table.

create table if not exists sync_holds (
  page_id bigint not null references pages(id) on delete restrict,
  scope text not null,
  key text not null default '',
  kind text not null,
  until timestamptz,
  since timestamptz not null default clock_timestamp(),
  ladder_step smallint not null default 0,
  detail jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sync_holds_pkey primary key (page_id, scope, key, kind),
  constraint sync_holds_scope_check check (scope in ('page', 'route', 'resource')),
  constraint sync_holds_kind_check check (
    kind in ('auth', 'identity_mismatch', 'network', 'route_hold', 'route_budget', 'resource_breaker')
  ),
  constraint sync_holds_scope_kind_check check (
    (scope = 'page' and key = '' and kind in ('auth', 'identity_mismatch', 'network'))
    or (scope = 'route' and key <> '' and kind in ('route_hold', 'route_budget'))
    or (scope = 'resource' and key <> '' and kind = 'resource_breaker')
  ),
  constraint sync_holds_until_check check ((kind = 'route_budget') = (until is null)),
  constraint sync_holds_ladder_step_check check (ladder_step >= 0),
  constraint sync_holds_revision_check check (revision >= 1)
);

-- A page holds one credentials hold at a time: a later refusal of another
-- kind replaces the row, it never stands beside it.
create unique index if not exists sync_holds_page_credentials on sync_holds (page_id)
  where scope = 'page' and kind in ('auth', 'identity_mismatch');

comment on table sync_holds is
  'Fansly Sync Engine (plan §9, §11; step 4): the hold set — one row per hold of a page, a route or a resource file. Read by the one hold evaluator (engine/admission.ts).';
comment on column sync_holds.page_id is
  'The page that holds; the erasure deletes the rows by page.';
comment on column sync_holds.scope is
  'What the row stops: page (every request), route (one route of the page), resource (one resource file).';
comment on column sync_holds.key is
  'The route id (scope route), the resource file (scope resource), or the empty string (scope page).';
comment on column sync_holds.kind is
  'auth / identity_mismatch (the credentials hold), network (the back-off), route_hold (a 429''s hold of the route), route_budget (the route''s durable slowdown state), resource_breaker.';
comment on column sync_holds.until is
  'The hold''s end; infinity for a credentials hold; null for route_budget, which is state without an end.';
comment on column sync_holds.since is
  'The start of the episode: kept while the hold is retaken in force.';
comment on column sync_holds.ladder_step is
  'route_budget: the step the route''s next 429 without Retry-After takes; resource_breaker: the step the breaker is on.';
comment on column sync_holds.detail is
  'The hold''s facts: the latest credentials refusal (attempt, instant, digest), the network streak, the route''s effective rate and newest 429.';
comment on column sync_holds.revision is
  'Bumped by every write of the row; a raise of a route (sync route raise) is a compare-and-set on its route_budget revision.';
comment on column sync_holds.created_at is
  'When the row was first written.';
comment on column sync_holds.updated_at is
  'When the row was last written.';

do $$ begin
  if exists(select 1 from pg_roles where rolname='read_only') then
    grant select on sync_holds to read_only;
  end if;
end $$;

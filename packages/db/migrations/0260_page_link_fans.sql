-- 0260_page_link_fans.sql
--
-- OnlyFans traffic sources, "link ↔ fan" (plan 2026-10-08, PR 8, migration C):
-- which fans a tracking or trial link brought, and over which periods their
-- spending counts for the link. A projection of the paid fan sweep's journal
-- (sync_raw_payloads, endpoints link_fans_*, journaled since 2026-10-09 by
-- PR 1): every table here is rebuilt from that journal, nothing else.
--
--   page_link_fan_walks           one read of one list of one link in one
--                                 request revision of the sweep: when it
--                                 started (capture time of its first page),
--                                 whether it was read to the end
--                                 (finished_at), how many pages and items,
--                                 under which OFAPI account. Only a finished
--                                 walk is evidence of anything.
--   page_link_fans                a fan as one link's lists show him, one row
--                                 per (page, link, fan): first and last
--                                 sighting, the last subscriber walk he was in
--                                 and whether he was active there, how many
--                                 finished walks in a row missed him, and what
--                                 the vendor says — the fan ↔ creator
--                                 subscription dates and flag (reference only,
--                                 see below) and, from a tracking link's
--                                 spenders list, the vendor's money for him.
--   page_link_fan_periods         the periods over which the fan's spending
--                                 counts for the link. At most one open per
--                                 (page, link, fan).
--   page_link_fan_journal_cursors per page, the last journal row the
--                                 projection applied. The sweep advances it
--                                 page by page; the rebuild command resets it.
--
-- THE PERIOD RULE (ofapi_subscription_period_equal_split.v1, the coordinator's
-- decision of 2026-10-09 on the production journal). A link's subscriber list
-- is the link's CLAIM HISTORY, not its current subscribers: on lora-vip-of
-- 1 315 of 1 824 listed fans are flagged expired. The vendor's subscription
-- dates on an item (subscribedOnData.subscribeAt / expiredAt) describe the fan
-- ↔ creator relation, not the link: a fan in three links carries the same
-- dates in all three, and on some links every fan "subscribed" before the
-- link existed. So:
--   * a period is open while the fan is in the link's subscriber list AND the
--     vendor flags him active there (subscribedOnExpiredNow = false);
--   * it opens at the sighting that shows him active with no open period: at
--     the one subscription.started webhook of the fan between the link's last
--     finished walk and that sighting, else at the sighting itself; a fan
--     active before the link's first finished walk (its floor) opens a
--     before-floor period (period_start_at null: counted from the floor);
--   * it closes at the start of the first finished walk in which the fan is
--     not active (flagged expired, or no flag), or at the start of the first
--     of two finished walks in a row that miss him (close_reason 'absent');
--     a walk that misses him counts only once the page's lists under that
--     walk's OFAPI account have returned anyone (a new account's cold list
--     is no evidence, П9.10);
--   * an unfinished walk closes nothing; a later sighting as active opens a
--     new period; a fan first seen not active opens none.
--
-- ERASURE. Page erasure deletes all four tables' rows of the page. Every row
-- that names a fan (page_link_fans, and page_link_fan_periods through it)
-- also hangs off the fan's page_fans row of the same page with ON DELETE
-- CASCADE, so ANY erasure that removes the fan from the page removes them —
-- including the page erasure of an image that does not know these tables
-- (after a rollback), and a fan erasure (fans → page_fans → here). What an
-- older image's page erasure would leave are walks and cursors: link ids,
-- counts and an OFAPI account id, no fan. The projection writes a fan only
-- while his page_fans row exists, and applies a journal page only under the
-- erasure fence (the shared lock and tombstone check every projection uses),
-- so an erased page's or fan's material is never written back.
--
-- Rollback-compatible: four new tables the previous image never names. After
-- a rollback the journal keeps being written (PR 1 is in that image) and the
-- cursor stays where it was; the next image's sweep applies the missed pages.
--
-- LOCKING: the foreign keys to pages, fans and page_fans take SHARE ROW
-- EXCLUSIVE on them for the instant of the CREATE (their writers wait behind it);
-- lock_timeout keeps the wait brief — if the locks are not had in 5 s this
-- aborts and the deploy rolls back.

set local lock_timeout = '5s';

create table if not exists page_link_fan_walks (
  id bigserial primary key,
  platform_account_id bigint not null references pages(id) on delete restrict,
  link_kind text not null,
  platform_link_id text not null,
  list_kind text not null,
  request_seq bigint not null,
  ofapi_account_id text,
  started_at timestamptz not null,
  finished_at timestamptz,
  api_pages integer not null default 0,
  items integer not null default 0,
  next_offset integer,
  last_offset integer not null,
  last_page_items integer not null,
  broken_reason text,
  evidential boolean,
  first_raw_payload_id bigint not null,
  last_raw_payload_id bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_link_fan_walks_key_uniq
    unique (platform_account_id, link_kind, platform_link_id, list_kind, request_seq),
  constraint page_link_fan_walks_link_kind_check check (link_kind in ('tracking', 'trial')),
  constraint page_link_fan_walks_link_id_check check (platform_link_id ~ '^[0-9]{1,20}$'),
  constraint page_link_fan_walks_list_kind_check check (
    list_kind = 'subscribers' or (list_kind = 'spenders' and link_kind = 'tracking')
  ),
  constraint page_link_fan_walks_counts_check check (
    api_pages >= 0 and items >= 0 and last_offset >= 0 and last_page_items >= 0
  ),
  constraint page_link_fan_walks_broken_check check (
    broken_reason is null or broken_reason in ('offset_gap', 'pagination_invalid', 'account_changed')
  ),
  -- A walk is finished, broken or still being read — never two of them.
  constraint page_link_fan_walks_state_check check (
    (finished_at is not null and broken_reason is null and next_offset is null and evidential is not null)
    or (finished_at is null and broken_reason is not null and next_offset is null and evidential is null)
    or (finished_at is null and broken_reason is null and next_offset is not null and evidential is null)
  )
);

create table if not exists page_link_fans (
  id bigserial primary key,
  platform_account_id bigint not null references pages(id) on delete restrict,
  link_kind text not null,
  platform_link_id text not null,
  fan_id bigint not null references fans(id) on delete cascade,
  in_subscriber_list boolean not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_seen_walk_id bigint references page_link_fan_walks(id) on delete restrict,
  last_seen_active boolean,
  absent_since timestamptz,
  absent_walks integer not null default 0,
  vendor_subscribed_at timestamptz,
  vendor_expires_at timestamptz,
  vendor_status text,
  vendor_revenue_net_mills bigint,
  vendor_chargebacks_mills bigint,
  vendor_revenue_calculated_at timestamptz,
  vendor_revenue_seen_at timestamptz,
  first_raw_payload_id bigint not null,
  last_raw_payload_id bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_link_fans_key_uniq unique (platform_account_id, link_kind, platform_link_id, fan_id),
  -- The fan on this page: whatever removes him from the page removes this.
  constraint page_link_fans_page_fan_fk foreign key (fan_id, platform_account_id)
    references page_fans (fan_id, platform_account_id) on delete cascade,
  constraint page_link_fans_link_kind_check check (link_kind in ('tracking', 'trial')),
  constraint page_link_fans_link_id_check check (platform_link_id ~ '^[0-9]{1,20}$'),
  constraint page_link_fans_vendor_status_check check (vendor_status is null or vendor_status in ('active', 'expired')),
  constraint page_link_fans_absence_check check (
    absent_walks >= 0 and ((absent_walks = 0) = (absent_since is null))
  ),
  -- Subscriber-list facts exist only on a fan seen in a subscriber list.
  constraint page_link_fans_subscriber_check check (
    in_subscriber_list or (last_seen_walk_id is null and last_seen_active is null and absent_walks = 0)
  )
);

create index if not exists page_link_fans_fan_idx on page_link_fans (fan_id, platform_account_id);

create table if not exists page_link_fan_periods (
  id bigserial primary key,
  platform_account_id bigint not null references pages(id) on delete restrict,
  link_kind text not null,
  platform_link_id text not null,
  fan_id bigint not null references fans(id) on delete cascade,
  link_fan_id bigint not null references page_link_fans(id) on delete cascade,
  period_start_at timestamptz,
  period_start_source text not null,
  opened_at timestamptz not null,
  opened_walk_id bigint not null references page_link_fan_walks(id) on delete restrict,
  closed_at timestamptz,
  close_reason text,
  closed_walk_id bigint references page_link_fan_walks(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_link_fan_periods_link_kind_check check (link_kind in ('tracking', 'trial')),
  constraint page_link_fan_periods_source_check check (
    (period_start_source = 'before_floor' and period_start_at is null)
    or (period_start_source in ('hub_subscription_event', 'first_seen') and period_start_at is not null)
  ),
  constraint page_link_fan_periods_close_check check (
    (closed_at is null and close_reason is null and closed_walk_id is null)
    or (closed_at is not null and close_reason in ('not_active', 'absent') and closed_walk_id is not null)
  )
);

-- One open period per (page, link, fan).
create unique index if not exists page_link_fan_periods_open_uniq
  on page_link_fan_periods (platform_account_id, link_kind, platform_link_id, fan_id)
  where closed_at is null;
-- The money read (PR 13): a fan's periods on a page.
create index if not exists page_link_fan_periods_fan_idx
  on page_link_fan_periods (fan_id, platform_account_id);
create index if not exists page_link_fan_periods_link_fan_idx
  on page_link_fan_periods (link_fan_id);

create table if not exists page_link_fan_journal_cursors (
  platform_account_id bigint primary key references pages(id) on delete restrict,
  last_raw_payload_id bigint not null default 0,
  rule text not null,
  pages_applied bigint not null default 0,
  pages_skipped bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table page_link_fan_walks is
  'OnlyFans link ↔ fan (plan 2026-10-08, PR 8): one read of one list (subscribers; spenders for tracking links) of one link in one request revision of the paid fan sweep. Projection of the sweep journal (sync_raw_payloads link_fans_*); rebuilt by link-fans:reproject.';
comment on column page_link_fan_walks.started_at is
  'Capture time of the walk''s first page.';
comment on column page_link_fan_walks.finished_at is
  'Capture time of the last page of a walk read from offset 0 to the end without a gap; null while it is read, or for good when broken.';
comment on column page_link_fan_walks.next_offset is
  'The offset the next page of the walk must have; null once finished or broken.';
comment on column page_link_fan_walks.broken_reason is
  'offset_gap: a page did not continue the previous one (e.g. erased journal pages); pagination_invalid: the vendor''s next-page link named no usable offset; account_changed: a page came under another OFAPI account than the walk''s first (a rebind mid-walk). A broken walk never finishes and is evidence of nothing.';
comment on column page_link_fan_walks.evidential is
  'Set at finish: true when some subscriber list of the page under this walk''s OFAPI account had returned a fan by then. Only an evidential walk can count a fan absent (П9.10).';
comment on table page_link_fans is
  'OnlyFans link ↔ fan (PR 8): a fan as one link''s lists show him. The periods his spending counts for the link are page_link_fan_periods. Projection of the sweep journal.';
comment on column page_link_fans.in_subscriber_list is
  'false: the fan is known only from the tracking link''s spenders list; he has no periods.';
comment on column page_link_fans.last_seen_active is
  'At the fan''s last subscriber-list sighting: true when the vendor flagged him active (subscribedOnExpiredNow = false), false when flagged expired or not flagged.';
comment on column page_link_fans.absent_since is
  'Start of the first of the finished evidential walks in a row that missed the fan; null while he is in the list.';
comment on column page_link_fans.vendor_subscribed_at is
  'subscribedOnData.subscribeAt: the fan ↔ creator relation, NOT this link (verified 2026-10-09). Reference only.';
comment on column page_link_fans.vendor_expires_at is
  'subscribedOnData.expiredAt: the fan ↔ creator relation, NOT this link. Reference only.';
comment on column page_link_fans.vendor_status is
  'From subscribedOnExpiredNow at the last subscriber sighting: active (false) or expired (true); null when not flagged.';
comment on column page_link_fans.vendor_revenue_net_mills is
  'Spenders list of a tracking link: the vendor''s revenue.total for the fan (net after the OnlyFans fee, refunds and chargebacks).';
comment on table page_link_fan_periods is
  'OnlyFans link ↔ fan (PR 8): the periods over which a fan''s spending counts for a link under ofapi_subscription_period_equal_split.v1 — open while the fan is in the link''s subscriber list and flagged active; see migration 0260 for the rule.';
comment on column page_link_fan_periods.period_start_at is
  'null = before the link''s floor (its first finished evidential subscriber walk): counted from the floor.';
comment on column page_link_fan_periods.period_start_source is
  'before_floor; hub_subscription_event: the one subscription.started webhook of the fan between the link''s last finished walk and the sighting; first_seen: the sighting that opened the period.';
comment on column page_link_fan_periods.closed_at is
  'End of the period (exclusive): start of the finished walk that showed the fan not active (not_active) or of the first of two finished walks in a row that missed him (absent).';
comment on table page_link_fan_journal_cursors is
  'OnlyFans link ↔ fan (PR 8): per page, the last sync_raw_payloads id the projection applied, and the rule it applied it under.';

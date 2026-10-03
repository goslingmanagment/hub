-- step3-accept.sql v2: the live-hour acceptance of switched Fansly pages (step 3b ruling 13, A1 §2b, A6; owner
-- decisions №18, №21–№26). psql, READ ONLY:
--   impl/workflows/prodsqlf.sh step3-accept.sql "<since>"            (production; set the pages below)
--   psql -X -v ON_ERROR_STOP=1 -v pages=ari-1,lilly-2 -v since="'2026-10-03T10:00:00Z'" [-v until="'…'"] -f step3-accept.sql
-- Pages checked together share one window end: page i is judged over [T_i, T* + 1 h), T_i = the later of :since and
-- the instant it became live (sync_pages.mode_changed_at), T* = max(T_i); -v until replaces the end. Before T* + 1 h
-- every page reads `inconclusive` (window_complete); a fail shows at once.
-- The same rules as `pnpm cli sync switch check` (apps/runtime/src/sync/switch/acceptance-rules.ts): the numbers, the
-- route table and the legacy operation map below are pinned to the code by tests/sync-switch-acceptance-sql.test.ts,
-- and the shared fixtures of tests/sync-switch-acceptance.integration.test.ts run this script and the CLI side by side.
-- Per page: fail > inconclusive > owner_review (429s on two or more routes) > accepted_with_route_429 > pass.
-- The last line is the verdict as JSON.
\if :{?pages}
\else
\set pages lilly-1
\endif
\if :{?since}
\else
\echo 'step3-accept.sql: pass -v since="''<timestamptz>''" (prodsqlf.sh does)'
\quit
\endif
\if :{?until}
\else
\set until null
\endif

-- The acceptance's numbers (= ACCEPTANCE_RULES / ACCEPTANCE_LATENCY_SLOS).
\set window_ms 3600000
\set min_samples 10
\set media_start_ms 60000
\set budget_w1_ms 60000
\set budget_w2_ms 300000
\set budget_slack 1
\set first_hold_ms 5000
\set slowdown_factor 0.5
\set slowdown_floor_share 0.125
\set network_failures_to_hold 3
\set alert_clean_ms 600000
\set lookback_ms 3600000
\set send_window_ms 15000
\set mismatch_share 0.001
\set unconfirmed_after_ms 900000
\set slo_visible_s 5
\set slo_confirm_s 30
\set slo_confirm_fast_s 10
\set slo_find_s 12
\set slo_money_head_s 12
\set slo_deletions_s 5
\set slo_repair_s 60

-- The route policy (= apps/runtime/src/sync/fansly/routes.ts): every canonical route (wire = the engine sends it under
-- this id), its family and its budget (requests a minute).
select json_agg(json_build_object('route', route, 'wire', wire, 'family', family, 'ceiling', ceiling, 'current', current)
                order by route) as routes
  from (values
    ('account.me', true, null, 15, 15),
    ('accounts.by_ids', true, null, 15, 15),
    ('messaging.groups', true, 'messaging', 12, 12),
    ('group.detail', true, 'messaging', 15, 15),
    ('messages.page', true, 'messaging', 15, 15),
    ('transactions.page', true, 'earnings', 15, 15),
    ('earnings.accounts', true, 'earnings', 15, 15),
    ('earnings.stats_accounts', true, 'earnings', 15, 15),
    ('earnings.monthly_accounts', true, 'earnings', 15, 15),
    ('media.order_history', true, null, 15, 15),
    ('payouts.methods', true, null, 15, 15),
    ('payouts.requests', true, null, 15, 15),
    ('subscribers.page', true, null, 15, 15),
    ('followers.page', true, null, 15, 15),
    ('notifications.page', true, null, 15, 15),
    ('posts.timeline', true, null, 15, 15),
    ('posts.tips', true, null, 15, 15),
    ('posts.by_ids', true, null, 15, 15),
    ('post.replies', true, null, 15, 15),
    ('vault.albums', true, null, 15, 15),
    ('uservault.albums', true, null, 15, 15),
    ('subscriptions.tiers', true, null, 15, 15),
    ('subscriptions.giftcodes', true, null, 15, 15),
    ('message.automated', true, null, 15, 15),
    ('account.walls', true, null, 15, 15),
    ('vault.media', true, null, 15, 15),
    ('account.media_by_ids', true, null, 15, 15),
    ('account.bundles_by_ids', true, null, 15, 15),
    ('media.offer_stats', true, null, 12, 5),
    ('account.stats', true, null, 15, 15),
    ('earnings.stats_window', true, 'earnings', 15, 15),
    ('earnings.monthly', true, 'earnings', 15, 15),
    ('trackinglinks', true, null, 15, 15),
    ('discovery.suggestions', true, null, 15, 15),
    ('broadcast.stats', true, null, 15, 15),
    ('broadcast.stats_deleted', true, null, 15, 15),
    ('broadcast.scheduled', true, null, 15, 15),
    ('polls', true, null, 15, 15),
    ('recapstats', true, null, 15, 15),
    ('ws.upgrade', true, null, 15, 15),
    ('cdn.media', true, null, 15, 15),
    ('earnings.overview', false, 'earnings', 15, 15),
    ('lists.account', false, null, 15, 15),
    ('lists.items', false, null, 15, 15),
    ('groups.mediaoffers', false, null, 15, 15),
    ('account.media_orders', false, null, 15, 15),
    ('tips.account', false, null, 15, 15),
    ('mediastory.views', false, null, 15, 15)
  ) as t(route, wire, family, ceiling, current) \gset
select json_agg(json_build_object('family', family, 'ceiling', ceiling, 'current', current) order by family) as families
  from (values
    ('messaging', 15, 15),
    ('earnings', 17, 17)
  ) as t(family, ceiling, current) \gset
-- fansly_send_log.operation → route (= FANSLY_LEGACY_OPERATION_ROUTES).
select json_agg(json_build_object('operation', operation, 'route', route) order by operation) as legacy_routes
  from (values
    ('account_me', 'account.me'),
    ('account_lookup', 'accounts.by_ids'),
    ('messaging_groups', 'messaging.groups'),
    ('group_detail', 'group.detail'),
    ('messages', 'messages.page'),
    ('earnings_overview', 'earnings.overview'),
    ('earnings_transactions', 'transactions.page'),
    ('earnings_accounts', 'earnings.accounts'),
    ('earnings_stats_accounts', 'earnings.stats_accounts'),
    ('earnings_monthlystats_accounts', 'earnings.monthly_accounts'),
    ('earnings_stats_window', 'earnings.stats_window'),
    ('earnings_monthly_stats', 'earnings.monthly'),
    ('media_orderhistory', 'media.order_history'),
    ('payout_methods', 'payouts.methods'),
    ('payout_requests', 'payouts.requests'),
    ('subscribers', 'subscribers.page'),
    ('followers', 'followers.page'),
    ('notifications_page', 'notifications.page'),
    ('lists_account', 'lists.account'),
    ('list_items', 'lists.items'),
    ('timeline_posts', 'posts.timeline'),
    ('post_tips', 'posts.tips'),
    ('post_lookup', 'posts.by_ids'),
    ('post_replies', 'post.replies'),
    ('vault_albums', 'vault.albums'),
    ('uservault_albums', 'uservault.albums'),
    ('subscription_tiers', 'subscriptions.tiers'),
    ('gift_codes', 'subscriptions.giftcodes'),
    ('automated_messages', 'message.automated'),
    ('account_walls_probe', 'account.walls'),
    ('vault_media', 'vault.media'),
    ('account_media_by_ids_probe', 'account.media_by_ids'),
    ('account_media_bundles_by_ids_probe', 'account.bundles_by_ids'),
    ('media_offer_stats', 'media.offer_stats'),
    ('account_stats', 'account.stats'),
    ('tracking_links', 'trackinglinks'),
    ('discovery_media_suggestions', 'discovery.suggestions'),
    ('broadcast_stats_probe', 'broadcast.stats'),
    ('broadcast_stats_deleted_probe', 'broadcast.stats_deleted'),
    ('broadcast_scheduled_probe', 'broadcast.scheduled'),
    ('polls_probe', 'polls'),
    ('recapstats_probe', 'recapstats'),
    ('group_mediaoffers_probe', 'groups.mediaoffers'),
    ('account_media_orders_probe', 'account.media_orders'),
    ('tips_account_probe', 'tips.account'),
    ('mediastory_views_probe', 'mediastory.views'),
    ('media_download', 'cdn.media'),
    ('ws_connect', 'ws.upgrade'),
    ('ws_probe', 'ws.upgrade')
  ) as t(operation, route) \gset

\echo '== 1. windows: T_i = the later of :since and the live instant; judged over [T_i, T* + 1 h); the engine state'
with n as materialized (select clock_timestamp() as now),
req as (select distinct btrim(x) as label from unnest(string_to_array(:'pages', ',')) as x where btrim(x) <> ''),
pg as (
  select r.label, p.id as page_id, sp.mode, sp.mode_changed_at,
         case when sp.mode = 'live' then greatest(:since::timestamptz, sp.mode_changed_at) else :since::timestamptz end as t_i
    from req r
    left join pages p on p.label = r.label
    left join sync_pages sp on sp.page_id = p.id
),
e as (select coalesce(:until::timestamptz, max(t_i) + :window_ms * interval '1 millisecond') as t_end from pg where mode is not null)
select coalesce(bool_and(pg.mode is not null), false) and count(*) > 0 as pages_known,
       coalesce(string_agg(pg.label, ',') filter (where pg.mode is null), '') as unknown_pages,
       coalesce(json_agg(json_build_object(
         'page_id', pg.page_id, 'page', pg.label, 'mode', pg.mode, 'mode_changed_at', pg.mode_changed_at, 't_i', pg.t_i,
         't_end', e.t_end, 'o_end', least(e.t_end, n.now), 'now', n.now, 'complete', n.now >= e.t_end) order by pg.label)
         filter (where pg.mode is not null), '[]') as windows
  from pg cross join e cross join n \gset
\if :pages_known
\else
\echo 'step3-accept.sql: no Fansly sync page labelled' :'unknown_pages' 'in' :'pages'
\quit
\endif
select page, mode, mode_changed_at as live_since, t_i, t_end, o_end as observed_until, complete
  from json_to_recordset(:'windows') as w(page text, mode text, mode_changed_at timestamptz, t_i timestamptz,
                                          t_end timestamptz, o_end timestamptz, complete boolean)
 order by page;
-- The engine state as it stands (shown, not judged: the checks below judge it).
with w as (select * from json_to_recordset(:'windows') as w(page_id bigint, page text))
select w.page, sp.owner_generation, sp.owner_host,
       round(extract(epoch from clock_timestamp() - sp.owner_heartbeat_at)) as owner_hb_age_s,
       sp.legacy_imported_at, sp.requests_enabled_at, sp.hold_kind, sp.hold_since, sp.hold_until, sp.resource_holds,
       sp.credentials_generation is not null as credentials_verified,
       sp.identity_account_id = p.external_page_id as identity_ok,
       g.owner_engine, g.engine_switched_at, g.last_completed_at as legacy_last_completed
  from w join pages p on p.id = w.page_id join sync_pages sp on sp.page_id = w.page_id
  left join fansly_page_send_guards g on g.page_id = w.page_id
 order by w.page;

\echo '== 2. engine state, the window, pace over both journals (0 pairs closer than S), the handover boundary (>= 1.2 x S)'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, mode text, mode_changed_at timestamptz,
                                                   t_i timestamptz, t_end timestamptz, o_end timestamptz, now timestamptz,
                                                   complete boolean)
),
ps as (
  select w.page_id, s.journal, s.ref, s.sent_at, s.setting_ms
    from w cross join lateral (
      select 'engine'::text as journal, a.id::text as ref, a.sent_at, a.setting_ms
        from sync_attempts a
       where a.page_id = w.page_id and not a.shadow and a.sent_at is not null
         and a.sent_at >= w.t_i - interval '10 minutes' and a.sent_at < w.o_end
      union all
      select 'legacy:' || l.source, l.id::text, l.sent_at, l.setting_ms
        from fansly_send_log l
       where l.page_id = w.page_id and l.sent_at is not null
         and l.sent_at >= w.t_i - interval '10 minutes' and l.sent_at < w.o_end) as s
),
po as (
  select ps.*, lag(ps.journal) over x as prev_journal,
         extract(epoch from ps.sent_at - lag(ps.sent_at) over x) * 1000 as gap_ms
    from ps window x as (partition by ps.page_id order by ps.sent_at, ps.journal, ps.ref)
),
pace as (
  select w.page_id, count(po.gap_ms) as pairs, count(*) filter (where po.gap_ms < po.setting_ms) as violations,
         round(min(po.gap_ms)) as min_gap_ms,
         round(min(po.gap_ms) filter (where po.journal <> po.prev_journal)) as min_cross_journal_gap_ms
    from w left join po on po.page_id = w.page_id and po.sent_at >= w.t_i
   group by w.page_id
),
bnd as (
  select w.page_id, g.owner_engine, g.engine_switched_at, g.last_completed_at,
         (select count(*) from fansly_send_log l where l.page_id = w.page_id and l.captured_at > g.engine_switched_at) as legacy_after,
         fe.first_sent, round(fe.setting_ms * 1.2) as required_ms,
         extract(epoch from fe.first_sent - g.last_completed_at) * 1000 as gap_ms
    from w
    left join fansly_page_send_guards g on g.page_id = w.page_id
    left join lateral (
      select min(a.sent_at) as first_sent, max(a.setting_ms) as setting_ms
        from sync_attempts a
       where a.page_id = w.page_id and not a.shadow and a.sent_at > g.engine_switched_at) as fe on true
),
checks as (
  select w.page_id, w.page, 1 as ord, 'live' as name, case when w.mode = 'live' then 'pass' else 'fail' end as verdict,
         json_build_object('mode', w.mode, 'liveSince', w.mode_changed_at) as detail
    from w
  union all
  select w.page_id, w.page, 2, 'window_complete', case when w.complete then 'pass' else 'inconclusive' end,
         json_build_object('windowStart', w.t_i, 'windowEnd', w.t_end, 'observedUntil', w.o_end)
    from w
  union all
  select w.page_id, w.page, 3, 'pace_combined', case when p.violations = 0 then 'pass' else 'fail' end,
         json_build_object('pairs', p.pairs, 'violations', p.violations, 'minGapMs', p.min_gap_ms,
                           'minCrossJournalGapMs', p.min_cross_journal_gap_ms)
    from w join pace p on p.page_id = w.page_id
  union all
  select w.page_id, w.page, 4, 'handover_boundary',
         case when b.owner_engine is distinct from 'fansly_sync_engine' or b.legacy_after > 0 then 'fail'
              when b.gap_ms is null or b.required_ms is null then 'inconclusive'
              when b.gap_ms >= b.required_ms then 'pass' else 'fail' end,
         json_build_object('ownerEngine', b.owner_engine, 'engineSwitchedAt', b.engine_switched_at,
                           'legacyLastCompleted', b.last_completed_at, 'legacyCapturesAfterFlip', coalesce(b.legacy_after, 0),
                           'engineFirstSent', b.first_sent, 'boundaryGapMs', round(b.gap_ms), 'requiredMs', b.required_ms)
    from w join bnd b on b.page_id = w.page_id
)
select coalesce(json_agg(json_build_object('page_id', page_id, 'page', page, 'ord', ord, 'check', name, 'verdict', verdict,
                                           'detail', detail) order by page, ord), '[]') as c_state
  from checks \gset
select page, "check", verdict, detail
  from json_to_recordset(:'c_state') as x(page text, ord int, "check" text, verdict text, detail json) order by page, ord;

\echo '== 3. per page and canonical route: budgets (each send: <= ceil(W/T) + 1 within 60 s and 300 s, halved after a 429),'
\echo '      429s (<= 1 per page+route, hold kept, recovery seen), 401/403 (none), page holds (none: the journal, the page row,'
\echo '      alert 1 page_stopped seen in the window), first media request (<= 60 s)'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, mode text, mode_changed_at timestamptz,
                                                   t_i timestamptz, t_end timestamptz, o_end timestamptz, now timestamptz,
                                                   complete boolean)
),
rt as (select * from json_to_recordset(:'routes') as r(route text, wire boolean, family text, ceiling numeric, current numeric)),
fm as (select * from json_to_recordset(:'families') as f(family text, ceiling numeric, current numeric)),
lm as (select * from json_to_recordset(:'legacy_routes') as m(operation text, route text)),
-- Both live journals of each page from T_i - 1 h up to now. `at`: the send instant, its upper bound when never recorded,
-- null when it never went out; `done_at`: when its outcome was known. Both to the millisecond, as the CLI reads them.
j as (
  select w.page_id, 'engine'::text as journal, a.id as ref, a.operation, a.resource,
         coalesce(rt.route, 'unknown:engine:' || a.operation) as route,
         date_trunc('milliseconds', case when a.sent_at is not null or a.outcome in ('admitted', 'sent', 'unknown')
              then coalesce(a.sent_at, a.admitted_at + :send_window_ms * interval '1 millisecond') end) as at,
         date_trunc('milliseconds', coalesce(a.completed_at, a.sent_at, a.admitted_at)) as done_at,
         a.outcome, a.http_status::int as http_status, a.retry_after_ms, a.error_class
    from w
    join sync_attempts a on a.page_id = w.page_id and not a.shadow
                        and a.admitted_at >= w.t_i - :lookback_ms * interval '1 millisecond'
    left join rt on rt.route = a.operation and rt.wire
  union all
  select w.page_id, 'legacy', l.id, l.operation, null, coalesce(lm.route, 'unknown:legacy:' || l.operation),
         date_trunc('milliseconds', case when l.sent_at is not null or l.outcome is distinct from 'aborted_before_send'
              then coalesce(l.sent_at, l.completed_at, l.lease_until, l.captured_at + :send_window_ms * interval '1 millisecond') end),
         date_trunc('milliseconds', coalesce(l.completed_at, l.sent_at, l.captured_at)),
         l.outcome, l.http_status, null::int, null::text
    from w
    join fansly_send_log l on l.page_id = w.page_id and l.captured_at >= w.t_i - :lookback_ms * interval '1 millisecond'
    left join lm on lm.operation = l.operation
),
-- Every 429 of the window, numbered per page+route.
r429 as (
  select j.page_id, j.route, j.journal, j.ref, j.resource, j.done_at, j.retry_after_ms,
         row_number() over (partition by j.page_id, j.route order by j.done_at, j.journal, j.ref) as k
    from j join w on w.page_id = j.page_id
   where j.http_status = 429 and j.done_at >= w.t_i and j.done_at < w.o_end
),
-- Every send on a budgeted route from T_i on (the budget's own admissions: what was sent before T_i was paced by another
-- policy), with the number of its route's window 429s before it.
bs as (
  select j.page_id, j.journal, j.ref, j.route, j.at, rt.family, rt.ceiling, rt.current,
         coalesce((select max(r.k) from r429 r where r.page_id = j.page_id and r.route = j.route and r.done_at < j.at), 0) as k
    from j join rt on rt.route = j.route join w on w.page_id = j.page_id
   where j.at >= w.t_i
),
bc as (
  select bs.*,
         count(*) over (partition by bs.page_id, bs.route order by bs.at
                        range between (:budget_w1_ms * interval '1 millisecond' - interval '1 microsecond') preceding and current row) as route_1,
         count(*) over (partition by bs.page_id, bs.route order by bs.at
                        range between (:budget_w2_ms * interval '1 millisecond' - interval '1 microsecond') preceding and current row) as route_2,
         count(*) over (partition by bs.page_id, bs.family order by bs.at
                        range between (:budget_w1_ms * interval '1 millisecond' - interval '1 microsecond') preceding and current row) as family_1,
         count(*) over (partition by bs.page_id, bs.family order by bs.at
                        range between (:budget_w2_ms * interval '1 millisecond' - interval '1 microsecond') preceding and current row) as family_2,
         count(*) over (partition by bs.page_id, bs.route, bs.k order by bs.at
                        range between (:budget_w1_ms * interval '1 millisecond' - interval '1 microsecond') preceding and current row) as slow_1,
         count(*) over (partition by bs.page_id, bs.route, bs.k order by bs.at
                        range between (:budget_w2_ms * interval '1 millisecond' - interval '1 microsecond') preceding and current row) as slow_2
    from bs
),
bv as (
  select bc.page_id, bc.journal, bc.ref, bc.at, v.kind, v.scope, v.window_ms, v.sends,
         ceil(v.window_ms / ceil(60000 / v.per_min)) + :budget_slack as bound
    from bc
    join w on w.page_id = bc.page_id
    left join fm on fm.family = bc.family
    cross join lateral (values
      ('route', bc.route, :budget_w1_ms, bc.route_1, bc.current),
      ('route', bc.route, :budget_w2_ms, bc.route_2, bc.current),
      ('family', bc.family, :budget_w1_ms, bc.family_1, fm.current),
      ('family', bc.family, :budget_w2_ms, bc.family_2, fm.current),
      ('slowdown', bc.route, :budget_w1_ms, bc.slow_1,
         greatest(bc.current * power(:slowdown_factor, bc.k), bc.ceiling * :slowdown_floor_share)),
      ('slowdown', bc.route, :budget_w2_ms, bc.slow_2,
         greatest(bc.current * power(:slowdown_factor, bc.k), bc.ceiling * :slowdown_floor_share))
    ) as v(kind, scope, window_ms, sends, per_min)
   where bc.at >= w.t_i and bc.at < w.o_end
     and (v.kind <> 'family' or bc.family is not null)
     and (v.kind <> 'slowdown' or bc.k > 0)
),
budget_violations as (select * from bv where sends > bound),
-- A 429's hold is kept when no send on its route falls inside (429, 429 + Retry-After or 5 s); a later answer below 400
-- on the route (read up to now) proves its recovery.
pairs as (
  select r.page_id, r.route, count(*) as n, max(r.done_at) as last_at,
         bool_or(exists (select 1 from j j2 where j2.page_id = r.page_id and j2.route = r.route and j2.at > r.done_at
                           and j2.at < r.done_at + coalesce(r.retry_after_ms, :first_hold_ms) * interval '1 millisecond')) as broken,
         json_agg(json_build_object('journal', r.journal, 'ref', r.ref, 'resource', r.resource, 'at', r.done_at,
                                    'retryAfterMs', r.retry_after_ms) order by r.k) as attempts
    from r429 r
   group by r.page_id, r.route
),
pair_state as (
  select p.*,
         case when p.n >= 2 then 'repeated'
              when p.broken then 'hold_broken'
              when exists (select 1 from j j2 where j2.page_id = p.page_id and j2.route = p.route and j2.at > p.last_at
                             and j2.http_status between 100 and 399) then 'recovered'
              else 'unproven' end as state
    from pairs p
),
auth as (
  select j.page_id, j.http_status, j.route, j.resource, count(*) as n
    from j join w on w.page_id = j.page_id
   where j.http_status in (401, 403) and j.done_at >= w.t_i and j.done_at < w.o_end
   group by 1, 2, 3, 4
),
-- The network streak of engine/errors.ts onOutcome: every answer but a network failure ends it; a request never sent
-- leaves it.
seq as (
  select j.page_id, j.ref, j.done_at, j.error_class,
         count(*) filter (where j.error_class is distinct from 'network')
           over (partition by j.page_id order by j.done_at, j.ref rows between unbounded preceding and current row) as grp
    from j
   where j.journal = 'engine' and j.outcome in ('response', 'transport_error', 'timeout')
     and j.error_class is distinct from 'not_sent'
),
streak as (
  select s.*, count(*) filter (where s.error_class = 'network')
                over (partition by s.page_id, s.grp order by s.done_at, s.ref rows between unbounded preceding and current row) as pos
    from seq s
),
-- Alert 1 (the page stopped): the latch row's newest episode and the earlier ones the paging sweep recorded. An open
-- latch was last seen at last_seen_at; a resolved one :alert_clean_ms before its resolve (an earlier, never-settled one:
-- at its opening), never before it opened. An episode seen within the window is a page hold — a 429 that held the page
-- after its hold was cleared included; one that ended before T_i is not the window's.
stops as (
  select w.page_id, e.opened_at, e.seen_until, e.resolved_at, e.detail
    from w cross join lateral (
      select date_trunc('milliseconds', n.opened_at) as opened_at, date_trunc('milliseconds', n.resolved_at) as resolved_at,
             n.error_code as detail,
             date_trunc('milliseconds', case when n.resolved_at is null then n.last_seen_at
                                             else greatest(n.opened_at, n.resolved_at - :alert_clean_ms * interval '1 millisecond') end)
               as seen_until
        from notification_incidents n
       where n.incident_key = 'fansly_sync_engine:' || w.page_id || ':page_stopped'
      union all
      select date_trunc('milliseconds', c.opened_at), date_trunc('milliseconds', c.resolved_at), null,
             date_trunc('milliseconds', greatest(c.opened_at,
                                                 coalesce(c.resolved_at - :alert_clean_ms * interval '1 millisecond', c.opened_at)))
        from notification_incident_cycles c
       where c.incident_key = 'fansly_sync_engine:' || w.page_id || ':page_stopped'
         and not exists (select 1 from notification_incidents n
                          where n.incident_key = c.incident_key and n.opened_at = c.opened_at)) as e
   where e.opened_at < w.o_end and e.seen_until >= w.t_i
),
holds as (
  select w.page_id,
         (select count(*) from j where j.page_id = w.page_id and j.journal = 'engine'
             and j.error_class in ('auth', 'identity_mismatch') and j.done_at >= w.t_i and j.done_at < w.o_end) as credentials,
         (select count(*) from streak s where s.page_id = w.page_id and s.error_class = 'network'
             and s.pos >= :network_failures_to_hold and s.done_at >= w.t_i and s.done_at < w.o_end) as network,
         (select coalesce(json_agg(json_build_object('openedAt', s.opened_at, 'seenUntil', s.seen_until,
                                                     'resolvedAt', s.resolved_at, 'detail', s.detail) order by s.opened_at), '[]')
            from stops s where s.page_id = w.page_id) as stopped,
         sp.hold_kind, sp.hold_since, sp.hold_until,
         coalesce(sp.hold_kind is not null and sp.hold_until > w.t_i and coalesce(sp.hold_since, '-infinity') < w.o_end,
                  false) as current_hold,
         sp.paused_all or 'media-stats.walk' = any(sp.paused_resources) as media_paused,
         (select min(j.at) from j where j.page_id = w.page_id and j.journal = 'engine' and j.route = 'media.offer_stats'
             and j.at >= w.t_i and j.at < w.o_end) as media_first
    from w join sync_pages sp on sp.page_id = w.page_id
),
checks as (
  select w.page_id, w.page, 5 as ord, 'route_budgets' as name,
         case when (select count(*) from budget_violations v where v.page_id = w.page_id) = 0 then 'pass' else 'fail' end as verdict,
         json_build_object(
           'violations', (select count(*) from budget_violations v where v.page_id = w.page_id),
           'first', coalesce((select json_agg(x) from (
                      select v.kind, v.scope, v.window_ms as "windowMs", v.sends, v.bound, v.at, v.journal, v.ref
                        from budget_violations v where v.page_id = w.page_id
                       order by v.at, v.journal, v.ref, v.kind, v.window_ms limit 5) x), '[]')) as detail
    from w
  union all
  select w.page_id, w.page, 6, 'route_429',
         case when bool_or(ps.state in ('repeated', 'hold_broken')) then 'fail'
              when bool_or(ps.state = 'unproven') then 'inconclusive' else 'pass' end,
         json_build_object('routesWith429', count(ps.route),
                           'routes', coalesce(json_agg(json_build_object('route', ps.route, 'count', ps.n, 'state', ps.state,
                                                                         'attempts', ps.attempts) order by ps.route)
                                              filter (where ps.route is not null), '[]'))
    from w left join pair_state ps on ps.page_id = w.page_id
   group by w.page_id, w.page
  union all
  select w.page_id, w.page, 7, 'auth_refusals', case when coalesce(sum(a.n), 0) = 0 then 'pass' else 'fail' end,
         json_build_object('refusals', coalesce(sum(a.n), 0),
                           'byRoute', coalesce(json_agg(json_build_object('httpStatus', a.http_status, 'route', a.route,
                                                                          'resource', a.resource, 'count', a.n)
                                                        order by a.http_status, a.route, a.resource)
                                               filter (where a.page_id is not null), '[]'))
    from w left join auth a on a.page_id = w.page_id
   group by w.page_id, w.page
  union all
  select w.page_id, w.page, 8, 'page_hold',
         case when h.credentials > 0 or h.network > 0 or h.current_hold or json_array_length(h.stopped) > 0 then 'fail'
              else 'pass' end,
         json_build_object('credentialsAnswers', h.credentials, 'networkHolds', h.network,
                           'current', case when h.current_hold
                                           then json_build_object('kind', h.hold_kind, 'since', h.hold_since, 'until', h.hold_until) end,
                           'stopped', h.stopped)
    from w join holds h on h.page_id = w.page_id
  union all
  select w.page_id, w.page, 9, 'media_start',
         case when h.media_first is not null and h.media_first <= w.t_i + :media_start_ms * interval '1 millisecond' then 'pass'
              when h.media_paused then 'fail' else 'inconclusive' end,
         json_build_object('firstRequestAfterSeconds', round(extract(epoch from h.media_first - w.t_i), 1),
                           'paused', h.media_paused, 'boundSeconds', :media_start_ms / 1000)
    from w join holds h on h.page_id = w.page_id
)
select coalesce(json_agg(json_build_object('page_id', page_id, 'page', page, 'ord', ord, 'check', name, 'verdict', verdict,
                                           'detail', detail) order by page, ord), '[]') as c_journal
  from checks \gset
select page, "check", verdict, detail
  from json_to_recordset(:'c_journal') as x(page text, ord int, "check" text, verdict text, detail json) order by page, ord;

\echo '== 4. nothing stuck, nothing lost (all 0; urgent work a subject breaker or the vendor holds is not stuck)'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, mode text, mode_changed_at timestamptz,
                                                   t_i timestamptz, t_end timestamptz, o_end timestamptz, now timestamptz,
                                                   complete boolean)
),
s as (
  select w.page_id, w.page, json_build_object(
    'attemptUnfinished', (select count(*) from sync_attempts a where a.page_id = w.page_id and not a.shadow
                            and a.outcome in ('admitted', 'sent') and a.admitted_at < w.now - interval '2 minutes'),
    'applyPending', (select count(*) from sync_attempts a where a.page_id = w.page_id and not a.shadow
                       and a.apply_state in ('captured', 'deferred') and a.admitted_at < w.now - interval '5 minutes'),
    'attemptQuarantined', (select count(*) from sync_attempts a where a.page_id = w.page_id and not a.shadow
                             and a.apply_state = 'quarantined' and a.admitted_at >= w.t_i),
    'workQuarantined', (select count(*) from sync_work k where k.page_id = w.page_id and not k.shadow
                          and k.state = 'quarantined'),
    'receiptsPending', (select count(*) from fansly_ws_decode_receipts r where r.page_id = w.page_id
                          and r.live_state = 'pending' and r.received_at < w.now - interval '1 minute'),
    'urgentWaiting', (select count(*) from sync_work k where k.page_id = w.page_id and not k.shadow and k.class = 'urgent'
                        and k.state = 'open' and k.first_demand_at < w.now - interval '2 minutes'
                        and (k.breaker_until is null or k.breaker_until <= w.now) and k.blocked_by_vendor_at is null),
    'fanThreadsBehind', (select count(*) from page_dm_threads t where t.platform_account_id = w.page_id
                           and t.fan_id is not null and not (t.metadata ? 'messageSyncExcludedReason')
                           and t.last_message_sender_role is distinct from 'model'
                           and t.last_message_at >= w.t_i and t.last_message_at < w.now - interval '5 minutes'
                           and case when t.last_message_id ~ '^[0-9]+$'
                                    then case when coalesce(t.head_confirmed_id, '') ~ '^[0-9]+$'
                                              then t.head_confirmed_id::numeric < t.last_message_id::numeric else true end
                                    else false end
                           and not exists (select 1 from sync_work k where k.page_id = w.page_id and not k.shadow
                                             and k.subject = t.platform_conversation_id
                                             and k.resource in ('dm-messages.head', 'dm-messages.catchup')
                                             and k.state in ('open', 'running')))
  ) as detail
    from w
)
select coalesce(json_agg(json_build_object('page_id', s.page_id, 'page', s.page, 'ord', 10, 'check', 'nothing_stuck',
         'verdict', case when (select bool_and(value::text = '0') from json_each(s.detail)) then 'pass' else 'fail' end,
         'detail', s.detail) order by s.page), '[]') as c_stuck
  from s \gset
select page, "check", verdict, detail
  from json_to_recordset(:'c_stuck') as x(page text, ord int, "check" text, verdict text, detail json) order by page;

\echo '== 5. SLOs over the whole window (route holds included; the unfinished tail counted at its age):'
\echo '      p95 visible <= 5 s, confirm <= 30 s, fast <= 10 s, find <= 12 s, money head <= 12 s (fewer than 10: count + max,'
\echo '      inconclusive); max deletions <= 5 s, repair <= 60 s; mismatches <= 0.1 %; 0 fan messages unconfirmed > 15 min'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, mode text, mode_changed_at timestamptz,
                                                   t_i timestamptz, t_end timestamptz, o_end timestamptz, now timestamptz,
                                                   complete boolean)
),
m as (
  select w.page_id,
         extract(epoch from m.first_visible_at - m.created_at) as visible_s,
         case when m.confirm_outcome in ('match', 'mismatch') then extract(epoch from m.confirmed_at - m.first_visible_at)
              when m.confirmed_at is null and m.deleted_at is null and not ex.excluded
                then extract(epoch from w.now - m.first_visible_at) end as confirm_s,
         m.attachments <> '[]'::jsonb as fast,
         coalesce(m.confirm_outcome in ('match', 'mismatch'), false) as confirmed,
         coalesce(m.confirm_outcome = 'mismatch', false) as mismatch,
         (m.confirmed_at is null and m.deleted_at is null and not ex.excluded
            and m.first_visible_at < w.now - :unconfirmed_after_ms * interval '1 millisecond') as over15
    from w
    join dm_live_messages m on m.page_id = w.page_id and m.first_visible_at >= w.t_i and m.first_visible_at < w.o_end
                           and m.sender_platform_user_id is not null and m.is_sent_by_page is false
    cross join lateral (
      select exists (select 1 from page_dm_threads t
                      where t.platform_account_id = m.page_id and t.platform_conversation_id = m.platform_conversation_id
                        and t.metadata ? 'messageSyncExcludedReason') as excluded) as ex
),
wk as (
  select w.page_id, k.resource, extract(epoch from coalesce(k.closed_at, w.now) - k.first_demand_at) as latency_s
    from w
    join sync_work k on k.page_id = w.page_id and not k.shadow and k.first_demand_at >= w.t_i and k.first_demand_at < w.o_end
                    and k.resource in ('dm-conversations.find', 'transactions.head', 'dm-live.deletions', 'repair.ws-gap')
),
samples as (
  select page_id, 'slo_visible' as name, visible_s as s from m where visible_s is not null
  union all select page_id, 'slo_confirm', confirm_s from m where confirm_s is not null
  union all select page_id, 'slo_confirm_fast', confirm_s from m where confirm_s is not null and fast
  union all select page_id, 'slo_find', latency_s from wk where resource = 'dm-conversations.find'
  union all select page_id, 'slo_money_head', latency_s from wk where resource = 'transactions.head'
  union all select page_id, 'slo_deletions', latency_s from wk where resource = 'dm-live.deletions'
  union all select page_id, 'slo_repair', latency_s from wk where resource = 'repair.ws-gap'
),
spec as (
  select * from (values
    ('slo_visible', 11, :slo_visible_s, 'p95'),
    ('slo_confirm', 12, :slo_confirm_s, 'p95'),
    ('slo_confirm_fast', 13, :slo_confirm_fast_s, 'p95'),
    ('slo_find', 16, :slo_find_s, 'p95'),
    ('slo_money_head', 17, :slo_money_head_s, 'p95'),
    ('slo_deletions', 18, :slo_deletions_s, 'max'),
    ('slo_repair', 19, :slo_repair_s, 'max')
  ) as t(name, ord, bound_s, measure)
),
agg as (
  select w.page_id, w.page, sp.name, sp.ord, sp.bound_s, sp.measure, count(sa.s) as n,
         percentile_cont(0.95) within group (order by sa.s) as p95, max(sa.s) as mx
    from w cross join spec sp
    left join samples sa on sa.page_id = w.page_id and sa.name = sp.name
   group by w.page_id, w.page, sp.name, sp.ord, sp.bound_s, sp.measure
),
checks as (
  select page_id, page, ord, name,
         case when measure = 'p95' then case when n < :min_samples then 'inconclusive' when p95 <= bound_s then 'pass' else 'fail' end
              else case when n = 0 then 'inconclusive' when mx <= bound_s then 'pass' else 'fail' end end as verdict,
         json_build_object('samples', n, 'maxSeconds', round(mx, 1), 'boundSeconds', bound_s,
                           'p95Seconds', case when measure = 'p95' and n >= :min_samples then round(p95::numeric, 1) end) as detail
    from agg
  union all
  select w.page_id, w.page, 14, 'confirm_mismatches',
         case when count(*) filter (where m.confirmed) = 0 then 'inconclusive'
              when count(*) filter (where m.mismatch) <= count(*) filter (where m.confirmed) * :mismatch_share then 'pass'
              else 'fail' end,
         json_build_object('confirmed', count(*) filter (where m.confirmed), 'mismatches', count(*) filter (where m.mismatch))
    from w left join m on m.page_id = w.page_id
   group by w.page_id, w.page
  union all
  select w.page_id, w.page, 15, 'unconfirmed_over_15m',
         case when count(*) filter (where m.over15) = 0 then 'pass' else 'fail' end,
         json_build_object('messages', count(*) filter (where m.over15))
    from w left join m on m.page_id = w.page_id
   group by w.page_id, w.page
)
select coalesce(json_agg(json_build_object('page_id', page_id, 'page', page, 'ord', ord, 'check', name, 'verdict', verdict,
                                           'detail', detail) order by page, ord), '[]') as c_slo
  from checks \gset
select page, "check", verdict, detail
  from json_to_recordset(:'c_slo') as x(page text, ord int, "check" text, verdict text, detail json) order by page, ord;

\echo '== 6. open incidents of the page (a route incident, route_limited:<route> told by its key whatever its code, is judged'
\echo '      by section 3 and shown here; alert 1 page_stopped never is)'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, mode text, mode_changed_at timestamptz,
                                                   t_i timestamptz, t_end timestamptz, o_end timestamptz, now timestamptz,
                                                   complete boolean)
),
open_incidents as (
  select w.page_id, n.id, n.kind, n.incident_key, n.opened_at, n.error_code, n.error_summary,
         starts_with(n.incident_key, 'fansly_sync_engine:' || w.page_id || ':route_limited:')
           and length(n.incident_key) > length('fansly_sync_engine:' || w.page_id || ':route_limited:') as route_rule
    from w join notification_incidents n on n.platform_account_id = w.page_id and n.resolved_at is null
),
x as (
  select w.page_id, w.page,
         case when count(o.id) filter (where not o.route_rule) = 0 then 'pass' else 'fail' end as verdict,
         json_build_object('incidents', coalesce(json_agg(json_build_object(
             'kind', o.kind, 'key', o.incident_key, 'openedAt', o.opened_at, 'errorCode', o.error_code,
             'summary', o.error_summary, 'judgedByRouteRule', o.route_rule)
           order by o.opened_at, o.id) filter (where o.id is not null), '[]')) as detail
    from w left join open_incidents o on o.page_id = w.page_id
   group by w.page_id, w.page
)
select coalesce(json_agg(json_build_object('page_id', page_id, 'page', page, 'ord', 20, 'check', 'open_incidents',
                                           'verdict', verdict, 'detail', detail) order by page), '[]') as c_incidents
  from x \gset
select page, "check", verdict, detail
  from json_to_recordset(:'c_incidents') as x(page text, ord int, "check" text, verdict text, detail json) order by page;

\echo '== 7. volume (for "volume explained"): engine sends of the window by class/resource and by route, engine failures'
\echo '      by route; shadow admissions and legacy sends of the hour before T_i (75 to 15 minutes before)'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz, o_end timestamptz)
)
select w.page, a.class, a.resource, count(*) filter (where a.sent_at is not null) as sends, count(*) as admissions
  from w join sync_attempts a on a.page_id = w.page_id and not a.shadow and a.admitted_at >= w.t_i and a.admitted_at < w.o_end
 group by 1, 2, 3 order by 1, 4 desc, 2, 3;
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz, o_end timestamptz)
),
rt as (select * from json_to_recordset(:'routes') as r(route text, wire boolean))
select w.page, coalesce(rt.route, 'unknown:engine:' || a.operation) as route, a.outcome, a.error_class, a.http_status,
       count(*) as attempts
  from w
  join sync_attempts a on a.page_id = w.page_id and not a.shadow
                      and a.admitted_at >= w.t_i - :lookback_ms * interval '1 millisecond'
                      and date_trunc('milliseconds', coalesce(a.completed_at, a.sent_at, a.admitted_at)) >= w.t_i
                      and date_trunc('milliseconds', coalesce(a.completed_at, a.sent_at, a.admitted_at)) < w.o_end
  left join rt on rt.route = a.operation and rt.wire
 where a.error_class is not null or a.outcome is distinct from 'response'
 group by 1, 2, 3, 4, 5 order by 1, 6 desc, 2, 3, 4, 5;
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz, o_end timestamptz)
),
lm as (select * from json_to_recordset(:'legacy_routes') as m(operation text, route text))
select w.page, s.route, count(*) as sends
  from w cross join lateral (
    select a.operation as route from sync_attempts a
     where a.page_id = w.page_id and not a.shadow and a.sent_at >= w.t_i and a.sent_at < w.o_end
    union all
    select coalesce(lm.route, 'unknown:legacy:' || l.operation) from fansly_send_log l left join lm on lm.operation = l.operation
     where l.page_id = w.page_id and l.sent_at >= w.t_i and l.sent_at < w.o_end) as s
 group by 1, 2 order by 1, 3 desc, 2;
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz)
)
select w.page, a.class, a.resource, count(*) as shadow_admissions
  from w join sync_attempts a on a.page_id = w.page_id and a.shadow
                             and a.admitted_at >= w.t_i - interval '75 minutes' and a.admitted_at < w.t_i - interval '15 minutes'
 group by 1, 2, 3 order by 1, 4 desc, 2, 3;
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz)
)
select w.page, l.source, l.operation, count(*) as legacy_sends
  from w join fansly_send_log l on l.page_id = w.page_id
                               and l.sent_at >= w.t_i - interval '75 minutes' and l.sent_at < w.t_i - interval '15 minutes'
 group by 1, 2, 3 order by 1, 4 desc, 2, 3;

\echo '== 8. restarts: generations and resume gaps, socket connections and their repair'
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz, o_end timestamptz)
),
g as (
  select w.page, a.owner_generation, min(a.admitted_at) as first_admit, max(a.completed_at) as last_done, count(*) as attempts
    from w join sync_attempts a on a.page_id = w.page_id and not a.shadow
                               and a.admitted_at >= w.t_i - interval '5 minutes' and a.admitted_at < w.o_end
   group by 1, 2
)
select page, owner_generation, attempts, first_admit, last_done,
       round(extract(epoch from first_admit - lag(last_done) over (partition by page order by owner_generation))) as resume_gap_s
  from g order by 1, 2;
with w as (
  select * from json_to_recordset(:'windows') as w(page_id bigint, page text, t_i timestamptz, o_end timestamptz)
)
select w.page, c.started_at, c.verified_at, c.closed_at, c.stop_reason, c.gap_since, c.state_reconciled_at, c.transient_unknown
  from w join fansly_ws_connections c on c.page_id = w.page_id
                                     and c.started_at >= w.t_i - interval '10 minutes' and c.started_at < w.o_end
 order by 1, 2;

\echo '== 9. verdict per page: fail > inconclusive > owner_review (429s on two or more routes) > accepted_with_route_429 > pass'
with c as (
  select * from jsonb_to_recordset((:'c_state')::jsonb || (:'c_journal')::jsonb || (:'c_stuck')::jsonb
                                   || (:'c_slo')::jsonb || (:'c_incidents')::jsonb)
    as c(page_id bigint, page text, ord int, "check" text, verdict text, detail jsonb)
),
v as (
  select page_id, page,
         coalesce(bool_or(verdict = 'fail'), false) as failed,
         coalesce(bool_or(verdict = 'inconclusive'), false) as open,
         coalesce(max((detail ->> 'routesWith429')::int) filter (where "check" = 'route_429'), 0) as routes429,
         coalesce(jsonb_agg("check" order by ord) filter (where verdict = 'fail'), '[]') as failing,
         coalesce(jsonb_agg("check" order by ord) filter (where verdict = 'inconclusive'), '[]') as inconclusive,
         jsonb_object_agg("check", verdict) as checks
    from c group by page_id, page
)
select coalesce(json_agg(json_build_object(
         'page', page,
         'verdict', case when failed then 'fail' when open then 'inconclusive' when routes429 >= 2 then 'owner_review'
                         when routes429 = 1 then 'accepted_with_route_429' else 'pass' end,
         'reasons', case when failed then failing when open then inconclusive else '[]'::jsonb end,
         'routesWith429', routes429,
         'checks', checks) order by page), '[]') as verdicts
  from v \gset
select page, verdict, reasons, "routesWith429"
  from json_to_recordset(:'verdicts') as x(page text, verdict text, reasons json, "routesWith429" int) order by page;
\echo :verdicts

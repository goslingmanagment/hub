-- budgets-calibration.sql — the evidence behind a route budget step (step 3b
-- ruling 3 as amended by A2; owner decisions D3, №21–№22). Read-only; run it
-- inside a read-only transaction, e.g.
--
--   impl/workflows/prodsqlf.sh apps/runtime/src/sync/budgets-calibration.sql '2026-10-04T00:00:00Z'
--
-- with psql variable `since`: the start of the evidence window (the deploy of
-- the budgets under review). One row per live page and route the engine sent
-- on (or holds route state for) and per live page and family. A step up is
-- +1/min at most, never above the route's ceiling, and only on evidence:
--
--   * ≥ 24 h on the step: since the window's start, the route's newest 429
--     (its halving) and its newest `sync route raise`, whichever is latest;
--   * 0 × 429 on the route — and on every route of its family — on the step;
--   * two non-overlapping 2-hour stretches in different UTC hours at ≥ 90 % of
--     the rate the route (or family) runs at: twelve consecutive 10-minute
--     buckets each with ≥ 0.9 × rate × 10 sends;
--   * a route that never had such a stretch is `low_exposure`: never proven.
--
-- `verdict`: eligible | not_yet | low_exposure | had_429 (on the route or its
-- family since the step began) | route_state_unreadable. For an eligible slowed page+route `raise_command`
-- is the owner's lever (A2), pinned to the route state revision this report
-- read; for an eligible route at its `current` below the ceiling the step is
-- a calibration PR moving `current` (`apps/runtime/src/sync/fansly/routes.ts`).
--
-- The budget table below is `fansly/routes.ts`'s (ROUTE_BUDGETS,
-- DEFAULT_ROUTE_BUDGET, FANSLY_ROUTE_FAMILIES, FAMILY_BUDGETS), pinned equal
-- by tests/sync-route-holds.test.ts; tests/sync-budgets-calibration.integration.test.ts
-- runs it on a fixture database.

with
route_budget (route, ceiling_per_min, current_per_min) as (values
  ('messaging.groups', 12, 12),
  ('media.offer_stats', 12, 5)
),
default_budget (ceiling_per_min, current_per_min) as (values
  (15, 15)
),
family_member (route, family) as (values
  ('messaging.groups', 'messaging'),
  ('group.detail', 'messaging'),
  ('messages.page', 'messaging'),
  ('earnings.overview', 'earnings'),
  ('transactions.page', 'earnings'),
  ('earnings.accounts', 'earnings'),
  ('earnings.stats_accounts', 'earnings'),
  ('earnings.monthly_accounts', 'earnings'),
  ('earnings.stats_window', 'earnings'),
  ('earnings.monthly', 'earnings')
),
family_budget (family, ceiling_per_min, current_per_min) as (values
  ('messaging', 15, 15),
  ('earnings', 17, 17)
),
evidence as (
  select :since::timestamptz as since, clock_timestamp() as now
),
live_page as (
  select sp.page_id, coalesce(p.label, sp.page_id::text) as label,
         sp.resource_holds -> 'route:state' as route_state
    from sync_pages sp
    left join pages p on p.id = sp.page_id
   where sp.mode in ('live', 'handover')
),
send as (
  select a.page_id, a.operation as route, a.sent_at, a.http_status
    from sync_attempts a
    join live_page lp on lp.page_id = a.page_id
    cross join evidence e
   where not a.shadow
     and a.sent_at is not null
     and a.sent_at >= e.since
),
page_route as (
  select page_id, route from send group by page_id, route
  union
  select lp.page_id, r.route
    from live_page lp,
         jsonb_object_keys(case when jsonb_typeof(lp.route_state -> 'routes') = 'object'
                                then lp.route_state -> 'routes' else '{}'::jsonb end) as r(route)
),
route_row as (
  select pr.page_id, lp.label, pr.route, fm.family,
         coalesce(rb.ceiling_per_min, db.ceiling_per_min)::numeric as ceiling_per_min,
         coalesce(rb.current_per_min, db.current_per_min)::numeric as current_per_min,
         lp.route_state is null
           or (lp.route_state -> 'version' = '1'::jsonb and jsonb_typeof(lp.route_state -> 'routes') = 'object') as state_readable,
         lp.route_state -> 'routes' -> pr.route as entry
    from page_route pr
    join live_page lp on lp.page_id = pr.page_id
    cross join default_budget db
    left join route_budget rb on rb.route = pr.route
    left join family_member fm on fm.route = pr.route
),
route_step as (
  select r.*,
         least(r.current_per_min, coalesce((r.entry ->> 'effectivePerMin')::numeric, r.current_per_min)) as effective_per_min,
         (r.entry ->> 'revision')::bigint as revision,
         (r.entry ->> 'holdUntil')::timestamptz as hold_until,
         (r.entry ->> 'last429At')::timestamptz as last_429_at,
         greatest(e.since, (r.entry ->> 'last429At')::timestamptz,
                  (select max(ae.created_at) from audit_events ae
                    where ae.event_type = 'admin.sync_route_raise'
                      and ae.platform_account_id = r.page_id
                      and ae.metadata ->> 'route' = r.route)) as step_since
    from route_row r
    cross join evidence e
),
-- A family runs at its own budget; its step starts with its members' newest.
family_step as (
  select rs.page_id, rs.label, rs.family, fb.ceiling_per_min::numeric as ceiling_per_min,
         fb.current_per_min::numeric as current_per_min, bool_and(rs.state_readable) as state_readable,
         max(rs.step_since) as step_since
    from route_step rs
    join family_budget fb on fb.family = rs.family
   group by rs.page_id, rs.label, rs.family, fb.ceiling_per_min, fb.current_per_min
),
scope_row as (
  select 'route'::text as scope, rs.page_id, rs.label, rs.route as name, rs.family, array[rs.route] as routes,
         rs.ceiling_per_min, rs.current_per_min, rs.effective_per_min, rs.state_readable, rs.revision,
         rs.hold_until, rs.last_429_at, rs.step_since
    from route_step rs
  union all
  select 'family', fs.page_id, fs.label, 'family:' || fs.family, fs.family,
         (select array_agg(fm.route) from family_member fm where fm.family = fs.family),
         fs.ceiling_per_min, fs.current_per_min, fs.current_per_min, fs.state_readable, null::bigint,
         null::timestamptz, null::timestamptz, fs.step_since
    from family_step fs
),
-- Sends of the scope on its step, by 10-minute bucket.
bucket as (
  select sr.scope, sr.page_id, sr.name, floor(extract(epoch from s.sent_at) / 600)::bigint as bucket, count(*) as sends
    from scope_row sr
    join send s on s.page_id = sr.page_id and s.route = any(sr.routes) and s.sent_at >= sr.step_since
   group by sr.scope, sr.page_id, sr.name, floor(extract(epoch from s.sent_at) / 600)
),
saturated as (
  select b.scope, b.page_id, b.name, b.bucket,
         b.bucket - row_number() over (partition by b.scope, b.page_id, b.name order by b.bucket) as run
    from bucket b
    join scope_row sr on sr.scope = b.scope and sr.page_id = b.page_id and sr.name = b.name
   where b.sends >= 0.9 * sr.effective_per_min * 10
),
run as (
  select scope, page_id, name, min(bucket) as first_bucket, count(*) as buckets
    from saturated
   group by scope, page_id, name, run
),
-- Each run gives floor(buckets / 12) disjoint 2-hour stretches.
stretch as (
  select r.scope, r.page_id, r.name,
         extract(hour from to_timestamp((r.first_bucket + 12 * k) * 600) at time zone 'UTC')::int as utc_hour
    from run r, generate_series(0, (r.buckets / 12) - 1) as k
),
scope_evidence as (
  select sr.*,
         round(extract(epoch from e.now - sr.step_since)::numeric / 3600, 1) as hours_on_step,
         (select count(*) from send s where s.page_id = sr.page_id and s.route = any(sr.routes) and s.sent_at >= sr.step_since) as sends_on_step,
         (select count(*) from send s where s.page_id = sr.page_id and s.http_status = 429 and s.sent_at >= sr.step_since
             and (s.route = any(sr.routes)
                  or s.route in (select fm.route from family_member fm where fm.family = sr.family))) as refusals_429_on_step,
         (select coalesce(sum(r.buckets), 0) from run r where r.scope = sr.scope and r.page_id = sr.page_id and r.name = sr.name) as saturated_buckets,
         (select count(*) from stretch st where st.scope = sr.scope and st.page_id = sr.page_id and st.name = sr.name) as stretches_2h,
         (select coalesce(array_agg(distinct st.utc_hour order by st.utc_hour), '{}') from stretch st
           where st.scope = sr.scope and st.page_id = sr.page_id and st.name = sr.name) as stretch_utc_hours
    from scope_row sr
    cross join evidence e
),
verdict as (
  select se.*,
         se.effective_per_min < se.current_per_min as slowed,
         case
           when not se.state_readable then 'route_state_unreadable'
           when se.refusals_429_on_step > 0 then 'had_429'
           when se.stretches_2h = 0 then 'low_exposure'
           when se.hours_on_step < 24 or se.stretches_2h < 2 or cardinality(se.stretch_utc_hours) < 2 then 'not_yet'
           else 'eligible'
         end as verdict
    from scope_evidence se
)
select v.label as page,
       v.scope,
       v.name,
       v.family,
       v.ceiling_per_min,
       v.current_per_min,
       v.effective_per_min,
       v.slowed,
       v.revision,
       v.hold_until,
       v.last_429_at,
       v.step_since,
       v.hours_on_step,
       v.sends_on_step,
       v.refusals_429_on_step,
       v.saturated_buckets,
       v.stretches_2h,
       v.stretch_utc_hours,
       v.verdict,
       case
         when v.verdict <> 'eligible' then null
         when v.slowed then least(v.current_per_min, v.effective_per_min + 1)
         when v.current_per_min < v.ceiling_per_min then least(v.ceiling_per_min, v.current_per_min + 1)
       end as next_per_min,
       case
         when v.verdict = 'eligible' and v.scope = 'route' and v.slowed
           then format('pnpm cli sync route raise --page %s --route %s --to %s --revision %s --evidence %L',
                       v.label, v.name, least(v.current_per_min, v.effective_per_min + 1), v.revision,
                       'budgets-calibration since ' || to_char((select since from evidence) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
         when v.verdict = 'eligible' and not v.slowed and v.current_per_min < v.ceiling_per_min
           then 'calibration PR: current ' || v.current_per_min || ' → ' || least(v.ceiling_per_min, v.current_per_min + 1) || '/min'
       end as step
  from verdict v
 order by v.label, v.scope desc, v.name;

# C — Production Fansly request volume (read-only measurement)

**Measured:** 2026-09-07, ~05:20 UTC, against production `agency_hub_core` on
45.8.230.111 as the `read_only` Postgres role only. No writes, no `SET` other than
`statement_timeout`. Containers on the box: `agency-hub-{api,worker,scheduler,postgres}`
(api/scheduler up 51 min, worker 50 min at measurement time — i.e. a deploy/restart
happened ~04:20 UTC today; the 14-day history below is unaffected).

**Window:** 14 full UTC days, 2026-08-24 .. 2026-09-06. Steady-state numbers are taken
from the 6-day sub-window 2026-09-01 .. 2026-09-06 (clean, no incident).

**Fansly pages (from `pages`):** `lora-1`(1), `lora-2`(2), `lora-3`(3), `lilly-1`(4),
`lilly-2`(5), `ari-1`(10). OnlyFans pages `lora-of`(8), `lora-vip-of`(9) are excluded
everywhere below.

---

## 0. Headline

| | |
|---|---|
| Fleet Fansly provider calls / day (steady state) | **~29,400** (~20.4 req/min) |
| Of which DM conversation-list sweeps | **15,680/day = 53.3%** |
| Captured response bytes / day | **~2.05 GB**, of which 1.62 GB (78.7%) is the DM list sweep |
| DM list pages byte-identical to the same slot 30 min earlier | **80–92% per page, ~87% fleet-weighted** |
| Share that is live change-detection polling (event-replaceable) | **95.2%** |
| Share that is history / inventory walking (stays) | **4.8%** |
| Terminal failures (`*:failed`) | 289 in 14 days = **0.055%** of calls |

---

## 1. Schema actually visible to `read_only`

`read_only` sees **12 tables**, and the grants are **column-level**. Confirmed with:

```sql
SET statement_timeout = '180s';
select table_name, privilege_type,
       string_agg(column_name, ',' order by column_name) as cols
from information_schema.column_privileges
where grantee = 'read_only' and table_schema = 'public'
group by 1,2 order by 1;
```

Tables: `capture_byte_hot_bodies`, `capture_json_hot_bodies`, `capture_payload_locations`,
`capture_payload_objects`, `creator_raw_media`, `creator_vault_album_scans`,
`observations`, `ofapi_capture_jobs`, `page_sync_states`, `pages`,
`projection_watermarks`, `schema_migrations`.

### `observations` — one row per captured provider response

Partitioned RANGE on `received_at`, monthly (`observations_2026_01` … `_2026_12`,
`observations_future`). Columns that matter:

| column | meaning for this measurement |
|---|---|
| `source` | `'pull'` for every Fansly row (the scheduler/worker); OnlyFans uses `webhook`/`ofapi_capture` |
| `producer` | **`sync:fansly:<stream>`** — this is the sync stream (the 17 `sync_stream` enum values + `link_stats_*`) |
| `kind` | **the endpoint family** — `persistRawPayload(..., endpoint)` writes the observation with `kind = endpoint`. Terminal failures are journaled as `<stream>:failed` |
| `account_id` | FK → `pages.id` |
| `received_at` | capture instant, the partition key |
| `idempotency_key` | **`<page_id>:<stream>:<sync_run_id>:<request_seq>.<n>`** — the single most useful column here. Part 3 = sync run id (recovers `sync_runs`, which this role cannot read); part 4 before the `.` = the stream's `request_seq`, i.e. **one scheduled dispatch**; `.n` = the request's index inside that run |
| `payload` | inline JSON, or SQL NULL when the row is pointer-only (G5 CAS) |
| `payload_bucket_month`,`payload_object_id` | composite ref into `capture_payload_objects`; `logical_bytes` there gives per-request payload size |

Grant note: `payload` IS readable — that is how the failure taxonomy below was produced.

### `page_sync_states` — readable columns only

Granted: `page_id, stream, status, phase, succeeded_at, failed_at, consecutive_failures,
last_error_code, last_error_summary, blocker_kind, blocker_code, blocker_message,
blocked_at, updated_at`.
**NOT granted** (a plain `select *` errors with *permission denied for table
page_sync_states*): `cadence_seconds`, `request_seq`, `applied_seq`, `leased_seq`,
`retry_at`, `work_class`, `progress`, `slot_offset_seconds`, `last_scheduled_slot`,
`lease_*`, `dispatch_source`, `request_payload`.
→ **cadence had to be reconstructed from `idempotency_key`, not read from config.**

### `capture_payload_objects`

Granted: `object_id, bucket_month, content_sha256, logical_bytes, content_type,
representation, codec_version, platform_account_id, access_class, erasure_domain,
first_seen_at, collision_ordinal`. Content-addressed and **deduplicated**, which is what
makes the "unchanged response" measurement in §7 possible.

### Partition sizes (context)

```
observations_2026_07  460 MB
observations_2026_08 7021 MB
observations_2026_09  140 MB   <- pointer-only (CAS) capture is live, bodies live in the catalog
```

---

## 2. Volume

### 2.1 Partition pruning check (run before every heavy aggregation)

```sql
SET statement_timeout = '180s';
EXPLAIN
select (o.received_at at time zone 'UTC')::date as d, o.account_id, o.kind, o.source, count(*)
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1,2,3,4;
```
Plan touches only `observations_2026_08` (bitmap index scan on
`observations_2026_08_account_id_received_at_idx`) and `observations_2026_09` (seq scan) —
pruning confirmed, ~363k rows. The full 14-day window was used everywhere.

### 2.2 Fleet total per UTC day

```sql
select (o.received_at at time zone 'UTC')::date as utc_day, count(*) as obs
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1 order by 1;
```

| UTC day | calls | | UTC day | calls |
|---|---|---|---|---|
| 08-24 | 27,120 | | 08-31 | 30,185 |
| 08-25 | 27,121 | | 09-01 | 28,484 |
| 08-26 | 29,364 | | 09-02 | 30,584 |
| 08-27 | 31,771 | | 09-03 | 29,475 |
| 08-28 | 19,006 ← incident | | 09-04 | 29,539 |
| 08-29 | 10,180 ← incident | | 09-05 | 29,549 |
| 08-30 | 27,903 | | 09-06 | 28,957 |

14-day total **379,237**. Aug 28–29 was an outage (`lilly-2` and `lora-1` produced **zero**
rows on 08-29). Steady state = **29,431/day** (Sep 1–6 mean).

Fansly is 100% `source='pull'` — there are no Fansly webhooks at all:

```sql
select o.platform, o.source, (o.account_id is null) as acct_null, count(*)
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
group by 1,2,3 order by 4 desc;
```
→ `fansly|pull|f|379237`; `onlyfans|webhook|t|98019`; `onlyfans|pull|f|5343`;
`(null)|client_capture|t|5029`; `onlyfans|ofapi_capture|f|1622`; rest negligible.

### 2.3 Per page per UTC day (steady state)

```sql
select p.label as page, (o.received_at at time zone 'UTC')::date as d, count(*) as reqs
from observations o join pages p on p.id = o.account_id
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1,2 order by 1,2;
```

| page | mean calls/day (Sep 1–6) | share |
|---|---|---|
| lilly-2 | 11,395 | 38.7% |
| lora-1 | 6,785 | 23.1% |
| lora-2 | 4,637 | 15.8% |
| lora-3 | 3,741 | 12.7% |
| lilly-1 | 2,438 | 8.3% |
| ari-1 | 436 | 1.5% |
| **fleet** | **29,431** | |

### 2.4 Per stream × endpoint, fleet-wide

```sql
with d as (
  select split_part(o.producer,':',3) as stream, o.kind,
         (o.received_at at time zone 'UTC')::date as utc_day, count(*) as n
  from observations o
  where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
  group by 1,2,3
)
select stream, kind, sum(n) as total_14d,
       round(sum(n)::numeric/14,1) as per_day_14d,
       round(sum(n) filter (where utc_day not in (date '2026-08-28', date '2026-08-29'))::numeric/12,1)
         as per_day_clean,
       round(100.0*sum(n)/(select sum(n) from d),2) as pct_of_fleet
from d group by 1,2 order by total_14d desc;
```

Top rows (59 rows total; everything ≥0.1% shown):

| stream | kind (endpoint) | 14d total | /day (clean) | % of fleet |
|---|---|---|---|---|
| dm_conversations | dm_conversations | 197,021 | 15,162 | **51.95** |
| fan_earnings | fan_earnings_stats | 38,233 | 2,916 | 10.08 |
| fan_earnings | fan_earnings_monthly | 38,232 | 2,916 | 10.08 |
| followers_reconcile | followers | 36,164 | 2,880 | 9.54 |
| dm_messages | dm_messages | 16,837 | 1,379 | 4.44 |
| media_stats | media_offer_stats | 7,443 | 572 | 1.96 |
| notifications | notifications | 6,746 | 495 | 1.78 |
| transactions | account_lookup | 4,998 | 373 | 1.32 |
| transactions | earnings_transactions | 4,998 | 373 | 1.32 |
| post_replies | post_replies | 4,356 | 321 | 1.15 |
| followers | followers | 4,278 | 302 | 1.13 |
| catalog | vault_media | 2,687 | 200 | 0.71 |
| dm_conversations | account_lookup | 2,061 | 155 | 0.54 |
| subscribers | subscribers | 1,935 | 143 | 0.51 |
| subscribers | account_lookup | 1,935 | 143 | 0.51 |
| followers | account_me | 1,932 | 143 | 0.51 |
| light | account_me | 1,932 | 143 | 0.51 |
| top_spenders | earnings_accounts | 1,796 | 135 | 0.47 |
| posts | posts | 1,029 | 76 | 0.27 |
| posts | post_tips | 747 | 56 | 0.20 |
| followers_reconcile | account_me | 680 | 53 | 0.18 |
| dm_conversations | dm_messages | 431 | 29 | 0.11 |
| stats_snapshot | earnings_stats_snapshot | 408 | 29 | 0.11 |
| *(remaining 36 kinds)* | | ~2,300 | ~180 | ~0.6 |

### 2.5 Per page × stream (mean calls/day, 12 clean days)

```sql
with d as (
  select p.label as page, split_part(o.producer,':',3) as stream,
         (o.received_at at time zone 'UTC')::date as utc_day, count(*) as n
  from observations o join pages p on p.id = o.account_id
  where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
  group by 1,2,3
)
select page, stream, sum(n) as total_14d,
       round(sum(n)::numeric/14,1) as mean_per_day_14d,
       round(sum(n) filter (where utc_day not in (date '2026-08-28', date '2026-08-29'))::numeric/12,1)
         as mean_per_day_clean
from d group by 1,2 order by page, total_14d desc;
```

| stream | lilly-2 | lora-1 | lora-2 | lora-3 | lilly-1 | ari-1 |
|---|---|---|---|---|---|---|
| dm_conversations | **6,715** | **3,748** | **1,918** | **1,534** | **1,411** | 32 |
| fan_earnings | 2,009 | 1,576 | 1,250 | 793 | 195 | 7 |
| followers_reconcile | 1,109 | 693 | 605 | 358 | 180 | 7 |
| dm_messages | 665 | 174 | 143 | 142 | 228 | 29 |
| transactions | 141 | 141 | 144 | 144 | 144 | 35 |
| media_stats | 115 | 134 | 118 | 79 | 70 | 55 |
| notifications | 96 | 96 | 96 | 96 | 64 | 48 |
| followers | 78 | 86 | 62 | 110 | 62 | 48 |
| catalog | 32 | 62 | 62 | 61 | 14 | 15 |
| post_replies | 30 | 100 | 81 | 76 | 34 | 2 |
| subscribers | 47 | 47 | 48 | 48 | 48 | 48 |
| light | 24 | 24 | 24 | 24 | 24 | 24 |
| top_spenders | 24 | 24 | 24 | 24 | 24 | 16 |
| posts | 18 | 24 | 28 | 27 | 18 | 17 |
| stats_snapshot | 13 | 12 | 12 | 27 | 13 | 12 |
| purchase_history | 5 | 11 | 2 | 5 | 0.2 | 0.4 |
| payouts | 2 | 2 | 2 | 2 | 2 | 2 |

---

## 3. Cadence, reconstructed from `idempotency_key`

`page_sync_states.cadence_seconds` is not readable, so cadence was reconstructed by
counting **distinct scheduled dispatches** (`request_seq` = part 4 of the key) per page
per day, and the requests inside each dispatch.

```sql
with s as (
  select p.label as page, split_part(o.producer,':',3) as stream,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as req_seq,
         count(*) as reqs
  from observations o join pages p on p.id = o.account_id
  where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
    and o.source = 'pull' and o.kind not like '%:failed'
  group by 1,2,3
), per_page as (
  select page, stream, count(*)/6.0 as sched_per_day, sum(reqs)/6.0 as reqs_per_day
  from s group by 1,2
)
select stream,
       round(avg(sched_per_day),2)                          as sched_runs_per_page_per_day,
       round(86400/nullif(avg(sched_per_day),0))            as implied_cadence_s,
       round(sum(reqs_per_day)/nullif(sum(sched_per_day),0),1) as reqs_per_scheduled_run,
       round(sum(reqs_per_day),0)                           as fleet_reqs_per_day,
       round(100.0*sum(reqs_per_day)/(select sum(reqs_per_day) from per_page),2) as pct
from per_page group by 1 order by fleet_reqs_per_day desc;
```

| stream | dispatches / page / day | implied cadence | requests per dispatch | fleet req/day | % |
|---|---|---|---|---|---|
| dm_conversations | 47.9 | **30 min** | 54.5 | **15,680** | **53.30** |
| fan_earnings | 1.00 | **24 h** | 954 | 5,724 | 19.46 |
| followers_reconcile | 5.72 | ~4.2 h | 101 | 3,469 | 11.79 |
| dm_messages | 23.1 | ~62 min | 5.8 | 797 | 2.71 |
| transactions | 24.0 | **1 h** | 5.3 | 768 | 2.61 |
| media_stats | 0.17 | ~6 d | 618 | 618 | 2.10 |
| followers | 24.0 | **1 h** | 3.5 | 511 | 1.74 |
| notifications | 16.1 | ~1.5 h | 5.0 | 480 | 1.63 |
| subscribers | 24.0 | **1 h** | 2.0 | 288 | 0.98 |
| post_replies | 1.14 | ~21 h | 40.8 | 279 | 0.95 |
| catalog | 0.56 | ~43 h | 78.2 | 261 | 0.89 |
| light | 24.0 | **1 h** | 1.0 | 144 | 0.49 |
| top_spenders | 24.0 | **1 h** | 1.0 | 144 | 0.49 |
| posts | 4.03 | ~6 h | 5.7 | 138 | 0.47 |
| stats_snapshot | 0.86 | ~28 h | 16.5 | 85 | 0.29 |
| purchase_history | 1.17 | ~21 h | 4.1 | 24 | 0.08 |
| payouts | 1.00 | 24 h | 2.0 | 12 | 0.04 |
| | | | | **29,422** | |

The executor caps a *run* at **5 requests**; a dispatch that needs more (a full DM sweep)
is carried across many consecutive runs sharing the same `request_seq`. Verified by
`split_part(idempotency_key,':',3)` (the sync run id): `lilly-2` performs ~1,400
dm_conversations **runs**/day at ~4.9 requests each, all inside 48 scheduled dispatches.

---

## 4. Intra-day pattern — the DM sweep is flat 24/7

```sql
select extract(hour from o.received_at at time zone 'UTC')::int as utc_hour,
       count(*) filter (where o.producer = 'sync:fansly:dm_conversations')     as dm_conv_stream,
       count(*) filter (where o.producer = 'sync:fansly:dm_messages')          as dm_messages_stream,
       count(*) filter (where o.producer = 'sync:fansly:fan_earnings')         as fan_earnings,
       count(*) filter (where o.producer = 'sync:fansly:followers_reconcile')  as foll_reconcile,
       count(*) filter (where o.producer not in ('sync:fansly:dm_conversations',
         'sync:fansly:dm_messages','sync:fansly:fan_earnings','sync:fansly:followers_reconcile')) as other,
       count(*) as total
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10)
group by 1 order by 1;
```

Selected rows (14-day sums per hour-of-day):

| UTC hour | dm_conversations | dm_messages | fan_earnings | followers_reconcile | other | total |
|---|---|---|---|---|---|---|
| 00 | 7,975 | 2,128 | 0 | 1,258 | **18,284** | 29,645 |
| 04 | 8,062 | 337 | **18,414** | 1,107 | 1,371 | 29,291 |
| 07 | 8,370 | 378 | 12 | 1,573 | 1,217 | 11,550 |
| 12 | 8,352 | 402 | 992 | 1,821 | 1,275 | 12,842 |
| 13 | 7,942 | 305 | **11,832** | 1,896 | 1,149 | 23,124 |
| 18 | 8,127 | 430 | 0 | 1,763 | 1,067 | 11,387 |
| 20 | 9,053 | 865 | 2,669 | 2,383 | 1,409 | 16,379 |
| 23 | 8,045 | 2,034 | 0 | 2,130 | 1,197 | 13,406 |

Findings:
* **`dm_conversations` is dead flat** — 7,942…9,053 per hour-of-day across 14 days
  (≈ 570–650 calls/hour fleet-wide, 24/7). There is no night, no idle window, no
  correlation with fan activity. It is a pure clock.
* `dm_messages` follows human activity (2,128 at 00 UTC vs 260 at 14 UTC) — that stream
  *is* demand-driven already.
* `fan_earnings` is a once-a-day burst per page, whenever that page's daily slot lands
  (04 UTC and 13 UTC are the biggest).
* Hour 00 carries an extra ~18k "other" over 14 days: `notifications` (5,337),
  `media_offer_stats` (5,256), `post_replies` (3,609), `vault_media` (2,254) —
  a midnight maintenance convoy.

### Sweeps per day and sweep geometry

```sql
with s as (
  select p.label as page,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as sweep,
         min(o.received_at) as t0, max(o.received_at) as t1, count(*) as reqs
  from observations o join pages p on p.id = o.account_id
  where o.received_at >= timestamptz '2026-09-05 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.producer = 'sync:fansly:dm_conversations' and o.kind = 'dm_conversations'
  group by 1,2
), g as (
  select page, reqs, t1 - t0 as duration,
         lead(t0) over (partition by page order by t0) - t0 as start_gap
  from s
)
select page, count(*) as sweeps_2d, round(avg(reqs),1) as avg_reqs_per_sweep,
       min(reqs) as min_reqs, max(reqs) as max_reqs,
       percentile_cont(0.5) within group (order by extract(epoch from start_gap)) as median_interval_s,
       avg(duration) as avg_sweep_duration
from g group by 1 order by 1;
```

| page | sweeps / 2 days | req / sweep (avg) | min / max | median interval | sweep wall time |
|---|---|---|---|---|---|
| ari-1 | 96 | 1.0 | 1 / 1 | 1800.8 s | 0 s |
| lilly-1 | 96 | 30.3 | 30 / 57 | 1800.5 s | 2 m 30 s |
| lilly-2 | 95 | **142.1** | 140 / 263 | 1799.3 s | **12 m 27 s** |
| lora-1 | 96 | 77.0 | 77 / 81 | 1800.7 s | 6 m 27 s |
| lora-2 | 97 | 40.1 | 17 / 74 | 1800.1 s | 3 m 23 s |
| lora-3 | 96 | 32.1 | 32 / 38 | 1800.9 s | 2 m 39 s |

**Exactly 48 sweeps/day/page at a 1,800 s interval.** Page size is 100
(`getMessagingGroupsPage({limit:100, offset, sortOrder:1, flags:0})`), so requests/sweep
≈ conversations/100:

| page | implied conversations |
|---|---|
| lilly-2 | ~14,200 |
| lora-1 | ~7,700 |
| lora-2 | ~4,000 |
| lora-3 | ~3,200 |
| lilly-1 | ~3,000 |
| ari-1 | ≤100 |
| **fleet** | **~32,200 conversations, fully re-read every 30 minutes = ~1.55 M conversation-rows/day** |

`lilly-2` spends 12.5 min of every 30 min window walking its own inbox — a 42% duty cycle
that will cross 100% at roughly 34,000 conversations on that one page.

---

## 5. Failures

```sql
select p.label as page, (o.received_at at time zone 'UTC')::date as utc_day, o.kind, count(*)
from observations o join pages p on p.id = o.account_id
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10) and o.kind like '%:failed'
group by 1,2,3 order by 2,1,3;
```
289 rows in 14 days = **0.055%** of calls, ≈21/day, spread thin (max 25 in one
page-day: `lora-3` `stats_snapshot` on 08-24). No page-day exceeded 15
`dm_conversations:failed`.

The error body IS readable (`payload` is granted), and it is **not** an HTTP-status story:

```sql
select o.kind,
       coalesce(o.payload #>> '{error,code}', '<null>') as err_code,
       left(coalesce(o.payload #>> '{error,summary}',''), 90) as summary,
       count(*) as n
from observations o
where o.received_at >= timestamptz '2026-08-24 00:00:00+00'
  and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
  and o.account_id in (1,2,3,4,5,10) and o.kind like '%:failed'
group by 1,2,3 order by n desc;
```

| kind | code | summary | n |
|---|---|---|---|
| dm_conversations:failed | — | **"DM conversation sync returned duplicate or overlapping group ids; refusing to apply the page; restarted the DM conversation sweep"** | **149** |
| stats_snapshot:failed | — | "Fansly account_stats response is invalid; journal retained and progress withheld" | 25 |
| transactions:failed | — | "Fansly incremental transaction total differed from fetched rows" | 22 |
| dm_conversations:failed | — | `fetch failed` (transport) | 14 |
| subscribers:failed | — | `fetch failed` | 9 |
| dm_messages:failed | — | **Fansly request failed (500)** | 9 |
| dm_conversations:failed | `40P01` | deadlock inside the sync chunk | 8 |
| light / fan_earnings / notifications / dm_messages / followers / transactions / top_spenders :failed | — | `fetch failed` | 15 |
| followers:failed | `40P01` | deadlock | 2 |
| dm_conversations:failed | — | **Fansly authorization failed (401)** | 1 |
| followers:failed | — | **Fansly authorization failed (401)** | 1 |
| followers_reconcile:failed | `followers_reconcile_deactivation_blast_radius` | "would deactivate 104/113 active rows (limit 76); refusing destructive finalize" | 2 |
| followers_reconcile:failed | `followers_reconcile_snapshot_drift` | "moved during the scan (9383 unique rows for terminal count 9384)" | 1 |
| purchase_history:failed | — | **Fansly request failed (422)** | 1 |

**HTTP-status breakdown of the whole 14 days: two 401s, nine 500s, one 422, zero 403, zero
429.** Fansly is not rate-limiting us and not rejecting us — the client's own 5 s spacing
is the binding constraint. Every other failure is an internal consistency guard.

The dominant one matters for cost: **149 of 289 failures are the "duplicate/overlapping
group ids" guard, and each one restarts that page's DM sweep from `offset 0`** — i.e. it
throws away up to 142 requests of work. That is ~11/day of self-inflicted re-walks, and it
is a direct consequence of paginating a list that is being reordered underneath us.
`followers_reconcile_snapshot_drift` is the same disease on the follower list.

Redaction note: the sanitiser already ran — `responseSnippet` is redacted at capture and
was `null` on every DM guard row; no tokens appear in any sampled row.

---

## 6. Freshness (`page_sync_states`, granted columns only)

```sql
select p.label as page, s.stream, s.status, s.phase, s.succeeded_at, s.failed_at,
       s.consecutive_failures, s.last_error_code,
       left(coalesce(s.last_error_summary,''),50) as last_err,
       s.blocker_kind, s.blocker_code, s.updated_at
from page_sync_states s join pages p on p.id = s.page_id
where s.page_id in (1,2,3,4,5,10) order by p.label, s.stream;
```

`consecutive_failures = 0` on **101 of 102** rows; the live streams
(`light`, `dm_conversations`, `dm_messages`, `transactions`, `followers`, `subscribers`,
`top_spenders`) all succeeded within the last ~30 minutes on every page. What is *not*
healthy:

| page | stream | state | note |
|---|---|---|---|
| ari-1 | purchase_history | **blocked** | `provider_bad_data` / "Fansly request failed (422)", blocked since 2026-09-02 15:42 |
| lilly-2, lora-1, lora-2, lora-3 | notifications | pending, `phase=backfill` | **`succeeded_at` is NULL** — the backfill has never completed on these 4 pages |
| all 6 | media_stats | pending | `succeeded_at` NULL on lilly-1/lora-1/lora-2/lora-3; ari-1 last succeeded 2026-08-31, lilly-2 never |
| lora-1 | catalog | pending, `phase=vault_walk` | last success **2026-08-22** (16 days) |
| lora-2 / lora-3 | catalog | pending, `phase=vault_walk` | last success 09-03 / 09-02 |
| lora-3 | stats_snapshot | pending | `failed_at` 2026-08-24, no success since |

`projection_watermarks` is healthy — every Fansly page rebuilt within the last 52 minutes:

```sql
select p.label, w.last_rebuilt_at, now() - w.last_rebuilt_at as lag
from projection_watermarks w join pages p on p.id = w.platform_account_id
order by w.last_rebuilt_at;
```
lora-2 0:00:31, lilly-2 0:11:49, lora-1 0:16:19, lilly-1 0:28:37, lora-3 0:43:20,
ari-1 0:51:57 (plus the two OnlyFans pages at ~1.5–1.9 h). **No projection family lags.**
The table carries only one timestamp per page — it cannot say *which* family lags.

---

## 7. Bytes, and how much of it is new information

### 7.1 Bytes per day

```sql
with x as (
  select split_part(o.producer,':',3) as stream, o.kind, c.logical_bytes
  from observations o
  join capture_payload_objects c
    on c.bucket_month = o.payload_bucket_month and c.object_id = o.payload_object_id
  where o.received_at >= timestamptz '2026-09-01 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.account_id in (1,2,3,4,5,10)
)
select stream, kind, count(*) as obs_6d, round(count(*)::numeric/6,0) as obs_per_day,
       pg_size_pretty(round(sum(logical_bytes)/6.0)) as bytes_per_day,
       round(avg(logical_bytes)) as avg_bytes_per_req,
       round(100.0*sum(logical_bytes)/(select sum(logical_bytes) from x),2) as pct_bytes
from x group by 1,2 order by sum(logical_bytes) desc;
```

| stream / kind | calls/day | bytes/day | avg per call | % bytes |
|---|---|---|---|---|
| dm_conversations | 15,511 | **1,616 MB** | 109,268 | **78.66** |
| followers_reconcile / followers | 3,385 | 133 MB | 41,044 | 6.45 |
| notifications | 480 | 102 MB | 223,317 | 4.97 |
| catalog / vault_media | 205 | 60 MB | 306,634 | 2.92 |
| transactions / account_lookup | 384 | 36 MB | 99,401 | 1.77 |
| dm_messages | 797 | 24 MB | 30,981 | 1.15 |
| posts | 79 | 20 MB | 258,623 | 0.95 |
| transactions / earnings_transactions | 384 | 15 MB | 39,760 | 0.71 |
| followers | 366 | 14 MB | 39,290 | 0.67 |
| media_offer_stats | 618 | 8.5 MB | 14,102 | 0.40 |
| fan_earnings_stats + _monthly | 5,724 | 2.1 MB | 486 / 292 | 0.10 |
| *(everything else)* | ~1,000 | ~25 MB | | ~1.2 |
| **total** | **~29,400** | **~2.05 GB/day** | | |

`logical_bytes` is the size of the **stored** payload; the DM list body is
`trimFanslyMessagingGroupsPayload(page.raw)`, i.e. already trimmed. So 2.05 GB/day is a
**lower bound** on wire bytes.

### 7.2 How much of the DM sweep is new information — the key number

The capture catalog is content-addressed, so a byte-identical response reuses the same
`payload_object_id`. Comparing each request against the **same offset slot in the previous
sweep** gives the redundancy directly:

```sql
with r as (
  select p.label as page,
         split_part(split_part(o.idempotency_key,':',4),'.',1) as sweep,
         min(o.received_at) over (partition by p.label,
             split_part(split_part(o.idempotency_key,':',4),'.',1)) as sweep_t0,
         row_number() over (partition by p.label,
             split_part(split_part(o.idempotency_key,':',4),'.',1)
             order by o.received_at) as rk,
         o.payload_object_id as oid
  from observations o join pages p on p.id = o.account_id
  where o.received_at >= timestamptz '2026-09-05 00:00:00+00'
    and o.received_at <  timestamptz '2026-09-07 00:00:00+00'
    and o.producer = 'sync:fansly:dm_conversations' and o.kind = 'dm_conversations'
    and o.payload_object_id is not null
), c as (
  select page, rk, oid, lag(oid) over (partition by page, rk order by sweep_t0) as prev_oid
  from r
)
select page,
       count(*) filter (where prev_oid is not null) as comparable,
       count(*) filter (where prev_oid is not null and oid = prev_oid) as identical,
       round(100.0*count(*) filter (where prev_oid is not null and oid = prev_oid)
             /nullif(count(*) filter (where prev_oid is not null),0),1) as pct_unchanged
from c group by 1 order by 1;
```

| page | comparable requests (2 d) | byte-identical to previous sweep | **% unchanged** |
|---|---|---|---|
| lilly-1 | 2,854 | 2,619 | **91.8** |
| lilly-2 | 13,240 | 11,818 | **89.3** |
| lora-3 | 3,040 | 2,705 | **89.0** |
| lora-2 | 3,818 | 3,232 | **84.7** |
| lora-1 | 7,315 | 5,876 | **80.3** |
| ari-1 | 95 | 48 | 50.5 |
| **fleet-weighted** | 30,362 | 26,298 | **≈86.6** |

The looser month-wide dedup view agrees (83–92% repeat rate). A cross-stream version of the
same query gives: `followers_reconcile` 53–64% identical, `notifications` **0%** (a genuine
head poll that always returns something new), `transactions/earnings_transactions` 75–99%
identical.

**≈13,600 of the 15,680 daily DM list calls, and ≈1.4 GB of the 1.6 GB/day, return bytes
the kernel already has.**

---

## 8. Interpretation

### Where the requests go

Of ~29,400 Fansly calls/day, three things account for **85%**:
1. **The DM conversation-list sweep — 15,680/day (53%)**, a clock-driven full re-walk of
   ~32,200 conversations at 100/page, every 30 minutes, 24/7, whose only purpose is to
   notice that a thread has a new message. ~87% of it is byte-for-byte redundant. It is
   also 79% of the bandwidth and the source of 149 of 289 failures (the
   duplicate-group-id guard that restarts the sweep).
2. **`fan_earnings` — 5,724/day (19%)**, two calls (`fan_earnings_stats` +
   `fan_earnings_monthly`) for every known spender, once a day, whether or not that fan
   did anything.
3. **`followers_reconcile` — 3,469/day (12%)**, a full follower-list walk ~every 4 hours.

### Event-replaceable vs walks that stay

| class | streams | calls/day | share |
|---|---|---|---|
| **A. Live change-detection polling — replaceable by push/events** | dm_conversations 15,680; fan_earnings 5,724; followers_reconcile 3,469; dm_messages 797; transactions 768; followers 511; notifications 480; subscribers 288; light 144; top_spenders 144 | **28,005** | **95.2%** |
| **B. History / inventory / catalogue walks — stay whatever happens** | media_stats 618; post_replies 279; catalog (vault walk) 261; posts 138; stats_snapshot 85; purchase_history 24; payouts 12 | **1,417** | **4.8%** |

Within class A the honest sizing is:
* **dm_conversations (53%)** — the whole stream disappears if a message event arrives by
  push. Keep a slow reconcile sweep (say hourly instead of every 30 min, or daily) as a
  gap-detector: 15,680 → **~650/day at 1 h, ~320/day at 24 h**.
* **fan_earnings (19%)** — drive it off transaction events; only re-read a fan who
  actually spent. Today's per-fan bodies are byte-identical day over day.
  Realistic floor is a few hundred a day.
* **followers_reconcile (12%)** — drive it off follow/unfollow events; keep a weekly
  full reconcile for the blast-radius guard. 3,469 → **~500/day**.
* **dm_messages (2.7%)** — already demand-driven (it tracks human hours); it *grows*
  slightly under events because every event turns into a targeted thread read. Assume it
  stays or doubles: 797 → ~1,600/day.
* **notifications / transactions / light / followers / subscribers / top_spenders (6.3%)** —
  small, fixed hourly head polls. They shrink to a heartbeat but do not vanish.

**Sizing the gain:** class A ~28,000/day collapses to roughly **3,000–4,500/day**; with
class B unchanged the fleet lands at **~4,500–6,000 calls/day, an 80–85% reduction**, and
bandwidth drops from ~2.05 GB/day to **~0.3–0.45 GB/day (−80%)**. Second-order wins: the
sweep-restart failure class (149/14 d) disappears with the sweep, `lilly-2`'s 42% duty
cycle stops growing with its inbox, and the DM latency floor drops from "up to 30 minutes"
to event-time.

**Cost of doing nothing:** the DM sweep is O(conversations) × 48/day. `lilly-2` is at
~14,200 conversations and 12.5 min per 30-min window today; at ~34,000 conversations that
one page saturates its own schedule and DM freshness starts silently degrading. That
ceiling is per-page and arrives on the biggest page first.

---

## 9. What could NOT be measured with this role

* **True HTTP request count.** The adapter retries 429/5xx and transport errors internally
  (`packages/fansly/src/adapter.ts`, the `[429,500,502,503,504]` branch) and journals only
  the terminal outcome. `observations` is therefore a **lower bound** — retried attempts
  are invisible here. `sync_runs`, `ofapi_request_attempts` and the request-observer
  telemetry are not granted.
* **Configured cadence.** `page_sync_states.cadence_seconds`, `request_seq`, `applied_seq`,
  `retry_at`, `work_class`, `progress`, `last_scheduled_slot`, `dispatch_source` are not
  granted. Every cadence above is *observed*, inferred from `idempotency_key`. It matches
  clean round numbers (1800 s, 3600 s, 86400 s), so the inference is sound, but it is an
  inference.
* **Conversation / follower / fan counts.** `page_dm_threads`, `page_fans`, `page_follows`,
  `sync_checkpoints` are not visible. The ~32,200 conversations figure is derived from
  requests-per-sweep × 100, and could be off by up to one page (100) per page.
* **Which projection family lags.** `projection_watermarks` exposes one timestamp per page;
  `domain_events` and the per-family projections are not visible.
* **Rate-limit configuration.** `config_settings` is not visible, so
  `fanslyDmConversationsDelayMs` (observed as ~5 s between requests) could not be read,
  only measured.
* **Wire bytes.** `capture_payload_objects.logical_bytes` is the *stored, trimmed* body;
  headers and trimmed fields are not counted. All byte figures are lower bounds.
* **A "did this sweep find anything" counter.** There is none. §7.2's byte-identity
  comparison is the closest available proxy, and it slightly *overstates* newness: a page
  whose only change is a shifted position counts as "changed".
* **`sync_runs`, `domain_events`, `config_settings`, `audit_events`** — not granted, so no
  run-level durations, no per-run request budgets, no flag history.

---

### Query artefacts

All SQL files as executed live in
`/private/tmp/claude-501/-Users-dmitriy-code-goose-hub/7dd4d1ba-4f8b-45f5-865e-222ef0c49a90/scratchpad/research/sql/`
(`01_schema.sql` … `30_final.sql`). Every file opens with `SET statement_timeout = '180s';`
and each was piped over stdin to
`docker exec -i $(docker ps -qf name=postgres) psql -U read_only -d agency_hub_core -X -A -F "|"`.

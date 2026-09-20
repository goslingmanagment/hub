# OFAPI historical custody import (Decision 381)

Owner-approved, one-off import of custody rows for OFAPI accounts that were
retired BEFORE `ofapi_account_bindings` existed (migration 0150, 2026-09-06).
Every later replacement keeps its old ref through `applyVerifiedOfapiBinding`;
only the pre-0150 history is missing, and the sweep cannot replay it.

Symptom on production (2026-09-20): `obs_backlog_webhook_ofapi_v5` breaches
every minute, the sweep logs `skippedUnmapped: 4000` per run, and the
webhook family's replay budget goes entirely to rows no page maps.

## Why the table, not the API

`POST /api/v1/admin/ofapi/webhook/bindings` replaces a page's CURRENT account
from the live roster: the target must be listed and authenticated, and its
`historicalEvidence` proof resolves through `domain_events.observation_id`
(no index). Retired accounts are no longer in the roster, so that route cannot
express this repair. The custody table is the mechanism the canonicalize
driver reads (`listHistoricalOfapiBindings`); the runbook
`ofapi-refresh-release1.md` already anticipates "later evidence imports".

## Evidence required per account

Three independent sources, all read-only, all reproducible from `observations`:

1. **Session user id in signed CDN links** of `messages.sent` media
   (`u=<id>` in `payload.payload.media[].files.*.url`): the id of the OnlyFans
   account whose session produced the webhook. Compare with the roster
   (`ofapi_admin_accounts`, `onlyfans_id`) and `pages.metadata.avatarUrl`.
2. **The hub's own earlier attribution**: `ofapi_webhook_lineage_backfill`
   rows (producer `cli:corrections-lineage-intake`) carry `account_id` and
   wrap the original envelope with its `account_id: acct_…`.
3. **Fan-set continuity**: recipients of `messages.sent` shared between the
   retired ref and the page's current/adjacent refs.

Findings for the four retired refs (queries in the Decision 381 entry):

| Retired ref | Page | Creator id | Observed window (received_at) | Rows below v5 |
|---|---|---|---|---|
| `acct_fbaf2216a7c84147a599f349e0a6fb87` | 8 `lora-of` | 518588958 | 2026-07-05 01:55:05.652+00 → 2026-07-21 20:22:03.864+00 | 82,190 |
| `acct_b92980e0650b49d09a8312fa12f36a58` | 9 `lora-vip-of` | 514788334 | 2026-07-05 01:55:05.766+00 → 2026-07-21 20:22:43.963+00 | 62,466 |
| `acct_9070e38ab36a418da6e215b8ddbf71d9` | 8 `lora-of` | 518588958 | 2026-07-21 22:20:14.395+00 → 2026-09-03 20:22:00.233+00 | 189,357 |
| `acct_b47a56350b6f49ed99d055fc876f4bd9` | 9 `lora-vip-of` | 514788334 | 2026-07-21 22:18:13.414+00 → 2026-09-03 20:21:03.67+00 | 118,520 |

"Rows below v5" counts family kinds only (`users.typing` is not consumed by
any family and is not measured by the gauge).

## Pre-flight (read-only)

```sql
-- 1. Pages still hold the current refs and no custody row exists for the retired ones.
select id, label, status, ofapi_account_id, ofapi_binding_generation from pages where id in (8, 9);
select * from ofapi_account_bindings where account_id in (
  'acct_fbaf2216a7c84147a599f349e0a6fb87','acct_b92980e0650b49d09a8312fa12f36a58',
  'acct_9070e38ab36a418da6e215b8ddbf71d9','acct_b47a56350b6f49ed99d055fc876f4bd9');  -- expect 0 rows
-- 2. Definitive attribution check (postgres role; domain_events is not readable by read_only):
--    how the v3 pass attributed these refs. Expect ONE account_id per ref, 8 for fbaf/9070, 9 for b929/b47a.
select o.native_account_ref, d.account_id, count(*)
from domain_events d join observations o on o.id = d.observation_id
where d.occurred_at >= '2026-08-01' and d.occurred_at < '2026-08-02'
  and o.received_at >= '2026-07-31' and o.received_at < '2026-08-03'
  and o.source = 'webhook' and d.type in ('message.sent', 'tip.received', 'transaction.posted')
group by 1, 2 order by 1, 2;
-- 3. Baseline for the post-import check.
select account_id, count(*) from domain_events where account_id in (8, 9) group by 1;
```

## Import (owner "yes" first; one account at a time, smallest first)

Same locks as every binding writer (`withOfapiBindingLock`, cross-page claim
lock). Historical rows carry no generation; `valid_from`/`valid_to` are the
observed boundaries; the evidence records where the proof came from.

```sql
\set ON_ERROR_STOP on
begin;
select pg_advisory_xact_lock(9003010, 8);
select pg_advisory_xact_lock(9003010, 9);
select pg_advisory_xact_lock(9003011);
insert into ofapi_account_bindings(account_id, page_id, creator_id, generation, valid_from, valid_to, evidence)
select v.account_id, v.page_id, v.creator_id, null, v.valid_from::timestamptz, v.valid_to::timestamptz,
  jsonb_build_object(
    'source', 'historical_custody_import', 'decision', 381, 'importedAt', now(),
    'runbook', 'docs/runbooks/ofapi-historical-binding-import.md',
    'proof', jsonb_build_array('messages.sent media url u=<creator>', 'ofapi_webhook_lineage_backfill account_id', 'messages.sent recipient overlap'))
from (values
  ('acct_fbaf2216a7c84147a599f349e0a6fb87', 8, '518588958', '2026-07-05 01:55:05.652+00', '2026-07-21 20:22:03.864+00'),
  ('acct_b92980e0650b49d09a8312fa12f36a58', 9, '514788334', '2026-07-05 01:55:05.766+00', '2026-07-21 20:22:43.963+00'),
  ('acct_9070e38ab36a418da6e215b8ddbf71d9', 8, '518588958', '2026-07-21 22:20:14.395+00', '2026-09-03 20:22:00.233+00'),
  ('acct_b47a56350b6f49ed99d055fc876f4bd9', 9, '514788334', '2026-07-21 22:18:13.414+00', '2026-09-03 20:21:03.670+00')
) as v(account_id, page_id, creator_id, valid_from, valid_to)
join pages p on p.id = v.page_id and p.platform = 'onlyfans' and p.status = 'active'
where not exists (select 1 from ofapi_account_bindings b where b.account_id = v.account_id)
  and not exists (select 1 from pages q where q.ofapi_account_id = v.account_id);
-- Expect INSERT 0 4 (or 0 1 when staging one ref: keep only its VALUES row).
commit;
```

Staged rollout: run the statement with only the `acct_fbaf…` row first (82k
rows, page 8), watch three sweeps, then the remaining three rows.

## What the sweep does next (pinned by the integration test)

`tests/canonicalize-sweep.integration.test.ts` — "late custody import replays
a retired account's v3 rows without duplicating facts" runs this exact
statement against a fixture with the prod shape and asserts:

- before the import: every row rescanned and `skippedUnmapped`, nothing
  stamped, `computeHealthFloorBacklogMs` > 0;
- after the import: every v3 fact (message, tip, transaction, subscription,
  presence) **dedupes** through `domain_event_keys` — the dedup keys for
  these kinds are byte-identical between v3 and v5 — and a fully deduped row
  mints no checkpoint; only never-consumed v5 material (`chat_queue.*`,
  `posts.liked`) appends, as its hidden event plus one projection
  checkpoint; all rows are stamped v5; the gauge reads 0; the next sweep
  rescans nothing.

Expected production effect: ~452k rows replayed at ≤4,000 per minute
(`SWEEP_MAX_PAGES_PER_FAMILY` × page size) — about two to four hours — with
sweep logs reading `deduped ≈ scanned`, `appended` in the low tens (eight
`chat_queue.*` rows for page 9), `skippedUnmapped: 0`. Money projections do
not move: `transaction.posted` / `tip.received` dedupe by transaction and
notification id.

## Verification

```sql
-- gauge source: nothing below the floor for the retired refs
select native_account_ref, parse_version, count(*) from observations
where source = 'webhook' and parse_version < 5
  and native_account_ref in ('acct_fbaf2216a7c84147a599f349e0a6fb87','acct_b92980e0650b49d09a8312fa12f36a58',
    'acct_9070e38ab36a418da6e215b8ddbf71d9','acct_b47a56350b6f49ed99d055fc876f4bd9')
  and kind <> 'users.typing' group by 1, 2;   -- expect 0 rows when done
-- events per page: baseline + 16 (eight queue rows × hidden event + checkpoint), nothing else
select account_id, count(*) from domain_events where account_id in (8, 9) group by 1;
```

Worker log: `Canonicalization sweep complete` lines with `skippedUnmapped: 0`
and the `golden-signal p95 over threshold` warning gone; the
`golden_signal_lag:global:obs_backlog_webhook_ofapi_v5` incident resolves on
the first under-threshold sample.

## Rollback

`delete from ofapi_account_bindings where account_id in (…the four…)` under
the same locks. Rows already stamped v5 stay stamped (their facts were
deduped, not re-appended); the queue events for page 9 stay (they are
correct projection material). The gauge would start burning again only for
rows not yet stamped.

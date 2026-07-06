> Generated 2026-07-07 from docs/project-kernel/prompts/prompt-1-map.md at commit 0bc74f6.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Ops & observability

The kernel's operational observability rests on three services plus the ops
HTTP module. The golden-signals service samples the five pipeline latencies
(and one AI-volume gauge) minutely and latches breaches into incidents; the
DB disk-usage guard checks free space hourly and stands down retention on
breach; the reporting service builds the revenue/growth/fan reports that back
the finance and audience modules; and the ~1209-line ops module hosts health,
OFAPI credits, sync control, raw-SQL admin, live config, and the notifications
dashboard. This document maps all four.

## Golden signals (`services/golden-signals.ts`, 255 lines)

The Stage 25 five golden signals. `runGoldenSignalSample`
(`golden-signals.ts:181`) runs minutely on queue `ops.metrics.sample`
(`golden-signals.ts:30`), computing p50/p95 over a 10-minute trailing window,
with 90-day retention (`golden-signals.ts:33`). Sources: `ofapi_webhook_events`,
`domain_events` / `observations`, `projection_seq_watermarks`,
`ofapi_commands`, `domain_events_smoke_checkpoint`.

The p95 thresholds (`GOLDEN_SIGNAL_THRESHOLDS_MS`, `golden-signals.ts:36`):

| Signal | p95 threshold | Meaning |
|---|---|---|
| `capture` | 60 s | webhook → observation |
| `canonicalize` | 180 s | observation → domain_events |
| `projection` | 180 s | domain_events → projections |
| `command_settle` | 300 s | outbound command settle |
| `sse_delivery` | 600 s | SSE fan-out delivery |
| `ai_content_bytes` | 5 GB | Stage 29 gauge (BYTES) riding the p95 slot |

The `ai_content_bytes` entry is a Stage 29 (DP 6) restricted-class volume guard
— a gauge measured in bytes that rides the p95 slot so the existing breach
latch covers it (`golden-signals.ts:42-44`).

On breach the sample calls `notifyOfapiGlobalIncident({kind:
"golden_signal_lag"})`, otherwise it resolves (`golden-signals.ts:196-203`).
The report is served at `GET /api/v1/ops/metrics` via `getGoldenSignalsReport`
(`golden-signals.ts:214`, wired in `ops/index.ts:179`). The worker is
`startGoldenSignalWorker` (`golden-signals.ts:244`); the schedule is
`* * * * *` UTC (`golden-signals.ts:60`).

## DB disk-usage guard (`services/db-disk-alert.ts`, 122 lines)

The Stage 1 retention stand-down guard. `runDbDiskUsageCheck`
(`db-disk-alert.ts:71`) runs hourly at `:15` UTC (`db-disk-alert.ts:64`),
performs a `statfs("/")`, and compares against a default **80%** threshold
(`DEFAULT_DISK_USAGE_ALERT_PERCENT`, `db-disk-alert.ts:22`; overridable via
`config.diskUsageAlertPercent`). On breach it calls
`notifyOfapiGlobalIncident({kind: "db_disk_usage"})` with free/total GiB plus
the Postgres size, otherwise it resolves (`db-disk-alert.ts:103-118`). Queue:
`db.disk-usage.check`. This is the guard that lets retention stand down rather
than write into a nearly-full disk.

## Reporting service (`services/reporting.ts`, exports at `:430-1081`)

The revenue/growth/fan report builders that back the finance and audience HTTP
modules. Exported builders:

- Summaries: `getPageSummary`, `listPageSummaries`, `listModelSummaries`.
- Revenue: `getPageRevenueReport`, `getOverviewRevenueReport`,
  `getModelRevenueReport`, `getPageTransactionsReport`.
- Growth/audience: `getPageSubscribersReport` / `…Daily`,
  `getPageFollowersReport` / `…Daily`, `getPageFansReport`,
  `getPageDeletedFansReport`, `getOverviewGrowthReport`.
- Fan detail: `getPageFanDetailReport`, `getCrossPageFanDetailReport`.
- Fan spend: `getFanSpendSummary` (`reporting.ts:1081`) — per-fan spend via
  `getFanSpendByIdentifier`.

## Ops HTTP module (`apps/runtime/src/modules/ops/index.ts`, 1209 lines)

The largest module. What it hosts:

- **Health** — `GET /api/v1/health` (`ops/index.ts:158`) and
  `/api/v1/health/sync` (`ops/index.ts:166`).
- **Golden signals** — `GET /api/v1/ops/metrics` (`ops/index.ts:179`).
- **OFAPI credits** — summary / daily / `ledger` / `ledger.csv` /
  spend-comparison / dm-archive (`ops/index.ts:186-271`).
- **Sync control** — runs / trigger / blocks (`ops/index.ts:273-503`).
- **Admin (raw-SQL)** — logs / queue-jobs / db-stats / incidents
  (`ops/index.ts:520-710`).
- **Config** — live PATCH plus staged-flip with atomic version-checked apply
  (`ops/index.ts:810-994`).
- **Notifications dashboard** — the full Telegram settings/test/discover-chats,
  incidents, and report preview/send/history surface
  (`ops/index.ts:716-1207`).

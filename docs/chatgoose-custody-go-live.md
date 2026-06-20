# ChatGoose Custody Go-Live and Rollback Runbook

Status: active production runbook, 2026-06-20.

## Production Boundary

Core is the normal custody path for OFAPI reads, text commands, webhook receipt, replay/snapshot,
credit truth, spend projection, and forward-only DM archive. Desktop keeps its encrypted SQLite
cache and explicit Direct controls as rollback for still-unsupported command kinds. Historical DM
bulk backfill is prohibited.

AI is the exception: production Anthropic egress currently returns `403 Request not allowed`, so
the core AI gateway is staged off and desktop Direct AI remains active.

## Required Running State

Verify from `runtime_instances.running`, not repository defaults:

- `ofapiCreditLedgerEnabled=true`
- `ofapiDmProjectionEnabled=true`
- `ofapiDmSyncEnabled=true`
- `ofapiAccountHealthEnabled=true`
- `ofapiBalancePingEnabled=true`
- `ofapiAudienceSyncEnabled=true`
- `ofapiSpendProjectionShadowEnabled=true`
- `ofapiSpendTransactionIngestEnabled=true`
- `ofapiDmColdArchiveEnabled=true`
- `ofapiDesktopReadGatewayEnabled=true`
- `ofapiDesktopCommandOutboxEnabled=true`
- `ofapiDesktopCommandExecutionEnabled=true`
- `chatMuseAiGatewayEnabled=false` until provider egress is fixed
- `skippedOverrides=[]` for both API and worker

Desktop production defaults are Hub read, Hub text write, hourly spend reconcile, and Direct AI.
Support rollback controls are Direct read/write and the legacy 10-minute spend sweep.

## Canonical Deploy

Preflight:

```bash
pnpm typecheck
pnpm test:unit
pnpm build:production
```

Deploy:

```bash
scripts/deploy-production.sh --mode dist-only \
  root@45.8.230.111 \
  --verify-url https://gosling-agency.ru
```

Confirm API and worker are healthy and carry the intended
`agency-hub.source-revision` and `agency-hub.dependency-checksum` labels. A green API alone is not
enough; the worker owns webhook settlement, projections, commands, archive, and analytics rebuilds.

## SLOs and Alerts

Initial custody targets:

| Signal | Target | Incident threshold |
|---|---:|---:|
| Public API health | 99.9% monthly | 2 consecutive failed probes |
| Webhook acknowledgement | p95 < 1 s | p95 >= 2 s for 10 min |
| Pending webhook age | < 2 min | oldest pending >= 5 min |
| SSE settle-to-fanout lag | p95 < 5 s | p95 >= 30 s for 10 min |
| Command queue age | < 2 min | oldest queued >= 5 min while execution is enabled |
| Indeterminate commands | 0 steady-state | any new row |
| Snapshot recovery | no OFAPI calls; `resumeAllowed=true` | partial/malformed/apply failure |
| Credit floor | above configured floor | floor incident opens |
| DM archive lag | < 5 min while traffic exists | >= 15 min |
| Daily analytics rebuild | latest rebuild < 2 h old | >= 3 h |

The repo currently has no off-server automated production backup target. Until one is configured
and restore-tested, do not claim a durable RPO. This is an infrastructure blocker, not a reason to
reintroduce desktop OFAPI keys as the normal path.

## Evidence Queries

Run inside the production Postgres container.

Runtime flags:

```sql
select role,
       running->'values'->'ofapiDesktopReadGatewayEnabled'->>'value' as read_gateway,
       running->'values'->'ofapiDesktopCommandExecutionEnabled'->>'value' as command_execution,
       running->'values'->'chatMuseAiGatewayEnabled'->>'value' as ai_gateway,
       jsonb_array_length(running->'skippedOverrides') as skipped,
       last_seen_at
from runtime_instances
where last_seen_at > now() - interval '3 minutes'
order by role;
```

Webhook health:

```sql
select count(*) filter (where status = 'pending') as pending,
       min(received_at) filter (where status = 'pending') as oldest_pending,
       max(fanout_seq) as fanout_high_water
from ofapi_webhook_events;
```

Command health:

```sql
select state, count(*), min(created_at)
from ofapi_commands
group by state
order by state;
```

Archive and aggregate health:

```sql
select count(*) as archive_rows,
       max(source_received_at) as last_source_received_at,
       max(archived_at) as last_archived_at
from dm_message_archive;

select count(*) as aggregate_rows,
       max(business_date) as latest_business_date,
       max(rebuilt_at) as latest_rebuild
from dm_message_daily_aggregates;
```

Privacy checks:

- command status APIs and logs must never contain `payload.text`;
- AI logs/ledger must never contain prompt or generated text;
- cold archive media JSON must not contain `http`, `url`, signatures, or signed CDN fields;
- aggregate tables contain counts/money/timestamps only.

## Rollback Matrix

| Failure | Server rollback | Desktop rollback |
|---|---|---|
| Read gateway regression | stage read gateway off after disabling dependents; recreate API/worker | set read transport to Direct and restart |
| Command executor regression | stage execution `false`; recreate API/worker; inspect queued/in-flight rows | set write transport to Direct; never auto-resend an indeterminate row |
| Spend projection mismatch | stage transaction ingest off; retain shadow comparison | set legacy 10-minute sweep on |
| DM archive issue | stage cold archive off; keep hot projection/SSE running | no desktop change |
| Snapshot issue | keep SSE degraded and polling active; do not advance cursor | force polling, then retry snapshot after fix |
| AI gateway/provider issue | stage gateway off; remove/revert provider key; recreate API/worker | keep AI transport Direct |
| Analytics rebuild issue | unschedule/stop `ofapi.dm-analytics.rebuild`; table is disposable derived state | no desktop change |

Never rollback by deleting audit/ledger/journal rows. Never retry an indeterminate command
automatically. Never run an unbounded historical DM backfill during an incident.

## Controlled Write Validation

Any future new command kind must use only the owner-controlled `loravie`/`loravievip` pair. Record
the exact account, conversation, approved payload, command id, attempt count, ledger row, platform
id, webhook evidence, unsend/cleanup, and rollback. No third-party fan mutation is permitted.

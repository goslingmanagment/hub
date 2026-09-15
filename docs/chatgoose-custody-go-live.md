# ChatGoose Custody Go-Live and Rollback Runbook

Status: active production runbook, 2026-06-20.

> **Historical credential vocabulary.** Where this record says "chatter key" or
> "API key" about a HUB credential, it describes what existed on the day of the
> go-live. Decision 353 retired that lane: a person's bearer is a device token
> they sign in for, and there is no key to issue or revoke. Vendor keys (OFAPI,
> AI providers) are unaffected and still mean what they say here.

## Production Boundary

Core is the normal custody path for OFAPI reads, text commands, approved command-executor slices,
webhook receipt, replay/snapshot, credit truth, spend projection, and forward-only DM archive.
Desktop keeps its encrypted SQLite cache and explicit Direct controls as rollback for
still-unsupported command kinds. Historical DM bulk backfill is prohibited.

AI gateway execution is enabled only through the proxy-routed core path. The earlier direct
production-host Anthropic egress returned `403 Request not allowed`, so direct production-host
provider egress is prohibited. Anthropic calls go through the authorized page/account proxy, and
missing proxy config fails closed before quota reservation. Desktop Direct AI remains the explicit
fallback/default until the desktop gateway rollout is accepted.

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
- `chatMuseAiGatewayEnabled=true`
- `skippedOverrides=[]` for both API and worker

Desktop production defaults are Hub read, Hub write for text/typing/unsend/mark-read/media-send,
hourly spend reconcile, and Direct AI until the desktop gateway rollout is accepted. Upload and
unsupported writes still need Direct. Support rollback controls are Direct read/write, Direct AI,
and the legacy 10-minute spend sweep.

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
select kind, state, count(*), min(created_at)
from ofapi_commands
group by kind, state
order by kind, state;
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

AI gateway proxy validation:

```sql
select p.id,
       p.label,
       p.platform,
       ee.url is not null as has_proxy,
       coalesce(ee.rate_limit_scope_key, canonical_proxy_egress_key(ee.url)) as egress_key
from pages p
left join egress_endpoints ee on ee.platform_account_id = p.id
where p.label in ('lora-of', 'lora-vip-of')
order by p.label;
```

Before staging `chatMuseAiGatewayEnabled=true`, verify the selected test page has `has_proxy=true`.
The gateway must not fall back to direct host egress. After the controlled request, verify one
terminal `ai_usage_events` gateway row for the client request id with provider/cost/outcome
metadata and no prompt/output fields.

2026-06-20 production proxy validation evidence:

- Deployed revision `1ff3ebc42d55`; API/worker image labels matched that source revision and
  dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
- `lora-vip-of` was bound to an existing stored proxy route. Runtime `page proxy-ip` showed proxy
  exit IP `171.22.220.242`, direct exit IP `45.8.230.111`, and `Differs from direct: yes`.
- `POST /api/v1/ai/gateway/stream` for owner-controlled page `lora-vip-of` / conversation
  `518588958` returned HTTP 200 with SSE counts `meta=1`, `content_delta=2`, `usage=1`,
  `done=1`, `error=0`.
- Ledger row `8f6d988c-86bd-48dd-b8c8-7370dd7970a8` recorded provider `anthropic`, model
  `anthropic:claude-sonnet-4-6`, outcome `completed`, `39` input tokens, `19` output tokens,
  `402` micro-USD, quota accepted, and no prompt/output columns beyond `provider_response_id`.
- API/worker logs had zero matches for the validation canary and prompt phrase.
- Rollback drill staged gateway `false` and recreated API/worker; a valid request returned `503`
  `ChatMuse AI gateway is disabled` and wrote zero ledger rows. Gateway was restored to staged
  `true`, API/worker were recreated healthy, and final heartbeats showed read gateway `true`,
  command execution `true`, AI gateway `true`, and zero skipped overrides.
- Temporary validation chatter key was revoked and page assignment removed after the test.

Typing command validation:

```sql
select id,
       kind,
       state,
       attempt_count,
       platform_message_id,
       payload,
       verifier_result
from ofapi_commands
where id = '729fb32c-c313-4481-9c7c-c64963ec8df3';

select id,
       operation,
       page_id,
       http_status,
       credits_used,
       estimated,
       metadata
from ofapi_credit_ledger
where operation = 'ofapi_command_typing_active'
order by id desc
limit 5;
```

2026-06-20 production typing validation evidence:

- Deployed revision `405fe9e41bff`; API/worker image labels matched that source revision and
  dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
  Migration `0043_ofapi_command_typing_active.sql` was applied at
  `2026-06-20 03:12:58.929366+00`.
- The owner-controlled validation route was `lora-vip-of` page 9 to `loravie` conversation
  `518588958`. The temporary validation chatter was assigned only to `lora-vip-of`.
- API create returned HTTP 202 for `typing_active_v1` command
  `729fb32c-c313-4481-9c7c-c64963ec8df3`. The terminal row was `confirmed`,
  `attempt_count=1`, payload `{}`, `platform_message_id=null`, and verifier source
  `ofapi_response`.
- Ledger row `13` recorded `ofapi_command_typing_active`, page 9, HTTP 200, `credits_used=0`,
  `estimated=false`, and `attemptNumber=1`.
- Bounded production log checks contained command/page/kind/outcome metadata only and no validation
  key, payload, media URL, signed CDN field, or provider failure text.
- Rollback drill staged command execution `false`, recreated API/worker, and proved typing command
  `e2d9024f-84e7-44df-a8e4-cd768d58ee49` remained `queued` with zero attempts and no new typing
  ledger row. The parked command was cancelled, execution was restored to staged `true`, and final
  API/worker heartbeats reported command outbox `true`, command execution `true`, AI gateway
  `true`, and zero skipped overrides.
- The temporary validation key was revoked and its page assignment removed. The validation user has
  zero active keys and no assigned pages.

Unsend command validation:

```sql
select id,
       kind,
       state,
       attempt_count,
       platform_message_id,
       payload,
       verifier_result
from ofapi_commands
where id = '21cd8d41-8383-40b2-8418-7ca01067ea85';

select id,
       operation,
       page_id,
       http_status,
       credits,
       estimated,
       details
from ofapi_credit_ledger
where operation = 'ofapi_command_unsend_message'
order by id desc
limit 5;
```

2026-06-20 production unsend validation evidence:

- Deployed revision `8d75e4f94d93`; API/worker image labels matched that source revision and
  dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
  Migration `0044_ofapi_command_unsend_message.sql` was applied at
  `2026-06-20 03:46:07.858525+00`.
- The owner-controlled validation route was `lora-vip-of` page 9 to `loravie` conversation
  `518588958`. A fresh owner-only text command created target platform message id
  `10090438628342`; unsend command `21cd8d41-8383-40b2-8418-7ca01067ea85` then confirmed with
  `attempt_count=1`, payload `{"messageId":"10090438628342"}`, and
  `platform_message_id=10090438628342`.
- Ledger row `15` recorded `ofapi_command_unsend_message`, page 9, HTTP 200, `credits=1`,
  `estimated=false`, and `attemptNumber=1`.
- Webhook journal rows for the target message included projected `messages.sent`,
  `messages.received`, and paired `messages.deleted` events with fanout seq `15563` through
  `15566`.
- Bounded production log checks contained command/page/kind/platform-id metadata only and no text
  canary, payload, media URL, signed CDN field, or provider failure text.
- Rollback drill staged command execution `false`, recreated API/worker, and proved unsend command
  `358ad76c-3670-494a-800f-b99fe35b5474` remained `queued` with zero attempts and no new unsend
  ledger row. The parked command was cancelled, execution was restored to staged `true`, and final
  API/worker heartbeats reported command outbox `true`, command execution `true`, AI gateway
  `true`, and zero skipped overrides.
- The temporary validation key was revoked and its page assignment removed. The validation user has
  zero active keys and no assigned pages.

Mark-read command validation:

```sql
select id,
       kind,
       state,
       attempt_count,
       platform_message_id,
       payload,
       verifier_result
from ofapi_commands
where id = '<mark-read command id>';

select id,
       operation,
       page_id,
       http_status,
       credits,
       estimated,
       details
from ofapi_credit_ledger
where operation = 'ofapi_command_mark_chat_read'
order by id desc
limit 5;
```

Production mark-read validation completed on 2026-06-20:

- Canonical dist-only deploy reached revision `8fb9a9bc8393`; migration
  `0045_ofapi_command_mark_chat_read.sql` was applied at `2026-06-20 04:13:53.282961+00`.
- Owner-only command `be5c38b9-2697-4bc1-81de-957ec8db2368` on the
  `loravievip`/`loravie` route reached `confirmed` with one vendor attempt, payload `{}`, null
  `platform_message_id`, and an OFAPI-response verifier.
- Ledger row `18` recorded `ofapi_command_mark_chat_read` for page `9`, HTTP 200, one credit,
  `estimated=false`, and `{"attemptNumber":1}`.
- Worker log checks for the validation window found no payload, media URL, signed CDN field, text,
  or owner conversation id.
- Rollback drill staged command execution `false`, recreated API/worker, and proved mark-read
  command `4bbd0943-5e56-4500-9125-38928b89ebd9` remained queued/cancelled with zero attempts and no
  new mark-read ledger row. Execution was restored to staged `true`; final API/worker heartbeats
  reported command outbox `true`, command execution `true`, AI gateway `true`, and zero skipped
  overrides.
- The temporary validation key was revoked and its page assignment removed. The validation user has
  zero active keys and no assigned pages.

Media/PPV send command validation:

```sql
select id,
       kind,
       state,
       attempt_count,
       platform_message_id,
       payload,
       verifier_result
from ofapi_commands
where id = '<media command id>';

select id,
       operation,
       page_id,
       http_status,
       credits,
       estimated,
       details
from ofapi_credit_ledger
where operation = 'ofapi_command_send_media'
order by id desc
limit 5;
```

Production media/PPV send validation completed on 2026-06-20:

- Canonical dist-only deploy reached revision `2dbb5f407c52`; API and worker image labels matched
  that revision and dependency checksum `b9e2460cf2e038b7d75ad5c310424990b748fa30d55b19ad2c6b0d31a89a0227`.
  Migration `0046_ofapi_command_send_media_message.sql` was applied at
  `2026-06-20 05:02:06.041099+00`.
- The owner-only validation route was `lora-vip-of` page 9 to `loravie` conversation `518588958`.
  A governed archive query found an existing owner media id without exposing media URLs.
- Free media command `8360d753-3c2a-420d-9621-6221e1d65cf0` confirmed with one attempt, platform
  message id `10091143135310`, `price=0`, one media id, and zero previews.
- Ledger row `20` recorded `ofapi_command_send_media`, page 9, HTTP 200, one credit,
  `estimated=false`, and `{"attemptNumber":1}`.
- Cleanup unsend command `c4a8ef8d-8ab7-4f7a-ac90-225bde2ce746` confirmed with one attempt;
  ledger row `21` recorded the DELETE. Webhook rows `16680`-`16683` projected
  `messages.sent`, `messages.received`, and paired `messages.deleted` events with fanout seq
  `16617` through `16620`.
- API/worker log searches for the validation window found no caption canary, media id,
  `mediaFiles`, `mediaUrl`, signed/CDN/download URL, filename, or arbitrary vendor body fields.
- Rollback drill staged command execution `false` at config version 10, recreated API/worker, and
  proved media command `756d2124-4d23-4ad6-9367-ddd5709f97dc` remained queued/cancelled with zero
  attempts and no new media ledger row. Execution was restored to `true` at config version 11;
  final API/worker heartbeats reported command outbox `true`, execution `true`, AI gateway `true`,
  zero skipped overrides, and zero nonterminal commands.
- The temporary validation key was revoked and its page assignment removed. The validation user has
  zero active keys and no assigned pages.

## Rollback Matrix

| Failure | Server rollback | Desktop rollback |
|---|---|---|
| Read gateway regression | stage read gateway off after disabling dependents; recreate API/worker | set read transport to Direct and restart |
| Command executor regression | stage execution `false`; recreate API/worker; inspect queued/in-flight rows | set write transport to Direct; never auto-resend an indeterminate row |
| New command kind regression | stage execution `false`; recreate API/worker; cancel any queued validation command before restore | set write transport to Direct; leave local state unchanged unless a webhook/snapshot proves the mutation |
| Spend projection mismatch | stage transaction ingest off; retain shadow comparison | set legacy 10-minute sweep on |
| DM archive issue | stage cold archive off; keep hot projection/SSE running | no desktop change |
| Snapshot issue | keep SSE degraded and polling active; do not advance cursor | force polling, then retry snapshot after fix |
| AI gateway/provider issue | stage gateway off; optionally restore `.env.production.pre-ai-gateway-proxy-20260620T023316Z` to remove the provider key; recreate API/worker; keep page proxies unchanged unless the proxy itself is faulty | keep AI transport Direct |
| Analytics rebuild issue | unschedule/stop `ofapi.dm-analytics.rebuild`; table is disposable derived state | no desktop change |

Never rollback by deleting audit/ledger/journal rows. Never retry an indeterminate command
automatically. Never run an unbounded historical DM backfill during an incident.

## Controlled Write Validation

Any future new command kind must use only the owner-controlled `loravie`/`loravievip` pair. Record
the exact account, conversation, approved payload shape, command id, attempt count, ledger row,
platform id when the command creates one, webhook evidence when relevant, unsend/cleanup when
relevant, and rollback. Typing validation must record null platform id and requires no cleanup.
Unsend validation must use only an owner-owned unsendable message id, record that the command's
`platform_message_id` equals the target message id, and record the `messages.deleted` evidence when
OFAPI emits it without polling third-party fan bodies.
No third-party fan mutation is permitted.

# Лейн E — transport & health/monitor (PR 155 / 160 / 172 + prod≠main), 2026-09-14

Код читался из worktree `/Users/dmitriy/code/goose/.worktrees/hub-audit-20260914` (`0a08365f`); прод — `380326368f`.

## 1. Вердикт

Сами три PR держат заявленные инварианты (класс ошибки, порядок/скоуп/поля монитора, physical-attempt debt) и ничего из hard rules не ломают; но у #155 две дыры в гарантии «страница спит до дедлайна провайдера» (дедлайн без потолка и дедлайн, который стирается любым `requestPageSync`), а main отстаёт от прода на два поведенческих фикса (lease-loss cancellation, race cleanup↔finalizer) и на две миграции/24 decision-номера — это P2, не P1: дубль-DM отсюда невозможен (адаптер Fansly — только GET, outbox не тронут).

## 2. Находки

| № | P | Статус | file:line (worktree) | Что ломается (вход → неверный выход) | Наименьший фикс |
|---|---|---|---|---|---|
| 1 | P2 | CONFIRMED | `packages/shared/src/http-client.ts:513-535`, `packages/fansly/src/adapter.ts:2056-2063`, `apps/runtime/src/services/sync/executor.ts:313-324`, `packages/db/src/repositories/page-sync.ts:2601-2602` | У durable `retry_at` из `Retry-After` нет потолка. Один 429/503 с `Retry-After: 86400` (или HTTP-date в будущем, в т.ч. от прокси/CDN или при сдвиге часов провайдера) → `retryAfterAt = now+1d` → `retry_at = max(1d, ladder)` → стрим спит сутки. Воспроизведено: адаптер несёт `+31536000 s` (год) без клампа; executor передаёт 30-дневный `retryAt` в `retryPageSync` как есть. Инцидента нет (порог `STREAM_FAILURE_THRESHOLD=3` последовательных фейлов, `notification-incidents.ts:18,621`; здесь один), `/health/sync` считает стрим `retrying` → `pendingStreams`, страница `ok` (`sync-status.ts:991-995`, `health.ts:258-264`); `retry_wedged` только с 10 фейлов (`health.ts:23`). Планировщик честно уважает `retry_at` (`page-sync.ts:1916-1918`, `1995`, `2210`), т.е. сон реальный. | Клампить дедлайн провайдера в `resolveProviderRetryAt` потолком (30-мин cap лестницы или config `syncRetryAfterMaxMs`), при клампе — warn/anomaly в телеметрию run. Тест: `Retry-After: 86400` → `retryAt ≤ now+cap`. |
| 2 | P2 | PLAUSIBLE | `packages/db/src/repositories/page-sync.ts:3086-3104` (+ вызовы `apps/runtime/src/services/sync/fansly-dm-conversations.ts:1234-1240`, `executor-handlers.ts:323-329`) | Любой `requestPageSync` на стрим в `retrying` переводит его в `pending` и обнуляет `retry_at`/`retry_kind` — включая автоматические: follow-up `dm_messages` после чанка `dm_conversations` (`dmMessagesFollowupNeeded`, source `scheduled`) и anomaly-запрос `followers_reconcile`. Сценарий: `dm_messages` получил 429 `Retry-After: 600` → `retry_at=+600s`; через минуту `dm_conversations` завершает чанк с follow-up → `dm_messages` снова `pending` → диспатч в ещё закрытое окно → второй 429 → streak растёт (`consecutive_failures`), инцидент на 3-м. Гарантия Decision 275 «wake-up не раньше дедлайна» не держится на этом пути и не покрыта тестом (у #155 тесты только на `classifyTaskFailure`→`retryPageSync`). Не регрессия #155 (лестница стиралась так же), но заявленная гарантия без теста. | В `requestPageSync`: если `current.status === "retrying" && current.retryAt > now` — поднимать `request_seq`, но оставлять `status='retrying'`, `retry_at`, `retry_kind` (диспатч и так ждёт `retry_at`). Интеграционный тест на `dm_conversations`→`dm_messages` follow-up при `retrying`. |
| 3 | P2 | PLAUSIBLE (в проде исправлено `cfa4c602`, Decision 305; в main нет) | `packages/db/src/repositories/sync.ts:386-393` (`closeOrphanedSyncRuns`), `:458-465` (`closeInactiveSyncRuns`) | UPDATE-цель без `and sr.outcome = 'running'`. READ COMMITTED: CTE выбирает run как `running`, воркер-финализатор коммитит `succeeded`, UPDATE после ожидания row-lock перепроверяет только свой WHERE (`sr.id = …`) → перезаписывает `outcome` на `failed/partial`, `error_summary` на текст cleanup, `finished_at` на время cleanup. Итог: ложный `lastCompletedStatus`/`recentFailedCount` в мониторе, дашборде и `/health/sync` (`recentCounters.failedRuns`); `page_sync_states` не задет, планирование не страдает. Прод-фикс — 6 строк + `tests/sync-finalization-race.integration.test.ts` (232 строки), в main отсутствуют. | Портировать `cfa4c602` в main (обе UPDATE + интеграционный тест). |
| 4 | P2 | PLAUSIBLE (в проде исправлено `c1e0b15e`, Decision 306; в main нет) | `apps/runtime/src/services/sync/executor.ts:640-657, 674-676`; `packages/shared/src/http-request.ts:65-134`; `apps/runtime/src/services/sync/rate-limiter.ts` | В main потеря lease (heartbeat вернул `false`/упал) лишь ставит `leaseFenced = true`; проверка — после `executeStreamChunk` и в `assertOwnedPageSyncLease` между шагами хендлеров. Внутри одного `executeObservedRequest` (до 4 попыток, сон до 60 с каждая + ожидания rate-limiter) новые HTTP-попытки продолжают уходить после `lease_expires_at` (TTL 120 с, heartbeat 30 с). Второй воркер берёт lease → две параллельные читалки одной страницы/стрима: дубли `sync_http_attempts`, двойная нагрузка на прокси/rate-limit → 429 (и с #155 — durable сон по `Retry-After`), сожжённый бюджет. Не дубль-DM: адаптер Fansly не имеет POST/PUT/DELETE (grep `method:` — только GET), исходящие DM только через OFAPI outbox (не тронут); бизнес-завершение фенсится `lease_token` в `complete/retry/blockPageSync`. Прод несёт `http-request-scope.ts` + 4 тест-файла (≈440 строк), main — нет. | Портировать `c1e0b15e` (AsyncLocalStorage-сигнал, `fenceLease()` abort, `waitForHttpRequestPermit/Delay`, тесты `adapter-request-cancellation`, `http-request-cancellation`). |
| 5 | P2 | CONFIRMED (расхождение), последствие PLAUSIBLE | `packages/db/migrations/` (prod: `0185_fansly_followers_membership_read.sql`, `0186_ops_metrics_recent_series.sql` — в main нет; main: 0187–0191 есть в обоих), `packages/db/src/migrate-runner.ts:153,188`, `docs/decisions.md:12200` vs `:12328` | Прод применил 0185/0186 (branch `fix/performance-regressions-20260912`, `feat/fansly-c1-followers`), main их не содержит, но уже ушёл на 0187–0191. Мигратор пишет `schema_migrations.id = filename` и применяет непримененные файлы в сортировке — PR в main с номером 0185/0186 (например, с базы C1-ветки) даст два разных файла под одним номером с разным порядком применения на проде и на свежей БД. Decisions: прод содержит 296–319, main — до 295 и уже дважды «293» (`## Decision 293` и `## 293. Production load…`). Нарушение «migrations forward-only, numbered» и «decisions append-only, numbered» как процесс. | В main зарезервировать 0185/0186 (влить прод-файлы) до любых новых миграций; при мердже прод-ветки — единая нумерация decisions ≥296, дубль 293 переномеровать; проверка в CI: номер миграции строго > max(applied на проде). |

Не выведено как находки (P3): (a) тест #155 «leaves the deadline null…» шпионит `exponentialRetryDelayMs` на объекте модуля, но `resolveRetryDelayMs` вызывает локальную привязку — шпион на HTTP-пути не работает, тест реально спит 2.5–5 с (мой temp-тест с 3 ретраями упал по таймауту 30 с именно поэтому); (b) `Retry-After: 0`/HTTP-date в прошлом → in-process `retryDelayMs = 0` (горячий ретрай ×3), `Number()` принимает `"0x10"`=16 и `"1e9"`; `"-5"` через `Date.parse` → дата в 2001 → дедлайн `now` (задокументировано в http-client.test как намеренное) — всё до #155.

## 3. Утверждения PR/decision

| Утверждение | Итог | Доказательство |
|---|---|---|
| #155: `Retry-After` > 60 с → in-process цикл останавливается сразу, первый ответ терминален, `retryAfterAt` на ошибке | подтверждено | `adapter.ts:2062-2063,2105-2108,2131-2137`; тесты PR + мои: 429/`600`, 503/`61`, 429/`60.5` → 1 fetch, `["started",1],["failed",1]`; `60` ровно → in-process сон 60 000 мс |
| #155: ≤60 с — как раньше (сон, ретраи) | подтверждено | `adapter.ts:2113-2117` → `resolveRetryDelayMs` (клампит `parseRetryAfterDelayMs`, `http-client.ts:563-579`), тест «inside the clamp» |
| #155: 5xx без заголовка ретраится до бюджета | подтверждено | мой temp-тест: 503 без header → 4 попытки, задержки 2.5–5 / 5–10 / 10–20 с (лестница 5·2^(n−1) × jitter 0.5–1) |
| #155: оба формата (delta-seconds, HTTP-date) | подтверждено | `http-client.ts:513-535`; тест «HTTP-date deadline on the terminal 503» + http-client.test |
| #155: `retry_at = max(retryAfterAt, ladder)`, класс не меняется | подтверждено | `executor.ts:313-324, 413-433`; тесты «keeps the durable ladder when it outlasts…» и мой (5×consecutive=5 → 30 мин) |
| #155: «page sleeps until the provider's deadline» | опровергнуто как гарантия | находки 1 (без потолка) и 2 (`requestPageSync` стирает `retry_at`, `page-sync.ts:3104`) |
| #155: transport-ретраи через общий `exponentialRetryDelayMs`, вне Fansly ничего не изменилось | подтверждено | `exponentialRetryDelayMs` существовал до PR (`git show 21e0ee33^:…http-client.ts:564`); потребители: `telegram.ts:429,457,570,593` через неизменённый `resolveRetryDelayMs`; `normalizeProviderStreamFailure` (AI gateway) — только переименование `parseProviderRetryAfterFrameMs`→`parseRetryAfterDelayMsUnclamped`, тело байт-в-байт то же (diff `21e0ee33^`); OFAPI-парсеры (`services/ofapi.ts`, `ofapi-capture-jobs.ts`) не тронуты; outbox helper'ы не использует (grep). Единственное изменение поведения: Fansly transport 5·n → 5·2^(n−1) (3-я попытка ≤15 с → ≤20 с) |
| #155: outbox «one attempt, fail closed» не задет | подтверждено | файлы PR: `executor.ts`, `page-sync.ts`, `adapter.ts`, `errors.ts`, `http-client.ts` — ни один outbox-модуль; grep helper'ов вне telegram/adapter пуст |
| #155: `retryAfterAt` не уходит на wire | подтверждено (статически) | `new FanslyApiError(` — единственный конструктор с 5-м аргументом `adapter.ts:2131-2137`; contracts/openapi не тронуты в трёх PR (`--stat` grep пуст) |
| #155: Retry-After ведёт к `blocked`? | опровергнуто (не ведёт) | `classifyTaskFailure` 429/≥500 всегда `mode: "retry"` (`executor.ts:419-433`); streak растёт → инцидент на 3, `retry_wedged` в health на 10 (мой temp-тест: `previousConsecutiveFailures: 2, forceOpen: false`) |
| #160: селектор текущего run не менялся, только скоуп активности | подтверждено | diff `18649bd9`: `sr.outcome='running'`, `order by started_at desc, id desc` без изменений; `greatest(started, lastAttemptAt, lastEventAt)` ≡ старому `coalesce`-варианту (PG `greatest` игнорирует NULL); скоуп по `sync_run_id` эквивалентен скоупу по `page_id` через composite FK `sync_http_attempts_run_page_stream_fk`/`sync_run_events_run_page_stream_fk` (миграция 0012:25-33) |
| #160/#172: health-гейт / вердикт `/health/sync` не меняются | подтверждено | вердикт блока берётся из `page_sync_states.status` (`sync-status.ts:970-1035`), не из `runningRunId`; потребители `running*`/`lastCompleted*` — только `sync-monitor.ts:354-375, 453-505` (dashboard `isStalled` 45 с, `activeRunFor`, `lastCompletionFor`). Deploy-гейт (`scripts/deploy-production.sh:1066-1088`) принимает `200|503` + `"pages"` в теле — это проба живости/латентности, семантику health он не гейтит вообще |
| #172: поля, скоуп, порядок, mapping outcome сохранены | подтверждено | diff `c0cd21c3`: та же проекция, `row_number() … order by sr.finished_at desc, sr.id desc`, `partition by page_id, stream`, `outcome<>'running' and finished_at is not null and stream = any(...)`; `inner join sync_runs sr on sr.id = ranked."runId"` не может потерять строки; `normalizeSyncMonitorStreamRow` (84 поля) совпадает с SELECT; ORDER BY везде квалифицирован (`ps."pageLabel"`, `sr.finished_at`) |
| #172: «historical physical-attempt debt» сохранён | подтверждено (код), тест не гонял | CTE `attempts_with_last_success`/`physical_attempt_health` (`sync.ts:2353-2406`) не в diff'ах #160/#172; читают `sync_http_attempts` по `(page_id, stream)` напрямую, не через выбранный run, без верхней границы окна (только `windowStart` для recent-счётчиков); пин — `tests/sync-monitor.integration.test.ts:95-108` (`runningRunId: null`, `stalePhysicalAttemptCount: 1`, `physicalAttemptsSinceLastSuccess: 2`) — интеграционный, по брифу не запускал |
| #172 использует индекс 0177 `sync_runs_finished_idx` | не проверяемо / по форме предиката — нет | 0177 — обычный btree по `finished_at`, добавлен #164 для A0/T0-отчёта (пересекающиеся/незавершённые run); окно `completed_runs` — per-(page,stream) сортировка, ей нужен `sync_runs_page_stream_idx`; план #160 (`bounded-activity.json`) для `sync_runs` показывает `sync_runs_page_stream_idx`, `sync_runs_started_idx`, ни одного `sync_runs_finished_idx` и ни одного Seq Scan; `measurement.json` #172 планов не содержит. PR 172 использование 0177 и не заявляет |
| Бриф: «0184 partial index … которого нет в main» | опровергнуто | `packages/db/migrations/0184_load_hot_path_indexes.sql` есть в main (`sync_runs_running_idx on sync_runs (id) where outcome='running'` + `ofapi_webhook_events_page_received_idx`); предикаты `running_runs` в мониторе и `closeInactiveSyncRuns` (`outcome = 'running'`) совпадают с partial-предикатом. В проде, но не в main — 0185 и 0186 |
| Прод≠main в scope | подтверждено | `git diff 380326368f origin/main -- <scope>`: `c1e0b15e` (lease-loss cancellation: `http-request-scope.ts`, `http-request.ts`, `adapter.ts` waitForRateLimit, `rate-limiter.ts`, `executor.ts` fenceLease), `cfa4c602` (guard `sr.outcome='running'` в двух UPDATE), `f33946aa` (0186 + `listRecentOpsMetricSamples`, вне лейна), `97fcbd03` (C1: 0185, `deactivatedCount`, note `followersMembership`, `ensurePageSyncStates` activeFollowerCount — лейн C1); `deploy-production.sh` (+239/−) — гейт `wait_for_sync_health` идентичен |

## 4. Архитектура

1. **Два хозяина `retry_at`.** Стейт-машина не различает «backoff после ошибки» и «пауза, продиктованная провайдером»: `requestPageSync` любого источника (`scheduled` follow-up из `dm_conversations`, `anomaly`, ручной) считает `retrying` эквивалентом `pending` и стирает дедлайн (`page-sync.ts:3104`). Пока это так, никакая `max(retryAfterAt, ladder)` не даёт гарантии — нужен либо отдельный столбец/флаг «provider hold», либо правило «запрос не двигает `retry_at` вперёд».
2. **Дедлайн провайдера как факт без предела.** Decision 275 сознательно не клампит; но единственная защита от абсурдного значения — отсутствующая. Потолок + телеметрия при клампе стоят 10 строк и закрывают целый класс «страница тихо уснула».
3. **Три парсера одной политики.** `http-client.ts` (два варианта), `services/ofapi.ts`, `ofapi-capture-jobs.ts`; Decision 275 сам это признаёт. Пока OFAPI-путь не сведён на `parseRetryAfterInstant`, у OnlyFans-страниц другая семантика той же ошибки.
4. **`/health/sync` и деплой-гейт.** #160/#172 убрали историческую работу вокруг выбора run, но `attempts_with_last_success` по-прежнему прогоняет оконную функцию по всем `sync_http_attempts` за 30 дней retention для всех страниц/стримов на каждый вызов health; гейт же принимает 503 и меряет только «ответил за 150 с». Стоит явно решить, что гейт защищает (латентность запроса vs здоровье синка) и вынести physical-debt в инкрементальную проекцию, иначе следующий таймаут снова будет «не доказан».
5. **Cleanup как второй писатель `sync_runs.outcome` и прод как форк.** Планировщик эвристически дописывает терминальные исходы поверх финализаторов (прод-guard — минимальная заплатка, main без неё). Одновременно ветка `fix/performance-regressions-20260912` держит 4 поведенческих фикса, 2 миграции и 24 decision-номера, которых в main нет: «прод = release-коммиты» превратилось в расхождение поведения, а не порядка cherry-pick.

## 5. Что прогнал

```
cd /Users/dmitriy/code/goose/.worktrees/hub-audit-20260914
pnpm exec vitest run tests/adapter-fansly-retry.test.ts tests/sync-executor.test.ts tests/sync-status.test.ts \
  tests/sync-rate-limiter.test.ts tests/http-client.test.ts tests/health.test.ts tests/adapter-fansly-transport.test.ts \
  tests/dashboard-sync-status.test.ts tests/page-sync-repository-schema.test.ts tests/api-health-docs-auth.test.ts \
  tests/health-floor-names.test.ts
 Test Files  11 passed (11)
      Tests  147 passed (147)
 exit=0
```

Временные тесты (удалены после прогона):

```
pnpm exec vitest run tests/audit-tmp-E-transport-health-adapter.test.ts tests/audit-tmp-E-transport-health-executor.test.ts
 1-й прогон: Tests 2 failed | 7 passed (9)
   × "503 WITHOUT Retry-After still retries" — Test timed out in 30000ms (мой харнесс: spy на exponentialRetryDelayMs не действует на HTTP-путь, реальные сны 5/10/20 с)
   × "-5" → ожидал null, получил retryAfterAt=2026-09-13T23:01:59.849Z (V8 Date.parse("-5") → дата, floor к now)
 после правки харнесса (fake timers) и фиксации фактического поведения "-5":
 adapter:  Test Files 1 passed | Tests 7 passed (7)
 executor: Test Files 1 passed | Tests 2 passed (2)
```

Кейсы temp-тестов: 503+`Retry-After: 61` → 1 fetch, `retryAfterAt ≥ now+61s`; 503 без header → 4 попытки, лестница 2.5–5/5–10/10–20 с; 429+`86400` и `31536000` → `retryAfterAt` без клампа, 1 fetch; `garbage` → null + лестница; `-5` → дедлайн `now`, in-process delay 0; `Retry-After: 0` и прошлая HTTP-date → in-process `retryDelayMs 0`; `60` → сон 60 000 мс, `60.5` → терминал; executor: `retryAfterAt=+30d` → `retryPageSync(retryAt=+30d)`; 503 с дедлайном при `consecutiveFailures: 2` → `notifySyncChunkFailureIncident(previousConsecutiveFailures: 2, forceOpen: false)`.

Микропроверка Node: `Number("-5")=-5`, `Date.parse("-5")=988660800000`; `Number("1e9")=1e9`; `Number("0x10")=16`; `Number(" 600 ")=600`.

## 6. Не проверено и почему

- Интеграционные тесты `tests/sync-monitor.integration.test.ts`, `tests/sync.integration.test.ts`, page-sync/requestPageSync — Testcontainers, по брифу не запускал; находка 2 и утверждение о physical-debt — по коду.
- EXPLAIN реальных планов (`completed_runs`, `attempts_with_last_success`) — нет БД; выводы по индексам — по форме предикатов и плановым JSON из `investigations/sync-health-query-2026-09-08/`.
- Фактическая латентность `/health/sync` на проде и есть ли в проде длинные `Retry-After` вообще.
- Правильность самих прод-only фиксов (`c1e0b15e`, `cfa4c602`) — не ревьюил построчно, только что main их лишён.

### Запросы к оркестратору (роль `read_only`)

1. Индексы и их использование (ответ на Q5 эмпирически):
   ```sql
   select indexrelname, idx_scan, idx_tup_read
   from pg_stat_user_indexes
   where relname in ('sync_runs','sync_http_attempts','sync_run_events')
   order by relname, idx_scan desc;
   select indexname, indexdef from pg_indexes where tablename = 'sync_runs' order by indexname;
   ```
2. Что применено на проде из 0184–0191:
   ```sql
   select id from schema_migrations where id like '018%' or id like '019%' order by id;
   ```
3. Спит ли кто-то по Retry-After сейчас (без `retry_at`, по видимым полям):
   ```sql
   select page_id, stream, status, retry_kind, consecutive_failures, failed_at, last_error_code, left(last_error_summary, 120)
   from page_sync_states
   where status = 'retrying' and retry_kind in ('rate_limit','provider_5xx')
   order by failed_at desc limit 50;
   ```
4. Частота 429/5xx с `Retry-After` за 7 дней (если у `*:failed`-observations есть статус/заголовки в payload — подставить реальные ключи):
   ```sql
   select kind, count(*) from observations
   where kind like 'fansly:%:failed' and observed_at > now() - interval '7 days'
   group by kind order by 2 desc;
   ```
5. Размер окна physical-debt, которое health гоняет на каждый вызов:
   ```sql
   select count(*), min(started_at) from sync_http_attempts;
   select count(*) from sync_runs where outcome = 'running';
   ```

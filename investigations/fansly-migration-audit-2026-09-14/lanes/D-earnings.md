# Лейн D-earnings — деньги Fansly (PR 165 / 169 / 178 / 179 / 181)

Worktree: `/Users/dmitriy/code/goose/.worktrees/hub-audit-20260914` @ `0a08365f` (origin/main). Все `file:line` ниже — из него. Прод сверялся содержимым: `git diff 380326368f origin/main`.

## 1. Вердикт

Денежный путь корректен и read-only-аудит честный: P1 не найдено; главные риски — прод ≠ main в самом ревьюируемом парсере/replay-селекторе, плюс суточная ротация fan_earnings без дневного капа даёт «0 → 2×» дни (не регресс #165/#169, а свойство планировщика), что делает baseline для гейта «≥50 % экономии HTTP» нестабильным.

## 2. Находки

| № | P | Статус | file:line | Что ломается (вход → неверный выход) | Наименьший фикс |
|---|---|---|---|---|---|
| 1 | P2 | CONFIRMED (код + счётчики прода от оркестратора) | `packages/db/src/repositories/page-sync.ts:279-289` (cadence 86 400), `:1002-1019` (slot = floor((now − offset)/86400); page 5 → offset 7 195 s = граница 01:59:55 UTC), `:1938-1959` (новое поколение только когда строка idle и `currentSlot > lastScheduledSlot`; кэпа «не более одного walk за слот/сутки» нет), `:2049-2077` (одна lease на страницу, поток выбирается по priority desc; `fan_earnings` = 20, самый низкий среди scheduled, recovery/anomaly 30–70 выше), `apps/runtime/src/services/sync/fan-earnings.ts:67` (walk идёт до `walkCompleted`, ограничен только chunk-бюджетом 5 req / 45 s → 2 фана на чанк, ≈503 чанка для 1 005 спендеров) | Поколение слота N создаётся в ~02:00 UTC, но диспетчеризуется только когда на странице нет более приоритетного runnable-потока. После рестарта/инцидента все потоки получают recovery-поколения → `fan_earnings` голодает часами; если walk стартует после 00:00 UTC следующих суток, он целиком ложится на день N+1, строка становится idle, `currentSlot(N+1) > lastScheduledSlot(N)` → второй walk в те же UTC-сутки. Наблюдаемый эффект: 0 (09‑08, 09‑11) и 2×1005+4 (09‑12 = 2 014; +4 = один чанк из 2 фанов, перезапрошенный после рестарта, курсор `cursorFanId` durable в `page_sync_cursors`, `fan-earnings.ts:53,134-163`). Гейт «≥50 % физических HTTP» меряется против baseline, который на одной странице качается на ±100 % в сутки. Не регресс: логика walk перенесена в #169 дословно (`git show 5ae75754 -- executor-handlers.ts`), #165 планировщик не трогает, первый «0» — 09‑08, до деплоя обоих PR (10.09) | В `executeFanEarningsChunk`: если `state.completedAt` новее `now − cadence` и `dispatchSource === "scheduled"`, вернуть `satisfied:true` без walk (или per-slot request budget в `SYNC_STREAM_POLICY`) |
| 2 | P2 | PLAUSIBLE | `apps/runtime/src/services/sync/fan-earnings-capture.ts:25-31` (claim ДО `fetch()`), `packages/db/src/repositories/fan-earnings-refresh.ts:93` (TTL claim 5 мин), `packages/db/src/repositories/fan-earnings-receipts.ts:37` (`claim_expires_at > checkedAt`), `fan-earnings-capture.ts:69` (результат `settleFanEarningsReceipt` на success-пути игнорируется) | `fetch()` ждёт page rate-limit waiter / Retry-After (`rate-limiter.ts:49-57`, ожидание не ограничено TTL claim). Если ожидание + запрос > 5 мин: снимок журналируется, но settle не матчит строку → `false` молча; `last_content_fingerprint`/`last_checked_at` не обновляются. Следующий визит сравнивает уже с устаревшим fingerprint → изменение приписывается не тому claim/revision, `unsignaled_changes`/`refresh_changes` искажены. Видно только как агрегат `missing_or_inflight_receipts` | Брать claim ПОСЛЕ успешного `fetch()` (перед `persistRawPayload`) или продлевать `claim_expires_at` перед settle; логировать `false` |
| 3 | P2 | CONFIRMED (diff содержимым) | `git diff 380326368f origin/main -- apps/runtime/src/services/canonicalize/ packages/db/src/repositories/domain-events.ts packages/db/migrations` | Прод (release-линия `38032636`) несёт то, чего нет в main: (а) single-pass `parse` для earnings-семейства (`canonicalize/index.ts` в проде: `parse: parseFanslyEarningsObservation`; в main драйвер `canonicalize-driver.ts:518` зовёт `canParse`, `:550` — `canonicalize`, при отказе ещё `parseRejection` → парсер гоняется 2–3× на observation); (б) pending-head probe в `listObservationsForReplay` (Decision 315, коммит `14219b68` «avoid full journal scans for empty replay heads») — без него replay v7 при старте воркера снова делает id-ordered скан всех месячных heap'ов; (в) миграции `0185_fansly_followers_membership_read.sql`, `0186_ops_metrics_recent_series.sql` применены в проде, но отсутствуют в дереве main; `migrate-runner.ts:150-161` проверяет только файлы репо → деплой main их молча «пропустит», а любой будущий файл с номером 0185/0186 упадёт на `assertContiguousAppliedPrefix` (`:50-69`). 0178/0180/0181/0187–0191 — байт-в-байт совпадают (sha256). PR181 (`force_custom_plan`) в проде нет — это локальный экспортёр, runtime не касается | Довести release-коммиты (`ea7a629c`, `14219b68`, `7d1c0ed5`, 0185/0186) до main или зафиксировать в `docs/decisions.md` release-only дельту с запретом на номера 0185/0186 |
| 4 | P2 | CONFIRMED (temp-тест) | `apps/runtime/src/services/canonicalize/fansly-earnings.ts:96-97,106-107` (суммирование `number`-арифметикой), `apps/runtime/src/services/projections/fan-earnings.ts:59-60` (`Math.trunc`), ни один файл scope не импортирует `packages/shared/src/money.ts` (`millsFromInteger`/`sumMills`) | Hard rule CLAUDE.md «construct through the named constructors — never hand-roll arithmetic». Численно защищено: `Number.isSafeInteger` на каждой строке и на сумме — temp-тест подтвердил, что `"12.34"`, `0.1`, `2^53`, переполнение суммы → `invalid_earnings_money`, окно `month: 13` → `invalid_earnings_window`, отрицательные целые принимаются. Смешения mills/micro-USD не нашёл. Код перенесён #165 из `sync-pull.ts:280-380` без изменений (pre-existing) | Агрегировать `bigint` через `sumMills([...])`/`millsFromInteger`, `Number.isSafeInteger` оставить как границу парсинга |

P3 (не в таблице, по брифу): success-путь `settleFanEarningsReceipt` не обёрнут в try (`fan-earnings-capture.ts:69`) — DB-ошибка после журналирования проваливает run как не-fan-scoped (`fan-earnings.ts:107-108`), `fansFetched` не растёт → тот же фан перезапрашивается (лишний HTTP + дубль observation, деньгам не вредит); один ядовитый ряд отбраковывает всё observation (`fansly-earnings.ts:87-89` + `canParse`), при per-fan endpoint практически безвредно.

## 3. Утверждения PR / decisions

**PR 165 / Decision 285**
- «keys each fan/window by observation, separate SHA-256 fingerprint; A→B→A preserved; replay of one observation idempotent» → подтверждено → `fansly-earnings.ts:125-141`; `tests/canonicalize-fansly-earnings.test.ts` (прогнан): 3 разных `dedupKey`, одинаковый fingerprint у A и A, `event(1,100)` детерминирован.
- «projector orders equal timestamps by observation ID, incl. legacy rows whose column starts at zero; missing legacy receipts refuse equal-time overwrites» → подтверждено по коду → `packages/db/src/repositories/message-archive.ts:1648-1656`: `observed_at >` или (`=` и `excluded.source_observation_id >= coalesce(nullif(...,0), (select observation_id ...))`); при NULL из подзапроса WHERE → NULL → без апдейта. Интеграционный тест `fan-earnings-identity.integration.test.ts:84,114` не запускался (по брифу).
- «lifetime не уменьшится назад из-за replay старого снимка» → подтверждено по коду → `observed_at` события = `observation.observedAt ?? receivedAt`; `insertObservation` в `sync/shared.ts:177-190` observedAt не передаёт → NULL → receivedAt, монотонно с id; guard `>` отбрасывает старые.
- «A→A не даёт двойного учёта» → подтверждено → проекция — upsert-замена (`message-archive.ts:1635-1656`), не сумма; других потребителей `fan.earnings_observed` нет (grep: только projector + audit SQL).
- «empty arrays do not mint zeros; explicit zero preserved» → подтверждено → unit-тест `keeps an unscoped empty response unknown` (прогнан).
- «Historical v1 earnings remain deliverable; v2 projection-only, checkpointed» → подтверждено → `domain-events.ts:169-171,183-188`, все 9 мест классификации передают `schema_version` (grep), `domain-events-stream.ts:122`; `tests/domain-events-stream.test.ts` прогнан.
- «Only earnings kinds advance to v7» → подтверждено → unit-тест `familyForObservation` (dm_messages/purchase_history остаются lane sync v6).
- «provider mills unchanged» → подтверждено → математика парсера идентична `git show f0a53aee^:.../sync-pull.ts` (`fanslyEarningsObserved`), изменены только key/fingerprint.

**PR 169 / Decision 289**
- «records semantic changes atomically with dirty revisions» → подтверждено по коду → `fansly-transaction-dirty.ts:29-56`: одна транзакция (savepoint внутри `withOwnedPageSyncTransaction`, `sync/transactions.ts:400`), `select … for update` до upsert, mark в той же tx.
- «identical persisted upserts add no revision» → подтверждено (temp-тест) → `hasSemanticTransactionChange`: bigint-поля сравниваются по значению, `scanToken`/`newBalanceMills`/`sourceUpdatedAt` вне списка (`:9-20`).
- «settling R preserves an in-flight R+1» → подтверждено по коду → `fan-earnings-receipts.ts:41` (`applied = claimed`, не `requested`), `:58-59` (`refresh_class = 'dirty'` если `requested > applied`), CHECK `subject_refresh_revision_check` 0180:26-29; CAS — `claim_token` + `claimed_revision` + `claim_expires_at` под `for update` (`:28-39`). Интеграционный тест `fan-earnings-receipts.integration.test.ts:57` не запускался.
- «CHECK plane + R/R+1 + erasure fan-scope (план §3, стр. 79)» → подтверждено → 0180:22-32 (DROP/ADD `subject_refresh_state_plane_check`, имя совпадает с 0134:191), `erasure/index.ts:799,963-978` (delete по `(plane, subject_ref=ref)` + attribution через `transactions`; порядок target'ов: `subject_refresh_state` :974 раньше `transactions` :1216 — предикат видит нестёртые транзакции); `tests/retention-deleters.test.ts:75` допускает `erasure/index.ts`.
- «default none / fail-closed» → подтверждено → `config-registry.ts` default `"none"`, `isPageAllowlisted` (`fansly-stream-gate.ts:18-28`) пустое = никто.
- «does not add provider calls; same request selection with shadow on/off» → подтверждено по коду → `fan-earnings-capture.ts`: ровно один `input.fetch()` независимо от `shadow`; claim/settle — только `subject_refresh_state`; walk `fan-earnings.ts:67-129` дословно равен pre-#169 (`executor-handlers.ts`); `spendersOnly: true` (`:73`) не изменён. Тест `fan-earnings-capture.integration.test.ts:20` не запускался.
- «each response journaled before parsing, settlement or next endpoint» → подтверждено → `fan-earnings-capture.ts:52-69`: `persistRawPayload` → `buildFanEarningsReceipt` → settle → проверка `Array.isArray`.
- «Endpoint visits are not physical HTTP attempts» → подтверждено → `refresh_visits + 1` при любой попытке claim (`fan-earnings-refresh.ts:89`), даже если claim держит другой токен.
- «Zero/negative and absent-roster dirty targets retained but not fetched» → подтверждено → `markFanEarningsDirty` без фильтра по spend; выбор фанов по-прежнему `listPageFanNativeIds(spendersOnly)`.
- «Production activation 12 Sep … lilly-1» → не проверяемо (прод).

**PR 178 / Decision 314**
- «one bounded repeatable READ ONLY transaction; no writer changes» → подтверждено → 0187:13-16 (RAISE если не `transaction_read_only`/`repeatable read`), `fansly_earnings_audit_account` пинит `pg_current_snapshot()` и `transaction_timestamp()` (0187:95-101); в 0187–0191 и `scripts/fansly-events/*` нет ни одного INSERT/UPDATE/DELETE (grep); функции STABLE/IMMUTABLE. 0188 `fansly_earnings_audit_observations` — FUNCTION-читатель, не запись в `observations`.
- «Empty arrays never establish freshness; empty-only cohort cannot pass» → подтверждено → `scripts/fansly-events/earnings-audit.ts:163-167`: `verified` требует `observationCount > 0`, `matched > 0`, все прочие outcome = 0, `parseDebt = 0`, `unknownObservations = 0`, все партиции attached или `detachedRows = "0"`.
- «projection lag distinct from mismatch» → подтверждено → `earnings-audit-compare.ts:5-8,43`, `earnings-audit.ts:150` (`projection_pending` vs `missing`).
- «grants do not expose base tables» → подтверждено → REVOKE FROM PUBLIC + GRANT EXECUTE только `read_only` (0187:120-126, 0188:139-146, 0189:74-80); helpers 0190 без GRANT. Но см. архитектуру §4 п.4.
- prod-таблица результатов (Ari-1 verified и т.д.) → не проверяемо.

**PR 179 / Decision 317**
- «raw length before TOAST decompression» → подтверждено → 0190:8-9 `LANGUAGE internal AS 'byteaoctetlen'` = `toast_raw_datum_size − VARHDRSZ` (для compressed берёт `VARDATA_COMPRESSED_GET_EXTSIZE`, без detoast); применяется до любого `::text`/сравнения (0191:60-61), затем `fansly_earnings_audit_payload` ограничивает 512 строк × 6 скаляров, числа |x| ≤ 1e100, scale ≤ 100, итог ≤ 64 KiB (0190:45-70) → память ограничена.
- «major-version guard at install and each read» → подтверждено → 0190:3-7, 0191:12-14.
- «8 statements per exchange, each with 15 s timeout» → подтверждено → `earnings-audit-reader.ts:4` (`MAX_AUDIT_RESPONSES = 8`), `earnings-audit-pages.ts:20-34`, `SET LOCAL statement_timeout='15s'` (`earnings-audit-export.ts:54`); response ≤ 8 MiB/строка и ≤ 8 MiB×count на батч (`reader.ts:59`).
- локальные замеры (120 000 за 30.9 s и т.п.) → не проверяемо.

**PR 181 / Decision 318**
- «SET LOCAL force_custom_plan inside the READ ONLY transaction, validated and retained; wrong/missing mode → incomplete manifest» → подтверждено → `earnings-audit-export.ts:45-61` (zod `z.literal("force_custom_plan")` на `current_setting`; исключение → `completed=false`, manifest с `failure`). `SET LOCAL` транзакционен, сессионного `SET` нет; после `ROLLBACK` psql получает EOF (`reader.ts:114`). Тест `uses custom plans … restores an inherited generic plan after rollback` не запускался.
- «runtime change is four lines» → подтверждено → `git show 5bf9c5a7 --stat`: +4 в `earnings-audit-export.ts`.

## 4. Архитектура

1. **Два планировщика одного факта.** Суточная ротация (slot-планировщик страницы) и C2b-планы (`next_due_at`/`retry_after_at` в `subject_refresh_state`) живут независимо; C2b ничего не диспетчеризует, так что его due-даты — мёртвое состояние до C2c, а freshness per-fan определяется голоданием `fan_earnings` за другими потоками страницы (находка 1). Гейт «≥50 % экономии» сравнивает с baseline, который сам по себе не стационарен по дням; сравнивать нужно по слотам/поколениям, а не по UTC-суткам.
2. **Насыщение сигнала.** `hasSemanticTransactionChange(undefined, next) === true` (`fansly-transaction-dirty.ts:18`) — каждый новый tip помечает фана dirty. У активных спендеров `had_signal` при claim почти всегда true → outcome `unconfirmed`, `unsignaled_changes` структурно измеримы только на «тихих» фанах. Метрика «изменения без сигнала» смещена к неактивным фанам; тихие коррекции у активных неотличимы от обычных новых транзакций — C2c получит систематически заниженную оценку.
3. **Claim до сетевого ожидания** (находка 2): TTL claim = 5 мин фиксирован в коде, а ожидание rate-limit/Retry-After — величина внешняя; связка гарантирует потерю receipt под 429 именно тогда, когда провайдер «пересчитывает».
4. **Два определения «restricted».** Agent Read Plane сознательно не отдаёт `fan_earnings_stats` (`packages/contracts/src/agent-read-datasets.ts:870-872`), а 0189 через SECURITY DEFINER отдаёт роли `read_only` per-fan `platform_user_id` + gross/net mills проекции; 0181 в комментарии обещает «no fan identities, monetary values», 0189 — обратное. Не эскалация (kinds `fan_earnings_*` уже в allowlist `observation-scrub.ts:23-24`), но политика доступа к деньгам теперь задаётся в двух местах с разными ответами.
5. **Ревью main ≠ прод** (находка 3): все PR-тела приводят evidence с release-деревьев (`5e703b4a`, `74aac509`, `38032636`), а main их не содержит; аудит C2a в проде выполнялся single-pass драйвером, которого в main нет. Свойство «прод = release-коммиты» (память проекта) здесь превратилось в незамерженные perf-фиксы того самого пути, который PR объявляют проверенным.

## 5. Что прогнал

```
cd /Users/dmitriy/code/goose/.worktrees/hub-audit-20260914
pnpm exec vitest run tests/canonicalize-fansly-earnings.test.ts tests/fan-earnings-receipt.test.ts \
  tests/earnings-audit-reader.test.ts tests/fansly-transactions.test.ts tests/domain-events-stream.test.ts \
  tests/canonicalize-sync-pull.test.ts tests/config-registry.test.ts tests/effective-config.test.ts \
  tests/adapter-fansly-transactions-contract.test.ts tests/adapter-fansly-transactions-parity.test.ts
 Test Files  10 passed (10)
      Tests  87 passed (87)
   Duration  8.24s
```
Временный `tests/audit-tmp-D-earnings-money.test.ts` (границы денег: `"12.34"`, `0.1`, `2^53`, переполнение суммы, `month: 13`, отрицательные; bigint-сравнение в `hasSemanticTransactionChange`): `Test Files 1 passed, Tests 2 passed`, файл удалён (`git status` чист по моему лейну).
Статика: `git show <sha> --stat` для 5 PR; `git diff 380326368f origin/main` по scope + sha256 миграций 0178/0180/0181/0187–0191 (все SAME), список миграций (`0185`, `0186` только в проде); grep `platform ===`/`delete from` по новым файлам scope — 0 попаданий; `git show <sha> --stat -- packages/contracts scripts/platform-branch-budget.json tests/retention-deleters.test.ts` — пусто для всех 5 PR (routes/бюджеты/deleters не трогались).

## 6. Не проверено и почему

- Интеграционные suites (`fan-earnings-identity/receipts/dirty/capture/erasure/audit*/toast/paging`) — запрещены брифом; заявленные там гарантии (A→B→A end-to-end, R/R+1 на живой БД, grants `read_only`, TOAST-границы, erasure) оценены только по коду.
- Находка 2 — не воспроизведена (нужен реальный rate-limit ≥ 5 мин); пометка PLAUSIBLE.
- Гипотеза, что replay v7 после деплоя #165 (≈281 k earnings-observations, `prioritizeUnparsed`) вложился в насыщение VPS 11.09 01:05 UTC — PLAUSIBLE, по коду не решается.
- Прод-числа PR (результаты аудитов страниц, 3 364 теста и т.п.) — не проверяемы без прода.

### Запросы к оркестратору (роль `read_only`, READ ONLY)

1. Подтвердить механику «поздний старт → 2 walk'а за сутки» по часам старта/финиша walk'ов lilly-2:
```sql
select date_trunc('hour', received_at at time zone 'UTC') as hour_utc, count(*)
from observations
where account_id = 5 and source = 'pull' and platform = 'fansly' and kind = 'fan_earnings_stats'
  and received_at >= '2026-09-07' and received_at < '2026-09-14'
group by 1 order by 1;
```
Ожидание: 09‑09 старт вечером (496), 09‑10 два блока, 09‑12 два блока ≈1005 подряд, первый — сразу после 00:00 UTC.
2. Состояние слота (колонки, доступные read_only):
```sql
select page_id, status, dispatch_source, slot_offset_seconds, last_scheduled_slot,
       requested_at, started_at, progressed_at, finished_at, succeeded_at, consecutive_failures
from page_sync_states where stream = 'fan_earnings' order by page_id;
```
Ожидание для page 5: `slot_offset_seconds = 7195`.
3. Чем страница была занята 11.09 (голодание): по `observations` за 2026‑09‑11 для `account_id = 5` — `select kind, count(*) … group by kind` — и сравнить с 09‑10/09‑12.
4. Потери receipt (находка 2): `select fansly_earnings_shadow_report('lilly-1');` — поля `endpoints[].missing_or_inflight_receipts`, `expired_claims`, `outcomes`.
5. Для находки 3: `select id from schema_migrations where id like '0185%' or id like '0186%';` (ожидание: обе применены) — и решение владельца, куда их довести.

## 7. Ответы на вопросы брифа (кратко)

1. **Деньги.** Суммы — JS `number` mills из `row.totalGross/totalNet` (Fansly отдаёт целые mills: `money.ts:20-25`, `sync-pull.ts` v3 «units confirmed mills»), строки/дроби/переполнение → `invalid_earnings_money` (temp-тест). Именованные конструкторы `packages/shared` не используются (находка 4), смешения units нет; событие хранит `grossMills/netMills` как number, проекция пишет в BIGINT.
2. **A→B→A / A→A / legacy.** Identity по observation (`fan_earnings:v2:<obs>:<fan>:<window>`), проекция — замена по (observed_at, source_observation_id), A→A безвредно; legacy-строки с `source_observation_id = 0` резолвятся через событие, при нерезолве equal-time апдейт запрещён; откат lifetime назад невозможен (guard `>`; observed_at = receivedAt). SSE: v1 deliverable, v2 hidden с checkpoint — все 9 мест классификации version-aware.
3. **C2b.** Атомарность — одна DB-транзакция (savepoint внутри page-tx) с `for update`; CAS — token+revision+deadline под `for update`; гонка mark/claim/settle сериализована page-lease (`withOwnedPageSyncTransaction`, один поток на страницу) и row-lock; CHECK plane + revision + claim реализованы (0180); default `none` fail-closed; erasure fan-scope есть. Слабое место — TTL claim vs ожидание сети (находка 2).
4. **Аудит.** Чисто read-only (функции STABLE/IMMUTABLE, ни одной DML); 0188 — читатель, не запись; grants только EXECUTE `read_only` (политический вопрос — §4 п.4); `SET LOCAL` только в транзакции, после ROLLBACK сессия завершается; таймауты 15 s/1 s/30 s + 120 s локально и `timeout 120s` удалённо; декодирование ограничено 64 KiB по raw-длине до detoast и 512×6 скаляров после.
5. **Пустая выборка ≠ pass** — `verified` требует `observationCount > 0` и `matched > 0`; lag → `projection_pending`, не «чисто».
6. **Прод ≠ main** — находка 3.
7. **+2 046 HTTP** — не от #165/#169: shadow не добавляет запросов и был включён только на lilly-1 после двойного walk'а 09‑12; рост — целиком lilly-2 и это slot-lag ротации (находка 1, раздел 8).

## 8. Ротация lilly-2: «0 за день, 2× на следующий» (вопросы оркестратора)

**(1) Где живёт «день» и кэп.** «День» = `cadenceSeconds: 86400` в `SYNC_STREAM_POLICY.fan_earnings` (`page-sync.ts:282`), но отсчитывается не от UTC-полуночи, а от per-page слота: `slot = floor((now − slotOffsetSeconds)/86400)`, `slotOffsetSeconds = (pageId·2654435761 + streamIndex·2246822519) mod 86400` (`:1002-1019`); для page 5 это 7 195 s → граница слота 01:59:55 UTC. Новое поколение создаётся только когда строка idle (`request_seq = applied_seq`) и `currentSlot > lastScheduledSlot` (`:1938-1959`); пропущенные слоты не догоняются множественно (`last_scheduled_slot = currentSlot`), но поколение, созданное для слота N и отработавшее поздно, сразу сменяется поколением N+1, как только строка станет idle. Кэпа на количество walk'ов/запросов в сутки нет: `executeFanEarningsChunk` (`fan-earnings.ts:67-129`) идёт до `walkCompleted`, ограничен лишь chunk-бюджетом (`chunk-budget.ts:9-12`: 5 запросов / 45 s → 2 фана на чанк, ≈503 чанка на 1 005 спендеров). Состояние ротации durable: `cursorFanId`/`completedAt` в `page_sync_cursors` (`getCheckpoint`/`upsertCheckpoint(Progress)`, `:53,134-163`), в памяти ничего нет — рестарт теряет максимум один незакоммиченный чанк (2 фана = +4 запроса; ровно столько лишних в 2 014 и 1 007). Два писателя? Нет: C2b (#169) HTTP не делает — `captureFanEarningsEndpoint` вызывается только из walk, `markFanEarningsDirty` пишет лишь `subject_refresh_state`; shadow на lilly-2 никогда не включался (только lilly-1, 12.09 23:38 UTC — после двойного walk'а).

**Механика 0 → 2×.** Диспетчер берёт на страницу один поток за раз по приоритету (`acquirePageSyncLease`, `:2049-2077`); `fan_earnings` scheduled = 20 — ниже всех, recovery/anomaly-источники других потоков 30–70. После рестарта/инцидента остальные потоки получают recovery-поколения (`buildSeedPageSyncState`, `:1057-1122`; gate resume → `createdRecoveryGeneration`, `:1397-1420`) и walk голодает часами. Если его первый чанк стартует после 00:00 UTC дня N+1, весь walk слота N (≈8+ часов при ≈1 чанк/мин) ложится на день N+1, строка становится idle, планировщик видит `currentSlot(N+1) > lastScheduledSlot(N)` и немедленно создаёт следующее поколение → второй полный walk в те же UTC-сутки. 09‑09/09‑10 (496 + 1 518 = 509 хвост + 1 005 + 4) — тот же эффект с частичным переносом. Это «поздний старт + отсутствие капа», а не «догон по дизайну»: догона нескольких пропущенных слотов в коде нет.

**(2) Почему lilly-2.** Самый большой ростер спендеров (1 005 → 2 010 запросов ≈ 503 чанка → самый длинный walk, часы), и самая нагруженная страница по приоритетным потокам (DM/transactions) → максимальное голодание. У страниц с 6–732 спендерами walk укладывается в минуты–час после границы слота и всегда попадает в те же сутки; сдвинуть его за полночь может только задержка ≈22 ч, а сдвинуть многочасовой walk — задержка в несколько часов.

**(3) Регресс или свойство.** Свойство, существовавшее до #165/#169: walk перенесён #169 в `fan-earnings.ts` дословно (единственное отличие — сохранение `completedAt` в progress-state, читателей у него в runtime нет, только отчёт 0181); #165 планировщика не касается; первый «0» — 09‑08, деплой обоих PR — 10.09. Возможный (не доказанный) вклад #165 в 09‑11: старт воркера запускает v7-реparse ≈281 k retained earnings-observations (`prioritizeUnparsed`, Decision 285/314) — нагрузка на воркер/БД перед инцидентом 01:05 UTC; в main, в отличие от прода, такой replay ещё и без pending-head probe (находка 3). Проверка — SQL №1–3 из §6.

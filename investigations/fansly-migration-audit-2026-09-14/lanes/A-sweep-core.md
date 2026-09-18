# Лейн A-sweep-core — ядро обхода `dm_conversations` до A0 (PR 153 / 154 / 157 / 182)

Код: worktree `/Users/dmitriy/code/goose/.worktrees/hub-audit-20260914` @ `0a08365f` (origin/main). Все `file:line` — по нему.

## 1. Вердикт

Ядро обхода в main поведенчески эквивалентно до-#153 коду и держит инварианты (один writer чекпоинта, один concurrent writer голов, capture-first); P1 не найдено; две P2 — незамерженное прод-only ужесточение lease-loss (деплой main = регресс прода) и «исчерпанный head-debt навсегда блокирует историю треда» при включённом allowlist (сейчас `none`).

## 2. Находки

| № | P | Статус | file:line | Что ломается (вход → неверный выход) | Наименьший фикс |
|---|---|---|---|---|---|
| 1 | P2 | CONFIRMED (диф) | `apps/runtime/src/services/sync/rate-limiter.ts:26-58`, `executor.ts:629-680` (main) vs прод `380326368f` | Прод несёт `c1e0b15e` «stop new HTTP attempts after observed lease loss» (ветка `origin/fix/performance-regressions-20260912`, НЕ предок origin/main): `assertHttpRequestActive()` в rate-limit waiter + `AbortController` на потере lease. В main после потери lease heartbeat лишь ставит `leaseFenced=true`; sweep продолжает HTTP до следующей `assertOwnedPageSyncLease` (`fansly-dm-conversations.ts:423` — раз на list-страницу; внутри итерации до 4 group_detail/head-repair запросов, `:648`, `:726`) и до `withOwnedPageSyncTransaction`. Деплой main как есть → откат ужесточения, которое сейчас работает в проде. В том же `git diff 380326368f origin/main -- apps/runtime/src/services/sync/ packages/db/src/repositories/` (10 файлов, +24/−249) прод-only: guard `and sr.outcome='running'` в `closeOrphanedSyncRuns`/`closeInactiveSyncRuns`, probe пустой replay-головы в `listObservationsForReplay`, рекурсивный `listRecentOpsMetricSamples`, гейт `activeFollowerCount` в `ensurePageSyncStates`, followers-membership note, `readEnvelopeCapturePayloadBatch`. Файлы моего scope (`fansly-dm-conversations.ts`, `fansly-dm-head-diff.ts`, `cursor-state.ts`, `page-dm.ts`, `fansly-dm-head-debt.ts`) в проде и main идентичны. | Перед следующим деплоем смержить `fix/performance-regressions-20260912` (или явно зафиксировать в decisions, что прод = main + эта ветка). |
| 2 | P2 | PLAUSIBLE (прослежено по SQL, БД не поднимал) | `packages/db/src/repositories/page-dm.ts:1153-1157`, `fansly-dm-head-debt.ts:99-104`, `fansly-dm-conversations.ts:1013-1015` | При `fanslyDmHeadCatchupPageAllowlist` ∋ страница: тред с `message_coverage_status='pending_backfill'` и debt, исчерпавшим 5 попыток (`captured_at null, attempts=5`, напр. удалённая провайдером голова) → первая ветвь выбора требует `attempts<5`, вторая (`pending_backfill and not exists(debt captured_at is null)`) НЕ фильтрует по attempts → тред никогда не выбирается на историю; в sweep `hasUnresolvedFanslyDmHead` тоже без фильтра → `pendingHistory=false`, `nextFanslyDmHeadRetryAt` (с `attempts<5`) → `null` → follow-up не запрашивается. Выход только при новой голове (новая debt-строка). Decision 277 обещает «exhaustion leaves visible unresolved work», но не говорит, что блокируется первичный backfill истории. Сейчас allowlist `none` → прод не затронут. | Добавить `and d.attempts < 5` в `not exists` второй ветви (`page-dm.ts:1155`) и в `hasUnresolvedFanslyDmHead`; или отдельное состояние `exhausted`, не блокирующее историю. Добавить SQL-регрессию в `tests/fansly-dm-head-debt*.integration`. |
| 3 | P2 | PLAUSIBLE | `apps/runtime/src/services/sync/executor-handlers.ts:2955-2987` | Путь «partner unresolvable после 3×5xx» пишет ВЕСЬ ряд `page_dm_threads` (включая `lastMessageId/At/SenderId/Preview`) из снапшота `currentConversation`, прочитанного в начале обхода (`:2739`/`:2812`), через `upsertPageDmConversation` без `headForwardOnly` — единственная цель: дописать `messageSyncExcludedReason`. Сегодня конкурентного писателя голов у Fansly нет (page-lane один, sweep не идёт параллельно), регресса нет. Но это латентный второй writer голов «по форме»: любой будущий concurrent writer (A1 socket) + этот write-back = откат головы на возраст снапшота — ровно та ловушка, о которой предупреждает `page-dm.ts:137-143`. | Заменить на точечный `update page_dm_threads set metadata = metadata || {...}` (или репо-функцию `markPageDmConversationExcluded`). |
| 4 | P2 | PLAUSIBLE | `fansly-dm-conversations.ts:1265-1288`, `:1341-1348`; `page-dm.ts:279-299` | Empty-sweep guard без escape hatch: страница, чей inbox реально опустел, каждые 15 мин даёт `dm_conversations_empty_sweep_guard` (warn) и `satisfied:false` навсегда (≈96 anomaly/сутки на страницу), `succeeded_at` не двигается, `lastFullSweepCompletedAt` заморожен. Заявлено в Decision 274 как осознанная цена; для новых/пустых страниц (0 видимых тредов) ложного срабатывания нет — `countPageDmVisibleThreadsBelowGeneration`=0 → certified. Предикат guard и destructive pass — два одинаковых текста SQL (`:262-264` vs `:289-291`), идентичность держится комментарием и integration-пином, не общей константой. | Вынести where-clause в одну `sql`-константу; operator-ручку «retire threads» вне scope. |

P3 (не выводится): дублирование `loadEffectiveConfig` на chunk; `observeFanslyDmHead` +1 insert-select на диалог на всех Fansly-страницах независимо от allowlist (`:1004-1008`), при allowlist ещё +2 запроса на диалог (`:1009-1015`) — стоимость, не баг.

## 3. Утверждения PR / decision

| Утверждение | Статус | Доказательство |
|---|---|---|
| #153: «три коммита, каждый behaviour-preserving» | подтверждено | `diff -w` тела `fanslyDmConversationsChunk` (`130150ac^` executor-handlers.ts:2783-3716) против `130150ac:fansly-dm-conversations.ts` — 446 строк дифа, из них −36/+273; все содержательные изменения: (a) `parseDmConversationCursorState`→`parseDmConversationSweepState` с `existingState = kind==='in_progress' ? … : null` (`:286-290`) — completed-документ и раньше давал `null`→fresh sweep; (b) inline-предикат `!existing || lastMessageId≠ || unreadCount≠ || !isVisible || unresolvedIdentity≠ || excludedReason≠` ↔ `breaksLegacyUnchangedPage(reasons)` с `LEGACY_UNCHANGED_PAGE_REASONS = [missing_row,last_message_id,unread_count,visibility,unresolved_identity,message_sync_excluded_reason]` (`fansly-dm-head-diff.ts:69-76, 94-135`; incoming `isVisible:true` ⇒ `visibility` ⟺ `!existing.isVisible`); (c) `createdAt/notes` spread вместо `undefined` — потребители `fan-hydration.ts:32` (`account.createdAt ? …`), `:176` (`Array.isArray(account.notes)`) — эквивалентно. |
| #153: «persisted JSON unchanged to the byte» | подтверждено | `cursor-state.ts:556-591`: набор и порядок ключей in-progress (`version,mode,generation,offset,observedCount,pageCount,providerTotalMode,providerReportedTotal,unchangedPageStreak,fullSweepStartedAt,lastFullSweepCompletedAt[,generationSetCount]`) и completed (`…,membershipCertified,lastFullSweepCompletedAt[,erasureDelta]`) совпадают со старыми литералами; `erasureDelta` сериализуется только non-null (`:571`). Юнит `tests/dm-conversation-cursor-state.test.ts` — pass. |
| #153: «четыре inline upsert → один `writeSweepCheckpoint`, те же репо-функции» | подтверждено | `:169-203`; вызовы `:314` (init, progress, app.db), `:391` (restart, progress, app.db), `:1134/1139` (completed, progress/success, dbTx), `:1157` (mid-sweep progress с `generationSetCount`, dbTx). Других писателей stream `dm_conversations` для Fansly нет: `ofapi-dm-sync.ts:758/764/815` — только OnlyFans-страницы; `sync-blocks.ts:593-601 deleteCheckpoints` — owner-gated reset блока `messages_live` (`:149`). |
| #153: «no import cycles» | подтверждено | `fansly-dm-conversations.ts:23-104` — импорта `executor-handlers.ts` нет. |
| #153: «`withPageSyncLock` had no production callers» | не проверяемо здесь | `locking.ts` удалён; не восстанавливал. |
| #154 / D274: пустой sweep при видимых тредах → ничего не скрыто, нет success-штампа, `lastFullSweepCompletedAt` не двигается, +15 мин | подтверждено | `:1067-1073` guard считается только при `finalObservedCount===0`; `:1083-1090` `membershipCertified = !guard && …`, `finalizationWithheld`; `:1091` destructive только при certified; `:1112-1114`; `:1131-1138` progress-write; `:1341-1348` `satisfied:false` + `continuationRetryAt=+15m`. Юнит `sync-handlers.test.ts:3737-3900` (3 кейса, мок-БД) pass; integration `fansly-dm-conversations-sweep.integration.test.ts:302-396` (не гонял). |
| #154: «страница без видимых тредов certifies as before» | подтверждено | `countPageDmVisibleThreadsBelowGeneration`=0 → `emptySweepGuardHeld=false` → certified. |
| Гипотеза Q3 «пропуск guard при первой пустой странице и `total>0`» | опровергнуто | Адаптер: `done = parsed.data.length < limit` (`packages/fansly/src/adapter.ts`, `getMessagingGroupsPage`) → пустая страница всегда `done:true` → `page.done && 0 !== total` → `dm_conversations_partial_page_guard` (`:538-552`) рестартует sweep ДО транзакции: ничего не скрыто, чекпоинт не completed, chunk бросает → лестница ретраев `pageSyncRetryBackoffMs` (60 с ×2, cap 30 мин). Guard тут не нужен. |
| #154: «`countPageDmVisibleThreadsBelowGeneration` shares the where-clause» | подтверждено текстуально | `page-dm.ts:262-264` ≡ `:289-291`; общей константы нет (находка 4). |
| #157 / D277: «old debts survive newer heads» | подтверждено | `fansly-dm-head-debt.ts:7-22`: PK `(conversation_id, message_id)`, `on conflict do nothing`; новая голова = новая строка. |
| #157: «exact ID receipts replace successful-attempt timestamps» | подтверждено | `:26-36` captured только при exact non-deleted row; `page-dm.ts:979` `resolveCapturedFanslyDmHeads` до prune (`:981-987`); при `includeHeadDebt` legacy-предикат по `last_message_sync_at` заменён debt-предикатом (`page-dm.ts:1091-1095`). |
| #157: «five unconfirmed attempts retain explicit exhausted state», backoff 1m/5m/15m/1h | подтверждено | `:40-58` (`attempts<5`, case по attempts), CHECK `between 0 and 5` (миграция 0172), view `state='exhausted'`. Побочный эффект — находка 2. |
| #157: «bounded: ≤5 страниц на попытку» | подтверждено | `executor-handlers.ts:3040-3041` `targetAttemptFinished = found ∨ exhausted ∨ cap ∨ pagesRead+1≥5`; receipt `:3076-3082` / `:3183-3194`; парсер отвергает `pagesRead≥5` (`cursor-state.ts` #157 diff). Юниты `sync-handlers.test.ts:5580-5640` pass. Верхняя граница HTTP на один debt: 5 попыток × ≤5 страниц = 25 + дочитка до overlap. |
| #157: «Removing a page from the allowlist abandons its recovery pin at the next chunk» | подтверждено | `:2744-2761` + юнит `:5636`. |
| #157: «`fanslyDmHeadCatchupPageAllowlist` defaults to none» | подтверждено | `packages/shared/src/config-registry.ts:149` default `"none"`, `isPageAllowlisted` fail-closed (`fansly-stream-gate.ts:18-28`). Lilly-2 в коде/конфиге нигде не зашита (grep по `packages/*`, `apps/runtime/src`, миграциям: только комментарий в `fansly-stats.ts:30` и промпт классификатора); canary REPORT (`investigations/fansly-lilly2-head-canary-2026-09-10/REPORT.md`) — все роли `none`, «0 eligible targets», «captured debt 2959 unchanged». Живое значение `config_settings` — вопрос оркестратору. |
| #182: «Postgres cases apply old incoming/outgoing heads and rollback through the real sweep» | подтверждено (код), не прогнано | `tests/fansly-dm-shadow.integration.test.ts:27-72` fixture зовёт реальный `fanslyDmConversationsChunk`, `:167-204` три кейса: assert рядов `page_dm_threads` и ровно 4 list-запросов. Гоняется только nightly/Docker (не в `pnpm check`); гейт `fanslyDmShadowPageAllowlist="shadow"`. |
| #182: «synthetic corpus reproduces the Lora-1 dangling-pointer clearing» | подтверждено как синтетика | `tests/dm-shadow-corpus.test.ts:2` → `scripts/fansly-events/corpus.ts` (`DmShadowCorpusAnalyzer`, чистый анализатор, ни одного `db.`/`delete`/`update`); handler не участвует — упасть от изменений sweep не может. Capture-first не затронут: «clearing» — счётчик в отчёте, не запись в БД. |
| #182: «Application code, policy, provider calls, flags unchanged» | подтверждено | `git show 0a08365f --stat`: docs, investigations, tests только. |
| D320 «Numbered from main e913b7a6, last decision 319» | подтверждено | `docs/decisions.md:12653`. |

## 4. Архитектура

1. **Граница «один writer голов» держится только page-lane'ом, не схемой.** Для Fansly `upsertPageDmConversation` намеренно без `headForwardOnly` (`page-dm.ts:137-143`), т.е. любой второй писатель — регресс. Сегодня писатели `page_dm_threads`: sweep (`:975`), full-row write-back в dm_messages (`executor-handlers.ts:2956`, находка 3), `refreshPageDmConversationWindow(rebuildHeadForDeletedMessageId)` — только OFAPI (`ofapi-dm-projection.ts:377-381`), `finalizePageDmConversationMessageSync` головы не трогает (`page-dm.ts:990-1004`), erasure — санкционированный delete. Перед A1 (socket-writer) write-back (3) надо убрать, иначе инвариант ломается первым же событием.
2. **Head-debt — вторая политика выбора треда, а не надстройка.** При allowlist предикат `staleHeadMismatchSql` целиком подменяется debt-предикатом (`page-dm.ts:1091-1101`), а в sweep `shouldRequestDmMessagesFollowup(…, headDebtDue)` возвращает override, минуя `pending_backfill`-ветку (`:225`). Две политики с разными фильтрами (`attempts<5` есть в одной ветке, нет в другой) — источник находки 2. Лучше один SQL-селектор «eligible debt» (view/функция) и использовать его в трёх местах (`selectNext…`, `nextFanslyDmHeadRetryAt`, `hasUnresolvedFanslyDmHead`).
3. **dm_messages при allowlist никогда не «успешен».** `executor-handlers.ts:3280-3289`: пока есть debt с `attempts<5`, chunk возвращает `satisfied:false`, `continuationRetryAt=max(retryAt, now+60s)`; `succeeded_at` стрима заморожен на всё время активации; freshness SLA у dm_messages `null` (`page-sync.ts:264-274`), так что алерта нет, но операторская картина «стрим не завершался N часов» — ложная тревога. Это спекулятивный fallback: «пусть планировщик будит нас каждую минуту, вдруг что-то стало due».
4. **Guard'ы дублируют предикаты текстом.** Empty-sweep guard vs destructive pass (`page-dm.ts:262-264`/`289-291`), legacy-streak vs full diff (`LEGACY_UNCHANGED_PAGE_REASONS`) — второе оформлено константой (хорошо), первое — нет.
5. **Прод живёт на release-коммитах с незамерженной веткой** (находка 1): для лейна это значит, что «прод = main + hardening», и любой аудит main занижает реальную защищённость прода, а деплой main её снимает.

## 5. Что прогнал

```
cd /Users/dmitriy/code/goose/.worktrees/hub-audit-20260914
pnpm exec vitest run tests/fansly-dm-head-diff.test.ts tests/dm-conversation-cursor-state.test.ts tests/dm-shadow-corpus.test.ts tests/dm-shadow.test.ts
  Test Files  4 passed (4)   Tests  97 passed (97)   Duration 2.98s   EXIT=0
pnpm exec vitest run tests/sync-handlers.test.ts
  Test Files  1 passed (1)   Tests  76 passed (76)   Duration 4.29s   EXIT=0
```
Дифы: `git show 130150ac^:…executor-handlers.ts` (2783-3716) vs `130150ac:…fansly-dm-conversations.ts` через `diff -w -u`; `git show f448ffec/93f50bd6/0a08365f -- <scope files>`; `git diff 380326368f origin/main -- apps/runtime/src/services/sync/ packages/db/src/repositories/` (+24/−249, 10 файлов); `git branch -a --contains c1e0b15e`, `git merge-base --is-ancestor c1e0b15e origin/main` → no. Временных тест-файлов не создавал.

## 6. Не проверено и почему

- Integration-сюиты (`fansly-dm-conversations-sweep` 10, `fansly-dm-shadow` 7, head-debt 66) — Docker/Testcontainers запрещены брифом; заявленные в PR прогоны — исторические (`validation.json` #182: 26 passed на `e913b7a6`).
- Находка 2 — SQL-путь прослежен, не воспроизведён на Postgres.
- Живые значения `fanslyDmHeadCatchupPageAllowlist` / `fanslyDmShadowPageAllowlist` (`config_settings` не в read_only-списке).
- `strictness-ratchet` / `check-platform-branches` / `retention-deleters` — не гонял полный suite; по `--stat` четырёх merge-коммитов эти пины не тронуты.

### Запросы к оркестратору (read_only)

1. Разрез `dm_messages` по producer (head-repair sweep'а vs walk истории), page 4/5, по UTC-дням и часам 09-12:
```sql
select (o.received_at at time zone 'UTC')::date as day, o.account_id, o.producer, count(*)
from observations o
where o.source = 'pull' and o.kind = 'dm_messages' and o.account_id in (4,5)
  and o.received_at >= '2026-09-04' and o.received_at < '2026-09-14'
group by 1,2,3 order by 1,2,3;

select date_trunc('hour', o.received_at at time zone 'UTC') as hour_utc, o.account_id, o.producer, count(*)
from observations o
where o.source = 'pull' and o.kind = 'dm_messages'
  and o.received_at >= '2026-09-12' and o.received_at < '2026-09-13'
group by 1,2,3 order by 1,2,3;
```
Ожидаемые producer: `sync:fansly:dm_conversations` (limit-1 head repair из sweep, `fansly-dm-conversations.ts:735-747`), `sync:fansly:dm_messages` (walk chunk'а и targeted backfill, `targeted-thread-backfill.ts:560-562`).
2. Состояние стримов страниц 4/5 (без request_seq/retry_at):
```sql
select page_id, stream, status, dispatch_source, phase, work_class, progress, progressed_at, succeeded_at, failed_at, enqueued_at, updated_at
from page_sync_states where page_id in (4,5) and stream in ('dm_messages','dm_conversations');
```
3. Подтвердить через дашборд/API (не SQL): `fanslyDmHeadCatchupPageAllowlist` и `fanslyDmShadowPageAllowlist` на всех трёх ролях.
4. Совпадает ли egress key (прокси) у lilly-1 и lilly-2 — это делит между ними один лимит `dm_messages` (5 с).

## 7. Ответ координатору: ровный поток ~300/час `dm_messages` на lilly-2

**(1) Механизм в main — обычный chunk-цикл history-стрима при непустой очереди кандидатов, не head-debt и не replay.**

- Стрим `dm_messages`: chunk = `SyncChunkBudget(maxRequests=5, maxWallClockMs=45_000)` (`chunk-budget.ts:10-11`); каждый `/message` — одна HTTP-попытка и ровно одна observation `source='pull', kind='dm_messages'` (`fansly-dm-messages.ts:219-244` → `persistRawPayload` → `insertObservation`, producer `sync:fansly:<stream>`).
- Темп: каждый запрос ждёт общие scope'ы `global` (2 500+100 мс) и `dm_messages` (floor 5 000 мс: `config.ts:11,617`, `rate-limiter.ts:88-91`, `adapter.ts:2238-2248`) на egress key → потолок 12 req/мин = 720/ч на прокси на все страницы, что его делят.
- После 5 запросов chunk отдаёт `satisfied:false, yieldReason:"request_budget"` (`executor-handlers.ts:3208-3223`); `yieldPageSync` ставит `pending`, `retry_at=null` (`page-sync.ts:2505-2557`); `resolveContinuationPriority` видит страницу runnable → немедленный wakeup следующего chunk'а (`executor.ts:814-828`, `1121-1128`), планировщик (`* * * * *`, `sync-queue.ts:241`) — лишь страховка. Итого ~5 запросов / (25 с ожиданий + накладные: run, lease, telemetry, SQL кандидата) ≈ 5–6/мин при монопольном прокси; наблюдаемые 5/мин = 12 с/запрос — ровно этот режим с учётом того, что page-lane один на страницу (`listRunnablePageSync` группирует по page) и `dm_conversations` (cadence 1800 с, priority 30 > 25) периодически перебивает.
- Кандидат при allowlist `none` (`includeHeadDebt` не передаётся: `executor-handlers.ts:2806-2810`) — legacy-предикат `page-dm.ts:1095-1101,1151-1158`: `last_message_id ≠ newest_stored_message_id AND (sync_at IS NULL OR sync_at < last_message_at)` ИЛИ `pending_backfill`. На тред обычно 1 запрос (incremental — 25 сообщений до overlap; backfill — 1 страница, cap 25 → `partial_window`, `fansly-dm-messages.ts:39-62`, `PAGE_DM_LIVE_BACKFILL_CAP=25`). 4 013 запросов за 09-12 ≈ 4 000 проходов по тредам.
- Стрим «успешен» (`succeeded_at`, `upsertCheckpoint`) только когда кандидатов нет (`exhaustedEligibleConversations`, `:3291-3303`); дальше cadence 86 400 с ПЛЮС follow-up от sweep'а на каждую сдвинувшуюся голову (`fansly-dm-conversations.ts:1234-1240`). Поэтому поток «ровный, пока очередь не пуста» и обрывается, когда `selectNextPageDmMessageSyncCandidate` возвращает `null` (на lilly-2 это случилось 09-13 20:28 — `succeeded_at`).
- Что это НЕ: head-debt recovery (#157) — выключен allowlist'ом; canary «0 eligible»; replay #158/#159 — только БД (`services/canonicalize*` не трогает `app.adapter`); deep backfill — default off (`config-registry.ts:150`); единственные сетевые читатели `/message` — head repair sweep'а (`fansly-dm-conversations.ts:726`, limit 1) и `fetchAndJournalFanslyDmMessagePage`. Head repair тоже журналируется как `kind='dm_messages'` — его долю выделит запрос по `producer` (п. 1 запросов).

Оценка в запросах/сутки: без дневного потолка — только temp-лимит scope'а: 720/ч → 17 280/сутки на прокси (теоретический cap). Наблюдаемые 300/ч × 8 ч = ~2 400 — длина очереди кандидатов, не лимит.

**(2) Всплеск 09-07 (до #157).** Тот же путь: legacy-ветка `selectNextPageDmMessageSyncCandidate` в #157 не менялась (diff `93f50bd6` добавляет только `includeHeadDebt`-вариант). Триггеры одинаковы: (а) массовый follow-up после sweep'а, где у многих тредов сдвинулись `last_message_id/last_message_at`; (б) reset/recovery стрима после деплоя/рестарта (`ensurePageSyncStates` сеет `recovery`). Что именно 09-07 — по коду не доказать; разрез по producer/часам (запрос 1) и `dispatch_source` (запрос 2) отделит одно от другого.

**(3) Дневного бюджета у dm_messages нет.** Есть только: chunk 5/45 с, spacing 5 с на egress key, `page_dm_message_sync_health` circuit breaker на тред (`page-dm.ts:1141-1150`), `PAGE_DM_LIVE_BACKFILL_CAP=25` на тред, и `fanslyDmDeepBackfillMaxRequestsPerRun=1` — но только для deep backfill (off). Почему не видно как «экономия»: A0-измерение (`fansly_events_measurement_report`, `dm-shadow.ts`) считает list-walk `dm_conversations` (страницы ниже stop, байты) и `missingHotHeads`; walk истории и head repair в нём не участвуют, а head repair к тому же лежит в `kind='dm_messages'`, т.е. в «истории», хотя порождён list-sweep'ом. Экономия от A0/A1 должна проявиться в `kind='dm_conversations'` и в `producer='sync:fansly:dm_conversations'` внутри `dm_messages`, а не в объёме walk'а истории — тот определяется числом stale-тредов, а не частотой опроса.

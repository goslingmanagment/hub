# Fansly data-plane sync audit — 2026-09-13

**Вывод:** алгоритм нельзя считать полностью корректным. В текущем коде воспроизведены пять дефектов: незавершаемый retry backfill транзакций, ошибочное выключение подписки при дрейфе offset-списка, ложное завершение DM history после split-commit replay, отсутствие обновления purchase history уже известного media и неработающий детектор повторных страниц earnings stats.

Исследован HEAD `b48f173d` в `/Users/dmitriy/code/goose/hub`. Родительский аудит независимо определил production revision `4310680dc2f923955295f85491eb6cf43d9bb82a`. `git diff` этих ревизий подтвердил одинаковую бизнес-логику пяти findings: различия executor-handlers затрагивают follower telemetry, не subscriber/DM/purchase; transactions, DM helper, stats и purchase parser не различаются. Adapter на production дополнительно имеет отменяемые waits; эту разницу нельзя приписывать всем Fansly путям.

**Это доказательства дефектов кода и воспроизводимых последствий на синтетических данных. Они не доказывают, что перечисленные потери уже случились в production.** Production DB и provider в рамках этого подаудита не изменялись и не опрашивались. Ограниченный live-снимок и его пределы приведены в родительском отчете.

## Метод и артефакты

Прочитаны CLAUDE.md, quick reference решений, Stage 16/17. Пройдены фактические DM/follower/subscriber/transaction control paths, связанные DB selectors/finalizers, purchase-history discovery/classifier, части stats/catalog и общий Fansly request path. Проверка не ограничивалась старыми спецификациями: они описывают несколько уже замененных реализаций.

- `reproduce.mjs` извлекает реальные функции из текущих TypeScript файлов через TypeScript AST, транспилирует и запускает в VM. IO заменен in-memory doubles; чистые вычисления и ветвления handler'ов не переписаны.
- `reproduction-results.json` содержит результаты всех пяти probes. Запуск: `node investigations/sync-algorithm-audit-2026-09-13/fansly/reproduce.mjs` из корня repo.
- F1/F2/F4/F5 исполняют реальные handler/function bodies. F3 исполняет реальный DM fetch+coverage helper с достижимым состоянием split commit; полный executor crash/restart в DB не моделировался.
- Vitest не запускался этим агентом, чтобы не конкурировать с единым запуском родительского агента. Продуктовый код не менялся.

## Подтвержденные дефекты

### F1 — P1: новая транзакция навсегда инвалидирует продолжение initial backfill

**Где:** `apps/runtime/src/services/sync/transactions.ts:1201` запрос без временных границ; `:1247–1264` сравнение total с замороженным значением; `:1326–1336` сохранение offset/total; `:1415–1436` catch; `:465–488` flush; `:1512–1516` повторный выбор сохраненного backfill.

**Цепочка:** первый chunk сохраняет `providerReportedTotal=200, offset=100`. Между chunks приходит новая продажа, total становится 201. Следующий запрос старого offset возвращает 201; handler отказывается продолжать. Это правильно как отказ от несогласованного snapshot, но catch только перестраивает dirty projections и очищает `dirtyFrom`. Он не инвалидирует offset/generation/total. Все следующие retries снова загружают total=200 и offset=100. Если реальный total не вернется к 200, stream не сможет закончить самостоятельно.

`state.snapshotEnd` существует, но провайдеру не отправляется, поэтому не замораживает snapshot. Это осознанный способ запроса после проблем с Fansly date bounds; просто добавить `before=snapshotEnd` без повторного подтверждения контракта нельзя.

**Воспроизведение:** реальный `syncTransactionsBackfill` на трех retries запросил `[100,100,100]`, трижды выбросил `total changed`, не записал ни одного исправленного checkpoint. Состояние имеет `dirtyFrom=null`; при непустом dirty поле flush лишь сохранит тот же offset/total с очищенным dirty.

**Влияние:** блокируется первичная/принудительная загрузка финансовой истории и дальнейшее достижение нормального incremental режима. Raw страницы уже захвачены; это не разрушение ранее записанных транзакций.

**Исправление:**

1. Минимальный recovery: общий typed snapshot-invalidated результат для incremental и backfill; при total drift/offset overlap инвалидировать только прогресс нестабильного прохода, сохранять уже захваченные факты и историю ошибки; новый retry стартует с головы. Incremental уже использует такой pattern (`safelyInvalidateFanslyIncrementalProgress`). Ограничить подряд restart count, не превращать busy account в бесконечный head rescan.
2. Основное улучшение: определить контракт обхода изменяемого offset списка. Если provider подтвердит snapshot/cursor API — использовать его. Иначе хранить anchor первой страницы и фактические уникальные IDs/страницы, явно обрабатывать insert-at-head и повторное наложение; отделить «история до якоря собрана» от свежего head reconciliation. Простого совпадения общего total недостаточно.
3. Repair existing checkpoint только для подтвержденного `backfill_total_changed/backfill_offset_overlap`, через предусмотренный reset/restart workflow с сохранением raw и audit evidence.

**Валидация:** многократные restart после прихода 1/N транзакций; crash после captured page/после checkpoint; возврат provider total к прежнему; overlap при неизменном total; отсутствие дубликатов финансовых фактов; ограниченное число повторных запросов и достижение terminal history.

### F2 — P1: subscriber reconciliation принимает raw count за доказательство membership

**Где:** `apps/runtime/src/services/sync/executor-handlers.ts:1493–1503` cumulative count; `:1514` terminal check; `:1590–1598` destructive finalization; `packages/db/src/repositories/fans.ts:1081–1105` deactivation SQL.

**Цепочка:** provider total=200. Page 0 содержит IDs 1..100. Между запросами порядок/состав списка меняется; page offset100 содержит [100,102..200]. Raw строк по-прежнему 200, уникальных подписок 199, отсутствует активная 101. Handler сравнивает 200 с 200 и допускает `deactivatePageSubscriptionsByGeneration`. ID101 не имеет текущего generation и становится `is_current=false`. SQL не проверяет, что generation воспроизвел distinct set. Существующий `lastSeenBefore` guard в repository здесь не передается.

**Воспроизведение:** реальный `fanslySubscribersChunk` вернул `satisfied:true`, вызвал finalization; in-memory IO model выключил subscription101. SQL predicate независимо проверен: `is_current=true AND (last_seen_generation IS NULL OR last_seen_generation < generation)` соответствует этому исходу.

**Влияние:** ложное исчезновение активного подписчика/подписки и неверные производные subscriber counts/CRM state. Следующий успешный полный sweep может восстановить состояние; это не доказательство списания/потери денег.

**Исправление:** перенести уже существующую строгую проверку из `dm_conversations`: within-page duplicates, cross-page generation overlap, count distinct generation в той же transaction, проверка provider total/дрейфа; после mismatch новый generation без destructive finalization. Добавить sweep-start fence и небольшую проверку blast radius по аналогии с followers. Для истинного перехода к нулю нужна отдельная подтверждаемая процедура: текущий empty-first-page guard иначе не даст законно очистить последний subscriber.

**Валидация:** stable 200/200; duplicate+omission200/199; within-page duplicate; изменение total; тот же fan с двумя различными subscription IDs; создание/обновление subscription другим writer во время sweep; true-zero after prior subscriptions; crash/resume. При недоказанном membership подписки сохраняются и completeness не продвигается.

### F3 — P1: DM deep history становится complete после повторной страницы, хотя provider не исчерпан

**Где:** `apps/runtime/src/services/sync/fansly-dm-messages.ts:39–55` любое overlap=>complete; `:257–263` overlap по существующим message IDs. `executor-handlers.ts:2852` выбор before из сохраненной summary; `:3030–3036` deep завершается после одной страницы; `:3060–3074` message upsert и finalize в разных transactions; `:3100–3139` debt и очистка pin; `packages/db/src/repositories/page-dm.ts:1238–1258` deep selector только partial_window; `apps/runtime/src/services/projection-debt-sweep.ts:69–77` repair сохраняет текущий coverage status.

**Достижимое состояние:** summary.oldestStored=200, coverage=partial_window. Deep запрос before200 приносит199..175, provider.done=false. Message upsert успешно commits. Процесс падает до finalize либо finalize падает и создается projection debt; summary остается old=200. До summary repair следующая попытка снова делает before200. Все25 IDs уже есть, overlap=true. Coverage helper возвращает complete, хотя IDs1..174 все еще не собраны. Completed conversations исключаются из deep selector. Debt sweep не исправляет coverage: намеренно сохраняет его текущее значение.

**Воспроизведение:** реальные shared fetch+coverage functions получили replay199..175 при provider.done=false и присвоили complete. Это узкий проверенный counterexample с источниками достижимого crash window, а не полная DB fault-injection проверка.

**Корень:** наличие любого знакомого сообщения означает лишь пересечение с известным фрагментом. Оно не доказывает, что ниже него уже существует непрерывная полная история. Split commit делает этот случай обычным recovery-сценарием.

**Исправление:**

1. Для deep_backfill `complete` только при provider exhaustion либо при встрече с отдельно доказанным непрерывным интервалом, ведущим к provider floor. Сам по себе overlap не должен закрывать историю.
2. Хранить lower bound/provider cursor и доказательство завершения history как durable operational state в transaction с записью страницы. Summary hot-cache count/oldest не должна определять единственный restart cursor.
3. Debt row должна нести намерение завершения/cursor advance либо replay должен безопасно повторять страницу, сохраняя partial до исчерпания. Оставить failure isolation: неисправная projection не должна блокировать capture всего stream.
4. Для уже complete conversations проверять наличие terminal raw response/proof; неопределенные переоткрывать ограниченным audit/recovery проходом, не обнуляя архив.

**Валидация:** injected crash между upsert и finalize, injected finalize failure, debt repair до/после следующего fetch, sparse known history, полная повторная страница, включенный prune, provider short/empty terminal page. Завершение требует evidence, число уже сохраненных сообщений не является evidence.

### F4 — P2: purchase_history один раз закрывает media и больше никогда не обновляет его покупателей

**Где:** `executor-handlers.ts:3406–3420` все исторические captures строят вечный dedupe; `:3532–3545` new transaction target отбрасывается по capturedTargetKeys/capturedContentIds; `:3615–3635` та же фильтрация raw DM discovery. `fansly-purchase-history.ts:508–564` empty page считается terminal; `packages/db/src/repositories/sync.ts:595–637` список captures не имеет age/generation.

**Цепочка:** ранее проверенный media-1 не имел покупателей; есть terminal_empty capture. Позже новая captured transaction с ID11 относится к media-1. Discovery определяет корректный media target, но глобальный captured-key set удаляет его. Checkpoint transactionCursor продвигается с10 на11 и stream завершается без нового запроса. Аналогично происходит для media с уже непустой историей и новых покупателей после завершенного обхода.

**Воспроизведение:** реальный `executePurchaseHistoryChunk`, реальные target-extractor и chain classifier: ранее terminal_empty + новая transaction11 => `purchaseHistoryRequests:0`, cursor11, `satisfied:true`.

**Влияние:** новые buyer/order facts не появляются из этого stream. Финансовая transaction уже захвачена; inline DM orders/notifications могут независимо заполнить часть событий. Нельзя называть это потерей всех PPV purchases во всем Hub, но lifetime target dedupe не реализует обещанное incremental refresh purchase history.

**Исправление:** разделить immutable capture identity (`target,generation,requestBefore`) и refresh eligibility. Новая purchase transaction с ID/updatedAt позже watermark target помечает media dirty; новый bounded head walk идет до уже известных order IDs, не перечитывая всю историю каждый раз. Хранить per-target generation, lastHeadCapturedAt, transaction watermark и known order boundary. Coalesce несколько sales одного media в один refresh. Старый404/410 — evidence исхода на тот момент; решение о будущих retries не должно скрываться в вечном dedupe.

**Валидация:** empty=>first sale; second buyer same media; multiple sales coalesced; shared media/bundle ID conflict; crashed head walk; complete historical tail+new head; counters финансовых facts не меняются из-за повторного capture.

### F5 — P2: earnings stats «repeat cursor guard» не ловит игнорирование offset

**Где:** `apps/runtime/src/services/sync/fansly-stats.ts:1701–1743`, особенно сравнение `earningsPreviousOffset===offset` на1709 и запись `{earningsOffset:offset+100, earningsPreviousOffset:offset}` на1739. Daily-cap deferral сохраняет тот же step на `:1619–1630`, terminal incomplete result `:1892–1913`.

**Цепочка:** provider возвращает одну и ту же полную100-row страницу независимо от offset. Локальные offsets всегда растут0,100,200…; previousOffset всегда на100 меньше текущего. Поэтому предназначенная для этого случая проверка никогда не срабатывает. Daily cap защищает от бесконечных запросов в один день, но завтра stream продолжит тот же ошибочный обход, тратя cap и не доходя до monthly/tracking/broadcast и других последующих steps. День sweep также не завершится.

**Воспроизведение:** реальный `fanslyStatsSnapshotChunk` запущен на два UTC дня с уменьшенным cap3: offsets `[0,100,200,300,400,500]`, шесть одинаковых ответов, ноль repeat anomalies, оба дня cap исчерпан, финальный stepIndex=2. Это условие provider drift, а не утверждение, что текущий live provider уже игнорирует offset.

**Исправление:** после capture сравнивать страницу с предыдущим set/fingerprint на основе стабильных row keys/window, проверять forward progress/count; на повторе завершать лишь подзадачу как `partial_provider_surface` и продолжать другие независимые steps с durable blocker. Freeze window bounds для всех страниц одного sweep: сейчас новый chunk вычисляет now/after заново при прежнем offset. Валидировать response shape до `rowCount`, иначе незнакомый object без массива превращается в0 и выглядит как terminal.

**Валидация:** ignore-offset100rows; повтор через две страницы; действующие distinct страницы100/100/7; malformed shape; midnight continuation с фиксированными bounds; repeated response не продвигает successful coverage и не расходует каждый следующий день целиком.

## Граница подтвержденных findings и дополнительных рисков

- **Adapter capture boundary:** `packages/fansly/src/adapter.ts:2164` вызывает `summarizeResponse` до возврата raw handler'у. Например DM callback `:1237–1240` обращается к `parsed.messages.length` без runtime shape guard. Envelope `{success:true,response:{...unexpected...}}` может выбросить TypeError до `fetchAndJournalFanslyDmMessagePage` и его `persistRawPayload`. Это установленный по исходникам риск полноты capture при drift, но полный adapter/http-executor injected-response probe здесь не выполнен. Следующий тест должен проверить именно сохранность полного тела, а не только400-char diagnostic snippet. Исправление — небросающий shape summary и raw custody до validation; generic signature `<T>` не является runtime validation.
- **Legacy DM head mode:** при `fanslyDmHeadCatchupPageAllowlist=none` применяется старое условие `lastMessageSyncAt < lastMessageAt` (`fansly-dm-conversations.ts:207–236`, `page-dm.ts:1093–1105`). HTTP success с missing exact head может снять eligibility; исправленный exact-ID debt путь существует, но gated. Default=none (`packages/shared/src/config.ts:102`). Нельзя утверждать состояние live allowlist без live config. Отчет должен отдельно показать rollout этого исправления и unresolved/exhausted debt count.
- **Empty histories:** subscribers empty-first-page guard защищает от массового false removal, но при реальном уходе последнего подписчика будет удерживать устаревшее состояние и retries. Нужен honest explicit zero confirmation protocol, не удаление guard.
- **Fan earnings rejection:** `fan-earnings.ts:109–138` намеренно останавливает весь keyset prefix на первой400/404/410. Сохранность хорошая, но один постоянно недоступный spender может остановить refresh всех следующих. Улучшать через отдельную durable per-subject очередь/debt, сохраняя факт неполноты; нельзя просто continue и объявить complete.
- **Stats floor inference:** отдельные исторические lanes трактуют серию пустых окон и один дальний probe как exhaustion (`fansly-stats.ts:1520–1545`). Пустые периоды доказывают неактивность в этих окнах, не отсутствие более старой активности. Для исторической полноты предпочтителен account-created floor или честный `partial`; в этом подаудите это не включено в число пяти function-reproduced bugs.

## Покрытие проверки и сильные стороны

| Участок | Что реально проверено | Вывод / ограничения |
|---|---|---|
| Transactions | Full incremental/backfill flow, checkpoint cleanup, DB write path, adapter bounds, targeted tests as source | F1. Incremental уже имеет snapshot invalidation; raw-before-domain-write и writer gate сохранены. Повторное получение не равно двойному начислению. |
| Subscribers | Полный handler, generation deactivation SQL, hydration fallbacks | F2; destructive proof слабее DM/followers. |
| Followers incremental/reconcile | Полные core loops, generation verification, restart/non-destructive close, metadata observer | Сильнее subscribers: row-side generation count, terminal count, blast-radius limit, lastSeenBefore. Неполный sweep явно может закрываться non-destructively; health не должен выдавать это за certified membership. |
| DM conversations | Generation/overlap/total guards, list-head debt, finalization | Duplicate guards и exact row-side count хорошие; unknown-total не разрешает hiding. Проверка count не является неизменяемым provider snapshot при churn. |
| DM messages/deep | Полный selection/pinning/finalize/debt flow, shared fetch+coverage, DB selectors | F3; exact-ID head-debt улучшает freshness, но historical completeness отдельна. |
| Purchase history | Полный handler, target chains/parser, SQL captured index | F4. Хорошие guards на malformed/cyclic cursors, journal-before-checkpoint, media-scoped запросы вместо fan×media. |
| Stats snapshot | Основной orchestration, steady steps, window/month guards, portions historical earnings | F5; other lanes используют полезные served-window/retry narrowing и durable daily budgets. Исторические floor heuristics требуют честной маркировки. |
| Catalog/vault | State reopen, album loop, repeat/page caps, inventory proof, terminal coverage | Хорошо отделены provider_exhausted и partial; weekly rewalk делает edits/membership eventually observable. Не полный end-to-end catalog projection audit. |
| Fan earnings/media stats | Capture flow и policy/queue architecture, rejection/fairness rules | Per-fan2call capture и per-media decay снижают fan×media cost. Исчерпывающий аудит projection/watermarks не заявляется. |
| Notifications/payouts/replies | Инвентаризация файлов, общий lane/adapter механизм | Специальные algorithms этих трех streams подробно не проверялись этим подагентом; полноту не сертифицирую. |
| Adapter | Transactions/subscribers/followers/DM pagination, request/retry/proxy path, prod diff | Fail-closed proxy, terminal auth, Retry-After deadline separation хорошие. Runtime shape/capture seam требует adversarial test. |

## Оптимизации с измеримым эффектом

1. **Материализовать purchase target state вместо чтения всех raw captures на каждый chunk.** Сейчас `listFanslyPurchaseHistoryCaptures` загружает весь lifetime body corpus, затем `Promise.all(resolveRawCapturePayloadRow)` разворачивает все CAS references (`executor-handlers.ts:3406`). При N captures каждый из C chunks стоит O(N) reads/parsing, часто с N одновременными lookups. Сделать bounded keyset reconcile ledger→operational per-target state, хранить high-water и parser version; raw остается источником восстановления. Эффект измерять DB reads/CPU/RSS/chunk и одинаковым классификационным результатом на golden corpus.
2. **Один запрос для DM summary вместо повторного полного window ranking.** `getPageDmMessageWindowSummary` (`page-dm.ts:789–824`) считает два row_number по всем сообщениям при каждом finalize, deep проходит по25. Для n history это может наращивать повторную работу примерно как сумму25+50+…+n, то есть O(n²/25) просматриваемых rows на полный backfill. Использовать индексированный oldest/newest lookup + incremental count на inserted rows либо bounded batch finalize, оставив периодический точный recount и корректность edits/deletes. Сначала EXPLAIN ANALYZE на фактическом объеме; не объявлять фактическую latency без измерения.
3. **Per-subject fairness/debt вместо stream-wide poison item.** В fan earnings/purchase один неисправимый subject блокирует хвост. Создать маленькую durable очередь retries/exhausted с явным coverage debt, держать freshness healthy subjects; reuse existing subject_refresh_state и per-conversation breaker discipline вместо новой независимой scheduler системы.
4. **Измерять полезный capture throughput, а не HTTP200.** В каждом stream: fetched unique facts, duplicate pages, known-head debt, terminal-proof age, unresolved history ranges, requests per new fact, raw bytes per new fact, per-target wait age. `satisfied` означает законченный dispatch intent; не использовать как universal completeness.
5. **Budget учитывать фактические вызовы метаданных.** `executeFollowersChunk:1729`, initial followers reconcile metadata идут через `refreshPageMetadata` без переданного budget observer; helper `shared.ts:626` использует telemetry-only observer. Follow-up terminal refresh budget передает. Сделать budget observer неизбежным в executor-owned fetch path, а двухвызовные hydrate units заранее резервировать. Это улучшение предсказуемости fairness; строгий egress limiter все равно остается основным ограничителем.
6. **Не оптимизировать за счет сокращения REST reconciliation до доказанной замены.** Exact head receipt не доказывает edit/delete/history coverage. Для более редких list sweeps нужны измеренные event transport gaps/replay proofs и отдельный periodic full-reconcile cadence.

## Рекомендуемый порядок работ

1. Исправить F1/F2/F3 с regression probes, особенно destructive reconciliation и crash windows. Держать изменения небольшими и отдельно измерять recovery/coverage.
2. Исправить F4/F5: per-target generation/dirty refresh и semantic page-progress guards. Не поднимать budgets, чтобы компенсировать алгоритмический loop.
3. Исполнить adapter malformed-success body custody test и legacy head allowlist audit.
4. После correctness — убрать lifetime raw scan из chunk hot path, измерить DM summary cost и per-subject fairness. Для каждой оптимизации сравнить canonical facts и completeness proofs до/после на retained corpus.

## Memory provenance

Память использована как указатель на старое расследование stale-head, а не как источник текущих production чисел: `MEMORY.md:858–868`, rollout `01a07eaf-1e8e-77e0-b551-4c26b5806852`. Все утверждения о текущем коде сверены с checkout.

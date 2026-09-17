# Canonicalization: две возможности с проверенным путём исполнения

Проверены `main@b48f173d` и production `74aac5093cfc` из `production-revision.txt`. Обе возможности присутствуют в обеих ревизиях. **Сначала убрать глобальную диагностику из exact canonicalization; затем ускорить повторные mixed batches через положительные dedup-ответы.** Продуктовый код не изменялся.

## 04-A — P2: exact receipt выполняет глобальную проверку и переписывает recovery tombstone

**Путь.** `runPostSettleOfapiProjections` → `runCanonicalization({observationId,kinds})` в `apps/runtime/src/services/ofapi-events.ts:127–130`; аналогично recovery `ofapi-webhook-recovery.ts:241` и каждый read collection response `ofapi-collection-runner.ts:182`. До выборки observation driver безусловно загружает все pages и все исторические OFAPI bindings и сообщает состояние глобального incident: main `canonicalize-driver.ts:732–766`, production `:803–837`.

Два запроса: `packages/db/src/repositories/catalog.ts:342–357` без WHERE; `ofapi-bindings.ts:165–170` по всему журналу привязок. При отсутствии конфликтов `notification-incidents.ts:443–478,778–793` вызывает `recoverAndResolveNotificationIncident`: отдельная транзакция, глобальный advisory lock, **безусловный** upsert `notification_incident_recoveries`, затем conditional UPDATE incident (`notifications.ts:505–528,561–608`). Отсутствие открытого incident не отменяет tombstone write. Это нужная защита от запоздалого открытия incident, но она повторяется с частотой canonicalization.

**Доказательство.** [probe.mjs](probe.mjs) исполняет настоящие driver и recovery-функции обеих ревизий с fake DB. Даже `scanned=0` даёт последовательность: две глобальные выборки → BEGIN → advisory lock → recovery upsert → incident UPDATE → COMMIT → exact SELECT. Есть отдельный успешный candidate case. SQL recovery lock действительно сгенерирован Drizzle; insert/update учитывались fake query builder. Результат: [probe-results.json](probe-results.json), `context`.

**Цена.** При Q exact-запусках: `2Q` глобальных SELECT, передача/сборка `Q(P+H)` строк, `Q` транзакций по одному incident key и `Q` recovery rewrites плюс `Q` условных UPDATE. P — страницы, H — retained bindings. Это пять SQL перед самой выборкой кандидата, без BEGIN/COMMIT; сериализация по incident key общая для разных accounts. Q=10 000 — условный пример: 50 000 SQL и 10 000 переписей tombstone; это не измеренный production volume.

**Изменение.** Сначала выбрать кандидата и семью; контекст получать лениво. Для accountId-known/context-free collection family карта не нужна. Для exact webhook после parse разрешать только его captured native ref; для `data_exports.*` — полный список account_ids из body. Узкий resolver обязан учитывать текущие **и исторические** claims и карантин конфликтов. Нельзя подменить это только текущим active binding.

Полный census и глобальное open/recovery оставить у обычного sweep; narrow path никогда не объявляет глобальное recovery. Обнаруженный локально конфликт оставляет observation unstamped и может инициировать полный census через существующий sweep. Не вводить TTL/process cache. Такая граница сохраняет авторитет tombstone и его защиту от delayed opens; недостаточно просто пропустить UPDATE «если incident отсутствует».

**Выигрыш и цена.** На пустом exact call/context-free collection устраняются все пять подготовительных SQL и recovery WAL; webhook меняет fleet hydration на targeted lookup. Ускорение всего receipt зависит от доли operational projections; её не измеряли. Размер: средний, около 1–2 дней реализации/проверок. При малом Q и восьми страницах экономия fleet rows мала; наиболее конкретная выгода — убрать транзакцию и глобальный lock на каждый receipt.

**Приёмка.** Already-stamped exact receipt не пишет recovery; known-account collection не читает binding corpus; webhook со старым binding сохраняет account attribution; конфликт, team export с неизвестным account, исправление привязки, concurrent delayed incident open. Sweep продолжает закрывать глобальный conflict. Capture-first, raw body/read seam, erasure/material checks, parse stamp и cursor CAS не меняются. Канарейка: SQL/exact receipt, recovery-table update/WAL rate, время глобального lock, oldest unstamped current receipt и время обнаружения binding conflict.

## 04-B — P2: дешёвый duplicate fast path перед allocation, с сохранением текущего append miss path

**Углубление известного batch append, а не дополнительная независимая экономия поверх него.** Предыдущий аудит предложил групповые allocation/claims/inserts. Здесь проверен меньший шаг: оставить fresh append как есть и удалить работу для уже существующих exact keys.

**Путь.** Driver `canonicalize-driver.ts:634–638` → mixed/projection append; Fansly `sync-pull.ts:171–210` выпускает `message.*` плюс media material из одной DM страницы. `domain-events.ts:288–306,347–421` блокирует account counter, затем **даже duplicate** получает nextval, конфликтный INSERT key и SELECT существующего event_id: три последовательных SQL. Fresh event тоже стоит три SQL. `:424–454` обеспечивает deliverable → hidden → checkpoint, outcomes остаются в input order. Этот код одинаков в main/production.

**Изменение.** Под текущим account lock один ограниченный запрос существующих `(dedup_key,event_id)` для полного набора input keys. Положительные ответы хранить только до commit; пополнять map после успешных resolution/append. Для найденного key вернуть прежний event_id без allocation/claim. На miss выполнять прежний append. Subscription compatibility lookup `:321–342` остаётся **перед** fast path: observation-based correction может владеть другим fan-bearing key; alias не создавать. Checkpoint создавать только по реально вставленным hidden rows, прежний конфликт checkpoint сохраняет rollback.

**Erasure — обязательное условие.** Account counter сам по себе не гарантирует неизменность keys при fan erasure (`erasure/index.ts:1537–1566`). Положительный map допустим только внутри транзакции, удерживающей существующий shared page writer fence; если caller его не держит — shared try-lock брать **до counter lock**, defer без stamp при отказе. Это ещё один SQL. Сохранять действующие material-time checks; не кешировать тела/отрицательные ответы между observations. До проверки lock order и erasure interleavings оставлять unfenced callers на старом path. Обычный SELECT + process cache небезопасен.

**Доказательство и модель.** Probe исполняет реальную функцию и вариант с минимальным prefetch, вставленным **только в памяти**. По 200 synthetic mixed inputs на каждой ревизии:

| Дубликатов | Сейчас SQL | Prefetch SQL | Identity allocations |
|---|---:|---:|---:|
| 200 | 602 | 3 | 200 → 0 |
| 180 | 607 | 68 | 201 → 21 |
| 0 | 607 | 608 | 201 → 201 |

BEGIN/COMMIT и новый fence не включены; если нужен fence, справа прибавить 1. Совпали appended/deduped, input outcome order, account seq и весь порядок вставленных events. В 90%-duplicate примере checkpoint остаётся `hiddenCount=10`, highWater=221. SQL reduction 88,8% здесь **не означает** такое же снижение CPU/времени всей синхронизации.

При D duplicates экономия `3D−1` SQL, либо `3D−2` с дополнительным fence. Нулевые D стоят лишний запрос и O(N) temporary map; разумный первый scope — replay/DM batches, где измерена высокая duplicate fraction. Выполнять prefetch bounded chunks; размер payload bodies не увеличивать. Не менять dedup-key construction или historical membership: A→B→A с различающимися observation/revision keys обязана давать те же три события, повтор exact keys — прежние outcomes. Проблемы уже существующих content-hash ключей этот fast path не исправляет.

**Размер/приёмка.** Средний, около 1–2 дней плюс concurrency gates. Нужны overlapping appenders, повтор key внутри mixed batch, legacy subscription crash-before-stamp, rollback после key claim, checkpoint collision, A→B→A, erasure до/во время prefetch, пустой и all-new batch. Canary: statements/attempted event, duplicate fraction, counter lock hold p95, WAL/event, highWater gap/checkpoint alarms. Нет изменений HTTP, retry, lease, provider budgets, money units или owner controls.

## Отброшено и ограничения

- Уже deployed: parse-reuse части семей, pending-head probe, bounded CAS prefetch для unmapped webhook waits, раздельный unparsed/replay floor. Не включены в экономию.
- «Не читать тело при unmapped ref» отвергнуто: пустой/отклонённый parse и export account attribution нельзя вывести только из metadata; изменится stamp/retry семантика.
- Полностью убрать subscription observation probe отвергнуто: теряется compatibility после identity-parser correction.
- Atomic append+stamp полезен для crash window, но здесь не доказана достаточная частота crash/replay, чтобы включать третьим приоритетом.

Прочитаны CLAUDE, decisions #276/#279, Stage 8 и baseline REPORT/events-ofapi REPORT. `node --import tsx/esm investigations/sync-optimization-swarm-2026-09-13/04-canonicalization/probe.mjs` завершился exit 0, <1 с. Это actual-function/fake-I/O доказательство числа операций и последовательности, **не** PostgreSQL concurrency test, EXPLAIN либо production latency benchmark. Никаких SSH/SQL/provider calls, Vitest, installs или product edits. Production revision перечитана перед завершением.

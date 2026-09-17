# Проекции: две дополнительные оптимизации

**P05-1:** одна выборка готовых `(projection, account)` вместо повторных пустых probes. **P05-2:** ограниченная порция работы и изоляция ошибки на уровне аккаунта. Обе возможности присутствуют на `main b48f173d` и production `74aac5093cfc`; это предложения, не внедрённые улучшения. Production-нагрузка и наличие poison events не измерялись.

## P05-1 — выбирать готовую работу одной metadata-выборкой, P2

**Активный путь:** minutely `projections.message-archive.sweep` → `worker-services.ts:453–473` → `projections/registry.ts:635–649`. Каждый из 14 callbacks вызывает `listEventAccounts`, затем для каждого аккаунта `getProjectionWatermark` и `listEventsSince`; восемь предварительно читают страницу. Worklist — маленькая `domain_event_seq`, **не historical DISTINCT по domain_events** (`packages/db/src/repositories/message-archive.ts:492–524`). Но одинаковая работа повторяется 14 раз независимо от наличия новых событий.

**Доказано actual-function harness:** для A существующих Fansly/OnlyFans страниц при нулевом delta получается `14 + (14 + 14 + 8)A = 14 + 36A` SQL statements. При A=1 — 50; A=6 — **230**, включая 84 пустых event reads. Это исключает AI acceptance, BEGIN/COMMIT и серверную стоимость запроса. Считаются вызовы настоящих callbacks с поддельными ответами БД, а не запросы переписанного алгоритма.

**Минимальное изменение:** в начале tick одним запросом сопоставить registry names × `domain_event_seq.next_seq−1` × `projection_seq_watermarks`, выбрать пары `coalesce(high_seq,0) < next_seq−1`. Уже существующий `run(app,{accountId})` позволяет запускать только эти пары. Для полностью idle tick получаем **один metadata SQL вместо 230** при A=6. Активные reducers, их watermark read и проверки страницы пока сохранить: экономия не требует общего payload cache или нового enqueue при append. Пример запроса — `readiness-proposal.sql`.

Snapshot является планом текущего tick: событие, committed после него, попадает в следующий минутный проход. Нельзя без чтения поднимать watermark до головы. Отсутствующий watermark означает replay от 0; unresolved page остаётся pending и снова рассматривается после восстановления каталога. Erasure/rebuild сбрасывают durable состояние — локальный snapshot не должен создавать watermark или resurrect material сам. Долгоживущий кэш и generation, переживающие reset, здесь не нужны. Параллельный rebuild требует существующей координации либо отдельного epoch: readiness этого конфликта не исправляет.

**Польза и предел:** устраняет floor round-trips, pool occupancy и планирование пустых reads через partitions; не доказывает уменьшение физических reads или общей длительности в 230 раз. При полностью активных аккаунтах останется работа reducers и почти все event reads, а metadata join добавит собственную небольшую стоимость. Сложность S: repository query + dispatch, без изменения 14 reducers. Приёмка: idle, один новый account, один lagging projector, missing watermark/page, append после snapshot, erasure/reset между snapshot и запуском; canary — empty event queries/tick, SQL/tick и oldest pending lag.

## P05-2 — изолировать и ограничивать работу аккаунта, P1 при poison / P2 как оптимизация

Изоляция сегодня охватывает целый projector (`registry.ts:647–665`), а account ids всегда отсортированы (`message-archive.ts:522`). Исключение на раннем аккаунте прерывает весь callback. Например, `ofapi-content-events.ts:21–46` кидает `Invalid queue event`; watermark записывается только после успешной страницы (`:61–70`). Registry продолжит другие проекции, но следующего аккаунта **этой** проекции не достигнет.

**Новое воспроизведение, отдельно от baseline R1/debt queue:** двум аккаунтам подан по одному событию; у первого malformed queue fact. Два вызова настоящего `runOfapiContentProjection` дали account reads **[1,1]**, ни одного watermark. Внешний вызов того же callback отдельно для каждого аккаунта с локальным catch дал **[1,2]**, ошибку account 1 и `ofapi_content_events:2=1`. Ни fanout, ни ledger, ни poison fact не переписывались.

Дополнительное усиление: 12 callbacks имеют drain-until-empty; только queue/read snapshots ограничены 20×500 events/account. Поэтому try/catch между аккаунтами устраняет poison starvation, но не ограничивает backfill первого аккаунта. При B backlog rows и цене c на event второй ждёт приблизительно `Bc`, а при постоянном поступлении быстрее drain конечного ожидания вообще не обещано. Это глубже известного бюджета между registry callbacks.

**Конкретный дизайн:** сначала per-account catch с диагностикой `(projection,account,error)`, не продвигающий ошибочный watermark. Затем общая операция `runPage(account,afterSeq,throughSeq,limit=500)`: фиксировать верхнюю границу на начало dispatch, после целиком завершённой страницы возвращать durable continuation. Обходить готовые пары по кругу, проверять общий deadline между страницами; сохранять позицию последней обслуженной пары для рестарта. Poison получает отдельный retry time/backoff, оставаясь видимым и repairable. Отдельные 14 pg-boss queues не требуются; текущий exclusive sweep сохраняется.

При равной цене событий ожидание первой порции другого аккаунта меняется с `B·c` на примерно `500·c` за предшествующую пару. Это условная модель, **не измеренный speedup**; один тяжёлый event/SQL всё ещё может пережить cooperative deadline. Watermark отмечает только полностью пройденный диапазон: crash повторяет страницу идемпотентно; erasure deferral (`creator-posts.ts:468–476,519`) не перескакивается. Ошибка временного account-mapping или исправленный reducer должны возобновлять старый диапазон. Сложность M: единый контракт bounded page для 14 callbacks и durable scheduling cursor/retry state. Приёмка: poison first + healthy later, большой/непрерывный tail + quiet page, crash после применения до watermark, рестарт при rotation, erasure fence. Canary — oldest pending age по паре, completed pages/turn, retries и объём повторно применяемого prefix.

## Матрица readers: углубление уже известного type filtering

Все нижеперечисленные readers вызывают `listEventsSince` без positive type filter; SQL всегда выбирает `de.data` (`domain-events.ts:953–985`). Runtime registry: **14 readers, 48 объявленных типов, 0 overlaps**. Полные наборы записаны в `probe-results.json.registry.entries`.

| Reader | Типов | Строк/account/run | Место чтения, services/projections/ |
|---|---:|---:|---|
| ofapi_content_events | 1 | ≤10 000 | ofapi-content-events.ts:28 |
| ofapi_read_snapshots | 1 | ≤10 000 | ofapi-read-snapshots.ts:82 |
| ofapi_media | 1 | drain | ofapi-media.ts:252 |
| ofapi_typed_exports | 1 | drain | ofapi-typed-exports.ts:34 |
| message_archive | 4 | drain | message-archive.ts:93 |
| ofapi_message_coverage_v1 | 2 | drain | ofapi-message-coverage.ts:236 |
| fan_earnings_stats | 1 | drain | fan-earnings.ts:41 |
| creator_posts | 2 | drain | creator-posts.ts:354 |
| media_plane | 5 | drain | media-plane.ts:181 |
| fansly_stats | 13 | drain | fansly-stats.ts:222 |
| fansly_engagement | 3 | drain | fansly-engagement.ts:153 |
| fansly_catalog | 9 | drain | fansly-catalog.ts:253 |
| fansly_comments | 2 | drain | fansly-comments.ts:181 |
| fansly_payouts | 3 | drain | fansly-payouts.ts:181 |

Это **delta scans от собственных watermark, не 14 исторических full scans каждую минуту**. Для mapped page, одинакового delta N≤10k и полного tick без ошибок — 14N материализованных rows. При N=12 001 actual callbacks вернули **164 012** rows =12N+2×10k. При budget truncation, различных watermark, новых arrivals или отсутствующей странице коэффициент другой. Один checkpoint, не принадлежащий ни одному projector, дал 14 reads, 14 watermark writes, 3 transaction callbacks. Таблица не считает API/worker domain-event hubs; smoke initial replay фильтрует projection-only, AI acceptance читает observations, Fansly replay/shadow rebuild — отдельные неежеминутные пути.

Typed SQL может приблизить payload materialization **14→1 для принадлежащих registry типов**; у неиспользуемого checkpoint потенциально 14→0. Это известная идея, отдельно в savings новых findings не посчитана. Ни `max(matching seq)`, ни число matching rows не доказывают глобальную completeness: фильтр создаёт ожидаемые seq gaps. Нужны отдельные `scannedThroughSeq`, фиксированный global ceiling, и доказательство покрытия диапазона; erasure/tiered gaps и rebuild/legacy seeds не могут превращаться в «ничего не найдено, всё обработано».

**Typed dirty-generation fanout (агент12):** после typed reads payload уже читается одним owner; следующий выигрыш — только sparse work discovery. При A аккаунтах, P=14, D готовых пар и T append batches/tick сравнивать экономию probes `P·A−D` с дополнительными `T·k` transactional dirty-head updates, где k — число реально затронутых families/batch. Платить 14 dirty writes на каждый append бессмысленно. Если экономия probes меньше append WAL/lock cost, P05-1 достаточно. Dirty-head updates должны следовать только фактическим inserts после dedup, commit вместе с ledger и учитывать reset epoch; notification может быть hint, не единственное доказательство pending work. Production crossover пока неизвестен.

## Отклонено и воспроизводимость

Не предлагаются общий payload cache, увеличение workers, уменьшение polling или повтор baseline R1. Rebuild не трогает operational state, archive сохраняет shadow/legacy-seed путь и detached-partition preflight. Capture-first, account ordering, erasure fences, money units, provider backoff и manual controls остаются в существующих reducers/append/capture слоях; новые dispatch-оптимизации не требуют provider calls.

`node --import tsx/esm investigations/sync-optimization-swarm-2026-09-13/05-projections/probe.mjs` воспроизводит census и poison. Git diff подтвердил идентичность registry/projectors/worker-services/message-archive repository в обеих ревизиях; отличие `domain-events.ts` касается `listObservationsForReplay`, не event read. Нет PostgreSQL EXPLAIN, production доступа, Vitest, сетевых вызовов или модификаций product source. Результаты — операции настоящих функций и SQL-text, не обещание общей производительности.

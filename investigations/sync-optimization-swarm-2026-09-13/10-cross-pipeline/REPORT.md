# Сквозная оптимизация и проверка 12 отчётов

**Найдена одна дополнительная конкретная возможность: workboard не объединяет burst одного фана в один пересчёт, несмотря на комментарий о debounce.** Проверены все 32 findings из девяти предметных и трёх архитектурных отчётов. Полная матрица решений и пересечений — [review.json](review.json). Реализация не менялась.

Три практических направления:

1. Устранить лишние workboard jobs, сохранив обязательный следующий пересчёт при новом событии во время исполнения — **CP10-1, P2**, после проверки runtime queue policy.
2. Сначала простые сокращения служебного SQL: QSQL-01/02/03, P05-1, 04-A, OBS-09-02. Они не требуют новой архитектуры. Codec CAP03-1 — отдельный небольшой CPU-патч с сильной проверкой байтов.
3. Для больших delta — typed reads и bounded processing из 05; subscriber interval sweep из 06. Dirty-generation архитектура 12 проверяется **после** измерения остаточной стоимости discovery, иначе её дополнительные writes могут съесть выигрыш.

База: `main=b48f173d93e3693550e2db139de3b11107d44ce2`; предоставленный root повторный снимок API/worker/scheduler от `2026-09-12T23:49:31Z` — `74aac5093cfc665853cc8e5b6cc661de7119b917`. Исторические оценки нагрузки не использованы как текущие. Наличие кода не доказывает включённый lane или фактическую политику существующей очереди.

## CP10-1: задержка каждого event ошибочно считается объединением работы

**Активный caller.** `apps/runtime/src/worker-services.ts:560` запускает `startWorkboardEventRecompute` без отдельного feature gate. Subscriber фильтрует fan-relevant events, затем для **каждого** вызывает `boss.send` с `(accountId, fanIdentityRef)`, `singletonKey` и `startAfter:5`: `apps/runtime/src/services/workboard-event-recompute.ts:43–63`. Тело job не содержит самого события: `runWorkboardFanRecompute:74–100` читает актуальное состояние фана.

Очередь создаётся с `policy:'standard'`: `apps/runtime/src/services/sync-queue.ts:260–264`. `singletonSeconds` не передан. В установленном pg-boss **12.14.0** `manager.js:427–456` отправляет обычный INSERT; `plans.js:911–915` получает `singleton_on=NULL`. Unique index для времени требует `singleton_on IS NOT NULL`; остальные уникальные ограничения применяются к short/singleton/stately/exclusive/key_strict_fifo, а не standard (`plans.js:464–482`). Один `singletonKey` здесь не объединяет jobs. `startAfter` только откладывает каждый job.

**Доказательство.** [probe.mjs](probe.mjs) исполняет настоящие queue registration, subscriber, `Manager.send/createJob` и job wrapper на исходниках обеих ревизий. На 100 events одного фана и пяти других — **105 INSERT statements для шести ключей**; два нерелевантных события отфильтрованы. При 105 принятых fake-DB jobs wrapper делает 105 page lookups, 105 fan lookups и 105 вызовов reducer. Сам reducer и БД заглушены; его SQL/время в сумму не включены. Принятие всех INSERT при standard policy следует из SQL и predicates индексов, **не проверено реальным PostgreSQL**. Исходники subscriber и этого queue definition совпадают между ревизиями.

Сейчас для E relevant events одного burst — E enqueue INSERT и E пересчётов. Внутри настоящего reducer дополнительно читаются сигналы/старое/новое состояние и пишутся производные данные (`apps/runtime/src/modules/workboard/recompute.ts:272–319`). Модель после coalescing при K уникальных ключах, если все события пришли **до начала исполнения**, — K пересчётов: для fixture **105→6**. Если события продолжаются во время работы, нужны дополнительные turns; постоянный поток не обещает один job навсегда. Это не 94% ускорения Hub и не экономия HTTP. Размер E/K в production неизвестен.

**Безопасный дизайн, M.** Ввести ограниченное durable состояние `(page,fan,wanted_seq,applied_seq,generation,lease)` и объединять только ожидающую работу одного ключа. Executor фиксирует требуемую версию и eligibility/material boundary, выполняет штатный reducer, затем закрывает лишь эту версию. При `wanted>applied` или новом arrival во время исполнения следующий turn остаётся обязательным. Ошибка, lease loss или crash не закрывают pending obligation; restart восстанавливает её из durable состояния. Минимальная очередь может использовать существующие pg-boss механизмы, но контракт queued/running-followup должен быть явно доказан. Один процессный Set или голый `singletonSeconds:5` недостаточны.

Эта первая версия убирает повторные **пересчёты**; E дешёвых dirty updates на ingress могут остаться. Обещать сразу E→K SQL на всём пути нельзя. Event ledger, порядок account_seq, captured facts, temporal transitions и существующие money расчёты сохраняются. Если reducer зависит от ещё не применённой проекции, readiness проверяется отдельно: пять секунд не являются доказательством готовности material. Erasure/reset меняют generation; поздний worker не воскрешает старые данные. Nightly reconciler остаётся и показывает drift.

**Выпуск требует явного cutover.** `ensureQueueCreated:130–140` вызывает `createQueue`; это `ON CONFLICT DO NOTHING`. В workboard нет reconciliation policy, аналогичной page executor. Изменение `policy` только в TypeScript не меняет существующую очередь. Нужны runtime-DDL проверка и миграция/cutover с учётом pending/active/retry jobs, без потери пробуждений. Самостоятельных production действий этот отчёт не разрешает.

Приёмка: burst до claim; событие до/после reducer snapshot и completion; два worker; таймерная граница; restart; retry; generation reset/erasure; неизменность итогов и отсутствие пропущенного terminal transition. Canary: jobs/relevant event, recomputes/unique key, SQL/recompute, oldest pending age, workboard lag и nightly drift. Если E≈K, усложнение не окупается.

## Что выдержало cross-review и как не сложить одну экономию дважды

| Семья работы | Решение и граница |
|---|---|
| QSQL-01/02/03/04 | Конкретные повторные SQL подтверждены. Для planner сохраняются первый ensure, lock order и standalone wrapper. No-op guard не должен закрепить потерю retry context. Общий idle poller экономит только пустые fetch и не исправляет межпроцессный admission. |
| P05-1 / typed reads / GF12-01 | **230→1 — полностью idle fixture шести mapped accounts.** Typed delta readers: 14 callbacks, 48 disjoint types; это 14 чтений delta каждого потребителя, не 14 исторических full scans за минуту. Typed reads и dirty fanout не складываются: первое убирает body reads, второе — оставшееся discovery ценой transactional writes. |
| P05-2 / E11-1 | Poison isolation — отдельная ошибка доступности; bounded account turns — fairness. SSE quantum не убирает total reads, а может добавить head overhead. Не добавлять его проценты к typed read reduction. |
| OBS-09-02 / CP10-1 | Shared worker hub устраняет второй ledger reader; CP10-1 — downstream recomputes. Операции разные, но общая доля в CPU неизвестна. Startup smoke replay, guards и checkpoint сохраняются; общей reader failure domain нужна проверка lifecycle. |
| 04-A / 04-B | Exact-path census отделяется от глобального incident recovery; локально здоровый account не закрывает глобальный конфликт. Dedup prefetch **602→3** — 200 exact duplicates, без BEGIN/COMMIT; дополнительный shared erasure fence даёт ещё 1 SQL. Это альтернатива/этап общего batch append, не дополнительный коэффициент поверх него. |
| CAP03-1 / CAP03-2 | Root подтвердил codec parity на Node22: 86 807 byte cases + 11 invalid cases. Timings локальные. Descriptor-only index убирает ссылки на body, но исходный Promise.all peak остаётся до bounded reader; retained storage и HTTP не уменьшаются. Purchase lane условный. |
| DM02 / FAN06 | Readthrough workload условный; change-set comparator дешевле без новой cache authority. Reply SQL merge требует differential SQL; summary aggregate сохраняет O(N) count scan и квадратичную сумму backfill scans. FAN06 interval SQL отдельно подтверждён root на PG16 в 220 сравнениях, **без performance benchmark**. Notes batch экономит round-trips при complete arrays, а timestamps/writes остаются. |
| FH07 / 08 | Media-stats 429/split_31 и DM recovery экономят HTTP лишь в своих сценариях. Rethrow 429 — containment, общий scoped cooldown отдельно обязателен. Все 08 findings экономят локальный SQL/locks, не vendor credits; exact-credit shortcut требует монотонности persisted receipt. |
| OBS-09-01 / E11-2 / E11-3 | Health index переносит цену на writes/HOT; нужен PG plan/WAL crossover. AI union bound не позволяет naïve LIMIT в arms и не отменяет manifest. **501→$500 all-time — correctness**, полный aggregate может увеличить работу. |
| GF12 / R13 | Receipt/requirements — пригодные направления shadow-проверки, не дополнительные измеренные savings поверх конкретных исправлений. Parse cache пока условный. R13-B отклонён как текущий optimization project: не доказана окупаемость собственного архивного storage после CAS. |

## Критический путь, capacity и отклонённые shortcuts

Независимая проверка source: canonicalization и projections запускаются разными `boss.work` callbacks (`worker-services.ts:391,453`); их 600-секундные бюджеты проверяются между страницами/проекторами и **не являются общим DB admission**. `createPool` создаёт один app pool без собственного разделения по классам работы (`packages/db/src/client.ts:72`); долгие callbacks, serving и LISTEN consumers могут конкурировать за ресурсы. Уменьшение concurrency снижает peak, но само не устраняет обязательные операции.

Для сравнимого workload считать отдельно `DB work = Σ λᵢ·queriesᵢ + idle polls`, `occupied connections ≈ Σ λᵢ·connection-secondsᵢ + pinned LISTEN`, CPU/bytes/WAL и физические HTTP. λ — частота **полезной** работы, не число повторных jobs. Фактические λ, buffer costs и доли CPU здесь неизвестны. Важны oldest debt и p95 capture→material→serving; уменьшение одного локального множителя не даёт процента всей системы.

Отклонены: новая квота идей; ускорение ценой пропущенных facts; TTL-кэш binding/erasure truth; hash-only CAS equality; LIMIT каждого transcript arm; «переключить policy одной строкой»; повторный учёт уже deployed getAccountHighWater, parse reuse, no-op fan writes, bounded webhook reader и awaiting_parse. Исправления полноты F1–F3 и retry/admission из baseline остаются отдельными предпосылками безопасного ускорения.

Воспроизведение: `node investigations/sync-optimization-swarm-2026-09-13/10-cross-pipeline/probe.mjs`. Использованы installed TypeScript/pg-boss, Node26; выполнены actual-function calls с fake I/O и generated SQL. Нет production SSH/SQL/provider calls, Vitest/Testcontainers, installs, product edits или новых агентов. Остальные probes прочитаны, не объявлены повторно исполненными; независимые Node22/PG16 результаты принадлежат root. Все 12 финальных REPORT/findings прочитаны до завершения.

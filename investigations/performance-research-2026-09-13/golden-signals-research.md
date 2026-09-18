# Исследование canonicalize golden signal

Срез исходников: `74aac509` в `/Users/dmitriy/code/goose/.worktrees/hub-performance-research-20260913`. Исследователь читал код и сохранённые артефакты; production SSH/SQL/API, тесты и изменения приложения не выполнял. Root отдельно собрал catalog metadata и выполнил локальные oracle, scale и index comparison проверки. Полный production EXPLAIN недоступен по ACL; исследование завершено с отклонением неподходящих кандидатов, без production fix.

**Вывод: для canonicalize golden signal сейчас не следует менять SQL или добавлять индекс.** Исследование обнаружило и отклонило оптимизацию, которая сохраняет результат, но примерно в 4,2 раза замедляет большой допустимый replay. Индексная альтернатива тоже не получила достаточного обоснования: при корректно summarized существующем BRIN старый SQL обслуживает маленькое искусственное окно за 0,5 ms, а новый btree не меняет план больших окон. Сам observed production SQL 12393.49ms подтверждён, но его фактический plan и состояние BRIN summaries не доступны по read_only ACL. Поэтому next action — подтвердить конкретный production access path и его стоимость в разрешённом диагностическом контуре, не выпускать предположение как фикс.

## 1. Что действительно наблюдали

Сохранённый PostgreSQL log на `2026-09-12T21:33:57.706Z` содержит выполнение **12393.49 ms**. SQL fingerprint `c6f16be98fbe64ef609d55a2002a2a163bc8c787c8a76abe2c65d8ec871d78e2` совпадает с `computeGoldenSignals` canonicalize query. Источники: `observations-followup/after-runtime-logs.json:148`, `after-log-attribution.json`, `REPORT.md:87` в предыдущем исследовании.

Это доказательство одного медленного SQL, а не доказательство, что каждый минutely tick занимает 12 секунд, что виноват конкретный JOIN plan, или что все 91/36 млн observation fetches принадлежат ему. В том окне были внешние диагностические запросы. Сохранённый slow log не содержит actual row counts, buffers, plan либо query-level CPU. Нельзя заранее обещать процент экономии CPU или диска.

Подтверждённый кодовый риск: predicate свежести есть только у `domain_events.created_at`, тогда как JOIN разрешает планировщику читать `observations` целиком. Если актуальный план выберет hash join со сканированием всего журнала, стоимость мониторинга растёт с историей, хотя результат использует лишь недавние события. Это гипотеза о наблюдённом выполнении. Root попытался проверить её через ограниченный EXPLAIN, но read_only не имеет SELECT на необходимые domain_events столбцы; факт denied не заменён обходом прав.

### Новая metadata и oracle проверка root

`metadata.json`, время `2026-09-12T23:11:04.884121Z`: роль read_only, transaction read-only; parent observations PK и 0144 valid, parent domain_events BRIN(created_at) valid. PostgreSQL 16.13, jit=off, max_parallel_workers_per_gather=0, work_mem=16MB. Доступа к требуемым domain_events.observation_id/created_at нет; pg_stats результатов не дал. Connection закрыт, прав/лимитов не меняли. Поэтому **нет actual production plan, actual recent cardinality либо измеренного разделения стоимости JOIN и event scan**.

Каталог показывает приблизительные reltuples populated observations: July 911154, August 1060009, September 405273; это planner estimates, не свежий COUNT. Parent reltuples=-1. Физически есть несколько populated и пустые monthly/future partitions; synthetic fixture масштабирует объём вниз и не выдаётся за копию production.

Root выполнил подготовленный deterministic oracle на изолированном локальном PG 16: populated 11 строк,p50=5000,p95=2635195000; empty 0 строк,null/null. Лог `golden-oracle-result.log`. Это подтверждает семантический fixture, но не производительность и не все application paths. Отдельные `golden-signals-performance-{sparse,broad,repeated}.sql` и индексные варианты root выполнил последовательно; результаты ниже.

## 2. Кто запускает и кто использует результат

- `apps/runtime/src/services/golden-signals.ts:24–89`: queue `ops.metrics.sample`, policy `exclusive`, cron `* * * * *`, UTC. Лидер scheduler регистрирует cron через `services/schedules.ts`; worker запускает обработчик с `batchSize:1` (`worker-services.ts`, `startGoldenSignalWorker`). API не пересчитывает golden signals при каждом HTTP чтении.
- `computeGoldenSignals` последовательно считает capture, canonicalize, projection и остальные gauges. Ошибка canonicalize SQL выбрасывается наружу: дальнейшие gauge probes и `insertOpsMetricSamples` в этом запуске не выполняются. Это не существующий catch-and-zero путь.
- `runGoldenSignalSample` пишет p50/p95 в `ops_metric_samples`, округляя миллисекунды в `insertOpsMetricSamples`; после этого ведёт отдельный incident latch на каждый threshold metric. Для canonicalize порог p95 **180000 ms**, сравнение строго `value > threshold`.
- `GET /api/v1/ops/metrics` за `requireSyncHealthAccess` отдаёт сохранённые последние 30 точек на серию плюс threshold map и smoke checkpoint (`modules/ops/index.ts:432`, `getGoldenSignalsReport`). Decision 303 уже оптимизировал чтение этих samples; это другой SQL и другой слой. Не надо ещё раз «ускорять endpoint» изменением sampler.
- `ops-watchdog.ts`: API независимо проверяет свежесть telemetry каждую минуту, после 5 мин startup grace; допустимая тишина 3 мин. `disk_*` gauges исключаются из newest-sample deadman. Понижение частоты sampler до 5/10 мин без изменения контрактов создаст ложные или реальные blind spots.
- Stage 25 описывает canonicalization observation→`domain_events.created_at` как golden signal для приёмки scaleout. Decision 96 вводит sampler; W5 хранит per-signal latch и честную тишину; Decision 293 load оптимизировал только projection backlog; Decision 303 обслуживает reads; Decision 315 касается replay selector. Эти изменения не отменяли canonicalize metric.

## 3. Точный контракт выборки

Исходный SQL:

```sql
select
  percentile_cont(0.5) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p50,
  percentile_cont(0.95) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p95
from domain_events de
join observations o on o.id = de.observation_id
where de.observation_id > 0
  and de.created_at > now() - make_interval(mins => 10);
```

В приложении 10 передаётся прежним параметром `SAMPLE_WINDOW_MINUTES`; пример раскрывает его только для выполнения исследовательского SQL.

1. **Окно по append timestamp, не по provider time.** Включены только события со строгим `created_at > cutoff`. Ровно cutoff исключён; cutoff+1microsecond включён. Верхней границы `created_at <= now()` нет: существующая строка с будущим created_at включается. Добавить такую границу незаметно нельзя.
2. **Лаг начинается с journal received_at.** Это не `observed_at`, не provider `occurred_at`, не source response timestamp. `insertObservation` берёт explicit `receivedAt` либо один JS `new Date()` и использует тот же timestamp в observation_keys и observations. Event writer не передаёт `created_at`, оставляя database `now()` default. Длительная транзакция или отличие часов могут дать отрицательный лаг; исходная формула его не зажимает.
3. **Вес по строкам events и совпадениям JOIN.** 100 events от одной observation дают 100 элементов распределения. DISTINCT observation IDs с последующим вычислением одного лага изменит p50/p95. Все типы, аккаунты и projection-only события включены, если observation_id положителен. Синтетические события с 0 и отрицательные IDs исключены. Дедуп, не создавший новую строку события, нового измерения не даёт.
4. **INNER JOIN.** Событие, у которого нет соответствующей observation в attached parent, не входит в распределение. Ни missing-row=zero, ни LEFT JOIN+coalesce неэквивалентны.
5. **Физическая уникальность составная.** Observations PK `(id,received_at)`; events PK `(id,occurred_at)`. Протокол обычно выделяет глобально новые sequence IDs, но SQL/schema не гарантирует глобальную уникальность одного id. Одинаковый observation id в разных партициях даёт несколько matches. Кандидат должен сохранить их все. Нельзя подменять join scalar subquery либо LIMIT 1. События с одинаковым физическим id в разных occurred_at тоже должны сохранять вес.
6. **Нет трафика → null quantiles → никаких новых canonicalize samples.** `toSamples` отбрасывает NULL/nonfinite значения. Существующий latch остаётся как был: отсутствие sample не подтверждает здоровье. Ошибка SQL тоже не становится нулём. Числа округляются лишь при сохранении samples, не до расчёта percentile.
7. **Один SQL snapshot.** Source filtering и observation lookup видят одну MVCC картину. Разбить fetch IDs и load timestamps на отдельные round trips с тем же отсутствующим transaction нельзя без изменения concurrent erasure/append поведения.

## 4. Схемы, партиции и индексы

`0054_observations.sql`: monthly RANGE по `received_at`, PK `(id,received_at)`, прежние `(account_id,received_at)`, `(kind,received_at)`, `(parse_version,received_at)`; `0144` добавляет health floor `(parse_version,source,kind,received_at)`. Для lookup по id с возвратом received_at уже достаточно PK, добавлять ещё `observations(id) INCLUDE(received_at)` было бы дублированием.

`0057_domain_events.sql`: RANGE по `occurred_at`, provider timestamps, первичные месяцы с 2024 и `pre_2024` catch-all; `0077` перестраивал ранние партиции; `0082` добавил future catch-all. Индексы `(account_id,account_seq)` и `(type,occurred_at)` не обслуживают глобальную свежесть по created_at. `0080` уже добавил **BRIN(created_at)** на parent. В inspected migrations больше btree/covering индекса по created_at не найдено. Root подтвердил valid индексы catalog probe; actual query plan и статистическое распределение недоступны по ACL.

Ни cutoff по `de.created_at`, ни равенство `o.id` не дают partition pruning по ключам `occurred_at`/`received_at`. Это необходимо: недавно созданное событие может описывать 1970/2024/2032, а новая канонизация старой observation должна показать долгий лаг. Принудительно читать только текущий месяц — ложное ускорение через потерю самых запоздалых событий.

BRIN хранит диапазоны страниц и возвращает кандидаты с последующим heap recheck, поэтому наличие индекса не означает узкий exact index scan. Качество зависит от физического распределения created_at и summarization; это основание измерить blocks/rechecks, а не объявить индекс сломанным. [Документация PostgreSQL 16 BRIN](https://www.postgresql.org/docs/16/brin-intro.html).

PK позволяет index-only observation lookup по нужным двум столбцам, но недавно изменённые страницы могут требовать heap fetches для проверки MVCC visibility. Это особенно актуально при parse_version stamps. Нельзя обещать «ноль heap чтений» только по имени Index Only Scan. [PostgreSQL 16 index-only scans](https://www.postgresql.org/docs/16/indexes-index-only-scans.html).

## 5. Кандидаты и выбор

### A. Минимальный параметризованный all-match lookup — отклонён как общий фикс

Исполняемый файл: `golden-signals-candidate-lateral.sql` рядом с отчётом.

```sql
select
  percentile_cont(0.5) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p50,
  percentile_cont(0.95) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p95
from domain_events de
join lateral (
  select o.received_at
  from observations o
  where o.id = de.observation_id
  offset 0
) o on true
where de.observation_id > 0
  and de.created_at > now() - make_interval(mins => 10);
```

`OFFSET 0` сохраняет все строки. Его смысл здесь — сохранить параметризованную границу подзапроса: обычный LATERAL без неё может быть развёрнут обратно в первоначальный JOIN. Проверен PostgreSQL 16 source `is_simple_subquery`: присутствующий `limitOffset` запрещает pull-up. Это зависимость от выбранной версии планировщика, поэтому она должна иметь короткий комментарий и плановый регрессионный тест, а не магическое необъяснённое число. [PostgreSQL 16 planner source](https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/src/backend/optimizer/prep/prepjointree.c), [семантика LATERAL](https://www.postgresql.org/docs/16/queries-table-expressions.html#QUERIES-LATERAL).

Ожидаемый механизм: отбор недавних events по прежнему created_at predicate, затем PK probes observations только для их observation_id. Не нужны payload, observation_keys, API, новая запись или migration. Разные event строки сохраняют свой вес, одинаковые id matches сохраняются полностью.

**Контраргумент:** в насыщенном replay окне сотни тысяч уникальных observation IDs × число attached partitions могут стоить дороже последовательного чтения journals. Query fence ограничивает свободу планировщика. Проверить 0/100/10000/200000 recent events, низкую и высокую долю повторяемых IDs, старые и свежие heap pages. Если regression большого окна материальна, кандидат не одобрять только по выигрышу обычной минуты.

### A2. Materialized recent set плюс тот же all-match lookup — не решает обнаруженный риск

Исполняемый файл: `golden-signals-candidate-materialized.sql`.

```sql
with recent as materialized (
  select de.observation_id, de.created_at
  from domain_events de
  where de.observation_id > 0
    and de.created_at > now() - make_interval(mins => 10)
)
select
  percentile_cont(0.5) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p50,
  percentile_cont(0.95) within group (order by extract(epoch from (de.created_at - o.received_at)) * 1000) as p95
from recent de
join lateral (
  select o.received_at from observations o
  where o.id = de.observation_id offset 0
) o on true;
```

Граница явно выделяет только два узких столбца recent набора, но добавляет его материализацию и при больших окнах возможный spill. MATERIALIZED сам по себе не гарантирует, что обычный JOIN потом не просканирует observations; нужен проверенный фактический plan. Без измеримого отличия от A не выбирать более длинный вариант; материализация не устраняет дорогие all-partition probes при высокой уникальности IDs. [PostgreSQL 16 CTE materialization](https://www.postgresql.org/docs/16/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION).

### B. Индекс отбора по created_at с прежним свободным JOIN — локально проверен, добавление не обосновано

Локальный исследовательский DDL на disposable dataset:

```sql
create index gs_created_observation_candidate
  on domain_events (created_at) include (observation_id)
  where observation_id > 0;
```

Сохранить исходный SQL и посмотреть, выбирает ли planner хороший recent-first plan благодаря точному time range. Он сохраняет возможность hash join при действительно огромном окне; это преимущество перед постоянным fence. Но индекс не гарантирует решения другого дефекта оценки JOIN; его цена — место, WAL и обновление каждого положительного event append на всех attached partitions. PostgreSQL может потребовать heap visibility даже с INCLUDE на свежих строках. Нужны actual plan и сравнение append throughput/index size; без них такая migration избыточна.

Этот DDL **не является production migration**. На partitioned parent нельзя просто добавить `CONCURRENTLY` к нему и считать безопасной выкладкой. При выборе B понадобится существующий retry/valid-index протокол: parent-only index, последовательные concurrent child builds, attach; сверка всех исторических/future partitions, lock budget, restartability, совместимость precreator. Новая migration нумеруется по актуальному release, не по сохранённому каталогу.

### C. Сохранять received_at/lag в domain_events при append — отклонить для этой задачи

Это потенциально убирает JOIN вообще, но затрагивает все append producers, replay/migration semantics и erasure/deletion: сегодняшняя метрика исключает event, если observation больше нет в parent; денормализованное время продолжало бы его учитывать. Потребуется backfill или двойное чтение старых событий, а duplicate id ambiguity остаётся. Не оправдано без подтверждённого production access path и существенного выигрыша: узкий PK query candidate уже отклонён из-за регрессии, а расширять append protocol на основании одного slow log ещё рискованнее.

## 5a. Исполненная root локальная adversarial проверка

Логи `golden-performance-sparse.log`, `golden-performance-broad.log`, `golden-performance-repeated.log`. Изолированный PG16, network none,1 CPU /1 GB; work_mem 16 MB, jit off, parallel gather 0.300000 старых observations и 300000 старых events,13 observation partitions, новые events добавлены отдельным блоком. Temp heap свежий без VACUUM; leaf+parent stats явно ANALYZE. Пары выполняются ABBA после oracle equality checks. Это масштабная искусственная проверка, не production clone.

| Recent workload | Старый SQL, два выполнения | LATERAL A, два выполнения | Вывод |
|---|---:|---:|---|
|100 events /100 различных IDs |17.921 /16.917 ms |18.143 /17.505ms |Выигрыша нет, старый plan уже nested loop |
|200000 events /200000 IDs |205.478 /245.032ms |937.210 /940.899ms |A примерно в 4.2 раза медленнее по среднему двух runs |
|200000 events /100 IDs |185.352 /198.370ms |135.182 /134.448ms |A быстрее в этом профиле, не общий выигрыш |

Причина подтверждается actual plans. Broad old выбирает Hash Join и читает 300000 observations один раз. A навязывает 200000 параметризованных обращений ×13 partitions =2600000 leaf loops и 200000 heap fetches; Memoize имеет 0 hits/200000 misses. Repeated A имеет 199900 hits/100 misses,1300 leaf loops и 100 heap fetches. Это конкретно тот фактор, ради которого запрошен adversarial тест.

Не следует восстанавливать точные scanned rows как `Actual Rows * Actual Loops`: JSON округляет per-loop Actual Rows до целого, так что редкое попадание среди множества пустых partition probes печатает 0 при ненулевом total. Здесь приводятся exact loop/heap-fetch/Memoize counters, а не ложные zero rows.

Все табличные buffers в этих TEMP fixtures отражены как **Local Blocks**, не Shared Blocks. File reads могут обслуживаться OS cache; результаты не измеряют physical disk I/O production. BRIN создан перед bulk insert: ANALYZE сам по себе не гарантирует, что все ranges summarized. Для следующей проверки подготовлены `golden-signals-performance-index-{sparse,broad,repeated}.sql`, которые явно вызывают brin_summarize_new_values у leaf BRIN, не VACUUM heap, затем сравнивают старый свободный JOIN до/после temporary created_at covering btree. Этот дополнительный фактор важен для анализа event scan; он не оправдывает unconditional LATERAL, проигравший на unique-ID нагрузке.

## 5b. Проверка summarized BRIN и нового covering btree

Логи `golden-index-sparse.log`, `golden-index-broad.log`, `golden-index-repeated.log`; сводка root `experiment-summary.json` проверена по plan JSON. Те же fixtures, leaf BRIN summaries явно заполнены, heap не VACUUM; затем добавлен temporary btree и повторён **исходный** SQL со свободным JOIN.

| Recent workload | Summary BRIN, ms | BRIN плюс новый btree, ms | Что фактически выбрал planner |
|---|---:|---:|---|
|100 /100 IDs |0.498, 0.483 |0.481, 0.392 |Малое окно: BRIN bitmap меняется на btree index-only;730→712 LocalBlocks |
|200000 /200000 IDs |204.694, 214.652 |193.459, 189.918 |Прежний BRIN+Hash Join в обеих версиях;16449 LocalBlocks без изменения |
|200000 /100 IDs |158.191, 161.732 |157.194, 154.584 |Прежний BRIN+Hash Join в обеих версиях;16449 LocalBlocks без изменения |

На больших окнах новый индекс **не используется**, поэтому наблюдаемую разницу времени не приписываем ему. На маленьком окне saved blocks и разница абсолютного времени очень малы. Новый индекс занимает 9625600 bytes при 300100 events и 15917056 bytes при 500000 events в модели, без измерения write-cost. Это не обосновывает дополнительный индекс для immutable ledger на основании одной прежней 12.4 sстроки лога.

Сильный вывод отдельного контрольного фактора: искусственный свежесозданный BRIN до summarization дал 17 ms для малого окна; заполнение его summaries позволило исходному SQL выполнить ту же работу примерно за 0.5 ms без query change. Из этого нельзя заключить, что production BRIN не summarized: такой доступ к summary coverage/actual plan не получен. Влияние BRIN maintenance теперь является конкретной проверяемой гипотезой наряду с inaccurate estimates, large recent population, I/O/resource contention и состоянием текущих partitions. Root не запускал production summarization, VACUUM, ANALYZE или конфигурационные изменения в рамках этих экспериментов.

## 6. Небезопасные упрощения

- LIMIT на events перед percentile, TABLESAMPLE или «только последняя observation» меняет распределение и может скрыть p95 задержку.
- Среднее или max минутных/аккаунтных p95 не воспроизводит p95 общего множества; объединение percentile через промежуточные percentile некорректно.
- DISTINCT observations, scalar subquery, min/max received_at либо LIMIT 1 нарушают вес и all-match semantics.
- Срез по observation received_at/observed_at, event occurred_at, текущим партициям, active pages либо известному набору event types отбрасывает существующие элементы распределения.
- Кэшировать timestamp по id между sampling ticks меняет erasure/MVCC поведение и требует invalidation; один statement index probe дешевле по сложности.
- Вставлять zero samples после timeout/no traffic разрешает false resolve. Timeout/cadence увеличение только скрывает лишнюю работу или ослабляет контроль.
- Глобально отключать hash join / менять planner settings затрагивает несвязанные запросы. Никаких таких production settings в этом решении.
- Использовать observation_keys по одному observation_id без гарантированного complete unique mapping ошибочно: таблица ключей адресуется source/idempotency key и не заменяет физический all-match JOIN.

## 7. Adversarial проверки до решения

Подготовлен `golden-signals-oracle-fixture.sql`: только temporary таблицы и ROLLBACK на локальном PG 16. Исследователь не запускал; root успешно выполнил (`golden-oracle-result.log`). 11 joined строк; независимые hand-computed p50=5000 ms, p95=2635195000 ms. Сравнение исходного и candidate полного multiset через двусторонний EXCEPT ALL; это сильнее совпадения только двух quantiles. В нём duplicate observation/event IDs по партициям, повторяемая observation,1970/2032provider dates, старый received_at, отрицательный лаг, точные cutoff±1µs, future created_at, missing observation, IDs0/-1 и пустое окно.

Матрица для приложения/плана, которую ещё нужно выполнить:

| Проверка | Какую регрессию ловит |
|---|---|
| Реальный SQL перехватывается с pool из `computeGoldenSignals`, не перепечатан отдельной константой | Тесты не расходятся с shipped query |
| Предыдущий SQL как independent oracle; EXCEPT ALL по joined источнику и равенство p50/p95 | Вес/multiplicity, NULL и границы окна |
|0,1,2,20 событий с неравномерными lag | Интерполяция percentile_cont, отсутствие ceil/round до вычисления |
|1 observation→100 events плюс 1 медленное событие | Опасный DISTINCT по observations; event weighting |
| Positive missing observation, observation0/-1, физические NOT NULL | INNER JOIN и фильтрid; отсутствие бессмысленной nullable ветки |
| created_at=cutoff,±1µs,now,+1day; received_at старый/будущий | Точные границы, отрицательный lag, сохранение отсутствующего upper bound |
| Два id одинаковы по разным received_at; два event id по occurred_at | Нет LIMIT 1/scalar assumption; identity не сужена |
| Detached partition после подготовки локального fixture | Источник остаётся именно attached parent, не lake/parked history |
| Same statement concurrent append/erasure и отсутствие временного app cache | Одинаковый MVCC snapshot, отсутствующие rows не восстанавливаются |
|No traffic после существующей breach | Не создаёт zero sample и не закрывает latch |
|SQL throw/timeout | Не превращается в zero; прежний failure propagation |
| Existing reported sample rounding/threshold =180000 и 180001 | Не меняет persistence и incident threshold |
|300k–1mстарых rows, малая recent доля; свежая heap без VACUUM и VACUUM case | Фактическая экономия buffer/heap работы, не только покрывающий индекс на идеальных данных |
|10000/200000 recent events, высокое/низкое повторение IDs | Ловит регрессию forced nested loop при массовом replay |
|Много пустых historical/future partitions плюс backfilled rows | Оценки planner и стоимость всех partition probes |
|Удалить OFFSET 0 / вернуть old query в negative control | Плановый тест действительно чувствителен к дефекту |

`tests/golden-signals.integration.test.ts` уже покрывает capture lag, projection backlog, floor gauges, persistence/report, breaches/recovery и отсутствие sample для capture. Прямых nonzero canonicalize quantile assertions в inspected файле нет. `tests/minutely-job-query-plans.integration.test.ts` проверяет старые OFAPI spend/floor планы, но не этот JOIN. Поэтому просто прогнать имеющиеся тесты недостаточно.

## 8. Что измерить и как принять

1. Catalog metadata получена. EXPLAIN production old query недоступен по ACL; A/A2 не надо повторно пытаться выполнять с теми же отсутствующими правами. Для следующего diagnosis нужны разрешённые точный plan, recent cardinality и BRIN summary coverage. Никакого обхода роли, чтения payload либо выдачи приватных строк.
2. На serial disposable PG 16 выполнить oracle fixture, actual captured SQL app tests, разноразмерную plan матрицу. Записывать execution+planning time, shared/local/temp blocks, rows/loops/heap fetches, не складывая recursively cumulative counters без методики. Условия cold/fresh и warmed отделять. Не выдавать synthetic multiplier за production savings.
3. Если контролируемая prod пара потом нужна: единый read-only REPEATABLE READ snapshot и фиксированный cutoff, ограниченные timeouts, без параллельных диагностик. Не повышать read_only лимиты, не обходить ACL. Timeout old query — цензурированное время, не точная длительность.
4. По этим результатам не одобрять A/A2 и не вводить B: первый вариант доказанно регрессирует, второй не даёт достаточного выигрыша. Известен дорогой production SQL; следующий полезный шаг — подтвердить его фактическую причину, а не подбирать ещё один обход без наблюдаемого плана.
5. ДляA deployment не требует migration/flag/retention change; rollback прежним SQL, сохраняет текущее schema и данные. Независимое code/architecture review должно проверить именно final emitted SQL и fence comment. B имеет дополнительный index build/append/storage budget и отдельный deployment план.
6. После разрешённого deploy проверять sampler minute completion, свежие p50/p95, отсутствие false resolve/deadman, service health/errors, и сравнивать сопоставимые окна при учёте числа новых events/observations и replay работы. Sampler12.393 s — wall time, не 12.393 CPU seconds. Экономия этого SQL не равна ускорению пользовательского HTTP.

## Источники и границы работы

Локальные первичные: `apps/runtime/src/services/golden-signals.ts`, `ops-watchdog.ts`, `schedules.ts`, `worker-services.ts`, `modules/ops/index.ts`, `packages/db/src/repositories/{ops-metrics,observations,domain-events}.ts`, `apps/runtime/src/services/erasure/index.ts`, migrations 0054/0057/0067/0077/0080/0082/0144/0186, tests golden-signals/minutely-job-query-plans, Stage 25, decisions293/303/315, error-handling.md и SESSIONS.md. Сохранённые measurement artifacts относятся к прошлому release/window, не подтверждают текущие планы.

Memory quick-pass: MEMORY.md:830–833 использован лишь для read_only/capture/durable cursor рамок; действующий код и пользовательские ограничения проверены отдельно. Root получит этот указатель для единого финального memory citation.

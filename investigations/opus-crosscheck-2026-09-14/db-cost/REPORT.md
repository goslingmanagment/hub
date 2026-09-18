# Перепроверка Opus: PostgreSQL, WAL и диск

**Механизмы нескольких оптимизаций подтверждены; итоговые проценты экономии не подтверждены измерением исправленного пакета.** Самые конкретные новые кандидаты — `FILTER(TRUE)` для health-floor и partial `id` index для repair queue. Предложенный O3-03 batch-upsert нельзя применять как написано: он меняет поведение при конкуренции и пропущенных полях.

Проверено 48 отдельных записей в [checks.json](checks.json): G2–G5 и одиннадцать подстрок G5, O3-01…12, O4-01…06/O4-02a, O5-01…10, четыре общих численных вывода. O3-13 проверяет root. Записи отсутствующих номеров нужны для покрытия назначения, они не означают, что такой claim был в исходном отчёте.

Код сверялся с `74aac509`; отличающиеся от main файлы сохранены в [source](source/). Root подтвердил текущий `380326368fe3`, идентичный `74aac509` по sync-коду. Свежие показания root: **14 сентября 01:15 MSK — 19 217 633 280 B доступно, 77% использования диска**; БД в 01:17 MSK — 37 287 541 783 B. Это отдельные точки, не скорость роста. [Production identity](../production-identity.json), [catalog](../production-catalog.json).

## Существенные совпадения

- **G4/O4-06 ↔ OBS-09-01.** В `sync.ts:2284–2425` есть ranking всей retained history завершённых runs и window по всем attempts для last success. Нужен точный latest-success anchor и suffix ошибок; простой time cutoff потеряет старый успех или неразрешённые ошибки. Часть других CTE уже ограничена временем, поэтому формулировка «весь запрос читает всю историю» слишком широка.
- **G3/O3-07.** Sweep пишет thread по одной строке и передаёт `stored_*`, coverage и sync timestamps из чтения до транзакции. Batch и разделение владельцев этих полей полезны; generation остаётся membership-authority для count, overlap, max и finalize. Отдельная таблица должна сохранить atomic checkpoint и erasure fence. [Текущий writer](../../../packages/db/src/repositories/page-dm.ts), [sweep](../../../apps/runtime/src/services/sync/fansly-dm-conversations.ts).
- **O3-05 sketch ↔ FAN06-02.** Пакетные complete notes/alias snapshots пересекаются с нашим предложением. Это отдельная работа от удаления generation indexes, которые тем же O3-05 названы в главной таблице Opus.
- **O3-09 ↔ FAN06-01 — только частичное пересечение.** Diff-write rollup убирает повторные версии результата; interval-edge aggregation убирает лишнее вычисление. Их можно сочетать, но это не один и тот же измеренный выигрыш.

**G5: календарное «всегда вчера, без автоматического догона» подтверждено отдельно.** Новый scheduled collection job строит окно от предыдущей UTC-полуночи до текущей; `last_scheduled_at` проверяет только интервал, а не последнее покрытое число. Например, запуск 10 сентября выбирает 9 сентября; после отсутствия запусков 11–12 сентября возобновление 13 сентября выбирает только 12 сентября. Окна 10–11 сентября автоматически не появятся. При коротком interval несколько завершённых jobs за один UTC-день вновь выберут то же окно. Это относится к операциям, поддерживающим date query; endpoints текущего состояния без date params не получают календарного покрытия. [Планировщик](../../../packages/db/src/repositories/ofapi-read-collections.ts:208), [передача дат](../../../apps/runtime/src/services/ofapi-collection-runner.ts:97).

Это не означает потерю checkpoint каждого незавершённого job: `queued/running/paused` блокирует создание нового, старый target можно продолжить. Но exhausted/429/5xx background run может остаться `failed` с частичным checkpoint, после чего следующий interval создаёт новое вчерашнее окно; runner прямо описывает работу без backlog. Для непрерывной дневной истории нужен отдельный coverage cursor и ограниченный догон. Фактические пропуски, активные категории и повторная оплата здесь не измерялись. [Runner](../../../apps/runtime/src/services/ofapi-collection-runner.ts:338), запись `G5/ofapi-calendar-gap` в [матрице](checks.json).

## Новое и полезное, с ограничениями

**O4-01: механизм `min(...) FILTER (WHERE TRUE)` подтверждён.** PostgreSQL16 `planagg.c` отвергает специальный MIN/MAX path при наличии aggregate filter. Значения MIN, NULL и пустой выборки сохраняются. Для sparse `command_result` regular aggregate может прочитать узкий `(parse_version, source)` диапазон вместо длинного ordered scan с фильтром. Но выбранный index и ускорение зависят от статистики и плотности; на плотном диапазоне отказ от early LIMIT может быть дороже. Сохранённый [`floors_fix_explain.sql`](../../sync-audit-opus-2026-09-13/evidence/O4/floors_fix_explain.sql) содержит **EXPLAIN без ANALYZE**, а его output отсутствует. [PG16 source](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/optimizer/plan/planagg.c#L254-L260).

**O4-03: partial index совпадает с реальным query shape.** `listDmRepairSignalRows` выбирает mismatch fingerprints, сортирует глобально по `id`, затем LIMIT. Индекс по `id` с тем же predicate — конкретный кандидат. Он добавляет цену на переходы material/emitted и сам не решает starvation poison rows. [Query](../../../packages/db/src/repositories/dm-message-candidate.ts:498).

**O4-02a: BRIN summarization — реальный механизм.** Новый диапазон без summary читается; `autosummarize` и `brin_summarize_new_values` могут это исправить. Но `n_ins_since_vacuum` не измеряет число unsummarized ranges, а новые события задним числом могут создавать законно широкие min/max ranges. Обещание «−50%» остаётся гипотезой; задача autosummarize может быть потеряна при заполненной очереди. [PostgreSQL16 BRIN](https://www.postgresql.org/docs/16/brin-intro.html).

**O3-01/O3-05/O3-06: индексы действительно увеличивают цену записи, но DROP требует проверки читателей.** У generation есть реальные max/count/set/finalize readers в `page-dm.ts:301–401`. `idx_scan=0/12` за ограниченное окно не доказывает ненужность. Даже после трёх drops HOT возможен лишь если не меняются оставшиеся indexed fields и на старой heap page есть место. `(run_id, logical_id, attempt_no)` не даёт time order индекса `(run_id, started_at)`, а `(metric, quantile, time)` не равно `(metric, time)` для запросов без ограничения quantile. [HOT условия](https://www.postgresql.org/docs/16/storage-hot.html).

## С чем не согласны

**O3-03 SQL sketch не эквивалентен production upsert.** T1 начинает statement без fan K; T2 вставляет K со значением B и коммитит после snapshot T1; T1 хочет A, но его `INSERT … DO NOTHING` пропускает конфликт. `UPDATE` не видел K, в итоге остаётся B. Текущий `ON CONFLICT DO UPDATE` применяет A. Последующий read-back лишь прочтёт B. Дополнительно sketch теряет absent/NULL distinction; production `fans.ts:80–195` группирует входы по присутствию optional fields. Это SQL-semantics counterexample по коду и документации; PostgreSQL two-session test в этой проверке не запускался. [Sketch](../../sync-audit-opus-2026-09-13/evidence/O3/sketches.sql:60), [PG16 isolation](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED).

**O3-02 нельзя безоговорочно назвать «без изменения смысла данных».** `page_fans.last_seen_at` читается membership dataset как `k_occurred_at` и `f_last_seen_at`. Убрать обновление stale timestamp можно, но время «проверили членство» станет временем последнего реального наблюдения/изменения. O3-04 с 6h окном явно меняет ту же семантику. [Dataset](../../../packages/db/src/repositories/agent-dataset-map.ts:92).

**O3-10 single finished INSERT теряет crash evidence.** Durable started row нужен для зависших attempts. Третий UPDATE bytes выполняется в capture-пути уже после finish; свести в два writes возможно только с явной передачей точного capture-byte measurement. «Каждый HTTP attempt = три записи» тоже неверно для uncaptured failures/retries. O3-11 recovery timestamp нельзя считать бессмысленным: он защищает от поздно пришедшего старого failure.

**O4-02/O7-02 writer-side percentile может поменять метрику.** Сейчас percentile взвешен по событиям, использует окно по `de.created_at`, исключает отсутствие трафика. Один sample на observation, средний p95 процессов или только успешно завершённый callback имеют другую семантику. Нужны совместимые event weights, окна, crash и multiworker aggregation.

## Числа, которые нельзя переносить как измеренные

| Вывод Opus | Что установлено |
|---|---|
| Postgres −35…38%, buffers −70…74% | [`final_table.py`](../../sync-audit-opus-2026-09-13/evidence/O4/final_table.py) умножает доли shapes на **заданные 99%/95%/50%/90%** улучшения. Это модель. Shapes сопоставляются по min/max timings без надёжного query identity. Input snapshots отсутствуют. |
| +60% ядра на вкладку | `total_exec_time / elapsed` — конкурентное время запросов, включающее ожидания; это не CPU. Повторные buffer hits/reads — не уникальные физические обращения к диску. |
| WAL −45…65%, −1.2GB/day на thread indexes | [`model.py`](../../sync-audit-opus-2026-09-13/evidence/O3/model.py) использует фиксированные `HDR=50`, `CYCLES=48`, `FPI_HEAP=3500`, `FPI_IDX=3000`. Snapshot WAL bytes реальны как тип измерения, per-table attribution и эффект правок модельные. Write suppression и checkpoint/FPI changes пересекаются. |
| SQL −8…10M/day от16M | Единой модели непересекающихся операций нет. При округлённых вводах самого отчёта 7400→4600 chunks и60→25SQL независимая сумма даёт427k, совместный эффект329k: **98kSQL/day учтены дважды**. Это иллюстрация ошибки сложения, не измерение production. |
| До100%17–26дней, +11–13GB за неделю | Нет сохранённого ряда free bytes или outputs размеров. Свежие19.218GB — только точка. При крайних growth assumptions самого текста0.62–1.11GB/day получилось бы17.3–31.0дня; это sensitivity scenario, не новый прогноз. |

[PostgreSQL16 определяет отдельно](https://www.postgresql.org/docs/16/pgstatstatements.html) execution time, block hits/reads и WAL. Эти метрики нельзя заменять друг другом. Root подтвердил отсутствие `pg_read_all_stats` у `read_only`, что объясняет скрытые query IDs; это ограничение атрибуции, а не основание считать временные fingerprints надёжными.

**Дефект вычисления delta воспроизведён настоящим скриптом Opus.** В полностью синтетических snapshots одна запись изменилась с10 на11 calls, min снизился100→90ms. `final_table.py` не сопоставил её, поскольку fallback работает лишь при `calls>20`, и приравнял baseline к нулю: получил15840calls/day вместо1440. [Probe](probe.py), [результат](probe-results.json), [stdout скрипта](final-table-synthetic-output.txt). Это доказывает дефект алгоритма; размер ошибки именно в отсутствующих production snapshots неизвестен.

## Диск и нумерация

- **O5-01:** GC существует, default-OFF — deliberate decision#176; менять на default-ON нужно отдельным решением. Сейчас удаляет candidate/rollback, а не все предложенные `production-full-*`; cache threshold в коде168h, предложение72h. Shared image layers требуют расчёта фактически освобождаемых bytes.
- **O5-02:** q14 берёт пять фиксированных диапазонов id, поэтому99.6% не является census августа. Runbook#239 прямо запрещает тратить измеренный на старом prefix dedup как гарантированный headroom discount. +6.1GB и peak2–3GB не подтверждены.
- **O5-03:** retention default30d подтверждён;14d — изменение истории telemetry. DELETE не возвращает filesystem pages; сначала bounded prune должен завершиться, затем отдельно измеренные rewrite/headroom/lock budgets.
- **O5-06:** код действительно имеет warning<30d и critical<7d. «Должен быть открыт» нельзя вывести из внешнего прогноза без внутренней24h series и latch state.
- **O5-09/O5-10:** cold zstd segments и hash-key migration — отдельные проекты. Compression probe600 bodies не подтверждает whole-month recovery; нужны exact lookup/replay/erasure/collision/peak-space контракты. Эти bytes частично относятся к уже предложенным rewrite inventories, их нельзя механически суммировать.

**Идентификаторы:** O3-03/O3-09/O3-10 есть только в SQL sketches, O4-02 — только в evidence labels/proposal; O5-04/O5-08 отсутствуют. O3-05 означает разные работы в main и sketch. O3-11/O3-12/O5-05/O5-07 присутствуют в одной групповой строке без однозначного соответствия четырём действиям. В [checks.json](checks.json) это отражено явно; отсутствующие номера не включать в количество explicit claims исходного отчёта.

Следующая конкретная проверка: paired `EXPLAIN (ANALYZE, BUFFERS)` для O4-01 на empty/sparse/dense families и O4-03 на repair backlog, затем PostgreSQL concurrency oracle для пересмотренного O3-03. Никаких product edits, SSH/SQL production, provider calls, installs или больших tests этот reviewer не выполнял. Запускался только локальный синтетический parser/model probe.

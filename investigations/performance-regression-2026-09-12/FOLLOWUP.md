# Серьёзность находок и дополнительный аудит производительности

12 сентября 2026. **Обе ранее подтверждённые P2 стоит исправить. Логирование параметров — первым, deadlock — в ближайшем исправлении.** Дополнительное ревью двух агентов и координатора нашло существующие источники лишней работы. Их нельзя приписывать последней оптимизации: проверенные участки были в baseline.

## Серьёзность прежних находок

| Проблема | Что реально подтверждено | Приоритет |
|---|---|---|
| Сырые SQL-параметры в PostgreSQL logs | Запись уже происходит; и повторная 30-минутная выборка содержит 7 `DETAIL: parameters`. Конкретные секреты в них не устанавливались. | Исправить первым: ограничение bind logging до нуля сохраняет диагностику медленных SQL. Это прежде всего нарушение границы данных, а не доказанный главный источник CPU нагрузки. |
| Новый alias deadlock | На настоящем PostgreSQL один из пересекающихся autocommit batch calls получает `40P01`, предшествующая запись fans могла уже завершиться. | Исправить устойчивым порядком блокировок. Прерывание работы способно приводить к повторному sync/backfill; частота на production не известна. |
| Старая reaper/finalizer race | Успешный sync run может получить историю `failed`; одинаково воспроизводится до и после оптимизации. | Исправить вслед за двумя P2 для достоверности статусов. Это не установленная причина текущей нагрузки. |
| Первоначальный projection-lag P2 | Снят после проверки commit-order; численное различие не доказывает потерянную тревогу о реальном backlog. | Runtime-исправление по этому контрпримеру не требуется. |

В свежем окне **новых deadlock не обнаружено**: счётчик БД 33 → 33 за 31,1 с, а в PostgreSQL logs за 30 минут нет `deadlock detected`. Исторические 33 нельзя приписать fan writer или последнему deploy. Нулевое короткое окно не доказывает, что race не случается. Environment-флаг fan-identities не задан; таблица boot overrides недоступна `read_only`, поэтому действующее значение feature flag полностью не установлено.

Исправление deadlock должно сохранять no-op suppression. Возвращать прежние безусловные записи и отменять остальные оптимизации по этому finding не требуется. Runtime retry при ошибке имеет ступенчатый backoff 60 секунд → максимум 30 минут; бесконечный немедленный retry loop в этой цепочке не обнаружен.

## 1. Измеренная медленная выдача последних точек метрик

**Наиболее убедительный отдельный SQL-кандидат.** `GET /api/v1/ops/metrics` → [getGoldenSignalsReport](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/services/golden-signals.ts:377) → [listRecentOpsMetricSamples](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/ops-metrics.ts:99), `perSeries=30`.

Запрос строит `row_number()` по `(metric, quantile)` над всей `ops_metric_samples`, а потом оставляет первые 30 точек. Маленький ответ не ограничивает прочитанную/упорядоченную историю. В production-логах найдены **два запроса с точной статической SQL-формой этой функции: 12 931,694 и 10 138,744 мс**. Совпадение проверялось после нормализации whitespace по `row_number() over (partition by metric, quantile order by sampled_at desc)`, `from ops_metric_samples`, `where rn <=`; параметры и текст SQL не выгружались.

Эти запросы могли быть вызваны нашими диагностическими чтениями. Проверка доказывает дорогой путь выдачи метрик, **не** частое зависание обычного пользовательского UI. Прочие slow statements с той же таблицей к этой функции не приписывались.

**Исправлять:** ограничить чтение на уровне каждой серии, с индексом под полный порядок `(metric, quantile, sampled_at)` и корректным способом перечисления серий. Сохранить старые/редкие/переставшие обновляться серии; произвольный cutoff «за последние 30 минут» изменит контракт и может скрыть остановившийся sampler. Конкретный rewrite требует сравнения результатов и PostgreSQL plan/benchmark до применения. Процент экономии CPU не измерен.

Доказательства: [совпадения SQL и длительности](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/followup/known-slow-shapes.json), [скрипт агрегации](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/followup/known-slow-shapes-probe.py). Участок `ops-metrics.ts` не менялся в `c0cd21c3..c76c6db0` и совпадает с production.

## 2. Канонизация многократно возвращается к записям без привязки

За 30 минут worker сообщил 116 736 обработанных строк, **116 533 `skippedUnmapped` — 99,8%**; 30 завершённых sweep имели суммарную wall duration 364 459 мс (максимум 15 053 мс). Сумма длительностей не равна CPU-времени. Это измеренный объём повторяемой работы, а не число уникальных потерянных фактов.

В [driver](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/services/canonicalize-driver.ts:513) загрузка payload, проверка формы и canonicalize идут перед проверкой account binding на строках 552–580. Если drafts требуют аккаунт, а binding отсутствует, тело уже разобрано, но stamp не пишется. Такая запись остаётся допустимой для следующего обхода.

Повторяемость нужна для восстановления после binding repair; ненужную тяжёлую часть можно сократить. Возможный путь — явное состояние ожидания с повторным разбором при изменении привязки/парсера и ограниченной проверкой восстановления. Это требует проекта корректности: данные должны оставаться replayable; нельзя удалять их или ставить terminal parse stamp для уменьшения backlog. Простое перемещение общего `skip` до payload тоже не эквивалентно: для team-level exports account IDs содержатся в payload, а некоторые unmapped формы дают ноль событий и могут штатно помечаться обработанными.

**Приоритет высокий для отдельной оптимизации**, потому что доля безрезультатных посещений на production велика. Точный выигрыш, распределение по source/kind и стоимость decode относительно SQL selection не измерены. Нельзя приписывать все 99,8% earnings lane или описанным ниже двойным проходам.

## 3. Подтверждённые лишние операции с небольшим объёмом исправления

**Отброшенный follower COUNT.** [ensurePageSyncStates](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/page-sync.ts:1542) считает followers до проверки existing states. Для полностью созданных states результат не используется. Минутный planner вызывает ensure напрямую, затем ещё раз внутри schedule; каждый executor preflight делает свой count.

Координатор выполнил реальные repository-функции с recording DB mock: fully seeded page (17 streams), один ensure — 5 SQL, в том числе 1 COUNT и 3 state reads; planner ensure → schedule — **2 COUNT**; следующий executor preflight — ещё 1 COUNT. Изменение count с 50 000 на 999 999 не изменило результат. Это доказательство лишних обращений, не benchmark SQL.

Исправлять: определять missing states до подсчёта, считать только там, где действительно нужен начальный recovery для отсутствующего `followers_reconcile`; убрать повторное полное ensure из уже подготовленной planner-цепочки, сохранив самостоятельный контракт schedule и maintenance cadence/repair. [Probe](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/ensure-seeded-count-probe.mjs), [receipt координатора](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/ensure-seeded-count-probe.log).

**Повторный полный разбор earnings.** [canParse и canonicalize](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/services/canonicalize/fansly-earnings.ts:147) оба вызывают полный parser. В нём создаются агрегаты, сортируются breakdowns, сериализуется JSON и вычисляется SHA256. Один корректный агрегат хэшируется дважды; два monthly-агрегата — четыре раза. Разбор должен один раз возвращать одновременно результат и диагностику, сохранив точную проверку malformed/partial money payload. Локальный диагностический fixture с настоящими driver/parser/registry подтверждает число операций; производственная доля этой lane не измерена.

**Перекрытие unparsed и replay выборок.** В [driver:474](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/services/canonicalize-driver.ts:474) capture pass выбирает `parse_version < 1`, replay pass — `< family.version`, без нижней границы 1. Поэтому unstampable zero-version строки некоторых `prioritizeUnparsed` families проходят оба сканирования и расходуют бюджет replay. Исправление — непересекающиеся выборки для этого режима с сохранением отдельных cursors и fairness; CLI/replay без приоритизации не должен потерять возможность обрабатывать version 0. Координатор независимо выполнил пять диагностических сценариев с настоящими driver/parser/registry, все прошли. В том числе mapped malformed parse0 занял обе страницы; следующая корректная version6 в этом тике не обрабатывалась. Бесконечное starvation этим примером не доказано. [Дополнительное pipeline-ревью](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/additional-pipeline-performance.md), [fixture](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/pipeline-repeated-work-diagnostic.cjs), [receipt координатора](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/pipeline-repeated-work-diagnostic.json).

## Другие кандидаты — отдельная проверка перед исправлением

- Preview десяти сообщений вызывает полный sync monitor страницы для всех 17 streams и несвязанных totals, а использует только `messages_live`/`messages_history`. Минимальное сужение — два DM streams; остальные подсчёты надо убирать с сохранением coverage, active siblings и старого unresolved attempt debt. Латентность конкретного preview не измерена.
- При потере lease локальный `leaseFenced` не доходит до уже начатого physical HTTP retry loop. Возможны новые попытки после потери владения и последующее отбрасывание результата. Business writes fenced; бесконечный retry или запись под чужим lease не заявлены. Перед patch нужен targeted тест отмены во время rate wait/retry delay.

[Полное дополнительное sync-ревью](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/additional-sync-performance.md). Эти пункты не используются как доказательство текущего production-инцидента.

## Свежий снимок и границы измерений

19:36 МСК, production `31b73a9691f3`, те же контейнеры, без рестартов. За 31,1 с средний расход PostgreSQL — 0,464 CPU-core, worker — 0,122, API — 0,012, scheduler — 0,006; host load 1.12/1.08/1.03. Краткий снимок не показывает прежнюю постоянную перегрузку.

Суммарные index fetch по июльской/августовской/сентябрьской observations за окно составили около 18,1 млн. Это счётчики обращений, не уникальные строки и не физические disk reads. Они показывают существенную оставшуюся работу с журналом, но не дают распределение стоимости по запросам. У `page_follows` примерно 51,7 тыс. live tuples и +123,9 тыс. index fetch; это все обращения к таблице, их нельзя целиком приписать follower COUNT. За окно создано 3 sync runs.

`pg_stat_statements` уже установлен, stats_reset 13:02:48 UTC. Роль `read_only` видит числовые агрегаты, но query/queryid рабочих запросов скрыты. Поэтому точный query ranking по этому источнику не заявлен. Права не расширялись. SQL выполнен только этой ролью, с read-only default и короткими таймаутами; Docker logs обрабатывались в агрегаты без выгрузки SQL-параметров. На production ничего не изменялось.

- [Снимок всех агрегатов](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/followup/production-performance-snapshot.json)
- [Краткие дельты](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/followup/production-performance-summary.json)
- [Видимые statement stats и ограничения](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/followup/statement-stats-snapshot.json)
- [Агрегат slow-query logs](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/followup/slow-log-aggregate.json)

Рекомендуемая последовательность: закрыть logging и alias deadlock; оптимизировать дорогую выдачу метрик; убрать простые лишние COUNT/повторный parse; отдельно спроектировать ожидание binding repair и устранение пересекающихся scan passes. Каждое изменение проверять на сохранение результатов и на стоимость до/после. Runtime-код в этой проверке не менялся.

# Проверка регрессий после оптимизации Hub

Обновлено 12 сентября 2026 после трёх независимых ревью кода и проверки их выводов координатором. **Подтверждены две новые проблемы P2: изменение порядка блокировок при записи username aliases и запись сырых SQL-параметров после включения slow-query logging.** Исправления, коммиты и изменения production не выполнялись.

Первоначальный P2 о «пяти минутах очереди, отображаемых как 15 секунд» **снят**. Контрпример доказывает изменение численного определения метрики, но не пропуск тревоги о реальном ожидании уже зафиксированных событий. Этот отчёт заменяет первоначальное заключение.

## 1. P2 — новый порядок записи aliases создаёт deadlock

Место: [fans.ts:199](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/fans.ts:199), построение alias batch на строке 202 и INSERT на строке 213.

После условного upsert массив `rows` сначала содержит изменённые записи из `RETURNING`, затем к ним добавляются неизменённые записи из отдельного SELECT. Этот массив используется для записи `fan_username_aliases`. Возврат исходного порядка результата на строке 229 происходит уже после записи aliases и не исправляет порядок блокировок.

Два пересекающихся вызова получают одинаковый порядок входных фанатов `[A, B]`. Первый меняет только A; после его записи в `fans` второй меняет только B. Новая реализация строит alias batches `[A, B]` и `[B, A]`. При autocommit блокировки `fans` уже отпущены, поэтому оба alias INSERT могут взять разные первые строки и взаимно ждать вторую. Даже пропущенный `ON CONFLICT DO UPDATE WHERE` берёт блокировку конфликтующей строки.

| Реализация | Порядок alias INSERT | Результат контролируемого пересечения |
|---|---|---|
| До оптимизации, `c0cd21c3` | `[A, B]` / `[A, B]` | Оба вызова завершились |
| После оптимизации, `c76c6db0` | `[A, B]` / `[B, A]` | Один вызов завершился, второй получил PostgreSQL `40P01` |

Координатор дважды выполнил fixture с реальными старой и новой `upsertFans` на PostgreSQL 16 со штатными миграциями. Последний запуск — 2/2 теста, 4.86 с: «passed» означает успешное воспроизведение ожидаемого deadlock в новой версии. SQL не переписывается: тест только удерживает выполнение перед alias statement и перед второй строкой. После снятия тестового gate цикл состоит из обычных блокировок aliases, а не advisory locks.

**Воздействие и достижимость.** Прерывается вызов sync/backfill, тогда как предшествующие записи `fans` могли уже закоммититься; следующий шаг membership/checkpoint не выполняется в этом вызове. Bulk-пути без внешней транзакции есть в [ofapi-fan-identities.ts:98](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/services/sync/ofapi-fan-identities.ts:98) и [fansly-page-alias-backfill.ts:98](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/apps/runtime/src/services/fansly-page-alias-backfill.ts:98). OFAPI fan-identities lane по умолчанию выключен; его текущее production-состояние не проверялось. Большинство обычных sync writers используют внешнюю транзакцию и удерживают блокировки `fans` до завершения aliases, поэтому finding не означает, что любой параллельный sync падает. Production-частота и необратимая потеря данных не установлены.

**Направление исправления:** канонический порядок `(fanId, username)` перед alias INSERT независимо от изменённых/пропущенных строк; повторить контрольный сценарий с ожиданием успеха обоих вызовов. Проверить порядок всех писателей этой таблицы, а не ограничиться перестановкой публичного return.

Доказательства: [полное ревью fan writers](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/fan-writes.md), [fixture](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/audit-fan-alias-concurrency.integration.test.ts), [лог с порядком строк и SQLSTATE](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/fan-alias-concurrency.log).

## 2. P2 — slow-query logging записывает сырые bind-параметры

Изменение конфигурации описано в [Decision 293, строка 12349](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/docs/decisions.md:12349). В снимке до оптимизации `log_min_duration_statement=-1`: [диагностика 11 сентября, строка 551](/Users/dmitriy/code/goose/hub/docs/diag/2026-09-11-agency-hub-load/reports/report-astra.md:551). После оптимизации на production установлены:

```text
log_min_duration_statement = 2000 ms
log_parameter_max_length = -1
log_parameter_max_length_on_error = 0
log_statement = none
```

Снимок 12 сентября, 19:25 МСК: среди 566 строк PostgreSQL Docker logs за 30 минут обнаружены **7 строк `DETAIL: parameters`**, максимальная длина 2952 символа. Сами значения не выгружались. Это подтверждает активную запись raw parameters, но не раскрытие конкретного пароля, prompt/completion или тела сообщения.

`log_parameter_max_length=-1` разрешает полные bind-значения для non-error logs, включая записи по длительности; `0` отключает их. Отдельная настройка `*_on_error=0` и `log_statement=none` не закрывают этот канал. Семантика проверена по [документации PostgreSQL 16](https://www.postgresql.org/docs/16/runtime-config-logging.html).

Существующий до оптимизации [канон server logs](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/docs/error-handling.md:387) запрещает raw SQL parameters. Pino redaction действует внутри runtime, тогда как PostgreSQL пишет stderr напрямую в Docker logging driver. В SQL-параметрах приложение передаёт в том числе JSON observations и restricted AI content; это объясняет риск, но не доказывает, что конкретное содержимое уже оказалось в выбранной выборке.

**Направление исправления:** постоянно установить `log_parameter_max_length=0`, сохранив slow-query threshold 2000 ms и `log_parameter_max_length_on_error=0`. Затем проверить реальные настройки рабочих соединений и отсутствие bind-значений в новых логах именно медленных параметризованных запросов. Ноль отключает bind logging, но не очищает произвольные SQL-литералы. Конфигурация production и уже записанные логи в этом аудите не менялись.

Доказательства: [безопасный агрегированный снимок](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/postgres-log-boundary.json), [независимая оценка цепочки логирования](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/postgres-log-assessment.md).

## Что снято и что существовало раньше

**Снят P2 о projection lag.** `created_at DEFAULT now()` — время начала транзакции, а не commit. Более ранняя транзакция может получить более поздний `account_seq`, поэтому прежний минимум timestamps и timestamp первой pending seq численно расходятся. Однако appender удерживает блокировку account-seq до commit: первая pending seq зафиксирована не позже следующих. Её `created_at` не позже её commit, поэтому новый возраст остаётся верхней оценкой ожидания самой ранней зафиксированной строки. Пример «300 с → 15 с» мог включать 285 с до доступности позднего события проектору; реальный backlog в нём не доказан.

Проверены обычные append, внешние транзакции, replay/backfill, repair, tiering restore и erasure. Поддерживаемый writer, нарушающий описанный порядок commit/seq, не найден. Первоначальный падающий тест сохранён как численный контрпример, **а не как доказательство функциональной регрессии**. Исторические значения gauge до/после не полностью сопоставимы; определение полезно уточнить в документации. Возврат полного сканирования по этому finding не обоснован. [Полная проверка цепочки событий](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/event-pipeline.md).

**Старый P2 — cleanup может перезаписать успешное завершение sync run.** Если finalizer уже обновил строку и держит её блокировку, а reaper выбрал её по старому snapshot как running/inactive, после commit finalizer-а cleanup пишет `failed` поверх `succeeded`. Внешний UPDATE не перепроверяет `outcome = running` на актуальной строке. Реальный SQL воспроизведён в трёх вариантах: baseline без 0184, baseline с 0184 и текущий код с 0184; результат одинаков. Это дефект истории результата/времени запуска, не новая регрессия оптимизации и не откат checkpoint/бизнес-данных. [Ревью](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/sync-queries.md), [fixture](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/sync-finalize-race-repro.mjs), [результат](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/sync-finalize-race.log).

**P3 — неверная мотивировка DM shadow timeout.** Комментарий в [fansly-dm-shadow.ts:58](/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912/packages/db/src/repositories/fansly-dm-shadow.ts:58) и Decision 293 приписывают 5 s timeout предотвращение полных обходов. Сейчас это shadow-диагностика: реальная пагинация продолжается и после успешной виртуальной остановки. Изменение повышает шанс получить диагностику и может потратить больше бюджета chunk, но сокращение provider-запросов этим кодом не доказано. Это замечание к описанию; потери данных или нового обхода fencing не найдено.

## Объём ревью и независимая проверка

Исходная папка `/Users/dmitriy/code/goose/hub` находится на `b48f173d` и содержит незавершённые материалы пользователя. Исполняемые исходники проверялись в отдельном checkout:

`/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912`

HEAD — `c76c6db06ce1c25e469ca07ec62762e248870f44`, релиз #175. Baseline основных оптимизаций — `c0cd21c3`; для оптимизации completed-run query дополнительно проверен `b48f173d..c0cd21c3`.

Production работает на `31b73a9691f3`, а не squash-коммите #175. Семь файлов запросов/потока/индексов побайтно совпадают с audit HEAD; отличие `fans.ts` относится к дополнительным диагностическим счётчикам follower reconcile, а не оптимизированным writers. Дополнительный UI-код production полностью не ревьюился.

| Участник | Прочитанный код и границы | Итог |
|---|---|---|
| Reviewer fan writes | Четыре writer-функции, callers/транзакции, NULL и omitted поля, alias history, freshness, erasure и triggers | Найден новый alias deadlock; другие подозрения проверены и отсеяны |
| Reviewer event pipeline | Append/seq/commit, SSE live/replay/retention, projection watermarks, canonicalization, restore/erasure | Новых регрессий не подтвердил; опроверг прежний operational P2 |
| Reviewer sync queries | Running/completed SQL, callers, OFAPI recency, shadow timeout/budget/lease, migrator/indexes | Новых runtime-регрессий не подтвердил; нашёл старую reaper race и неточный комментарий |
| Координатор | Проверка выводов по исходникам, serial PostgreSQL reproductions, сравнение baseline/head, production health/config/logging | Подтвердил два новых P2 и происхождение старой race; исправил ложноположительный вывод |

Агенты не запускали конкурирующие DB suites. Координатор выполнял PostgreSQL проверки последовательно.

## Выполненные тесты

| Проверка | Результат и трактовка |
|---|---|
| `pnpm check` | 296 файлов, 3258 тестов прошли, 9 существующих skips; lint и сборка прошли |
| Проверка типов | Штатный ratchet прошёл с бюджетом 1901 существующей ошибки; это не чистый `tsc` |
| 16 существующих интеграционных suites | 124 теста прошли, без skips, PostgreSQL 16 со штатным migrator |
| 4 первоначальные дополнительные проверки | 3 passed / 1 failed: fan identity/membership equivalence и timestamp inversion подтверждены; падение касается прежнего численного определения gauge, P2 снят |
| Контроль на старом `golden-signals.ts` | 4/4 passed; подтверждает изменение численного результата, не потерю реальной тревоги |
| Новый alias concurrency fixture | Дважды 2/2 passed: старая версия завершает оба вызова, новая воспроизводит `40P01`; второй receipt содержит точные порядки alias IDs |
| Reaper/finalizer race | Три сценария на реальном SQL завершились одинаково: baseline с/без 0184 и текущий код; старый дефект |

Начальный общий интеграционный receipt содержит 127 passed / 1 failed в 17 файлах. Его не следует читать как «одна подтверждённая runtime-регрессия»: интерпретация последнего assertion пересмотрена после анализа commit-order.

Проверены SSE replay/live, account scope, erasure gaps, hidden events/checkpoints, конкурентные append; sync activity и completed payload; fan identity/membership/aliases, explicit NULL и omitted поля, auto-renew; recency с pending/type filters и пустыми страницами; DM shadow fallback. Новые fixtures остаются исследовательскими артефактами вне основной тестовой ветки. Базовый writer извлечён из `c0cd21c3`.

## Состояние production и пределы аудита

Read-only снимок 12 сентября, 19:14–19:19 МСК; отдельная проверка логирования — 19:25 МСК.

- API, worker и scheduler здоровы, одна ревизия, `RestartCount=0`. Health, защищённый sync health и ops metrics возвращают HTTP 200; 8 страниц, 0 unhealthy, 0 failed/stalled streams.
- Свободно 22 ГБ из 79 ГБ, load average 1.36/0.83/0.93, доступно около 3.9 ГБ RAM. Это краткий снимок, не длительный нагрузочный тест.
- Индексы `sync_runs_running_idx` и `ofapi_webhook_events_page_received_idx` существуют, valid/ready. Параметры производительности соответствуют Decision 293, `pending_restart=false`; настройки durability `fsync`, `full_page_writes`, `synchronous_commit` включены. Отдельно обнаружен описанный выше дефект bind logging.
- Smoke consumer: 19:17:19 → 19:18:49 МСК, `framesSeen` 1379405 → 1379417, `gapCount` 2781 → 2781, `duplicateCount` 0 → 0. Новых пропусков/дублей в этом окне нет; исторический gapCount не равен нулю.
- Capture p95 около 1.8 с, canonicalize около 56.9 с, projection около 55 с; pull sync backlog снизился с 51.6 с до 0. Краткий здоровый снимок не исключает редкую race.
- В просмотренном окне логов текущих контейнеров не найдено level=error/API 5xx. Сохраняется `obs_backlog_webhook_ofapi_v5`, возраст около 69.6 суток. Предыдущая [диагностика](/Users/dmitriy/code/goose/hub/docs/diag/2026-09-11-agency-hub-load/reports/report-astra.md:1427) уже содержала ту же серию с возрастом 68.7 суток. Это отдельный старый хвост; его причина здесь не расследовалась.
- Исторические `recentFailedRuns=6` и `recent5xxs=1271` в sync health не атрибутированы текущему deployment.

SQL на production выполнялся только ролью `read_only`, с read-only transaction default и таймаутами statement 5 s / lock 1 s. Доступ к sync_runs, watermark, smoke и ops-таблицам этой роли запрещён; доступ не расширялся. Smoke/метрики прочитаны через штатный защищённый HTTP endpoint. Параметры SQL из логов не копировались. Полная историческая сверка бизнес-данных, длительный soak, статистическая оценка deadlock и interruption/rerun chaos-test миграции 0184 не выполнялись.

## Артефакты и воспроизведение

- [Полный check](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/pnpm-check.log)
- [Начальный интеграционный receipt](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/integration.log)
- [Контроль старого определения gauge](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/baseline-counterexample.log)
- [Первоначальные исследовательские тесты](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/performance-regression-audit.integration.test.ts)
- [Production snapshot](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/production-snapshot.json)
- [Метрики до](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/production-metrics.json) и [после](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/production-metrics-followup.json)
- [Read-only probe](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/production_probe.py)
- [Ревизии, трактовка проверок и хеши артефактов](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/validation-manifest.json)

Из audit checkout, по одному процессу:

```sh
pnpm exec vitest run tests/audit-fan-alias-concurrency.integration.test.ts --maxWorkers=1 --no-file-parallelism
node /Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/sync-finalize-race-repro.mjs --run-local
```

Рабочие исходники релиза восстановлены до HEAD; tracked source diff пуст. Добавлены только исследовательские fixtures и отчёты. Утверждение «регрессий нет» по итогам проверки делать нельзя: два описанных P2 требуют исправления.

## Дополнение: серьёзность и следующий резерв производительности

По следующему запросу пользователя два агента и координатор дополнительно проверили источники лишней работы, сняли свежие production-агрегаты и выполнили два диагностических набора. [Оценка серьёзности и порядок исправлений](/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/FOLLOWUP.md). Новые дополнительные performance-кандидаты отделены от регрессий последней оптимизации.

# Latest metrics: что измерено и что можно измерить

Подготовлено 2026-09-12. Этот агент не подключался к VPS, не выполнял SQL/API на
production, не запускал Docker или тестовые наборы. Изменены только артефакты
investigation; release code, Git-коммиты и production-права не изменялись.

## Текущая граница доступа

В `postdeploy-first.json` (20:05:58 UTC) уже зафиксированы:

- `read_only`: `permission denied for table ops_metric_samples`;
- новый индекс `ops_metric_samples_series_time_idx`: valid и ready;
- размер индекса: 199 892 992 байта, около 190.6 MiB.

Поэтому **production A/B старого и нового SQL пока не выполнен**. Не нужно
повторять ошибочный EXPLAIN, выдавать новые права или выполнять диагностический
SQL под приложением. Индекс создаёт дополнительную стоимость хранения и записи;
локальное ускорение чтения само по себе не доказывает снижение общего CPU/WAL.

## Точный SQL и семантика

`metrics-capture-exact-queries.cjs` прочитал `ops-metrics.ts` через `git show`
для base `31b73a9691f32f8c33c3fe479bca68533c7048d6` и release
`96a86c1fcdde841b781c9bf9ea4218419900e8ff`. Каждая настоящая функция
`listRecentOpsMetricSamples` была вызвана с `{ perSeries: 30 }` и заглушкой
`db.execute`, которая только сняла SQL через установленный Drizzle PgDialect.
Подключений к БД нет. По одному statement на ревизию, параметры `[30]`.

Результат и source hashes: `metrics-exact-query-pair.json`. Новый SQL побайтно
совпадает с прежним `metrics-release-query.json`. Старый SQL действительно
содержит `row_number() over (partition by metric, quantile order by sampled_at
desc)` и `rn <= $1`; это исходный запрос, а не вручную подобранный эквивалент.

Оба запроса возвращают до 30 последних записей каждой хранимой пары
`(metric, quantile)`, включая редкие и давно не обновлявшиеся серии. Порядок:
metric ASC, quantile ASC, sampled_at DESC. Старый запрос не определял выбор
между равными timestamps; новый сохраняет эту неопределённость. SQL-проба
сравнивает число строк, но EXPLAIN не возвращает значения и сам по себе не
доказывает равенство результатов. Оно отдельно проверено локальным benchmark.

## Подготовленная SQL-проба

`metrics-production-pair-probe.py` самодостаточен для запуска через Python stdin:

- Проверяет release revision и health API/worker/scheduler.
- PostgreSQL доступен только через `docker exec ... psql -U read_only`.
- Сессионные ограничения: read-only по умолчанию, statement timeout 5s,
  lock timeout 1s, idle-in-transaction timeout 10s. Настройки сервера/роли не меняет.
- Одна `REPEATABLE READ READ ONLY` транзакция; перед PREPARE/EXPLAIN проверяет
  `has_table_privilege`, ожидаемую таблицу и valid/ready индекс. При текущих ACL
  возвращает `skipped: read_only_has_no_select_on_ops_metric_samples` и ноль EXPLAIN.
- В случае допустимых предпосылок делает новый EXPLAIN первым, старый — ровно
  один раз. Это не даёт полному старому скану заранее прогреть новый запрос.
  Оба SQL остаются параметризованными, через первый EXECUTE подготовленного
  statement с N=30; тип `$1` выводит PostgreSQL.
- SAVEPOINT перед старым запросом позволяет после его тайм-аута корректно
  завершить транзакцию и сохранить уже полученный новый план. Старый запрос
  не повторяется, включая timeout/failure.
- Сохраняет исходные JSON-планы, фактические executor rows, root buffer counters,
  planning/execution time и идентификатор snapshot в начале и конце.

Сравнение идёт **на новой схеме, где индекс доступен обоим запросам**. Это
сравнение формы запроса на одинаковых данных, не воссоздание старой production
схемы. Для прежней схемы нельзя удалять индекс на production.

Execution Time — инструментированное время выполнения, включая ожидания, не
CPU time. Если старый запрос не уложился в 5s, это только незавершение statement
в пределах бюджета; нельзя выдавать 5s за измеренный минимум CPU/executor time.
Scan rows — приблизительное число кортежей по Actual Rows/filters × loops;
PostgreSQL округляет средние на повторяемых узлах, а внутренние шаги B-tree
здесь не считаются. Root buffers уже включают дочерние узлы: суммировать уровни
плана нельзя. Hits — повторные обращения, не уникальные страницы; reads могут
обслуживаться OS cache, а не физическим диском. Один запуск не даёт p95.

## Штатное API: можно измерить текущий отклик

`GET /api/v1/ops/metrics`, SDK operation `opsMetrics`, использует
`x-monitoring-token` / `HEALTH_SYNC_MONITORING_TOKEN`, как проверка sync health
в deploy script. Маршрут вызывает `getGoldenSignalsReport`, затем точный
`listRecentOpsMetricSamples(..., { perSeries: 30 })` и один SELECT smoke checkpoint
по id=1. Это фиксированный read endpoint; произвольного SQL в нём нет.

Исходники release: `apps/runtime/src/modules/ops/index.ts:434`,
`apps/runtime/src/api/request-auth.ts:192`,
`apps/runtime/src/services/golden-signals.ts:374`,
`packages/contracts/src/routes.ts:5607`, `packages/sdk/src/operations.ts:208`.
У Agent CLI `hub` отдельной команды для этой monitoring operation нет.

`metrics-api-latency-probe.py` подготовлен для root review и запуска:

- читает только точный ключ токена из `/opt/agency-hub/.env.production`, не
  исполняет содержимое файла, не печатает его и не передаёт секрет в argv;
- делает loopback HTTP на `127.0.0.1:3000`; redirects и env HTTP proxies отключены;
- один прогрев и пять измерений, пауза 1s, socket timeout 5s, максимум body 2 MiB;
- прекращается после первой ошибки; не вызывает retries;
- сохраняет status, latency, bytes, количество samples/metrics/series и предел
  30 samples на серию; тела, токены и названия отдельных серий не печатает;
- отчёт: min/median/max пяти запросов, не p95 и не отношение старой и новой версии.

Это текущее время HTTP+авторизация+pool wait+два DB reads+JSON, измеренное на VPS.
Оно не включает сеть внешнего пользователя и не изолирует latest-metrics SQL.
Для A/B скорости нужен старый сопоставимый замер; для общего разгружения сервера —
сопоставимые окна CPU/IO/WAL и входной работы. Нельзя превращать этот API замер
или снижение прочитанных строк в процент экономии CPU всего VPS.

## Уже существующий локальный результат

`metrics-final-benchmark.json`: PostgreSQL 16, 1 000 002 записи, 22 серии,
N=30, 602 выходные строки, точные результаты совпадают.

- Старый SQL: 88.627–96.447 ms; новый: 0.475–0.613 ms в трёх локальных прогонах.
- Executor scan rows: 1 000 002 → 617 (примерно на 99.94% меньше).
- Root shared block references: 10 622 → 154 (примерно на 98.55% меньше).

Это сильное подтверждение устранённого сканирования истории в данном fixture,
но оно не является production latency или общей экономией CPU. Дополнительный
populated-migration контроль хранится отдельно в `metrics-populated-control.json`.

Оба Python helper прошли только статический разбор синтаксиса; они не
исполнялись этим агентом. Root должен прочитать helper перед запуском.

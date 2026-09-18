# Независимое ревью sync / OFAPI recency / DM timeout / 0184

Проверено 2026-09-12: `b48f173d` → `c76c6db0` в worktree `/Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912`. Включено изменение выбора завершённых запусков `c0cd21c3`. Основа ревью — diff, ограничения схемы, вызывающие функции, транзакции, lease/recovery и мигратор. Дополнительно root-agent последовательно запустил подготовленную здесь concurrency fixture в отдельной локальной Postgres 16 БД; receipt прочитан reviewer-ом. Production этим reviewer не изменялась; параллельные Vitest/Testcontainers не запускались.

**Вердикт: новой подтверждённой поведенческой регрессии в данном блоке не найдено.** Отдельно воспроизведён старый P2: cleanup может перезаписать успех конкурентно завершающегося run. Также найдена неверная мотивировка изменения timeout; это замечание к комментарию/решению, не доказательство потери данных или деградации пользовательского сценария.

## P3 — timeout ошибочно описан как средство уменьшения полного обхода

- Изменённый комментарий: `packages/db/src/repositories/fansly-dm-shadow.ts:57–60`, особенно `:58`: отмены проверки якобы «forced the full sweep each time».
- Та же формулировка в `docs/decisions.md:12342–12344`.
- Реальная цепочка: allowlist включает только shadow (`apps/runtime/src/services/sync/fansly-dm-conversations.ts:256`, `:325`); material read выполняется в `:575`, его результат попадает в `materialConfirmed` / lag diagnostics (`:875–878`), далее в `advanceDmShadow` (`:920`) и в статус отчёта (`:1221–1233`). `readDmShadowMaterial` возвращает `null` при отказе (`dm-shadow-material.ts:9–14`). Результат не управляет завершением реального обхода.
- Реальное destructive finalization зависит от provider total и membership certification (`fansly-dm-conversations.ts:1083–1094`). Внешний цикл продолжает пагинацию до `page.done` либо исчерпания бюджета; виртуальный stop применяется только к диагностике. Decision 284 прямо закрепляет это (`docs/decisions.md:11899–11905`: полный обход идёт и после виртуальной остановки).
- Следствие: timeout 5 s повышает шанс получить полный диагностический отчёт ценой более долгого ожидания. По этому коду нельзя приписывать ему сокращение числа страниц/provider HTTP-запросов. Исправить комментарий и мотивировку решения; обязательного runtime-исправления этот finding не доказывает.

## Проверенная эквивалентность SQL

### Активность running runs

`packages/db/src/repositories/sync.ts:405–477` (`closeInactiveSyncRuns`) и `:1656–1728` (`listRunningSyncRuns`).

- В исходном коде `max(coalesce(finished_at, started_at))` и `max(emitted_at)` вычислялись для каждого сохранённого run, затем присоединялись к running runs. Теперь тот же набор дочерних строк агрегируется отдельно для каждого running run. Формула времени активности, строгое `< inactiveBefore`, классификация `checkpoint_advanced → partial`, остальные `failed`, поля UPDATE и результирующие счётчики сохранены.
- Для run без дочерних строк старая отсутствующая GROUP BY-строка и новая строка с NULL scalar aggregate дают тот же `coalesce(..., sr.started_at)`. Незавершённый HTTP attempt по-прежнему учитывается через `started_at`; поздно завершившийся ранний attempt не теряется, поскольку агрегируется finish/start timestamp, а не первый/последний ID.
- Page scope, сортировка `started_at ASC, id ASC` и limit CLI-watch сохранены. Отдельный running-set CTE может включать другие страницы, но конечная выборка применяет исходный page filter; их activity к выбранной странице не присоединяется.
- Вызывающие пути: planner cleanup с порогом 90 s (`apps/runtime/src/services/sync/planner.ts:26–38`) и `getStatusWatchSnapshot` (`apps/runtime/src/services/sync.ts:97–121`). Это не изменение durable `page_sync_states`, контрольной точки, генерации либо владения lease.
- Индексы дочерних таблиц `(sync_run_id, started_at)` и `(sync_run_id, emitted_at)` существуют с baseline migration. Новый partial index сокращает поиск running set; его predicate не меняет SQL-условие отбора.

**Отдельный P2, существовавший до оптимизации — cleanup перезаписывает конкурентно завершившийся run.** У обоих вариантов внешнее UPDATE соединяется с вычисленными кандидатами по ID, без повторного `sr.outcome = 'running'` в WHERE целевой строки (`sync.ts:457–464`); `finishSyncRun` также обновляет по одному ID (`:319–338`). Достижимый trigger: run на snapshot reaper-а старше inactivity cutoff; finalizer уже держит UPDATE-lock и ещё не закоммитил успешное завершение; reaper ждёт, finalizer commit, после чего reaper записывает `failed` и собственный `error_summary` поверх успеха. Последствие — неверная история результата/времени завершения в мониторинге и CLI; это не откат бизнес-данных или checkpoint.

Root-agent запустил `sync-finalize-race-repro.mjs` последовательно на локальном Postgres 16. В `sync-finalize-race.log` **все три** варианта — baseline без 0184, baseline с 0184 и candidate с 0184 — вернули `outcome=failed`, финальный `finished_at=2026-09-12 12:00:00+00`, `error_summary=Sync run auto-closed after inactivity`, хотя finalizer записывал `succeeded` с `12:00:01Z`. Это прямое подтверждение inherited race, а не новой регрессии запроса/index. Fixture извлекает реальные SQL baseline/head, требует `--run-local`, создаёт и удаляет свой localhost-контейнер; production URL не принимает. Команда из audit worktree: `node /Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/reviews/sync-finalize-race-repro.mjs --run-local`. Одно воспроизведённое interleaving не доказывает эквивалентность всех возможных гонок.

### Последний завершённый run в мониторе

`sync.ts:2267–2298`.

- Фильтры visible pages, requested streams, `outcome <> running`, `finished_at IS NOT NULL`, а также `finished_at DESC, id DESC` сохранены.
- Winner ID и загрузка payload выполняются **в одном SQL statement**. Между ними нет отдельного сетевого вызова/нового snapshot, поэтому concurrent finish, update stats либо удаление истории не создают новую возможность выбрать ID из одного состояния, а payload из другого.
- `sync_runs.id` — первичный ключ; дополнительный join не размножает строки. Поля source/status/duration/stats/error читаются с того же winner. Старая история, а не только `windowStart`, по-прежнему участвует в выборе последнего завершения.
- Пустые pageIds/streams завершаются до SQL (`:2047–2052`). NULL source сохраняет fallback `scheduled`; terminal run с NULL finish и running run с ошибочно заполненным finish по-прежнему исключены. Duration clamp и отображение `succeeded → success` сохранены.
- Исторические physical-attempt debt CTE не урезаны до running set. Это отдельные расчёты; новый выбор completed payload их не меняет. Вызывающие `sync-monitor` и `sync-status` получают прежнюю форму строки.

### OFAPI max(received_at) → per-page backward probe

`packages/db/src/repositories/ofapi.ts:377–444`, `:2966–2993`; `schema.ts:3201–3269`.

- `received_at` — `NOT NULL` (`schema.ts:3242`), поэтому `MAX(received_at)` равен `ORDER BY received_at DESC LIMIT 1`; отличие PostgreSQL NULL ordering здесь недостижимо в корректной схеме.
- Оба варианта исключают именно `status = pending`, а не все failed/skipped. Это сохранённая семантика, а не новая классификация успешного ingest.
- Event-type filter попадает внутрь lateral probe до LIMIT. Много новых событий другого типа не подменяет старый matching DM event. Равные timestamps дают одно и то же возвращаемое время; ID tie-break не нужен, поскольку другие поля не возвращаются.
- Empty pageIds/eventTypes возвращают пустую Map до формирования VALUES/IN. Страница без matching rows даёт LEFT JOIN NULL, который удаляется при нормализации Map. Дубли pageIds дают повтор того же значения, Map схлопывает их как раньше.
- `platform_account_id IS NULL` (непривязанный/удалённый page) не начинает матчиться. Очистка привязки/erasure не расширяет scope. Привязка и timestamp читаются внутри одного SQL snapshot.
- Вызывающие `getOfapiWebhookStatus` и `getSyncStatusSnapshot` используют `.get(page.id)`; возможное отличие порядка заполнения Map не меняет их ответы.

Ограничение производительности: «one bounded backward index probe» означает один probe на страницу, **не фиксированное число просмотренных строк**. Новый индекс не включает status/event type в ключ. Если у страницы нет matching event или очень длинный хвост pending/других типов, probe может пройти весь её диапазон с heap checks. Это повод измерить редкий/нулевой matching feed; без такого измерения нельзя объявить performance regression относительно прежнего полного агрегирования. Row-semantics при этом сохранена.

## Timeout, бюджеты, lease, erasure и recovery

- SQL timeout изменён с 500 ms на 5 s только для shadow material read. `SET LOCAL` живёт внутри собственной `db.transaction` и не переносится на pooled connection после commit/rollback. Отказ возвращается в catch как unknown diagnostics, а не success/absence. Report writer сохраняет 500 ms statement timeout и 100 ms lock timeout (`fansly-dm-shadow.ts:18–21`).
- Check расположен после raw capture (`fansly-dm-conversations.ts:442–455`), перед бизнес-транзакцией (`:933`). Поэтому cancellation read не откатывает уже journaled provider response и не держит бизнес-транзакцию/lease row lock дополнительные 5 s.
- `SyncChunkBudget`: 5 запросов, 45 s wall clock (`chunk-budget.ts:10–12`), время БД входит в elapsed. Более долгое ожидание может уменьшить число страниц/optional hydration в одном chunk; это реальная цена изменения. Проверка бюджета является admission check, не жёсткой отменой уже полученной страницы. Страница сохраняет checkpoint, затем цикл уступает и продолжает с сохранённого offset (`fansly-dm-conversations.ts:1368–1373`).
- При пропущенном optional head repair код сохраняет прежний head для retry (`:814–816`, `:897`), а не объявляет неизвестный новый head полностью полученным.
- Runtime heartbeat и page lease heartbeat идут каждые 30 s; lease TTL 120 s (`executor.ts:74–75`, `:632–657`). Асинхронный SQL не блокирует Node event loop. Завершение проверяет `leaseFenced` и conditional completion. Бизнес-транзакция дополнительно проверяет актуальное владение перед работой и перед commit с row lock (`repositories/sync-context.ts:106–111`).
- Пагинационная бизнес-транзакция сохраняет существующий shared erasure fence (`fansly-dm-conversations.ts:942`), deferred branch не продвигает offset. Shadow read не является доказательством membership и не обходит finalization guards.
- pg-boss hard expiry 900 s и safe handoff reserve 60 s сохраняются (`sync-queue.ts:19`, `executor.ts:77`, `:1142–1164`). Пять секунд не создают нового сравнения с коротким outer request timeout. Pool acquisition не ограничен этим statement timeout — это прежнее свойство, поэтому утверждать жёсткий общий предел 5 s тоже нельзя.

## Миграция 0184 и восстановление прерванного запуска

- Первая строка совпадает с `-- agency-hub:no-transaction`; все три запроса отделены `agency-hub:statement`. Мигратор действительно выполняет этот путь без BEGIN (`migrate-runner.ts:168–188`). `CREATE INDEX CONCURRENTLY` не оказывается внутри обычной migration transaction.
- Generator выбирает только два фиксированных имени в `public` с `NOT indisvalid`; сгенерированные DROP выполняются по одному. Успешный первый index и прерванный второй безопасно проходят повторный запуск: первый остаётся, INVALID shell второго удаляется, затем IF NOT EXISTS восстанавливает недостающий index. После завершения обоих записывается migration ledger. Это тот же работающий протокол, что 0169/0177.
- Два мигратора сериализуются session advisory lock; ожидающий выполняет короткие `pg_try_advisory_lock`, а не держит блокирующую транзакцию, которой concurrent build пришлось бы ждать (`migrate-runner.ts:94–111`).
- Определения schema и SQL совпадают: running `(id) WHERE outcome='running'`, webhook `(platform_account_id, received_at)`. Нет unique/foreign-key/data rewrite, удаления фактов либо изменения retention.
- Не выполнялись interruption/rerun chaos test и EXPLAIN на production. Реальный стандартный путь мигратора просмотрен, специальная интеграционная проверка отказа посередине 0184 не выполнена этим reviewer. Само наличие IF NOT EXISTS не проверяет определение одноимённого ранее вручную созданного valid index; это общий прежний предел миграционной дисциплины, а не обнаруженный конфликт.

## Дополнительная независимая проверка первоначального finding о projection lag

`golden-signals.ts:145–174` действительно меняет численное определение: `min(created_at)` всех pending rows заменено `created_at` первой pending seq. Параллельная транзакция может иметь более ранний start timestamp, но получить более позднюю seq. Из этого **не следует**, что реально committed очередь ждала 5 минут, а стала отображаться как 15 секунд.

Appender держит account-seq row lock до commit (`domain-events.ts:280–297`, `:396–469`). Для поздней seq выполняется `commit_later >= commit_first >= created_at_first`; следовательно, `now - created_at_first` не меньше реального времени ожидания самой старой committed строки. Более старый `created_at` поздней транзакции добавляет к старому gauge время до доступности события projector-у. Контрпример с инверсией timestamps доказывает отличие исторической серии/формального `min(created_at)` определения; без отдельного writer, обходящего этот invariant, он не доказывает заявленную потерю тревоги о давно committed backlog. Рекомендация: снять operational P2 и явно описать изменение gauge, сохранив численный контрпример как уточнение контракта.

## Пределы заключения

Прочитаны `CLAUDE.md`, Decisions 280/284/293, Stage 25 и непосредственно связанные code/tests. Существующие интеграционные fixtures разобраны на охват (recency, completed history, inactivity, shadow failure и migrator); зелёные результаты не использовались как замена чтению кода. Этот файл не повторяет результаты root-agent тестов и не утверждает, что весь Hub свободен от регрессий. PostgreSQL tuning, fan upsert и SSE отдельно ревьюят другие участники.

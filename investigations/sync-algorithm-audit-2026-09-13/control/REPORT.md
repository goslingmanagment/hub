# Аудит control plane синхронизации

Дата: 2026-09-13. Проверенный checkout: `b48f173d93e3693550e2db139de3b11107d44ce2`. Установленный `pg-boss`: **12.14.0**. Продуктовый код и production этим агентом не изменялись. Исторические stage 25/26 использовались как описание намерений; выводы ниже сделаны по исполняемому коду и реальному PostgreSQL.

## Результат

Основа FSM реализована последовательно: сохраненное намерение отделено от одноразового queue wakeup; checkpoint/записи ограждаются generation + token + DB-clock expiry; продолжение одного chunk возвращается в очередь атомарно; expired lease нельзя воскресить heartbeat. Однако утверждать «всё корректно и готово к масштабированию» нельзя.

**Воспроизведены пять дефектов**: потеря retry-класса в planner, снятие ручной Fansly-паузы при auth recovery, два нарушения распределенной работы очереди и выдача просроченных pacing-slots после ожидания DB lock. Первый дефект проверен двумя сценариями, всего подготовлены и успешно выполнены **6 PostgreSQL counterexamples**. Дополнительно отмечены три направления оптимизации с явными условиями применимости.

Это проверки существующего неправильного поведения: зеленый counterexample означает, что дефект воспроизведен, а не что соответствующая гарантия соблюдена.

## Реальные проверки

Первичный запуск координировал root одним процессом Vitest. Логи:

- `../evidence/counterexamples-control.log`: 2 файла, 6 тестов green. Из них 5 принадлежат этому аудиту; шестой, projection-debt, принадлежит соседнему разделу.
- `../evidence/counterexamples-pacing.log`: 1 файл, 1 тест green.
- Исходники counterexamples сохранены отдельно от продуктовой suite: `../evidence/tests/audit-sync-control.integration.test.ts` и `../evidence/tests/audit-sync-pacing.integration.test.ts`. Для повторного запуска используется audit-only Vitest config, подготовленный root.

Во всех тестах `startIntegrationTestDatabase()` предоставляет отдельную настоящую PostgreSQL-БД; отсутствие Docker здесь вызывает ошибку, не «успешный skip». HTTP к платформам не выполнялся. Для queue-сценариев использован настоящий pg-boss и его production queue options.

| ID | Приоритет | Доказательство | Применимость |
|---|---|---|---|
| C1 | P2 | SQL retry → planner → acquire, два класса | Обычный planner retry, независимо от числа workers |
| C2 | P2 | Auth pause → operator pause → verification recovery | Подтверждено строго для Fansly generic recovery |
| C4 | P2, до scale-out | Два настоящих fetch с перекрывающимися транзакциями | Два процесса executor; один процесс защищает local fetchLock |
| C5 | P2, до scale-out | Активная удаленная группа A, pending A и B → fetch возвращает [] | Два процесса executor либо active job, неизвестный локальному coordinator |
| C3 | P2 | Две реальные reservation ждут DB lock, обе получают past slots | Конкурирующие waiter одной identity + DB stall; возможны API verification и worker даже при одном worker |

Root отдельно проверяет production revision и topology. По переданной root проверке production имеет один worker, поэтому C4/C5 нельзя называть уже наблюдаемым production-инцидентом. C1 дополнительно проверен root в production revision как оставшийся кодовый дефект. Ни этот отчет, ни counterexamples не доказывают фактическую потерю данных или бан аккаунта.

## C1. Planner удаляет retry-класс до повторной попытки

**Причина:** `packages/db/src/repositories/page-sync.ts:1920-1933` переводит due stream из retry в pending и одновременно пишет `retry_kind = null`. При этом `consecutive_failures` сохраняется. Новый lease уже содержит `retryKind: null`.

**Следствия в реальном executor:**

1. `apps/runtime/src/services/sync/executor.ts:436-450` ограничивает Fansly 404 двумя retry только если `previousRetryKind === 'provider_404'`. При нормальном повторе через planner класс уже обнулен, поэтому каждый следующий 404 опять считается первым. Ветка `provider_404_exhausted` недостижима через этот путь: запросы продолжаются с backoff до 30 минут бессрочно.
2. `apps/runtime/src/services/sync/executor.ts:289-303` снимает `ofapi_low_credit` при успешном ответе только если lease пришел с `ofapi_insufficient_credits`. После planner этот признак утрачен, и успешный recovery chunk не может выполнить предназначенное снятие latch. Отдельный credit monitor может снять его другим путем; не утверждается, что инцидент обязательно вечен.

**Контрпример:** seed/request light → acquire(token1) → `retryPageSync(retryKind=provider_404, retryAt=due)` → проверка, что класс сохранен → `scheduleDuePageSync` → acquire(token2) → класс null при failures=1. Второй тест повторяет тот же реальный SQL путь с `ofapi_insufficient_credits`; платформа seed здесь несущественна, потому что проверяется общая FSM, а не OFAPI HTTP.

**Исправление:** при материализации due retry очищать только временной барьер `retry_at`, сохраняя `retry_kind` до попытки. Сбрасывать retry metadata при успехе, явном superseding request/reset и других уже предусмотренных terminal transitions. Альтернатива, если `retry_kind` требуется исключительно для UI retry-state, — отдельный durable `last_failure_kind`, которым пользуется классификация и recovery.

**Проверка исправления:** одна интеграция с тремя последовательными 404 через настоящий planner должна закончиться blocked/provider_404_exhausted. Вторая: 402 → planner → реальный успешно завершенный chunk с totalRequests>0 должен вызвать recovery; нулевой-request budget yield этого делать не должен. Существующие unit tests (`tests/sync-executor.test.ts:1490-1541`, `1938-1964`) подставляют retryKind в lease mock вручную и не видят потерю между компонентами.

## C2. Auth recovery отменяет более позднюю ручную паузу Fansly

**Причина:** `pausePageSync` (`packages/db/src/repositories/page-sync.ts:2848-2880`) сохраняет `blocker_kind='auth'`. Для Fansly нет независимого признака, что после auth pause оператор снова нажал Pause. `clearPageSyncAuthBlock` (`:2766-2784`) переводит все auth-blocked rows в pending/idle без сохранения такой ручной паузы. Production call site: `apps/runtime/src/services/notification-incidents.ts:793-812`, успешная проверка подключения.

**Контрпример:** `pausePageSyncForAuth(light)` → `pausePageSync(light)` → `clearPageSyncAuthBlock(pageId)`; после явной ручной паузы state становится pending.

**Влияние:** повторная верификация токена возобновляет поток, который оператор намеревался оставить остановленным. Особая чувствительность здесь — пользователь остановил поток на время разбора provider/proxy/capture-проблемы.

**Граница вывода:** OFAPI binding/connected recovery в `services/ofapi-account-health.ts` и `repositories/ofapi-bindings.ts` уже различает `ofapi_user_paused`, что отражено в decision #256. Этот counterexample относится к Fansly generic verification и не является доказательством дефекта того OFAPI пути.

**Исправление:** хранить владельца паузы отдельно от диагностического blocker: например, `user_paused` для обеих платформ. Auth recovery очищает auth blocker, но оставляет status paused, пока owner pause сохраняется. Простое удаление auth marker при Pause оставит проблему последующего Resume без проверки credentials; нужна независимая ось состояния.

**Проверка исправления:** обе перестановки событий: operator pause → auth death → recovery; auth death → operator pause → recovery. Затем только явный Resume должен открыть поток. Отдельно сохранить feature-gate pause и не затронуть OFAPI generation recovery.

## C4. pg-boss groupConcurrency=1 не является распределенным mutex

**Hub relies on:** `apps/runtime/src/services/sync/executor.ts:1236-1261` использует `fetchLock` и `localActiveGroups` в памяти одного процесса, а для других processes полагается на `groupConcurrency: 1`. Page singleton защищает страницу, но у разных страниц одной proxy identity singleton keys разные (`services/sync-queue.ts:309-320`).

**Причина в фактически установленной библиотеке:** `node_modules/pg-boss/dist/plans.js:757-799` считает `active_group_counts` через snapshot и отдельно берет очередной job через `FOR UPDATE SKIP LOCKED`. Общей блокировки строки группы либо атомарного group lease нет. Два fetch могут не видеть незакоммиченные active-записи друг друга и взять разные page jobs одной группы.

**Детерминированный контрпример:** queue содержит page101 и page102 с одним egressKey. Transaction A делает настоящий `boss.fetch(... groupConcurrency:1)` и не commit. Transaction B делает тот же fetch через другой PostgreSQL client; первый job заблокирован и пропускается, active count у группы еще 0, второй job успешно берется. После обоих commit в `pgboss.job` две active записи одной группы. Удержание transaction A моделирует окно перекрытия двух обычных fetch statements, не изменяет их SQL.

**Влияние:** при scale-out перестает выполняться заявленная «не более одного chunk на egress» координация. Это не доказывает одновременные запросы к платформе: shared pacing при штатной работе остается отдельной защитой request spacing. Но per-group chunk fairness, давление на proxy и ресурсы уже не ограничены одним активным chunk.

**Исправление:** либо сохранить один executor process как явную границу эксплуатации, либо добавить общий DB lock для fetch/claim + атомарный group occupancy protocol. Практичный узкий вариант — serialize sync queue fetch в одной короткой PostgreSQL transaction под advisory lock, выполняя fetch через тот же db wrapper; освобождать lock сразу после claim commit, а не держать весь HTTP chunk. Для пропускной способности следующая ступень — отдельная egress lease/dispatch table с `SKIP LOCKED` на группах. Нельзя считать добавление еще одного локального mutex исправлением распределенного случая.

**Проверка исправления:** сохранить контрпример и развернуть ожидаемый assert: до commit A второй процесс не должен забрать другую страницу той же группы, но после завершения A должен. Дополнительно реальный двухпроцессный churn test: kill worker, expired job, смена egress mapping.

## C5. Чужая занятая группа останавливает выдачу свободной группы

**Причина:** `pg-boss/dist/plans.js:765-773` выбирает `LIMIT 1` до вычисления `group_filtered` (`:794-800`). Если старейший queued job принадлежит уже занятой группе, его выкидывает group filter, а следующий свободный job не рассматривается. Локальный executor передает в `ignoreGroups` только собственные active groups (`executor.ts:1247-1261`).

**Контрпример:** worker A уже держит A1; очередь содержит A2, затем B1. Worker B имеет пустой localActiveGroups. Его штатный fetch возвращает `[]`, несмотря на runnable B1. Тот же fetch с явным `ignoreGroups=[A]` сразу берет B1.

**Влияние:** на двухпроцессной topology worker B будет каждую секунду опрашивать очередь впустую до освобождения A, хотя свободны и его ресурсы, и egress B. В сочетании с длинными chunks масштабирование может дать существенно меньше ожидаемого выигрыша и увеличить задержки несвязанных страниц.

**Исправление:** фильтровать недоступные группы до LIMIT в корректно координированном claim query. Короткая общая fetch transaction из C4 может читать active groups, передавать полный ignoreGroups и выполнять fetch под тем же advisory lock. Простое увеличение batchSize — ограниченная оптимизация, не доказательство отсутствия starvation: при достаточно длинном префиксе A проблема повторится.

**Проверка исправления:** deterministic A1-active/A2-pending/B1-pending возвращает B1; вариант с сотней pending A подтверждает, что решение не зависит от случайного размера batch. Отдельно сохранить single-page singleton и FIFO среди доступных групп.

## C3. DB stall превращает pacing-слоты в разрешение на пачку запросов

**Причина:** `reserveSyncProviderRateLimit` снимает `now` до DB transaction и ожидания row locks (`packages/db/src/repositories/sync.ts:2723`, `2749-2766`). После ожидания вычисляет `scheduledAt=max(старый now, nextAvailableAt)` (`:2780-2784`). Если DB ожидание длиннее нескольких интервалов pacing, накопившиеся callers получают timestamps из прошлого. `createSyncRateLimitWaiter` (`services/sync/rate-limiter.ts:49-57`) вычисляет `max(0, scheduledAt-Date.now())`, что для всех равно 0.

**Контрпример:** профиль spacing=100ms; отдельная transaction удерживает его `FOR UPDATE`; две реальные reservation вызваны и по `pg_stat_activity` подтверждены как Lock-waiters. После удержания еще 300ms lock освобождается. Обе reservation получают scheduledAt ранее освобождения lock; обе downstream wait-длины равны нулю.

**Влияние:** алгоритм гарантирует последовательные зарезервированные timestamps, но не выдерживает request spacing после DB stalls. Это может усилить upstream 429 и нагрузку на proxy именно в момент, когда база восстанавливается. Дефект не требует нескольких sync-worker: тот же waiter вызывается API verification (`services/connections.ts:254`), onboarding, proxy checks, endpoint probes и worker chunks.

**Исправление:** после захвата всех требуемых locks получать актуальный DB `clock_timestamp()` и брать максимум относительно него; не использовать frozen application time как authoritative current time. Для жесткой физической гарантии нужен дополнительный send-time claim/recheck: event-loop stall после успешной reservation тоже может схлопнуть разные planned slots. Bounded DB-lock wait + cancelable waiter помогут освобождать потерявшие lease chunks. Не переносить большую bulk очередь на общий vendor horizon: двухфазное bulk pacing stage26 сохранять.

**Проверка исправления:** текущий counterexample должен после отпускания lock получить первый slot примерно у момента release и второй >= first+spacing, причем второй waiter действительно ждет. Отдельно покрыть clock skew, отмену до send и падение клиента после reservation. Этот аудит не выполнял настоящие vendor sends и не измерял rate-limit инциденты на production.

## Улучшения производительности и fairness

### O1. Page-scoped continuation lookup вместо полного списка fleet на каждом chunk

`executor.ts:108-122` читает целиком `listRunnablePageSync` и `listRunnableOfapiCapturePages`, затем делает `.find(pageId)`. `executeNextPageWorkChunk` (`:1029-1043`) повторяет fleet-level reads перед dispatch. Когда background capture включен, это до четырех aggregate/list queries на один chunk, независимо от платформы самой страницы. SQL `listRunnablePageSync` (`page-sync.ts:1975-2011`) агрегирует страницы и streams целиком.

Добавить pageId predicate в repository query либо `getRunnablePageWorkPriority(pageId)`; тогда planner оставляет свой fleet read, а executor читает только свою страницу. Не кешировать это решение на весь run без invalidation: manual request и rollback state должны влиять на ближайший chunk. Проверять EXPLAIN/BUFFERS и latency на realistic page/stream cardinality; точный выигрыш этим агентом не измерен.

### O2. Cleanup должен начинаться с running runs

`closeInactiveSyncRuns` (`sync.ts:414-424`) сначала агрегирует всю таблицу HTTP attempts и все run events, затем соединяет с `sync_runs WHERE outcome='running'`. Planner вызывает это раз в минуту до любой dispatch (`planner.ts:34-38`).

Сначала отбирать немногочисленные running IDs, затем получать last attempt/event через индексированные LATERAL/MAX или maintain one heartbeat/activity timestamp. Проверить план PostgreSQL: CTE сам по себе не гарантирует full materialization, но текущая форма не выражает требуемое ограничение входа aggregate. Отчет не заявляет измеренный production full-table scan без EXPLAIN. Сохранить правило partial при checkpoint_advanced, закрывать только неактивные runs и не менять фактографическую retention.

### O3. Ограничить ожидание live stream за длинным history stream внутри одной страницы

Page jobs теперь FIFO, однако выбор stream (`page-sync.ts:2073-2075`) всегда strict priority. `dm_messages` scheduled имеет 25, `notifications` 16 (`:514-519`). Yield старой истории оставляет demand и scheduled priority; новых времен «обслужен последним» в сравнении нет. При непрерывно runnable history notifications не получит chunk, пока history не закончится либо не уйдет в retry. Сценарий не требует двух страниц/двух workers.

Это условная проблема latency/starvation, не измеренная в production этим агентом. Она особенно существенна для `notifications`: policy-комментарий (`:332-342`) обосновывает 30-минутный poll одноразовым источником. Намерение «DM важнее» не задает верхней границы ожидания.

Добавить deadline/aging для live streams либо фиксированную долю chunks для history/maintenance с защитой критичных money/live запросов. Не поднимать все low-priority streams навсегда: это только поменяет жертву starvation. Regression model: постоянно готовый dm_messages и overdue notifications; notifications обязан получить chunk в согласованной верхней границе. Аналогично проверить сравнение capturePriority >= legacyPriority (`executor.ts:1038-1040`), где при равенстве сейчас всегда выигрывает capture.

## Что оставлено подтвержденным положительным результатом

- `heartbeatPageSyncLease`, settle/write fencing используют `clock_timestamp()` и отказывают expired lease; старый token не сможет завершить новую lease.
- `withOwnedPageSyncTransaction` проверяет ownership перед записью и повторно под row lock перед commit; это защищает сохраненные checkpoints/projections от устаревшей попытки.
- Page queue имеет `exclusive` singleton по page ID, `retryLimit=0`, один chunk на job и атомарный complete→send через одну PostgreSQL transaction; ручной запрос не хранится только в queue.
- Delayed continuation хранится в durable `retry_at`, поэтому не занимает future singleton перед urgent request.
- Гейтовый skip отдельно от успеха и не пишет `succeeded_at`; ролевой scheduler отдельно от API/worker timekeepers.
- Для Fansly proxyless resolution fail-closed; rate limit identity основана на egress, а не только page ID.

Отдельная граница: по сообщению root, production более нового revision уже содержит abort HTTP при потере lease и оптимизацию ensurePageSyncStates. Отсутствие этих изменений в local HEAD не включено здесь как «новый production-баг».

## Порядок исправлений

1. C1 и C2: небольшие FSM-изменения с интеграционными lifecycle-тестами.
2. C3: актуальный DB-clock после lock и тест stall; сохранить двухфазную egress модель.
3. O1/O2: по одному query change с before/after EXPLAIN и измерением latency, без повторного архитектурного переписывания.
4. O3: owner-visible предел ожидания live stream, затем policy и bounded fairness test.
5. C4/C5: закрыть перед добавлением второго executor process; настоящий двухпроцессный soak обязателен, unit mocks недостаточны.

Это предложения для reviewable исправлений. Deploy, смена topology и production config в рамках аудита не выполнялись.

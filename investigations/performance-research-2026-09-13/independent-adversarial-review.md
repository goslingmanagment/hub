# Независимая adversarial проверка исследования

Исходники: `74aac509`, `/Users/dmitriy/code/goose/.worktrees/hub-performance-research-20260913`. Проверяющий самостоятельно читал схемы/SQL/callers, подготовил golden-signal oracle и контрпримеры нагрузки, затем независимо проверил monitor/replay предложения root и их планы. PostgreSQL тесты и production metadata запускал только root последовательно. Application code не менялся; application diff, migration и deploy candidate отсутствуют и **не получили approval этим review**.

**Статус исследования:** выводы поддерживаются evidence; первым кандидатом на реализацию следует оставить bounded latest-completion lookup. Универсальные golden/replay замены отклонены. Для attempts plain prefix допустим следующий ограниченный prototype, но не обещание production CPU/I/O savings. Финальный `REPORT.md` root прочитан; ниже receipt проверки синтеза и небольшие замечания к формулировкам.

## Проверенные доказательства

Прочитан `experiment-summary.json`: **19 логов,93 EXPLAIN plans**. Сверены критические строки с raw plan JSON, а не только пересказом root. Проверены исходные SQL и новые scratch candidates, oracle fixtures, metadata/ACL ограничения, write-amplification log. Golden отчет `golden-signals-research.md` содержит полный разбор временных границ, weighting, physical identity, partition keys, erasure и sampled/absent/error поведения.

Число plans не равно 93 разным workload scenarios и не равно 93 application tests. Сходство результатов на этих fixtures не доказывает production performance. Большинство SELECT fixtures используют TEMP tables: их counters — Local Blocks; это не physical disk reads и не shared production buffers. `Actual Rows` per-loop округлён, поэтому сумма `Actual Rows*Actual Loops` не является точной переписью редко совпадающих partition lookups. В заключении допустимы runtime диапазоны, exact loop/heap/Memoize counts и top-level block counters с правильными названиями.

## 1. Completed run: лучший ограниченный кандидат

Поддерживаю **направление реализации**: distinct visible(page,stream) work keys; отдельный latest run ID probe с filters `outcome<>'running'` и `finished_at is not null`; полный ORDER `finished_at DESC,id DESC LIMIT 1`; payload читается после выбора через PK. Соответствующий narrow partial index содержит page,stream,finished_at,id и не хранит stats/error payload.

Прямой source review подтверждает сохранение исходного отбора, tie-breaker, source fallback и статуса при условии, что существующий outer payload projection останется буквально прежним. Сокращается retained-history ranking, ранее оставшийся после Decision293. В модельном плане 37.231ms/2976LocalBlocks заменились 0.083/0.034ms и 31LocalBlocks. Это structural выигрыш конкретного subquery, не ускорение полного /sync/health на такую же величину.

Нужные invariants: DISTINCT только для work keys, исходная final row multiplicity при duplicate stream inputs остаётся; RBAC/page labels/platform stream filtering не расширяются; finished_at-null и running rows исключаются независимо от времени; id определяет одинаковый finished_at tie; duration floor/clamp, statuses, stats и errors не изменяются. Empty lists сохраняют ранний return. Проверить actual emitted app SQL, full payload values, empty/inaccessible keys и negative-control old plan.

Index write-cost не нулевой, но новый индекс **не впервые** делает outcome/finished_at обновления несовместимыми с HOT: current 0184 `sync_runs_running_idx WHERE outcome='running'` и 0177 finished_at index уже индексируют эти зависимости. Миграция всё равно должна быть forward-only, concurrent/retry-safe на обычной таблице, с index validity и полным deployment health gate.

## 2. Attempts: простой переписанный запрос сначала провалил плановый review

Первый source-equivalent prototype имел два hidden cost:

- latest-success LIMIT выбрал глобальный started_at index и отфильтровал в среднем 96615 чужих строк на key;
- OR(last_success IS NULL OR started_at>last_success) остался heap filter после broad page/stream bitmap.

Поэтому 28.7–29ms вместо 34ms не давали доказанной разгрузки:14211blocks вместо 1775. Такой SQL не следовало принимать по одному времени.

Проверяющий предложил `monitor-attempts-adversarial-candidate.sql`: meaningful tuple-prefix order с LIMIT, точная equality СНАРУЖИ LIMIT для отбрасывания one-row spillover; debt разбит на mutually exclusive NULL/non-NULL ветви UNION ALL. Root подтвердил oracle с no-success, stale/cutoff boundaries, equal started_at, future success, duplicate output и '-infinity'. Семантическое распределение recent/debt корректно: это два независимых aggregates, overlap не суммируется дважды.

При дальнейшем отказе от state-sensitive индекса root добавил upper tuple bound на тот жеkey. Проверен получившийся SQL: history scan latest-success ограничен своимkey; old lastSuccess semantics сохранены. Это важно для no-success: просто seek>=key мог бы пройти чужие prefixes до первого success.

Plain `(page,stream,started_at DESC)` показал на модели:

| Профиль | Старый SQL | Plain prefix prototype |
|---|---:|---:|
|Основной |34.688–37.617ms /1775blocks |0.311–0.396ms /99blocks |
|Около 201k no-success debt |278.464–282.747ms /45538blocks |54.821–56.429ms /4830blocks |
|Много recent, все 24 keys |232.571–259.955ms /86579blocks |78.966–86.755ms /43649blocks |

Это основание исследовать plain index дальше. Но старый план тоже меняется от индексов/формы данных: на covering recent fixture old использовал 3539LocalBlocks и 2243/2244temp read/write, а новый 43906LocalBlocks безtemp. Поэтому нельзя обещать универсальное снижение всех чтений/диска. Полный monitor query с точными page counts и всеми остальными CTE ещё не сравнивался.

## 3. Attempts indexes: write path способен отменить read win

В write fixture10000 completions, fillfactor 60:

| Вариант | HOT updates | WAL bytes | Execution ms |
|---|---:|---:|---:|
|Baseline |6544 |3064176 |28.018 |
|Plain prefix |6544 |3544012 |43.034 |
|Covering плюс success partial |0 |7222036 |71.584 |
|Один state-leading prefix |0 |6286856 |61.773 |

State в INCLUDE, key либо partial predicate лишает started→terminal update HOT возможности; факт соответствует [PostgreSQL 16 HOT](https://www.postgresql.org/docs/16/storage-hot.html). Один state-leading index уменьшает количество дублирующих index writes, но не решает HOT проблему. Plain сохраняет HOT в модели, всё равно увеличивает WAL и update latency — не бесплатная оптимизация.

Эти числа не доказывают текущий HOT ratio production: fillfactor 60 выбран для проявления механизма, execution timings не повторены многократно. Для решения нужен текущий read frequency × workload и write frequency/bytes, а не только synthetic SELECT multiplier. `useSyncMonitor` с 10 sинтервалом без найденных callsites нельзя считать 10 sбоевой нагрузкой. Caller inventory должен разделять доступный хук, реально вызываемые protected health/preview readers и фактические HTTP logs.

## 4. Golden signals: отказ от неподходящего фикса обоснован

Прямой контракт: точный percentile_cont по event-weighted INNER JOIN,10 min lower-exclusive created_at window без upper bound, received_at source timestamp; один SQL snapshot; no traffic даётNULL/no sample, ошибки не превращаются в 0. PKs составные; duplicate IDs across partitions сохраняются, LIMIT 1 недопустим. Old/replay/late/provider-dated events не позволяют сузить source partition range по сегодняшней дате.

Unconditional LATERAL семантически прошёл oracle, но 200kуникальных IDs дали 937–941ms против 205–245ms. Actual plan:2.6 млн leaf probes,200k heap fetches, Memoize0 hits. На повторяемых IDs hits199900 дают локальный выигрыш; это как раз доказывает зависимость от workload и необходимость отказа от универсального решения.

Новый created_at covering btree при summarized BRIN не обоснован: sparse0.483–0.498ms против 0.392–0.481ms; broad/repeated используют прежний BRIN даже после добавления btree. Production12.39349s существует в логе, но actual plan/BRIN summary coverage недоступны по ACL. Не добавлять индекс, не денормализовать lag в events, не запускать production summarization/VACUUM/ANALYZE на основании этой модели. В golden report исправлена обнаруженная root противоречивая фраза о якобы уже доступном безопасном PK fix.

## 5. Replay: универсальный prefix-topN тоже отклонён правильно

Математически per(version,kind) topN → global topN корректен для disjoint prefixes, при dedup входных kinds и точной физической payload hydration по(id,received_at) в одном snapshot. Но сортировка только поid не определяет набор tied rows на границеN; fixture с 3duplicate IDs нижеLIMIT не доказывает byte-identical subset при>200ties. Нельзя тайно добавлять received_at ORDER или изменять background cursor semantics.

Actual query candidate ухудшился на tail:176–177ms против 26ms,88152blocks против 13383; planner всё ещё способен выбрать неверный id index под prefix фильтрами. Many 1000 versions дал 260–293ms против 0.265–0.373ms: materialize всехV×Kprefixes уничтожает current early-stop преимущество. Эти контрпримеры достаточны, чтобы отклонить universal replacement даже после хорошего sparse-case результата.

При будущем исследовании отдельно сохранить atLeast bounds, negative/INT_MIN versions, limit, empty/undefined kinds, source-free/exact/account/accountIds/deep/time fallback, array duplication, payload hydration physical precision и parse stamp/cursor budget. Никакой новой подсистемы, cache, body prefetch, provider egress или миграции из этого prototype не следует.

## Gate качества и архитектуры

- **Research conclusions:** поддержаны кодом и экспериментами; найденные adverse результаты не скрыты.
- **Architecture direction:** completed-prefix первый; attempts plain-prefix отдельным решением после full-query/read-write измерения; golden/replay без изменений до лучшего evidence.
- **Implementation readiness:** ещё нет полного application diff, actual app query-capture tests, forward migration, code review final tree или production-equivalent schema validation. Это review исследования, не approval будущего коммита.
- **Deployment:** в этом исследовании code/schema/flags/cadence не менялись. Прежнее разрешение пользователя на доставку фиксов не превращает отвергнутый prototype в пригодный release. Нельзя обещать новый production speedup без выпускного gate и контрольного окна.

## Receipt проверки финального REPORT.md

Финальный root `REPORT.md` прочитан полностью. Сверены 19 логов/93 plans, критические числа в completion, attempts, golden, replay таблицах, write WAL/HOT/update timings, отклонение универсальных алгоритмов, metadata/ACL ограничения и отсутствие application/deployment approval. Ranked recommendations поддерживаю; блокирующего противоречия между доказательствами и выбранным направлением нет.

Перед окончательной публикацией root переданы три ограниченные правки; все три внесены root и повторно проверены исследователем. Сам REPORT проверяющий не менял:

1. В completed разделе «Старый и новый полные результаты совпали» уточнить до «Полные результаты модельных запросов совпали; полный ответ приложения ещё не проверялся». Модель имеет ограниченный набор полей; не проверены весь status/duration/error projection и приложение целиком.
2. «за 10 минуту» исправить на «за последние 10 минут».
3. Неоднозначное «UNION с пересечением не удваивает счётчики» заменить точной схемой: recent и debt вычисляются отдельными aggregates; UNION ALL соединяет только взаимоисключающие NULL/non-NULL ветви debt.

Это approval качества исследовательского вывода с указанными уточнениями, а не approval будущего SQL diff, миграции, app regression tests или релиза. Противоречивая фраза в golden report о якобы уже доступном безопасном PK fix исправлена: такой кандидат экспериментально отклонён.


Повторная проверка: исправленные формулировки и ссылка на это review присутствуют в финальном REPORT.md. Verification receipt root фиксирует 93 plans/19 logs и clean source 74aac; об удалении собственного экспериментального контейнера root сообщил отдельно. Ограничения измерений явно сохранены. Research approval окончательный; implementation/release approval отсутствует.

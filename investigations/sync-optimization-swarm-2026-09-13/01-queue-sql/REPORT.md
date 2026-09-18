# Оптимизация SQL очереди и control plane

Дата: 2026-09-13. Scope: `queue_sql`. Только анализ; продукт, миграции и production не менялись.

**Четыре возможности выдержали проверку. Все присутствуют и в main, и в указанной root production-ревизии.** Доказаны повторные вызовы реальных функций и генерируемый SQL; уменьшение CPU, WAL и времени синхронизации на сервере ещё не измерено.

| Приоритет | Предложение | Подтверждённая издержка | Минимальное изменение |
|---|---|---|---|
| P2, QSQL-01 | Один preflight planner вместо двух и отдельный короткий maintenance read | `ensure → scheduleDue → ensure`; только этот подпуть передаёт `9S` полных state rows за idle tick | Сохранить первый ensure перед gates; убрать вложенный ensure именно в prepared-пути planner |
| P2, QSQL-02 | Не переписывать уже pending/dependency-blocked состояния | Ещё `U+B` последовательных UPDATE за tick даже без изменения делового состояния; во время циклов удерживаются row locks всех выбранных states | Пропуск одинакового состояния после существующего locked read; не менять владение строкой |
| P2, QSQL-03 | Одна транзакция gate reconciliation на страницу | Восемь стабильных gates дают `8P` транзакций, `24P` SQL round trips | Читать восемь состояний одной страницы в установленном lock order и применять ту же логику переходов |
| P3, QSQL-04 | Общий idle dispatcher при сохранении числа исполнителей | После сериализации fetch всё равно остаются `C` независимых пустых опросов в секунду | Один таймер пустой очереди; отдельные `C` permits исполнения, повторный fetch при освобождении permit |

Здесь `S` — число возвращаемых `page_sync_states` всех страниц в рассматриваемом scope, `P` — число активных Fansly-страниц, `U` — уже нормализованные pending строки, `B` — неизменные dependency-blocked строки, `C` — локальная executor concurrency. Это **разные знаменатели**; результаты нельзя складывать как проценты ускорения всей системы. Full-state list не фильтрует active pages, поэтому `S` не следует автоматически заменять числом активных страниц × streams.

## Проверенная версия и доказательства

- Рабочая ветка: `b48f173d93e3693550e2db139de3b11107d44ce2`.
- Повторно прочитан `../production-revision.txt`: API, worker и scheduler указывают `74aac5093cfc`; `git rev-parse` раскрывает его в **`74aac5093cfc665853cc8e5b6cc661de7119b917`**. Сам агент production не опрашивал.
- Harness получает код обеих версий через **`git show <revision>:<path>`**, транспилирует исходные функции без изменения их тел, заменяет импортируемый I/O. SQL строит установленный Drizzle. Ни одного SQL-запроса в БД и ни одного HTTP-запроса harness не выполняет.
- [probe.mjs](probe.mjs), [probe-results.json](probe-results.json), [SQL main](b48f173d93e3-generated-sql.json), [SQL production](74aac5093cfc-generated-sql.json).
- В обеих версиях полный reader выбирает **37 колонок**, включая `request_payload`, `progress`, диагностические строки и lease timestamps. Первоначальная устная оценка в 39 колонок исправлена по сгенерированному SQL.
- `pg-boss` локально — **12.14.0**; `pnpm-lock.yaml` между проверенными ревизиями не менялся. Runtime-установка контейнера отдельно не проверялась.

Известная оптимизация follower count уже в production: `page-sync.ts:1542–1557` в release читает `page_follows` только при необходимости seed `followers_reconcile`. Её экономия **исключена** из этого отчёта. Релиз также уже отменяет HTTP при потере lease; эти строки следует сохранить при реализации.

## QSQL-01. Один preflight planner и узкая maintenance-проекция

**Реальный вызов.** `apps/runtime/src/services/sync/planner.ts:50` вызывает `ensurePageSyncStates` перед gates. Затем `:87` вызывает `scheduleDuePageSync`, который снова делает ensure: main `packages/db/src/repositories/page-sync.ts:1886–1890`, release `:1896–1900`. Этот код выполняется на старте worker (`worker-services.ts:601`) и в `sync.planner` callback (`:252–256`); cron — раз в минуту (`sync-queue.ts:241`). Возможны дополнительные ручные planner wakeups; модель ниже рассчитана на один вызов.

**Что повторяется.** Один ensure в обычном уже инициализированном состоянии делает пять SQL-запросов: метаданные страниц, полный state list, legacy repair UPDATE, ещё один полный list, последний полный list для возвращаемого результата. Даже без policy drift он открывает и закрывает пустую transaction. Основные ссылки:

- main `page-sync.ts:1568–1596`, `:1598–1624`; release `:1578–1606`, `:1608–1634`;
- reader и 37 выбранных колонок — обе версии `page-sync.ts:1127–1200`;
- результат обоих ensure в planner-подпути игнорируется; финальный список из schedule также игнорируется (`planner.ts:50,87`).

Вслед за двумя ensure scheduler читает все states ещё раз для scheduling и ещё раз для dependencies, а затем возвращает очередной полный список. В reclaim выполняется десятый full-reader query, но на fixture без expired leases он возвращает ноль строк.

**Точная трасса подпути `ensure; scheduleDue`.** Все состояния существуют, cadence/slot policy совпадает, dependencies удовлетворены, новый slot ещё не наступил, expired leases нет. Это не весь planner: gates, cleanup, capture recovery и enqueue здесь исключены.

| Синтетические Fansly-страницы | `S` | SQL без BEGIN/COMMIT | BEGIN/COMMIT | Полных state rows через границу DB→JS | Строк прочитано FOR UPDATE |
|---:|---:|---:|---:|---:|---:|
| 8 | 136 | 15 | 10 | 1 224 = `9S` | 272 = `2S` |
| 50 | 850 | 15 | 10 | 7 650 = `9S` | 1 700 = `2S` |
| 200 | 3 400 | 15 | 10 | 30 600 = `9S` | 6 800 = `2S` |

Обе версии дали одинаковые counts. BEGIN/COMMIT подтверждены реализацией `drizzle-orm/node-postgres/session.js:180–187`; в harness подсчитываются транзакции и два соответствующих SQL round trips, реальный driver не запускался. `projectedJsonBytes` в JSON — сериализация искусственных rows с 1 KiB `progress.syntheticPayload`, **не замер PostgreSQL wire bytes или production TOAST**.

**Минимальный дизайн.** Выделить внутренний `schedulePreparedPageSync` без вложенного ensure, оставив самостоятельный `scheduleDuePageSync` wrapper с ensure для существующих callers/tests. Planner по-прежнему сначала инициализирует states, затем применяет gates, затем вызывает prepared scheduling. Не удалять первый ensure: иначе новые gate-controlled streams не существуют во время reconciliation.

Это само по себе убирает **5 SQL + 2 transaction commands**, одну metadata выборку и `3S` full rows за обычный planner tick: `25→18` round trips указанного подпути, `9S→6S`. Число row locks не уменьшается. Условная экономия DB→JS JSON в этих трёх проходах — `3S × средний размер request_payload/progress/прочих полей`; никакого ускорения HTTP не следует.

Следующий небольшой шаг — отделить maintenance без возвращаемых rows от существующего публичного reader. Для поиска недостающих streams и policy drift достаточно `(page_id, stream, cadence_seconds, slot_offset_seconds)`. Legacy repair не меняет cadence/offset; поэтому повторный полный read после него не нужен для policy reconciliation. Вставленные новые rows уже имеют вычисленные policy values. При сохранении полноценного wrapper для callers, которым нужен результат, planner и executor могут использовать вариант без лишнего результата. Для planner это позволяет убрать ещё два ненужных возвращаемых full lists и заменить maintenance lists на узкие. **Этот следующий шаг в harness не реализован; в подтверждённую экономию `25→18` не включён.**

**Корректность и восстановление.** Seed продолжает делать `ON CONFLICT DO NOTHING`; новый stream после deploy появится при следующем tick; policy обновления и legacy repair остаются, tombstone-фильтр metadata сохраняется. Gate order не меняется. Между первым preflight и scheduling может появиться новая страница: обработка такой страницы следующим tick допустима только при сохранении существующего onboarding ensure/request path; проверить отдельно. Не вводить постоянный process cache «страница уже seeded»: иначе schema/stream rollout и второй process потеряют invalidation. Lease acquisition и финализация не меняются.

**Сложность:** S для удаления одного preflight; S–M для отдельного maintenance API. **Проверки:** новый stream/новая page, policy drift, legacy repair, tombstoned page, неизменная ручная пауза, race onboarding между prepare и schedule. Сравнить final state и emitted wakeups старого/нового пути на тех же fixtures. Canary: SQL/tick, returned bytes/tick, scheduler duration p50/p95, oldest due age и отсутствие роста пропущенных wakeups. При `S≈100` и свободной БД абсолютный выигрыш может быть небольшим; это сокращение известной работы, не заявленный главный production bottleneck.

## QSQL-02. Пропуск неизменных pending и dependency-blocked UPDATE

**Реальный вызов.** После `ensure` planner берёт `FOR UPDATE` по всему scope и в JS проходит rows: main `page-sync.ts:1893–1961`, release `:1903–1971`. Для `requestSeq > appliedSeq` даже уже `pending` row получает UPDATE `status='pending', retry_kind=null, retry_at=null, updated_at=now`: main `:1920–1933`, release `:1930–1943`.

Затем `refreshPageSyncDependencies` вновь блокирует весь scope (main `:1727–1734`, release `:1737–1744`). У уже заблокированной строки с невыполненной зависимостью `request_seq>applied_seq` остаётся истинным, поэтому код вновь пишет тот же blocker/message/retry state: main `:1784–1807`, release `:1794–1817`. `blocked_at=coalesce(blocked_at, now)` сохраняется, а `updated_at` меняется каждый tick.

**Доказательство.** Actual-function harness из `probe-results.json`:

- При восьми синтетических Fansly pages и 136 states в уже нормализованном pending с `retry_kind=null`, `retry_at=null`: **136 дополнительных UPDATE** за один вызов scheduler; подпуть `15→151` SQL и `25→161` round trips. Никакой новый request generation/slot для этого не нужен.
- При восьми неизменных `purchase_history` blockers `Waiting for light`, уже `blocked`, без новых фактов: **8 одинаковых dependency UPDATE**, SQL `15→23`, round trips `25→33`.
- Сгенерированный SQL не имеет distinct predicate. Harness не исполнял UPDATE в PostgreSQL; это доказательство выдачи команд и совпадения fixture с их WHERE, а не измерение tuple/WAL delta.

**Модель.** При `U` неизменных pending и `B` неизменных dependency blockers — `(U+B) × ticks` лишних UPDATE. В каждой транзакции обновления идут последовательно, поэтому одна row-RTT задержка `r` даёт дополнительный нижний порядок `(U+B)r` времени удержания блокировок плюс исполнение DML. В scheduling transaction заблокированы также unrelated pages и running states: их heartbeat/complete/manual controls могут ждать. Это условная модель contention; production lock wait не измерялся.

**Минимальный дизайн.** После текущего locked read не выдавать UPDATE, если целевое состояние совпадает. Для pending сравнивать status и требующие очистки scheduling поля; для dependency blocker сравнить status, kind/code/message, наличие blocked_at, требующие очистки retry fields. Либо добавить SQL `IS DISTINCT FROM` predicate как защиту, но один только SQL predicate всё равно оставляет `U+B` round trips: выигрыш RTT требует пропуска вызова в JS. `updated_at` должен означать изменение состояния, а не служить причиной бесконечного refresh. Под отдельным успехом корректности **сохранить `retry_kind` для повторной попытки**: его потеря — известный C1 baseline; оптимизация не должна маскировать или закреплять этот баг.

Чтобы не смешивать semantic fix и performance review, первый узкий patch можно применять только к уже `pending` строкам с обоими retry-полями null и к совершенно идентичным dependency-blocked tuples. Обработка созревшего retry останется прежней до отдельного исправления C1.

**Сохранение гарантий.** Locked read, порядок `(page_id, streamOrder)`, request/applied CAS, lease token/seq predicates остаются. Не пропускать реальный переход retry→pending, смену списка unmet dependencies, установку первого blocked_at или снятие dependency blocker. SucceededAt/appliedSeq остаются авторитетом dependency proof. Manual pause и `running` продолжают исключаться. Capture/events, курсоры, money codecs и provider calls не затрагиваются.

Отдельное последующее улучшение — выполнять scheduling+dependency decision на одной странице за transaction вместо двух fleet-wide transactions. Это уменьшает область contention, но не обязательно число SQL; требует доказать interleavings pause/resume/complete и сохранить общий lock order. **Не включаю его как доказанную экономию или отдельное готовое предложение.** В частности, слепой `SKIP LOCKED` может задерживать due-page бесконечно при постоянной конкуренции, поэтому его здесь не предлагаю.

**Сложность:** S для no-op guard. **Проверки:** два повторных planner cycles с одинаковыми states → тот же runnable set и ноль второго UPDATE; pending с реальным retry context; maturation Retry-After; изменившаяся dependency; live lease heartbeat; concurrent manual pause. Canary: `n_tup_upd` для states на planner tick и unchanged row count, WAL/tick при сопоставимом объёме работы, lock wait p95, oldest due age. Если pending быстро исполняются, `U≈0`, а все blockers имеют внешнюю причину, `B≈0`, эта оптимизация почти ничего не даст.

## QSQL-03. Восемь gate transactions на каждую Fansly-страницу

**Реальный вызов.** `planner.ts:51` → `apps/runtime/src/services/sync/fansly-stream-scheduling.ts:39–140`. В этой функции один раз загружаются effective config и список pages (`:43–46`), затем для каждой страницы перечисляются ровно восемь gates (`:60–109`), и каждый последовательно вызывает `reconcileFanslyBulkStreamGate` (`:112–128`). Эти файлы одинаковы в двух ревизиях.

Каждый вызов repository начинает transaction и SELECT одного полного state row `FOR UPDATE`: обе версии `page-sync.ts:1252–1257`. Даже когда row уже полностью соответствует `flag_off` (`:1328–1339`) или для ramped lane ничего менять не надо (`:1384–1388`), transaction уже создана, row заблокирован и гидратирован.

**Доказательство и модель.** На восьми синтетических Fansly pages, все восемь gates стабильно закрыты и уже правильно помечены:

`8 gates × 8 pages = 64 SELECT FOR UPDATE + 64 BEGIN + 64 COMMIT = 192 SQL round trips`.

Ноль UPDATE, все 64 вызова вернули `action='unchanged'`. Это counts точных repository-функций, вызванных в том же восьмикратном цикле, что у runtime caller. Дополнительные config/page reads в counts не включены. Общая формула стабильного случая — `24P` round trips, `8P` transactions, `8P` locked rows и `8P` полных result rows.

**Минимальный дизайн.** `reconcileFanslyBulkStreamGatesForPage(db, pageId, desiredGates, now)`:

1. Одна transaction на страницу, SELECT только этих восьми streams в **том же `streamOrderSql`**, что у `pausePageSync`/`lockPageSyncStatesForPage`.
2. Из существующей функции выделяется вычисление решения по **уже заблокированной** row; predicates `seedPaused`, feature-gate ownership, legacySkippedSuccess, retryBackoffActive и generation increments остаются прежними.
3. Каждое необходимое UPDATE остаётся прежним; для unchanged не исполняется ни одного UPDATE. Commit перед переходом к следующей странице.

В стабильном случае получается `P SELECT + P BEGIN + P COMMIT = 3P` round trips: на той же fixture **192→24**, минус 87,5% именно этого подпути. Количество прочитанных и заблокированных rows пока не уменьшается; bytes не обещаются. Это точное устранение восьми transaction envelopes вокруг восьми частей одной page FSM, не общее предложение «batch everything».

**Корректность и recovery.** Не объединять все pages в одну transaction. Все затронутые streams захватывать в существующем глобальном порядке, иначе пересечение с pause/resume/reset, которые блокируют всю страницу, может дать deadlock. Применять существующее решение только к заблокированной row; не переиспользовать незаблокированный preflight snapshot. Ровно одна recovery generation при открытии, исходная manual/auth ownership, never-ran seed rule и будущий retryAt сохраняются. Не кешировать effective config сверх сегодняшнего одного цикла и не использовать просто «gate config не изменился»: состояние самой строки могло измениться из-за ручного действия или error recovery.

**Сложность:** S–M. **Проверки:** stable flag-off и ramped no-op; closed→open с pending/idle/retrying; seed never-ran, manual pause до/после первого run, legacy skipped-success; concurrent Pause/Resume в обоих порядках; падение transaction посередине обновления восьми gates → rollback, следующий tick восстанавливает работу. Canary: transactions и SQL/gate-cycle, unchanged/paused/resumed/recovery counts, lock wait p95 и отсутствие неожиданных auto-resumes.

**Контраргумент:** одна transaction держит восемь row locks одновременно и несколько реальных UPDATE дольше, чем отдельные однострочные transactions. На gate-flip это может кратко увеличить задержку ручного control на этой странице; выигрыш ожидается преимущественно в стабильных минутах. При одной Fansly page это 21 сэкономленный round trip за tick, а не крупное ускорение ingest.

## QSQL-04. Один idle poller при сохранении `C` рабочих slots

**Реальный вызов.** `startSyncPageExecutor` создаёт `C` worker loops: main `executor.ts:1314–1324`, release `:1319–1329`. Каждый ждёт общий `fetchLock`, вызывает `boss.fetch(batchSize:1, priority:false, orderByCreatedOn:true, groupConcurrency:1, ignoreGroups:localActiveGroups)` и освобождает lock: main `:1236–1270`, release `:1241–1275`. При пустом результате **каждый** отдельно ждёт 1 000 ms: main `:1272–1274`, release `:1277–1279`.

Сериализация убирает одновременные fetch, но не повторный запрос к той же пустой очереди из соседних loops. Default concurrency — 4 (`packages/shared/src/config.ts:119`); текущий live config отдельно не проверялся.

**Доказательство.** Harness запускает настоящий `startSyncPageExecutor` обеих ревизий с пустым fake boss и управляемыми fake `delay` promises. В 60 последовательных one-second rounds при `C=4` получается **240 пустых fetch**, плюс 4 начальных = 244. Все параметры fetch зафиксированы в `probe-results.json`. В `pg-boss/dist/manager.js:522–539` каждый fetch после queue cache генерирует и исполняет один `fetchNextJob` SQL; `plans.js:734–824` содержит CTE выборку/active group count/update. Следовательно, минимум 240 рабочих SQL попыток за эти 60 rounds, не считая cache refresh. Реальные SQL timings не измерены.

**Минимальный дизайн.** Один dispatcher управляет теми же `C` execution permits и `localActiveGroups`. Пока permit свободен, он последовательно fetches один job и сразу отдаёт его отдельному handler; fetched-but-waiting jobs не накапливаются. Если fetch пуст — заводится **один** idle timer на тот же 1 s. Освобождение permit/group может разбудить dispatcher раньше timer. Если все permits заняты — polling не нужен. Handler оставляет сегодняшние heartbeat, one-job/one-chunk, `processSyncPageExecuteJob` и atomic complete→send transaction без изменений.

Модель для чистого idle: `C / Δ → 1 / Δ` запросов в секунду, где `Δ=1 s`; при default 4 это **75% меньше idle fetch**, а не 75% ускорение sync. В реализованном harness проверена исходная сторона; 60 вместо 240 — арифметика предложенного dispatcher, **его реализация и load test не выполнены**. Уменьшение времени ожидания относительно текущего цикла не обещается; для новых external jobs сохраняется верхняя граница обнаружения около одного интервала плюс DB/scheduling задержка. При частично занятых slots число лишних пустых polls также зависит от числа idle loops.

**Корректность.** Не делать `batchSize=C` и не выдавать lease/job заранее сверх permits: это поменяет FIFO, expiry start и group fairness. Сохранить page singleton, head/tail queue round-trip между chunks, `retryLimit=0`, DB-clock safe handoff, completion affected=1 и atomic child insert. Уведомление об освобождении permit должно быть level-triggered или иметь счётчик поколения, чтобы не потерять wakeup между check и await. При завершении/ошибке handler permit/group всегда освобождаются в finally; остановка отменяет таймер и ждёт текущие handlers по существующему shutdown контракту.

Известные C4/C5 baseline о распределённом `groupConcurrency` остаются: process-local dispatcher не исправляет multi-process admission. Новые workers не добавляются. Нужно отдельно сохранить доказательство, что другой egress не задерживается за занятой группой.

**Сложность:** M. **Проверки:** 60 idle rounds при C=1/4; burst ≥C jobs разных групп без искусственного одного-job/second bottleneck; одна занятая группа и свободная другая; immediate child handoff; external enqueue после empty fetch; lost-wakeup interleaving; handler crash, abort и stop во время idle. Canary: empty/success fetch ratio, SQL fetch/minute при одинаковом idle fraction, enqueue→start p95 и используемые execution slots. Если все workers почти всегда заняты, экономия близка к нулю; сначала внедрять более простые QSQL-01/02.

## Инварианты, границы и отвергнутые направления

- Ни одно предложение не меняет HTTP payloads, capture-first, canonicalization ordering, capture/event idempotency, cursor completeness или money units. Erasure/tombstone eligibility и lease predicates сохраняются в существующих местах. Всё это нужно проверять на итоговом patch, а не объявлять доказанным одними подсчётами запросов.
- **Не удалять проверку safe handoff и не разрывать complete→send transaction.** Это дополнительные round trips, но они защищают от ABA, утраты wakeup и дедуп-коллизии parent/child: main `executor.ts:1130–1199`, release `:1135–1204`. Даже сокращение этих запросов должно иметь отдельное доказательство двух ownership boundaries; здесь такой кандидат отклонён.
- **Не сливать много chunks внутрь одного pg-boss job.** Это ломает нынешний fairness quantum и отдаляет safe handoff; исходник явно запрещает local drain (`executor.ts:1083–1086`, release `:1088–1091`).
- **Не считать `enqueued_at` признаком существующей queue job.** Queue wakeups disposable; planner нужен для recovery после expiry/failure/crash. Кеш «уже отправлено» без проверяемой generation/job ownership потеряет работу. `send` null из-за exclusive singleton сам по себе — ожидаемая идемпотентность, не доказанный избыточный job.
- **Не отключать heartbeat из-за short average chunk.** Pacing, retries, slow HTTP и DB lock stalls меняют wall time; lease correctness важнее редкой записи. Слияние heartbeat с progress требует строгой гарантии максимального интервала при полном отсутствии progress; доказательства нет.
- **Page-scoped runnable lookup — уже известный O1 baseline.** Он по-прежнему актуален (`executor.ts:108–122,1029–1043`; `page-sync.ts:1975–2018`; release у SQL `:1985–2028`), но не пересчитан как новая находка. Возможное уточнение: существующий `listRunnablePageSync` уже возвращает egress key, а `resolveSyncPageWakeupTarget` снова вызывает трёхзапросный `findPageById` ради platform/proxy (`executor.ts:200–212,1127`; `catalog.ts:319–335`). Narrow page-scoped work snapshot мог бы одновременно вернуть legacy/capture priorities и свежий egress target; нельзя просто кешировать старый target через весь chunk, поскольку proxy/manual page eligibility могут измениться. Это оставлено отдельному минимальному дизайну O1, в savings отчёта не включено.
- **Не обещать новые индексы без EXPLAIN.** Таблица states по сути небольшая; проблема выше — доказанные повторения и область locking. Existing page PK уже помогает page-scoped lookup. Исторические scans в cleanup и схемы OFAPI capture относятся к другим направлениям/известному O2 baseline и не дублируются здесь.
- **Не считать production снятой точной копией main.** Follower-count и HTTP abort уже отличаются; любые будущие патчи должны строиться поверх production fixes, а не откатывать их.

## Воспроизводимость и ограничения

Из корня `/Users/dmitriy/code/goose/hub`:

```sh
node --import tsx/esm investigations/sync-optimization-swarm-2026-09-13/01-queue-sql/probe.mjs
```

Harness завершился успешно на обеих git-ревизиях; финальный запуск занял около 1,3 s wall time. Это длительность самого probe, **не performance benchmark**. До финального запуска исправлены две ошибки самого harness: относительный путь к schema и разбор `ANY(ARRAY[$n::sync_stream])` в fake DB. Продуктовый код не изменялся. Fake DB не симулирует MVCC/locks/TOAST/реальную задержку, поэтому не доказывает concurrent correctness или PostgreSQL query plan. Fake-timer polling считает алгоритмические вызовы; 60 rounds не означают минуту наблюдения production.

Измерения production, A/B, Vitest, Testcontainers, package installs и subagents не выполнялись. Собственный вывод ограничен четырьмя локально подтверждёнными издержками и условными дизайнами. Для принятия performance patch сначала нужны указанные targeted regression interleavings, затем canary с нормировкой на полезную работу; из этих результатов нельзя вывести ускорение всей fleet или потребность в увеличении capacity.

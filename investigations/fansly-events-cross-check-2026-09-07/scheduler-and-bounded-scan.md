# Независимая сверка: scheduler, ограниченный обход и зависимые потоки

Дата: 2026-09-07. Проверен **`origin/main=dcbba081d3bfbbf19a5e3ccf0ea3d77646d5076d`** через `git show origin/main:<path>`; локальный HEAD остаётся `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`. Ниже номера строк **кода относятся к dcbba081**, а не к старым номерам двух документов. Исследование read-only; runtime и production не менялись, provider-запросов не было.

Сравнены актуальные файлы: **D** = `docs/research/fansly-events-architecture-2026-09-07/ARCHITECTURE.md` (уже с поправками после арбитра); **I** = `investigations/fansly-events-architecture-2026-09-07/ARCHITECTURE.md`; арбитр = `docs/research/fansly-events-cross-review-2026-09-07.md`.

## Вердикт

**Взять A0 из D как первый эксперимент, но не принять утверждение арбитра, что ограниченный обход уже доказанно сохраняет прежнюю свежесть и даёт −46%.** Shadow внутри прежнего полного обхода безопасен: он измеряет гипотетическую точку остановки, не убирая reads, не меняя membership или историю. Для включения реальной ранней остановки нужны более строгие условия ниже. До них сохраняется независимый полный discovery из I. Сокет для A0 не нужен.

Для первого изменения **сохранить cadence scheduler 1800 s**, а интервалы discovery/full audit задавать живой per-page policy внутри Fansly handler. Это минимальный путь из D. I справедливо требует единый effective policy и rollback; его можно реализовать как общий resolver этих двух внутренних deadlines, без немедленной переделки scheduler slots. «Только handler технически возможен» — неверно: полноценный cadence resolver тоже возможен, но требует атомарного переноса slot state.

Недельный `fan_earnings` вместо ежедневного и 48 h `followers_reconcile` вместо фактически более частого — **отдельные изменения свежести/полноты**, не бесплатные следствия A. Их нельзя включать по одному факту совпадения ответов.

## 1. Что именно известно о порядке `/messaging/groups`

- Current adapter передаёт `sortOrder`, `offset`, `limit`, `flags`; endpoint не предлагает `updatedSince`, resume token или snapshot version. Завершение означает `data.length < limit`: `packages/fansly/src/adapter.ts:1129–1184`.
- В бандле `main.pretty.js:160812` действительно `NEWEST:1`, а `:160373–160387` UI передаёт этот режим API. Более сильное подтверждение намерения: клиент локально сортирует `lastMessage.createdAt` по убыванию, `:160754–160769`. Поэтому это разумная гипотеза для shadow, а не случайное предположение.
- Но это **не серверный контракт** стабильности offset-пагинации, порядка всех типов групп и связи двух markers. Типы Hub допускают отсутствующий `lastMessage`, отсутствующий `lastMessageId`; общий mutation watermark отсутствует: `packages/fansly/src/types.ts:244–271`. I дополнительно имеет наблюдение несовпадения list ID и embedded ID, I:193.
- Сам Hub уже защищается от повторённых/перекрывающихся group IDs, перезапуская full sweep: `executor-handlers.ts:2997–3019,3351–3366,3565–3573`. Это реальная mutable list, не атомарный snapshot.

Арбитр в разногласии №11 приравнял bounded walk D к независимому discovery I слишком рано: оба ходят независимо от WS, но **полнота первого зависит от stop rule**, полнота второго пока не опирается на недоказанную раннюю остановку.

## 2. Новые DM за первыми K страницами

D:148 в обычном режиме описывает **динамический** walk до временной границы, а не жёсткий K. Не следует приписывать ему отсутствующий лимит. Однако D:195 прямо обещает reconnect catch-up «1–3 страницы», а его оценка стоимости предполагает около трёх страниц. Эти числа допустимы как наблюдаемое среднее либо бюджет одного чанка, **не как условие успешного завершения**.

Контрпример даже при идеальной сортировке: после простоя появилось 450 изменившихся диалогов, `limit=100`, `K=3`. Дочитаны 300, оставшиеся 150 не проверены. Если сохранить «новый watermark = начало этого запуска» и начать следующий раз сверху, эти 150 окажутся старше новой границы; при достаточно активной голове они могут не попадать в первые K до полного обхода через 6 h. Живой pong ничего не исправляет. Условие «K исчерпан» должно возвращать `pending/yield`, сохранять ту же coverage boundary и продолжение; **не `satisfied` и не новое доказательство свежести**. Текущий budget 5 HTTP /45 s уже различает yield и completion: `sync/chunk-budget.ts:5–12,28–54`.

Аналогичная ошибка без K: D:148 связывает watermark с **началом предыдущего bounded walk**, не уточняя, что тот завершён. Неуспешный/отменённый запуск не может сдвигать нижнюю границу. После часов outage или parse failure «previous attempt minus 5 min» потеряет предыдущий долг.

Минимальный контракт пригодного bounded walker:

1. Отдельно `lastCompletedDiscoveryBoundary`, frozen boundary текущего walk, startedAt, cursor/progress и unresolved debt. Watermark публикуется только после завершённой проверки, а не по запуску/слоту/heartbeat. Отсутствующий baseline требует bootstrap.
2. Прочитывать всё множество heads новее frozen boundary, продолжая чанками. Фиксированные 1–3 страницы — yield. Deadline относится к завершению всех required targets и materialization, а не к началу первой страницы.
3. Пропущенный/malformed timestamp, несовпадение markers, неизвестная group/identity или нарушение сортировки **не считаются «старым неизменным диалогом»**. Сохранить evidence и продолжить/назначить scoped repair; спорный участок нельзя закрыть ранним stop.
4. Удаление головы с откатом timestamp, появление ранее скрытой группы со старой историей и изменения старого материала требуют отдельной сверки. New-message timestamp не является универсальным mutation index.
5. При непрерывном reorder нужны overlap/restart rules и ограничение возраста незавершённой проверки. Один old page сам по себе не доказывает, что позже нет свежей головы, пока порядок не подтверждён. Если такой detector нельзя доказательно сделать дешевле, оставить полный inventory.

Shadow «0 пропусков 7 дней» полезен, но недостаточен один: сравнение должно использовать snapshot головы **до применения full page**, сверять stable IDs и оба markers, считать неизвестные/непроверяемые строки отдельным долгом, учитывать requested attempts и время чтения. Нужны fixtures/controlled scenarios: >K changed groups, restart до completion, failure после checkpoint progress, постоянно меняющийся head, old head deletion, empty/partial sidecar и unseen group со старой датой. Иначе недельное отсутствие редкого сценария ошибочно станет гарантией.

**Достаточны ли valid markers + last completed boundary + отсутствие hard K? Нет, при mutable offset нужны дополнительные оговорки.** Минимальный контрпример с `limit=2`, frozen boundary=0, убывающими head times `[29,28,24,23,22,21,20,19,-1,-2]`. Sweep начинается в30, читает offsets0,2,4. После этого исчезает уже прочитанный первый group29. Запрос offset6 возвращает `[19,-1]`: group20 сдвинулся на index5 и пропущен без duplicate. Sweep доходит до конца, все timestamps корректны. Следующий watermark25: чтение `[28,24]`, затем `[23,22]` позволяет early stop, пропущенный group20 остаётся ниже. Если total drift guard включён, он поймает конкретное удаление; компенсирующее добавление старого/скрытого group сохраняет total и показывает предел такого guard. Это модель возможного offset churn, не утверждение о наблюдавшейся именно такой последовательности Fansly.

Следовательно, order checks, overlap/recheck и сравнение total — нужные защитные меры, но **без контракта snapshot/cursor или ограничения churn нет строгой гарантии**. Полный audit позднее исправляет конечное состояние, однако уже не сохраняет30min discovery. В финальном решении надо назвать этот предел; «0 misses в shadow» — эмпирический acceptance, а не доказательство отсутствия будущего случая. Если требование — не расширять такое окно даже при нарушении эвристики, полный independent detector остаётся с прежним deadline.

Сравнение с baseline здесь конкретное, а не требование магической безошибочности: **старый full walker тоже может пропустить group20 в движущемся списке текущего запуска**, но следующий полный30min обход при стабилизировавшемся списке его прочитает. Новый bounded walker с watermark25 намеренно остановится раньше и может ждать full6h. Именно расширение окна восстановления является регрессией. Рабочий baseline следует измерять как30min slot **плюс очередь/дочитка/apply**, а не обещать, что текущая система уже даёт строгие30min end-to-end.

### Минимальный A0 без дополнительных HTTP

В existing full sweep считать shadow result из уже captured list pages; accounts/group hydration не добавлять ради эксперимента. Не менять real execution, finalization и history выборку. Состояние одного shadow generation хранить рядом/отдельно от full cursor и продолжать между чанками: `sourceSweepGeneration`, start/frozen boundary, candidate stop page+reason, eligible/unknown marker counts, would-fetch/skip counts, changed refs ниже stop, finish/outcome. Failure/restart сохраняет незавершённый outcome; новую completed boundary нельзя получить от отброшенного запуска.

Минимальные наблюдаемые показатели:

- Полные начатые/завершённые/перезапущенные обходы; `candidate_stop` и фактическая последняя страница; распределение K по странице и по bursts, не только среднее.
- Ниже candidate stop: новые group IDs, новые head IDs, несовпадающие embedded/list markers, head regressions, изменения unread/flags/visibility/identity; неизвестное отдельной категорией, не «0 misses».
- Scope-aware lag: `walk_start→finish`, head discovery→required readers, время последнего completed head discovery и full membership, retained mutation debt. Нарушение30min видно и при healthy socket.
- Фактические HTTP attempts/time/bytes и гипотетически исключённые **list calls** отдельно от уже условных detail calls. В A0 savings=0: HTTP экономия только рассчитана по trace.
- Existing deep cursor/progress, oldest pending history age, завершённые history pages и доля capacity. A0 не меняет dispatch и не добавляет provider calls; новый A-on runner yield-ит в существующий page fairness, сохраняет quota history и никогда не пересоздаёт deep cursor при каждом discovery.

Для последних пунктов есть текущий substrate: durable message cursor `executor-handlers.ts:3763–3776`, выбор deep backfill/quota `:3874–3895`, перенос `currentBeforeMessageId`/live-request counter `:3907–3921`. Если увеличение числа маленьких discovery jobs съедает его квоту, такой canary не проходит, несмотря на снижение total requests.

## 3. История и скрытые consumers

Пропущенную inventory-строку **не подберёт автоматически `dm_messages`**. Candidate query смотрит только известные visible треды с fanId и head mismatch/pending backfill: `packages/db/src/repositories/page-dm.ts:1054–1113`. Неизвестного vendor group в этой таблице нет; у известного треда со старой сохранённой головой нет нового mismatch. После записи list page именно `dm_conversations` запрашивает follow-up, `executor-handlers.ts:3588–3594`.

Deep history выбирается из того же локального roster (`page-dm.ts:1157–1205`), сохраняет отдельный before cursor (`executor-handlers.ts:3907–3919`) и пользуется существующим quota path. Урежение discovery нового/вернувшегося треда задерживает и начало его истории, даже если код исторического потока не менялся. Честное «история не ухудшилась» проверяет **прогресс и время обнаружения новых кандидатов**, не отсутствие diff в history handler.

Полезная защита D:149 — bounded не входит в destructive finalization. Её надо усилить: bounded не присваивает full generation и не изменяет full coverage receipt. В current full walk generation set count должен равняться observed count, затем разрешено скрытие, `executor-handlers.ts:3413–3486`; SQL скрывает все visible со старой/null generation, `page-dm.ts:247–263`. Частичная проверка не имеет права подавать себя как полный membership proof, даже если каждый прочитанный row корректен.

Это больше, чем бейдж unread:

| Данные/reader | Последствие от непрочитанного старого/скрытого треда |
|---|---|
| `page_dm_threads`: flags, unread, tier, lastUnread, identity eligibility, visible, head | Эти поля записываются list handler, `executor-handlers.ts:3286–3327`. Старый timestamp не означает неизменность всех полей. |
| Workboard / needs-reply / closing | Primary thread требует visible и fanId, читает head и роли, `workboard-v2.ts:125–150`; closing требует visible и last sender=fan, `:739–763`. Потерянная/устаревшая строка влияет на рабочую очередь. |
| Архив/AI/Agent reader | Новая полная история появляется после REST message walk и canonicalization. Неизвестные треды и невыданные follow-ups дают downstream lag; горячая голова не равна свежему архиву. |
| Existing old-message mutations | Head-to-overlap не проверяет старые edits/deletes, `executor-handlers.ts:4082–4083`. Этот исходный предел нельзя объявлять закрытым ни A, ни сокетом. I §9 правильно разделяет mutation coverage. |

D:151 честно признаёт flags/unread drift до полного интервала; **D:17 и D:27 одновременно обещают прежнюю свежесть/≤30 min**. При 6 h audit это противоречие. Пользователь исходно требует сохранить свежесть, поэтому такой продуктовый компромисс пока не принят. Без отдельного полного detector этих полей нельзя обещать ≤30 min для всей DM поверхности.

## 4. Slot trap, per-page policy и честное здоровье

Три подтверждённых текущих механизма:

- `computeCurrentPageSyncSlot = floor((epochSeconds-offset)/cadence)`, `page-sync.ts:1012–1018`; offset тоже зависит от global policy, `:1001–1008`.
- Каждый ensure цикл возвращает cadence и offset к `SYNC_STREAM_POLICY`, **не rebasing `last_scheduled_slot`**, `:1600–1617`.
- Planner пропускает row, если новый currentSlot ≤ старый lastScheduledSlot, `:1938–1940`. Увеличение cadence уменьшает индекс: scheduled loop может замолчать на десятки/сотни лет. Это не буквально «никогда»: explicit pending requests идут другой веткой, `:1920–1935`, а время математически догонит индекс.

Следствие: наивный SQL flip cadence или изменение константы действительно непригодны. Но арбитр ошибочно объявил handler единственным допустимым решением. Альтернатива I возможна при effective resolver **во всех** seed/ensure/offset/slot/due/status/fallback sites плюс atomic slot rebase и сохранение pending requests. Это изменение приложения/состояния, не обязательная новая схема. Для A0 оно излишне; оставить tick и resolver внутренних deadlines проще.

**SLA/503 D подтвердился, но его обход не надо путать с correctness.** DM stream и messages_live имеют SLA3600 s, `page-sync.ts:253–262,468–472`; `sync-status.ts:960,1029–1039` измеряет `succeededAt`, stale превращается в delayed. `health.ts:257,299–300,367–376` даёт 503 на delayed. OF `reconcile_not_due` действительно возвращает `satisfied:true` без `gatedSkip`, `ofapi-dm-sync.ts:558–573`; executor вызывает complete, `executor.ts:652–676`, а complete обновляет `succeeded_at`, `page-sync.ts:2385–2405`.

Но в том же текущем репозитории `skipPageSync` специально **не** штампует fake freshness и не сбрасывает failure streak (`page-sync.ts:2433–2443`), потому что такой дефект уже скрывал остановку 13 дней. OF display override дополнительно использует 24 h last event (`sync-status.ts:1386–1435`); прямое копирование четырёх строк не доказывает Fansly SLO.

Для A допустим successful completed **head discovery scope** после реальных reads, но `lastFullSweepCompletedAt` и mutation/membership coverage остаются прежними. Для B нужны отдельные receive/apply/discovery clocks и debt; heartbeat и `reconcile_not_due` не делают материал свежим. Проверять одновременно HTTP200/503, task state, full coverage age и oldest undiscovered/unapplied debt. Green health сам по себе не gate полноты.

## 5. `followers_reconcile`: реальный trigger, но причина ещё не доказана

Арбитр правильно поправил seed-only объяснение. Current `executor-handlers.ts:2083–2093` в конце завершённого hourly followers вызывает anomaly при **любом из трёх условий**:

1. activeFollowerCount ≠ sourceFollowerCount;
2. knownFollowId есть, provider exhausted, known checkpoint не встретился;
3. knownFollowId есть, newestFollowId равен ему, но обработаны новые rows.

Функция `triggerFollowersReconcileAnomaly`, `:475–484`, запрашивает stream с `source:'anomaly'`. Seed condition `page-sync.ts:1061–1070` — другой механизм. Нельзя из одной агрегированной частоты доказать, какой OR-arm реально срабатывал, и нельзя убрать anomaly, просто заставив выполнять только scheduled48h.

Текущий incremental останавливается на known follow ID (`executor-handlers.ts:1990–1995`), не сверяет весь membership. Full reconcile нужен для удалений/сдвигов. Сначала читать reason-specific evidence, проверить count semantics, destructive proof и generation outcomes; затем исправлять ложный trigger или coalescing. Если count mismatch отражает реальное неполное membership, его подавление ухудшит данные. Повторный request не даёт права сдвигать independent full deadline.

Скрытый эффект: присутствие обновляется из прочитанных followers/accounts (`executor-handlers.ts:1979–1982,2017–2035`). Более редкий full roster уменьшает наблюдения старых фанатов, которых hourly prefix не читает. Даже если desired cadence48h записан давно, текущую более частую наблюдаемость нельзя выдать за неизменившийся продуктовый результат без проверки presence consumers.

## 6. `fan_earnings`: delta перспективна, new transaction недостаточно

Положительная часть D подтверждена: current walker spenders-only, 2 HTTP per fan, keyset с contiguous successful prefix, отдельный журнал каждого ответа (`executor-handlers.ts:4377–4455`); завершение сбрасывает cursor для следующей ежедневной сверки (`:4490–4518`). Это хороший кандидат на coalesced dirty refresh.

Но D:199 «только новая транзакция + недельный проход» оставляет три конкретные дыры:

1. **Same-ID corrections.** REST upsert уже меняет transaction state/status/amount/sourceUpdatedAt (`sync/transactions.ts:415–440`, `db/repositories/transactions.ts:90–106,112–137`). Existing canonical event dedup — `txn:<id>` (`canonicalize/sync-pull.ts:64–106`), поэтому подписка только на новый `transaction.posted` не увидит повторное material change. Dirty должен возникать на подтверждённой semantic delta при REST apply, а не на mere refetch/row updated_at и не только createdAt/new ID.
2. **Provider aggregation lag.** Ничто в коде/приложенных наблюдениях не доказывает атомарность transaction ledger и двух stats endpoints. Если первое dirty чтение произошло до обновления vendor aggregate, после него новых транзакций может не быть. Нужна незакрытая expected revision/revalidation либо independent rotation с прежним freshness ceiling, а не немедленный settle «ответ200 значит обновилось». Same-ID settlement, missing fan mapping и baseline без stats тоже должны создавать долг.
3. **Ложная свежесть board.** `listTopFanEarnings` читает provider projection, `message-archive.ts:1586–1606`; snapshot meta сообщает **MAX** observed_at, `:1622–1631`. При delta один active fan обновляет builtAt всей доски, остальные могут быть недельными. Нужны раздельные last observed и full coverage/min age/debt, иначе UI будет выглядеть свежим при старых rankings. Проверить существующий extension reader и ограничение mixed-age snapshot.

Сохранить periodic rotation необходимо. Переход daily→weekly без доказательства зависимостей stats от complete semantic ledger delta ухудшает верхнюю границу обнаружения тихих корректировок. Оценку «−5000+» считать гипотезой, зависящей от безопасного retry/rotation объёма, не гарантированным результатом маленького diff.

## Рекомендуемая последовательность решения

1. A0: shadow decision на прежних full reads; реальные counters/стоимость/coverage по странице, указанные failure fixtures. Никаких cadence flips или новых сокетов для этого не требуется.
2. Одновременно read-only диагностика трёх follower trigger arms и semantic earnings delta/lag. Подготовить scoped исправления независимо от WS.
3. A-on только после уточнения completed boundary, continuation beyond K, missing markers/reorder, head deletion/visibility и раздельных clocks. Full inventory сохраняется до доказательства сохранения freshness всех required fields; если доказательство не получено — A не получает обещанный процент.
4. C — отдельные canary/gates, initial catch-up и rollback к прежней policy. B — по транспортным и custody gates, не как средство спрятать нерешённый discovery.

Технически сильнейший итог — **D как короткий план эксперимента и количественные гипотезы, I как обязательные инварианты полноты/сбоев; ни один документ целиком без этих уточнений**. Сокращение нагрузки не должно достигаться переносом невыявленных данных на шестичасовое/недельное окно под зелёным `succeeded_at`.

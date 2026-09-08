# Независимая критическая сверка конечного подхода

Дата: 2026-09-07. Прочитаны текущие D (`docs/research/fansly-events-architecture-2026-09-07/ARCHITECTURE.md`), I (`investigations/fansly-events-architecture-2026-09-07/ARCHITECTURE.md`) и кросс-сверка. Решающий код перепроверен через `git show origin/main:…` на `dcbba081d3bfbbf19a5e3ccf0ea3d77646d5076d`; local HEAD остаётся `582ef1cf`. Production/runtime не читались и не изменялись в этой независимой ветке. Экономику, реальный SQL scope и правила bounded stop проверяют другие ветки.

Координатор дополнительно сообщил live verification: production теперь на том же `dcbba081…`; permissive14-column SELECT для `page_sync_states` успешен, хотя full-table SELECT отсутствует. Поэтому прежняя оговорка I о полном отсутствии доступа к sync states нуждается в исправлении. `sync_http_attempts`/config SELECT всё ещё недоступны. Это evidence координатора, не самостоятельный production probe данного reviewer.

## Решение

**Начать с измеряемого сокращения повторных REST-чтений; native WS исследовать параллельно и вводить как ускоритель свежести. Конечная система — один Hub sync с тремя причинами работы: независимый discovery, адресный dirty hint и история.** Сокет не является условием первой экономии, а успешный bounded walk не является условием начать безопасную проверку протокола.

Первый implementation slice — **A0: чистый shadow bounded-stop внутри уже выполняемого полного обхода**, без дополнительных Fansly запросов и без изменений serving state, checkpoint, membership, success/freshness. Он даёт ответ о реализуемости A, а не обещанную экономию. A-on разрешается только при доказанном stop contract и прежнем пределе обнаружения; статистическое «0 misses за неделю» — дополнительное свидетельство, а не математическое доказательство порядка сортировки.

Затем отдельно исправлять доказанную лишнюю работу followers и добавлять transaction-driven **кандидатов для REST fan earnings**, не заменяя vendor stats арифметикой Hub и не отменяя независимую сверку. Native WS сначала raw+hint-only; прямую запись DM отложить до доказанной полноты payload и shared writer/material semantics. Так используются полезные части обоих документов без принятия их небезопасных обещаний.

Не принимать как конечную спецификацию D целиком. Кросс-сверка верно выделила гипотезу bounded walk, но смешала «полезная измеренная возможность» с «доказанная безопасная экономия», а исправленный D всё ещё содержит явный loss-on-cap и невыполнимый rollback. I задаёт более точные гарантии отказов; его общий materializer и политику всех потоков не надо строить до shadow A0 или транспортного spike.

## Что в текущих документах необходимо исправить

| Приоритет | Место | Конкретный дефект / минимальная правка |
|---|---|---|
| P1 | D §5.2:180 | После cap кадры «считаются, но не пишутся», соединение закрывается только после 3×cap. Это сознательная потеря уже получаемых business frames, а не capture-first. Не сохранять только heartbeat/доказанную ephemeral telemetry можно по явной policy; business overflow означает немедленный degraded/gap и прекращение приёма при невозможности durable capture. Считать и не журналировать бизнес-кадры нельзя |
| P1 | D §7, таблица «Потеря? Нет»; §0:23/25 | DB down, crash до raw commit, disconnect и overload без upstream replay могут потерять transient facts. Полный обход доказывает только доступный scope/состояние по конкретным traversal rules. Заменить `Нет` на точные guarantee/gap outcomes из I; не считать reconnect/full inventory доказательством полной истории мутаций |
| P1 | D §0:25, §7 rollback B, §9 live rollback | «Один полный обход исправит уже записанные WS строки» не следует из кода: list walk не переписывает произвольные старые message bodies, не отменяет ложные старые tombstones, а head-forward после B намеренно отказывает старому head без отдельного repair. Rollback прекращает ухудшение; исправление данных — versioned bounded repair/replay с receipt и проверкой required readers |
| P1 перед C2 | D §5.3:199 и C2 плана | «Новая транзакция с прошлого чтения + недельный обход» не покрывает изменения старого transaction ID, provider stats без новой transaction и исторический A→B→A. Ни transaction.createdAt cursor, ни существующий `transaction.posted` event для этого не годятся. Ниже — конкретный минимальный контракт |
| P2 | D §5.2:172 / §7 worker failover | Advisory lock не означает, что старый upstream socket физически исчез одновременно с потерей DB session. Если один выделенный pg-client держит все page locks, его потеря требует остановки **всех** принадлежащих ему receivers до reacquire. Один logical owner и допустимое физическое overlap различать; overlap — transport gate, не заранее «безвреден» |
| P2 | D §5.2:189/195 | Catch-up «1–3 страницы» или 4 страницы на тред ограничивает один dispatch, а не длину неизвестного gap. Остаток должен иметь durable continuation до старой проверенной boundary. Existing completed deep-backfill cursor сам по себе не представляет эту новую дыру и может никогда не выбрать её |
| P2 | D §5.4:206/213 | Номер migration0150/decision250 взят из старой базы. Выбирать номера от актуального main. Новый enum value влияет на strict clients даже без нового endpoint: compatibility/re-vendor определяется readers' accepted values, а не наличием новой операции |
| P2 | I §11 этапы0–1 vs конечный объединённый план | Whole-system admission, policy resolver и shared DM materializer перечислены слишком близко к первой работе. Разделить prerequisites по этапам: A0 ничего из этого не требует; WSS shadow требует custody/route/receiver fencing; адресный fetch — dirty CAS и admission; direct apply — shared material semantics |

В D §0:27 заявлено unread drift ≤30 минут «при любом рычаге», но §5.1:151 и §10:3 разрешают до интервала полного обхода, то есть до6 часов. Это отдельное изменение поведения продукта, которое нельзя назвать сохранением прежней свежести. Поскольку пользователь просит свежесть сохранить, default конечного плана — прежняя доказанная граница; более редкий unread/state repair требует отдельного принятия изменённой гарантии.

## Fan earnings: кандидаты от транзакций полезны, `new transaction` недостаточно

Проверенный main:

- `executeFanEarningsChunk`, `executor-handlers.ts:4353–4541`: два REST запроса на fan (lifetime + monthly), spendersOnly, собственный последовательный fan cursor; каждый успешный ответ отдельно capture-first.
- `persistFanslyTransactionsPage`, `sync/transactions.ts:368–453`: транзакции upsert-ятся вместе с checkpoint в `withOwnedPageSyncTransaction`; old `transactionId` может получить новые state/status/amount/attribution. `upsertTransaction` (`repositories/transactions.ts:81–169`) возвращает row, но не возвращает доказательство semantic change.
- `sync/transactions.ts:557–595`: incremental read имеет lookback и rescan cap; defaults `transactionLookbackDays=7`, `transactionRescanCapDays=30` в config registry139–140, **effective values этой веткой не прочитаны**. Изменение старой posted transaction за lookback не гарантированно обнаруживается; слишком старый pending явно clamped.
- `canonicalize/sync-pull.ts:79–106`: `transaction.posted` dedup только `txn:<id>`. Повторное изменение того же transaction ID не создаёт ещё один такой event. Следовательно, поставить заработки на этот consumer — потерять обновления статуса/суммы.
- `fan_earnings_stats` — отдельная provider snapshot projection (`projections/fan-earnings.ts`), а не доказанный эквивалент SUM(transactions). `getFanEarningsSnapshotMeta` (`message-archive.ts:1615–1634`) показывает **max** observedAt, который не сертификат свежести всех fans/windows.

Минимальная будущая схема C2:

1. Transaction writer определяет **семантический** insert/change под тем же DB transaction: fan binding, active/suppression, state/status, money, type и связанные поля. Повтор идентичного payload не создаёт dirty. Пометить old и new fan, если attribution изменился. Не использовать `occurredAt > lastScan` или просто `upsert returned row`.
2. В этой же transaction upsert `subject_refresh_state(page, fan_earnings, nativeFanRef)` с monotonically requested revision. Это не отдельный event broker, CDC-сервис или новый workflow engine.
3. Executor берёт R, делает прежние два provider reads, журналирует оба, завершает R только после корректной materialization/receipt обоих необходимых scopes. Partial success не заставляет повторять удачный вызов бесконечно и не стирает вторую debt; R+1 сохраняется при гонке.
4. Сохраняется периодическая независимая rotation с **явным максимальным возрастом** каждого fan/window. Дневную проверку нельзя заменить недельной, одновременно утверждая прежнюю daily correctness/freshness для изменений без detector. Сначала shadow измеряет vendor changes без prior transaction signal; потом отдельно принимается cadence.
5. Newly discovered fan, zero/negative-net fan после reversal, old correction, unknown attribution, delayed vendor settlement и provider response `[]` рассматриваются явно. Если dirty выбирается через старое `spendersOnly net>0`, обнулённый reversal fan может потерять последнее исправление и сохранить старый положительный ranking.
6. `last_checked_at` и `last_changed_at` — разные evidence. Не обновлять денежный event искусственно ради зелёной freshness; при unchanged response сохранять check receipt, а при failed/partial capture freshness не продвигать.

Не применять transaction delta к сумме fan_earnings напрямую. До доказательства эквивалентности units/categories/adjustments это создаёт вторую финансовую истину. Транзакция выбирает **кого перепроверить у Fansly**.

### Нижняя граница стоимости C2 без сокета

Координатор воспроизвёл по production6d средний baseline `fan_earnings=5724` observations/day для двух существующих вызовов на fan. Даже если **ни у кого не изменились деньги**, обещанный D недельный полный проход даёт `5724/7 ≈ 818` вызовов/day в среднем. Поэтому итог D «fan_earnings≈300/day, включая weekly sweep» арифметически невозможен при том же roster и двух endpoint reads. Правильная модель: `818 + 2×U + retries/partial-repair`, где U — число дополнительных объединённых fan refresh вне недельной rotation, с исключением двойного учёта совпавших заданий. При сохранении daily full check baseline остаётся5724, пока не доказан иной detector для quiet fan corrections.

Это кандидат на большую экономию без WS, но число «несколько сотен» и экономия−5400/day не могут служить gate/обоснованием до пересчёта. Вводить C2 отдельным slice полезно; считать его тривиальным флажком — нет, поскольку нужны вышеописанные invalidation и material identity.

### Подтверждённый A→B→A defect существующей earnings canonicalization

`canonicalize/sync-pull.ts:365–375` использует key `fan_earnings:<fan>:<window>:stableHash(aggregate)`; `upsertFanEarningsStat`, `message-archive.ts:1549–1563`, выбирает новое состояние по observedAt. Возврат к ранее наблюдавшемуся aggregate дедупится историческим key и **не возвращает projection к этому состоянию**. Это не гипотеза о rate limit и не доказанный production incident; это воспроизводимое свойство текущего кода, которое влияет на C2 и не лечится weekly re-read.

Локально выполнен реальный `canonicalizeSyncPullObservation` (его файл byte-identical между HEAD и проверенным origin/main), затем смоделирован существующий first-key-wins ledger:

```text
inputNet 100000 → key …:6df73eae → appended → projectedNet 100000
inputNet 110000 → key …:5c0de26e → appended → projectedNet 110000
inputNet 100000 → key …:6df73eae → deduped  → projectedNet 110000
```

DB integration этим воспроизведением не запускалась: canonical keys фактически получены из кода, ledger behavior сверено с `domain_event_keys` protocol. До C2 acceptance нужен versioned correction: semantic content fingerprint хранить отдельно от identity конкретного наблюдения/изменения; новый receipt с более поздним временем и прежним содержимым должен иметь возможность подтвердить возвращённое состояние. Replay того же observation остаётся идемпотентным. Подход с observation-ref+parser version, либо явным transition revision под account lock, надо согласовать с правилами неизменившихся снимков. Не оставлять 32-bit `stableHash` единственной гарантией идентичности.

Обязательные C2 cases: unchanged retry, pending→posted на том же ID, refund/late correction за lookback, fan reassignment, A→B→A, empty zero snapshot, old stale response после свежего, crash между transaction commit и dirty intent, R+1 во время двух запросов, после первого успешного/второго неуспешного ответа, user pause/rollback с pending dirties.

## Минимальная последовательность без лишней инфраструктуры

| Этап | Что обязательно | Что отложить |
|---|---|---|
| 0: evidence | Подтверждение базовой ревизии, physical-attempt baseline, safe-stop fixtures; read-only исследование follower trigger; WS протокол/second-connection отдельным безопасным gate | Не требуется общий materializer или новый transport в production |
| A0: shadow в существующем полном обходе | Только диагностическое virtual-stop решение; журнал/serving/checkpoints/финализация неизменны; bounded-vs-full comparison | Никакого WS, rate increase, нового расписания |
| A1: canary bounded + independent full reconcile | Стоп-контракт, missing-marker fail-closed, свой cursor без membership finalization, truthful freshness, пропуск/offset/outage тесты, откат конкретной policy | Не обещать−46% до наблюдаемого gate; WS не нужен |
| C1/C2 отдельные slices | Follower RCA; для earnings — semantic dirty writer+revision CAS, independent max-age, A→B→A repair | Не ставить weekly sweep по умолчанию, не вычислять provider stats из локальных сумм |
| B0: WSS proof/shadow | Scoped egress и auth binding, generation, one logical receiver ownership, durable raw, decode debt, reconnect cooldown, no business drop cap | Не выполнять WS hot writes; не делать17 новых materializers |
| B1: hints | Revision dirty targets, dispatcher/attempt budget/cooldown, independent detector и guaranteed history progress | Не запускать full sync на frame; не переписывать source-of-truth |
| B2: optional direct DM | Corpus completeness, single canonical append authority, shared serving writer, existing `message.material_observed`, tombstone/old mutation repair и receipt | Не вводить дублирующий hot-truth слой, из которого нужные readers узнают факт только через будущий REST |

Receiver lock implementation не должен становиться спором ради формализма. Один dedicated DB session с advisory locks всех разрешённых pages дешевле дополнительной lease FSM и может быть приемлем при single-worker topology, **если** потеря этой session закрывает все sockets, состояние поколения fenced и overlap безопасен по наблюдению. DB lease пригоднее для scaleout, но тоже не гарантирует отсутствия физических overlaps. Выбирать по текущему topology, сохраняя одинаковые custody/failure invariants.

Снижение polling и receiver можно откатывать независимо. Возвращать прежнюю due-policy с jitter; не стирать retained raw, history cursors, pending revisions и owner pauses. Inflight work заканчивает только собственную leased revision. Уже ошибочно записанная сумма/голова/удаление требует отдельного repair, а не обещания «полный обход всё исправит».

## Что должен утверждать окончательный ответ владельцу

«Сначала проверяем и убираем повторные чтения, затем добавляем события для секундной свежести. Bounded scan — основной кандидат на экономию, но безопасное раннее завершение ещё надо подтвердить. Сокет получает всё, что реально доставляет Fansly, и не заменяет историю/сверку. Статистика спендеров обновляется адресно после подтверждённых изменений, с независимой проверкой и исправленной идемпотентностью. При сбое показываем scope/возраст/пропуск; production switches по одному, откат не удаляет факты».

Цифры экономии — проверяемые сценарии, а не уже установленный результат. Это позволяет выбрать один конкретный путь сейчас, не подменяя отсутствующие upstream guarantees красивыми процентами.

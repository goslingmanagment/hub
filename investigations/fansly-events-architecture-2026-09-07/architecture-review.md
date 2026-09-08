# Независимая архитектурная проверка Fansly event-assisted sync

Дата: 2026-09-07. Проверенный Hub: `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`. Это самостоятельный review кода и вариантов, до чтения основного архитектурного документа. Runtime, production, браузер и credentials не менялись. Доступность конкретного Fansly WebSocket, перечень его сообщений, replay и переносимость сессии этот review **не устанавливает**: их должна подтвердить отдельная ветка исследования трафика.

Дополнительно сравнен предоставленный координатором production commit `2475b3046332` с local HEAD по перечисленным safety seams. Retry-After parser, Fansly canonicalizer, credentials generation, shared rate limiter, dirty settlement и relevant auth pause/recovery имеют те же свойства. Различия executor/page-sync/cursor-state относятся преимущественно к OFAPI collection/binding/quality hold; production также содержит erasure fence внутри `upsertPostLike`, которого нет в local HEAD. Поэтому реализовывать следует от актуальной принятой production/main базы и сохранять этот fence, а не копировать старую локальную функцию целиком. Это сравнение git-объектов; самостоятельного live deployment verification данный reviewer не выполнял.

## Вердикт

Рекомендован **гибрид: непрерывный приём сигналов + объединяемые адресные обновления + независимая REST-сверка + существующий backfill**. Целевой транспорт — небольшой постоянно работающий серверный WSS collector, **только после доказательства его работоспособности через назначенный прокси и нужную сессию**. До этого применяется тот же downstream с browser relay и сохранённым polling. Отсутствие доказанного транспорта означает, что сокращать polling по обещанию доступности 24/7 ещё нельзя.

Первый релиз должен трактовать WS как сигнал «проверь этот объект», а не автоматически как готовый финансовый или DM факт. Часть полной полезной нагрузки можно начать материализовать напрямую позже, отдельно для каждого доказанного типа. Это немного медленнее максимально агрессивной схемы, зато не вводит второй источник истины и не отравляет существующую дедупликацию неполными сообщениями.

Нельзя обещать абсолютную полноту на интервале разрыва, если Fansly не даёт replay и успевает удалить факт до REST-сверки. Честная гарантия: не терять уже принятые Hub факты, быстро принимать доступные сигналы, восстанавливать доступную провайдеру историю, показывать неизвестные интервалы отдельно от подтверждённо пройденных страниц.

## Что уже подтверждено кодом

| Основание | Архитектурное следствие |
|---|---|
| `CLAUDE.md`, decisions #73/#100, Stage 7/8/17/25/26: observation → canonical events → rebuildable projections; pg-boss и Postgres уже являются substrate | Сохранить этот путь, не добавлять Kafka/Redis/вторую базу или самостоятельный бизнес-проектор в collector |
| `apps/runtime/src/services/egress/resolver.ts:78` отказывает vendor-wide Fansly; `:100–121` требует page proxy | WSS handshake, reconnect и REST hydration должны использовать тот же маршрут. Работоспособный HTTP dispatcher ещё не доказывает WSS/DNS/proxy поддержку |
| `apps/runtime/src/services/egress/pacer.ts:80–91` задаёт Fansly spacing 0; `sync/rate-limiter.ts:73–85` отдельно реализует per-egress scopes под `syncSharedRateLimitEnabled` | Слова «используем existing pacer» недостаточны: подключать действующий limiter и общий физический admission для всех новых callers, проверить effective config |
| `sync/fansly-lane.ts:214–241` резервирует физическую попытку в checkpoint до отправки; adapter получает `remainingAttempts` | Базовый механизм уже существует; не заменять его локальным счётчиком collector. Но бюджеты отдельных lanes ещё не являются общим бюджетом page/egress |
| `packages/db/src/schema.ts:348–358`: Fansly credentials имеют encrypted session, key version, updated time, но нет session generation | Долгоживущий collector требует нового поколения сессии/маршрута. Encryption key version не использовать вместо credential generation |
| `page-sync.ts:2870–2919` паркует auth-owned streams; `:2740–2770` снимает auth block по времени; `connections.ts:270–315` проверяет идентичность перед сохранением credentials | Сохранить identity verification и владение паузами; добавить generation fence к auth failure/recovery, WS lease и HTTP admission |
| `domain-events.ts:1–9`: append сериализован по account, ключи cross-producer; projection-only/mixed append имеют отдельные API | `account_seq` — порядок записи Hub, не причинный порядок Fansly. Новые типы должны иметь явную deliverability и корректный projection checkpoint |
| `canonicalize/sync-pull.ts:106,206`: `txn:<id>` и `msg:<direction>:<id>` | Неполный WS event, первым занявший эти ключи, может вытеснить полный REST event. Content-hash применяется не ко всем типам |
| `ingest-observations.ts:20–47,71–79,119–211`: allowlist видов, principal/page scope, special harvest capability; неизвестное — `desktop.unknown:*` | Generic desktop ingest не является готовым Fansly event endpoint. Нельзя получить доверенный producer через `x-client-version` или произвольный pageLabel |
| `fansly-engagement.ts:260–284` уже объединяет dirty по page/plane/subject; `:549–569` очищает dirty при завершении без revision CAS | Повторно использовать таблицу можно после усиления settlement; независимый event producer создаёт новую гонку |
| `sync/planner.ts:48–95,156–169`: существующий planner сохраняет flags, pauses, dependencies и dispatch | Event handler записывает durable intent; dispatcher остаётся один. Нельзя обходить его прямым выполнением всех stream handlers |

Точные исходники находятся в этом checkout; ссылки на строки относятся к указанной ревизии. Исторические Stage specs объясняют замысел, но текущие детали выше проверены по коду.

## Сравнение вариантов

| Вариант | Достоинства | Ограничения | Решение |
|---|---|---|---|
| Расширение/relay из обычного Firefox пользователя | Использует живую авторизованную сессию; удобен для изучения payload и нулевых дополнительных REST capture | Браузер может быть закрыт; табы, profiles и несколько операторов дублируют поток; local spool и pairing требуют защиты; browser-generated фоновые HTTP сохраняются | Хороший исследовательский/переходный источник и дополнительная пассивная копия. Сам по себе не обеспечивает 24/7 freshness |
| Серверный native WSS collector | Малый footprint, независим от рабочего компьютера, нет необходимости держать весь Fansly UI; удобно контролировать connect budget | Пока не доказаны auth handshake, TTL, audience coverage, отсутствие влияния второго socket, прокси и допустимый reconnect | Предпочтительный целевой транспорт после canary gate; не объявлять готовым сейчас |
| Постоянный управляемый браузер | Ближе к официальному runtime, может поддерживать JS-driven session/challenge flow | Сам генерирует polling, consumes resources, требует профилей/обновлений/наблюдения; запуск браузера не гарантирует нужные подписки и полноту | Запасной транспорт только если native WSS gate не проходит и measured total traffic/operability лучше polling. Не строить browser farm заранее |
| Только adaptive polling | Максимально использует существующие lanes, работает без пользовательского браузера; мало новых protocol assumptions | Для малой задержки нужны периодические чтения даже в тишине; недоступные или быстро исчезающие изменения остаются риском | Обязательный degraded mode и самостоятельная экономия для поверхностей без доказанных событий |

Сравнивать варианты нужно по **всем запросам к Fansly**, включая браузерные background calls, bootstrap, WSS handshakes и reconnect, а не только по Hub HTTP counter. Перенос polling в управляемый браузер не считается экономией.

## Минимальная конструкция

### 1. Небольшой collector, принадлежащий существующему worker

Один active connection на `(pageId, credentialGeneration, egressGeneration)`, координация через DB lease с fencing token. Worker restart безопасен; отдельный deployable сервис пока не нужен. Lease heartbeat и provider heartbeat — разные вещи. При потере DB/lease collector прекращает использование credential и закрывает socket; новый worker не наследует молча «здоровое» соединение.

Состояния: `disabled`, `connecting`, `live_unverified`, `live_verified`, `backoff`, `auth_blocked`, `proxy_blocked`. `live_verified` означает проверенные подписки и liveness, **не подтверждённую полноту событий**. Состояние дополнить `connected_at`, `last_frame_at`, `last_heartbeat_at`, `last_useful_signal_at`, `disconnected_at`, `gap_since`, причиной разрыва и generation. Не считать тишину бизнес-событий поломкой; не считать TCP-open доказательством правильной подписки.

### 2. Сначала durable raw, затем сигнал

Каждому принятому business frame присваивать неизменяемую локальную идентичность `(collectorInstance, connectionEpoch, localFrameSeq)`. Она дедуплицирует retry delivery одного захвата; provider event id, если его смысл доказан, сохраняется отдельно. Нельзя глобально дедуплицировать одинаковые bytes: два одинаковых события в разное время могут быть разными фактами.

Записывать original business payload, provider timestamp/ID при наличии, observed/received time, verified account ID, generation, connection epoch и decode/version metadata в existing observations/capture plane. Auth-handshake секреты не смешивать с business capture; heartbeat — ops telemetry. Неизвестный business kind сохраняется как unknown с parse debt. Неудачный decode не становится пустым событием.

Если dirty routing выполняется сразу, raw observation и dirty intent коммитятся одной транзакцией. Если через существующий canonicalization-style sweep, raw commit — единственная точка durable acceptance, а sweep обязан восстановить каждое ещё не маршрутизированное observation после crash. Pg-boss notification — wakeup, не хранилище факта. Браузерный relay удаляет запись из локального spool только после commit ACK от Hub; иначе resend с прежним ID.

### 3. Сигналы объединяются по объекту, не становятся очередью запросов

Ключ dirty row: `(pageId, plane, subjectRef)`; существуют `requestedRevision`, `claimedRevision`, `appliedRevision`, `firstDirtyAt`, `lastDirtyAt`, `nextDueAt`, `notBefore`, `reason`, lease token. Допускается узкое расширение `subject_refresh_state`; его нынешний безусловный dirty-clear использовать нельзя.

Claim фиксирует R = requestedRevision. Запрос, полученный ответ и capture завершаются для R. Settlement продвигает appliedRevision до R под lease/CAS, но не очищает новую R+1. Если во время чтения пришли ещё 100 сообщений той же беседы, после commit остаётся максимум ещё один актуальный проход, а не 100 задач.

Debounce имеет нижнюю задержку объединения и максимальный срок ожидания от **firstDirtyAt**; постоянный поток не должен бесконечно отодвигать deadline. Повторный hint может сделать объект due раньше, но не отменить retry cooldown. Бюджет исчерпан — durable deferral, не drop и не новое поколение полного backfill.

Маршрутизация закрытая и версионируемая: DM signal → конкретная беседа; notification ID → notification capture/associated subject only; unknown scope → один page-level reconciliation hint под cap. Неизвестный kind не запускает все 17 потоков. Связанные счётчики и fan enrichment объединяются отдельно; по умолчанию не выполнять profile + earnings + purchase history на каждый DM.

### 4. Два независимых вида времени

Доказанный provider revision/time определяет порядок изменения mutable entity. `received_at` — время доставки/захвата; `account_seq` — местный append order. Старый REST snapshot, завершившийся позже нового WS кадра, не должен регрессировать head. Если provider revision отсутствует, сохранять оба evidence и revalidate bounded current snapshot; не выдумывать уверенный Last-Write-Wins по времени прихода.

У full DM/transaction canonical events и material/enrichment events должны быть разные обязанности. Sparse WS не может занимать «полный» canonical key. Unfollow/delete/expiry не выводятся из пропущенного события; destructive visibility reconciliation сохраняет существующие full-sweep laws и generation witnesses.

### 5. Сверка и история работают независимо от сигнала

Сохранить существующие history cursors, capture coverage и backfill lanes. Event hint обновляет live/head работу, не перезаписывает `before`/offset checkpoint истории. Лимиты времени и запросов выделяют долю backfill, чтобы chat burst не остановил историю навсегда.

Периодическая reconciliation имеет собственный deadline, который **не сдвигается WS heartbeat или event activity**. Её результат может выявить пропущенный сигнал. Deep backfill никогда не считается завершённым по одному event payload. Mutable offset-list sweeps должны продолжать защищаться от вставок/удалений во время обхода.

При разрыве сохранять interval gap. После reconnect немедленно начинать bounded catch-up от последнего REST checkpoint с overlap, а не только «N минут назад»: простой мог превысить N. Проверять новые/изменившиеся беседы, читать каждую до известной границы, отдельно продолжать обнаружение и менее срочные lanes. Непроходимая дыра остаётся видимой. Реконнект сам по себе её не закрывает.

Без браузера normal mode сохраняется только при доказанном always-on collector. Если collector недоступен при валидной REST session, восстанавливать обычную polling cadence с jitter и теми же бюджетами. Если session/proxy заблокированы, не пробовать компенсировать потерю событий лавиной REST; показывать stale и ждать исправления. Ручные/flag-owned паузы всегда сохраняются.

## Исправления до усиления трафика

1. **Подтверждённая ошибка backoff:** `packages/shared/src/http-client.ts:546–561` ограничивает provider Retry-After верхней границей 60 секунд: значение `600` становится `60000`, хотя сообщает 600 секунд. Исправление должно сохранять абсолютный provider deadline и отдельный capped exponential fallback; длительное ожидание отдавать durable scheduler. Нужен общий `cooldown_until` page/egress, читаемый перед каждой физической попыткой, включая reconnect. Это проверено кодом; факт конкретного production incident здесь не устанавливается.
2. **Недостающий session fence:** добавить generation, capability/verified identity и egress binding. Проверять их перед новым handshake/HTTP admission и при auth-state settlement. Старый захват можно сохранить с историческим attribution, но stale worker не меняет текущую session health и не очищает новый gap.
3. **Новая гонка dirty settlement:** существующий unconditional clear заменяется revision fence до подключения независимого collector. Это логическое воспроизведение interleaving по коду, не утверждение о замеченной потере production данных.
4. **Бюджет целого account/egress:** inventory всех HTTP/WSS callers, единый admission/cooldown и отдельный резерв для live/reconciliation/history. Сохранить действующие lane attempt guards. Браузерные человеческие запросы нельзя объявить governed Hub admission; учитывать их отдельно при оценке суммарного трафика и proxy contention.

## Обязательные adversarial проверки

| Сценарий | Проверяемый результат |
|---|---|
| Один frame доставлен relay дважды, затем тот же факт пришёл REST | Raw retry дедупится по capture ID; канонический факт не дублируется; full material не теряется |
| Два одинаковых payload относятся к разным real events | Global content hash не схлопывает разные факты |
| Sparse WS, затем полный REST с тем же message ID | Полный текст, tips, media и provenance остаются доступны; ранний key не блокирует enrichment |
| Старый REST snapshot пришёл после нового изменения | Head не регрессирует; противоречие сохраняется как evidence |
| Frame R+1 поступил после начала hydration R, до settlement | R+1 остаётся pending; старый lease ничего не очищает |
| Crash после raw commit, до queue send/dirty routing | Sweep восстанавливает intent; business frame не потерян |
| Crash после REST response, до durable capture | Нельзя помечать applied/coverage. Повторный read допустим, но исчезнувший неперсистированный факт честно остаётся риском |
| Crash после capture, до checkpoint | Повторный проход идемпотентен; body сохранён; история не перескакивает через ответ |
| Credential заменён, старый socket вернул auth failure | Новая generation остаётся активной; stale frame исторически атрибутирован, не исполняет новые запросы |
| Actor/account ID не совпадает с page, delegated management scope не включает нужный dataset | Fail closed/quarantine, никакой записи в чужую projection |
| Disconnect 2 минуты / 6 часов / 7 дней | Gap сохранён, catch-up bounded и checkpoint-based; ни fixed lookback blind spot, ни full-history restart |
| Provider heartbeat идёт, бизнес-сигналы искусственно выброшены | Independent reconciliation обнаруживает расхождение; «WS live» не скрывает gap |
| 1000 signals одного объекта и 1000 разных объектов | Coalescing проверен; per-object+page physical budget соблюдён; oldest dirty не голодает |
| 429 + Retry-After:600, два worker, рестарт | Ни HTTP, ни reconnect не раньше deadline; cooldown не отменяется hint/manual wakeup |
| 401 session failure и 403 endpoint permission/WAF ambiguity | Разные состояния diagnosis; не вращать credential автоматически и не ретраить бесконечно |
| Одновременно inventory sweep, event upsert и page/fan erasure | Существующие erasure fences, tombstones и deletion laws не обходятся |
| Rollback при pending hints/inflight requests/history chunk | Приём/dispatch выключаются отдельно, raw остаётся, ordinary scheduler подбирает due work, checkpoint и owner pause сохраняются |

## Conditional readiness gate

Сокращать cadence конкретного dataset можно только после: (1) записанного frame/REST correspondence для требуемых create/update/delete событий; (2) проверки WSS auth/route/identity/liveness и нескольких restart/TTL/revoke циклов; (3) shadow comparison при неизменном polling, включая ночное отсутствие browser и искусственную потерю signals; (4) успешных concurrency/crash/dedup тестов выше; (5) измеренного общего request reduction при неизменной согласованной freshness и доступной истории.

Canary должен включать и активные, и тихие часы, полный reconciliation cycle и хотя бы один принудительный outage. Просто «72 часа без ошибок» недостаточно: никто мог не создавать редкие события. Метрики: request attempts по источнику/endpoint/reason, handshake/reconnect, useful hints, hints→unique fetch, hydration lag, oldest dirty, oldest gap, reconciliation discoveries with no prior signal, field-level disagreements, archive coverage/projection lag, auth/proxy incidents. Удобный процент экономии без полноты полей и gap census не является acceptance.

Rollback: выключить event-triggered dispatch одной page, вернуть сохранённую ordinary cadence, дождаться bounded catch-up, затем отдельно выключить collector при необходимости. Не очищать raw/dirty/history state, не снимать владельческие паузы и не запускать все due задачи одномоментно. Переход между browser relay и native collector не должен требовать изменения canonical/projection model.

## Неизвестное, которое нельзя скрыть архитектурой

- Какие именно Fansly события существуют, что означают их IDs, timestamps, ordering и heartbeat; есть ли subscription scopes/replay/ack.
- Работает ли native WSS через текущий proxy с текущей/delegated session, как долго, что делает дополнительное соединение.
- Какие mutations вообще не создают событий и какие события приходят только в открытой странице/беседе.
- Как быстро исчезают provider facts до REST capture и можно ли их восстановить из альтернативной поверхности.
- Текущие production cadence, physical traffic и per-dataset freshness baseline: этот независимый review production не читал.
- Какие полные WS payload разрешают безопасную прямую canonicalization. До доказательства они остаются raw evidence/hints.

Память использовалась только для навигации: `MEMORY.md:166–203` указала предыдущий self-hosted Fansly research и backoff/session вопросы. Все текущие утверждения о Hub выше перепроверены по указанному checkout; старый research не использован как доказательство Fansly WSS semantics.

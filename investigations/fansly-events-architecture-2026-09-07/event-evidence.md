# Fansly events: независимое исследование доказательств

Дата проверки: **2026-09-07**. Область: локальный код Hub и Fansly extension, шесть прежних HAR, сохранённый официальный браузерный bundle Fansly, публичные первоисточники. Production, браузер, чужие сессии и исходный код приложений не изменялись. Новых запросов к закрытому Fansly API не выполнялось. Этот документ — исследовательское приложение, не нормативная замена действующих решений.

**Вывод:** у Fansly обнаружен собственный account WebSocket `wss://wsv3.fansly.com?v=3`. Это поток интерфейса Fansly; подтверждённого прямого webhook-контракта от Fansly для Hub не найдено. Поток способен передавать предметные данные, а не только уведомления «что-то изменилось». Однако имеющиеся HAR сохранили только рукопожатия, поэтому наличие нужного типа в коде ещё не доказывает его доставку для конкретной сессии Lora. История, replay после обрыва, гарантии доставки и полнота охвата неизвестны. Эти ограничения исключают безопасное полное отключение REST.

## 1. Что именно проверено

Метки доказательств:

- **CODE** — код текущего локального checkout, не утверждение о production.
- **BUNDLE** — код официального веб-клиента, сохранённый 20 августа 2026 года; может отличаться от сегодняшней версии.
- **HAR** — реально записанный HTTP-трафик с датами внутри экспортов.
- **PUBLIC** — опубликованная документация указанного владельца, проверена 7 сентября; заявления посредника не становятся гарантией Fansly.
- **INFERENCE / UNKNOWN** — вывод из перечисленного либо непроверенный вопрос.

Hub HEAD при проверке: `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`. Extension HEAD: `1a74b8114235f95818425f49699178e5f451e29e`; checkout содержит ранее существовавшие незакоммиченные изменения. Исследованные capture/spool модули не изменялись этой работой. Прочитаны Hub `CLAUDE.md`, quick reference `docs/decisions.md`, Stage 11/17/32, extension `CLAUDE.md` и relevant decisions.

Повторяемый безопасный агрегат — [har-evidence-summary.json](/Users/dmitriy/code/goose/hub/investigations/fansly-events-architecture-2026-09-07/har-evidence-summary.json): пути, SHA-256, даты, коды HTTP, имена полей/заголовков, счётчики. В нём нет значений auth headers, cookies, query values, содержимого сообщений, fan IDs или media URLs. Сырые HAR не следует публиковать или прикладывать к PR.

| Локальный HAR | Entries | Fansly WS 101 | Сохранённые WS frames | Даты запросов внутри файла |
|---|---:|---:|---:|---|
| `fansly-network-capture-2026-08-19/fansly-session-2026-08-19.har` | 845 | 0 | 0 | 2026-08-19 |
| `fansly-app-bundle-2026-08-20/fansly-app-bundle-2026-08-20.har` | 132 | 1 | 0 | 2026-08-20 |
| `fansly-payouts-capture-2026-08-20/fansly-payouts-2026-08-20.har` | 480 | 0 | 0 | 2026-08-20 |
| `fansly-ui-walk-2026-08-21/fansly-ui-walk-2026-08-21-control.har` | 2 | 0 | 0 | 2026-08-20 |
| `fansly-ui-walk-2026-08-21/fansly-ui-walk-2026-08-21-pre-rewalk.har` | 484 | 17 | 0 | 2026-08-20 |
| `fansly-ui-walk-2026-08-21/fansly-ui-walk-2026-08-21.har` | 861 | 17 | 0 | 2026-08-20 |

Пути в таблице относительны к `/Users/dmitriy/code/goose/hub/artifacts/`. Последние два экспорта перекрываются: всего **18 уникальных Fansly handshakes по timestamp/status**, а не 35 независимых сессий. Причины повторных подключений неизвестны; навигация и повторная загрузка также возможны. Название каталога `2026-08-21` не подменяет фактические даты HAR.

## 2. Native WebSocket: транспорт и сессия

**BUNDLE.** Сохранённый [main.pretty.js](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20022) создаёт обычный `WebSocket` на `wss://wsv3.fansly.com?v=3`. Локальный HAR подтверждает ответ `101 Switching Protocols`. Это account service connection, не Intercom и не отдельный live-stream chatroom socket.

После открытия используется авторизация первым текстовым сообщением:

```text
JSON({ t: 1, d: JSON({ token: activeSession.token, v: 3 }) })
```

Здесь показана схема, не действующий token. Поля указаны в [onConnect / sendSessionVerifyRequest](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20762). Код не отправляет при этом `fansly-client-check`. Из этого **не следует**, что самостоятельный server connection пройдёт edge/WAF, proxy binding или все permission gates.

Внешний envelope разбирается по `t`; `d` часто содержит строку JSON. Для service event после decode получаем `serviceId` и `event`, причём `event` снова JSON string. [Wrapper dispatch](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20811):

| `t` | Обработка веб-клиентом |
|---:|---|
| 0 | ErrorEvent |
| 1 | SessionVerifiedEvent |
| 2 | PingResponseEvent |
| 10000 | ServiceEvent |
| 10001 | Массив вложенных wrapped events; каждый проходит тот же разбор |

**BUNDLE.** Application heartbeat — текст `p`, интервал случайно выбран между 20 и 25 секундами. Pong обновляет `lastPingResponse`; timeout равен `1.2 × pingInterval`. Проверка таймером может перезапустить соединение; reset ограничен отдельным 15-секундным интервалом. Нижний reconnect timer начинается с 1500 ms, удваивается с пределом 15 s; это поведение браузерного клиента, **не рекомендуемый retry budget для server fleet**. См. [ping state](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20686) и [reconnect](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:19936).

**UNKNOWN.** В проверенном account-WS транспортном коде нет запроса `resume`, сохранённого cursor, event-level ACK или контроля gapless upstream sequence. Отсутствие в одном клиенте не доказывает отсутствие серверной возможности. Hub `domain_events.seq` — собственный порядок уже принятых фактов, он не обнаруживает события, которые Fansly не доставил.

Сам Fansly после `SessionVerified` обнуляет freshness cached messages и перечитывает активный диалог. После возвращения видимости вкладки спустя >30 s также перечитывает unread и active group. Это [положительное свидетельство REST reconciliation в native клиенте](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:34883), но не универсальный алгоритм восстановления всех диалогов.

**Скрытый эффект сессии:** при WS ErrorEvent `code=401` native клиент вызывает `sessionService.logout()`; тот выполняет `POST /logout`. Собственный receiver должен остановить использование проблемной session generation и сообщить причину, не копировать logout/revoke. Для общего с chatter браузерного профиля это особенно важно. [WS 401](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:20778), [logout implementation](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:13566).

## 3. Кандидаты предметных событий

Все строки ниже — **BUNDLE**, то есть обработчики и используемые ими поля. Они не доказывают, что каждое событие приходит на creator account, в Management Session, при каждом изменении и на всех активных соединениях. Полнота payload должна быть подтверждена wire capture перед canonicalization.

| `serviceId` / внутренний `event.type` | Что читает native клиент | Архитектурное применение |
|---|---|---|
| Message 5 / 1 | `message`, затем `onMessagesEvent` | Кандидат прямого raw→message события; не делать lookup каждого полного сообщения |
| Message 5 / 10 | `message.id`, `message.type`; удаление обычного и связанных сообщений | Сохранять tombstone и исходный payload; нельзя восстанавливать существование из старого REST snapshot |
| Message 5 / 2,3,4 | `messageAckEvent`, `like.messageId`, `like` | Отдельные receipts/reactions; они не основание перечитывать весь inbox |
| Group 4 / 6,7,8,9,4,2 | `groupUser`, group `id`, settings, ack command | Частичная идентичность/состояние; missing group можно обогатить одним scoped lookup |
| Wallet 6 / 1,3 | `transaction` | Потенциально богатый финансовый факт; canonical ledger только после проверки статусов/units/идентичности с REST |
| Wallet 6 / 2 | `wallet`, `walletVersion`, `balance`, `accountId`, `type` | Native клиент сравнивает `walletVersion`; баланс не заменяет transaction history |
| Tipping 7 / 1 | `tip`, sender/receiver, amount | Не прибавлять повторно к revenue, если та же покупка уже пришла через wallet/notification |
| Follower 3 / 2,3 | `follow.accountId`, `follow.followerId` | Follow/unfollow state candidate; список подписок/аудитория сохраняет reconciliation |
| Subscription 15 / 5 | `subscription`, `version`, status/prices/tier/timestamps | Native cache сравнивает `version`; не выводить refund/окончательное revenue из одной подписки |
| Notification 9 / 1,2,3 | `notification`; ack data; removal | Sparse repair index и отдельная история уведомлений, не вся предметная история |
| Media 2 / 5,7,8 | `media`; `order` для single/bundle purchase | Можно избежать per-event order lookup, когда payload достаточен; право на media ≠ vault completeness |
| Post 1 / 1,5,8 | `post`; create/delete/update | Native клиент сам делает `getPosts([id])` на create/update; необходимо проверить фактическую полноту payload |
| Post 1 / 2,3,4 | `like`; `updates` со счётчиками | Coalesced update только затронутых posts; не полный posts/statistics sweep |
| Post 1 / 9,10 | `wallPost` с wall/post refs | Один post может дать несколько wall events; не удалять post целиком по одному удалению из wall |
| Account 12 / 2 | `account` с displayName/flags | Partial update не должен обнулять отсутствующие profile fields |
| OnlineStatus 8 / 1 | `status` с accountId/statusId | Код знает тип, но наличие полноценного fan-presence feed не подтверждено |

Основные проверяемые участки: [messages/groups](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:34974), [wallet](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:36929), [subscriptions](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:30043), [follow/tip/media](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:43229), [notification](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:36154), [posts](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:33188), [account/status](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:24667).

Перечисленные в enum `EarningsStatsService`, `VaultService`, `ManagementService`, `NotesService` **сами по себе не подтверждают event coverage** этих planes. Наличие названия сервиса — слабее наличия handler, наличие handler — слабее реального frame, реальный frame одного типа — слабее доказательства покрытия изменений.

**Не смешивать namespaces:** `serviceId=3,event.type=3` и `notification.type=3003` — разные уровни протокола. Notification renderer для 3002/3003 выбирает корреляционное поле follower; нельзя механически преобразовать `3003` в «unfollow». Сверка [notification code table](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/CODE-TABLES.md:317).

## 4. Что можно восстановить через notifications

**HAR.** 19 августа реально получены четыре GET страницы `/api/v1/notifications`, по 50 записей. Поля: `id`, `idString`, `accountId`, `type`, `correlationId`, `correlationGroupId`, `metadata`, `createdAt`, `acknowledgedAt`. Наблюдались типы 15016, 2007, 3003, 7001, 15007, 2008. Это хорошая отправная точка для selective recovery: известен тип и ref затронутого объекта.

**BUNDLE.** Метод принимает `before`, `after`, `type`; endpoint не требует перебирать всю историю ради новых записей, если семантика cursor подтвердится. [getNotifications](/Users/dmitriy/code/goose/hub/artifacts/fansly-app-bundle-2026-08-20/analysis/main.pretty.js:29228).

**UNKNOWN.** Не подтверждены retention, exhaustion, максимальный lookback, complete type coverage, порядок относительно предметных изменений, права Management Session, удаления и доставка запоздавших записей. Notifications не заменяет transaction ledger и не обеспечивает историю каждого edit/delete. На старом обследовании эксперимент message edit/delete был пропущен из-за отсутствия проверенного test conversation: [исходные notes](/Users/dmitriy/code/goose/hub/artifacts/fansly-network-capture-2026-08-19/notes.md:25).

## 5. Extension сейчас не является готовым event collector

**CODE.** [session-capture.ts](/Users/dmitriy/code/goose/fansly-ext/src/background/session-capture.ts:90) читает `onBeforeSendHeaders` только `https://apiv3.fansly.com/*`, только tab requests. Требует четыре HTTP headers, сохраняет latest/route client-check и уведомляет о material session change. Это capture session material, не capture platform payloads. Поиск `WebSocket`, `filterResponseData` и wire-capture consumers в `src/` не выявил такого пути.

[manifest.json](/Users/dmitriy/code/goose/fansly-ext/manifest.json:6) имеет `webRequest`, `storage`, `unlimitedStorage`, `tabs`; content script запускается в `document_idle`. В нём нет готового раннего WS interception. Для HTTP body filtering в Firefox MV3 документация требует отдельные permissions, включая `webRequestFilterResponse`; текущий manifest их не объявляет. [Mozilla filterResponseData](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/filterResponseData). Стандартный `webRequest` описывает HTTP request lifecycle, включая WS opening request; это не подтверждение готового frame-capture API. [Mozilla webRequest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest).

**INFERENCE.** Если используется passive browser path, capture нужно устанавливать до создания socket и ловить входящие wire frames с минимальным parsing. Нельзя перехватывать только Angular `onServiceEvent`: тот же bus содержит **синтетические события после REST**, cache updates и local UI actions. Например, `loadWallets()` эмитит тип 101, notification handling порождает другой service event, subscription handling эмитит тип 102. Неверный слой capture создаст ложную wire provenance и feedback loops. Не вызывать существующие handlers ради захвата: некоторые выполняют side effects.

**CODE.** [SessionStore](/Users/dmitriy/code/goose/fansly-ext/src/background/session-store.ts:15) хранит credential templates и tab→account mapping в memory. После restart worker табы неизвестны до нового захвата; durable presence — только последнее наблюдение. При закрытии последней вкладки account session удаляется из map. Это не 24/7 server session custody и не гарантия capture continuity.

**CODE.** Existing [acceptance-reporter.ts](/Users/dmitriy/code/goose/fansly-ext/src/background/acceptance-reporter.ts:1) — telemetry-grade spool: cap 300, batch 100, drop oldest при overflow, drop batch на 400, drop после 5 ошибок, debounce 1 s. Он подходит текущим AI acceptance signals по старому решению, но **не подходит custody бизнес-фактов**. Новый uploader обязан сохранять неподтверждённые bytes, quarantine schema-invalid payloads, retry с точным `Retry-After`, наблюдаемым backlog и durable ACK. Временное прекращение capture при полном диске должно создавать explicit gap, а не молча терять данные.

**CODE.** Hub [ingest-observations.ts](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ingest-observations.ts:30) сейчас allowlist-ит telemetry kinds и специальный machine-authorized harvest. Произвольный `fansly.ws` попадёт в `desktop.unknown:*`, а [client canonicalizer](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/canonicalize/client-capture.ts:30) не создаст Fansly domain events. Existing bearer/page ACL и atomic journaling полезны, но для native facts нужны новый доверенный producer capability, account/session-generation binding, kind contract и canonicalizer. Нельзя просто объявить любой chatter payload platform truth.

**Историческая граница:** Stage 11/32 явно исключают Fansly response mirroring. Текущий запрос пользователя разрешает проектирование нового подхода; будущая реализация должна записать решение, которое точечно supersedes этот scope, и обновить cross-repo ссылки. [Stage 11](/Users/dmitriy/code/goose/hub/docs/migration-history/stages/stage-11-client-capture-lane.md:6), [Stage 32](/Users/dmitriy/code/goose/hub/docs/migration-history/stages/stage-32-extension-cutover.md:32).

## 6. Внешние первоисточники и предел их доказательности

**PUBLIC, Fansly.** Management Sessions дают контролируемый доступ с выбранными permissions; link одноразовый; logout/expiry требуют нового link; creator может изменить права или отозвать доступ. Это пригодный механизм делегированной сессии. Документ не обещает API/WS portability, event completeness, refresh token или SLA. [Fansly Help Center, Management Sessions, 2025-12-01](https://help.fansly.com/en/articles/12328641-management-sessions).

**PUBLIC, OnlyFansAPI — о собственном продукте посредника.** Provider прямо описывает relay Fansly WebSocket, а не polling. Его webhook payload может включать дополнительное обогащение: sender identity и комментарий получают отдельными lookup; post events dedup-ятся между walls. Следовательно, показанный provider payload нельзя принимать за native frame. Это подтверждает практичность relay pattern и одновременно показывает скрытую стоимость enrich-on-event. [OnlyFansAPI, Fansly events](https://docs.onlyfansapi.com/webhooks/fansly-events).

Поиск документации на Fansly domains не обнаружил native webhook registration API. Найденные webhook setup guides относятся к внешним providers; это ограниченный результат поиска, а не доказательство абсолютного отсутствия закрытого партнёрского API.

## 7. Архитектурные последствия и обязательные проверки

1. **Нужны два источника:** event channel для свежести, REST snapshots/history/reconciliation для архивной полноты. Входящий полный payload можно сразу journal/canonicalize; sparse/unknown payload остаётся сохранённым и лишь помечает конкретный объект/plane dirty. Один event не должен запускать полный stream.
2. **Chatter browser не может быть единственным receiver**, если нужна свежесть при его отключении. Разумный кандидат — один собственный receiver на page через тот же fail-closed proxy/session generation. Работоспособность standalone WS требуется доказать canary; при её отсутствии потребуется отдельный управляемый браузер, стоимость/availability которого надо оценивать явно.
3. **Receiver transport и enrichment должны быть раздельны:** reconnect/auth не запускает параллельный fan-out. Dirty refs coalesce по `(page, entity, id)`; lookups batch-ятся; неизвестные types journal-ятся без автоматического all-stream resync. Retry и reconnect тоже входят в единый budget/cooldown; наличие WS не делает неограниченными REST calls.
4. **Session verification ≠ continuity verification:** новая connection epoch открывает recovery interval от последнего durable capture с overlap. `connected`/pong не означает, что все предметные события поступают. Auth error паркует generation; чужая сессия не разлогинивается. Молчание socket с живым ping не доказывает отсутствие изменений.
5. **Состояние и история различаются:** при create→delete/expire во время полного offline REST может уже не вернуть ни тело, ни сам transient факт. Без upstream replay нельзя обещать восстановление всей истории изменений. Допустимая гарантия — долговечность после capture, восстановление REST-discoverable state и явные неизвестные интервалы. Высокая availability уменьшает этот риск, но не превращает его в математический ноль.
6. **Для cutover нужны реальные wire fixtures:** одно подключение Lora с passive typed capture; типы/fields/counts и receive times; по controlled test account — incoming/outgoing DM, delete/edit, типы purchases/subscriptions/follow; отключение и reconnect; две одновременные connection; смена/отзыв session generation; idle/background browser; недоступный Hub и spool drain. Нельзя создавать реальные платные действия или отправлять сообщения без отдельного разрешения.
7. **Проверить до отключения polling:** что message/purchase/follow IDs совпадают между wire и REST; какие payload являются partial snapshots; time units и version semantics; соответствует ли wallet transaction окончательному ledger; recovery discoverability скрытых/старых conversations; notification retention; create/delete during outage; server WAF/proxy compatibility; права и срок Management Session. Провал каждого теста оставляет соответствующий REST stream включённым.

Этот отчёт позволяет выбрать и подготовить transport architecture. Он не даёт доказательств, достаточных для изменения production cadence сегодня.

## 8. Доппроверка: дешёвая сверка головы диалогов

По запросу архитектурного review отдельно разобраны **только поля** прежних GET `/api/v1/messaging/groups`. После исключения дубликатов overlapping exports — 9 ответов, 83 наблюдения строк (это не 83 уникальных диалога). [Агрегат](messaging-group-marker-evidence.json) сохраняет source HAR и времена запросов без IDs, text и query values.

**HAR.** Response имеет `{data, aggregationData}`. Каждая из 83 `data` строк содержит `groupId`, `lastMessageId`, `lastUnreadMessageId`, `unreadCount`, partner refs, flags, tier ref. `lastMessageId` non-null у 83/83; `lastUnreadMessageId` non-null у 19/83. В `aggregationData.groups` найдено 83 соответствующих group objects с `users`, permissions и **embedded `lastMessage`**. Его поля: `id`, `type`, `dataVersion`, `content`, `groupId`, `senderId`, `correlationId`, reply refs, `createdAt`, `attachments`, `embeds`, `interactions`, `likes`. `updatedAt` на уровне list row/group не обнаружен.

**Значимое расхождение:** только **82/83** `data.lastMessageId` совпали с `aggregationData.groups[].lastMessage.id`. В HAR 19 августа, запрос `2026-08-19T19:12:05.297+03:00`, у одной строки оба IDs непустые, но embedded lastMessage ID численно новее list marker. Причина неизвестна: нельзя объявить list/aggregation единым атомарным snapshot либо выбрать один marker без проверки. В отчёт не копируются значения этих IDs.

**CODE.** [getMessagingGroupsPage](/Users/dmitriy/code/goose/hub/packages/fansly/src/adapter.ts:1129) уже отдаёт `.items`, `.groups`, `.accounts` и raw. [Types](/Users/dmitriy/code/goose/hub/packages/fansly/src/types.ts:261) считают `lastMessageId` optional. Следовательно, новая дешёвая сверка может использовать существующий endpoint, а не обязательно выполнять `/group/:id` для каждого известного диалога.

**INFERENCE, пригодно как дизайн-кандидат:** оставить независимый list/head discovery с deadline не хуже принятого текущего SLA, например ≤30 min как proposed gate. Сравнивать оба head markers; mismatch, missing group/marker и changed IDs дают scoped refresh. Rich aggregate сохранять raw-first и применять через проверенный общий путь. Дорогой detail/full inventory можно урежать отдельно после canary. Это может дать экономию без шестичасового окна молчаливо пропущенного нового сообщения.

**UNKNOWN / gate:** в HAR нет controlled доказательства покрытия hidden/archived dialogs, всех фильтров, monotonic updated ordering и поведения markers при edit/delete старого сообщения. Нет доказательства, что новое сообщение всегда поднимает старый hidden thread в просмотренную голову. Один неизменившийся page и `lastMessageId` не дают права завершить full discovery или поставить historical coverage complete. Пока cheap discovery contract не подтверждён, сохранять прежний необходимый scan; нельзя назначить 6 h единственной страховке от selective signal loss. Даже подтверждённый lastMessage marker не обнаруживает произвольные изменения более ранних сообщений, для них остаётся independent reconciliation.

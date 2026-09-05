# Итоговый план обновления OFAPI в Hub

Дата: 05.09.2026. Исходный Hub: `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`.
Статус: **план реализации после проверки обоих аудитов и Fable plan, дополнен второй сверкой 2026-09-05 (раздел «Amendments»); production-переход на новую команду OFAPI выполнен 2026-09-05, код не менялся**. Fansly исключён.

Этот файл — единый рабочий план. [Исходный аудит](../../investigations/ofapi-support-refresh-2026-09-05/PLAN.md), [матрица 294 операций](../../investigations/ofapi-support-refresh-2026-09-05/endpoint-coverage.csv), [изменения схемы](../../investigations/ofapi-support-refresh-2026-09-05/SCHEMA-CHANGES.md) и [проверка Fable plan](../../investigations/ofapi-support-refresh-2026-09-05/FABLE-REVIEW.md) — доказательные приложения. Они не создают параллельную очередь реализации.

Владелец объяснил остановку production сменой аккаунта и ключа OFAPI и передал актуальный ключ. Переход выполнен 2026-09-05 13:43–14:10 UTC вручную по owner-gated шагам (см. Amendments, п. 1): ключ заменён в `.env.production` с пересозданием api/worker/scheduler, обе страницы перепривязаны на новые `acct_`, `external_webhook_id` обнулён и вебхук зарегистрирован в новой команде, блоки `ofapi_http_404` сняты SQL-ом. Прежние 404 были `code: account_not_found` (аккаунты отключены от старой команды), вебхуки молчали с 2026-09-03 20:22 UTC. Значение ключа не сохраняется в документах.

Результат первого пакета: правильные подключения и lifecycle, работающие существующие чтения, восстановление доставок, точные расходы/права, расширенная отправка и несколько полезных desktop-команд. Второй пакет: загрузка и каталог медиа, visitors/exports, трафик, Pixels/Postbacks. Третий: выбранные CRM/read-аналитика/история контента. Полный publishing/editor и автоматические кампании — отдельное возможное продолжение.

Архитектура: существующие capture → canonical events → projections, command outbox, управляемые задания, централизованные egress/ACL/credits и генерируемый SDK. Для хранения новых фактов добавляем минимальные структуры к этой инфраструктуре. Длительность в S/M/L или число новых endpoints не считаются доказанной оценкой срока.

## 0. Amendments (вторая сверка, 2026-09-05)

Семь правок по итогам перекрёстной проверки обоих планов и живого переезда на команду goslya. Они имеют приоритет над текстом этапов ниже там, где расходятся.

**1. S0 переписан под факт.** Переход сделан вручную: правка `OFAPI_API_KEY` в `/opt/agency-hub/.env.production` и `docker compose ... up -d --force-recreate --no-build api worker scheduler`; `update pages set ofapi_account_id=…` для страниц 8 и 9; `update ofapi_webhook_config set external_webhook_id=null where id=1`, затем `POST /api/v1/admin/ofapi/webhook`; отмена двух posts-jobs по #246 и триггер `posts`; `update page_sync_states … where blocker_code='ofapi_http_404'` → `pending`. В S0 остаётся код, который сделал бы это одной кнопкой:
- `code: account_not_found` как отдельный blocker `provider_binding` со своим инцидентом (не `auth` модели, как требует #245): пауза стримов страницы, отказ gateway/команд по этому `acct_`.
- Таблица истории binding `page_ofapi_accounts(page_id, ofapi_account_id, onlyfans_id, valid_from, valid_to)`; `findPageByOfapiAccountId` и канонизатор/replay смотрят историю. События до 2026-09-03 хранят `acct_9070e38a…` и `acct_b47a5635…`, которых в `pages` больше нет; они вносятся первой строкой истории.
- Регистрация вебхука проверяет `GET /webhooks/{id}` под текущим ключом и при 404 идёт в `create` вместо `noop` (`prepareOfapiWebhookRegistration`, ветка `stable`).
- Ремаппинг страниц при регистрации по `onlyfans_id`, а не только для страниц без `ofapi_account_id`.
- Снятие `provider_bad_data`-блока при восстановлении binding без ручного SQL (`requestPageSync` оставляет `blocked`, планировщик берёт только `blocker_kind is null`).
- Alarm тишины вебхуков: не 12 ч, а 30–60 мин в дневные часы для страницы с историей трафика.

**2. Idempotency-Key в два шага (уточняет S6).** Шаг 1, в S6: ключ `cmd:<commandId>` на каждый send и тот же ключ на всю retry-lineage команды. Ручной ретрай индетерминированной команды уже разрешён аутбоксом и сегодня может дать дубль; с общим ключом он безопасен во всех случаях, кроме «5xx после фактической публикации». Одна физическая попытка на команду сохраняется. Шаг 2, отдельное решение владельца: автоповтор `indeterminate` только после окна ожидания `messages.sent` без совпадения по чату, времени и тексту. `Idempotent-Replayed` не заменяет проверку статуса и message id.

**3. Тестовая среда.** Ключи «Onboarding» и «hub» принадлежат одной команде goslya, отдельной тестовой команды нет. Живые тесты записи (send, upload, pixel test-event) возможны только с отдельным тестовым OF-аккаунтом в этой команде (решение владельца) или на фикстурах из OpenAPI плюс один контролируемый canary с владельцем.

**4. Кредиты.** Владелец пополняет баланс до ~100k. Это снимает бюджет как ограничение плана, но не отменяет дневные бюджеты лейнов. Бесплатный баланс (S4: `_credits.balance` из `GET /api/webhooks` или `GET /api/usage/credits`, оба `used: 0` подтверждены живыми вызовами) выносится в первый релиз вместо платного ping через `/chats`. До пополнения при балансе <1000 придёт low-credit алерт, <500 паркуются пуллы.

**5. Хвосты переезда, отдельные тикеты.** Удалить вебхук на наш endpoint в старой команде OFAPI. Проверить десктоп одного чаттера после смены `acct_` (`/accounts` отдаёт новые id). Posts capture: `transport, post_dispatch` indeterminate воспроизводится на новом аккаунте при прямом ответе `/posts?limit=100` за 6.7 с и deadline 65 с; разбирать по `ofapi_request_attempts` (роль read_only её не видит), не внутри S0.

**6. Объём статистики (S8/S12).** Потребитель есть: Agent Read датасеты и скилл `hub`, где OF-страницы отвечают `not_captured`. В P2 оставляем минимальный набор с этим потребителем: `statistics/overview`, `subscribers/statistics`, visitors, `payouts/balances`, `payouts/payout-requests`. Остальные статистические семейства не берём без нового потребителя.

**7. Первый релиз** = S0 (кодовые остатки из п. 1) + S1 (совместимость gateway, spenders parser, курсоры по `_pagination.next_page`, ложный `succeeded_at` у noop-стримов, пиновый снимок спеки) + бесплатный баланс из S4. Дальше порядок S2 → S3 → S6/S6b → S1b → S7 → S8 → S9 → S10 → S11.

Что из первой версии Fable plan отклонено после проверки и НЕ переносится: «любая ошибка = 1 кредит кроме 402/429» (резолвер уже читает `_meta._credits.used` при любом статусе; OFAPI-side 404 без вызова OnlyFans бесплатен), `offset += limit` как доказательство полноты, дедуп доставок по `delivery_uuid`, `async` как query-параметр, зависимость vault-upload от send v2, вывод «presence никогда не работал».

## 1. Очерёдность реализации

| Этап | Приоритет | Результат | Зависимости |
|---|---|---|---|
| S0 | P0 | Завершённый переход на новый аккаунт/ключ OFAPI, baseline и fixtures | Первым для live canary; разработка S1 и следующих блоков может идти параллельно |
| S1 | P0 | Исправленные существующие read-контракты и маршрутизация | S0 для live-проверки |
| S1b | P1 | Новые read-пути для desktop | S1 resolver/capture; выпуск по готовому потребителю |
| S2 | P0 | Ephemeral, expiry, disconnected и история account bindings | S0; собственные schema/replay тесты |
| S3 | P1 | Delivery history, видимость потерь и redelivery | S2 identity/order; read-часть можно готовить раньше |
| S4 | P1 | Бесплатный баланс и сверка vendor credits | Независимо от S1–S3 |
| S5 | P1 | Ограничения API keys и понятные отказы по правам | Используется всеми последующими этапами |
| S6 | P1 | Send v2, Idempotency-Key, Banned Words, дробный PPV | Существующий outbox + S5 |
| S6b | P1 | Custom name, like/pin/unread и затем mute/hide | Существующий outbox + S5; не требует всего S6/S10 |
| S7 | P1 | Upload lifecycle и полноценный OF vault catalog | Upload-handlers S2, credit metadata/admission S4, S5; vault→send v1 возможен до S6 |
| S8 | P1 | Profile Visitors и расширение экспортов | Существующий export pipeline + S2/S4/S5 |
| S9 | P1/P2 | Tracking/Smart Links analytics, Pixels и Postbacks | S4/S5; S8 добавляет visits в отчёт |
| S10 | P2 | CRM-аудитория, subscription history, списки и engagement | S1/S2/S5 |
| S11 | P2 | История posts/stories/кампаний и измерение результата | Read-часть отдельно; публикации — необязательное продолжение |
| S12 | P3 | Выбранные account/analytics функции по подтверждённой потребности | После основных рабочих сценариев |

S0–S6 — первый обязательный пакет обновления. S7–S9 — второй пакет, закрывающий все названные в запросе новые продуктовые возможности. S10–S11 — расширение старых непокрытых областей, полезное для агентства. Это порядок зависимостей, не требование выпускать один огромный PR.

Небольшой desktop-срез S6b можно выпустить рядом с S6: редактирование custom name, затем like/unlike, pin/unpin и mark-unread. Для него не нужны весь CRM-сегментатор или Smart Links. OF-native notes остаются отдельным opt-in: исторический PRD явно исключал их из v1, а текущий код не подтверждает пересмотр этого решения.

### S0. Завершить переход на новый аккаунт/ключ и закрепить контракт

> **2026-09-05:** ручная часть перехода выполнена (Amendments, п. 1). В S0 остаётся только код, который делает такой переход штатным и делает отключение аккаунта видимым сразу, а не через двое суток.

Подключения проверяем через существующий `/api/v1/admin/ofapi/webhook`; новые operator routes добавляем в этот namespace через contracts. До замены `acct_` сохраняем old binding → Hub page → проверенный stable creator и обеспечиваем runtime lookup старых связей для поздних deliveries/replay. Минимальная история bindings из S2 входит в prerequisite remap: один локальный snapshot не заменяет работающий lookup.

`account_not_found` сохраняем как отдельную machine-причину недоступного provider binding. Останавливаем новые обращения/commands к нему и открываем один incident существующим механизмом. Не объявляем любой 404 disconnected и не предлагаем модельный re-login при ошибке ключа/команды. DB-only чтение и вычисления продолжаются; их freshness показывается отдельно.

**Что делаем.** Используем последний предоставленный владельцем ключ. Проверяем upstream whoami, доступные accounts и их стабильные OnlyFans IDs; составляем явное соответствие новых подключений страницам Hub. Для перехода обновляем серверный credential и подтверждённые bindings, сохраняя прежнюю историю; если меняется provider team, обновляем ожидаемую team identity как часть этой явной миграции. Проверяем наличие и настройки webhook в новом аккаунте, затем его доставку и доступность нужных чтений. Production-изменения выполняются отдельным шагом реализации; предоставление нового ключа в рамках планирования не означает, что они уже сделаны.

После успешной проверки подключения возобновляем допустимые read jobs штатной bounded recovery процедурой. Старые неопределённые send-команды не отправляем повторно. Если posts attempt продолжает падать уже на новом рабочем подключении, исследуем его конкретные phase/reason, HTTP status, размер ответа и границы лимита через owner diagnostics. Страница, отсутствующая среди ожидаемых подключений нового аккаунта, получает явный статус, а не ложный успешный пустой sync.

В Hub добавляем отдельный снимок **OFAPI** schema с URL/sha/date; не перезаписываем Fansly reference. Небольшой скрипт сравнения method/path, параметров, enum, request fields и важных response variants выдаёт review report. CI работает по закреплённому снимку, без сети и ключа. Обновление снимка — отдельный reviewable diff, не автоматическое открытие новых маршрутов.

**Готово когда:** все ожидаемые подключённые страницы дали свежие успешные upstream reads; webhook приходит в Hub; посты сохраняются и материализуются; старые данные остались связаны с теми же Hub pages. Для неперенесённой страницы виден конкретный статус. По каждому исправлению есть обезличенный fixture. Значение `idle` без полученной строки/полного пустого ответа не считается доказательством восстановления.

### S1. Совместимость существующих чтений

**Статусы sync.** Transactions pull для OF намеренно пропускается: данные поступают через webhook/backfill. Но handler возвращает `satisfied` без `gatedSkip`, и executor обновляет succeeded_at; то же происходит при выключенном top_spenders. Настоящие skips переводим в штатную skip-ветку. Включённый top_spenders действительно пересчитывает локальные transactions без HTTP — это корректная работа. Разделяем завершение задания, пропуск по политике и свежесть исходных фактов; платный HTTP ради зелёной отметки не добавляем. [Handler](../../apps/runtime/src/services/sync/executor-handlers.ts:1509), [executor](../../apps/runtime/src/services/sync/executor.ts:615), [пробы](../../investigations/ofapi-support-refresh-2026-09-05/fable-probes.json).

**Подтверждено локальным исполнением валидаторов:** gallery `type=photos`, messages `filter=pinned`, lists `view=queue`, vault lists `lightweight=true`, fans `filter[max_total_spent]=0` отвергаются. При этом `/users/blocked`, `/users/restricted` и `/messages/search` могут ошибочно проходить как динамический user/message path. [Код](../../apps/runtime/src/services/ofapi-read-gateway.ts:195).

**Ещё два подтверждённых дефекта.** [Tracking spenders parser](../../apps/runtime/src/services/sync/ofapi-fan-identities.ts:79) ожидает `item.id`, хотя этот endpoint возвращает `onlyfans_id`: три строки документированной формы дают ноль identity inserts. Subscribers имеют другую форму с `id`; нужен отдельный typed mapper, а не переименование для всех link users. [Audience sweep](../../apps/runtime/src/services/sync/ofapi-audience-sync.ts:509) при 19 элементах и vendor next offset=20 сохраняет offset=19. Используем проверенный `_pagination.next_page`/`hasMore`, допускаем только тот же account/path и прогресс курсора; фиксированное `+=limit` — fallback только при подтверждённом контракте. Пустая промежуточная страница с continuation не доказывает завершение. `me.subscribersCount` годится для сверки, но не доказывает полный состав аудитории и не разрешает массовое expiry.

**Как:**

- Развести gallery `photos/videos/audios` и vault `photo/gif/video/audio`; при необходимости сохранить проверенные aliases для старого desktop SDK.
- Сначала сопоставлять разрешённые статические маршруты, затем IDs/usernames. Для ещё не реализованных static routes — явный отказ; новое имя провайдера не должно случайно расширять gateway.
- Добавить полезные параметры к точным операциям: pinned, search, `tipsSource`, `view`, `lightweight`; более сложные fan/link filters — вместе с S9/S10.
- Внести изменения одновременно в request validation, capture contract, нормализованный ответ и потребителя. Параметр, который транспорт пропустил, а materializer отверг, не реализован.
- Поддержку ETag/304 для vault lists делать только вместе с сохранением billing/rate headers и проверенной cached body. Выгода — меньше байтов, не меньше credits.
- Сохранить отмеченную в Decision #162 фактическую семантику history cursor. Нынешнее описание `first_id` всё ещё говорит inclusive; это не причина отменять ранее проверенную адаптивную пагинацию.

**Готово когда:** валидные запросы достигают правильной операции; reserved-name probes не попадают в чужие response schemas; фильтрованные/частичные ответы не сертифицируют полноту всей коллекции; старые сценарии desktop продолжают работать.

Дополнительная приёмка: spender rows создают правильные fan identities, subscriber mapper не меняется; short-page/empty-page/повторный курсор не теряют продолжение и не создают ложную полноту. [Локальные воспроизведения](../../investigations/ofapi-support-refresh-2026-09-05/comparison-probes.json), [spenders contract](https://docs.onlyfansapi.com/api-reference/tracking-links/list-tracking-link-spenders), [fans pagination](https://docs.onlyfansapi.com/api-reference/fans/list-active-fans).

Источники: [chat media](https://docs.onlyfansapi.com/api-reference/chats/list-chat-media-gallery), [messages](https://docs.onlyfansapi.com/api-reference/chat-messages/list-chat-messages), [vault lists](https://docs.onlyfansapi.com/api-reference/media-vault-lists/list-vault-lists).

### S1b. Новые read-пути с конкретным потребителем

Первыми: search chat messages, fans expired/latest/top и subscription history, blocked/restricted users, `/me`, notifications/counts и Giphy search. Каждый путь имеет точную allowlist, query schema, capture kind/response validator, page ACL и потребителя в SDK/desktop либо owner UI. Родственные пути можно выпускать одним проверяемым срезом; отдельный PR на каждую строку не обязателен.

Сложные indexed fan filters идут с completeness semantics S10. Notes read/write остаются opt-in, не обязательным ежедневным poll. `users/list` используем для batching нужных identity reads. Side effects конкретных GET учитываем отдельно: просмотр chat messages может менять read-state, Following sort сохраняется на платформенном аккаунте.

**Готово когда:** поиск/история/индикатор используют новую операцию через SDK; static collision невозможен; результат имеет правильный scope и не запускает скрытую дополнительную платную цепочку.

### S2. Вебхуки и жизненный цикл

S1b можно выпускать независимо от этого блока; регистрацию новых webhook types выполняем после готовности их capture/handler. Приёмка S0 не требует upstream HTTP от computed или retired streams.

Текущий каталог содержит **32 события**, регистрация Hub запрашивает **19**. Не добавляем `*` без разбора. У каждого события должна быть явная роль: текущее состояние, исторический факт, progress hint либо сознательное capture-only.

| События | Сейчас | Что реализуем |
|---|---|---|
| Messages, tips, transactions | Основная цепочка есть | Сохраняем, проверяем replay без двойного дохода/сообщения |
| Subscriptions new/renewed | Есть | Общий порядок lifecycle вместе с expired |
| `subscriptions.expired` | Нет | Исторический lapse + корректное текущее subscriber state |
| Шесть существующих account events | Есть | Уточнение source-time/recovery semantics |
| `accounts.disconnected` | Нет | Остановка старого binding, связь с новым аккаунтом |
| Users typing/online/offline | Есть handlers; production журналирует их как обычные webhook-строки (за 72 ч до остановки: ~4200 `users.online`, ~1900 `users.typing`, карантинных строк нет), то есть idempotency header у них приходит вопреки docs | Ephemeral-исключение оставляем как защиту от смены поведения провайдера, не как исправление дефекта |
| Chat queue updated/finished | Подписаны, capture-only | Progress/reconciliation в S11 |
| `data_exports.*`, 7 событий | Не подписаны | Статус существующих export jobs в S8 |
| `media_uploads.*`, 2 события | Нет | Upload lifecycle в S7 |
| `posts.liked` | Нет | Engagement evidence в S11 |
| `fan_summary.completed` | Нет | Отложить вместе с provider AI |

**Ephemeral.** После HMAC сохраняем каждое такое поступление с отдельной локальной receipt identity. Отсутствующий vendor event ID допустим только для документированного набора; сообщения/деньги без него остаются quarantine. Не дедуплицируем одинаковые typing pulses навсегда по body hash. Старые typing не воспроизводим как текущую активность. [Проблемное место](../../apps/runtime/src/services/ofapi-webhooks.ts:153).

Исторический repair quarantine выделяем отдельно от штатного replay accepted events: проверяем сохранённое подписанное тело, восстанавливаем только доступные факты с исходным временем. Если одинаковые receipts уже схлопнулись по body hash, отсутствующие времена поступлений восстановить нельзя. Старый online/offline не должен включать сегодняшнюю SSE-активность.

**Expiry.** Используем `payload.user.id`, `expiredAt` и идентичность периода. Храним факт окончания даже при уже случившейся переподписке; текущее состояние изменяет только актуальное lifecycle evidence. Нужен симметричный guard и для запоздалого new/renewed. Согласуем с существующим понятием `subscription.ended`, не вводим два равнозначных публичных типа. Audience sweep сохраняется как reconciliation. Vendor-derived событие и историческая полнота — разные вещи. [Projection](../../apps/runtime/src/services/ofapi-subscription-projection.ts:34).

Документированный ориентир задержки expiry — около 15 минут. Подключение события не догружает всю прежнюю историю; после перерыва провайдер возобновляет обработку в пределах последних 48 часов. Подписки, для которых он никогда не видел актуальный срок окончания, могут отсутствовать в этом потоке.

**Disconnected.** `acct_` — сменяемое подключение, стабильная идентичность — OnlyFans user ID. Заполняем `external_page_id` только из проверенных creator metadata, добавляем небольшую историю old/new vendor bindings к существующему Hub page. Останавливаем новые запросы/commands к disconnected binding, показываем один incident. Поздние события старого `acct_` остаются привязанными к истории, но не выключают новое подключение. Совпадения username недостаточно. Сейчас generic health может записать suffix disconnected, но action-set его не учитывает. [Health](../../apps/runtime/src/services/ofapi-account-health.ts:33), [mapping](../../apps/runtime/src/services/ofapi-webhooks.ts:215).

**Готово когда:** проходят duplicate, reverse-order expiry/renewal и reconnect/late-disconnect; old binding сохраняет lineage; одна страница не останавливает другую; no-header presence доходит до клиента; invalid signature не становится доверенным фактом. Для релиза нужны registration → capture → canonicalization → projection → contracts/SSE → scoped replay, а не только строка в массиве событий.

Источники: [delivery identity](https://docs.onlyfansapi.com/webhooks/delivery-and-retries), [expiry](https://docs.onlyfansapi.com/webhooks/available-events#subscriptionsexpired), [disconnect](https://docs.onlyfansapi.com/webhooks/available-events#accountsdisconnected).

### S3. История доставок и восстановление

**API:** GET `/api/webhooks`, GET `/api/webhooks/{webhook_id}`, GET `/api/webhooks/events`, GET `/api/webhooks/{webhook_id}/deliveries`, POST `/api/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver`; при необходимости явное управление enabled/account scope в существующем registration flow.

**Как:** сохраняем историю попыток до истечения vendor retention, небольшими окнами с overlap и dedupe. Отдельно храним attempt ID, `delivery_uuid`, event identity, outcome и redelivery lineage. Одна business delivery с тремя попытками не равна трём событиям или трём списаниям.

Локальный ключ истории — vendor attempt ID; `delivery_uuid` служит группировкой. Собираем и successful, и failed attempts. Фильтр failed — представление UI: если синхронизировать только failures, успешная третья попытка не закроет две предыдущие ошибки.

В owner console показываем цепочку: **провайдер пытался доставить → Hub сохранил → событие разобрано → проекция обновлена**. Для потерянного receipt предлагаем remote redelivery; для уже сохранённого parse/projection failure — локальный replay. Accepted redelivery означает «поставлено в очередь»; завершение проверяем по delivery_uuid и местной проекции. Заголовок `X-OFAPI-Redelivery-Of` сохраняем как provenance.

Delivery history ограничен семью днями. Событий, возникших во время remote pause, там вообще нет: по такому окну нужна ограниченная API-догрузка с честным coverage gap. Нельзя обещать восстановление всех событий одной кнопкой. Уточняем receiver budget до текущих 10 секунд и убираем устаревшие комментарии про 15 секунд/пять retries. Одного глобального silence alarm через 12 часов недостаточно для раннего обнаружения этой проблемы.

Провайдер делает до трёх попыток доставки; после 20 подряд окончательно неуспешных deliveries включает pause. Recovery cooldown начинается с 5 минут и может вырасти до 6 часов. Эти состояния должны быть видны в диагностике отдельно от локальной очереди Hub.

**Готово когда:** история переживает vendor retention; 2 failed attempts + successful retry показываются как восстановленная delivery; remote redelivery не дублирует транзакцию/SSE; локальная ошибка чинится без платной внешней пересылки; 409 paused/disabled отражает конкретное действие оператора; raw payload и secrets не попадают в сводные списки.

Источники: [deliveries](https://docs.onlyfansapi.com/api-reference/webhooks/list-webhook-deliveries), [redelivery](https://docs.onlyfansapi.com/api-reference/webhooks/redeliver-webhook-delivery).

### S4. Vendor credit usage и бесплатный баланс

Если ключу разрешено чтение webhooks, уже запрошенный GET `/webhooks` тоже даёт бесплатную top-level credit/balance metadata. Сохраняем её до unwrap. Основной balance probe — usage; дополнительные права и отдельный poll webhook inventory ради этого не нужны. [List Webhooks](https://docs.onlyfansapi.com/api-reference/webhooks/list-webhooks).

**API:** GET `/api/usage/credits`. Ответ на «куда ушли кредиты» и устранение платного ping через chats.

Добавляем bounded usage reads с `from/to`, `group_by=day|account|endpoint`, `account_id`, `include_today`. Metadata `_credits.balance` используем для свежего balance observation. Endpoint бесплатный; ему нельзя запретить обновление баланса самим credit floor или приписать fallback в 1 credit. Внедрение замены ping — после live fixture, поскольку новая response shape пока не проверена.

Храним vendor aggregates как отдельные наблюдения и rebuildable projection. В отчёте рядом: vendor total, локально атрибутированные credits, оценочные/неразнесённые списания, разница и область видимости ключа. **Не складываем vendor usage с локальным ledger** и не распределяем неизвестные расходы по моделям догадкой. Null account/endpoint сохраняется как общекомандная категория.

Сегодня — provisional, законченные дни сверяем после nightly rollup. Локальный ledger остаётся источником actor/feature attribution и онлайн-резервов. Usage не даёт группировку по API key или chatter. Учёт из headers нужен также для 304, ошибок и бинарных ответов. Существующий OFAPI RPM limiter остаётся общим для команды, даже если добавится несколько ключей.

Точный текущий пробел зависит от транспорта: [legacy resolver](../../apps/runtime/src/services/ofapi.ts:183) учитывает non-2xx с `_meta._credits.used`, а без metadata не делает spend claim; [governed capture](../../packages/db/src/repositories/ofapi-capture.ts:2196) уже фиксирует reserved estimate и затем корректирует его по body metadata. Поэтому ошибки могут давать как недоатрибуцию, так и завышенную оценку. Не вводим правило «всем ошибкам 1 credit кроме 402/429». Добавляем общий разбор body/credit headers с явной политикой при противоречии, сохраняем исходные значения. `x-ofapi-is-cached` и `Idempotent-Replayed` включаем в разрешённые capture headers; существующий JSON cache flag не заменяет evidence для bodyless responses. Обновляем legacy, gateway, commands и capture jobs, а не только экран сверки.

**Готово когда:** free balance работает при нулевом остатке; equivalent-scope totals сходятся за закрытый день или разница объяснена; неполная видимость ключа и расходы без account видимы; нет повторного учёта webhook retry/redelivery; включение отчёта не меняет действующие caps.

Источник: [Credit Usage](https://docs.onlyfansapi.com/api-reference/usage/get-credit-usage). Код: [текущий paid ping](../../apps/runtime/src/services/ofapi.ts:308), [credit reports](../../apps/runtime/src/services/ofapi-credit-report.ts:1).

### S5. Per-API-key permissions

Документация подтверждает ограничения ключа по операциям и аккаунтам, но **не описывает публичный CRUD API для scopes**. `whoami` показывает сведения о ключе/команде; поля scopes там не документированы. Синтетический Hub `whoami` нельзя использовать как introspection провайдера.

**Как:** описываем требуемые возможности для выбранных Hub workflows; проверяем supported console/config workflow выдачи ключа. Сохраняем ключи только на сервере. Начинаем с ограничений существующего runtime key; второй admin key добавляем, если управление webhooks/pixels/accounts действительно требует другого набора полномочий. Не создаём новую IAM-платформу.

Readiness показывает configured scope, наблюдаемую доступность и unknown отдельно. Недоступный из-за scope account не считается удалённым, а отсутствие строк — пустой аудиторией. Различаем 401/403 провайдера, edge rejection и OnlyFans session state. В Hub это уже частично сделано в Decision #245: дополняем существующую диагностику, не ломаем её.

Добавляем конкретный preflight **ожидаемой команды OFAPI** при принятии/смене серверного ключа. Vendor `whoami.team.slug` сверяем с заранее подтверждённым значением и сохраняем время успешной проверки; не берём expected автоматически из нового ключа. Подтверждённое несовпадение блокирует регистрацию webhook и stateful vendor actions с понятной причиной. Недоступный whoami означает unknown, не mismatch. Синтетический Hub `/ofapi/read/whoami` для проверки не подходит. Сегодня `ofapiApiKey` — boot-конфигурация: это проверка credential adoption/boot, не существующая кнопка динамической смены. Число видимых accounts не доказывает принадлежность другой команде: ключ может иметь account restrictions.

Успешную проверку привязываем к fingerprint конкретного credential; при его смене прежний результат недействителен. Новый ключ не допускаем к stateful actions до preflight. Проверка охватывает основной клиент и fallback создания клиента для регистрации; DB-only работа Hub от её недоступности не останавливается. Возможную законную смену slug оформляем как явное обновление ожидаемой привязки.

**Готово когда:** denied operation не создаёт retry storm или предложение перелогинить модель; разрешённые операции продолжаются; смена ключа проходит ограниченный preflight и обратимый переход; права Hub page/principal проверяются независимо от vendor scope; write permissions не проверяются тестовой публикацией.

Источники: [MCP controls](https://docs.onlyfansapi.com/onlyfans-ai/mcp#control--safety), [Whoami](https://docs.onlyfansapi.com/api-reference/api-keys/whoami).

### S6. Отправка v2, Idempotency-Key и Banned Words

Расширяем текущий ChatGoose через существующий outbox.

1. **Provider idempotency.** До dispatch закрепляем ключ от durable command UUID вместе с account/chat/body fingerprint; передаём `Idempotency-Key` в send-message. Сохраняем `Idempotent-Replayed`, message ID и реальные credits. Первый релиз сохраняет одну физическую попытку. 409 in-flight не означает, что сообщение не отправлено; mismatch body/chat — отдельная ошибка. Окно response cache 24 часа, а 408/429/5xx не сохраняются: после timeout нельзя незаметно превратить POST в «проверку состояния». Расширение повторных отправок потребует отдельного доказанного контракта восстановления.
2. **Дробные цены.** В новом versioned send contract допускаем цену в центах в разрешённом диапазоне. Внутри — existing branded money; на границе OFAPI — USD. Не используем денежные float-вычисления. Старый v1 не расширяем полями, которые его клиенты отвергают; новый SDK и desktop adoption выпускаем вместе.
3. **Полноценный composer.** `replyToMessageId`, явно выбираемый `lockedText`, Giphy и release-form references. Сейчас caption платного media-send автоматически становится locked; новое поведение должно дать пользователю осознанный выбор. Numeric vault ID и одноразовый upload ID — разные виды material. Release forms читаем/прикрепляем по подтверждённым типам, не копируем противоречивый string schema поверх документированного массива.
4. **Banned Words.** GET `/banned-words`, cache/version словаря, подсветка найденного текста и vendor alternatives. Сначала preview в composer; блокирующий `blockBannedWords` включается явной политикой. Результат 422 сохраняет черновик и объясняет конкретное препятствие. Никакого скрытого переписывания текста или автоматической повторной отправки.

Названия уровней Banned Words контринтуитивны: `strict_ban` блокирует все три tiers, `risky` — два нижних, `replace_soften` — только нижний. UI должен объяснять реальное действие. Regex из словаря не выполняем произвольно без ограничений; для первой версии достаточно проверенных правил и серверного screening. Словарь — справочник провайдера, а не гарантия отсутствия любых ограничений OnlyFans.

`Idempotent-Replayed: true` сам по себе не подтверждает send: cached response может быть ошибочным. Нужны успешный HTTP status, валидный message ID и связь с исходным payload. После смены team/account область idempotency меняется; старые uncertain sends не переносим в автоматический retry нового подключения.

**Готово когда:** `$6.97` проходит codec без потери точности; новая команда сохраняет reply/price/preview/release forms; повторный receipt не создаёт второй send; timeout по-прежнему не запускает второй POST; заблокированный текст остаётся редактируемым draft; новый SDK не ломает существующие пять command kinds. Отдельные fixtures на TTL, 409, 422 mismatch, zero-credit replay и media token ambiguity.

Источники: [Send Message](https://docs.onlyfansapi.com/api-reference/chat-messages/send-message), [Banned Words](https://docs.onlyfansapi.com/api-reference/banned-words/list-banned-words), [composing](https://docs.onlyfansapi.com/introduction/guides/composing-messages). Код: [sender](../../apps/runtime/src/services/ofapi.ts:1139), [price validation](../../packages/contracts/src/routes.ts:4316).

### S6b. Небольшой пакет desktop-команд

Первый срез — `set_fan_custom_name_v1`. Следующий — like/unlike, pin/unpin и mark-unread; затем mute/unmute/hide. У каждой команды свой kind, target, ACL, durable intent и outcome. Парные действия можно выпускать вместе; SDK обновляем на законченный клиентский срез, без обязательного re-vendor после каждой строки enum.

Custom name нужен для текущей практики агентства; страна в свободном тексте не становится достоверной таймзоной. OF-native notes остаются отдельным opt-in с направлением синхронизации. Модерация и mass messaging получают отдельные capabilities при появлении выбранного сценария.

**Готово когда:** действие доступно в desktop, подтверждается Hub и обновляет локальную модель; failure/unknown видны, повтор не создаёт второе независимое действие.

### S7. Async upload и OF vault catalog

Сценарий: выбрал собственный файл → виден прогресс → файл готов к повторному использованию или однократной отправке → известна связь с исходным материалом.

**API:** POST `/{account}/media/vault`, POST `/{account}/media/upload`, существующий GET `media/uploads/{upload}/status`, оба `media_uploads.*`; GET vault/lists/item. Первая рабочая версия — upload-to-vault для повторного использования; CDN upload нужен для прямого одноразового attachment.

`async=true` передаём полем body/multipart согласно endpoint schema; query-параметр `?async=true` не используем как подтверждённый контракт.

Разделяем S7a upload→vault→готовый media ID и S7b полный catalog. S7a может отправлять результат существующей media-send v1: [schema](../../packages/contracts/src/routes.ts:4316) уже допускает numeric и `ofapi_media_*` IDs. Полный send v2 не prerequisite; ограничения цены/полей v1 сохраняются. Vault reads уже захватываются gateway, поэтому расширяем inventory/materialization/completeness, а не строим capture заново.

**Как:**

- Небольшая durable upload entity/job на существующей инфраструктуре: principal, page/binding, source artifact identity/hash/bytes, vendor upload ID, numeric media ID, request/response provenance, status, cost и timing. Reuse capture/leases/admission; отдельный универсальный workflow engine не нужен.
- Отделить pending/processing/completed/failed/indeterminate upload от готовности transcoded media. `completed` с `isReady=false` не делает все rendition URLs готовыми.
- Status polling и webhook обновляют одну запись идемпотентно. Ограниченный polling — recovery path; он бесплатный по контракту. Webhook может прийти раньше обработки 202.
- Одноразовый CDN material резервируется за одной send-командой. Неясный send оставляет потребление неясным; не инициируем повторный upload/send автоматически. Reusable vault ID не имеет этого ограничения.
- Сохраняем источник и стабильные media IDs; URL — обновляемый locator. Полный OF catalog строим по пагинированным vault/lists/items, со scope completeness и связями к уже существующему content-media model. Не приписываем OF готовность лишь потому, что такая таблица уже используется другой платформой.
- Ограничиваем размер/тип и проверяем file_url до передачи провайдеру; используем разрешённый artifact/source flow, не generic URL fetch. Сохраняем авторизацию page и source access. Direct multipart документирован до 100 MB; URL limits расходятся между guide и тарифной конфигурацией — до live-проверки это capability, а не обещание 1 GB для всех.
- Чтение/синхронизация release forms и taggable users; типизированные ссылки на подтверждения вместе с материалом. Операции создания формы/приглашения выделить в самостоятельное действие при необходимости.

Для ContentOps сначала полезнее metadata/provenance и inventory completeness, чем немедленно скачивать весь vault через платный OFAPI. До binary import оцениваем bytes, credits, disk и повторное использование исходников. DRM/download — отдельный controlled путь для собственных разрешённых материалов; отсутствие `files.full.url` не равно отсутствию файла. Старый FAQ с обходом через send/delete не используем: существует прямой vault upload.

**Готово когда:** две одинаковые completion-delivery дают один результат; account mismatch отвергается; upload/readiness видны отдельно; token не может одновременно уйти в два sends; failed upload не считается оплаченным upload без vendor evidence; полный inventory отличим от части данных; повторное использование vault ID не запускает повторную передачу файла.

Источники: [upload guide](https://docs.onlyfansapi.com/introduction/guides/uploading-media), [vault upload](https://docs.onlyfansapi.com/api-reference/media-vault/upload-media-to-vault), [upload status](https://docs.onlyfansapi.com/api-reference/media/get-upload-status), [downloads](https://docs.onlyfansapi.com/introduction/guides/downloading-media).

### S8. Profile Visitors и расширение экспортов

Ежедневная посещаемость профиля — недостающий контекст для понимания притока подписчиков и изменения дохода.

Profile Visitors — **агрегаты по аккаунту и дню, а не список людей, посмотревших профиль**. Сохраняем date, total/guest/user/subscriber visitors и avg_view_duration. Пока единица/определение duration не подтверждены отдельным fixture, не переименовываем её в «секунды» по догадке. Не суммируем категории как непересекающиеся без подтверждённой семантики.

**Как:** расширяем существующие export profiles типом `profile_visitors`, начиная с одной OF-страницы и короткого закрытого диапазона. Create с `auto_start=false`; bounded start; статусы/артефакт; checksum, фактические строки, source dates и pricing. После проверки — первоначальная история по нужному бизнес-окну. Для свежих закрытых дней добавляем альтернативу: GET `/{account}/statistics/reach/profile-visitors` с ограниченным overlap. REST проще для регулярного чтения без export job; batched export экономнее при допустимой задержке обновления. До выбора default сверяем один диапазон обоими способами: REST chart зависит от `type`, flags `isAvailable`/`hasStats`, а равенство всех breakdown/duration полей CSV не доказано. Пропущенные измерения остаются неизвестными, не нулевыми.

Для бюджета: два аккаунта × один daily REST × 30 дней — ориентир 60 credits; один batched export тех же 60 account-days — ориентир 3 credits по общему row-тарифу. Это разные freshness/call profiles, не гарантия финальной цены или полной эквивалентности полей. Дополнительные REST `type`/окна увеличивают расход. Ежедневные небольшие exports также нельзя оценивать как один месячный batch без проверки округления/quote.

Результат получает отдельную проекцию daily profile metrics и owner/team-lead read route. День без строки не становится нулём: показываем unavailable/ineligible/missing/complete с evidence. Рядом можно показывать новые подписки и доход, но отношение подписок к visits — показатель с оговорёнными популяциями, не доказанная пользовательская воронка и не причинный эффект рекламы.

События `data_exports.*` обрабатываем по vendor export ID с привязкой к нашим job/account IDs: top-level account_id может отсутствовать. Командный export status не публикуется глобально в page SSE. Polling остаётся страховкой; webhook completion не заменяет приёмку артефакта.

Поздний `in_progress` не откатывает completed. Callback до создания local↔vendor mapping сохраняется для последующей привязки; неизвестный export не отдаёт данные произвольной странице. Обе гонки входят в fixtures.

После visitors — последовательно добавляем типизированные профили `fans`, `tracking_links/trial_links/smart_links`, затем нужные historical financial/media exports. Каждый тип имеет собственную parser/coverage семантику. Уже действующее ограничение chat-history pilot автоматически не снимается.

Общие API list/cancel/retry добавляем с точным смыслом. Отмена местного blocked job сейчас не означает vendor cancel. Provider retry создаёт новый export с auto-start — это новая оплачиваемая операция. Сохраняем число найденных и доставленных строк отдельно; completed media ZIP с failed_downloads остаётся частичным.

**Готово когда:** pilot даёт проверенный account-day dataset, immutable artifact и верный credit outcome; missing/ineligible дни видимы; повторный импорт идемпотентен; completion без артефакта не выглядит как успешный import; export другой страницы не раскрывается заявителю; ежедневный visitors job ограничен бюджетом и не мешает DM.

Источники: [Data Exports](https://docs.onlyfansapi.com/data-exports), [create](https://docs.onlyfansapi.com/api-reference/data-exports/create-data-export), [retry](https://docs.onlyfansapi.com/api-reference/data-exports/retry-failed-data-export), [cancel](https://docs.onlyfansapi.com/api-reference/data-exports/cancel-data-export), [REST Profile Visitors](https://docs.onlyfansapi.com/api-reference/statistics/get-profile-visitors). Код: [существующий узкий export target](../../apps/runtime/src/services/ofapi-export-quotes.ts:35).

### S9. Привлечение, Smart Links, Pixels и Postbacks

При активной работе с трафиком первый продукт — понятный отчёт по источникам; второй — управление интеграциями этих источников.

**S9a — данные и отчёт.** Расширяем текущие link identities: бесплатные stored tracking/trial, shared inventories, typed per-link stats, subscribers/spenders и cohort ARPS. Добавляем Smart Links list/get/stats/cohort-arps/clicks/conversions/fans/spenders и tags. Фиксируем upstream IDs, page scope, окно attribution, net/gross, bot/duplicate flags, observed_at и coverage.

Быстрый полезный срез — проекция `cost{}` и `tags` из stored tracking/trial, которые уже попадают в raw, но [normalizeLinkItem](../../apps/runtime/src/services/ofapi-link-stats-sync.ts:107) их не использует. Сохраняем вид cost, единицы/валюту и источник; provider campaign cost не подменяет фактические расходы агентства. Отсутствующий cost не равен нулевому. Бесплатные `stored/*` возвращают inventory/агрегаты ссылок; вложенные related subscribers/spenders URL ведут на обычные платные endpoints. Discovery ссылок можно удешевить через stored inventory, индивидуальный user-walk от этого бесплатным не становится. [Контракт](https://docs.onlyfansapi.com/api-reference/stored-tracking-links/list-stored-tracking-links).

В отчёте: источник/ссылка → валидные клики → новые/повторные подписчики → расходы привлечённых фанов. Revenue из link attribution не прибавляется ещё раз к Hub revenue. Различаем измеренный link LTV, текущий daily revenue и расходы на трафик. Сначала читаем имеющиеся ссылки; создание/изменение tracking/trial/smart link — отдельные типизированные команды с понятным target.

**S9b — Pixels API.** Реализуем list/create/update/disconnect/test-event на `smart-links/{id}/pixels`. Ключевая модель: pixel принадлежит команде и может быть привязан к нескольким ссылкам. PATCH влияет на общий pixel; DELETE снимает одну связь. Показываем известные affected links и полноту этой информации; при неполной видимости нельзя обещать воздействие только на выбранную ссылку. Tokens шифруем, не возвращаем в SDK и не пишем в логи.

Read inventory выпускаем раньше изменений. Отдельный постоянный vault pixel access tokens не строим без потребности: provider получает write-only secret, повторная замена — явный ввод нового значения. Используем существующую защиту секретов и restricted capture для command/body; публичные DTO содержат безопасные сведения о конфигурации. CRUD/test остаются частью поддержки Pixels.

**S9c — Postbacks.** Typed CRUD `/smart-link-postbacks`, URL/body/header templates, разрешённые события и источники. Это настройка передачи данных наружу: показываем destination и фактический набор полей перед записью. Pixel test-event тоже реально отправляет событие во внешнюю рекламную систему; это отдельное явное действие, не health GET и не автоматический smoke. Сохраняем test provenance, чтобы не смешивать его с реальными конверсиями.

Не обещаем API для всего Smart Links V2: traffic-source editor, Meta spend connection, pre-landers и public shares описаны как dashboard capabilities, соответствующего публичного CRUD сейчас нет. Из полезных нюансов attribution: окно click→subscription 6 часов, а `first purchase` в pixel semantics не равен первой платёжной транзакции фана. Учитываем это при названиях показателей и экспортов.

**Готово когда:** данные нескольких ссылок сводятся без двойного дохода; organic/bot/duplicate и first/repeat не смешаны; shared pixel patch показывает scope; disconnect не изображает удаление общего pixel; test не отправляется незаметно; конкретный маркетинговый вопрос можно решить из Hub без чтения raw JSON.

Источники: [Smart Links V2](https://docs.onlyfansapi.com/introduction/guides/onlyfans-meta-pixel-smart-links), [pixel update](https://docs.onlyfansapi.com/api-reference/smart-links/update-smart-link-pixel), [pixel disconnect](https://docs.onlyfansapi.com/api-reference/smart-links/disconnect-smart-link-pixel), [pixel test](https://docs.onlyfansapi.com/api-reference/smart-links/send-smart-link-pixel-test-event). Существующая опора: [link sync](../../apps/runtime/src/services/ofapi-link-stats-sync.ts:400).

### S10. Аудитория, CRM и эффективность сообщений

**Что полезно добавить:** expired/latest/top fans и subscription history; blocked/restricted users; новые fan filters; durable пользовательские списки и membership; message engagement/buyers, mass/direct statistics.

**Как:** переиспользуем fan identity и page relationship; отчёты/списки проецируем из captured responses. Таблицы provider notes/custom name не подменяют локальные append-only notes: храним source/version, явно выбираем направление синхронизации. Create/edit lists, pin/mute/read-state и moderation commands выпускаем отдельно от чтения; контактные действия не запускаются автоматически.

Для desktop сначала `set_fan_custom_name_v1`, затем like/unlike, pin/unpin, mark-unread; mute/hide — следующим отдельным срезом. Сейчас [FanPanel](../../../of-desktop/apps/desktop/src/renderer/src/features/fan-panel/FanPanel.tsx:137) лишь показывает custom name; [TODO](../../../of-desktop/TODO.md:13) подтверждает практику записи страны в имя, но не достоверную таймзону. OF-native notes не объявляем восстановлением существующего сценария: [историческое решение v1](../../../of-desktop/docs/PRD.md:106) их исключало. Batch `users/list` уже есть в desktop client, но рабочих потребителей не найдено: применять для реально необходимого enrichment с coalescing, не запускать обязательный платный refresh каждого профиля.

Для zero-spender/expired сегмента обязательны `_source.is_complete` и `omitted_from_page`. Индекс провайдера может быть неполным, а GET с `max_total_spent` сам запускает backfill. Это не привычный «дешёвый безопасный полный список». Фильтры кодируем bracket syntax; online=0 отличается от отсутствия фильтра. Если потребуются Following reads, не задаём sort ради удобства: он сохраняется на аккаунте; empty page не terminal, следуем `_pagination.next_page`.

**Полезный сценарий:** очередь недавно истёкших подписок с prior spend, last reply и contactability. Она ранжирует кандидатов для ручной работы, без автоматической рассылки. Message buyers и engagement дают понимание эффективности PPV; delivery, open, purchase и revenue остаются разными показателями.

При list-write с `skip_invalid` заранее учитываем до пяти внутренних попыток и иной partial-result payload. Нельзя резервировать один credit и считать частичный ответ полным успехом списка.

**Готово когда:** сегменты воспроизводимы и показывают полноту; истёкшая подписка не удаляет CRM-историю; blocked фан объяснимо недоступен для контакта; raw/local/provider notes не затирают друг друга; buyer stats сверяются с идентичностями и финансовыми фактами; partial batch имеет точные added/failed.

Источники: [active fans](https://docs.onlyfansapi.com/api-reference/fans/list-active-fans), [following](https://docs.onlyfansapi.com/api-reference/following/list-all-followings), [user lists](https://docs.onlyfansapi.com/api-reference/user-list-collections/add-users-to-user-list). Полный перечень соседних операций — в CSV.

### S11. Посты, stories, кампании и очередь публикаций

**S11a — чтение и сохранение.** Добавляем post details/stats, labels, comments/replies и post-likes evidence; stories active/archive/details/stats/viewers, highlights; mass-message queue/details/overview и engagement; notifications/counts. Это даёт историю публикаций, связь media→post/campaign и измерение результата. Исторический список не притворяется полным, если vendor даёт только окно.

`posts.counters` используем для дополнительной сверки, не как доказательство полного обхода. `minimumPublishDate` сокращает инкрементальный сбор новых публикаций, но не обнаруживает все правки и удаления старых: сохраняем ограниченную периодическую сверку. [List Posts](https://docs.onlyfansapi.com/api-reference/posts/list-posts).

**S11b — необязательное продолжение после основных пакетов.** По выбранному продуктовому сценарию — create/update/schedule posts, публикация/удаление stories и mass-message create/update/cancel. В текущей схеме нет story update и scheduledDate для stories; собственное отложенное размещение stories — отдельное возможное расширение. UI показывает конкретный материал, цену, время и получателей; durable intent и one-attempt dispatch живут в Hub. Массовая отправка не становится generic write proxy.

Mass queue использует собственный queue ID; `chat_queue.updated/finished` обновляют status, не порождают send. Schedule одному фану через mass-messaging остаётся stateful scheduled operation. Update/cancel после частичной отправки не обещают, что все сообщения исчезли. Условия `subscribedWithinLastDays`, scheduledDate и saveForLater проверяем совместно, по ограничениям провайдера.

Story overlays/mentions/stickers поддерживаются актуальным endpoint, хотя FAQ говорит обратное. Для первой версии достаточно проверенного publish payload; визуальный редактор overlays можно добавить позже. Release-form attach-tags заменяет набор тегов; пустой массив может снять существующие связи, поэтому «добавить тег» нельзя реализовать слепой отправкой неполного массива.

**Готово когда:** read-часть связывает пост/кампанию с исходным материалом и результатом; публикация требует явного principal и конкретного target; повтор command не публикует дубль; timezone и актуальный состав получателей видимы; partial delivery/cancel не объявляются полным откатом; клиент получает подтверждённый remote ID.

Источники: [posts](https://docs.onlyfansapi.com/api-reference/posts/send-post), [mass messaging](https://docs.onlyfansapi.com/api-reference/mass-messaging/send-mass-message), [stories](https://docs.onlyfansapi.com/api-reference/stories/add-to-story).

### S12. Что подключать из остального и что отложить

**Первый конкретный read-срез:** balances snapshot + payout requests/statuses, если нужен экран доступного/ожидаемого баланса и истории выплат. Payout requests используют документированные limit/offset; response marker не превращаем в request cursor без проверки. Earning-statistics — временной ряд earnings, не payout methods. Balances, заявки и earnings — разные факты/проекции с собственными status/money codecs. [Payout requests](https://docs.onlyfansapi.com/api-reference/payouts/list-payout-requests), [earning statistics](https://docs.onlyfansapi.com/api-reference/payouts/get-earning-statistics).

После visitors и PPV engagement выбираем одну необходимую financial/subscriber сверку. Ежедневный обход всех overview types, earnings, subscribers и близких analytics сразу не включаем. Для каждого job нужны потребитель, вопрос, период, частота и бюджет; «паритет с Fansly» сам по себе не основание. Стоимость зависит от страниц/окон, а не от обещания 2–3 или 10 credits на страницу в день.

| Семейство | Решение | Причина / минимальная полезная версия |
|---|---|---|
| Account metadata, `/me`, connection status, client sessions/re-auth | Добавить нужные read/status; lifecycle UI после S2/S5 | Проверенная привязка аккаунта и меньше ручной диагностики; face/OTP остаются осознанным действием владельца |
| Statistics, financial/summary analytics, payouts/chargeback summaries | Выбранные read snapshots для сверки | Hub уже рассчитывает деньги; vendor-derived profitability может опираться на другую комиссию/себестоимость |
| Tracking/trial creation, promotions, bundles | После read/attribution, по рабочему сценарию | Рекламная акция должна иметь цель, scope, срок и понятное изменение цены |
| Public Profiles | По необходимости для onboarding/identity | В Hub уже есть альтернативный public-profile path; vendor lookup не обязателен для всех CRM-операций |
| Release forms create/invite/rename/hide | После read/attach в S7/S11 | Отдельная процедура с реальными участниками, не автоматическая часть upload |
| Provider fan AI summaries и custom categories | Отложить | Дублируют Hub AI gateway/dossier, оплачиваются отдельно; можно позже импортировать как provider-authored evidence |
| Banking, tax/legal settings, withdrawal | Отложить | Низкая польза для текущего обновления, отдельные денежные/учётные процессы |
| Subscribe-to-user, массовая moderation, delete vault, account disconnect | Только по конкретному продуктовому запросу | Нет причины открывать эти действия ради endpoint parity |
| Saved-for-later autosend / автоматические кампании | Отложить | Новая автономная коммуникация с фанами, требует отдельного продуктового поведения |
| Deprecated media scrape | Исключить | Используем действующие upload/download пути |
| Vatstack/CoinGate callbacks | Исключить | Внутренняя инфраструктура провайдера |
| FansBot, provider MCP, Make/n8n/Zapier | Не включать в runtime Hub | Это альтернативные способы доступа к API. Для разработки полезны docs/MCP, но они не заменяют наш adapter/custody |

## 2. Стоимость и ограничения

| Сценарий | Текущий документированный ориентир | Что делаем в Hub |
|---|---|---|
| Usage, delivery list, upload status, stored links | Явные бесплатные исключения | Не применяем generic fallback в 1 credit |
| Обычный uncached вызов OnlyFans | Обычно 1 credit; upstream errors тоже могут стоить | Читаем фактическую metadata/headers, различаем vendor rejection и upstream call |
| Media upload/download | 3 credits / decimal MB, минимум 1 на файл; cached download может быть бесплатным | До запуска показываем bytes/оценку, ограничиваем стоимость, не скачиваем весь vault по умолчанию |
| Webhook | 1 credit / 100 events; retries не отдельный расход, manual replay оплачивается | Не считаем attempt rows как business events; сверяем с vendor usage |
| Обычный export | Ориентир 1 credit / 20 результатов; часть типов считает цену после scan | Проверяем quote/actual cost, отдельный ceiling; не считаем free create бесплатным export |
| Profile Visitors | Число потенциальных строк = account-days | Например 90 дней × 2 страницы = до 180 строк; по общему тарифу ориентир 9 credits, финал подтверждается quote/actuals и eligibility |
| Provider AI summary | 200 credits / generation | Не включаем как дубль собственного AI |
| Vault lists ETag/304 | Сокращает payload; credit может всё равно списаться | Credits/rates берём из новых headers, не cached `_meta` |

Тарифы — снимок на дату аудита, не неизменяемые константы приложения. Существующие caps, fair scheduling и disk admission сохраняются. Для новых тяжёлых потоков задаём отдельный небольшой budget, чтобы export/catalog не вытеснял интерактивные сообщения. Общекомандный RPM не умножается от количества ключей.

Источники: [credits](https://docs.onlyfansapi.com/introduction/essentials/credits), [rate limits](https://docs.onlyfansapi.com/introduction/essentials/rate-limits), [exports](https://docs.onlyfansapi.com/data-exports).

## 3. Приёмка и выпуск каждого среза

Каждый законченный срез должен давать пользовательский результат, а не просто метод в клиенте:

1. Точные входные поля и response variants, назначение данных, side effects, стоимость, scope и source timestamp. Для undocumented/contradictory частей — fixture и отдельно отмеченное предположение.
2. Существующий egress resolver, principal/page ACL, credit admission и durable capture. Новая stateful операция — конкретная команда с устойчивой идентичностью и явным indeterminate outcome.
3. Нормализованный read/command result, provenance, projection/coverage и UI/SDK consumer. Unknown, unavailable, missing и zero не подменяют друг друга.
4. Детерминированные tests на значимый риск: request mapping, duplicate/out-of-order, partial response, crash recovery, credit charging и cross-page access. Для новой таблицы — forward-only migration, lineage/erasure inventory и rebuild поведение.
5. `routes.ts` → `pnpm contracts:generate`; re-vendor OF desktop SDK только для используемых новых операций. Проверить совместимость общего Hub SDK и то, что Fansly routes/поведение не изменились.
6. `pnpm check` и затронутые integration tests с Docker; не гонять две vitest integration suites одновременно. После необходимых checks — один ограниченный live canary, затем обычный staged rollout с verification window.

Примеры ключевых acceptance-наборов:

| Риск | Обязательный сценарий |
|---|---|
| Expiry ordering | Renewal пришёл первым, старый expired — позже; active остаётся active, история сохраняет оба факта |
| Account rebinding | Новый acct связан с прежним stable creator; поздний disconnect старого не выключает новый |
| Webhook recovery | Уже сохранённый event redeliver не удваивает деньги; пропущенный receipt после recovery доходит до проекции |
| Raw-first | Сбой parser не теряет body; сбой durable capture не выдаёт успешный ACK |
| Sending | Timeout не запускает второй POST; 409 idempotency conflict не становится «точно не отправлено» |
| Replay response | Replay header с ошибочным ответом не подтверждает send; remap team/account не возобновляет старые uncertain sends |
| Freshness | Webhook-sourced skip не имитирует sync; реальный DB top_spenders завершается без HTTP и показывает свежесть исходных фактов |
| Delivery attempts | Два failed + один successful attempt сохранены отдельно под одной delivery_uuid |
| Upload | Completed с `isReady=false`, duplicate webhook, polling race, один token на две команды |
| Credits | Zero balance не блокирует free usage; 304 и replay корректно учитывают headers/нулевой расход |
| Export | Completed без принятого artifact не successful import; failedDownloads > 0 не full coverage |
| Visitors | Неeligible account-day виден как missing/unavailable, а не нулевой traffic |
| Scope | Restricted key/account не превращает неполный roster или usage в «всю команду» |
| Pixels | Shared pixel update не скрывает влияние на другие ссылки; test dispatch остаётся отдельным событием |

Регистрацию новых вебхуков, schema rollout и локальный replay планируем отдельно. Например, replay старого lapse восстанавливает историю, но не должен запускать сегодняшнюю re-engagement рассылку. Нельзя включать каждое новое событие как источник незапрошенных сообщений или повторных платных reads.

## 4. Проверки перед релизом

| Вопрос | Почему документации недостаточно | Проверка перед релизом |
|---|---|---|
| Vendor key permissions | FAQ говорит full access, новые страницы — restricted; whoami scopes не описаны | Поддерживаемая console-конфигурация + безопасные identity/status reads; записать реально доступную область |
| Переход на новый аккаунт/ключ | Причина остановки сообщена владельцем; новые bindings и успешный переход ещё не проверены | Whoami/accounts нового ключа, stable IDs, ожидаемые страницы, webhook и свежие reads |
| No-header users events | Контракт допускает, Hub quarantines; live incidence не установлена | Новые естественные signed deliveries и разрешённая диагностика headers/quarantine |
| Idempotency при upstream ambiguity | Response cache не покрывает все ошибки/время | Синтетические transport tests; отдельный управляемый test-account pilot перед расширением retry-политики |
| Export dates/types | Guide допускает отсутствие dates у ряда типов, schema объявляет required | Типовые quote probes с auto_start=false; paid start только в утверждённом pilot |
| Media size/readiness | URL size и account tariff различаются; completed не readiness | Один небольшой собственный файл, валидировать terminal fields и стоимость |
| Release forms | Schema string против guide arrays; attach-tags parameter rename | Fixture точного запроса/ответа и подтверждённая идентичность queue/message |
| CreatorTraffic pixel fields | Required pixel_id в schema при «unused» в описании; test не поддерживается | Проверить платформенный payload перед первым реальным config action |
| Pagination | `first_id` prose расходится с наблюдением; following может вернуть пустую промежуточную страницу | Сохранить адаптивные правила и проверить точные cursor transitions |
| Visitors interpretation | Нет identities; eligibility даёт отсутствующие строки; duration unit не закреплена | Первый CSV fixture и сверка дневных чисел с источником |

Остальные замеченные противоречия: FAQ отрицает прямой vault upload и story overlays; composing example нарушает правило previews⊆mediaFiles; fan filters в schema записаны через точки вместо bracket wire; event-list example содержит 13 событий вместо полного каталога из 32; ряд examples содержит старые daily-rate поля и несовпадающую цену экспорта. **Источник истины для реализации — конкретный endpoint + проверенный fixture с сохранённым raw, а не случайный FAQ или response example.**

## 5. Первый релиз и граница расширения

Первый релиз предлагаю ограничить **S0 + S1**, с параллельной подготовкой fixtures для S2/S4/S6. S0 — отдельное завершение известного перехода аккаунта/ключа; кодовый срез S1 исправляет воспроизводимые несовместимости и закрепляет OFAPI baseline. Разработку не задерживаем общим расследованием уже объяснённого простоя. Затем выпускаем отдельными срезами lifecycle, delivery, usage, permissions и send v2, завершая первый пакет S0–S6.

Крупные продуктовые части — uploads/catalog, exports/visitors, traffic/pixels — не объединяем с восстановлением production в один релиз. Все названные пользователем новые функции входят в S2–S9; оставшаяся широкая поверхность разделена на полезные следующие этапы и сознательно отложенные направления. Реализация выбранного этапа должна завершаться рабочим UI/API сценарием и проверкой восстановления, а не галочкой у нового endpoint.

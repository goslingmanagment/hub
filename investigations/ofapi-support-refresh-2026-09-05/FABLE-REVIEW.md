# Проверка Fable plan и итоговое объединение

Дата: 05.09.2026. Hub `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`. Проверяется приложенный Fable plan (текст передан владельцем в чате, в репозитории не хранится). Это сравнение конкретных документов, не рейтинг моделей.

**Рабочий результат:** [единый план реализации](../../docs/plans/2026-09-05-ofapi-coverage-refresh.md). Исходный PLAN в investigations теперь доказательное приложение, не конкурирующий актуальный план.

## Оценка

Fable plan удобнее как компактная очередь: отдельные desktop-команды/read-пути, конкретный payout/read backlog и набор сценариев приёмки. Он включил важные исправления первого сравнения: историю bindings, существующий subscription.ended, expiry ordering, fractional price, ограничение URL-size, export polling fallback, artifact acceptance и общие Pixels.

Наш план точнее как инструкция к реализации: в Fable остались ранее разобранные ошибки pagination/credits/retry/capture и появился риск потери delivery attempts. Кроме того, scopes отложены, хотя пользователь явно запросил их поддержку. Удобство структуры не компенсирует эти технические ограничения.

Наш план тоже улучшен: убрана лишняя зависимость первого vault upload от send v2; не требуется отдельный token vault для Pixels; publishing явно стал необязательным продолжением; общий S12 получил конкретный небольшой payout-срез. Уточнён реальный дефект статусов sync, который раньше был только общей оговоркой о свежести данных.

| Из Fable | Решение итогового плана |
|---|---|
| Отдельные desktop commands/read routes | Принято как S6b/S1b; выпуск законченными сценариями, без обязательного PR/re-vendor на каждую строку |
| Видимость аккаунта и молчащего источника | Принято; provider binding error отделён от модельной сессии, timestamps не подменяют свежесть фактов |
| Конкретные payouts/statistics reads | Принято частично: balances + заявки/статусы, затем выбранная сверка по потребности |
| Free metadata у GET webhooks | Подтверждено документацией; используем уже полученную metadata, основной balance read — usage |
| Compact acceptance matrix | Принято, исправлены критерии sending, pagination, delivery attempts и computed streams |
| Read inventory Pixels первым | Принято; последующие CRUD/test сохраняются в плане |

## Ключевые проверки

### 1. Send retry: повтор POST остаётся повтором операции

Fable выводит безопасность повторной отправки из того, что 5xx/408/429 не кешируются. Документация называет retries безопасными, но описанный механизм — response cache с ограниченным сроком/областью. Отсутствие записи не доказывает отсутствие уже выполненного действия OnlyFans. «Одна попытка плюс один ре-проб» ограничивает число повторов, а не исключает дубль.

В итоговом S6 сохраняется одна физическая попытка первого релиза. Для расширения нужен доказанный recovery contract; после смены team/account прежняя область idempotency меняется. Это оценка достаточности гарантии для Hub, не заявление, что дубли уже наблюдались. [Send Message](https://docs.onlyfansapi.com/api-reference/chat-messages/send-message).

Дополнительная ошибка: `Idempotent-Replayed: true` недостаточно для confirmed. Может воспроизводиться ошибочный ответ; сохраняем проверку успешного статуса и валидного message ID в [sender](../../apps/runtime/src/services/ofapi.ts:1193). Критерий Fable «нет второго POST без ключа» слабее необходимого «неясный исход не запускает второй POST автоматически».

### 2. Delivery history: UUID группирует attempts

В Fable предложен dedup по `delivery_uuid`. Все attempts одной delivery имеют общий UUID: такой уникальный ключ потеряет вторую/третью попытку. Хранить по vendor attempt ID, группировать по UUID; синхронизировать success и failure. `succeeded=false` — UI-фильтр, не единственный ingest-фильтр. Remote redelivery исправляет отсутствующее поступление; сохранённые parse/projection failures исправляет local repair. [Delivery rules](https://docs.onlyfansapi.com/webhooks/delivery-and-retries).

### 3. Presence: временной бакет не заменяет receipt identity

Fable отказался от вечного body-hash, но «receipt id с временным бакетом» неоднозначен. Hash(account/fan/body/bucket) тоже схлопывает независимые pulses внутри бакета. Каждое accepted ephemeral поступление имеет уникальный receipt ID; coalescing допускается после durable capture. Поддерживаем delivery и с provider key, и без него для разрешённых трёх типов.

Заявленные 4200 users.online за 72 часа здесь независимо не проверены. Даже такой счётчик не доказывает наличие idempotency header у typing/offline или всех online. Отсутствие событий за последние 24 часа совместимо с их наличием раньше в 72-часовом окне. В итоговый план не включён вывод «presence никогда не работал».

### 4. Pagination и credit errors не исправляются общей формулой

Остаются две ошибки предыдущего отчёта: `offset+=limit` плюс `subscribersCount` как полнота и non-2xx→1 кроме 402/429. Реальные local probes подтверждают, что consumer игнорирует nextPageUrl, а credit resolver уже учитывает body used при любом статусе. Governed path при missing-meta вообще сохраняет estimate, который может завышать расход. Итог: проверенный continuation/completeness и body/header cost evidence для каждого транспорта. [Локальные результаты](../../investigations/ofapi-support-refresh-2026-09-05/comparison-probes.json).

Free stored inventories **самих ссылок** в новой формулировке Fable — корректное улучшение по сравнению с первым отчётом. Индивидуальные people reads остаются платными; отличия freshness/removed/shared/smart-link scope нужно проверить перед заменой discovery.

### 5. Transactions/top_spenders: ошибка в критерии успеха, узкий дефект в skip

OF [transactions handler](../../apps/runtime/src/services/sync/executor-handlers.ts:1509) намеренно пропускает pull; источник денег — webhook/backfill. Рабочий [top_spenders](../../apps/runtime/src/services/sync/executor-handlers.ts:1302) агрегирует локальные transactions, поэтому HTTP ему не нужен.

Но noop transactions и disabled top_spenders возвращают satisfied без gatedSkip. [Executor](../../apps/runtime/src/services/sync/executor.ts:615) вызывает [completePageSync](../../packages/db/src/repositories/page-sync.ts:2387), обновляет succeeded_at и очищает ошибки. Настоящие skips нужно направить в skip-ветку; локальный расчёт и свежесть его входных фактов показывать отдельно. Новый платный pull ради успеха не нужен.

Выполнены настоящие handlers с запрещёнными DB/provider доступами: оба skip проходят без I/O и не содержат gatedSkip. [Скрипт](../../investigations/ofapi-support-refresh-2026-09-05/fable-probes.mjs), [результат](../../investigations/ofapi-support-refresh-2026-09-05/fable-probes.json).

### 6. Upload и vault: две ошибки и одно упрощение нашего плана

`async` — body/multipart field, не документированный query. Raw vault reads уже захватываются [gateway](../../apps/runtime/src/services/ofapi-read-gateway.ts:499); пробел — полный inventory/catalog/coverage. [Upload contract](https://docs.onlyfansapi.com/api-reference/media-vault/upload-media-to-vault).

`send_media_message_v1` уже принимает numeric и `ofapi_media_*` IDs: [schema](../../packages/contracts/src/routes.ts:4316), успешный safeParse в новых probes. Поэтому первую загрузку→vault→send можно выпустить без всего send v2. Это полезное упрощение нашей прежней зависимости. Полный disk upload требует Hub+SDK+desktop flow, не снятия одного flag.

### 7. Scopes, Pixels и CRM: не путать отсутствие management API с отсутствием поддержки

Per-key endpoint/account restrictions документированы; FAQ о полном доступе недостаточен для откладывания явно названной пользователем функции. В Hub нужны preflight, правильные отказы и работа с ограниченным roster; public CRUD scopes для этого не требуется. [Документация](https://docs.onlyfansapi.com/onlyfans-ai/mcp#control--safety).

Pixels inventory выпускается первым; typed CRUD/test остаётся. Отдельное постоянное хранилище access tokens не обязательно: используем существующую защиту secret-bearing commands, provider хранит свой write-only token, обновление требует явной замены. [Pixel update](https://docs.onlyfansapi.com/api-reference/smart-links/update-smart-link-pixel).

Notes не включаем в ранний обязательный desktop-пакет: [исторический PRD](../../../of-desktop/docs/PRD.md:106) фиксирует исключение v1; нового решения вернуть функцию не найдено. Custom name, reactions/pins/unread обоснованы лучше.

### 8. Payouts и контент: конкретные типы и потребители

Payout requests принимает limit/offset; marker есть в примере ответа, но не документирован как request cursor. Earning-statistics — earnings time series, не payout methods с masked credentials. В итоговом плане отдельно balances snapshots, payout facts и earnings. Цена ежедневного сбора зависит от числа страниц/окон. [Payout requests](https://docs.onlyfansapi.com/api-reference/payouts/list-payout-requests), [earning statistics](https://docs.onlyfansapi.com/api-reference/payouts/get-earning-statistics).

`posts.counters` — дополнительная сверка, не доказательство полноты; minimumPublishDate не обнаруживает все правки старых публикаций. Сохраняем periodic reconciliation. [List Posts](https://docs.onlyfansapi.com/api-reference/posts/list-posts).

Ежедневный сбор всех статистических семейств сразу избыточен без потребителей. Приоритет — visitors, balances/requests, выбранная financial сверка и PPV engagement. Publishing можно отложить по пользе, но [ContentOps readiness plan](../../docs/plans/2026-09-03-contentops-media-identity.md:8) не передаёт весь OF capture другому приложению.

## Production и авторизация

Владелец уже объяснил простой сменой аккаунта/ключа: повторно выбирать, «какая команда production», не требуется. Нужна проверка ожидаемой новой identity и сохранение old bindings до remap. Коды provider binding/key не подменяются модельным auth-dead; [Decision #245](../../docs/decisions.md:10475) требует раздельного смысла восстановления.

Один новый read-only GET `/api/whoami` с последним ключом в 13:42 UTC получил edge 403. Повтор/обход не выполнялись, accounts/webhooks после отказа не запрашивались. Это не проверка валидности нового ключа и не основание считать старую команду актуальной. Ключ не сохранён в файлы.

Точные timestamps Fable, состояние loravievip, 4200 presence events и утверждение об успешных free-balance probes независимо не подтверждены в этой проверке. Production не изменялся. Конкретный план перехода готовится до применимых owner gates; дополнительные отдельные подтверждения на каждый read/локальную правку не вводятся. Миграции получают следующий свободный номер на момент PR, не фиксированное 0150 навсегда.

## Итог объединения

Сохраняем глубину контрактов нашего плана и полезное деление Fable на небольшие пользовательские срезы. Приняты уточнения sync telemetry, payout types и callback races; сняты лишние зависимости upload/send и обязательность полного publishing. Scopes и Pixels остаются в целевом обновлении. Все спорные правила отправки, пагинации, расходов и dedup заменены проверенными формулировками в едином рабочем файле.

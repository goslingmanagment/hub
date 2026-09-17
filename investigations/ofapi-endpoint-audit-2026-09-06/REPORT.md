# Проверка покрытия и корректности OnlyFansAPI — 06.09.2026

**Все эндпоинты не покрыты; среди реализованных остались подтверждённые ошибки.**
Проверена именно ревизия production `7fac98f310d673134c8dcb5dd6596e126e7f9e69`.
Это аудит с полным перечнем операций, локальными проверками поведения и ограниченной
read-only проверкой production. Это не утверждение о полном сквозном тестировании
всех операций на реальном аккаунте.

## Что проверено

| Проверка | Результат |
|---|---|
| Актуальный OpenAPI OnlyFansAPI | 294 уникальные пары HTTP method + path, 55 категорий |
| Конкретный исходящий вызов в Hub | **39 операций**; 31 GET, 6 POST, 1 PUT, 1 DELETE |
| Нет конкретного исходящего вызова | **255 операций** |
| Если исключить 2 внутренних callback поставщика | 39 из 292 интеграционных операций; 253 отсутствуют |
| Каталог вебхуков | 32 события; Hub запрашивает 19; canonicalizer объявляет 16 |
| Тесты production-ревизии | **722/722 passed**, 57 файлов, 0 skipped; из них 398 интеграционных тестов в 30 файлах |
| Официальные примеры ответов gateway | Все 14 доступных примеров HTTP 200 проходят текущий shape validator; у 2 из 16 proxy-операций нет такого примера |
| Дополнительные проверки | Ошибки воспроизведены на реальных исходниках с подменой HTTP/DB; корневой агент независимо повторил оба repro |

**39 означает наличие конкретного пути вызова, а не полную поддержку его возможностей.**
Например, exports ограничены существующим chat-message pilot, upload — чтением статуса,
usage/credits — запросом баланса за вчера. Наличие generic transport не считалось покрытием.
255 отсутствующих строк не являются автоматически очередью разработки: среди них есть
внутренние callbacks, deprecated операция и функции вне текущего продуктового scope.

Полный перечень: [CSV, все 294 операции](inventory/endpoint-matrix.csv),
[JSON с исходящими вызовами и параметрами](inventory/endpoint-matrix.json),
[сводка всех категорий](inventory/summary.json), [методика](inventory/README.md).

## Почему проверялся отдельный checkout

Рабочий `/Users/dmitriy/code/goose/hub` был на `582ef1cf`. После `git fetch origin`
`origin/main` оказался на `f1834cd9`: там поверх baseline добавлен план, без реализации.
Production image label указывает на `7fac98f310d6`, ветку `fix/ofapi-posts-capture`.
Для проверки создан отдельный detached worktree:
`/tmp/hub-ofapi-audit-20260906/deployed`.

Последняя проверка 06.09 в 16:14 МСК подтвердила ту же deployed revision и contract hash
`46f7a01e6b6339c302b16cf4c592dd95199ee5ed2337536c11156d4154859fcc`.
Все ссылки вида `apps/...:line` в приложениях относятся к этому commit, а не к старому main.
Исходники ни рабочего checkout, ни production не изменялись; добавлены только материалы аудита.

## Подтверждённые ошибки и их последствия

Приоритет означает порядок исправления по техническому влиянию. Воспроизведение условия
ошибки не доказывает, что оно уже случилось в production.

| ID | Приоритет | Ошибка | Последствие и доказательство |
|---|---|---|---|
| R1 | P2 | Fan identities заканчивает обход короткой страницы, игнорируя `hasNextPage=true` | Страница 2 не запрашивается; target помечается завершённым и возвращается `satisfied:true`. Обе фазы — links и subscribers. `sync/ofapi-fan-identities.ts:327,420` |
| R2 | P2 | Общий list parser превращает HTTP 200 `{data:{}}` в пустую последнюю страницу | Transactions/chargebacks/links могут принять нарушение ожидаемой формы за завершение сбора. `ofapi.ts:612`; downstream backfill/reconcile действительно заканчивают обход |
| R3 | P2 | Неудачный credential preflight кешируется на весь срок жизни клиента | После одного 503/таймаута `/whoami` повторная проверка уже не делает HTTP; команды и governed capture остаются закрыты после восстановления поставщика. `ofapi.ts:733-763,2015-2037` |
| W1 | P1 | Допустимые ephemeral вебхуки без idempotency header уходят в quarantine | Typing/online/offline подтверждаются поставщику, но не обрабатываются. Байты сохранены. В проверенных live данных этот триггер **не наблюдался**. `ofapi-webhooks.ts:153`, `ofapi-webhook-capture.ts:68` |
| W2 | P2 | Старое событие подписки меняет более свежую запись | Цена 10000 mills становится 4000, а новый `sourceUpdatedAt` сохраняется. Также безусловно выставляется active/subscriber. `ofapi-subscription-projection.ts:183-218`; SQL upsert без проверки времени |
| W3 | P2 | Account health упорядочивает события по времени получения | Запоздалый failure старой auth attempt после reconnect может снова поставить рабочие collectors на паузу. Проверка generation защищает другой binding, но не этот порядок. `ofapi-account-health.ts:100-123` |
| W4 | P2 | Нет повторной обработки неудачного account-health projection после settlement | Временная ошибка чтения оставляет событие `processed`; повторный запуск пропускает health. Пропущенный recovery сохраняет auth block. `ofapi-events.ts:287-288,354`, `ofapi-account-health.ts:154` |
| R4 | P2 | Команды/legacy gateway/admin игнорируют отрицательное подтверждение сохранения расходов | При отказе обеих accounting-записей нет отдельного восстанавливаемого состояния расходов. Подтверждённую отправку нужно сохранить успешной; её повторять нельзя. `ofapi.ts:1357` и аналогичные вызовы |
| R5 | P2 | Числовой media ID теряет точность при `Number(id)` | Допустимый контрактом `9007199254740993` уходит как `9007199254740992`. Реальные ID такого размера в production не проверялись. `ofapi.ts:1308`, `routes.ts:4361` |
| R6 | P3 | Gateway неполно проверяет required query и limit | Пропускает user-lists limit 1/100 при vendor диапазоне 10–50; users/list без ids и messages/search без query доходят до upstream rejection. `ofapi-read-gateway.ts:220,254,302` |

Подробные trigger, ссылки на документацию, трассировка downstream и пробелы тестов:
[request audit](request-audit.md), [webhook audit](webhook-audit.md).
Оба набора проверок повторены корневым агентом. Для W2 дополнительно прочитан реальный
SQL upsert: timestamp fence действительно отсутствует, вывод не основан только на mock.
Для R4 показан именно проигнорированный отказ accounting; потери production-расходов этим
аудитом не установлены.

## Что отсутствует в поддержке

35 из 55 категорий не имеют ни одного конкретного исходящего вызова. Среди них:
банкинг/payouts, financial/summary analytics, Banned Words, blocked/restricted users,
account authentication workflow, stories/highlights, mass messaging, большинство settings,
Smart Links/Pixels/Postbacks, release forms. Частично поддержаны chats/messages, fans,
tracking/trial links, media/vault, posts и exports. Точный scope каждой операции — в матрице.

Из существенного для текущего pipeline:

- `subscriptions.expired` не запрашивается и не имеет webhook projection; expiry пока
  зависит от audience reconciliation.
- Для `accounts.disconnected` health handler уже существует, но событие отсутствует в
  регистрации Hub, canonicalizer и SSE mapping. Это частичная поддержка.
- `media_uploads.*`, семь `data_exports.*`, `posts.liked`, `fan_summary.completed` не
  запрашиваются. REST polling существующих exports при этом реализован.
- Нет операторского workflow delivery history/manual redelivery; header
  `X-OFAPI-Redelivery-Of` не сохраняется. Обычная дедупликация исходного ключа уже есть.
- Отсутствующие optional query/body возможности, включая дробный PPV и расширение send,
  перечислены отдельно от ошибок разрешённых запросов. Generic write proxy не нужен:
  новые команды должны продолжать существующий outbox.

## Что уже исправлено и работает в проверенном коде

Старые finding о gallery type, collisions users/search, spender id, частичной
fans/active странице и OFAPI через page proxy не перенесены в список текущих ошибок.
В deployed revision gallery aliases нормализуются, search имеет свою ветку,
fans/active валидируется строже, spender берётся по `onlyfans_id`, OFAPI egress
разрешается отдельно от page proxy. Баланс запрашивается через бесплатный usage endpoint.

Проверены HMAC по raw bytes, capture до parse, сохранение malformed/conflict фактов,
дедупликация, pending sweep, базовые one-attempt команды, существующий export pilot,
обработка денег через named mills constructors. Тесты доказывают свои проверенные
сценарии, а не полноту API или фактическую активацию всех flags.

## Production: что удалось подтвердить

Проверки выполнены 06.09.2026 примерно в 16:03–16:14 МСК. SQL выполнялся только
под `read_only`, с ограничением времени запроса; выгружены агрегаты и технические поля.

- API, worker, scheduler и Postgres были healthy; `/api/v1/health` вернул `ok` для API/DB.
  Свободно **36 GB**, занято 54% диска.
- `lora-of` и `lora-vip-of` имеют OFAPI mapping generation 1; `external_page_id`
  в обеих страницах пуст. Это не отменяет mapping через OFAPI и требует отдельной
  проверки identity/backfill, если эта область включается в исправления.
- За проверенные 24 часа сохранены 452 `messages.received`, 407 `messages.sent`,
  1153 `users.typing`, 994 `users.online`, 970 `users.offline`; последние receipts свежие.
  Это доказательство поступления в журнал, а не самостоятельная проверка desktop SSE.
- За 72 часа не найдено `ofapi.webhook.invalid_identity` или `ofapi.webhook.malformed`.
  Поэтому W1 — воспроизведённая несовместимость с допустимым контрактом, без утверждения
  о текущих потерях presence.
- По постам обеих страниц есть HTTP 200, `parse_version=8` и terminal observations.
  У lora-of initial run в 07:11 МСК сохранил terminal counts 686 raw / 673 accepted /
  13 boundary duplicates / 0 rejected; последний terminal — 15:32 МСК.
  У lora-vip-of последний terminal — 12:48 МСК. Terminal относится к scope конкретного
  задания; он не доказывает наличие всей истории постов вне этого scope.
- Последний просмотренный provider receipt по постам сообщает **99 209 credits**
  на 15:32 МСК. Это снимок ответа, не прямо запрошенный текущий баланс. Старое заключение
  о нулевых кредитах к этой проверке неприменимо.
- Свежие `/whoami` preflight receipts имеют HTTP 200. Текущий успешный preflight не
  опровергает R3: там отдельно воспроизведён временный отказ первого запроса.

Ограничения: `read_only` сейчас имеет SELECT только на 10 таблицах; нужные
`ofapi_capture_jobs`, `ofapi_webhook_events`, credit ledger, sync states/runs и incidents
не доступны. `/api/v1/health/sync` без аутентификации вернул 401. Поэтому полный census
job states, flags, backlog, credit reconciliation и построчная materialization здесь не
подтверждены. Использован доступный первичный журнал; другой DB principal не применялся.
Платные vendor пробы, отправка сообщений, публикации, перезапуски, изменение flags,
webhook registration, redelivery и деплой в этом аудите не выполнялись.

Исходные безопасные выборки: [health](evidence/production-health.txt),
[receipts по платформе](evidence/production-ofapi-facts.txt),
[receipts по страницам](evidence/production-observations.txt),
[parse/HTTP evidence](evidence/production-capture-proof.txt),
[terminal counts и баланс](evidence/production-terminal-facts.txt).

## Источники и дрейф документации

Скачаны актуальные [llms.txt](https://docs.onlyfansapi.com/llms.txt),
[llms-full.txt](https://docs.onlyfansapi.com/llms-full.txt),
[OpenAPI](https://app.onlyfansapi.com/scribe-docs/openapi.yaml);
проверен [API Reference](https://docs.onlyfansapi.com/api-reference).
Метод/path знаменатель взят из OpenAPI. Отдельный Fansly API исключён.

`llms.txt` и `llms-full.txt` совпали байт-в-байт: 6 253 347 bytes каждый,
SHA-256 `8872033186d33968b2c0e2dc5c3df5ba86e63d8032dadf5a1289d34391e4d177`.
OpenAPI: 3 212 912 bytes,
SHA-256 `0eb6f13c70ec29e3b22b2bc105cf7588f06c33fd2b9797e5a3d5418b454a982e`.

LLM-документы содержат 293 OF и 89 отдельных Fansly endpoint sections. Дополнительная
OpenAPI-операция — внутренний CoinGate callback. После исключения generated examples
остались два смысловых расхождения: OpenAPI добавляет `supercharged_events` в create/update
Smart Link Pixel, а llms его ещё не содержит. Оба пути пока не реализованы Hub.
Детали: [docs-diff.json](inventory/docs-diff.json).

## Рекомендуемый следующий шаг

Сначала закрыть ошибки существующего потока: R1/R2 (достоверное завершение обхода),
R3 (восстановление preflight), W1–W4 (доставка и порядок lifecycle).
В этот же набор добавить целевые regression cases, отсутствующие среди 722 зелёных тестов.
Accounting recovery R4 сохраняет подтверждение отправки и никогда не означает resend.
R5/R6 — небольшие точные поправки границ контракта.

Расширение оставшихся операций продолжать по существующему OFAPI plan в проверенной
ревизии, с отдельным решением о нужных функциях и их активации. Не превращать число 255
в автоматическое включение новых collectors. Live приёмка исправлений должна проверять
capture → parse → projection → потребителя и состояние завершения, а не только HTTP 200.

## Повторяемость

[test-summary.json](evidence/test-summary.json) содержит точную команду и перечень всех
57 файлов; [полный результат Vitest](evidence/deployed-test-results.json) — 722 assertions.
Suite использовала локальный Postgres 16 через Testcontainers, файлы запускались последовательно.

[request-repro](evidence/request-repro.mjs) и [webhook-repro](evidence/webhook-repro.cjs)
содержат только синтетические данные и подменяют HTTP/DB. Их результаты сохранены рядом.
Для повтора нужны checkout указанного commit и его pnpm dependencies; зафиксированный
worktree оставлен по указанному выше пути. Запуск request-repro из worktree:
`node --import tsx/esm <absolute-path-to-request-repro.mjs>`.
В текущих repro paths к checkout и output зафиксированы явно.

Матрицу можно восстановить через `inventory/extract-inventory.cjs <repo> <snapshot-dir>`;
snapshot-dir должен содержать скачанные официальные `openapi.yaml`, `llms.txt`,
`llms-full.txt`. Сверять их SHA-256 с указанными выше, поскольку provider docs меняются.

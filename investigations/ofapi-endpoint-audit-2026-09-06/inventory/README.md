# OnlyFansAPI: воспроизводимая инвентаризация 2026-09-06

Проверен код commit `7fac98f310d673134c8dcb5dd6596e126e7f9e69` в `/tmp/hub-ofapi-audit-20260906/deployed`; parent подтвердил соответствие production image label. Этот отчет самостоятельно НЕ проверяет production flags, успешность vendor запросов или результаты тестов.

## Результат

Свежий OpenAPI содержит **294 method/path операции в 55 категориях**. В коде Hub обнаружены **39 явных исходящих операций**: GET 31, POST 6, PUT 1, DELETE 1. **255 операций не имеют конкретного исходящего пути** в Hub. Покрыты хотя бы одним вызовом 20 категорий; 35 категорий не имеют вызовов. `implemented_scoped` означает наличие конкретной реализации, а не полное соответствие всех параметров, body, ответов или доказанную работу в production.

Число 255 нельзя читать как размер feature backlog. Два пути — `/api/webhooks/vatstack` и `/api/webhooks/coingate` — внутренние callback endpoints поставщика. POST `/{account}/media/scrape` поставщик пометил deprecated и направляет к Download Media. Другие отсутствующие возможности могут перекрываться собственными механизмами Hub либо требовать отдельного продуктового решения.

`whoami` и `accounts` у desktop gateway синтезируются локально; реальные vendor вызовы тоже есть, но в admin/preflight потоке. `GET /usage/credits` реализован только как вчерашний from/to balance probe, а не как весь аналитический API расхода. Три Data Exports операции обслуживают quote + owner-approved bounded chat-message pilot; это не универсальный экспорт всех видов данных. POST messages обслуживает только существующие versioned text/media команды. Upload поддержан только чтением статуса.

## Артефакты и повтор

- `endpoint-matrix.csv` / `endpoint-matrix.json`: все 294 операции, status, категории, source evidence, конкретные реализации, gateway allowlist, параметры, deprecated, liveProbeExecuted=false и ссылки на docs.
- `summary.json`: счетчики по всем 55 категориям, SHA256 источника, HEAD, методика и исключения.
- `source-signatures.json`: извлеченные AST конкретные исходящие вызовы, включая capture и export.
- `docs-endpoints.json`: все 382 docs sections: 293 OF + 89 отдельного Fansly API.
- `docs-diff.json`: различия источников и вложенных схем.
- `baseline-comparison.json`: сравнение с сохраненной матрицей 2026-09-05: 34 → 39 (+5, без удалений).

Повтор из любой директории:

```sh
node /tmp/hub-ofapi-audit-20260906/inventory/extract-inventory.cjs /tmp/hub-ofapi-audit-20260906/deployed /tmp/hub-ofapi-audit-20260906
```

Скрипт принимает явные repo, snapshot directory и optional output directory, поэтому переносим вместе с архивом источников. Без snapshot аргумента ищет openapi.yaml в своей директории или на уровень выше; без repo аргумента использует git root текущей директории. Скрипт использует уже установленные yaml/typescript из pnpm store проекта. Он не устанавливает зависимости, не запускает приложение или test suite и не обращается к сети. AST извлекает конкретные request paths; `{kind}` для tracking links раскрывается только в объявленное интерфейсом конечное множество subscribers/spenders. Чистый resolver gateway изолированно вызывается на каждом OpenAPI GET пути. Универсальные `proxyRead` / `dispatchGovernedRaw` не увеличивают покрытие сами по себе. Поиск остальных исходящих callers выполнен по всему apps/packages/scripts дереву; OFAPI vendor network boundary остается в `services/ofapi.ts`. Отдельный `onlyfans-public-profiles.ts` ходит на OnlyFans.com и не является реализацией vendor `/api/profiles`.

Параметры в matrix — статическая инвентаризация имен. Bracket notation `filter[online]` нормализуется к `filter.online` при сравнении; родительский object parameter `filter` отдельно отсутствующим не считается. Бounded capture filters, body capabilities, числовые ограничения, заголовки и shape validation требуют отдельного рассмотрения.

## Изменения относительно прошлой матрицы

Добавлены реальные GET `/whoami`, `/usage/credits`, `/webhooks`, `/webhooks/{webhook_id}`, `/{account}/chats/{chat_id}/messages/search`. Предыдущее широкое сопоставление пользователей больше не допускает reserved `users/blocked` и `users/restricted`; поиск сообщений теперь имеет собственную ветку. Эти исправления уже есть в проверенном deployed commit, их нельзя предлагать как новые дефекты текущего production.

Новые transport callers подтверждены: preflight `apps/runtime/src/bootstrap.ts:407`; inventory `apps/runtime/src/services/ofapi-webhooks.ts:255`, `:261`, `:277`; free balance `apps/runtime/src/services/ofapi-credits.ts:417`; binding roster snapshot `apps/runtime/src/services/ofapi-binding-refresh.ts:23`.

## Остаточные границы покрытия

Десять реализованных GET операций имеют недоступные в Hub документированные query capabilities:

| Операция | Не предоставляемые параметры |
|---|---|
| accounts | onlyfans_id, onlyfans_username, onlyfans_email |
| fans/all и fans/active | type, filter.tips, filter.duration |
| trial-links | startDate, endDate, sort, field, synchronous |
| posts | query, pinned, counters, minimumPublishDate |
| stored/trial-links и stored/tracking-links | filter.include_smart_links, filter.search, filter.tags |
| tracking-links/{id}/spenders | minSpend |
| tracking-links | startDate, endDate, with_deleted, sortby, sort, pagination, synchronous |
| usage/credits | group_by, account_id, include_today |

Это ограничения поддерживаемого scope, а не автоматически дефекты существующих callers. Gateway parseQuery также не проверяет наличие required ids/query для users/list и messages/search: пустой query пропускается локально и может получить provider 422. `media/vault/lists` conditional ETag/If-None-Match режим не проведен через gateway, который принимает rawPath/rawQuery/readIntent; значит полная header/304 parity отсутствует.

Намеренное архитектурное ограничение: read gateway остается GET-only (Decision #54, `docs/decisions.md:711`), generic write proxy запрещен в пользу versioned outbox (Decision #55, `:738`). Остальные отсутствующие интеграционные операции не следует автоматически добавлять обходом этих границ. Дополнительные продуктовые решения потребуются для payouts/banking, аккаунт/auth управления, post/story writes, массовых сообщений, settings, внешней AI summary, Smart Links/Pixels, release forms и прочего.

## Дрейф официальных источников

`llms.txt` и `llms-full.txt` в этом скачивании байт-идентичны (SHA256 `8872033186d33968b2c0e2dc5c3df5ba86e63d8032dadf5a1289d34391e4d177`). Они содержат 293 OF sections и 89 Fansly sections. В OpenAPI есть дополнительный provider callback `POST /api/webhooks/coingate`; OF docs-only операций нет.

21 embedded schema отличаются сырыми values; после исключения случайно сгенерированных examples остаются только 2 смысловых расхождения: `supercharged_events` есть в OpenAPI для POST Smart Link Pixel и PATCH Smart Link Pixel, но отсутствует в llms (OpenAPI lines 52721 и 52931). Оба endpoint в Hub отсутствуют, поэтому этот docs drift не ломает существующий Hub вызов.

## Ограничения проверки

Ни один production/vendor запрос в этой подзадаче не выполнялся. Test suite не запускалась. Код проекта не менялся. Матрица полностью перечисляет OpenAPI method/path, но сама по себе не доказывает корректность bodies, парсеров, пагинации, capture, materialization, authorization или production activation. `liveProbeExecuted=false` означает отсутствие прямого vendor smoke probe со стороны inventory; это не отрицание сохраненных production свидетельств parent audit (whoami 200, posts 200 + parsed + terminal). Parent отдельно проверил official 200 examples для 14 из 16 proxied operations; у upload_status и vault_lists пример отсутствует, см. gateway-response-examples.json.

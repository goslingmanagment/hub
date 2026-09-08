# Живые наблюдения координатора

Дата: 2026-09-07, около 07:50–08:20 МСК. Read-only проверка production; пассивное наблюдение обычной загрузки Fansly в Firefox. Секреты, тела переписки и медиа не переносились в этот пакет.

## Production

- Docker API, worker, scheduler, Postgres healthy. Свободно 36 GB из 79 GB, filesystem used 55%.
- Docker label API `agency-hub.source-revision=2475b3046332`; локальный исследуемый HEAD `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`. Diff соответствующих Fansly путей проверен отдельно в независимых отчётах. Это разные revisions.
- `GET https://gosling-agency.ru/api/v1/health` в `2026-09-07T05:03:15.706Z`: status ok, API/DB ok, DB latency 1 ms. Contract hash `59deb1b5c836b6cc4f7a6b269684aac660bd239a1d3bfcfdeda43984b620bb6f`.
- SQL исполнялся только через `psql -U read_only -d agency_hub_core`, в `BEGIN READ ONLY`, statement_timeout 20 s. Первоначально найдены table-level SELECT grants на 10 таблицах. **Исправление после кросс-сверки:** это не полный эффективный доступ — у `page_sync_states` есть SELECT на 14 колонок; прямой SELECT успешно выполнен позднее в этой же дате. См. [повторную проверку](../../fansly-events-cross-check-2026-09-07/evidence/read-only-verification.txt). Доступ к `sync_http_attempts` и `config_settings` отсутствует. Grant/role не менялись.
- `hub capabilities` получил HTTP 200, но локальный CLI отказался разобрать ответ: `response_validation_failed`. Это ограничение конкретной проверки/совместимости CLI; оно не означает отказ production API.
- [SQL](production-query.sql) и [результат](production-observations.txt): снимок `2026-09-07 05:04:46.961620+00`, окно предыдущих 24 часов, шесть Fansly pages.

| Page | Observations за 24 h |
|---|---:|
| lora-1 | 7 064 |
| lora-2 | 5 008 |
| lora-3 | 3 644 |
| lilly-1 | 2 585 |
| lilly-2 | 9 625 |
| ari-1 | 518 |
| Всего | 28 444 |

По producer: `dm_conversations` 15 560 (54.7%), `fan_earnings` 4 416 (15.5%), `followers_reconcile` 3 435 (12.1%), `dm_messages` 1 701 (6.0%). В producer totals входят разные kinds, включая failed/local terminal evidence там, где они присутствуют.

Это распределение **сохранённых observations**, не HTTP attempts: не охватывает неуспешные попытки без capture, retry, браузер, расширения, дополнительные тела/локальные completion markers. Не устанавливает включённые flags, полноту истории, projection parity или точный процент будущей экономии. `parse_version=0` у deliberately noncanonical kinds не доказывает parser backlog.

## Firefox, контейнер lora-1

- Первый доступный Firefox был в Ari-1. Для исследования использована отдельная вкладка существующего контейнера `lora-1`, выбранного через File → New Container Tab. Логин, смена credentials, установка расширения и изменение proxy не выполнялись.
- Обычная загрузка `https://fansly.com/` открыла `/home`; UI показывал `lora-1` и профиль `LoraVie`. Никаких тестовых сообщений, покупок, лайков или удалений не создавалось.
- Network Monitor с фильтром `wsv3` показал **два HTTP 101** для `wss://wsv3.fansly.com/?v=3`, Initiator `main.8d0ac612d8667b89.js:1 (websocket)`; HTTP transfer 166 B на handshake, HTTP response body 0 B. Эти HTTP размеры **не измеряют WebSocket frames**.
- Это свежая проверка существования endpoint и установления WS в данной браузерной сессии. Два handshake не доказывают причину второго подключения, серверный fan-out, успешную authentication frame или доставку всех событий.
- Реальные business frames, auth ACK и длительная continuity в этой проверке **не сохранены**. Исторический bundle имеет другое имя/hash; его protocol/handler semantics остаются свидетельством версии от 2026-08-20.
- Во время дальнейшего осмотра Computer Use сообщил об изменении Firefox пользователем; новый осмотр показал закрытый DevTools. Продолжение конкурирующих UI действий прекращено. Никакой standalone WSS connection с перенесённым токеном не запускался.

Отсюда: endpoint подтверждён живым браузером, но transport readiness и event coverage требуют отдельного canary. Основной архитектурный вывод не зависит от предположения, что этот gate уже пройден.

# Fansly HTTP: три возможности с подтверждённым управляющим путём

13.09.2026. `main=b48f173d93e3693550e2db139de3b11107d44ce2`, production по общему артефакту — `74aac5093cfc`. `fansly-media-stats.ts`, `fansly-dm-conversations.ts`, `fansly-account-probe.ts`, `fansly-catalog.ts` имеют одинаковые Git blobs в обеих ревизиях. Это присутствие кода, не подтверждение production gates/объёмов. Изменений реализации нет.

| ID | Приоритет | Возможность | Условный выигрыш |
|---|---|---|---|
| FH07-1 | P2, сначала | Не продолжать media HTTP после terminal 429 | До 4 лишних обращений внутри chunk из пяти запросов; сохранить Retry-After |
| FH07-2 | P2 | Возобновлять частичный `split_31` refresh по окнам | До 40% запросов этого режима; probe: 13 → 9 |
| FH07-3 | P2 | Один batch account-resolution на DM list-page | 4 singleton lookup → 1; проверка до 100 кандидатов вместо первых четырёх |

## FH07-1. Item-isolation поглощает общий отказ провайдера

**Путь и включение.** `fanslyMediaStatsChunk` требует flag/allowlist (`apps/runtime/src/services/sync/fansly-media-stats.ts:615–622`). `requestWindow` перехватывает любой отказ кроме 401/403, записывает ошибку media с `nextDueAt=now+day` и возвращает `failed` (`:731–752`). `visitCandidate` превращает его в `skipped` (`:960–977`), внешний цикл продолжает остальные media (`:902–919`).

**Что действительно доказано.** Реальная функция с I/O-mocks получила пять terminal `FanslyApiError(429, RetryAfter=600s)` для разных media: пять adapter calls, пять item failures; ошибка наружу не вышла, continuation примерно через 20s. Это не измерение реальных HTTP.

Отдельно проверен production transport: adapter кладёт deadline в throwable (`packages/fansly/src/adapter.ts:2048–2151`); `http-request.ts:117–150` делает emit/throw без общего cooldown. `http-request-scope.ts:1–61` хранит только abort signal; executor отменяет его при lease-loss (`executor.ts:632–655`). Rate waiter резервирует обычный spacing (`rate-limiter.ts:50–66`), telemetry пишет counters/attempts/logs (`observability.ts:732–838`), daily observer считает `started` (`fansly-lane.ts:202–220`). Эти участки не регистрируют Retry-After. При живой lease и ближайшем обычном слоте до deadline следующий fetch разрешён. Сохранён [production trace](production-http-trace.txt).

**Изменение.** Минимальное containment: повторно бросать terminal 429 до item-failure write; существующий executor уже вычисляет `max(provider deadline, ordinary backoff)` (`executor.ts:414–427`). Текущий chunk прекратится, item не уйдёт на сутки как сломанный. Этого недостаточно для общей защиты: другой due stream ещё может запуститься. Корневой вариант — durable absolute cooldown в общем admission, привязанный к подтверждённой области provider limit. Минимально здесь видна одна page/session и endpoint family `/it/moie/statsnew`; распространять запрет на весь proxy или все аккаунты без доказанного scope нельзя. Deadline сохраняется до возврата отказа; очередь освобождает worker до нужного времени. Scope расширяется только по evidence/политике, никакого выдуманного глобального лимита.

**Экономика и ограничения.** При пяти due media и 429 на первом вызове — 5 → 1 попыток внутри chunk, четыре отказа предотвращены. Повторные chunks могут умножать расход, но их число/activation не измерены. Root cooldown и rethrow — одна оптимизация, экономии не складываются. 404 конкретного media остаётся изолированным; generic 5xx сам по себе не доказывает общий отказ. Размер: S для containment, M для durable scoped admission.

**Проверки/canary.** 429 delta/date-header, restart, две lanes одной page, независимая page, истёкший deadline, lease-loss, ручная пауза. Метрики: HTTP starts до сохранённого deadline, swallowed 429, item deferrals, calls/полезный refresh. Capture уже полученного успешного ответа не отменять.

## FH07-2. Частичный трёхоконный refresh каждый раз начинается заново

**Путь и включение.** В том же разрешённом lane `longTailWindowMode=split_31` означает три окна по 31 дню (`fansly-media-stats.ts:1450–1489`), когда 90-дневный запрос не принят. `runSteady` начинает с первого окна при каждом вызове (`:1153–1187`). Если бюджет закончился после двух окон, `steadyComplete=false`, при законченном backfill visit не записывается (`:984–996`), хотя оба ответа уже journaled. Сохраняется только backfill cursor, не steady progress.

**Доказательство и экономика.** Реальный handler, три due long-tail media, backfill закончен, budget=5: `A,A,A,B,B / B,B,B,C,C / C,C,C`. Получены 13 calls и три complete visits вместо необходимых девяти, четыре окна повторены. При N одинаковых media до полного завершения: `3N+2(N−1)=5N−2` обращений; после resume — `3N`. Предел экономии 40% для этой смеси; это не 40% всего Hub. Фиксированное `now` в probe показывает точные дубли; в работе границы сдвигаются на длительность dispatch. Пустая очередь, `ninety` и однооконные tiers такого выигрыша не дают. При 300 calls/day только на этот режим условная ёмкость растёт примерно 60 → 100 complete visits/day без повышения requests/sec.

**Алгоритм.** В operational `subject_refresh_state` хранить steady generation: frozen `refreshAsOf`, exact query windows/period, plan version, completed-window bits и raw receipt IDs. После journal commit атомарно под lease фиксировать окно; следующий chunk продолжает первое отсутствующее. `last_visited_at`, clear-dirty и full freshness обновлять только после всех трёх окон. После падения восстанавливать bits из receipt, не HTTP. Новый tier/plan, erasure generation или ручной reset инвалидирует выполнение, но не удаляет captures. UTC rollover обнуляет только daily attempts, не окна. Просроченный refresh сохраняет evidence и отдельный fresh catch-up по существующей cadence; не выдавать старую generation за сегодняшнюю.

Размер M. Альтернатива S — не начинать три окна при capacity<3: убирает повторы, но оставляет два слота каждого chunk и не защищает от wall-clock/retry interruption. Canary: calls/completed visit по window-mode, возраст partial generations; проверки после каждого window commit, смена суток/tier, dirty во время refresh, retries и crash. Целевое число успешных window reads — 3, не ложный complete после 2.

## FH07-3. Batch восстановления исключённых DM partners

**Путь.** В `dm_conversations` прежний `partner_unresolvable_from_account_lookup` вызывает отдельный probe для каждого partner при наличии chunk capacity (`fansly-dm-conversations.ts:783–807`). Probe всегда отправляет singleton `/account?ids=…` и journal (`fansly-account-probe.ts:15–50`). Адаптер уже поддерживает до 100 IDs (`packages/fansly/src/adapter.ts:733–755`). Пять попыток на chunk заданы `chunk-budget.ts:9–11`.

После одного list-call остаются максимум четыре singleton probes; список содержит до 100 conversations (`fansly-dm-conversations.ts:424–429`). Без иных repair/retry первые четыре устойчиво исключённых partner могут снова занимать всю проверку той же list-page. Поздние сохраняют exclusion без попытки восстановления. Probe исполнил настоящую singleton-функцию: четыре calls/четыре captures. Полный list-handler с DB не запускался; позиционная проблема подтверждена порядком цикла и budget checks.

**Алгоритм.** Два прохода по уже полученной странице: определить candidates, включая group-resolution результаты; dedup по partner ID; один `/account` batch ≤100, journal до применения; затем прежние conversation writes. Только явно возвращённый запрошенный ID означает `resolved` и разрешает clear-exclusion. Отсутствующий ID в непустом batch — `unknown`, не доказательство удаления. Ошибка batch сохраняет exclusions; partial/malformed не порождает ложных разрешений. Новые exclusion после DM 5xx оставляют прежний singleton confirmation path. Embedded aggregation не подменяет свежий `/account`.

При четырёх eligible partners 4 → 1 lookup (75%), вместе с list 5 → 2; до 100 candidates проверяются за тот же один batch. Если candidate один, экономии нет. Условная экономия трёх pacing slots при 2.6s — 7.8s; реальные RTT/доли exclusions не измерены. Размер S/M. Тесты: duplicate partners, absent/partial IDs, budget после group repairs, capture failure, auth/retry и erasure fence. Метрики: probes/candidate, восстановленные exclusions, возраст непроверенных partners по позиции.

## Отклонённое и воспроизводимость

- Catalog hydration: реальный handler трижды запросил те же 100 IDs после `raw=[]`, IDs 101–102 не дошли. Очередь `not exists creator_media` (`packages/db/src/repositories/fansly-catalog.ts:781–807`) не различает неотправленное, captured-but-unprojected и missing. Однако source прямо предупреждает: текущие live vault rows несут raw media IDs, а нужны optional offer IDs. Оставлено условным хвостом; в основные выигрыши не включено. Возможный repair — operational receipts, exact requested IDs, bounded retry/fairness; не «отметить missing навсегда».
- Proxy dispatcher pooling уже существует; follower aggregation уже используется; длинный Retry-After внутри одного adapter request и lease cancellation уже в production. Не заявлены как новые. ETag/WS/bigger page caps не предполагаются; F1/F3/F4/F5 прошлого аудита не повторяются.
- Все три изменения сохраняют capture-first, ordering/idempotency, erasure/lease fences, backoff, cadence, ручные gates и money units. Экономию измерять по физическим attempts при одинаковых gates/workload; между условными сценариями проценты не складывать.

Повтор: `node investigations/sync-optimization-swarm-2026-09-13/07-fansly-http/probe.mjs`. [Результаты](probe-results.json). Настоящие TS функции транспилированы установленным TypeScript, внешний I/O подменён; нет provider/SSH/SQL/Vitest/install, нет нагрузочного или latency benchmark. Контейнерные revision IDs взяты из `production-revision.txt`, код сверён Git. Требуется canary на общей release-базе.

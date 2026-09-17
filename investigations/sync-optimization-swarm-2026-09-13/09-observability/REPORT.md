# 09 — Стоимость наблюдения синхронизации

Две новые возможности: **заменить полный historical scan physical-health точными диапазонами** и **убрать второй независимый event reader внутри worker**. Обе существуют в `main=b48f173d93e3` и production `74aac5093cfc`; production взят из переданного root файла `production-revision.txt`, повторно прочитан перед завершением. Экономия ниже относится к конкретным чтениям, не к CPU всего Hub.

## OBS-09-01 · P2 · Physical-health: последний успех + нужные диапазоны

**Активный путь.** [health.ts:194](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/health.ts:194) → [sync-status.ts:1563](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync-status.ts:1563) → `listSyncMonitorStreamRows`. Его же вызывает [sync-monitor.ts:914](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync-monitor.ts:914). Dashboard overview запрашивает этот monitor только для `dm_messages`, page detail — для потоков страницы ([sync-blocks.ts:329–365](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync-blocks.ts:329)). Hooks имеют период 10 секунд ([adminSync.ts:59](/Users/dmitriy/code/goose/hub/apps/dashboard/src/api/adminSync.ts:59)); это не доказательство постоянной открытой вкладки. Запрос работает с переданными разрешёнными страницами и потоками.

**Повторная работа.** [sync.ts:2333–2385](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/sync.ts:2333) читает **все сохранённые attempts**, вычисляет `max(started_at) FILTER (WHERE state='success') OVER (PARTITION BY page_id,stream)`, затем агрегирует каждую строку. Итог содержит только: количество попыток/успехов за окно, последний успех, число неуспехов после него и stale-started после него. Уже существующий [recent_attempt_counts:2318](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/sync.ts:2318) отдельно читает последнее окно. Physical-блок побайтно одинаков в двух ревизиях — проверяет probe.

**Изменение.** Для каждого фактического `(page,stream)`:

1. Найти последний `state='success'` через `ORDER BY started_at DESC LIMIT 1`.
2. Два счётчика за окно добавить в существующий `recent_attempt_counts`.
3. Для `retry`, `failed`, `started` сосчитать только suffix после найденного успеха; у `started` дополнительно `started_at <= now-2min`. Когда успеха нет, явно читать всю нужную историю: старый долг остаётся видимым.

Все CTE остаются в одном SQL snapshot. Предлагается один индекс `(page_id,stream,state,started_at DESC)`; существующие индексы начинаются с `sync_run_id` либо только `started_at` ([schema.ts:592](/Users/dmitriy/code/goose/hub/packages/db/src/schema.ts:592)). [SQL-эскиз](proposed-physical-health.sql) разделяет NULL/non-NULL success на ветви, чтобы nullable-OR не мешал обычному range seek.

**Модель.** Пусть `H` — вся retained history для scope, `R` — строки окна, `D` — нужный failure suffix, `S` — число page/stream. Сегодня candidate reads ≈ `H+R`, плюс оконная обработка `H`; после ≈ `R+D`, `S` success probes и `3S` suffix ranges. В условном corpus `H=300000`, `R=10000`, `D=100`, `S=100`: **310000 → 10100 candidate rows**, отдельно 400 index operations. Это модель, не PostgreSQL EXPLAIN и не обещание ускорить весь запрос в 30 раз: другие CTE остаются.

**Доказательство.** [probe-results.json](probe-results.json): 2013 сравнений эквивалентного вычисления. Проверены отсутствие успеха, успех старше окна, одинаковые timestamps, точная граница 120 секунд, часы без новых записей, future timestamps и поздний `started→success`, сохраняющий исходный `started_at`. Это semantic oracle по фактическим SQL-предикатам, не исполнение PostgreSQL.

**Границы.** Кэша нет: late update, prune, erasure и течение времени видны следующему statement; `>` после успеха и `>=` начала окна остаются прежними. Не заменять `started_at` на `finished_at`. При никогда не успешном потоке `D≈H` — экономии почти нет, что необходимо для точного долга. Индекс увеличит WAL и может убрать HOT на terminal update: rollout имеет смысл после сравнения saved read buffers с WAL/attempt. Размер **M**: одна query-переделка, forward migration, интеграционные проверки. Canary: одинаковые old/new поля на одном snapshot; buffers/read, query p95, WAL/attempt, старейший долг; отдельные прогоны с concurrent settle/prune/erasure и пустым ACL scope.

## OBS-09-02 · P2 · Один worker event reader для smoke и workboard

**Активный путь.** [worker-services.ts:558–560](/Users/dmitriy/code/goose/hub/apps/runtime/src/worker-services.ts:558) безусловно стартует smoke и workboard. Они независимо вызывают `createDomainEventHub`: [domain-events-smoke.ts:77](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/domain-events-smoke.ts:77), [workboard-event-recompute.ts:47](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/workboard-event-recompute.ts:47). Эти callers одинаковы в main/prod. API создаёт ещё один process-local hub при SSE ([events/index.ts:613](/Users/dmitriy/code/goose/hub/apps/runtime/src/modules/events/index.ts:613)).

Каждый hub держит собственный LISTEN, baseline и watermarks, повторно читает head и страницы ledger ([domain-events-stream.ts:203–265](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/domain-events-stream.ts:203)). `listEventsSince` выбирает `de.data` и остальные поля каждого события ([domain-events.ts:967](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/domain-events.ts:967)). Фильтрация workboard происходит уже после чтения. Это удвоение SQL, переданных строк и JSON hydration внутри одного worker.

**Изменение.** Создать hub в worker composition root, передать его обоим сервисам, закрывать один раз владельцем после их остановки. Каждый сервис по-прежнему имеет собственный unsubscribe; smoke сохраняет независимые seq guards, cursor, gap/duplicate counters, persisted checkpoint и свой replay при старте. Подписать и буферизовать live до capture replay boundary, как сейчас. Не объединять API и worker через новый сетевой сервис; API ACL и re-auth остаются в своём процессе.

**Доказательство.** Probe транспилирует настоящие `createDomainEventHub` и `validateGaplessReplayBatch` обеих ревизий, подменяя только ledger/pool/logger. Четыре аккаунта × 601 событие, два подписчика:

| Работа live drain | Два hub | Один hub |
|---|---:|---:|
| LISTEN / baseline reads | 2 / 2 | 1 / 1 |
| head / batch reads | 8 / 16 | 4 / 8 |
| возвращённые строки | 4808 | 2404 |
| модель сериализованных row JSON, байт | 10302680 | 5151340 |

Каждый подписчик получил 2404 события; искусственный разрыв на новом аккаунте вызвал по одному continuity callback у обоих. Байт-модель использует synthetic 2KiB `data`, **не** измеряет wire, CAS compression или размер raw capture. Startup smoke replay остаётся и не включён в экономию.

При `W` workers и `A` активных API hubs число совпадающих live readers меняется `2W+A → W+A`. Для одного worker с активным API это `3→2`; для worker-части — вдвое. Реальный выигрыш зависит от трафика/перекрытия drain batches. Размер **S–M**: ownership/lifecycle injection без миграции. Проверки: restart со старым checkpoint, события между subscribe/replay, reconnect, новый аккаунт, projection checkpoints, continuity loss, exception одного subscriber, порядок остановки. Canary: SQL/ledger-row, pool LISTEN connections, smoke counters и возраст checkpoint, workboard enqueue latency.

**Риски.** Общий reader создаёт общий failure domain для двух consumers; callbacks нельзя делать блокирующими. Самостоятельная worker smoke-копия никогда не проверяла настоящий HTTP/SSE transport. Нельзя компенсировать отсутствие событий обновлением checkpoint «для зелёного»: свежесть остаётся честной. Multi-worker singleton checkpoint и global-reader HOL этим изменением не исправляются; последнее отдельно у agent11.

## Сохранение гарантий, отклонённое и воспроизводимость

Обе идеи оставляют capture-first, durable history, account ordering, dedup, erasure fences, leases, cursor completeness, money units, provider backoff и ручные паузы без изменения. Нет нового кэша, подавления ошибок или передачи restricted/log payload наружу. Никаких выводов о CAS bytes из размера `ai_generation_content`.

**Не включено в новые savings:** production уже исправляет golden projection lag, expensive SSE head bounds, recent metric series, running-run activity и раннюю hydration completed-run payload; повторять эти работы нельзя. `ai_content_rows` minutely full count существует, но переносить cadence/вводить точный счётчик без проверки restricted CAS accounting и write economics не предлагаю. Успешные per-attempt stdout traces уже подавляются; удалять durable attempts или заменять failed-probe значение старым зелёным sample нельзя. Не предлагается сокращать history proof или произвольно замедлять мониторинг.

Воспроизведение: `node investigations/sync-optimization-swarm-2026-09-13/09-observability/probe.mjs`. Source/product не менялись; production SSH/SQL/provider, Vitest, Testcontainers и установки не выполнялись. Остались обязательными реальный EXPLAIN/WAL на согласованной ревизии и проверка полного service lifecycle.

# Hub: сквозной путь факта до пользовательского результата

**Три вывода:** общий SSE-reader переносит backlog одной страницы в задержку другой; компенсация отставания архива делает стоимость AI-запроса зависимой от всей истории разговора; AI подписывает сумму последних 500 транзакций как all-time. Первый — новый риск runtime latency, второй — условная оптимизация serving, третий — дополнительная ошибка корректности, **не экономия sync**.

Исследовано `main@b48f173d93e3693550e2db139de3b11107d44ce2` и `production@74aac5093cfc` из общего `production-revision.txt`. Все три механизма присутствуют в обоих исходниках. Код production взят через `git show`; текущие флаги и частота запросов не измерялись. Различие ревизий существенно: дорогой head lookup SSE в production уже исправлен, эта экономия ниже не посчитана.

## Краткая карта системы

Потребность пользователя: увидеть актуальный разговор, правильно оценить фана/деньги, получить релевантный ответ AI и выполнить платформенное действие один раз. Один захваченный факт проходит разные пути и не становится одновременно готовым для всех этих задач.

| Слой и владелец состояния | Реальный путь и граница |
|---|---|
| Клиент → API | Desktop/extension/dashboard используют контракт и page ACL. AI проверяет доступ **до** контекстных чтений: `apps/runtime/src/modules/ai/features/index.ts:251–264`. API, worker, scheduler — разные роли одного приложения: `startup.ts:44–82`. |
| Scheduler → sync executor | Scheduler владеет cron/leadership; `page_sync_states`, leases и checkpoint владеют исполнением. Planner сводит runnable work по странице: `services/sync/planner.ts:87–105`; API enqueue не является доказательством capture. |
| Платформа → durable receipt | Fansly pull сначала сохраняет raw (`services/sync/transactions.ts:1223–1228`). OFAPI webhook capture предшествует job enqueue/ACK (`services/ofapi-webhooks.ts:188–219`). У OFAPI также есть read/capture и command-outbox пути; неопределённый send нельзя автоматически повторять. |
| Receipt → оперативные таблицы → canonical | OFAPI после settle последовательно обновляет cold/hot DM, subscription/presence/spend и другие оперативные состояния, затем канонизирует точную observation: `services/ofapi-events.ts:105–132`. Для остальных/ремонта работает sweep. `domain_event_seq` сериализует append **по аккаунту**, не глобально: `packages/db/src/repositories/domain-events.ts:195,296,466`. |
| Events → projections / SSE | Это независимые потребители. Архив идёт через minutely sweep и watermark (`services/projections/message-archive.ts:42–46,69–110`); общий registry даёт бюджет **между** проекторами (`worker-services.ts:453–472`). SSE читает событие уже после canonical append, не дожидаясь готовности всех проекций. |
| Serving → AI gateway | Kernel transcript собирается из archive или fresh union; Fansly может передать clientContext (`modules/ai/features/index.ts:348–417`). Денежный и subscription-контексты читаются отдельно: `:418–438`. Gateway владеет квотами, учётом micro-USD, restricted prompt capture; это не тот же денежный ledger, где суммы в mills. |
| Observability / recovery | Runtime heartbeats, golden signals, sync status и постоянный v2 smoke наблюдают разные границы (`worker-services.ts:558`, `services/golden-signals.ts:241`). Replay чинит производные данные; operational cursors/coverage не очищаются rebuild (`services/projections/registry.ts:373–409`). Detached history запрещает неполный rebuild (`:429–456`); message_archive требует shadow rebuild, а не truncate. |

Пути выше указаны относительно `apps/runtime/src/`, кроме явно полных путей. Это карта исполнения, не утверждение текущих production-флагов. Старый OnlyFans `dm_messages` crawler исключён независимо от polling flag (`services/sync/onlyfans-dm-polling.ts:16,47–49`); новые Fansly lanes и optional OFAPI/AI возможности нельзя объявлять включёнными по наличию исходника.

**Системная связь:** долговременное сохранение увеличивает replay и историю; replay создаёт свежие account_seq; общий consumer тратит время на эти seq; лаг проекции заставляет serving обращаться сразу к нескольким копиям; стоимость такого чтения снова растёт с сохранённой историей. Capture/ordering сами по себе нужны. Глобальный drain одной страницы до конца и повторное объединение всей истории при каждом AI-запросе этими гарантиями не требуются.

## E11-1 — P2: общий SSE удерживает чужую страницу до конца backlog

**Caller/активация:** `/events` v2 создаёт hub (`modules/events/index.ts:613,738`); worker безусловно создаёт отдельный hub для smoke (`worker-services.ts:558`, `services/domain-events-smoke.ts:76–77`). Внутри hub один dirty account читается по 500 событий до captured `throughSeq`, затем начинается следующий. Main: `services/domain-events-stream.ts:203–266`; production: тот же путь `:203–270`. Фильтрация projection-only и ACL подписчика происходит **после чтения** (`:129–146`).

**Доказано actual-function harness:** подписчик видит только B; после baseline в A появляются 9 999 projection-only событий и checkpoint, в B — одно новое сообщение. Реальная функция обеих ревизий выполняет **20 чтений A / 10 000 строк до первого чтения B**. См. `probe-results.json`. Это не синтетическая копия алгоритма; заменены только зависимости/I/O. Production latency не измерена.

**Цена:** задержка B из-за A — примерно `ceil(backlogA/500) × t_batchA + head lookup`. При условных 10 ms на batch пример добавляет 200 ms, миллион строк — 20 s. Эти миллисекунды — модель. Нагрузка возникает даже когда пользователь не подписан на A. Исправленный production `getAccountHighWater` уменьшает стоимость head, но не число последовательных batch.

**Минимальное улучшение:** закончить квант после одного batch или небольшого time budget; сохранить безопасный `afterSeq` и captured boundary в per-account drain state, вернуть недочитанную страницу в хвост. Бюджетировать ошибки/повторный head read отдельно, чтобы одна ошибающаяся страница не задерживала соседние. Переподключение LISTEN продолжает durable catch-up; reconnect не является потерей уведомления, потому что уведомление только будит.

**Сохранить:** account ordering, validation непрерывности, snapshot recovery при erasure/detach, checkpoint hiddenCount и monotonic cursor. Не пропускать hidden range без его доказательства. Первая правка снижает cross-page latency; **экономия total event reads у неё нулевая**. Размер S–M. Приёмка: два аккаунта, постоянный backfill A, редкие B, обрыв LISTEN, gap, tombstone; p95 append→B-delivery, максимальный возраст dirty account, duplicates/gaps должны оставаться нулевыми. При отсутствии backlog эффект мал; больше смен аккаунта может увеличить head lookup overhead.

## E11-2 — P2 conditional: свежий AI-контекст оплачивает всю историю на каждом запросе

**Активность:** только kernel-context OnlyFans при `aiTranscriptFreshUnionMode=shadow|serve`; default `off` (`packages/shared/src/config.ts:280`). Production-значение неизвестно. Не распространять оценку на Fansly clientContext.

**Причина:** `packages/db/src/repositories/ai-transcript-union.ts:61–163` читает archive/dm arms без входного cap, строит refs, cross-tombstones, DISTINCT и hot upgrade; LIMIT ≤1500 стоит только в конце. Это правильная семантика дедупликации, но ограничен **ответ**, а не обработанная история. Дополнительно `modules/ai/context/index.ts:105–133` сперва ждёт отдельный archive-read даже в serve, после чего union снова читает archive. Actual-function probe: ошибка первого archive-read завершает loader; union не вызывается. Это зависимость двух последовательных чтений, не независимый резервный канал.

**Цена:** для G генераций разговоров с Hₐ archive / H_d dm / H_h hot rows входная работа растёт с `G × (Hₐ+H_d+H_h)`, плюс дедуп/sort и point lookups; возвращается лишь L≤1500. При Hₐ=H_d=100k, L=100 объём кандидатов 2000× больше ответа — **не утверждение 2000× ускорения**. SQL plan/buffers/TOAST здесь не измерены. Холодная история и retention усиливают пользовательский first-token latency, а не только фоновый sync.

**Минимальный путь:** сначала убрать обязательное второе чтение в serve: union — основной результат, archive — условный fallback; comparison manifest либо получать той же SQL snapshot, либо оставлять в shadow. Изменение полноты manifest должно быть явно согласовано с его контрактом, не тихо удалено.

Затем прототип bounded merge: keyset-чтение порций обоих источников по **точно текущему** time/numeric/lexical order; для каждого candidate ref получить counterpart/tombstone/hot state точечным запросом, применить тот же source preference. Продолжать до L живых winners и доказанного порога: ни один ещё не прочитанный source key не выше последнего winner. Поздняя fresh-копия может менять время, поэтому простой LIMIT L в каждом arm некорректен. Весь проход — одна согласованная snapshot с прежними erasure fences. Типичная работа O(L+дубли+удалённые кандидаты); worst case остаётся O(H).

Размер M; новый индекс допустим только если EXPLAIN показывает, что точный comparator без него не поддерживает keyset. Oracle — текущая SQL. Приёмка: равные timestamps, numeric/text IDs, global tombstone без conversation, stubs, DM-preference с другим временем, PPV upgrade, concurrent correction/erasure. Сравнить top-L и manifest, затем bounded scale 1k/10k/100k history, p95 context ms и rows/buffers. Если mode=off или беседы короткие, сначала выбрать другую оптимизацию. Этот пункт новый относительно baseline, а не повод ускорять/provider-расширять capture.

## E11-3 — P1 correctness: полная локальная история превращается в неполную all-time сумму

**Путь:** `modules/ai/features/index.ts:418–423` вызывает `loadSpendingContext` для kernel-context features с `includesEarnings`; `modules/ai/context/index.ts:195–223` выбирает последние 500 active transactions, суммирует их gross. Неизменённый formatter печатает **“Total gross (all-time)” / “Type breakdown (all-time)”** (`modules/ai/prompts/context/spending.ts:155–175`). Эти файлы одинаковы в обеих ревизиях. Flags fresh union здесь не требуются; Fansly clientContext обходит этот loader.

**Actual-function контрпример:** сохранены 501 tip: старый $10 000 и 500 новых по $1. Loader + настоящий formatter выдают `$500.00 all-time`, хотя сохранено $10 500. Ошибка зависит от пропущенных исторических сумм и не ограничена 1/501. Полнота capture при этом может быть идеальной; ни sync-health, ни ускорение канонизации её не исправят.

**Минимальное исправление:** named lifetime-gross aggregate по тому же `(page, fan)`, `is_active` и явно согласованной классификации canonical types; суммирование exact mills в SQL/BigInt и одно преобразование для formatter. Сначала точный uncapped GROUP BY, затем при оправданной частоте — материализация с idempotent correction/reclassification/retraction и scoped rebuild. Базовый GROUP BY может **увеличить DB CPU относительно нынешнего LIMIT 500**: это исправление достоверности, не доказанная экономия.

Нельзя просто подставить page_fans LTV или `fan_spend_lifetime`: у существующего spender rollup собственный фильтр типов (`packages/db/src/repositories/spenders.ts:51,94–100`), gross/net/refund semantics должны совпасть. Полнота ledger относительно провайдера остаётся отдельным coverage-фактом. Prompt unit frozen: изменение семантики/формата проходит явный manifest/parity review; рост итоговой суммы сам по себе не требует произвольной правки шаблона.

Размер S для точной агрегации, M для reusable aggregate. Приёмка: 499/500/501+ transactions, крупная старая сумма, negative adjustment, superseded/inactive, category breakdown, fan/page изоляция, mills exactness и captured-history coverage. Никаких автоматических provider-запросов для исправления этого пути не нужно. **Не включать в sync savings.**

## Отвергнуто и ограничения

- Удалить одну из DM-копий сейчас: роли различаются; архив содержит legacy seeds, correction lineage, tombstone/erasure поведение. Сначала доказать равенство serving/rebuild и ownership всех полей.
- Просто распараллелить всё/добавить worker: не устраняет общий durable-state bottleneck и ослабляет проверенность concurrency/egress. Межаккаунтный quantum решает более узкую задачу.
- Уменьшить retention или назвать зелёный health полнотой: противоречит назначению capture и не исправляет consumer semantics.
- Не пересчитывал чужие девять отчётов; общие projection/canonical/queue оптимизации остаются за профильными агентами.

Проба: `node investigations/sync-optimization-swarm-2026-09-13/11-system-end-to-end/probe.mjs`. Она читает pinned source из Git, транспилирует реальные функции установленным TypeScript и подменяет I/O. Никаких Vitest/Testcontainers, установки, production SQL/SSH/provider вызовов или source edits. DB plans, реальный mix клиентов/flags, platform completeness и пользовательские SLO не измерены; от них зависит приоритет и величина выигрыша. Соседние client repos подробно не исследованы, поэтому конкретный клиентский UX-симптом требует отдельного trace. Отчёт покрывает сквозные зависимости, а не объявляет каждую ветку всей системы проверенной.

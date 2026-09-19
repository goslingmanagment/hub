# 13. Sync как исполнение обязательств данных

13.09.2026. Исследование, без реализации. Main `b48f173d93e3693550e2db139de3b11107d44ce2`; production по общему снимку `74aac5093cfc`. Сверка 13 ключевых диапазонов с production дала совпадение, местами со сдвигом строк: [source-parity.json](source-parity.json). Активность конкретных gates и распределение production-нагрузки здесь не измерялись.

**Две серьёзные альтернативы:** A — заменить управление периодическими процедурами управлением конкретными незакрытыми требованиями к данным; B — сделать архив главным хранилищем исполнения, а Postgres оставить компактным serving/control. Для одной агентской команды выбираю **ограниченный эксперимент A, P2**. B, P3, оставляю условным направлением при доказанном доминировании стоимости хранения истории. Немедленную полную перестройку не рекомендую.

## A. Исполнять требования, а не запускать stream

Сегодня `planner → scheduleDuePageSync → page executor` управляет строками stream; зависимость удовлетворена, если предшественник когда-либо имел `succeededAt` или `appliedSeq>0`. Политика задаёт отдельные периоды: transactions 3600 секунд, DM discovery 1800, DM history 86400. Это удобная оркестрация процедур, но она не описывает, **какой именно материал или какое доказательство осталось получить**. Источник: [planner:49](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/planner.ts:49), [policy:175](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/page-sync.ts:175), [dependency:1713](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/page-sync.ts:1713). Сам по себе этот факт не означает ошибку зависимостей.

Предлагаемая единица работы:

`requirement(page, subject, predicate, boundary, deadline, authority, revision)`

Например: «сохранено сообщение H», «история стыкуется с доказанной границей A», «summary применил материал до M», «проверена текущая голова в этом scheduled slot». Их нельзя свести к одному `complete`. Строка evidence хранит источник/receipt, версию контракта и parser, тип доказательства, material watermark и erasure epoch. `observed item`, `verified traversal` и `freshness observation` — разные свидетельства.

Планировщик сопоставляет требования с доступными свидетельствами и выбирает недостающий шаг:

1. Есть raw, нет интерпретации — локальный parse/replay.
2. Есть интерпретация, отстаёт serving — штатный materializer/repair.
3. Нет нужного материала — ограниченный provider read через прежний executor.
4. Нет достижимого доказательства полноты — явный `unproven/unsupported`, а не бесконечный проход или ложный успех.

Один receipt может закрыть несколько **совместимых** требований; потребители ссылаются на него. Новое свидетельство переоценивает связанные требования, а не весь исторический граф. Разница с обычной dirty queue: dirty queue выбирает, **когда повторить обработчик**; здесь сначала определяется, **нужен ли вообще upstream, и что именно считается выполненным**. Начать следует с трёх фиксированных типов выше, без DSL и универсального оптимизатора запросов.

**Это частично уже построено.** OFAPI `awaiting_parse` обрабатывается локально, после capture оплаченный запрос не повторяется; anchor принимается только с composable proof: [jobs:1217](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-capture-jobs.ts:1217), [jobs:1545](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-capture-jobs.ts:1545), [jobs:1055](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-capture-jobs.ts:1055). Agent hydration уже принимает bounded demand, сравнивает target/caps и переиспользует готовый OFAPI job: [hydration:762](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/agent-hydration.ts:762). Эти savings **равны нулю в новой оценке**. Новизна — общий критерий исполнения для остальных acquisition/repair путей вместо набора отдельных рецептов и coarse stream dependencies. Baseline F3/F4 мотивирует проверку свидетельств, но их исправления не записываются в экономию A.

Первый практический срез — существующие Fansly DM regular/targeted/summary пути, где targeted job уже пользуется реальным page lease: [targeted:3](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/targeted-thread-backfill.ts:3). Shadow только классифицирует следующий нужный шаг; он не создаёт второй dispatch authority. Если raw нельзя безопасно воспроизвести текущим writer, требование остаётся незакрытым: универсальная rebuildability пока отсутствует.

### Discovery остаётся обязательством сохранности

Чистое «качать только по запросу пользователя» отвергается: невостребованный сегодня факт может исчезнуть до первого запроса. Нельзя экономить, перестав собирать обязательный архив. Текущие discovery/reconciliation slots становятся независимыми требованиями с прежними сроками; сигнал только ускоряет проверку. Молчание WS/webhook не закрывает requirement. Историческое покрытие не доказывает свежесть; новый head не доказывает старые edits/deletes. Для неустойчивого paging count/overlap сами по себе не сертификат. Если endpoint не позволяет доказать непрерывность, система честно оставляет её неизвестной.

Публичные гарантии Fansly sequence/replay/snapshot здесь не установлены и архитектуре A не нужны. Существующий OFAPI cursor contract не переносится на Fansly. Provider capabilities описываются конкретным adapter-контрактом; смена семантики инвалидирует связанное доказательство, сохраняя raw.

## B. Архив исполняемых сегментов + компактный serving

Другой подход: каждый входящий ответ сначала становится устойчивой записью в append-only сегменте на том же VPS; локальный manifest связывает байты, account и receipt. Postgres держит каталог, текущие требования, account sequence, денежные и оперативные проекции. Исторический replay читает сегменты последовательно; холодные выборки получают отдельный путь чтения. Это меняет физическую authority и стоимость поступающего факта, даже если HTTP остаётся прежним.

Транзакционная граница: сначала durable segment record и checksum, затем DB envelope/receipt; только после этого ACK/checkpoint. Сбой между шагами оставляет архивный orphan для повторной регистрации. Он не разрешает подтвердить незафиксированный факт. Нужны устойчивый идентификатор receipt, fsync/group-commit, восстановление открытого сегмента, fencing erasure и зарегистрированный читатель всех tiers.

**Почему не сейчас:** G5 уже устраняет повторные body-копии через scoped CAS; нельзя заново считать весь dedup выигрыш. Архив нельзя смешивать между `ordinary_capture`, `restricted_ai` и erasure domains: [scope:46](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/capture-payloads.ts:46). Текущий tiering прямо предупреждает о ложных capture floors и replay failure после detach: [tiering:599](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/tiering/index.ts:599). `message_archive` содержит legacy seed и не восстанавливается обычным in-place replay: [registry:99](/Users/dmitriy/code/goose/hub/apps/runtime/src/services/projections/registry.ts:99). Поэтому «переложить таблицы в Parquet» недостаточно.

B сохраняет уже принятый один VPS и решение #161 без off-box backup; она не добавляет устойчивость к потере VPS. Холодные чтения и erasure дорожают: для удаления субъекта нужен physical rewrite затронутых сегментов с проверенной заменой, не вечный tombstone поверх доступных байтов. Даже после выноса bodies каталог/receipts продолжают расти. Для одной команды новый собственный storage engine может стоить больше всех сэкономленных ресурсов.

## Сравнение и порог окупаемости

| | A: требования/свидетельства | B: архив сегментов |
|---|---|---|
| Что дешевеет | Повторное acquisition/repair, если нужная часть уже выполнена | Запись/чтение исторических bodies, если DB amplification доминирует |
| Что остаётся | Обязательный discovery, capture всех фактов, canonical append | Все provider calls, custody/ledger, каталог фактов |
| Что дорожает | Индекс evidence, revocation, объяснение незакрытых требований | Crash recovery, холодное serving, erasure, эксплуатация |
| Где проигрывает | Почти каждый запуск получает необходимые новые данные | История редко читается, а нагрузку создают текущие UPDATE/HTTP |

Для A пусть `D` — обязательные физические HTTP attempts за окно, `X` — прочие нынешние attempts, `U` — оставшиеся после повторного использования, `R` — дополнительные проверки. Тогда `Q₀=D+X`, `Q₁=D+U+R`; экономия есть только при `X>U+R`, её верхний предел `X/(D+X)`. Retries/hydration также входят в attempts; observation count их не заменяет. При **условных** D=9000, X=1000, U=100, R=100 сокращение дополнительной работы на 90% даёт лишь **8% всего HTTP**; при D=1000, X=9000, U=900, R=100 — 80%; без reuse и с R=100 — ухудшение на 1%. Это сценарии, не production измерения.

CPU, DB I/O и metadata учитываются отдельно: A полезна, когда стоимость избежанных calls/parse/materialization выше новых операций evidence. Обязательную canonicalization известных семейств и денежные проекции нельзя лениво пропускать. Сокращение пустых projection ticks само по себе относится к агенту 05, не к savings A.

Для B считать **после текущего CAS**: `B` — уникальные body bytes за окно, `a_pg/a_seg` — измеренные physical-write amplification. Условие выигрыша по записи: `B(a_pg−a_seg) > W_manifest + W_compaction + W_erasure`. Всё должно быть в physical bytes за одинаковое окно. WAL throughput, retained WAL и свободное место различаются. HTTP-выигрыш B — ноль. Нельзя обещать проценты без измерения этих членов и доли cold reads.

## Инварианты, отказы и миграция

В A сохраняются capture-before-parse/checkpoint, idempotency и существующий `appendDomainEvents` account lock: [append:283](/Users/dmitriy/code/goose/hub/packages/db/src/repositories/domain-events.ts:283). Parser revision переоткрывает только interpretation, новый head — freshness, erasure epoch — все зависимые свидетельства; A→B→A состояния не схлопываются по одному content hash. Поздний сигнал не отменяет ручную pause/revision. Очередь использует прежние leases, page egress resolver, абсолютный cooldown и лимиты физических попыток.

Совместное выполнение не складывает бюджеты и не расширяет target: требуется совместимая исходная authority; различные caps не объединяются автоматически. Read-only GET остаётся read-only. Demand создают только существующие разрешённые mutation/policy с principal. Деньги остаются BIGINT mills/micro-USD, actual/reserved credits учитываются прежним ledger. Send/upload/stateful outbox вообще не участвует в оптимизации и сохраняет one-attempt/indeterminate закон.

1. **Shadow:** после исправления baseline P1 классифицировать существующие DM receipts и решения без новых calls. Отдельно считать missing capture, parse/materialization debt, unprovable coverage. Не добавлять архивный полный scan на каждый tick.
2. **Локальный canary:** один тип requirement заменяет только уже допустимый локальный repair; прежний executor владеет egress. Проверить parity и crash после каждого commit, manual pause, lease loss, parser change, erasure. Legacy-only материал включить в corpus.
3. **Замена acquisition:** только если shadow показывает лишние физические attempts, в одной разрешённой lane включить планирование по требованиям с прежними ceilings/discovery deadlines. Затем отдельными gates расширять scope. Rollback возвращает dispatch старому пути, receipts остаются.
4. **B отдельно:** сначала shadow segment reader, byte parity, same-disk crash/erasure/restore drill, затем новый capture canary. Перенос единственной копии и переключение authority требуют отдельного owner gate; исторический rewrite не смешивать с A.

## Дешёвое опровержение и пределы

[probe.py](probe.py) проверяет source parity и 10 искусственных случаев модели: два crash gap, пропущенный сигнал, overlap без proof, erasure, pause и четыре несовместимых authority. [Результат](model-results.json): 10/10. Это **не запуск runtime handler и не benchmark**.

Следующий falsification: на уже разрешённом root корпусе сопоставить принятые requests/receipts и контрфактические решения A, не обращаться к provider. Отвергнуть A, если нет избежанных действий сверх уже работающего OFAPI reuse, метаданные съедают выигрыш, либо появляются false-complete, лишние calls или пропуски discovery. Не выдать несовпадение существующей неполной проекции за ошибку нового алгоритма: сравнивать с сохранёнными фактами и явно заданным claim.

Чистый WS/changefeed sync отвергнут без доказанных replay/scope/continuity; при прежнем reconciliation и дешёвом REST он может только добавить расходы. Не запускались production SSH/SQL, provider requests, Vitest/Testcontainers и установки. Продуктовые файлы не изменялись.

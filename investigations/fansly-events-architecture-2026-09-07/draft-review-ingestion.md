# Независимый review проекта: интеграция с Hub ingestion

Проверено 2026-09-07: `ARCHITECTURE.md`, строки 1–284 первоначального draft; Hub local `582ef1cf8a2de52eba6639ef775ddbe3e15ba74c`, relevant differences production `2475b3046332` ранее сверены. Main document не редактировался.

Вердикт: направление реализуемо и согласуется с Hub; матрица 17 streams полная, основные legacy consumers и rollback фактов учтены. До основной реализации требуется исправить два вопроса correctness/freshness и конкретизировать две точки интеграции. Полный redesign scheduler/storage не требуется.

## R1 — P1: head refresh не восстанавливает изменение старого сообщения

**Draft:** §7, строка 149; §9, строка 197. Message create/delete/change объединены в реакцию «один group-head refresh до известной boundary».

**Реальный failure:** в чате head ID1000, пришёл partial update/delete ID100. Запрос `/message?groupId&limit=25` возвращает новую голову, в которой уже есть известный ID. Существующий incremental закон останавливается на overlap (`executor-handlers.ts:4074–4078`); конкретный ID100 не прочитан. Если intent помечен выполненным после этого head capture, Hub сохраняет устаревший текст/удалённое сообщение, несмотря на полученный сигнал. Редкий group inventory тоже не обязан это обнаружить: list contract имеет `lastMessageId`, но не общий message-mutation watermark (`packages/fansly/src/types.ts:253–271`).

**Минимальная коррекция:** разделить rules по mutation kind. Message create допускает head-to-anchor. Verified delete с точным page/message scope применяет sticky tombstone, не требует чтения всей истории. Partial edit/update содержит target ID и остаётся pending до evidence именно для этого target; использовать доказанный targeted endpoint, либо bounded resumable traversal до target, либо `unresolved_mutation` при недоступном материале. Head-only receipt не закрывает старую mutation. Требуется fixture «old message changed, head unchanged», а также delete→late REST. Recovery receipt должен указывать, какие mutability claims проверены: актуальная голова не доказывает отсутствие старых edits.

## R2 — P1: свежесть без полученного frame пока регрессирует

**Draft:** §8, строка 172; §10, строки 209–210; §11, строки 232,239–240.

Receipt→reader ≤30 s измеряет только доставленные события. При одном пропущенном message frame и живом pong degraded fallback не включится до независимой сверки. Урежение единственного discovery inventory 30 min→2/6 h увеличивает окно незамеченной новой переписки, хотя цель требует сохранить свежесть. Недельная parity после теста не устраняет этот failure mode.

**Что CODE действительно позволяет:** `/messaging/groups` на одной странице выдаёт `groupId`, `lastMessageId`, `lastUnreadMessageId`, `unreadCount`, flags, tier и optional partner ID; `aggregationData.groups[].lastMessage` optional (`types.ts:244–271`). Existing handler уже сравнивает head с `newestStoredMessageId` (`executor-handlers.ts:287–310`). Поэтому возможно выделить независимый marker inventory, который сразу journals list page и создаёт адресные intents только для new/changed heads; details нужны лишь missing identity/head.

**Чего CODE/HAR здесь не доказали:** монотонный updated/sort cursor, достаточность первой страницы, coverage hidden/archived groups, или существенную экономию такого inventory. Без cursor proof safe walk остаётся полным offset traversal, `limit=100`, стоимость O(ceil(G/100)). Более того, в текущем handler group detail и head repair УЖЕ условные (`executor-handlers.ts:3113–3118,3182–3186`), поэтому отделение materialization не гарантирует большой HTTP выигрыш.

**Минимальная коррекция:** ввести per-plane `max_discovery_lag` независимо от event receipts; для DM head первоначально сохранить discovery не хуже текущей проверенной policy (например independent 15–30 min marker walk, плюс допустимый completion lag по baseline). Heavy detail/repair и полный membership certification можно разнести по частотам. До доказательства дешёвого complete discovery 2/6 h разрешать только дорогой certification, не единственное обнаружение новых heads. Gate обязан проверять silent drop при живом heartbeat и end-to-end mutation→reader. Если нужный экономический gate при этой freshness недостижим, честно не урежать discovery и не объявлять цель выполненной; пересмотреть scope/transport после данных.

## R3 — P2: per-page cadence нельзя менять через нынешние поля как обычный override

**Draft:** §8, строка 184; §11, строка 232; §12, строка 260.

Сейчас `ensurePageSyncStates` на каждом planner cycle сравнивает `cadence_seconds` с глобальным `SYNC_STREAM_POLICY[row.stream]` и безусловно возвращает global value (`packages/db/src/repositories/page-sync.ts:1590–1609`). Наивный lora-1 flip поля cadence будет перезаписан следующим циклом. Изменение самой константы затронет весь Fansly fleet и не даст описанный per-page canary/rollback.

**Минимальная коррекция:** явно включить в этап 1 effective per-page/per-plane policy resolver, используемый и seed/ensure normalization, и slot calculation, и due scheduling, и degraded fallback. Previous policy values сохраняются как отдельный audited state, не как текущее `page_sync_states.cadence_seconds`. Проверка: несколько planner cycles после canary flip, restart, disabled WS fallback и rollback сохраняют ожидаемую cadence только lora-1; другие страницы неизменны. Это небольшой обязательный scheduler diff, не готовая config capability текущего Hub.

## R4 — P2: выбрать владельца material events и использовать существующий revision contract

**Draft:** §5, строки 120; §6, строки 128,133; §12, строка 261.

Draft одновременно предлагает family registration, отдельный router и общий materializer, который пишет archive/media/tip context **и canonical append**. Для hints router transaction описан, но для full direct material не определено, какой обработчик единственный append authority, что считается completion и как он координируется с существующим canonicalization sweep. В существующем Hub canonicalizer сам append-ит mixed events + projection checkpoint, затем marks observation parsed (`canonicalize-driver.ts:504–567`), а archive reducer отдельно потребляет ledger (`projections/message-archive.ts:91–122`). Simple dual writes в новой функции могут дать два владельца merge/order/replay.

Кроме того, новое revision event не нужно изобретать с нуля: Fansly уже emits `message.material_observed` с fingerprint и `fieldPresence`, пока лишь для messages с attachments (`canonicalize/sync-pull.ts:902–985`, фильтр `:912`). Archive уже понимает этот тип (`projections/message-archive.ts:25–30`; `db/repositories/message-archive.ts:158–276`). Он не является универсально готовым решением: current material head включает `materialObservedAt` в fingerprint, ряд fields заполняется null; ordering опирается на observed/version fields. Надо проверить семантику перед reuse для произвольного sparse WS/text edit, а не просто передать объект.

**Минимальная коррекция:** назвать одну ownership chain. Например raw→версионированный canonical family (existing mixed append discipline)→единственный durable message material reducer; общие legacy hot/thread/tip reducers становятся idempotent consumers/частью этого materialization receipt. Router в одной transaction только создаёт адресные intent и route receipt, а full-material processing имеет независимый completion receipt/parsed version; routed не означает applied. Если выбрана иная chain, документ должен сказать, как existing sweep исключает конкурирующий append и как replay всегда проходит тот же reducer. До direct apply подтвердить reuse/расширение `message.material_observed` для plain text, sparse fields, stable material hash и late snapshots. Ошибки archive/media/hot после raw не должны закрывать materialization receipt.

## Что проверено и не требует новой переделки

- All 17 Fansly streams присутствуют в приложении; aggregated REST table main их не теряет. Presence отдельно сохранён как зависимый reader.
- Money остаётся REST-confirmed; txn dedup/state caveat корректен. Purchase target revisit, profile identity и shared proxy admission названы явно.
- Dirty R/R+1, generation/auth fencing, independent history checkpoints, explicit unknown gaps и retained raw заявлены правильно.
- Rollback не удаляет facts/checkpoints и предусматривает исправление уже ошибочно применённого материала; фактический downgrade compatibility test обязателен и уже есть в плане.
- Fractional fairness 60/25/15 можно оставить как canary proposal; подтверждать измеренным progress, не выдавать доли за реализованные свойства existing fixed-priority scheduler.
- Handshake/native transport переносимость остаётся gate, а не обещание. Подготовленный документ не разрешает production mutations.

Тесты runtime не запускались: review архитектуры и текущего кода, никаких runtime edits. Проверка самого markdown: файл создан отдельно, основной draft не изменён.

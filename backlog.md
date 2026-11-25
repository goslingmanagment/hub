# Backlog — подтверждённые открытые задачи

Актуализировано по `main` (2026-11-25). Закрытые и устаревшие пункты (`UV-001`–`UV-014`,
`BL-A*`, `BL-C*`, `BL-D-1`, `LINK-001`, `OA-001`–`OA-005`, OFAPI/Decision 358/PR #21 хвосты)
убраны. Здесь остаются только открытые операционные хвосты, сознательно отложенные `FEAT-*`
и политика заморозки erasure (`ER-001`).

## Операционные и координированные задачи

### INC-001 / UV-010 — Завершить remediation PPV poison-loop

- **Исправлено в коде:** новые `message.ppv_unlocked` получают правильные refs и
  fail-closed mapping (`ofapi-payloads.ts`, `canonicalize/ofapi-webhook.ts`),
  quarantine (`observation_parse_quarantine`, миграция 0209), проекции
  `message_archive` / `dm_message_archive`, минутный reconcile покупок
  (`ppv-purchase-backfill.ts`), команды backfill `archive:backfill-ppv-purchases`
  и repair `events:repair-ofapi-ppv-refs` готовы.
- **Остаток (операционный rollout, вне кодовых фиксов):** запуск исторического
  backfill и repair старых rows, read stop-loss и приёмка на флоте.
  Каноническая история инцидента — Decision #155.

### UV-015 — SSE-стрим отдаёт owner device-token'у все события без клампа

- **Сбой:** owner-принципал через device-token получает полный event-стрим
  (`apps/runtime/src/modules/events/index.ts`), но кламп сломает `of-desktop`,
  который живёт на этом поведении.
- **Ruling (owner 2026-08-01):** в Agent Read Plane не чинится; agent-ключи
  SSE не получают вовсе. Чинить отдельно, координированно с релизом
  `of-desktop`: clamp для не-session принципалов + обновление клиента.
- **Код:** `apps/runtime/src/modules/events/index.ts`, `pageScopeFor`
  (`apps/runtime/src/api/request-auth.ts`).

## BLOCKS ANY FUTURE ERASURE EXECUTION

### ER-001 — Fan erasure остаётся неполным

Реальные erasure runs запрещены принятой политикой (Decision #129), поэтому это
не блокер. Если политика изменится, сначала нужно проверить исторические W6 gaps
(`sync_raw_payloads`, `ofapi_webhook_events`, `ofapi_spend_projection_events`,
W2.1 snapshot) и следующие кандидаты:

- `threadPred` не учитывает `partner_platform_user_id`; Fansly thread с
  `fan_id=NULL` переживает erasure вместе с сообщениями
  (`apps/runtime/src/services/erasure/index.ts`,
  `apps/runtime/src/services/sync/executor-handlers.ts`).
- `fanGroupIds` снимается до transaction-level exclusive fence; concurrent
  identity resolution может оставить legacy group-only restricted generation.
- group-only restricted generation, которую нельзя связать ни по fan, ни по
  partner identity, остаётся без residual warning, а run сообщает успех.

## FEAT — не захваченные плоскости данных Fansly/OF (отложено владельцем)

Не дефекты: оставшихся ниже данных в хабе нет в виде типизированных проекций.
Общий рецепт для каждой: захват через резолвер егресса и прокси страницы →
журналирование полного ответа до парсинга → версионированный канонизатор +
реплей-тест → типизированная перестраиваемая проекция → дескриптор реестра
датасетов → честные `fieldStates` и покрытие.

### FEAT-002 — Тиры подписок как сущности

- **Нет:** таблицы тиров (`page_subscriptions` хранит имя/цвет/цену тира
  строкой на подписке).
- **Частично захвачено:** `account_me` несёт `subscriptionTiers` и `walls` в
  `pages.metadata` jsonb; нужен канонизатор и проекция, вендор не нужен.

### FEAT-003 — Выплаты (payouts) / кошелёк

- **Нет:** таблицы выплат (есть только моментальный баланс
  `pages.earnings_balance_mills` из `account_me`).
- **Требует** нового вендор-эндпоинта.

### FEAT-004 — Чарджбеки Fansly

- **Нет:** у OF чарджбеки есть (`ofapi-chargebacks-sync.ts`, миграция 0107), у
  Fansly захват возвратов отсутствует (`transactions` остаётся `posted`).
- **Смежный долг:** OF-чарджбеки не передают `endDate`.
- **Митигировано в Agent Read Plane:** money-класс отдаёт `refundState` с
  честным `not_captured` / `captured_unparsed`, блокируя ложные выводы об
  отсутствии возвратов; сам захват остаётся открытым.

### FEAT-005 — Остаток Fansly-реплея: три вида + `accountMedia`/`tips`

Сознательно отложено (R-010):

- **`account_lookup`** (`/account?ids=` — исторические профили фанов).
- **`group_detail`** (`/messaging/groups/:id` — полный состав участников треда).
- **`earnings_accounts`** (`/earnings/accounts` — денежные суммы по фанам).
- **`accountMedia` / `accountMediaBundles` / `tips` внутри `dm_messages`** —
  отдельная проекция медиа-вложений и чаевых из сохранённых страниц.
- **BL-D-2:** исторические интервалы подписок (`subscription.observed`) пока
  живут только в леджере, без отдельной проекции поверх `page_subscriptions`.
- **Историческая серия follower-тоталов (`page_identity_daily`):** полная
  посуточная серия тоталов лежит в `domain_events` (`page.identity_observed`) и
  ждёт собственной проекции.
- **Долг захвата (capture-first):** `content` у `dm_conversations` и полнота
  `followers` обрезаются до журнала (`redactFanslyMessageLike` /
  `trimFanslyFollowerPayload` в `apps/runtime/src/services/sync/shared.ts`).

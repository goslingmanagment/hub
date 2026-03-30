# Workboard — Product Spec

> Заменяет текущий CRM (Retention + Reactivation tabs).
> Версия: 30.03.2026. Источник: discovery-сессия Дмитрий + Claude.

## Проблема

Текущий CRM — аналитический дашборд с двумя табами (Retention, Reactivation), кучей фильтров и сортировок. Никто им не пользуется. Чаттеры не думают категориями "retention vs reactivation". Им нужен простой ответ: **кому писать и как срочно**.

## Решение

**Workboard** — экран проактивной работы по реактивации фанов. Чаттер (или админ) заходит на страницу модели, видит список фанов, которым нужно написать, и идёт работать.

**Workboard НЕ занимается unreads** — непрочитанные сообщения чаттер видит в интерфейсе Fansly. Workboard — это чисто проактивная работа: пинги, реактивации, retention.

## Ключевой принцип

> Каждый ценный фан должен оставаться "горяченьким". Никто не должен пропадать из виду.

Workboard — это очередь задач. Цель: **пустой список = всё обработано**.

---

## Сегменты

Три типа фанов, три ритма контакта, три вкладки.

### Tab 1: Сабы (активные подписчики)

**Кто:** фан с активной подпиской (`is_subscriber = true`, `subscription_expires_at > now()`).

**Ритм:** touchpoint-система, привязанная к дате истечения подписки. Чем ближе к expiry — тем чаще нужен контакт.

| Touchpoint | Когда появляется | Цвет |
|------------|-----------------|------|
| 21d | Подписка истекает через 14-21 дней | Серый |
| 14d | Подписка истекает через 7-14 дней | Серый |
| 7d | Подписка истекает через 5-7 дней | Синий |
| 5d | Подписка истекает через 3-5 дней | Жёлтый |
| 3d | Подписка истекает через 1-3 дня | Оранжевый |
| 1d | Подписка истекает через 0-1 день | Красный |

**Handled:** touchpoint считается отработанным если был контакт (любое сообщение от фана или модели) после наступления touchpoint-а или за последние 48 часов: `last_contact_at >= greatest(touchpoint_due_at, now - 48h)`.

**Показываем:** только unhandled touchpoint-ы.

**Сортировка:** touchpoint urgency (1d первый) → auto-renew Off выше On → LTV desc.

**SQL:** переиспользуем `retentionBaseQuery` из текущего `crm.ts` с `showHandled: false`.

### Tab 2: Актив спендеры

**Кто:** LTV >= $100 (`creator_net_amount_mills >= 100_000`), нет активной подписки, последний спенд <= 30 дней назад (`last_transaction_at > now() - 30 days`).

**Ритм:** контакт каждые 7 дней.

**Overdue:** нет контакта 7+ дней (`last_contact_at < now() - 7 days` или `last_contact_at IS NULL`).

**Показываем:** только overdue.

**Сортировка:** LTV desc.

### Tab 3: Неактив спендеры

**Кто:** LTV >= $100 (`creator_net_amount_mills >= 100_000`), нет активной подписки, последний спенд > 30 дней назад (`last_transaction_at <= now() - 30 days`).

**Ритм:** пинг каждые 14 дней.

**Overdue:** нет контакта 14+ дней (`last_contact_at < now() - 14 days` или `last_contact_at IS NULL`).

**Показываем:** только overdue.

**Сортировка:** LTV desc.

### Определение "контакт"

`last_contact_at = MAX(last_fan_message_at, last_model_message_at)` — последнее сообщение от любой стороны. Если фан написал вчера — контакт был вчера, даже если мы не ответили (unreads обрабатываются в Fansly).

### Исключения между сегментами

- Фан с активной подпиской НЕ попадает в табы 2 и 3 (даже если LTV >= $100).
- Фан с LTV < $100 без активной подписки НЕ попадает никуда.
- Snoozed фаны скрыты из всех табов до истечения snooze.

---

## Snooze (отложить)

Иногда фана осознанно не трогают (игнорит, проблемный, etc). Чаттер может отложить фана.

**Механика:**
- Три кнопки на карточке: `[⏸ 7d]` `[⏸ 14d]` `[⏸ 30d]`
- Клик → фан скрыт из workboard до `snoozed_until`
- Snooze абсолютный — даже если фан напишет или потратит, он остаётся snoozed (unreads покажет Fansly)
- Можно unsnooze вручную

**БД:** таблица `workboard_snoozes`:
```sql
CREATE TABLE workboard_snoozes (
  id SERIAL PRIMARY KEY,
  platform_account_id INTEGER NOT NULL,
  fan_id INTEGER NOT NULL,
  snoozed_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_account_id, fan_id)
);
```

**Запрос workboard:** фильтр `WHERE NOT EXISTS (SELECT 1 FROM workboard_snoozes ws WHERE ws.fan_id = ... AND ws.platform_account_id = ... AND ws.snoozed_until > now())`.

---

## UI

### Layout

```
Workboard — Lora-1
12 требуют внимания · 3 snoozed

[Сабы · 5]    [Актив спендеры · 3]    [Неактив спендеры · 4]
```

- Header: название страницы, общее число overdue, число snoozed (кликабельно)
- Три таба с числом overdue на каждом
- Числа обновляются при snooze/unsnooze

### Карточка фана — Tab 1 (Сабы)

```
┌─────────────────────────────────────────────── overdue 3д ──┐
│  🔴 1d    WhaleGuy99                                 $487   │
│           @whaleguy99                          Tier: VIP    │
│                                                             │
│  Fan msg: 3d ago          Model msg: 5d ago                 │
│  Last spend: 2d ago       Expires: Apr 2 · Auto-renew: Off │
│                                                             │
│                              [⏸ 7d] [⏸ 14d] [⏸ 30d] [→ Chat] │
└─────────────────────────────────────────────────────────────┘
```

Поля:
- Touchpoint badge (🔴 1d / 🟠 3d / 🟡 5d / 🔵 7d / ⚪ 14d / ⚪ 21d)
- Fan name + username
- LTV (total spend)
- Subscription tier name
- Fan msg: Xd ago / never
- Model msg: Xd ago / never
- Last spend: Xd ago
- Subscription expires: date
- Auto-renew: On / Off
- Overdue Xd (в правом верхнем углу)

### Карточка фана — Tab 2 (Актив спендеры)

```
┌─────────────────────────────────────────────── overdue 5д ──┐
│  BigTipper                                           $320   │
│  @bigtipper                                                 │
│                                                             │
│  Fan msg: 12d ago         Model msg: 8d ago                 │
│  Last spend: 18d ago      Sub: Expired (Mar 15)             │
│                                                             │
│                              [⏸ 7d] [⏸ 14d] [⏸ 30d] [→ Chat] │
└─────────────────────────────────────────────────────────────┘
```

Поля:
- Fan name + username
- LTV
- Fan msg: Xd ago / never
- Model msg: Xd ago / never
- Last spend: Xd ago
- Subscription status: Expired (date) / Never subscribed
- Overdue Xd

### Карточка фана — Tab 3 (Неактив спендеры)

Идентична Tab 2.

### Цвет карточки по просрочке

| Overdue | Фон карточки |
|---------|-------------|
| 0-2 дня | Обычный |
| 3-7 дней | Лёгкий жёлтый |
| 7+ дней | Лёгкий красный |

Для Tab 1 (сабы): overdue = дни с момента наступления touchpoint-а без контакта.
Для Tab 2: overdue = silence_days - 7.
Для Tab 3: overdue = silence_days - 14.

### Раскрытие карточки (Chat Preview)

Клик на карточку → раскрывается панель с последними 25 сообщениями (переиспользуем `ChatPreviewPanel`).

Сообщения фана слева, модели справа. Показываем tips. Внизу — ссылка "View Full Profile".

`PAGE_DM_MESSAGE_HISTORY_LIMIT` в `crm.ts` уже 25. Фронт передаёт `limit: 25`.

### Snoozed секция

Внизу страницы (под карточками или в отдельном collapsible):

```
▸ Snoozed (3)

  SomeFan      $150    snoozed до Apr 12    [Unsnooze]
  AnotherFan   $90     snoozed до Apr 20    [Unsnooze]
  QuietOne     $120    snoozed до Apr 28    [Unsnooze]
```

Unsnooze = удаление записи из `workboard_snoozes`. Фан сразу появляется в workboard (если overdue).

### Пустой стейт

```
┌─────────────────────────────────────────────┐
│                                             │
│           ✓ Все обработано                   │
│           Нет просроченных фанов             │
│                                             │
└─────────────────────────────────────────────┘
```

### Нет пагинации

Показываем всех overdue фанов (ожидаем < 100 на таб). Если окажется больше — добавим "Load more" позже.

---

## Данные

### Ключевые таблицы

| Таблица | Что берём |
|---------|-----------|
| `fans` | platform_user_id, username, display_name |
| `fan_pages` | is_subscriber, subscriber_since, subscription_expires_at, auto_renew |
| `page_dm_conversations` | unread_count, last_message_at, last_fan_message_at, last_model_message_at, last_message_sender_role, last_message_preview, platform_conversation_id, message_backfill_complete, stored_message_count |
| `spender_lifetime_page` | creator_net_amount_mills (LTV), last_transaction_at |
| `page_subscriptions` | subscription_tier_name (через CTE current_subscription) |
| `workboard_snoozes` | snoozed_until (новая таблица) |

### Деньги

BIGINT mills. 1 mill = $0.001. $100 = 100,000 mills.

---

## Scope

### Fansly first

Workboard пока только для Fansly-страниц. OF — позже.

### Для админа

Дашборд пока готовим для админа (Дмитрия). Чаттерам откроем позже.

### Что НЕ делаем

- Unreads — обрабатываются в интерфейсе Fansly
- PPV / массовые рассылки — отдельная задача, не в scope workboard
- Handoff между сменами — возможно позже
- Drag-and-drop, Kanban, status tracking — не нужно
- Нотификации / Telegram-бот — возможно позже

---

## Текущий CRM (что переиспользуем)

### Переиспользуем

| Что | Где | Зачем |
|-----|-----|-------|
| `retentionBaseQuery` | `crm.ts` | SQL для таба "Сабы" (touchpoint логика) |
| `primary_conversation` CTE | `crm.ts` | Паттерн получения последней conversation на фана |
| `ChatPreviewPanel` | `components/page/crm/` | UI раскрытия карточки с историей чата |
| `TouchpointBadge` | `components/page/crm/` | Бейдж touchpoint-а |
| `useCrmConversationPreview` | `queries.ts` | Хук загрузки preview |
| Утилиты форматирования | `viewModel.ts` | formatMills, formatRelativeTime, etc. |

### Удаляем (после запуска workboard)

- `CrmPage.tsx`
- `RetentionTable.tsx`
- `ReactivationTable.tsx`
- `CrmSummaryHeader.tsx`
- `viewModel.ts` (кроме утилит)
- API роуты `/crm/retention`, `/crm/reactivation`, `/crm/summary`
- `listCrmRetention`, `listCrmReactivation`, `getCrmSummary` из `crm.ts`

---

## API Design

### GET /api/v1/pages/:pageLabel/workboard

Возвращает три секции в одном ответе.

```typescript
interface WorkboardResponse {
  page: { label: string; platform: string };

  subscribers: {
    total: number;
    items: WorkboardSubscriberItem[];
  };

  activeSpenders: {
    total: number;
    items: WorkboardSpenderItem[];
  };

  inactiveSpenders: {
    total: number;
    items: WorkboardSpenderItem[];
  };

  snoozed: {
    total: number;
    items: WorkboardSnoozedItem[];
  };
}

interface WorkboardSubscriberItem {
  fanId: number;
  fan: { platformUserId: string; username: string | null; displayName: string | null };
  ltv: { creatorNetAmountMills: bigint };
  touchpoint: { code: string; label: string; isSoft: boolean; dueAt: string };
  overdueDays: number;
  conversation: {
    platformConversationId: string | null;
    lastFanMessageAt: string | null;
    lastModelMessageAt: string | null;
    lastMessagePreview: string | null;
    storedMessageCount: number;
    messageBackfillComplete: boolean;
  };
  subscription: {
    expiresAt: string;
    autoRenew: boolean | null;
    tierName: string | null;
  };
  lastTransactionAt: string | null;
}

interface WorkboardSpenderItem {
  fanId: number;
  fan: { platformUserId: string; username: string | null; displayName: string | null };
  ltv: { creatorNetAmountMills: bigint };
  overdueDays: number;
  silenceDays: number;
  conversation: {
    platformConversationId: string | null;
    lastFanMessageAt: string | null;
    lastModelMessageAt: string | null;
    lastMessagePreview: string | null;
    storedMessageCount: number;
    messageBackfillComplete: boolean;
  };
  subscription: {
    status: "expired" | "never";
    expiresAt: string | null;
  };
  lastTransactionAt: string | null;
}

interface WorkboardSnoozedItem {
  fanId: number;
  fan: { platformUserId: string; username: string | null; displayName: string | null };
  ltv: { creatorNetAmountMills: bigint };
  snoozedUntil: string;
}
```

### POST /api/v1/pages/:pageLabel/workboard/snooze

```typescript
// Request
{ fanId: number; days: 7 | 14 | 30 }

// Response
{ ok: true; snoozedUntil: string }
```

### DELETE /api/v1/pages/:pageLabel/workboard/snooze/:fanId

Unsnooze.

```typescript
// Response
{ ok: true }
```

---

## Implementation Plan

### Порядок

1. **DB migration:** таблица `workboard_snoozes`
2. **DB repository:** `listWorkboard()`, `snoozeWorkboardFan()`, `unsnoozeWorkboardFan()` в `crm.ts` или новый `workboard.ts`
3. **Contracts:** Zod-схемы для workboard response
4. **Service:** `getWorkboardReport()`, `snoozeWorkboardFan()`, `unsnoozeWorkboardFan()`
5. **API routes:** три новых эндпоинта
6. **React hooks:** `useWorkboard()`, `useSnooze()`, `useUnsnooze()`
7. **Frontend:** `WorkboardPage.tsx`, `WorkboardCard.tsx`, `WorkboardSnoozedSection.tsx`
8. **Routing:** подключить страницу

### Что переиспользуем из кода

- `retentionBaseQuery` → основа SQL для таба "Сабы"
- `reactivationBaseQuery` → основа SQL для табов спендеров (модифицированная)
- `ChatPreviewPanel` → раскрытие карточки
- `TouchpointBadge` → бейдж в карточке саба
- `formatMills`, `formatRelativeTime`, `formatDate`, `daysRemaining` → форматирование
- `resolveFanLabel` → отображение имени фана

---

## Константы

```typescript
const SUBSCRIBER_TOUCHPOINTS = ["21d", "14d", "7d", "5d", "3d", "1d"];
const ACTIVE_SPENDER_MIN_LTV_MILLS = 100_000n; // $100
const ACTIVE_SPENDER_RHYTHM_DAYS = 7;
const ACTIVE_SPENDER_RECENT_SPEND_DAYS = 30;
const INACTIVE_SPENDER_MIN_LTV_MILLS = 100_000n; // $100
const INACTIVE_SPENDER_RHYTHM_DAYS = 14;
const INACTIVE_SPENDER_RECENT_SPEND_DAYS = 30;
const SNOOZE_OPTIONS_DAYS = [7, 14, 30];
const OVERDUE_WARNING_THRESHOLD_DAYS = 3; // жёлтый фон
const OVERDUE_DANGER_THRESHOLD_DAYS = 7;  // красный фон
```

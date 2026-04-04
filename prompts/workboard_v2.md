И так в чем суть работы чаттеров с фанами (активными и спящими) из нашей должностной инструкции:

1. Активные фанаты (Удержание):
(Повседневное общение для создания привязанности)
•	Поддержание регулярного общения с активными фанатами
•	Создание эмоциональной связи через персонализацию
•	Инициация общения без продажи - для укрепления доверия
•	Благодарность за tips, покупки и участие в акциях

2. Спящие фанаты (Реактивация)
(Работа с базой для продления LTV, возвращения в активное состояние)
•	Реактивация «спящих» подписчиков по текущему плану
•	Отслеживание признаков оттока и работа с «остывающими» до отписки

3. Серая масса (такого нет в должностной инструкции, добавляю для сториборда)
(фаны еще не имевшие с нами никаких контактов в чатах или покупок)
• Вывод на первое общение через касание в чатах
• Холодные продажи через рассылки

Активные фаны это либо активная подписка (хотя некоторые с подпиской не взаимодействуют в чате), либо просто фаны, которые тратились в последнее время. Обычно последние 2-4 недели.

Спящие - фанаты которые тратились когда-либо на любую сумму, но перестали.

Серая масса - простые followers, которые еще никак не взаимодействовали с нами. Не чатились (либо минимально), но не покупали никогда. С точки зрения серой маркетинга серая масса является основным объектом работы маркетолога через разные бандлы/скидки/подписки и прочее.

Наша же цель в данный момент это удержание и реактивация. Соответственно нужно продумать две разные системы (1 - Система удержания. 2 - Система реактивации)






1 - Система удержания: Мы должны всем действующим фанам, в первую очередь подписчикам (ведь они платят за подписку) давать достаточно внимания, чтобы они не были обижены.
Должен быть умный алгоритм и хорошо продуманная формула. Но очень важно, составлять ее так, чтобы никто не был пропущен. Да, можно ранжировать сильно вниз кого-то, но главное никого не забыть. Использовать все возможные метрики которые нам доступны. Я считаю лично одними из важнейших: 1. как давно фанат в принципе писал что-либо модели. 2. как давно фанат покупал что-либо. 3. читал ли он последние сообщения от модели. 

Я вижу это как небольшую сегментацию, те кто активно покупает но не сабается помещаются в 


2 - Система реактивации:
Должен быть умный алгоритм и хорошо продуманная формула. Но очень важно, составлять ее так, чтобы никто не был пропущен. Да, можно ранжировать сильно вниз кого-то, но главное никого не забыть. 




## Данные в Agency Hub

### Что синхронизируется

| Данные | Стримы | Статус |
|---|---|---|
| Транзакции (суммы, типы, даты) | `transactions` | ✅ Работает |
| Подписки (tier, цена, expiry, auto-renew) | `subscribers` | ✅ Работает |
| Фолловеры | `followers`, `followers_reconcile` | ✅ Работает |
| DM переписка | `dm_conversations`, `dm_messages` | ✅ Работает |
| Top spenders (OM identities) | `top_spenders` | ✅ Работает |
| Метаданные аккаунта | `light` | ✅ Работает |

## Схема БД (ключевые таблицы для workboard)

### fans
```
id, platform, platform_user_id, username, display_name,
created_at_external, metadata, first_seen_at, last_seen_at
```
Один фан = один platform + platform_user_id. Уникален в рамках платформы.

### page_fans (она же fan_pages)
```
id, fan_id, platform_account_id,
total_creator_net_mills,          -- LTV в mills (1 mill = $0.001)
is_follower, follower_since,
is_subscriber, subscriber_since,
subscription_expires_at, auto_renew,
page_alias, page_alias_source,
last_transaction_at, last_seen_at
```
Связь фан ↔ аккаунт модели. Тут LTV, статус подписки, auto-renew.

### page_subscriptions
```
id, platform_subscription_id, platform_account_id, fan_id,
subscription_tier_id, subscription_tier_name, subscription_tier_color,
price_mills, renew_price_mills, auto_renew,
billing_cycle_days, duration_days,
renew_date, ends_at, is_current,
source_created_at, source_updated_at
```
Детали подписки: тир, цена, auto-renew, дата окончания.

### transactions
```
id, platform_account_id, fan_id, transaction_id,
raw_type, canonical_type,       -- 'subscription'|'tip'|'message_purchase'|'post_purchase'|'stream_tip'|'chargeback'|'refund'|'payout_reversal'|'other'
transaction_state,              -- 'pending'|'posted'|'unknown'
gross_amount_mills, creator_net_amount_mills,
occurred_at, is_active
```
Каждая транзакция с типом и суммой. Mills = $0.001.

### fan_spend_daily
```
platform_account_id, fan_id, business_date,
canonical_type, transaction_state,
transaction_count, gross_amount_mills, creator_net_amount_mills,
last_transaction_at
```
Агрегат: траты фана по дням и типам. Для расчёта velocity/trend.

### fan_spend_lifetime
```
platform_account_id, fan_id,
gross_amount_mills, creator_net_amount_mills,
last_transaction_at
```
Общий LTV фана на аккаунте.

### page_dm_threads (она же page_dm_conversations)
```
id, platform_account_id, fan_id,
platform_conversation_id,
partner_platform_user_id, partner_username,
unread_count,
last_message_at, last_message_sender_role,  -- 'fan'|'model'|'system'|'unknown'
last_message_preview,
last_fan_message_at, last_model_message_at,
stored_message_count,
message_coverage_status,    -- 'pending_backfill'|'partial_window'|'complete'
message_backfill_complete
```
DM треды. Ключевое: last_fan_message_at, last_model_message_at, unread_count.

### page_dm_messages
```
id, conversation_id, platform_account_id,
platform_message_id,
sender_platform_user_id, sender_role,   -- 'fan'|'model'|'system'|'unknown'
created_at, content,
total_tip_amount_cents
```
Отдельные сообщения. sender_role = кто написал. content = текст.

### fan_notes
```
id, fan_id, platform_account_id, author_user_id,
body, created_at
```
Заметки чаттеров о фане (ручные).

### fan_profiles
```
id, fan_id, platform_account_id,
version, body, source, created_by_user_id, created_at
```
Профиль фана (версионированный).

### fan_summaries
```
id, fan_id, platform_account_id, author_user_id,
body, created_at
```
Саммари по фану.

### fan_flags
```
id, fan_id, flag, created_by_user_id, created_at
```
Флаги на фане (типы определены в shared).

### page_fan_external_notes
```
id, platform_account_id, fan_id, provider,
external_note_id, content_type, title, body,
is_active
```
Заметки с платформы (Fansly notes sync).

### workboard_snoozes
```
id, platform_account_id, fan_id,
snoozed_until, created_at
```
Снуз фана на воркборде (отложить до времени). Уже есть в схеме.

### page_follows
```
id, platform_account_id, fan_id,
followed_at, is_active
```
Фолловы. is_active = текущий фолловер или нет.

### revenue_daily
```
platform_account_id, business_date,
canonical_type, transaction_state,
transaction_count, gross_amount_mills, creator_net_amount_mills
```
Дневная выручка по типам.

---

## Что можно вычислить из имеющихся данных

### Для скоринга
- **LTV** → `fan_spend_lifetime.creator_net_amount_mills`
- **Spend velocity** → `fan_spend_daily` (скользящее среднее 7д vs 30д)
- **Last transaction** → `page_fans.last_transaction_at`
- **Subscription status** → `page_fans.is_subscriber`, `subscription_expires_at`, `auto_renew`
- **Subscription details** → `page_subscriptions` (tier, price, ends_at, auto_renew)
- **Days until expiry** → `page_fans.subscription_expires_at - now()`
- **Last fan message** → `page_dm_threads.last_fan_message_at`
- **Last model message** → `page_dm_threads.last_model_message_at`
- **Unanswered** → `last_fan_message_at > last_model_message_at`
- **Silence duration** → `now() - last_fan_message_at`
- **Unread count** → `page_dm_threads.unread_count`
- **Message frequency** → из `page_dm_messages` (count per period, avg interval)
- **Message length** → из `page_dm_messages.content` (avg length)
- **Who initiates** → из `page_dm_messages.sender_role` (% fan-initiated conversations)
- **Transaction types breakdown** → `fan_spend_daily` по canonical_type
- **Tip frequency** → `transactions` where canonical_type = 'tip'
- **PPV purchases** → `transactions` where canonical_type = 'message_purchase'
- **Follow date** → `page_follows.followed_at`
- **Follower vs subscriber** → `page_fans.is_follower` vs `is_subscriber`
- **Churn risk** → composite: auto_renew OFF + days until expiry + silence
- **CRM notes** → `fan_notes`, `fan_profiles`, `page_fan_external_notes`
- Остальное, еще не описанное

### Online / presence signal — best effort
- Fansly does **not** have a confirmed dedicated per-user `online` / `offline` API for arbitrary users.
- Что реально подтверждено:
  - **`lastSeenAt`** приходит в follower/account payloads, в том числе через `GET /account/{accountId}/followersnew`
  - Фильтр **`lastSeenAfter`** позволяет выбрать followers, которые были активны после указанного timestamp
  - Есть дополнительные сигналы активности: DM/chat WebSocket transport, typing (`POST /message/typing`), livestream/chat presence
  - `aggregationData` в followers response даёт `username`, `displayName`
- Практическая продуктовая модель:
  - показывать это как **inferred presence**, а не как точный online status
  - базовые бакеты: `Active now` < 30m, `Recently active` 30-120m, дальше `Stale`
  - polling раз в 1-5 мин даёт рабочий near-real-time сигнал, но список не будет исчерпывающим и на 100% точным
  - в UI нужен явный label вроде `best effort` / `updated X min ago`
- Важно:
  - FBuddy `online-users` — это их собственная производная фича, а не нативный Fansly presence API
  - FBuddy backend endpoints `/api/v1/online-users/record` и `/history` относятся к FBuddy analytics/history, а не к Fansly
  - ⚠️ Запросы через SOCKS5 proxy всё ещё нужны для стабильной работы с Fansly

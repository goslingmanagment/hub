# Какие эндпоинты OnlyFansAPI не подключены

Срез аудита 06.09.2026: production commit `7fac98f310d673134c8dcb5dd6596e126e7f9e69`.
«Не подключён» означает отсутствие конкретного исходящего вызова этой операции в Hub. Это не утверждение об отсутствии похожей собственной функции Hub: например, собственные заметки и аналитика не равны API заметок/аналитики поставщика.

В полном OpenAPI 255 строк без реализации. Ниже **252 актуальные интеграционные операции: 117 GET и 135 остальных**. Из основного перечня исключены два внутренних callback поставщика и deprecated media/scrape; они приведены в конце. Среди POST есть также аналитические запросы, поэтому все non-GET нельзя называть изменениями данных.

Чтение списка постов уже есть; отсутствует отдельный GET поста и его статистики. Чтение сообщений, поиск, отправка и удаление уже есть; отсутствуют действия, перечисленные ниже. Список tracking/trial ссылок и часть пользователей уже есть; отсутствуют приведённые дополнительные операции. Матрица учитывает endpoint даже при частичной поддержке параметров: ограничения реализованных 39 путей описаны в [отчёте](REPORT.md).

Для каждого блока ниже приведены все отсутствующие method/path, без сокращения URL. `{account}` — идентификатор аккаунта OFAPI. Сначала GET, затем остальные методы.

## Аккаунт — 4

- `GET /api/{account}/me` — Get Current Account
- `GET /api/{account}/me/model-start-date` — Get Model Start Date
- `GET /api/{account}/me/top-percentage` — Get Top Percentage
- `DELETE /api/accounts/{id}` — Disconnect Account

## Финансовая аналитика поставщика — 5

- `GET /api/analytics/financial/profitability/{account}/history` — Get Profitability History
- `POST /api/analytics/financial/transactions/summary` — Get Transaction Summary
- `POST /api/analytics/financial/transactions/by-type` — Get Transactions By Type
- `POST /api/analytics/financial/forecast` — Get Revenue Forecast
- `POST /api/analytics/financial/profitability` — Get Profitability

## Сводная аналитика поставщика — 3

- `POST /api/analytics/summary/earnings` — Get Earnings Overview
- `POST /api/analytics/summary/historical` — Get Historical Performance
- `POST /api/analytics/summary/comparison` — Get Period Comparison

## Банковские реквизиты и документы — 7

- `GET /api/{account}/banking/details/bank` — Get Bank Payout Details
- `GET /api/{account}/banking/details/legal-form` — Get Legal Form Details
- `GET /api/{account}/banking/details/legal-info` — Get Legal and Tax Status
- `GET /api/{account}/banking/details/dac7-form` — Get DAC7 Form Details
- `GET /api/{account}/banking/details/account-country` — Get Account Country Details
- `GET /api/{account}/banking/countries` — List Countries
- `GET /api/{account}/banking/available-payout-systems` — List Available Payout Systems

## Запрещённые слова — 1

- `GET /api/banned-words` — List Banned Words

## Списки заблокированных и ограниченных пользователей — 2

- `GET /api/{account}/users/blocked` — List Blocked Users
- `GET /api/{account}/users/restricted` — List Restricted Users

## Статистика возвратов — 2

- `GET /api/{account}/chargebacks/statistics` — List Chargeback Statistics
- `GET /api/{account}/chargebacks/ratio` — Calculate Chargeback Ratio

## Действия с сообщениями — 5

- `POST /api/{account}/chats/{chat_id}/messages/{message_id}/pin` — Pin Message
- `DELETE /api/{account}/chats/{chat_id}/messages/{message_id}/unpin` — Unpin Message
- `POST /api/{account}/chats/{chat_id}/messages/{message_id}/like` — Like Message
- `DELETE /api/{account}/chats/{chat_id}/messages/{message_id}/unlike` — Unlike Message
- `POST /api/{account}/messages/{queue_id}/attach-tags` — Attach Tags (Release Forms) to Message

## Действия с чатами — 6

- `POST /api/{account}/chats/mark-as-read` — Mark All Chats as Read
- `POST /api/{account}/chats/{chat_id}/mute` — Mute Chat Notifications
- `DELETE /api/{account}/chats/{chat_id}/unmute` — Unmute Chat Notifications
- `POST /api/{account}/chats/{chat_id}/hide` — Hide Chat
- `DELETE /api/{account}/chats/{chat_id}` — Delete Chat
- `POST /api/{account}/chats/{chat_id}/mark-as-unread` — Mark Chat as Unread

## Встраиваемое подключение аккаунта — 1

- `POST /api/client-sessions` — Create Client Session

## Авторизация и переподключение — 6

- `GET /api/authenticate/{attempt_id}` — Poll Authentication Status
- `POST /api/authenticate` — Start Authentication
- `PUT /api/authenticate/{attempt_id}` — Submit 2FA
- `POST /api/authenticate/{attempt_id}/send-email-to-creator` — Send 2FA E-mail to Creator
- `POST /api/authenticate/{account_id}/reauthenticate` — Re-authenticate Account
- `PUT /api/authenticate/{account_id}/credentials` — Update Authentication Credentials

## Управление экспортами — 3

- `GET /api/data-exports` — List Data Exports
- `DELETE /api/data-exports/{data_export_id}` — Cancel Data Export
- `POST /api/data-exports/{data_export_id}/retry` — Retry Failed Data Export

## Эффективность сообщений и покупатели — 6

- `GET /api/{account}/engagement/messages/mass-messages` — Mass Messages
- `GET /api/{account}/engagement/messages/direct-messages` — Direct Messages
- `GET /api/{account}/engagement/messages/mass-messages/chart` — Mass Messages Chart
- `GET /api/{account}/engagement/messages/direct-messages/chart` — Direct Messages Chart
- `GET /api/{account}/engagement/messages/top-message` — Top Message
- `GET /api/{account}/engagement/messages/{message_id}/buyers` — Message Buyers

## Фаны, история подписок и заметки OnlyFans — 8

- `GET /api/{account}/fans/expired` — List Expired Fans
- `GET /api/{account}/fans/latest` — List Latest Fans
- `GET /api/{account}/fans/top` — List Top Fans
- `GET /api/{account}/fans/{fan_id}/notes` — Get Fan Notes
- `GET /api/{account}/fans/{user_id}/subscriptions-history` — Get Subscription History
- `PUT /api/{account}/fans/{fan_id}/custom-name` — Set Fan's Custom Name
- `PUT /api/{account}/fans/{fan_id}/notes` — Create/Edit Fan Notes
- `DELETE /api/{account}/fans/{fan_id}/notes` — Clear Fan Notes

## AI-сводки поставщика — 6

- `GET /api/fan-summary-categories` — List Custom Summary Categories
- `GET /api/{account}/fans/{fan_id}/summary` — Get Fan Summary
- `POST /api/fan-summary-categories` — Create Custom Summary Category
- `PUT /api/fan-summary-categories/{category_id}` — Update Custom Summary Category
- `DELETE /api/fan-summary-categories/{category_id}` — Delete Custom Summary Category
- `POST /api/{account}/fans/{fan_id}/summary` — Generate Fan Summary

## Исходящие подписки аккаунта — 3

- `GET /api/{account}/following/all` — List All Followings
- `GET /api/{account}/following/active` — List Active Followings
- `GET /api/{account}/following/expired` — List Expired Followings

## Пробные ссылки — 9

- `GET /api/{account}/trial-links/{trial_link_id}` — Get Free Trial Link
- `GET /api/{account}/trial-links/{trial_link_id}/spenders` — List Free Trial Link Spenders
- `GET /api/{account}/trial-links/{trial_link_id}/stats` — Get Free Trial Link Stats
- `GET /api/{account}/trial-links/{trial_link_id}/cohort-arps` — Get Free Trial Link Cohort ARPS
- `GET /api/{account}/trial-links/{trial_link_id}/tags` — List Free Trial Link Tags
- `POST /api/{account}/trial-links` — Create Free Trial Link
- `DELETE /api/{account}/trial-links/{trial_link_id}` — Delete Free Trial Link
- `POST /api/{account}/trial-links/{trial_link_id}/tags` — Add Free Trial Link Tags
- `DELETE /api/{account}/trial-links/{trial_link_id}/tags` — Remove Free Trial Link Tags

## GIF-поиск — 2

- `GET /api/{account}/giphy/trending` — List Trending GIFs
- `GET /api/{account}/giphy/search` — Search GIFs

## Теги ссылок — 1

- `GET /api/link-tags` — List All Link Tags

## Массовые рассылки — 6

- `GET /api/{account}/mass-messaging/overview` — Get Mass Message Overview
- `GET /api/{account}/mass-messaging` — List Mass Message Queue
- `GET /api/{account}/mass-messaging/{id}` — Get Mass Message
- `POST /api/{account}/mass-messaging` — Send Mass Message
- `PUT /api/{account}/mass-messaging/{id}` — Update Mass Message
- `DELETE /api/{account}/mass-messaging/{id}` — Unsend/Delete Mass Message

## Загрузка и скачивание медиа — 3

- `GET /api/{account}/media/download/drm/{media_id}` — Download DRM-protected Media
- `GET /api/{account}/media/download/{cdnUrl}` — Download Media from the OnlyFans CDN
- `POST /api/{account}/media/upload` — Upload media to the OnlyFans CDN

## Изменение Vault — 2

- `DELETE /api/{account}/media/vault/delete-media` — Delete Vault Media
- `POST /api/{account}/media/vault` — Upload Media to Vault

## Управление альбомами Vault — 6

- `GET /api/{account}/media/vault/lists/{list_id}` — Show Vault List
- `POST /api/{account}/media/vault/lists` — Create Vault List
- `PUT /api/{account}/media/vault/lists/{list_id}` — Rename Vault List
- `DELETE /api/{account}/media/vault/lists/{list_id}` — Delete Vault List
- `POST /api/{account}/media/vault/lists/{list_id}/media` — Add Media To List
- `DELETE /api/{account}/media/vault/lists/{list_id}/media` — Remove Media From List

## Уведомления OnlyFans — 6

- `GET /api/{account}/notifications` — List Notifications
- `GET /api/{account}/notifications/search-users` — Search Users In Notifications
- `GET /api/{account}/notifications/counts` — Get Notification Counts
- `GET /api/{account}/notifications/tabs-order` — Get Notification Tabs Order
- `POST /api/{account}/notifications/mark-all-as-read` — Mark All Notifications As Read
- `PUT /api/{account}/notifications/tabs-order` — Update Notification Tabs Order

## Баланс и вывод средств OnlyFans — 6

- `GET /api/{account}/payouts/balances` — Get Account Balances
- `GET /api/{account}/payouts/eligibility` — Get Eligibility
- `GET /api/{account}/payouts/earning-statistics` — Get Earning Statistics
- `GET /api/{account}/payouts/payout-requests` — List Payout Requests
- `PATCH /api/{account}/payouts/payout-frequency` — Update Payout Frequency
- `POST /api/{account}/payouts/request-manual-withdrawal` — Request Manual Withdrawal

## Комментарии к постам — 7

- `GET /api/{account}/posts/{post_id}/comments` — List Post Comments
- `POST /api/{account}/posts/{post_id}/comments` — Create Post Comment
- `DELETE /api/{account}/posts/{post_id}/comments/{comment_id}` — Delete Post Comment
- `POST /api/{account}/posts/{post_id}/comments/{comment_id}/pin` — Pin Post Comment
- `DELETE /api/{account}/posts/{post_id}/comments/{comment_id}/pin` — Unpin Post Comment
- `POST /api/{account}/posts/{post_id}/comments/{comment_id}/like` — Like Post Comment
- `DELETE /api/{account}/posts/{post_id}/comments/{comment_id}/like` — Unlike Post Comment

## Метки постов — 2

- `GET /api/{account}/posts/labels` — List Labels
- `POST /api/{account}/posts/labels` — Create Label

## Посты: отдельный пост, статистика и публикация — 8

- `GET /api/{account}/posts/{post_id}` — Get Post
- `GET /api/{account}/posts/{post_id}/stats` — Show Post Statistics
- `POST /api/{account}/posts` — Send Post
- `PUT /api/{account}/posts/{post_id}` — Update Post
- `DELETE /api/{account}/posts/{post_id}` — Delete Post
- `POST /api/{account}/posts/{post_id}/archive` — Archive Post
- `POST /api/{account}/posts/{post_id}/unarchive` — Unarchive Post
- `POST /api/{account}/posts/{post_id}/pin` — Pin/Unpin Post

## Промоакции — 4

- `GET /api/{account}/promotions` — List Promotions
- `POST /api/{account}/promotions` — Create Promotion
- `DELETE /api/{account}/promotions/{promotion_id}` — Delete Promotion
- `POST /api/{account}/promotions/{promotion_id}/stop` — Stop Promotion

## Публичные профили через OnlyFansAPI — 2

- `GET /api/profiles/{username}` — Get Profile Details
- `GET /api/search` — Search Profiles

## Очередь публикаций — 3

- `GET /api/{account}/queue` — List Queue Items
- `GET /api/{account}/queue/counts` — Count Queue Items
- `PUT /api/{account}/queue/{queue_id}/publish` — Publish Queue Item

## Согласия участников съёмки — 7

- `GET /api/{account}/release-forms` — List Release Forms
- `GET /api/{account}/release-forms/taggable-users` — List Taggable Users
- `GET /api/{account}/release-forms/mentions` — List Mentions
- `POST /api/{account}/release-forms/create-invitation-link` — Create Invitation Link
- `POST /api/{account}/release-forms/create-release-form` — Create Release Form
- `PATCH /api/{account}/release-forms/toggle-show` — Hide / Unhide Release Form
- `PATCH /api/{account}/release-forms/rename` — Rename Release Form

## Отложенные сообщения — 4

- `GET /api/{account}/saved-for-later/messages` — List Saved For Later Messages
- `GET /api/{account}/saved-for-later/messages/settings` — Get Message Settings
- `PATCH /api/{account}/saved-for-later/messages/settings/enable-or-update-automatic-messaging` — Enable/Update Automatic Messaging
- `PATCH /api/{account}/saved-for-later/messages/settings/disable-automatic-messaging` — Disable Automatic Messaging

## Отложенные посты — 4

- `GET /api/{account}/saved-for-later/posts` — List Saved For Later Posts
- `GET /api/{account}/saved-for-later/posts/settings` — Get Post Settings
- `PATCH /api/{account}/saved-for-later/posts/settings/enable-or-update-automatic-posting` — Enable/Update Automatic Posting
- `PATCH /api/{account}/saved-for-later/posts/settings/disable-automatic-posting` — Disable Automatic Posting

## Настройки аккаунта — 16

- `GET /api/{account}/settings` — Get Settings
- `GET /api/{account}/settings/blocked-countries` — Get Blocked Countries
- `GET /api/{account}/settings/welcome-message` — Get Welcome Message
- `GET /api/{account}/settings/drm` — Get DRM Status
- `GET /api/{account}/settings/social-media-buttons` — List Social Media Buttons
- `POST /api/{account}/settings/profile` — Update Profile
- `PATCH /api/{account}/settings/subscription-price` — Update Subscription Price
- `PUT /api/{account}/settings/blocked-countries` — Update Blocked Countries
- `PATCH /api/{account}/settings/welcome-message` — Enable/Disable Welcome Message
- `POST /api/{account}/settings/welcome-message` — Update Welcome Message
- `PATCH /api/{account}/settings/drm` — Enable/Disable DRM
- `POST /api/{account}/settings/username-exists` — Check Username Availability
- `POST /api/{account}/settings/social-media-buttons/reorder` — Reorder Social Media Buttons
- `POST /api/{account}/settings/social-media-buttons` — Add Social Media Button
- `PUT /api/{account}/settings/social-media-buttons/{button_id}` — Update Social Media Button
- `DELETE /api/{account}/settings/social-media-buttons/{button_id}` — Delete Social Media Button

## Предоставленные пробные ссылки — 5

- `GET /api/{account}/shared-trial-links` — List Shared Free Trial Links
- `GET /api/{account}/shared-trial-links/{shared_trial_link_id}/tags` — List Shared Free Trial Link Tags
- `DELETE /api/{account}/shared-trial-links/{shared_trial_link_id}` — Revoke Shared Free Trial Link Access
- `POST /api/{account}/shared-trial-links/{shared_trial_link_id}/tags` — Add Shared Free Trial Link Tags
- `DELETE /api/{account}/shared-trial-links/{shared_trial_link_id}/tags` — Remove Shared Free Trial Link Tags

## Предоставленные tracking-ссылки — 5

- `GET /api/{account}/shared-tracking-links` — List Shared Tracking Links
- `GET /api/{account}/shared-tracking-links/{shared_tracking_link_id}/tags` — List Shared Tracking Link Tags
- `DELETE /api/{account}/shared-tracking-links/{shared_tracking_link_id}` — Revoke Shared Tracking Link Access
- `POST /api/{account}/shared-tracking-links/{shared_tracking_link_id}/tags` — Add Shared Tracking Link Tags
- `DELETE /api/{account}/shared-tracking-links/{shared_tracking_link_id}/tags` — Remove Shared Tracking Link Tags

## Postbacks Smart Links — 5

- `GET /api/smart-link-postbacks` — List Smart Link Postbacks
- `GET /api/smart-link-postbacks/{postback_id}` — Show Smart Link Postback
- `POST /api/smart-link-postbacks` — Create Smart Link Postback
- `PATCH /api/smart-link-postbacks/{postback_id}` — Update Smart Link Postback
- `DELETE /api/smart-link-postbacks/{postback_id}` — Delete Smart Link Postback

## Smart Links, Pixels и статистика — 18

- `GET /api/smart-links` — List Smart Links
- `GET /api/smart-links/{smart_link_id}` — Get Smart Link
- `GET /api/smart-links/{smart_link_id}/pixels` — List Smart Link Pixels
- `GET /api/smart-links/{smart_link_id}/tags` — List Smart Link Tags
- `GET /api/smart-links/{smart_link_id}/stats` — Get Smart Link Stats
- `GET /api/smart-links/{smart_link_id}/cohort-arps` — Get Smart Link Cohort ARPS
- `GET /api/smart-links/{smart_link_id}/spenders` — List Smart Link Spenders
- `GET /api/smart-links/{smart_link_id}/fans` — List Smart Link Fans
- `GET /api/smart-links/{smart_link_id}/clicks` — List Smart Link Clicks
- `GET /api/smart-links/{smart_link_id}/conversions` — List Smart Link Conversions
- `POST /api/smart-links` — Create Smart Link
- `DELETE /api/smart-links/{smart_link_id}` — Delete Smart Link
- `POST /api/smart-links/{smart_link_id}/pixels` — Create Smart Link Pixel
- `PATCH /api/smart-links/{smart_link_id}/pixels/{pixel_id}` — Update Smart Link Pixel
- `DELETE /api/smart-links/{smart_link_id}/pixels/{pixel_id}` — Disconnect Smart Link Pixel
- `POST /api/smart-links/{smart_link_id}/pixels/{pixel_id}/test-event` — Send Smart Link Pixel Test Event
- `POST /api/smart-links/{smart_link_id}/tags` — Add Smart Link Tags
- `DELETE /api/smart-links/{smart_link_id}/tags` — Remove Smart Link Tags

## Статистика аккаунта и посетителей — 6

- `GET /api/{account}/statistics/total-transactions` — Calculate Total Transactions
- `GET /api/{account}/statistics/overview` — Statistics Overview
- `GET /api/{account}/statistics/subscriber-metrics` — Get Subscriber Metrics
- `GET /api/{account}/statistics/statements/earnings` — Get Earnings
- `GET /api/{account}/statistics/reach/profile-visitors` — Get Profile Visitors
- `GET /api/{account}/subscribers/statistics` — Get Subscriber Statistics

## Сохранённые предоставленные пробные ссылки — 1

- `GET /api/{account}/stored/shared-trial-links` — List Stored Shared Free Trial Links

## Сохранённые предоставленные tracking-ссылки — 1

- `GET /api/{account}/stored/shared-tracking-links` — List Stored Shared Tracking Links

## Stories — 8

- `GET /api/{account}/stories/archive` — List Story Archive
- `GET /api/{account}/stories/{story_id}/stats` — Get Story Stats
- `GET /api/{account}/stories/{story_id}/viewers` — List Story Viewers
- `GET /api/{account}/stories` — List Active Stories
- `GET /api/{account}/stories/{story_id}` — Show Story
- `POST /api/{account}/stories/{story_id}/mark-as-watched` — Mark Story as Watched
- `POST /api/{account}/stories` — Add to Story
- `DELETE /api/{account}/stories/{story_id}` — Delete Story

## Highlights — 7

- `GET /api/{account}/stories/highlights` — List Story Highlights
- `GET /api/{account}/stories/highlights/{highlight_id}` — Show Story Highlight
- `POST /api/{account}/stories/highlights` — Create Story Highlight
- `PUT /api/{account}/stories/highlights/{highlight_id}` — Update Story Highlight
- `DELETE /api/{account}/stories/highlights/{highlight_id}` — Delete Story Highlight
- `PATCH /api/{account}/stories/highlights/{highlight_id}/{story_id}` — Add Story to Highlight
- `DELETE /api/{account}/stories/highlights/{highlight_id}/{story_id}` — Remove Story from Highlight

## Пакеты подписок — 3

- `GET /api/{account}/bundles` — List Bundles
- `POST /api/{account}/bundles` — Create Bundle
- `DELETE /api/{account}/bundles/{bundle_id}` — Delete Bundle

## Tracking-ссылки — 8

- `GET /api/{account}/tracking-links/{tracking_link_id}/stats` — Get Tracking Link Stats
- `GET /api/{account}/tracking-links/{tracking_link_id}/cohort-arps` — Get Tracking Link Cohort ARPS
- `GET /api/{account}/tracking-links/{tracking_link_id}/tags` — List Tracking Link Tags
- `GET /api/{account}/tracking-links/{tracking_link_id}` — Get Tracking Link
- `POST /api/{account}/tracking-links/{tracking_link_id}/tags` — Add Tracking Link Tags
- `DELETE /api/{account}/tracking-links/{tracking_link_id}/tags` — Remove Tracking Link Tags
- `POST /api/{account}/tracking-links` — Create Tracking Link
- `DELETE /api/{account}/tracking-links/{tracking_link_id}` — Delete Tracking Link

## Управление списками пользователей — 9

- `GET /api/{account}/user-lists/{userListId}` — Get User List
- `GET /api/{account}/user-lists/{userListId}/users/pinned` — List Pinned Users in User List
- `POST /api/{account}/user-lists` — Create User List
- `PUT /api/{account}/user-lists/{userListId}` — Update User List
- `DELETE /api/{account}/user-lists/{userListId}` — Delete User List
- `POST /api/{account}/user-lists/{userListId}/users` — Add Users to User List
- `DELETE /api/{account}/user-lists/{userListId}/users` — Clear User List
- `DELETE /api/{account}/user-lists/{userListId}/users/{userId}` — Remove User from a User List
- `POST /api/{account}/user-lists/{userListId}/users/{userId}/pin` — Pin/Unpin User in User List

## Блокировка и подписка на пользователей — 6

- `POST /api/{account}/users/{user_id}/restrict` — Restrict User
- `DELETE /api/{account}/users/{user_id}/restrict` — Unrestrict User
- `POST /api/{account}/users/{user_id}/block` — Block User
- `DELETE /api/{account}/users/{user_id}/block` — Unblock User
- `POST /api/{account}/users/{user_id}/subscribe` — Subscribe to User
- `DELETE /api/{account}/users/{user_id}/subscribe` — Unsubscribe from User

## Каталог, доставки и повторная доставка вебхуков — 4

- `GET /api/webhooks/events` — List Available Events
- `GET /api/webhooks/{webhook_id}/deliveries` — List Webhook Deliveries
- `POST /api/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver` — Redeliver Webhook Delivery
- `DELETE /api/webhooks/{webhook_id}` — Delete Webhook

## Исключения из продуктового списка — 3

- `POST /api/webhooks/vatstack` — внутренний callback самого поставщика, не недостающая функция Hub.
- `POST /api/webhooks/coingate` — внутренний callback самого поставщика, не недостающая функция Hub.
- `POST /api/{account}/media/scrape` — deprecated; не следует добавлять как новую интеграцию.

Вебхуки-события — отдельный перечень, они не добавляются к числу HTTP endpoints: [каталог поддержки событий](webhook-audit.md#event-coverage). Источник списка — [полная матрица](inventory/endpoint-matrix.json).


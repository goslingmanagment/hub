# Изменения схемы OFAPI относительно июньского снимка

Основной план: [PLAN.md](../../investigations/ofapi-support-refresh-2026-09-05/PLAN.md).

Baseline: 266 операций; current: 294, включая два внутренних callback. +29 / −1 буквально; 26 новых публичных операций после исключения callback и переименования параметра attach-tags. У 79 общих операций есть изменения; 9 только в примерах. Остальные включают prose/format/type/contract drift и не равны 70 новым функциям.

## Добавления

| Method/path | Операция | Классификация | Источник |
|---|---|---|---|
| `GET /api/banned-words` | List Banned Words | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/banned-words/list-banned-words) |
| `GET /api/{account}/users/blocked` | List Blocked Users | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/blocked-restricted-users/list-blocked-users) |
| `GET /api/{account}/users/restricted` | List Restricted Users | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/blocked-restricted-users/list-restricted-users) |
| `POST /api/{account}/messages/{queue_id}/attach-tags` | Attach Tags (Release Forms) to Message | Переименование параметра; тот же URL shape | [документация](https://docs.onlyfansapi.com/api-reference/chat-messages/attach-tags-release-forms-to-message) |
| `PUT /api/authenticate/{account_id}/credentials` | Update Authentication Credentials | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/connect-onlyfans-account/update-authentication-credentials) |
| `POST /api/webhooks/vatstack` | Handle a Vatstack webhook delivery. These report the outcome of validations that could not complete synchronously because the government registry was down at the time of the request. | Внутренний callback; исключён | provider OpenAPI |
| `POST /api/webhooks/coingate` | Handle a CoinGate payment callback. | Внутренний callback; исключён | provider OpenAPI |
| `GET /api/fan-summary-categories` | List Custom Summary Categories | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/fans-ai-summary/list-custom-summary-categories) |
| `POST /api/fan-summary-categories` | Create Custom Summary Category | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/fans-ai-summary/create-custom-summary-category) |
| `PUT /api/fan-summary-categories/{category_id}` | Update Custom Summary Category | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/fans-ai-summary/update-custom-summary-category) |
| `DELETE /api/fan-summary-categories/{category_id}` | Delete Custom Summary Category | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/fans-ai-summary/delete-custom-summary-category) |
| `GET /api/{account}/media/download/drm/{media_id}` | Download DRM-protected Media | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/media/download-drm-protected-media) |
| `GET /api/{account}/release-forms` | List Release Forms | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/release-forms/list-release-forms) |
| `GET /api/{account}/release-forms/mentions` | List Mentions | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/release-forms/list-mentions) |
| `PATCH /api/{account}/release-forms/toggle-show` | Hide / Unhide Release Form | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/release-forms/hide-unhide-release-form) |
| `PATCH /api/{account}/release-forms/rename` | Rename Release Form | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/release-forms/rename-release-form) |
| `GET /api/{account}/settings/drm` | Get DRM Status | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/settings/get-drm-status) |
| `PATCH /api/{account}/settings/drm` | Enable/Disable DRM | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/settings/enable-disable-drm) |
| `GET /api/smart-links/{smart_link_id}/pixels` | List Smart Link Pixels | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/list-smart-link-pixels) |
| `POST /api/smart-links/{smart_link_id}/pixels` | Create Smart Link Pixel | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/create-smart-link-pixel) |
| `PATCH /api/smart-links/{smart_link_id}/pixels/{pixel_id}` | Update Smart Link Pixel | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/update-smart-link-pixel) |
| `DELETE /api/smart-links/{smart_link_id}/pixels/{pixel_id}` | Disconnect Smart Link Pixel | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/disconnect-smart-link-pixel) |
| `POST /api/smart-links/{smart_link_id}/pixels/{pixel_id}/test-event` | Send Smart Link Pixel Test Event | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/send-smart-link-pixel-test-event) |
| `GET /api/smart-links/{smart_link_id}/tags` | List Smart Link Tags | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/list-smart-link-tags) |
| `POST /api/smart-links/{smart_link_id}/tags` | Add Smart Link Tags | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/add-smart-link-tags) |
| `DELETE /api/smart-links/{smart_link_id}/tags` | Remove Smart Link Tags | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/smart-links/remove-smart-link-tags) |
| `GET /api/usage/credits` | Get Credit Usage | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/usage/get-credit-usage) |
| `GET /api/webhooks/{webhook_id}/deliveries` | List Webhook Deliveries | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/webhooks/list-webhook-deliveries) |
| `POST /api/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver` | Redeliver Webhook Delivery | Новая публичная операция | [документация](https://docs.onlyfansapi.com/api-reference/webhooks/redeliver-webhook-delivery) |

## Удалённый буквальный path

`POST /api/{account}/messages/{message_id}/attach-tags` заменён на `{queue_id}`. Это не удаление функции. Перед использованием требуется проверить, какой remote ID принимает операция.

## Изменённые общие операции

Этот список фиксирует область последующего review. Примеры ответов и формулировки могут меняться без изменения runtime; содержательные изменения учтены в этапах S1–S12.

| Операция | Что изменилось в snapshot |
|---|---|
| `POST /api/analytics/financial/profitability` | .responses.200.content.application/json.schema.items; .responses.200.content.application/json.schema.properties; .responses.200.content.application/json.schema.type |
| `GET /api/analytics/financial/profitability/{account}/history` | .responses.200.content.application/json.schema.items; .responses.200.content.application/json.schema.properties; .responses.200.content.application/json.schema.type |
| `POST /api/analytics/summary/comparison` | Только примеры |
| `GET /api/{account}/banking/available-payout-systems` | .responses.200.content.application/json.schema.properties.data.properties.payouts.items.properties.fields.properties; .responses.200.content.application/json.schema.properties.data.properties.payouts.items.properties.uiMapping.properties |
| `GET /api/{account}/chats/{chat_id}/messages` | .parameters |
| `POST /api/{account}/chats/{chat_id}/messages` | .description; .parameters; .requestBody.content.application/json.schema.properties.blockBannedWords; .requestBody.content.application/json.schema.properties.price.description; .requestBody.content.application/json.schema.properties.price.type; .responses.409 |
| `GET /api/{account}/chats` | .parameters |
| `GET /api/{account}/chats/{chat_id}/media` | .parameters |
| `POST /api/{account}/chats/{chat_id}/typing` | .description |
| `POST /api/client-sessions` | .requestBody.content.application/json.schema.properties.proxy_country.enum |
| `POST /api/authenticate` | .requestBody.content.application/json.schema.properties.proxyCountry.enum |
| `GET /api/data-exports` | .parameters |
| `POST /api/data-exports` | .requestBody.content.application/json.schema.properties.account_ids.description; .requestBody.content.application/json.schema.properties.file_type.description; .requestBody.content.application/json.schema.properties.options.description; .requestBody.content.application/json.schema.properties.options.properties; .requestBody.content.application/json.schema.properties.type.description; .requestBody.content.application/json.schema.properties.type.enum |
| `GET /api/{account}/engagement/messages/mass-messages` | .parameters |
| `GET /api/{account}/engagement/messages/direct-messages` | .parameters |
| `GET /api/{account}/engagement/messages/mass-messages/chart` | .parameters |
| `GET /api/{account}/engagement/messages/direct-messages/chart` | .parameters |
| `GET /api/{account}/engagement/messages/top-message` | .parameters |
| `GET /api/{account}/engagement/messages/{message_id}/buyers` | .parameters |
| `GET /api/{account}/fans/all` | .description; .parameters |
| `GET /api/{account}/fans/active` | .description; .parameters |
| `GET /api/{account}/fans/expired` | .description; .parameters |
| `GET /api/{account}/fans/latest` | .parameters |
| `GET /api/{account}/fans/top` | .parameters |
| `GET /api/{account}/fans/{fan_id}/summary` | .responses.200.content.application/json.schema.properties.custom_fields; .responses.200.content.application/json.schema.properties.last_buy_date; .responses.200.content.application/json.schema.properties.summary_data.properties.content_dislikes; .responses.200.content.application/json.schema.properties.summary_data.properties.dos_and_donts; .responses.200.content.application/json.schema.properties.summary_data.properties.spend_cadence |
| `GET /api/{account}/following/all` | .description; .parameters |
| `GET /api/{account}/following/active` | .description; .parameters |
| `GET /api/{account}/following/expired` | .description; .parameters |
| `GET /api/{account}/trial-links` | .parameters |
| `GET /api/link-tags` | .description; .parameters |
| `GET /api/{account}/mass-messaging/overview` | .parameters |
| `GET /api/{account}/mass-messaging` | .description |
| `POST /api/{account}/mass-messaging` | .requestBody.content.application/json.schema.properties.blockBannedWords; .requestBody.content.application/json.schema.properties.price.description; .requestBody.content.application/json.schema.properties.price.type; .requestBody.content.application/json.schema.properties.subscribedWithinLastDays |
| `GET /api/{account}/mass-messaging/{id}` | .description |
| `PUT /api/{account}/mass-messaging/{id}` | .description; .requestBody.content.application/json.schema.properties.blockBannedWords; .requestBody.content.application/json.schema.properties.price.description; .requestBody.content.application/json.schema.properties.price.type |
| `POST /api/{account}/media/upload` | .requestBody.content.multipart/form-data.schema.properties.async.description |
| `GET /api/{account}/media/uploads/{upload}/status` | .description; .responses.200.content.application/json.schema.oneOf |
| `POST /api/{account}/media/vault` | .requestBody.content.multipart/form-data.schema.properties.async.description |
| `GET /api/{account}/media/vault/lists` | .description; .parameters; .responses.200.content.application/json.schema.oneOf; .responses.200.content.application/json.schema.properties; .responses.200.content.application/json.schema.type; .responses.304 |
| `GET /api/{account}/notifications` | .parameters |
| `GET /api/{account}/payouts/earning-statistics` | Только примеры |
| `POST /api/{account}/posts` | .requestBody.content.application/json.schema.properties.blockBannedWords |
| `PUT /api/{account}/posts/{post_id}` | .requestBody.content.application/json.schema.properties.blockBannedWords |
| `GET /api/profiles/{username}` | Только примеры |
| `GET /api/search` | .parameters |
| `GET /api/{account}/queue` | .description; .parameters |
| `POST /api/{account}/release-forms/create-invitation-link` | Только примеры |
| `POST /api/{account}/release-forms/create-release-form` | Только примеры |
| `GET /api/{account}/release-forms/taggable-users` | .description; .responses.200.content.application/json.schema.properties._pagination.properties.notice; .responses.200.content.application/json.schema.properties.data.properties.hasMore |
| `PATCH /api/{account}/saved-for-later/messages/settings/enable-or-update-automatic-messaging` | Только примеры |
| `PATCH /api/{account}/saved-for-later/posts/settings/enable-or-update-automatic-posting` | Только примеры |
| `GET /api/{account}/shared-trial-links` | .parameters |
| `GET /api/{account}/shared-tracking-links` | .parameters |
| `GET /api/smart-link-postbacks` | .responses.200.content.application/json.schema.properties.data.items.properties.body; .responses.200.content.application/json.schema.properties.data.items.properties.headers; .responses.200.content.application/json.schema.properties.data.items.properties.http_method; .responses.200.content.application/json.schema.properties.data.items.properties.traffic_source_ids; .responses.200.content.application/json.schema.properties.data.items.properties.traffic_sources |
| `POST /api/smart-link-postbacks` | .requestBody.content.application/json.schema.properties.body; .requestBody.content.application/json.schema.properties.headers; .requestBody.content.application/json.schema.properties.http_method; .requestBody.content.application/json.schema.properties.url.description; .responses.200.content.application/json.schema.properties.data.properties.body; .responses.200.content.application/json.schema.properties.data.properties.headers; .responses.200.content.application/json.schema.properties.data.properties.http_method; .responses.200.content.application/json.schema.properties.data.properties.traffic_source_ids; +1 других полей схемы |
| `GET /api/smart-link-postbacks/{postback_id}` | .responses.200.content.application/json.schema.properties.data.properties.body; .responses.200.content.application/json.schema.properties.data.properties.headers; .responses.200.content.application/json.schema.properties.data.properties.http_method; .responses.200.content.application/json.schema.properties.data.properties.traffic_source_ids; .responses.200.content.application/json.schema.properties.data.properties.traffic_sources |
| `PATCH /api/smart-link-postbacks/{postback_id}` | .requestBody.content.application/json.schema.properties.body; .requestBody.content.application/json.schema.properties.headers; .requestBody.content.application/json.schema.properties.http_method; .responses.200.content.application/json.schema.properties.data.properties.body; .responses.200.content.application/json.schema.properties.data.properties.headers; .responses.200.content.application/json.schema.properties.data.properties.http_method; .responses.200.content.application/json.schema.properties.data.properties.traffic_source_ids; .responses.200.content.application/json.schema.properties.data.properties.traffic_sources |
| `GET /api/smart-links` | .parameters |
| `POST /api/smart-links` | .responses.200.content.application/json.schema.properties.data.properties.revenue.nullable |
| `GET /api/smart-links/{smart_link_id}/fans` | .parameters; .responses.200.content.application/json.schema.properties.data.properties.filters.properties.previously_subscribed; .responses.200.content.application/json.schema.properties.data.properties.filters.properties.subscribed_using_promo; .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.subscription_insights; .responses.200.content.application/json.schema.properties.data.properties.summary.properties.fans_with_1_plus_messages_total |
| `GET /api/smart-links/{smart_link_id}/clicks` | .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.gbraid; .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.sccid; .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.wbraid |
| `GET /api/smart-links/{smart_link_id}/conversions` | .parameters; .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.click.properties.gbraid; .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.click.properties.sccid; .responses.200.content.application/json.schema.properties.data.properties.rows.items.properties.click.properties.wbraid |
| `GET /api/{account}/statistics/total-transactions` | .parameters |
| `GET /api/{account}/statistics/subscriber-metrics` | .parameters |
| `GET /api/{account}/statistics/statements/earnings` | .parameters |
| `GET /api/{account}/statistics/reach/profile-visitors` | .parameters |
| `GET /api/{account}/stored/trial-links` | .parameters |
| `GET /api/{account}/stored/shared-trial-links` | .parameters |
| `GET /api/{account}/stored/shared-tracking-links` | .parameters |
| `GET /api/{account}/stored/tracking-links` | .parameters |
| `POST /api/{account}/stories` | .description; .requestBody.content.application/json.schema.properties.canvasHeight; .requestBody.content.application/json.schema.properties.canvasWidth; .requestBody.content.application/json.schema.properties.mediaFiles.description; .requestBody.content.application/json.schema.properties.question; .requestBody.content.application/json.schema.properties.texts; .responses.200.content.application/json.schema.properties.data.properties.canvasHeight; .responses.200.content.application/json.schema.properties.data.properties.canvasWidth; +5 других полей схемы |
| `GET /api/{account}/tracking-links` | .parameters |
| `GET /api/{account}/transactions` | .parameters |
| `GET /api/{account}/user-lists` | .description; .parameters |
| `POST /api/{account}/user-lists` | Только примеры |
| `POST /api/{account}/user-lists/{userListId}/users` | .requestBody.content.application/json.schema.properties.skip_invalid; .responses.200.content.application/json.schema.oneOf; .responses.200.content.application/json.schema.properties; .responses.200.content.application/json.schema.type; .responses.400.description |
| `GET /api/webhooks/events` | Только примеры |
| `POST /api/webhooks` | .requestBody.content.application/json.schema.properties.account_ids.description; .requestBody.content.application/json.schema.properties.account_scope.description; .requestBody.content.application/json.schema.properties.events.description |
| `PUT /api/webhooks/{webhook_id}` | .requestBody.content.application/json.schema.properties.account_ids.description; .requestBody.content.application/json.schema.properties.account_scope.description; .requestBody.content.application/json.schema.properties.events.description |

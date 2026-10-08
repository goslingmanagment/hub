# Fansly API Specification

> Reverse-engineered from FBuddy browser extension v0.1.129 and Fansly Python SDK.
> Last updated: 2026-03-05

---

## 1. Overview

### Base URLs

| Service | URL |
|---------|-----|
| REST API | `https://apiv3.fansly.com/api/v1` |
| Media Upload API | `https://mediav2.fansly.com/api/v1` |
| CDN (media) | `https://cdn3.fansly.com` |
| Chat WebSocket | `wss://chatws.fansly.com?v=3` |
| DM WebSocket | `wss://wsv3.fansly.com/?v=3` |
| Website | `https://fansly.com` |
| Emoji assets | `https://fansly.com/assets/emoji/{category}/{name}.svg` |

### Presence / Online Status

Fansly does expose real-time transports, but the reverse-engineered traffic does
not show a first-class per-user presence API that emits explicit
`online`/`offline` events for arbitrary accounts.

What is confirmed in this spec:
- **Real-time delivery exists** via DM and live chat WebSockets.
- **Typing exists** via `POST /message/typing`.
- **Live streaming presence exists** via `GET /streaming/followingstreams/online`
  and chatroom APIs.
- **Recent activity exists** via `lastSeenAt` fields observed in account/follower
  payloads.

Practical implication: "online status" can likely be approximated from
`lastSeenAt`, DM activity, typing, or livestream/chat presence, but it should
not be described as a confirmed dedicated presence API unless traffic shows a
specific endpoint or WebSocket event for that.

### Response Envelope

All REST API responses use a standard envelope:

```json
{
  "success": true,
  "response": { ... }
}
```

On error:
```json
{
  "success": false,
  "error": { "code": 99, "message": "..." }
}
```

The SDK unwraps the `response` field automatically.

### Authentication

- **Token source**: Stored in `localStorage` under key `session_active_session` as JSON `{ "token": "<base64_token>" }`.
- **Header**: `authorization: <token>` (raw value, no `Bearer` prefix).
- **Timestamp header**: `fansly-client-ts: <unix_ms>` (current time in milliseconds).

### Required Headers

| Header | Description | Source |
|--------|-------------|--------|
| `authorization` | Auth token (base64-encoded) | localStorage session |
| `fansly-client-ts` | Current timestamp in ms | Generated client-side |
| `fansly-client-id` | Client identifier | Injected by Fansly app (opaque) |
| `fansly-client-check` | Client integrity check | Injected by Fansly app (opaque) |
| `fansly-session-id` | Session identifier | Injected by Fansly app (opaque) |
| `Accept` | `application/json, text/plain, */*` | Standard |
| `Content-Type` | `application/json` (for POST) | Standard |
| `Referrer` | `https://fansly.com/` | Browser default |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Browser default |

The `fansly-client-id`, `fansly-client-check`, and `fansly-session-id` headers are set by the Fansly web application itself. FBuddy intercepts them from network requests via the `fbuddy-network-hook.js` injection script and reuses them for its own API calls.

### Fetch Options

```javascript
{
  mode: "cors",
  credentials: "include",   // sends cookies automatically
  referrer: "https://fansly.com/",
  referrerPolicy: "strict-origin-when-cross-origin"
}
```

### Global Query Parameter

All requests include `ngsw-bypass=true` to bypass Angular service worker caching.

### Money Representation

- **Wallet balances**: In **cents** (divide by 100 for USD). Source: `AccountResource.wallets()` docstring.
- **Earnings/transactions**: In **mills** (divide by 1000 for USD). Source: `EarningsResource` docstring.
- **Tips in messages**: `totalTipAmount` field in cents (divide by 100).

### Timestamp Representation

All timestamps are in **milliseconds** (Unix epoch ms), except:
- `Post.createdAt`: In **seconds** (Unix epoch). FBuddy multiplies by 1000 (`g.createdAt*1e3`).

### IDs

All entity IDs are **string-encoded 64-bit integers** (e.g., `"737077689877278720"`).

---

## 2. Endpoints by Group

### 2.1 Account

#### GET /account/me
Get the authenticated user's full account information.

**Response:**
```json
{
  "account": {
    "id": "string",
    "username": "string",
    "displayName": "string",
    "subscriberCount": 42,
    "walls": [{ "id": "string" }],
    "notes": [{ "id": "string", "title": "string", "note": "string" }]
  },
  "wallets": [],
  "subscriptionTiers": []
}
```

#### GET /account
Get accounts by IDs or usernames.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string | One of ids/usernames | Comma-separated account IDs |
| `usernames` | string | One of ids/usernames | Comma-separated usernames (case-insensitive) |

**Response:** Array of account objects. Batch limit: 100 per request (FBuddy chunks at 100).

#### GET /account/{accountId}/wallets
Get wallets for a specific account.

**Response:** Array of wallet objects.
```json
[
  { "type": 1, "balance": 10000 },
  { "type": 2, "balance": 5000 }
]
```
- Type 1 = Main wallet
- Type 2 = Earnings wallet
- Balance in cents.

#### GET /account/walls
Get account walls/timelines (content categories).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `correlationPostIds` | string | No | Correlation post IDs |

**Response:** Array of wall objects `{ "id": "string", "name": "string" }`.

#### GET /account/search
Search for accounts.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `limit` | int | No | Max results (default 100) |
| `offset` | int | No | Pagination offset |

**Response:** Array of account objects.

#### POST /account/ignore
Set ignore/block flags for an account.

**Request Body:**
```json
{
  "ignoredId": "string",
  "ignoreFlags": 1
}
```

#### GET /account/media
Get account media by IDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string | Yes | Comma-separated account media IDs |

**Response:** Array of account media objects.

#### POST /account/media
Create account media (link uploaded media to account).

**Request Body:**
```json
[{
  "mediaId": "string",
  "previewId": null,
  "permissionFlags": 0,
  "price": 0,
  "whitelist": [],
  "permissions": { "permissionFlags": [] },
  "tags": []
}]
```

#### GET /account/media/bundle
Get account media bundles by IDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string | Yes | Comma-separated bundle IDs |

#### POST /account/media/bundle
Create account media bundle.

#### POST /account/media/permissions
Edit permissions for a single account media item.

**Request Body:**
```json
{
  "id": "string",
  "mediaId": "string",
  "previewId": null,
  "permissionFlags": 0,
  "price": 0,
  "whitelist": [],
  "permissions": { "permissionFlags": [] },
  "tags": []
}
```

#### POST /account/media/bundle/permissions
Edit permissions for a media bundle.

---

### 2.2 Messaging

#### GET /messaging/groups
List DM conversation groups.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `limit` | int | No | 20 | Results per page (max 100) |
| `offset` | int | No | 0 | Pagination offset |
| `sortOrder` | int | No | 1 | Sort order (0 or 1) |
| `flags` | int | No | 0 | Filter flags (0=all, 32=unread only) |
| `search` | string | No | | Username search query |
| `subscriptionTierId` | string | No | | Filter by subscription tier |
| `listIds` | string | No | | Comma-separated list IDs |

**Response:**
```json
{
  "data": [
    {
      "id": "string",
      "partnerUsername": "string",
      "unreadCount": 0,
      "lastMessage": { "content": "..." }
    }
  ],
  "aggregationData": { "total": 100 }
}
```

**Pagination:** Offset-based. Increment `offset` by `limit`.

#### GET /group/{groupId}
Get detailed information about a specific conversation.

**Response:**
```json
{
  "id": "string",
  "type": 1,
  "groupFlags": 0,
  "groupFlagsMetadata": "",
  "createdBy": "string",
  "users": [{ "userId": "string", "permissionFlags": 0 }],
  "permissionFlags": [],
  "recipients": [],
  "userSettings": { "customName": null, "hidden": false },
  "lastMessage": { "content": "..." },
  "hasDmPermissionFlags": false,
  "partnerMissingDmPermissionFlagsChecked": false,
  "dmPermissionFlags": [],
  "accountDmPermissionFlags": { "flags": 0, "metadata": "" }
}
```
- `type`: 1 = DM

#### POST /group
Create a new DM conversation group.

**Request Body:**
```json
{
  "users": [
    { "userId": "target_account_id", "permissionFlags": 0 },
    { "userId": "my_account_id", "permissionFlags": 0 }
  ],
  "recipients": [],
  "lastMessage": null,
  "userSettings": null,
  "type": 1
}
```

**Error:** Code 99 = DM permissions denied.

#### GET /message
Get messages in a conversation.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `groupId` | string | Yes | | Conversation group ID |
| `limit` | int | No | 25 | Number of messages |
| `before` | string | No | | Message ID cursor (get messages before this) |

**Response:**
```json
{
  "messages": [{
    "id": "string",
    "type": 1,
    "dataVersion": 0,
    "content": "string",
    "groupId": "string",
    "senderId": "string",
    "correlationId": "string",
    "inReplyTo": null,
    "inReplyToRoot": null,
    "createdAt": 1234567890000,
    "attachments": [],
    "embeds": [],
    "interactions": [],
    "likes": [],
    "totalTipAmount": 0
  }],
  "accountMedia": [],
  "accountMediaBundles": [],
  "tips": [],
  "tipGoals": [],
  "accountMediaOrders": [],
  "stories": [],
  "storyOrders": []
}
```

**Pagination:** Cursor-based. Use `before` = last message's `id`.

#### POST /message
Send a message.

**Request Body:**
```json
{
  "type": 1,
  "groupId": "string",
  "content": "string",
  "attachments": [],
  "likes": [],
  "scheduledFor": 0,
  "inReplyTo": null,
  "createdAt": 1234567890000
}
```

#### POST /message/ack
Mark messages as read.

**Request Body:**
```json
{
  "messageIds": ["msg_id_1", "msg_id_2"],
  "type": 2
}
```
- `type`: 2 = read acknowledgment

#### POST /message/typing
Send typing indicator.

**Request Body:**
```json
{ "groupId": "string" }
```

#### GET /message/unread
Get unread message summary.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `limit` | int | No | 100 | |
| `offset` | int | No | 0 | |
| `before` | string | No | "0" | |

#### POST /message/delete
Delete a message.

**Request Body:**
```json
{
  "messageId": "string",
  "id": "string"
}
```

#### GET /message/automated
Get configured automated messages (welcome messages, etc.).

**Response:** Array of automated message configs:
```json
[{
  "id": "string",
  "accountId": "string",
  "triggerType": 3,
  "triggerMetadata": "",
  "delay": 0,
  "cooldown": 0,
  "messageTemplate": {
    "type": 1,
    "content": "string",
    "attachments": [],
    "senderId": "string"
  }
}]
```
- `triggerType`: 3 = new subscription

#### POST /message/broadcast
Broadcast/mass DM. [NEEDS TESTING]

---

### 2.3 Subscribers (Creator Endpoints)

#### GET /subscribers
Get list of subscribers (for creators).

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `status` | string | No | "3,4" | Comma-separated status codes |
| `limit` | int | No | 100 | Results per page (max 100) |
| `offset` | int | No | 0 | Pagination offset |
| `search` | string | No | | Username search |
| `subscriptionTierId` | string | No | | Filter by tier |
| `before` | string | No | | Pagination cursor (timestamp) |
| `after` | string | No | | Pagination cursor (timestamp) |

**Response:**
```json
{
  "stats": { "totalActive": 10, "totalExpired": 5, "total": 15 },
  "subscriptions": [{
    "id": "string",
    "subscriberId": "string",
    "subscriptionTierName": "string",
    "status": 3
  }]
}
```

**Pagination:** Offset-based. Increment `offset` by `limit`.

---

### 2.4 Subscriptions (User's Subscriptions)

#### GET /subscriptions
Get all subscriptions the authenticated user has purchased.

**Response:**
```json
{
  "stats": { "totalActive": 5 },
  "subscriptions": [{
    "subscriptionTierName": "Premium",
    "status": 3
  }],
  "subscriptionPlans": []
}
```

#### GET /subscriptions/tiers
Get subscription tier information for the authenticated account.

#### GET /subscriptions/giftcodes
Gift codes issued for the authenticated creator's subscriptions. 73 codes observed
(2026-08-19).

**Shape caution:** `original_price` arrives **snake_case amid otherwise camelCase keys**. Read
it by its literal served name; a camelCase normalizer silently drops it, and it is money.

---

### 2.5 Followers

#### GET /account/{accountId}/followersnew
Get followers for an account.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `limit` | int | No | 100 | Max results (max 100) |
| `offset` | int | No | 0 | Pagination offset |
| `before` | string | No | "0" | Pagination cursor (timestamp) |
| `after` | string | No | "0" | Pagination cursor (timestamp) |
| `search` | string | No | | Username search |
| `lastSeenAfter` | int | No | | Filter by last seen timestamp (ms) |

**Response:**
```json
{
  "followers": [
    { "id": "follow1", "followerId": "user1" }
  ],
  "aggregationData": {
    "accounts": [
      { "id": "user1", "username": "testuser1", "displayName": "Test User" }
    ]
  }
}
```

**Pagination:** Offset-based. Increment `offset` by `limit`.

---

### 2.6 Content (Posts, Timeline, Vault, Stories)

#### GET /post
Get posts by IDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string | Yes | Comma-separated post IDs |

**Response:**
```json
{
  "posts": [{
    "id": "string",
    "content": "string",
    "createdAt": 1234567890,
    "wallIds": [],
    "attachments": [],
    "fypFlags": 0,
    "pinned": 0
  }],
  "accountMediaBundles": [],
  "accountMedia": [],
  "accounts": [],
  "tips": []
}
```

Note: `createdAt` in posts is in **seconds** (not milliseconds).

#### POST /post
Create a new post.

**Request Body:**
```json
{
  "content": "string",
  "wallIds": ["wall_id"],
  "attachments": [],
  "fypFlags": 0,
  "inReplyTo": null,
  "quotedPostId": null,
  "scheduledFor": 0,
  "expiresAt": 0,
  "postReplyPermissionFlags": [],
  "pinned": 0,
  "pinWallIds": []
}
```

#### GET /post/{postId}/replies
List the replies (comments) on one post. **Takes no query parameters** — verified against all
five observed GETs in the 2026-08-19/21 captures.

**The `POST /postreply/verify` pairing — SETTLED, and the answer matters.** All 5 captured GETs
were preceded ~40 ms earlier by `POST /api/v1/postreply/verify {"inReplyTo":"<same post id>"}`,
so the capture alone does not prove a bare GET works. It was settled live on 2026-08-21
(probe [E1], `lora-1`, through the page's own proxy, against a post whose replies HAD been
served with the verify POST): **the bare GET returns 200 without it.** `POST /postreply/verify`
stays on the no-mutations exclusion list and is never issued.

**Response:**
```json
{
  "posts": [{
    "id": "string",
    "accountId": "string",
    "content": "string",
    "createdAt": 1234567890,
    "inReplyTo": "parent_post_id",
    "inReplyToRoot": "root_post_id",
    "attachments": [],
    "accountMentions": [],
    "likeCount": 0,
    "mediaLikeCount": 0,
    "totalTipAmount": 0,
    "attachmentTipAmount": 0,
    "fypFlags": 0,
    "replyPermissionFlags": []
  }],
  "accounts": []
}
```

Each reply is a **full post object**. `createdAt` is in **seconds**. Journal both `inReplyTo`
and `inReplyToRoot` — they are the thread structure.

**`accounts[]` is UNRELIABLE.** It was **EMPTY in 2 of 5** captured responses despite a comment
existing, so author hydration is not guaranteed and a fallback `GET /account?ids=` batch path is
mandatory. When it IS populated it embeds the author as a full account record — including
`lastSeenAt`, `notes`, `containingLists`, `subscriberSubscription`, `statusId` and the
follower/subscriber counters. **The [A20] field allowlist applies to this array before
journaling**, for the same reason it applies to the conversation lane: `lastSeenAt` changes every
minute and would make every body unique.

**Pagination is UNESTABLISHED.** Observed `posts[]` lengths were 1/1/4 with bodies 0.5–18.2 KB;
no captured response was large enough to reveal a cursor. Do not assume one exists, and do not
assume its absence.

**"No replies" is not live-proven.** No GET anywhere in the capture returned 204 (all 197 204s
are OPTIONS preflights). Handle 200-with-empty-`posts[]`, 204, and an empty body all as "no
replies"; none of the three is live-observed on this route.

#### GET /post/scheduled
Get scheduled posts.

**Response:**
```json
{ "scheduledPosts": [] }
```

#### POST /post/scheduled/{postId}/cancel
Cancel a scheduled post.

#### GET /timeline/home
Get home feed.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `before` | string | No | "0" | Pagination cursor (post ID) |
| `after` | string | No | "0" | Pagination cursor |
| `mode` | int | No | 0 | Timeline mode |

**Response:** Same structure as GET /post.

#### GET /timelinenew/{accountId}
Get timeline for a specific account.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `before` | string | No | Pagination cursor (post ID) |
| `after` | string | No | Pagination cursor |
| `wallId` | string | No | Filter by wall ID |
| `contentSearch` | string | No | Content search query |

**Pagination:** Cursor-based. Use `before` = last post's `id`.

#### GET /timeline/permissions
Get timeline access permissions.

#### GET /uservault/albumsnew
Get user's vault albums (legacy endpoint).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `accountId` | string | No | Account ID (defaults to current user) |

#### GET /vault/albumsnew
Get vault albums (new endpoint, used by FBuddy).

#### POST /vault/albums
Create a vault album.

**Request Body:**
```json
{ "title": "string" }
```

#### POST /vault/albums/edit
Edit a vault album.

#### POST /vault/albums/delete
Delete a vault album.

**Request Body:**
```json
{ "albumId": "string" }
```

#### POST /vault/albums/order
Reorder vault albums.

**Request Body:**
```json
{ "oldPos": 0, "newPos": 1 }
```

#### POST /vault/albums/media
Add media to a vault album.

**Request Body:**
```json
{ "albumId": "string", "mediaIds": ["media_id_1"] }
```

#### POST /vault/albums/media/delete
Remove media from a vault album.

**Request Body:**
```json
{ "albumId": "string", "mediaIds": ["media_id_1"] }
```

#### POST /vault/albums/media/rename
Rename a vault media item.

**Request Body:**
```json
{
  "albumId": "string",
  "mediaId": "string",
  "customFilename": "string"
}
```

#### GET /media/vaultnew
Get media from vault (album or by type).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `albumId` | string | Conditional | Album ID |
| `type` | string | Conditional | Vault type (e.g., `38000` for All) |
| `mediaType` | string | No | Filter by media type |
| `search` | string | No | Search query |
| `before` | string | No | Pagination cursor |
| `after` | string | No | Pagination cursor (default "0") |

#### GET /media
Get raw media by IDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids` | string | Yes | Comma-separated media IDs |

Batched at 25 per request by FBuddy.

#### GET /mediaoffers/location
Get media offers for a location (e.g., DM group).

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `locationId` | string | Yes | | Location ID |
| `locationType` | int | No | 4001 | Location type |
| `accountId` | string | Yes | | Account ID |
| `mediaType` | string | No | "" | Media type filter |
| `before` | string | No | "" | Pagination cursor |
| `after` | string | No | "0" | Pagination cursor |
| `limit` | int | No | 100 | Results per page |
| `offset` | int | No | 0 | Pagination offset |

**Response:**
```json
{
  "data": [{ "id": "string", ... }]
}
```

#### GET /media/orderhistory
Get account media purchase/order history.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `accountMediaId` | string | Conditional | Account media ID |
| `accountMediaBundleId` | string | Conditional | Bundle ID |
| `limit` | int | No | 100 |
| `accountIds` | string | No | Comma-separated buyer account IDs |
| `accountQuery` | string | No | Search buyer username |
| `before` | string | No | Pagination cursor |

#### GET /mediastories/following
Get stories from followed accounts.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `limit` | int | No | 10 | Number of stories |
| `offset` | int | No | 0 | Pagination offset |

#### POST /mediastories
Create a media story. [NEEDS TESTING - exact request body structure]

---

### 2.7 Earnings & Payments

All monetary values in earnings endpoints are in **mills** (divide by 1000 for USD).

#### GET /account/wallets/earnings
Get earnings overview with pending balance.

**Response:**
```json
{ "pendingBalance": 50000, "totalEarnings": 100000 }
```

#### GET /account/wallets/earnings/accounts
Get earnings broken down by subscriber.

Observed live response fields include `totalGross` and `totalNet`. This endpoint exposes the gross/net split directly at the per-subscriber aggregate level.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `before` | string | No | End timestamp (ms) |
| `after` | string | No | Start timestamp (ms) |

#### GET /account/wallets/earnings/stats
Get earnings statistics.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `before` | string | No | End timestamp (ms) |
| `after` | string | No | Start timestamp (ms) |

#### GET /account/wallets/earnings/stats/accounts
Get earnings statistics for a specific subscriber.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `correlationAccountId` | string | Yes | Subscriber's account ID |
| `before` | string | No | End timestamp (ms) |
| `after` | string | No | Start timestamp (ms) |

#### GET /account/wallets/earnings/monthlystats
Get monthly earnings statistics with leaderboard rank.

#### GET /account/wallets/earnings/monthlystats/accounts
Get monthly earnings from a specific subscriber.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `correlationAccountId` | string | Yes | Subscriber's account ID |
| `before` | string | No | End timestamp (ms) |
| `after` | string | No | Start timestamp (ms) |

#### GET /account/wallets/earnings/transactions
Get individual earnings transactions.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `before` | string | No | "" | End timestamp (ms) |
| `after` | string | No | "" | Start timestamp (ms) |
| `limit` | int | No | 50 | Max transactions |
| `offset` | int | No | 0 | Pagination offset |

**Response:**
```json
{
  "total": 100,
  "data": [{
    "amount": 5000,
    "type": 15001
  }]
}
```

Observed live fixtures show `amount` and `destinationAmount` both carrying the creator-net value, while `destinationTax` carries the commission rate in basis points (for example `2000` = 20%). When a separate gross field is absent, derive gross as `net / (1 - commission_rate)`.

**Pagination:** Offset-based.

#### GET /payments/wallets
Get payment wallets.

#### GET /payments/payoutmethods
Get configured payout methods.

#### GET /payments/payout/requests
Get payout request history.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `before` | string | No | | End timestamp (ms) |
| `after` | string | No | | Start timestamp (ms) |
| `limit` | int | No | 10 | Max results |
| `offset` | int | No | 0 | Pagination offset |

#### GET /payouts/documentation
Get payout documentation requirements.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | Comma-separated doc type codes (e.g., "1,2") |

---

### 2.8 Notifications

#### GET /notifications/unack
Get counts of unread notifications by type.

**Response:**
```json
[
  { "type": 5003, "total": 10 },
  { "type": 1004, "total": 5 }
]
```

#### GET /notifications
Get notifications filtered by type.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | No | Comma-separated notification type codes |
| `before` | string | No | Notification ID cursor |
| `after` | string | No | Notification ID cursor |
| `limit` | int | No | 100 |

**Pagination:** Cursor-based. Use `before` = last notification's `id`.

---

### 2.9 Settings

#### GET /settings
Get settings by category IDs.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `categoryIds` | string | Yes | Comma-separated category IDs |

**Response:**
```json
[
  { "categoryId": 2000, "keyId": 1, "value": "true", "metadata": "{...}" }
]
```

#### POST /settings
Update a setting value.

**Request Body:**
```json
{
  "categoryId": "2000",
  "keyId": "1000",
  "value": 1,
  "metadata": "{\"savedPermissionFlags\": [...]}"
}
```

---

### 2.10 Statistics & Analytics

> The creator statistics pages shipped in 2026-10 (`/creator/stats/*`) use a separate family,
> `GET /account/stats/*`, mapped in [fansly-creator-stats/README.md](fansly-creator-stats/README.md).
> The routes below still exist but only the legacy pages call them.

#### GET /it/amoie/stats
Get comprehensive profile and media statistics.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `beforeDate` | int | Yes | | End timestamp (ms) |
| `afterDate` | int | Yes | | Start timestamp (ms) |
| `period` | int | No | 86400000 | Aggregation period in ms (see below) |
| `year` | int | No | 0 | Year filter (0 = none) |
| `month` | int | No | 0 | Month filter (1-12, 0 = none) |

**Period constants:**
- `300000` = 5 minutes
- `3600000` = 1 hour
- `21600000` = 6 hours
- `86400000` = 1 day (default)

**Response:**
```json
{
  "dataset": {
    "datapoints": [{
      "timestamp": 1234567890000,
      "stats": [
        { "type": 0, "views": 100 },
        { "type": 1, "views": 50 }
      ]
    }],
    "profileDatapoints": [],
    "topMediaOffers": [],
    "topFypMediaOffers": [],
    "topFypTags": []
  },
  "aggregationData": {
    "accountMedia": [],
    "accountMediaBundles": [],
    "tags": []
  }
}
```

#### GET /it/moie/statsnew
Get detailed statistics for a specific media item.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mediaOfferId` | string | Yes | | Media offer ID |
| `beforeDate` | int | Yes | | End timestamp (ms) |
| `afterDate` | int | Yes | | Start timestamp (ms) |
| `period` | int | No | 86400000 | Aggregation period (ms) |

**Response:**
```json
{
  "dataset": {
    "datapoints": [{
      "timestamp": 1234567890000,
      "stats": [{ "type": 0, "views": 100 }]
    }],
    "topFypTags": []
  }
}
```

#### POST /it/pis
Track page/content impressions.

**Request Body:**
```json
{ "IS": [{ "type": 1, "contentId": "123456", "timestamp": 1234567890 }] }
```

---

### 2.11 Lists

#### GET /lists/account
Get user's custom lists.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `itemId` | string | No | Filter by item/account ID (empty string = all lists) |

#### GET /lists/itemsnew
Get items in a specific list.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `listId` | string | Yes | | List ID |
| `limit` | int | No | 100 | Max items |
| `after` | string | No | | Pagination cursor |
| `sortMode` | int | No | 3 | Sort mode |

#### POST /lists
Create a new list.

**Request Body:**
```json
{ "label": "string" }
```

#### POST /lists/items/add
Add users to a list.

**Request Body:**
```json
{
  "listItems": [{
    "id": "account_id",
    "listId": "list_id",
    "type": 1
  }]
}
```

FBuddy batches at 25 items per request.

---

### 2.12 Ignore/Block

#### GET /ignore
Get blocked/ignored accounts.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `noAggregation` | string | No | "true" to skip aggregation data |

**Response:**
```json
{
  "ignoring": [{
    "ignoredId": "string",
    "ignoreFlags": 1
  }]
}
```

---

### 2.13 Notes

#### POST /notes
Create a new note.

**Request Body:**
```json
{
  "contentType": 12000,
  "contentId": "account_id",
  "title": "string",
  "note": "string"
}
```

#### POST /notes/edit
Edit an existing note.

**Request Body:**
```json
{
  "id": "note_id",
  "contentType": 12000,
  "contentId": "account_id",
  "title": "string",
  "note": "string"
}
```

---

### 2.14 Media Upload

All upload endpoints use the **Media Upload API** base URL: `https://mediav2.fansly.com/api/v1`

#### POST /media/upload/create
Initiate a multipart media upload.

**Request Body:**
```json
{
  "fileSize": 1234567,
  "mimeType": "image/jpeg",
  "fileName": "photo.jpg"
}
```

**Response:**
```json
{
  "id": "upload_id",
  "type": 1,
  "partSize": 5242880,
  "parts": [{
    "index": 0,
    "uploadUrl": "https://s3.amazonaws.com/..."
  }]
}
```

Upload flow:
1. Call `/media/upload/create` to get upload URLs
2. PUT each chunk directly to the S3 `uploadUrl` (returns ETag in response header)
3. Call `/media/upload/complete` with all part ETags
4. Poll `/media/upload/{id}` until `status >= 6` (Completed)

#### POST /media/upload/complete
Complete a multipart upload.

**Request Body:**
```json
{
  "id": "upload_id",
  "type": 1,
  "partSize": 5242880,
  "status": 0,
  "parts": [{
    "index": 0,
    "eTag": "\"abc123\""
  }],
  "waitForComplete": 0
}
```

#### GET /media/upload/{uploadId}
Check media upload/processing status.

**Response:**
```json
{
  "id": "upload_id",
  "status": 6,
  "mediaId": "string",
  "media": { "id": "string", ... }
}
```

---

### 2.15 Streaming

#### GET /streaming/followingstreams/online
Get live streams from followed accounts.

#### GET /chatroom/chatters
Get chatroom chatters (live chat participants).

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `chatRoomIds` | string | Yes | | Comma-separated chat room IDs |
| `limit` | int | No | 100 | Max results |
| `offset` | int | No | 0 | Pagination offset |
| `search` | string | No | "" | Search by username |

#### GET /chatroom/goal/tips
Get tips for a chatroom goal.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `chatRoomGoalId` | string | Yes | | Goal ID |
| `before` | string | No | "" | Pagination cursor |
| `after` | string | No | "" | Pagination cursor |
| `limit` | int | No | 100 | Max results |
| `offset` | int | No | 0 | Pagination offset |

**Response:**
```json
{
  "chatRoomGoalTips": [{
    "tipId": "string",
    "tipAmount": 1000,
    "accountId": "string",
    "tipMessage": "string",
    "createdAt": 1234567890000
  }],
  "aggregationData": {}
}
```

---

### 2.16 Content Discovery

#### GET /contentdiscovery/suggestions
Get creator suggestions.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `limit` | int | No | 10 | Number of suggestions |
| `offset` | int | No | 0 | Pagination offset |

#### GET /contentdiscovery/livesuggestions
Get live stream suggestions.

#### GET /contentdiscovery/media/suggestionsnew
Get media content suggestions with optional tag filtering.

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `before` | string | No | | Pagination cursor |
| `after` | string | No | | Pagination cursor |
| `tagIds` | string | No | | Comma-separated FYP tag IDs |
| `limit` | int | No | 20 | Results per page |
| `offset` | int | No | 0 | Pagination offset |

---

### 2.17 Utilities

#### GET /versioning
Get API version information.

**Response:**
```json
{ "version": "1.0.0", "latest": "1.1.0" }
```

#### GET /orders/products
Get available products.

#### GET /trackinglinks
Get referral/tracking links with stats.

#### GET /intercom/authorize
Get authorization for Intercom chat integration.

---

### 2.18 Watermarks (Signed URLs)

#### GET /watermarks/signed-url
Get signed URL for watermarked content.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Action type for the signed URL |
| `i` | string | Yes | Item/media identifier |

---

## 3. Constants & Enums

### 3.1 Notification Types

> **Rewritten 2026-08-20. The previous table was wrong on 8 of its 16 codes, including both
> media-purchase events, which it labelled "post like undone/redone".** Source: the notification
> component's own `tabMap` and `filters` arrays in the shipped web client, read directly at
> `main.ac7fcc376bc818b0.js` (pretty-printed lines 192262–192330). The `Filter label` column is
> the platform's own UI string; `Renderer` is the component it dispatches to.

| Code | Filter label | Renderer | Note |
|------|------|------|------|
| 1002 | Likes | Post like | previously mislabelled `MediaLike` — **swapped with 2002** |
| 1003 | *(tab-grouped, no filter label)* | none | unlabelled in this dispatcher |
| 1004 | Post Replies | Post reply | previously mislabelled `MediaLikeUndo` |
| 1005 | Post Quotes | Post quote | previously mislabelled `MediaLikeRedo` |
| 2002 | Likes | Account-media like | previously mislabelled `PostLike` — **swapped with 1002** |
| 2007 | **Media Purchases** | Account-media order | previously mislabelled `PostLikeUndo`. **This is money.** |
| 2008 | **Media Purchases** | Account-media-bundle order | previously mislabelled `PostLikeRedo`. **This is money.** |
| 3002 | Followers | Follow | the code selects which correlation field holds the follower id |
| 3003 | Followers | Follow | as above |
| 5003 | Likes | Message like | unchanged |
| 7001 | Tips | Tip received | unchanged |
| 15006 | Subscribers | Subscription renew | — |
| 15007 | **Expired Subscriptions** | Subscription expire | previously mislabelled `SubscriberRenewalFail` |
| 15011 | **Promotions** | Plan promotion started | previously mislabelled `SubscriptionCanceled` |
| 15016 | Subscribers | Subscription-history renew | — |
| 32007 | **Locked Text Purchases** | component internally named `story-order` | **absent from the previous table. Money.** |
| 45012 | **Stream Ticket Purchases** | Stream-ticket order | **absent from the previous table. Money.** |
| 24001, 24002 | Fansly Alerts | generic admin renderer | absent from the previous table |
| 24001–24999 | *(family)* | generic admin renderer | the whole admin/alert range |

`7100` (TipGoal) appeared in the previous table but is not referenced in this dispatcher. It is
left out rather than carried forward — if it is live, one captured example restores it.

Admin notification metadata recognises these reason strings (`191532–191584`):
`generic_message`, `consent_request_received`, `consent_request_accepted`,
`consent_request_declined`, `consent_request_expired`, `consent_submission_approved`,
`consent_submission_needs_more`, `consent_submission_rejected`, `consent_revoked`,
`consent_sign_completed`, `consent_sign_failed`, `consent_sign_notarization_required`,
`consent_sign_expired`.

**Reading rule.** These are the *client's* labels for its own filter tabs. They prove what the
app believes a code means, not what the server guarantees. A code is promoted to a confirmed
business meaning only after two independent live examples agree with a second source.

### 3.2 Media Types

| Code | Name |
|------|------|
| 0 | Unknown |
| 1 | Image |
| 2 | Video |
| 3 | Audio |

### 3.3 Subscription Statuses

| Code | Name | Description |
|------|------|-------------|
| 1 | Idle | Initial state |
| 2 | CreatingPayment | Payment being created |
| 3 | Active | Active subscription |
| 4 | PaymentCreated | Payment completed, active |
| 5 | Expired | Expired/cancelled |
| 6 | Error | Error state |
| 10 | Activating | Being activated |

### 3.4 Media Upload Status

| Code | Name |
|------|------|
| 0 | Unknown |
| 1 | Created |
| 2 | Uploading |
| 3 | Uploaded |
| 4 | Completing |
| 5 | Processing |
| 6 | Completed |

### 3.5 Message Attachment Types

| Code | Name |
|------|------|
| 1 | AccountMedia |
| 2 | AccountMediaBundle |
| 7 | Tip |
| 8 | QuotedPost |
| 7100 | TipGoal |
| 32001 | Story |
| 42001 | Poll |

### 3.6 Vault Album Types

| Code | Name |
|------|------|
| 1000 | Posts |
| 5000 | Messages |
| 38000 | All |

### 3.7 FYP Flags

| Code | Name |
|------|------|
| 0 | None |
| 2 | Hashtag |
| 4 | Overwrite |

### 3.8 Settings Categories

| Code | Name |
|------|------|
| 2000 | General / Media |
| 4000 | Messaging |
| 5000 | Notifications |
| 12000 | Privacy |
| 44000 | Display |

### 3.9 Settings Keys (under category 2000)

| Code | Name |
|------|------|
| 1000 | Media Permission Presets |
| 1002 | Media Flags Editor Settings |

### 3.10 Transaction Types (Earnings)

| Code | Name | Description |
|------|------|-------------|
| 2010 | MediaLegacy | Media purchase (legacy) |
| 2016 | MediaSetsLegacy | Media bundle purchase (legacy) |
| 2110 | Media | Media purchase |
| 2116 | MediaSets | Media bundle purchase |
| 6002 | SpecialWallet | Special wallet transaction |
| 6101 | Transaction6101 | [UNKNOWN] |
| 6515 | SubscriptionPurchase | Subscription purchase |
| 7001 | TipsLegacy | Tip (legacy) |
| 7101 | Tips | Tip |
| 14001 | Transaction14001 | [UNKNOWN] |
| 15000 | SubscriptionIndividual | Individual subscription |
| 15001 | Subscriptions | Subscription |
| 18001 | Referrals | Referral earnings |
| 18002 | ReferralVariant | Referral earnings (variant) |
| 24101 | LeaderboardPrizeMoney | Leaderboard prize money |
| 32001 | Story/Bundle | Story or bundle sale |
| 32101 | BundleVariant | Bundle sale (variant) |
| 42001 | Poll | Poll transaction |
| 45001 | StreamTickets | Stream ticket sale |
| 45101 | StreamTicketsVariant | Stream ticket sale (variant) |
| 58000 | Transaction58000 | [UNKNOWN] |
| 16013 | PayoutReversal | Payout reversal — canonical internal type `payout_reversal`. Store for audit/completeness, but exclude from net revenue reporting and `daily_revenue`. No fan attached. Seen live: $331, destination=2, status=2 |

### 3.11 Revenue Types (Earnings Stats)

Revenue types are a subset of transaction types used for earnings stats breakdowns:

| Code | Name |
|------|------|
| 2110 | Media |
| 2116 | MediaSets |
| 7101 | Tips |
| 15001 | Subscriptions |
| 18001 | Referrals |
| 24101 | LeaderboardPrizeMoney |
| 45001 | StreamTickets |

`PayoutReversal` (`16013`) is not a revenue type. Store it for audit/completeness, but exclude it from net revenue calculations and rollups.

### 3.12 Payout Provider IDs

Corrected 2026-08-20 against the shipped web client (`main.ac7fcc376bc818b0.js`). The earlier
"PayPal" entry was wrong.

| Code | Name | Evidence |
|------|------|----------|
| 2 | **Paxum** | The payout-method component renders provider 2 with `/assets/images/psps/paxum.webp` (pretty-printed bundle line 237638, second occurrence 239418); compliance copy on the same screen names Paxum (238735). **Not PayPal.** The server returns this method's account identifier as a **full, unmasked email**. |
| 30 | Cryptocurrency (USDT) | Currency-wallet renderer; the live UI showed an already-masked account suffix for this provider. |

The same component also references Skrill, Cosmo, Pilot and bank-transfer icons, so the provider
space is wider than these two codes — this table lists only what a live payout method proved.

### 3.13 Note Content Types

| Code | Name |
|------|------|
| 12000 | User note |

### 3.14 Account Flags

| Flag | Name | Description |
|------|------|-------------|
| 2 | Model | Creator/model account |
| 8 | Admin | Admin account |
| 16 | EmailVerified | Email is verified |
| 32 | TwoFAEnabled | Two-factor authentication enabled |
| 64 | Staff | Staff account |

### 3.15 Ignore Flags

Bitfield flags for `/account/ignore` and `/ignore` endpoints.

| Flag | Name | Description |
|------|------|-------------|
| 1 | Mute | Muted (hide from feed) |
| 2 | Block | Blocked |
| 4 | Vip | VIP status (marks user as VIP) |
| 8 | SuggestionMute | Hide from suggestions |
| 16 | DmPermissionBypass | Bypass DM permission restrictions |

### 3.16 Permission Flags (Media/Content)

Bitfield flags for media and content access permissions.

Corrected and completed 2026-08-20 from the client's own permission-editor classes
(`main.pretty.js:114731–114785`, `116450–116508`). The earlier `8 = FreePreview` entry was wrong,
and four bits were missing.

| Flag | Client name | Meaning | Metadata carried |
|------|------|-------------|------|
| 1 | `price` | Requires payment (PPV) | `price` (also copied to a top-level `price` in media contexts) |
| 2 | `following` | Requires follow | — |
| 4 | `subscribed` | Requires subscription tier | `subscriptionTierId`; some media paths also retain the tier name and before/after history bounds |
| 8 | **`tipped`** | **Visible to fans who have tipped at least `minAmount`. NOT "free preview".** | `minAmount` |
| 16 | `followed by them` / `followed by me` | Follow relation | — |
| 32 | `media_purchases` | Fan has bought at least `minAmount` of media | `minAmount` |
| 64 | `subscribed by them` / `subscribed by me` | Subscription relation | — |
| 128 | `list` | Requires membership of a private list | `listId`, `label` |

Directional wording on bits 16 and 64 flips by component perspective: the DM editor renders
"followed/subscribed by **them**", another viewer component renders "by **me**". The bit is the
same; only the label's point of view changes. Read the bit, never the rendered string.

### 3.17 Media Stat Types (datapoints[].stats[].type)

Verified against a live capture on 2026-08-19 and against FBuddy's shipped label map.

| Code | Name |
|------|------|
| 0 | FYP Views |
| 1 | Direct Views |

Within a row, the `preview*` fields count the free teaser and the bare fields count the
full/paid asset.

### 3.18 Profile Stat Types (profileDatapoints[].stats[].type)

**Corrected 2026-08-19 from a live capture. The previous table in this file was WRONG —
see the note below before using any older copy.**

| Code | Name |
|------|------|
| 10001 | Direct / Timeline visits |
| 44001 | FYP Promotion visits |
| 44011 | Suggestions (Who to Follow) visits |
| 44031 | Search visits |

Established by opening the creator Statistics page, reading the on-screen "profile visits by
source" widget, and matching each visible label and value to the corresponding entry in the
`/it/amoie/stats` response. Capture artifacts:
`artifacts/fansly-network-capture-2026-08-19/` (HAR + screenshots `02b`, `02f`).

The superseded table claimed `10001` = FYP visits, `44000`/`44001` = search and
`44030`/`44031` = suggestions — i.e. it inverted direct vs FYP and swapped the
search/suggestion families. Anything built on it reports direct traffic as discovery
traffic. FBuddy's shipped code carries the correct mapping; this document's prose did not.

**The even codes ARE present in the live capture — as a second measure.** Aggregating
`profileDatapoints[].stats[]` across the 31-bucket daily `/it/amoie/stats` response shows an
8-code structure: each traffic family has an even/odd pair, where the odd member (`…1`) is the
UI-shown visit count and always carries `interactionTime = 0`, while the even member (`…0`)
carries the dwell time (`interactionTime`) with its own, differing view/uniqueViewer counts.
Family = `type − (type % 10)`.

| family | dwell-bearing member (`…0`) | UI visit-count member (`…1`) |
|---|---|---|
| Direct / Timeline | 10000 (31 rows, 2485 views, ΣinteractionTime 59 564 731) | 10001 (3647 views, interactionTime 0 in every row) |
| FYP Promotion | 44000 (499 views, Σ 15 291 349) | 44001 (637 views, 0) |
| Suggestions | 44010 (18 rows, 34 views, Σ 1 385 136) | 44011 (42 views, 0) |
| Search | 44030 (154 views, Σ 3 899 843) | 44031 (200 views, 0) |

The precise semantic of the even member's own view counts (impressions vs visits vs another
denominator) is unproven — label it only as the dwell-bearing series, never invent a meaning.
Rows carry exactly `{type, views, interactionTime, uniqueViewers}`. Treat the 8-code set as
the observed structure, not as exhaustive: journal unknown codes verbatim and surface them
rather than discarding them.

**UI caveat:** over a 30-day window Fansly's own widget omits the Suggestions source from
its percentage breakdown (the raw value is present in both the response and the chart) and
re-computes the percentages across the remaining three sources only. Figures computed from
raw datapoints will therefore legitimately differ from what the creator sees on the site.

### 3.19 Group Type

| Code | Name |
|------|------|
| 1 | DM (Direct Message) |

### 3.20 Media Offer Location Types

| Code | Name |
|------|------|
| 4001 | Default (used for DM group media) |

### 3.21 WebSocket Service IDs

| ID | Service | Description |
|----|---------|-------------|
| 5 | Messaging | DM/notification service (wsv3.fansly.com) |
| 46 | Chatroom | Live chatroom service (chatws.fansly.com) |

---

## 4. WebSocket Protocols

### 4.1 DM WebSocket

**URL:** `wss://wsv3.fansly.com/?v=3`

**Auth flow:**
1. Connect to WebSocket URL
2. On `open`: send auth message:
   ```json
   { "t": 1, "d": "{\"token\":\"<auth_token>\",\"v\":3}" }
   ```
   Note: `d` is a JSON-stringified string, not a nested object.
3. Receive auth ack (`t=1`, `d=null`)
4. Start ping timer (every 20 seconds, send `"p"`)
5. Start acknowledgment timer (every 5 seconds, flush pending message acks)
6. Force reconnect timer every 60 seconds

**Message format:**
```json
{
  "t": <message_type>,
  "d": <data>
}
```

**Message types (t):**

| Type | Name | Description |
|------|------|-------------|
| 0 | Error | Error message. `d` = error string |
| 1 | SessionVerified | Auth confirmed. `d` = null |
| 2 | BatchMessages | `d` = array of JSON strings (each a full message) |
| 10000 | ServiceEvent | `d` = JSON string with `{ serviceId, event }` |
| 10001 | BatchMessages | Array batch (similar to type 2, `d` = array of JSON strings) |

**Service IDs for type 10000:**

| ID | Service | Description |
|----|---------|-------------|
| 5 | Messaging | New DM message event |

**DM Service Event payload (serviceId=5):**
```json
{
  "type": 1,
  "message": {
    "id": "string",
    "senderId": "string",
    "type": 2,
    "correlationId": "string",
    "inReplyTo": "string",
    "totalTipAmount": 0
  }
}
```
- Message `type` 2 = automated message
- **Auto-ack logic:** Messages with `type === 2` (automated) or non-empty `correlationId` are auto-acknowledged unless `totalTipAmount > 0`.

**Ping/Pong:**
- Client sends: `"p"` (string, not JSON)
- Server responds: `"pong"` (string)

**Reconnect logic:**
- Starts at 1000ms delay
- Doubles on each failure (exponential backoff)
- Max reconnect delay capped

### 4.2 Live Chat WebSocket

**URL:** `wss://chatws.fansly.com?v=3`

**Constants:**
- Service ID: `46`
- Session verify type: `1`
- Ping interval: 46 * 1000 + 1 = 46001ms
- Service event type: `10000`
- Batch event type: `10001`

**Auth flow:**
1. Connect to WebSocket
2. On `open`: send auth: `{ "t": 1, "d": "{\"token\":\"<auth_token>\",\"v\":3}" }`
3. Wait for `t=1` (session verified)
4. Send subscribe: `{ "t": 46001, "d": "{\"chatRoomId\":\"<room_id>\"}" }`
   - Subscribe type = `46 * 1000 + 1 = 46001`

**Message types (t):**

| Type | Name | Direction | Description |
|------|------|-----------|-------------|
| 0 | Error | Incoming | Error event |
| 1 | Auth | Both | Send auth / receive auth ack |
| 46001 | Subscribe | Outgoing | Subscribe to chatroom (`46 * 1000 + 1`) |
| 10000 | ServiceEvent | Incoming | `d` = JSON string with `{ serviceId: 46, ... }` |
| 10001 | BatchMessages | Incoming | `d` = array of JSON strings |

**Chat message structure (inside service event):**
```json
{
  "chatRoomMessage": {
    "usernameColor": "#ffffff",
    ...
  },
  "subAlert": { ... }
}
```

**Ping/Pong:**
- Client sends: `"p"`
- Server responds: `"pong"`
- Force reconnect every 60 seconds

---

## 5. Data Models

### 5.1 Account
```json
{
  "id": "string",
  "username": "string",
  "displayName": "string",
  "subscriberCount": 0,
  "walls": [{ "id": "string" }],
  "notes": [{ "id": "string", "title": "string", "note": "string" }],
  "streaming": {
    "channel": {
      "chatRoomId": "string"
    }
  }
}
```

### 5.2 Message
```json
{
  "id": "string",
  "type": 1,
  "dataVersion": 0,
  "content": "string",
  "groupId": "string",
  "senderId": "string",
  "correlationId": "string",
  "inReplyTo": null,
  "inReplyToRoot": null,
  "createdAt": 1234567890000,
  "attachments": [],
  "embeds": [],
  "interactions": [],
  "likes": [],
  "totalTipAmount": 0
}
```

### 5.3 Post
```json
{
  "id": "string",
  "content": "string",
  "createdAt": 1234567890,
  "wallIds": [],
  "attachments": [],
  "fypFlags": 0,
  "scheduledFor": 0,
  "expiresAt": 0,
  "pinned": 0,
  "inReplyTo": null,
  "quotedPostId": null,
  "postReplyPermissionFlags": [],
  "pinWallIds": []
}
```

Note: `createdAt` is in **seconds**.

### 5.4 Media
Media objects have the following structure:
```json
{
  "id": "string",
  "mimetype": "image/jpeg",
  "filename": "photo.jpg",
  "location": "/path/to/media",
  "locations": [{ "location": "https://cdn3.fansly.com/..." }],
  "variants": [{ "mimetype": "...", ... }]
}
```

**CDN URL resolution:**
- If `locations` array exists and has items: use `locations[0].location`
- Otherwise: `https://cdn3.fansly.com${media.location}`

**Video HLS variants:** Some videos use HLS streaming with CloudFront signed cookies:
```json
{
  "cookie": {
    "accountId": "string",
    "variantId": "string",
    "meta": {
      "Key-Pair-Id": "...",
      "Policy": "...",
      "Signature": "..."
    }
  },
  "url": "https://..."
}
```

CloudFront cookies are set as:
```
CloudFront-Key-Pair-Id=<value>;domain=.fansly.com;path=<path>
CloudFront-Policy=<value>;domain=.fansly.com;path=<path>
CloudFront-Signature=<value>;domain=.fansly.com;path=<path>
```

### 5.5 Subscription
```json
{
  "id": "string",
  "subscriberId": "string",
  "subscriptionTierName": "string",
  "status": 3,
  "plans": [{ "status": 1 }]
}
```

### 5.6 Automated Message
```json
{
  "id": "string",
  "accountId": "string",
  "triggerType": 3,
  "triggerMetadata": "",
  "delay": 0,
  "cooldown": 0,
  "messageTemplate": {
    "type": 1,
    "content": "string",
    "attachments": [],
    "senderId": "string"
  }
}
```

### 5.7 Group (DM Conversation)
```json
{
  "id": "string",
  "type": 1,
  "groupFlags": 0,
  "groupFlagsMetadata": "",
  "createdBy": "string",
  "users": [{ "userId": "string", "permissionFlags": 0 }],
  "permissionFlags": [],
  "recipients": [],
  "userSettings": { "customName": null, "hidden": false },
  "lastMessage": { ... },
  "hasDmPermissionFlags": false,
  "dmPermissionFlags": [],
  "accountDmPermissionFlags": { "flags": 0, "metadata": "" }
}
```

### 5.8 Wallet
```json
{
  "type": 1,
  "balance": 10000
}
```
- Type 1 = Main wallet
- Type 2 = Earnings wallet
- Balance in cents

### 5.9 Setting
```json
{
  "categoryId": 2000,
  "keyId": 1,
  "value": "true",
  "metadata": "{...}"
}
```

### 5.10 Follower
```json
{
  "id": "string",
  "followerId": "string",
  "lastSeenAt": 1234567890000
}
```

### 5.11 Notification
```json
{
  "id": "string",
  "type": 5003,
  "total": 10
}
```

### 5.12 AggregationData

Many responses include denormalized related entities at `response.aggregationData`. This allows the client to cache referenced entities from any API response, reducing follow-up requests.

```typescript
interface AggregationData {
  accounts?: Account[];
  groups?: Group[];
  accountMedia?: AccountMedia[];
  accountMediaBundles?: AccountMediaBundle[];
  accountMediaOrders?: AccountMediaOrder[];
  posts?: Post[];
  stories?: Story[];
  tips?: Tip[];
  media?: Media[];
  subscriptions?: Subscription[];
  subscriptionHistory?: SubscriptionHistory[];
  tags?: Tag[];
  creatorMediaOfferLocations?: CreatorMediaOfferLocation[];
}
```

---

## 6. Pagination & Rate Limiting

### Pagination Patterns

1. **Offset-based**: Used by most list endpoints.
   - Parameters: `limit` + `offset`
   - Increment: `offset += limit`
   - Stop when: returned items < limit or empty

2. **Cursor-based (before/after)**: Used by timeline and messages.
   - Parameters: `before` (ID or timestamp), `after` (ID or timestamp)
   - For older items: set `before` = last item's ID
   - For newer items: set `after` = first item's ID

### Rate Limiting

- **Server-side**: HTTP 429 responses with optional `Retry-After` header
- **Client-side** (SDK): Token bucket rate limiter at 5 requests/second
- **FBuddy approach**: `waitForRateLimit()` with per-category delays:
  - Account requests: 1000ms minimum between requests
  - Media requests: 500ms minimum between requests
  - On 429: wait 5 seconds then retry (max 3 retries)
  - On 401: refresh token and retry once
- **Retry status codes**: 429, 500, 502, 503, 504
- **SDK retry**: Exponential backoff with factor 0.5, max 3 retries

### Batch Limits

| Resource | Max per request |
|----------|-----------------|
| Account IDs | 100 |
| Media IDs | 25 |
| List items add | 25 |
| Subscribers | 100 |
| Followers | 100 |
| Messaging groups | 100 |
| Notifications | 100 |
| Earnings transactions | 100 |

---

## 7. Additional Notes

### FBuddy-specific Backend API (NOT Fansly)

FBuddy extension also communicates with its own backend (variable `Cr` in code, pointing to `https://apiv2.fbuddy.net`). It also sends analytics/telemetry to `https://ingest.fbuddy.net/api/ingest`. These are NOT Fansly API endpoints:

- `/api/v1/auto-messages` - FBuddy auto-messages feature
- `/api/v1/auto-messages/{id}` - Manage auto-messages
- `/api/v1/auto-messages/{id}/test-send` - Test auto-message
- `/api/v1/auto-messages/logs` - Auto-message logs
- `/api/v1/community-reports/batch` - Community reports
- `/api/v1/community-reports/{id}/report` - Report content
- `/api/v1/community-reports/{id}/reports` - View reports
- `/api/v1/community-reports/{id}/inaccuracy` - Report inaccuracy
- `/api/v1/currency/rates` - Currency exchange rates
- `/api/v1/fan-properties/{accountId}` - Fan properties/tags
- `/api/v1/fan-properties/batch` - Batch fan properties
- `/api/v1/fan-spend/batch` - Fan spending data
- `/api/v1/fansly-sessions` - Session management
- `/api/v1/fyp/hourly-stats` - FYP hourly statistics
- `/api/v1/livestream-stats/record` - Record livestream stats
- `/api/v1/livestream-stats/history` - Livestream stats history
- `/api/v1/media/scores` - Media performance scores
- `/api/v1/message-templates` - Message templates
- `/api/v1/message-templates/{id}` - Manage templates
- `/api/v1/message-template-folders` - Template folders
- `/api/v1/online-users/record` - Record online users
- `/api/v1/online-users/history` - Online users history
- `/api/v1/organizations/{id}/message-logs` - Organization message logs
- `/api/v1/organizations/{id}/restricted-words` - Restricted words
- `/api/v1/organizations/{id}/settings` - Organization settings
- `/api/v1/pinned-messages` - Pinned messages in DMs
- `/api/v1/pinned-messages/{groupId}` - Manage pinned messages
- `/api/v1/smart-lists` - Smart lists (rules-based)
- `/api/v1/smart-lists/{id}` - Manage smart lists
- `/api/v1/translate` - Message translation
- `/api/v1/watermarks/signed-url` - Watermark signed URLs

### Known Bot Account

Account ID `407996034761891840` is flagged as the FBuddy bot (`Vne` variable). Messages to this group are silently skipped.

### FBuddy Caching TTLs

FBuddy implements aggressive caching for API responses:

| Resource | TTL |
|----------|-----|
| Me (current user) | 15s |
| Messaging groups | 60s |
| Subscribers page | 60s |
| Followers | 60s |
| Account data | 300s (5min) |
| Subscription tiers | 300s |
| Media cache | 300s |
| Lists account | 300s |
| Wall timeline | 300s |
| Earnings by accounts | 300s |
| Earnings cache | 600s (10min) |
| Media stats | 900s (15min) |
| AMOIE stats | 900s (15min) |
| Media offers | 120s (2min) |
| DM group ID | 180 days |
| System album ID | 180 days |

### CloudFront Signed Cookies for Media

Some media (especially HLS video) requires CloudFront signed cookies. The flow:
1. Media object contains `cookie` field with `accountId`, `variantId`, and `meta`
2. `meta` contains `Key-Pair-Id`, `Policy`, and `Signature`
3. Set cookies on `.fansly.com` domain for the appropriate path
4. Then access the HLS URL with credentials

### Session Storage

Auth token is read from `localStorage` key `session_active_session`:
```json
{ "token": "base64_encoded_auth_token" }
```

### Network Hook Architecture

FBuddy injects scripts to intercept Fansly's network traffic:
1. `window-bridge.js` - Creates a bridge for cross-context communication via `window.postMessage`
2. `fbuddy-network-hook.js` - Hooks `fetch()` and `XMLHttpRequest` to capture:
   - Request URL, method, headers, body
   - Response status, body
   - Specifically captures `fansly-client-*` headers for reuse
3. `fbuddy-restricted-words-guard.js` - Intercepts POST to `/api/v1/message` to check for restricted words before sending

### Request Deduplication

FBuddy deduplicates in-flight GET requests by key `"METHOD:URL:body"`. If an identical GET is already in-flight, the caller receives a `.clone()` of the pending response rather than making a duplicate request.

### PROXY_FETCH Architecture

FBuddy routes Fansly API calls through the extension's background script via `browser.runtime.sendMessage({ type: "PROXY_FETCH", url, options })` to bypass CORS restrictions. The background script executes the actual `fetch()` with `credentials: "include"`.

### FBuddy Auth API (separate from data API)

FBuddy also has an auth service at `https://api.fbuddy.net`:
- `GET /get-session` — Check/refresh FBuddy session
- `POST /sign-out` — Log out of FBuddy

Auth UI hosted at `https://auth.fbuddy.net/sign-in` and `/sign-up`.

### FBuddy Telemetry

- `POST https://umami.fbuddy.net/api/send` — Umami analytics events
- `POST https://gt.fbuddy.net/api/1/envelope/` — Sentry/GlitchTip error reports
- `POST https://ingest.fbuddy.net/api/ingest` — Community data sharing (opt-in)

### Error Code 99

Error code 99 from `/group` endpoint indicates DM permissions denied (the target user has restricted DMs). Also returned when creating a group that already exists.

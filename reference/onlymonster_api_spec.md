# OnlyMonster API Reference

Source: https://docs.onlymonster.ai/basics/openapi
Auth: `x-om-auth-token` header
Platform: only `onlyfans` supported
Base URL: not documented (likely `https://api.onlymonster.ai`)

---

## Endpoints

### GET /api/v0/accounts
List all accounts in the organization.

**Pagination:** cursor-based (`cursor`, `limit`)

**Response fields:**
| Field | Type | Notes |
|-------|------|-------|
| id | integer | OnlyMonster internal ID |
| platform_account_id | string | OnlyFans platform ID |
| platform | string | Always "onlyfans" |
| name | string | Display name |
| email | string\|null | |
| avatar | string | Avatar URL |
| username | string | |
| organisation_id | string | |
| subscribe_price | number\|null | Subscription price |
| subscription_expiration_date | datetime\|null | OM subscription expiry |

### GET /api/v0/accounts/{account_id}
Single account detail. Same fields as above.

---

### GET /api/v0/platforms/{platform}/accounts/{platform_account_id}/transactions
Retrieve transactions for a platform account.

**Pagination:** cursor-based (`cursor`, `limit` 10-1000, default 100)
**Required params:** `start` (ISO 8601), `end` (ISO 8601)

**Response fields:**
| Field | Type | Notes |
|-------|------|-------|
| id | string | Transaction ID |
| amount | number | Monetary amount (unit TBD — likely USD) |
| fan.id | string | Fan platform ID |
| type | string | `tip`, `message payment`, `recurring subscription`, `post purchase`, `live stream`, `unknown` |
| status | string | `done`, `loading`, `pending return` |
| timestamp | datetime | When transaction occurred |

---

### GET /api/v0/platforms/{platform}/accounts/{platform_account_id}/chargebacks
Retrieve chargebacks. Separate from transactions.

**Pagination:** cursor-based
**Required params:** `start`, `end`

**Response fields:**
| Field | Type | Notes |
|-------|------|-------|
| id | string | Chargeback ID |
| amount | number | Chargeback amount |
| fan.id | string | Fan platform ID |
| type | string | Type of original transaction |
| status | string | e.g. "undo" |
| chargeback_timestamp | datetime | When chargeback was created |
| transaction_timestamp | datetime | When original transaction occurred |

---

### GET /api/v0/platforms/{platform}/accounts/{platform_account_id}/tracking-links
Retrieve tracking links (for traffic/acquisition tracking).

**Pagination:** cursor-based
**Required params:** `start`, `end`

**Response fields:**
| Field | Type | Notes |
|-------|------|-------|
| id | string | |
| name | string | Link name |
| subscribers | number | Subscribers acquired through this link |
| url | string | Full URL |
| is_active | boolean | |
| clicks | number | Total clicks |
| created_at | datetime | |

---

### GET /api/v0/platforms/{platform}/accounts/{platform_account_id}/trial-links
Retrieve trial links.

**Pagination:** cursor-based
**Required params:** `start`, `end`

**Response fields:**
| Field | Type | Notes |
|-------|------|-------|
| id | string | |
| name | string | |
| claims | number | Times claimed |
| claims_limit | number | Max claims allowed |
| url | string | |
| duration_days | number | Days of free access |
| expires_at | datetime\|null | |
| is_active | boolean | |
| clicks | number | |
| created_at | datetime | |

---

### GET /api/v0/users/metrics
Chatter performance metrics. Very detailed.

**Pagination:** offset-based (`offset`, `limit` 1-100)
**Required params:** `from`, `to` (ISO 8601)
**Optional filters:** `creator_ids[]`, `user_ids[]`, `account_group_id`, `role_id`

**Response fields:**
| Field | Type | Notes |
|-------|------|-------|
| user_id | integer | Chatter user ID |
| creator_ids | integer[] | Which creators they work with |
| fans_count | integer | Total fans interacted with |
| messages_count | integer | Total messages sent |
| template_messages_count | integer | Template messages |
| ai_generated_messages_count | integer | AI-generated messages |
| copied_messages_count | integer | Copied messages |
| media_messages_count | integer | Messages with media |
| paid_messages_count | integer | Paid (PPV) messages sent |
| paid_messages_price_sum | number | Total price of PPV messages sent |
| sold_messages_count | integer | PPV messages actually sold |
| sold_messages_price_sum | number | Revenue from sold messages |
| total_sold_messages_count | integer | All-time sold messages |
| total_sold_messages_price_sum | number | All-time sold messages revenue |
| words_count_sum | integer | Total words typed |
| unsent_messages_count | integer | Drafted but not sent |
| reply_time_avg | number | Average reply time (seconds) |
| purchase_interval_avg | number | Average time between purchases (seconds) |
| purchase_interval_min | integer | Min purchase interval |
| purchase_interval_max | integer | Max purchase interval |
| work_time | number | Total work time |
| break_time | number | Total break time |
| posts_count | integer | Posts created |
| deleted_posts_count | integer | Posts deleted |
| sold_posts_count | integer | Posts sold |
| sold_posts_price_sum | number | Revenue from posts |
| total_sold_posts_count | integer | All-time posts sold |
| tips_amount_sum | number | Tips received |
| total_tips_amount_sum | number | All-time tips |
| chargedback_tips_amount_sum | number | Chargedback tips |
| chargedback_posts_price_sum | number | Chargedback posts revenue |
| chargedback_posts_count | integer | Chargedback posts count |
| chargedback_messages_price_sum | number | Chargedback messages revenue |
| chargedback_messages_count | integer | Chargedback messages count |
| total_chargedback_* | number/integer | All-time chargeback variants |
| internal_templates_count | number | Internal templates used |

---

## What OnlyMonster DOES NOT provide

⚠️ These data points are NOT available through the OnlyMonster API:

- **Subscriber list** — no endpoint for active subscribers, expiry dates, or renew status
- **Follower list/count** — no endpoint for followers
- **Fan profiles** — only `fan.id` in transactions; no usernames, display names, or profile data
- **Revenue net/gross split** — transaction `amount` unit not documented (likely gross USD dollars, needs verification on real data)
- **Subscription type breakdown** — `recurring subscription` is one type, no new vs renewal distinction

### Impact on Agency Hub

For OnlyFans pages, the dashboard will show:
- ✅ Revenue (transactions + chargebacks)
- ✅ Chatter performance metrics (messages, sales, reply time, work time)
- ✅ Tracking links (traffic/acquisition data)
- ✅ Trial links
- ❌ Active subscriber list / count / expiry / renew status
- ❌ Follower list / count / daily inflow
- ❌ Expiring subs warnings
- ❌ Fan profiles with usernames (only fan.id from transactions)

These limitations are inherent to the OnlyMonster API, not a Hub design choice.

## Transaction type mapping to unified taxonomy

| OnlyMonster type | Hub taxonomy |
|-----------------|--------------|
| `tip` | `tip` |
| `message payment` | `message_purchase` |
| `recurring subscription` | `subscription` |
| `post purchase` | `post_purchase` |
| `live stream` | `stream_tip` |
| `unknown` | `other` |
| (chargebacks endpoint) | `chargeback` |

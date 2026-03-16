-- Covering index for followers list: WHERE platform_account_id = ? AND is_active = true ORDER BY followed_at DESC
-- Existing indexes on page_follows don't cover (is_active, followed_at) together
CREATE INDEX IF NOT EXISTS page_follows_active_followed_idx
  ON page_follows (platform_account_id, is_active, followed_at DESC, id DESC);

-- Covering index for subscribers list: WHERE platform_account_id = ? AND is_current = true ORDER BY ends_at
-- Existing page_subscriptions_account_idx is (platform_account_id, ends_at) but misses is_current filter
CREATE INDEX IF NOT EXISTS page_subscriptions_current_idx
  ON page_subscriptions (platform_account_id, is_current, ends_at, id);

-- Revenue range scan index: WHERE platform_account_id IN (...) AND business_date >= ? AND business_date < ?
-- The unique constraint includes canonical_type and transaction_state which bloats the index for range scans
CREATE INDEX IF NOT EXISTS daily_revenue_account_date_idx
  ON daily_revenue (platform_account_id, business_date);

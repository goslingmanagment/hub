ALTER TABLE "page_subscriptions"
  DROP CONSTRAINT IF EXISTS "page_subscriptions_platform_subscription_id_unique";

ALTER TABLE "page_subscriptions"
  ADD CONSTRAINT "page_subscriptions_account_subscription_uniq"
  UNIQUE ("platform_account_id", "platform_subscription_id");

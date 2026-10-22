-- agency-hub:rollback-compatible — one nullable column; the previous image never names it.
-- 0295_page_fans_account_contactability.sql
--
-- The OnlyFans account check (services/ofapi-fan-account-check.ts) reads each
-- paying fan through the page's account and keeps, next to the page's
-- seen / not-seen answer (account_probe_*), whether the page can message him:
-- contactable, unavailable (his chat is closed to the page), restricted,
-- blocked, gone (the account is a stub with no username), unknown. Null: the
-- page never had such an answer (every Fansly row).

ALTER TABLE "page_fans" ADD COLUMN "account_contactability" text;

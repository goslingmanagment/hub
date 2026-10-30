-- agency-hub:rollback-compatible — one new nullable column; the previous image never names it.
-- 0336_user_ai_daily_limit.sql
--
-- The owner's personal daily AI limit for a person: what their AI calls may
-- cost in one Moscow day, all pages together, in micro-USD. Null: no personal
-- limit (the common per-page cap still applies). At the limit the gateway
-- refuses every AI call of the person (quota_denied) until 00:00 Moscow time.

alter table users add column if not exists ai_daily_limit_micro_usd bigint;

do $$ begin
  alter table users add constraint users_ai_daily_limit_nonnegative
    check (ai_daily_limit_micro_usd is null or ai_daily_limit_micro_usd >= 0);
exception
  when duplicate_object then null;
end $$;

comment on column users.ai_daily_limit_micro_usd is
  'The owner''s personal daily AI limit (micro-USD per Moscow day, all pages). Null: none.';

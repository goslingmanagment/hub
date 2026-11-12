-- agency-hub:rollback-compatible — two new columns with defaults and three wider checks: the previous image never names the columns and never writes the new scope.
-- 0393_ofapi_vault_album_scope.sql
--
-- OnlyFans vault albums get their own OFAPI budget scope, `vault_album`, with
-- their own UTC-day counter. Its credits never move the common day counter
-- (spend_day / spent_credits) nor any per-user counter; the balance floor and
-- the unsettled pool still include them.

alter table ofapi_credit_state
  add column vault_album_spend_day date,
  add column vault_album_spent_credits integer not null default 0,
  add constraint ofapi_credit_state_vault_album_nonnegative_check check (
    vault_album_spent_credits >= 0
  );

alter table ofapi_capture_jobs
  drop constraint ofapi_capture_jobs_budget_scope_check,
  add constraint ofapi_capture_jobs_budget_scope_check check (
    budget_scope in ('live', 'interactive', 'bulk', 'vault_album')
  );

alter table ofapi_request_attempts
  drop constraint ofapi_request_attempts_budget_scope_check,
  add constraint ofapi_request_attempts_budget_scope_check check (
    budget_scope in ('live', 'interactive', 'bulk', 'vault_album')
  );

alter table ofapi_budget_denial_daily
  drop constraint ofapi_budget_denial_daily_scope_check,
  add constraint ofapi_budget_denial_daily_scope_check check (
    scope in ('live', 'interactive', 'bulk', 'vault_album')
  );

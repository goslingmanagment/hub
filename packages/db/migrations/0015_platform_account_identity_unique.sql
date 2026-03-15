drop index if exists platform_accounts_platform_user_idx;

alter table platform_accounts
  add constraint platform_accounts_platform_account_uniq
  unique (platform, platform_account_id);

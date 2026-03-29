alter table page_top_spenders
  add column if not exists source_identity_key text;

update page_top_spenders
set source_identity_key = case
  when correlation_account_id is not null then 'fan:' || correlation_account_id
  when account_id is not null then 'account:' || account_id
  else 'legacy:' || md5(
    platform_account_id::text
    || ':'
    || coalesce(account_id, '')
    || ':'
    || coalesce(correlation_account_id, '')
    || ':'
    || created_at::text
  )
end
where source_identity_key is null;

alter table page_top_spenders
  drop constraint if exists page_top_spenders_pkey;

alter table page_top_spenders
  alter column correlation_account_id drop not null;

alter table page_top_spenders
  alter column source_identity_key set not null;

alter table page_top_spenders
  add constraint page_top_spenders_pkey primary key (platform_account_id, source_identity_key);

-- agency-hub:no-transaction
-- 0284: drop indexes that only cost writes, and leave room for HOT updates on
-- the two fan tables the sync rewrites most.
--
-- Every index below is maintained on each insert (and on each update that is
-- not HOT) and answers no query another index does not answer already.
-- Storage audit 2026-10-16 (investigations/storage-audit-2026-10-16.md), on
-- the index set rebuilt from all migrations:
--
-- A leading prefix of another index on the same table, same predicate — the
-- longer index serves every lookup the shorter one did:
--   page_fans_platform_account_idx (platform_account_id)
--     ⊂ page_fans_platform_account_alias_idx (platform_account_id, page_alias)
--     and page_fans_external_presence_idx (platform_account_id, external_presence_at)
--   revenue_daily_account_date_idx (platform_account_id, business_date)
--     ⊂ revenue_daily_account_date_type_state_uniq (…, canonical_type, transaction_state)
--   message_media_offers_page_message_idx (page_id, message_ref)
--     ⊂ message_media_offers_pkey (page_id, message_ref, offer_ordinal)
--   ai_acceptance_events_generation_idx (generation_ref)
--     ⊂ ai_acceptance_events_generation_ref_lifecycle_occurred_at_key
--   ofapi_credit_ledger_occurred_at_idx (occurred_at)
--     ⊂ ofapi_credit_ledger_occurred_at_id_idx (occurred_at desc, id desc),
--       which a range scan reads backward as easily
--   page_fan_external_notes_page_fan_provider_idx (platform_account_id, fan_id, provider)
--     ⊂ page_fan_external_notes_page_fan_provider_active_idx (…, is_active)
--
-- No reader at all:
--   sync_raw_payloads_retain_idx (retain_until): retain_until is a frozen
--     +36 500-day stamp (services/sync/shared.ts) that nothing filters on;
--     every OFAPI raw capture still paid for the entry.
--   ofapi_commands_payload_redaction_idx: the redaction sweep it served is
--     gone; terminal command payloads are permanent facts.
--   runtime_instances_last_seen_idx (last_seen_at): the table holds one row
--     per running process (about ten). The index made every heartbeat — each
--     process, every minute — a non-HOT update that also rewrote the row's
--     config snapshot; without it the heartbeat is HOT. The stale/live reads
--     scan ten rows.
--
-- DROP INDEX CONCURRENTLY: no table lock; it waits for running transactions.
-- agency-hub:statement
drop index concurrently if exists page_fans_platform_account_idx;
-- agency-hub:statement
drop index concurrently if exists revenue_daily_account_date_idx;
-- agency-hub:statement
drop index concurrently if exists message_media_offers_page_message_idx;
-- agency-hub:statement
drop index concurrently if exists ai_acceptance_events_generation_idx;
-- agency-hub:statement
drop index concurrently if exists ofapi_credit_ledger_occurred_at_idx;
-- agency-hub:statement
drop index concurrently if exists page_fan_external_notes_page_fan_provider_idx;
-- agency-hub:statement
drop index concurrently if exists sync_raw_payloads_retain_idx;
-- agency-hub:statement
drop index concurrently if exists ofapi_commands_payload_redaction_idx;
-- agency-hub:statement
drop index concurrently if exists runtime_instances_last_seen_idx;
--
-- fans and page_fans: most of their updates (last_seen_at, spend totals,
-- profile fields) change no indexed column, so they can be HOT — but only
-- while the row's page has room for the new version. At fillfactor 100 a full
-- page sends the update to another page and into every index (0145: 57.8 M
-- updates on 67 k page_fans rows grew the heap 30-64x before VACUUM FULL).
-- 90 keeps a tenth of each new page free. It applies to pages written from now
-- on; existing pages gain it as rows move. SHARE UPDATE EXCLUSIVE: reads and
-- writes continue; each switch waits at most 1 s for its lock and retries,
-- like 0265.
-- agency-hub:statement
do $do$
begin
  for attempt in 1..40 loop
    begin
      set local lock_timeout = '1s';
      alter table fans set (fillfactor = 90);
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise warning 'could not lock fans to set fillfactor; left as it was';
end
$do$;
-- agency-hub:statement
do $do$
begin
  for attempt in 1..40 loop
    begin
      set local lock_timeout = '1s';
      alter table page_fans set (fillfactor = 90);
      return;
    exception when lock_not_available then
      perform pg_sleep(0.5);
    end;
  end loop;
  raise warning 'could not lock page_fans to set fillfactor; left as it was';
end
$do$;

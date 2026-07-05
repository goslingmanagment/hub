-- Stage 13 (transactions provenance, currency, single-writer gate), migration 2 of 2.
-- Closes the pages.id cascade destruction door: FACT/HISTORY tables flip to
-- ON DELETE RESTRICT so a raw DELETE on a fact-bearing page is structurally
-- impossible; page "deletion" is the 0055 tombstone (status='deleted').
--
-- Classification (binding rule: facts/captured history/audit -> RESTRICT;
-- rebuildable projections/config/cache -> CASCADE stays). Enumerated from
-- schema.ts at execution time — 42 FKs total on pages.id:
--
-- RESTRICT (22 — facts, captured history, audit substrate):
--   transactions, sync_raw_payloads, sync_runs, sync_http_attempts,
--   sync_run_events (sync telemetry = Stage 7 reconciliation substrate),
--   page_fans, page_fan_external_notes, page_fan_aliases, page_follows,
--   page_subscriptions, page_fan_identities, page_dm_threads,
--   page_dm_messages, dm_message_archive, ofapi_commands,
--   workboard_contact_log, wb_classifier_runs (Stage 2 made verdicts
--   soft-superseded audit rows), fan_notes, fan_summaries, fan_profiles
--   (operator/AI-written — inputs may be gone, not rebuildable),
--   daily_followers, daily_subscribers (observed platform state — no
--   underlying fact table to rebuild from).
--
-- CASCADE stays (16 — rebuildable or config/cache/UI state):
--   page_credentials, egress_endpoints (secrets/config SHOULD die with the
--   page), notification_incidents, page_sync_states, page_sync_cursors,
--   dm_message_daily_aggregates, workboard_snoozes, revenue_daily,
--   fan_spend_daily, fan_spend_lifetime (rollups rebuild from transactions),
--   projection_watermarks, user_page_assignments, workboard_state,
--   wb_closing_cache, wb_closing_settings, wb_llm_usage_daily.
--
-- Untouched (4 — already non-cascade): ai_usage_events, ofapi_credit_ledger,
-- ofapi_spend_projection_events, ofapi_webhook_events.
--
-- The DO block resolves each FK's actual constraint name from pg_catalog
-- (names drifted across historical migrations) and re-creates it with
-- RESTRICT under the same name. Fails loudly if any expected FK is missing.

DO $$
DECLARE
  v record;
  fk_name text;
BEGIN
  FOR v IN
    SELECT * FROM (VALUES
      ('transactions',            'platform_account_id'),
      ('sync_raw_payloads',       'page_id'),
      ('sync_runs',               'page_id'),
      ('sync_http_attempts',      'page_id'),
      ('sync_run_events',         'page_id'),
      ('page_fans',               'platform_account_id'),
      ('page_fan_external_notes', 'platform_account_id'),
      ('page_fan_aliases',        'platform_account_id'),
      ('page_follows',            'platform_account_id'),
      ('page_subscriptions',      'platform_account_id'),
      ('page_fan_identities',     'platform_account_id'),
      ('page_dm_threads',         'platform_account_id'),
      ('page_dm_messages',        'platform_account_id'),
      ('dm_message_archive',      'platform_account_id'),
      ('ofapi_commands',          'page_id'),
      ('workboard_contact_log',   'platform_account_id'),
      ('wb_classifier_runs',      'platform_account_id'),
      ('fan_notes',               'platform_account_id'),
      ('fan_summaries',           'platform_account_id'),
      ('fan_profiles',            'platform_account_id'),
      ('daily_followers',         'platform_account_id'),
      ('daily_subscribers',       'platform_account_id')
    ) AS t(tbl, col)
  LOOP
    SELECT c.conname INTO fk_name
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
    WHERE r.relname = v.tbl
      AND f.relname = 'pages'
      AND c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
      AND (
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = r.oid AND a.attnum = c.conkey[1]
      ) = v.col;

    IF fk_name IS NULL THEN
      RAISE EXCEPTION 'Stage 13 FK flip: no FK found for %.% -> pages(id)', v.tbl, v.col;
    END IF;

    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', v.tbl, fk_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES pages(id) ON DELETE RESTRICT',
      v.tbl, fk_name, v.col
    );
  END LOOP;
END $$;

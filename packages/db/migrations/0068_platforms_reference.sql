-- Kernel Stage 18: platform vocabulary moves from a pg enum to a reference
-- table. Adding platform #3 becomes an INSERT (+ adapter package), not a
-- coordinated ALTER TYPE across environments.
--
-- PASSPORT RULE: rehearse this migration AND its reverse on a staging copy
-- before prod. The enum→text conversions are table rewrites on PG16 —
-- sync_http_attempts is the big one (30-day retention keeps it bounded);
-- schedule off-peak. Down-path: recreate the enum, cast the 7 columns back
-- (USING <col>::platform), drop the FKs and the platforms table.

CREATE TABLE IF NOT EXISTS platforms (
  key text PRIMARY KEY,
  display_name text NOT NULL,
  adapter_version text NOT NULL DEFAULT '1'
);

INSERT INTO platforms (key, display_name, adapter_version) VALUES
  ('fansly', 'Fansly', '1'),
  ('onlyfans', 'OnlyFans', '1')
ON CONFLICT (key) DO NOTHING;

-- The seven enum columns, converted in place. FKs guarantee the vocabulary
-- stays closed (the enum's one real property) while inserts stay cheap.
ALTER TABLE pages ALTER COLUMN platform TYPE text USING platform::text;
ALTER TABLE pages ADD CONSTRAINT pages_platform_fk
  FOREIGN KEY (platform) REFERENCES platforms(key);

ALTER TABLE sync_http_attempts ALTER COLUMN provider TYPE text USING provider::text;
ALTER TABLE sync_http_attempts ADD CONSTRAINT sync_http_attempts_provider_fk
  FOREIGN KEY (provider) REFERENCES platforms(key);

ALTER TABLE sync_run_events ALTER COLUMN provider TYPE text USING provider::text;
ALTER TABLE sync_run_events ADD CONSTRAINT sync_run_events_provider_fk
  FOREIGN KEY (provider) REFERENCES platforms(key);

ALTER TABLE sync_rate_limits ALTER COLUMN provider TYPE text USING provider::text;
ALTER TABLE sync_rate_limits ADD CONSTRAINT sync_rate_limits_provider_fk
  FOREIGN KEY (provider) REFERENCES platforms(key);

ALTER TABLE fans ALTER COLUMN platform TYPE text USING platform::text;
ALTER TABLE fans ADD CONSTRAINT fans_platform_fk
  FOREIGN KEY (platform) REFERENCES platforms(key);

ALTER TABLE page_fan_external_notes ALTER COLUMN provider TYPE text USING provider::text;
ALTER TABLE page_fan_external_notes ADD CONSTRAINT page_fan_external_notes_provider_fk
  FOREIGN KEY (provider) REFERENCES platforms(key);

ALTER TABLE dm_message_archive ALTER COLUMN platform TYPE text USING platform::text;
ALTER TABLE dm_message_archive ADD CONSTRAINT dm_message_archive_platform_fk
  FOREIGN KEY (platform) REFERENCES platforms(key);

-- Last, after every column is off the type.
DROP TYPE platform;

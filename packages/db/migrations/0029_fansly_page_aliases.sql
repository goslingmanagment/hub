ALTER TABLE fan_pages
  ADD COLUMN IF NOT EXISTS page_alias TEXT,
  ADD COLUMN IF NOT EXISTS page_alias_source TEXT,
  ADD COLUMN IF NOT EXISTS page_alias_source_note_id TEXT,
  ADD COLUMN IF NOT EXISTS page_alias_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS fan_pages_platform_account_alias_idx
  ON fan_pages (platform_account_id, page_alias);

CREATE TABLE IF NOT EXISTS fan_page_external_notes (
  id BIGSERIAL PRIMARY KEY,
  platform_account_id BIGINT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  fan_id BIGINT NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  provider platform NOT NULL,
  external_note_id TEXT NOT NULL,
  content_type INTEGER,
  title TEXT,
  body TEXT,
  created_at_external TIMESTAMPTZ,
  updated_at_external TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (platform_account_id, provider, external_note_id)
);

CREATE INDEX IF NOT EXISTS fan_page_external_notes_page_fan_provider_idx
  ON fan_page_external_notes (platform_account_id, fan_id, provider);

CREATE INDEX IF NOT EXISTS fan_page_external_notes_page_fan_provider_active_idx
  ON fan_page_external_notes (platform_account_id, fan_id, provider, is_active);

CREATE TABLE IF NOT EXISTS fan_page_aliases (
  platform_account_id BIGINT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  fan_id BIGINT NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source_note_id TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (platform_account_id, fan_id, alias)
);

CREATE INDEX IF NOT EXISTS fan_page_aliases_platform_account_alias_idx
  ON fan_page_aliases (platform_account_id, alias);

CREATE INDEX IF NOT EXISTS fan_page_aliases_fan_idx
  ON fan_page_aliases (fan_id);

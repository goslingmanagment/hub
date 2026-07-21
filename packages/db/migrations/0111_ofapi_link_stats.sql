-- OFAPI trial/tracking link statistics (2026-07-22 plan).
-- One run row per completed (page, link_kind) list walk; append-only
-- snapshot rows per link per run. Cumulative vendor counters are stored
-- as observed — deltas are a query-time concern. Money in mills.

CREATE TABLE IF NOT EXISTS page_link_stat_runs (
  id BIGSERIAL PRIMARY KEY,
  platform_account_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('tracking', 'trial')),
  status TEXT NOT NULL CHECK (status IN ('complete', 'truncated')),
  pulled_at TIMESTAMPTZ NOT NULL,
  api_pages INTEGER NOT NULL DEFAULT 0,
  raw_items INTEGER NOT NULL DEFAULT 0,
  written_rows INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_link_stat_runs_page_kind_pulled_idx
  ON page_link_stat_runs (platform_account_id, link_kind, pulled_at DESC);

CREATE TABLE IF NOT EXISTS page_link_stat_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES page_link_stat_runs(id) ON DELETE RESTRICT,
  platform_account_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('tracking', 'trial')),
  platform_link_id TEXT NOT NULL,
  name TEXT,
  url TEXT,
  link_created_at TIMESTAMPTZ,
  link_ends_at TIMESTAMPTZ,
  is_finished BOOLEAN,
  clicks_count INTEGER NOT NULL,
  claims_count INTEGER,
  subscribers_count INTEGER NOT NULL,
  spenders_count INTEGER NOT NULL DEFAULT 0,
  revenue_gross_mills BIGINT NOT NULL DEFAULT 0,
  revenue_calculated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT page_link_stat_snapshots_run_link_uniq UNIQUE (run_id, platform_link_id)
);

CREATE INDEX IF NOT EXISTS page_link_stat_snapshots_page_link_idx
  ON page_link_stat_snapshots (platform_account_id, link_kind, platform_link_id, id DESC);

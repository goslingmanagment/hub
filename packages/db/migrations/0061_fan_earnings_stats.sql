-- Stage 16: per-fan Fansly earnings projection (rebuildable; facts live in
-- observations/domain_events). RESTRICT FKs per the Stage 13 fact policy —
-- rebuildable, but rows reference identity rows that must not vanish.
CREATE TABLE "fan_earnings_stats" (
  "id"              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "account_id"      bigint NOT NULL REFERENCES "pages"("id") ON DELETE RESTRICT,
  "fan_id"          bigint NOT NULL REFERENCES "fans"("id") ON DELETE RESTRICT,
  "window"          text NOT NULL,
  "gross_mills"     bigint NOT NULL,
  "net_mills"       bigint,
  "currency"        char(3) NOT NULL DEFAULT 'USD',
  "observed_at"     timestamp with time zone NOT NULL,
  "source_event_id" bigint NOT NULL,
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE ("account_id", "fan_id", "window")
);
CREATE INDEX "fan_earnings_stats_account_window_idx"
  ON "fan_earnings_stats" ("account_id", "window");

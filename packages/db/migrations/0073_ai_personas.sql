-- Kernel Stage 30: personas become kernel config records (DP 9-A —
-- single-tenant, "editable per org" collapses to global config). Seeded
-- from the clients' defaults during the prompt migration; archived_at
-- soft-retires (prompt assets are never hard-deleted).
CREATE TABLE ai_personas (
  id bigserial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  system_block text NOT NULL,
  feature_overrides jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

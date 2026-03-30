CREATE TABLE IF NOT EXISTS workboard_snoozes (
  id BIGSERIAL PRIMARY KEY,
  platform_account_id BIGINT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  fan_id BIGINT NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  snoozed_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_account_id, fan_id)
);

CREATE INDEX IF NOT EXISTS workboard_snoozes_lookup_idx
  ON workboard_snoozes (platform_account_id, fan_id, snoozed_until);

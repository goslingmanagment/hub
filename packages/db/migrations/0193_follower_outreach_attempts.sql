-- Control-plane custody for a human-triggered browser send. Reserved leases
-- may expire; dispatching/sent custody NEVER expires or auto-retries. Keep
-- every attempt, including superseded un-dispatched reservations.
CREATE TABLE follower_outreach_attempts (
  attempt_id uuid PRIMARY KEY,
  platform_account_id bigint NOT NULL REFERENCES pages(id),
  fan_ref text NOT NULL,
  user_id bigint NOT NULL REFERENCES users(id),
  state text NOT NULL CHECK (state IN ('reserved', 'dispatching', 'sent', 'expired')),
  expires_at timestamptz NOT NULL,
  message_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX follower_outreach_active_fan
  ON follower_outreach_attempts (platform_account_id, fan_ref)
  WHERE state <> 'expired';

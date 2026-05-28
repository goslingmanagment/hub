CREATE TABLE IF NOT EXISTS "notification_incident_recoveries" (
  "incident_key" text PRIMARY KEY,
  "recovered_at" timestamptz NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

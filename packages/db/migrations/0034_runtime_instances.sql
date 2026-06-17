-- Heartbeat table for the in-dashboard Configuration surface (Stage A).
-- Each running process (api, worker) upserts a row with the sanitized config
-- values it is actually using, so the Configuration page can render per-instance
-- running values and flag drift between the api and worker containers. No secret
-- values are ever stored here -- secrets are reduced to set/unset before the row
-- is written. Rows whose last_seen_at falls past the staleness TTL are ignored
-- for drift and periodically reaped, so restarts do not leave a graveyard of dead
-- instances that would read as false drift.

CREATE TABLE IF NOT EXISTS "runtime_instances" (
	"role" text NOT NULL,
	"instance_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"image_tag" text,
	"running" jsonb NOT NULL,
	CONSTRAINT "runtime_instances_pkey" PRIMARY KEY ("role", "instance_id")
);

CREATE INDEX IF NOT EXISTS "runtime_instances_last_seen_idx" ON "runtime_instances" USING btree ("last_seen_at");

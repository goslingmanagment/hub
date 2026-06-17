-- Writable foundation for the in-dashboard Configuration surface (Stage B0).
-- `config_settings` holds the per-key override overlay that layers over the env
-- defaults; only the editable knobs in the descriptor registry may be written here,
-- and validation/clamping happens server-side before a row lands. Scope columns are
-- future-proofed for per-page overrides but only the global scope (scope_type
-- 'global', scope_id 0) is used today. `config_audit_log` is an append-only trail:
-- a single multi-key patch shares one group_id, and each row records the per-key
-- old/new value and version so every change is reconstructible. No live runtime
-- behavior reads these tables yet (read-site wiring is Stage B1).

CREATE TABLE IF NOT EXISTS "config_settings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL DEFAULT 'global',
	"scope_id" bigint NOT NULL DEFAULT 0,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"updated_by_user_id" bigint,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "config_settings_scope_key_uniq" UNIQUE ("scope_type", "scope_id", "key")
);

DO $$ BEGIN
	ALTER TABLE "config_settings"
		ADD CONSTRAINT "config_settings_updated_by_user_id_users_id_fk"
		FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "config_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL DEFAULT now(),
	"user_id" bigint,
	"scope_type" text NOT NULL,
	"scope_id" bigint NOT NULL,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"old_version" integer,
	"new_version" integer,
	"note" text
);

DO $$ BEGIN
	ALTER TABLE "config_audit_log"
		ADD CONSTRAINT "config_audit_log_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "config_audit_log_changed_at_idx" ON "config_audit_log" USING btree ("changed_at");
CREATE INDEX IF NOT EXISTS "config_audit_log_group_idx" ON "config_audit_log" USING btree ("group_id");

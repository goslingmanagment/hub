CREATE TABLE IF NOT EXISTS "onlyfans_public_profile_resolutions" (
  "fan_id" bigint PRIMARY KEY NOT NULL,
  "platform_user_id" text NOT NULL,
  "status" text NOT NULL,
  "username" text,
  "display_name" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_attempted_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "next_attempt_after" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "onlyfans_public_profile_resolutions_fan_id_fans_id_fk"
    FOREIGN KEY ("fan_id") REFERENCES "public"."fans"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "onlyfans_public_profile_resolutions_platform_user_uniq"
    UNIQUE("platform_user_id"),
  CONSTRAINT "onlyfans_public_profile_resolutions_status_check"
    CHECK ("status" in ('resolved', 'not_found', 'unavailable', 'failed', 'rate_limited'))
);

CREATE INDEX IF NOT EXISTS "onlyfans_public_profile_resolutions_next_attempt_idx"
  ON "onlyfans_public_profile_resolutions" USING btree ("next_attempt_after");

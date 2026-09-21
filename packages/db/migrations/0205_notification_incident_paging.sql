-- Decision 381: paging policy between the incident latch and Telegram.
--
-- The latch tables stay the source of truth for WHAT is broken. These two
-- tables record what the minutely paging sweep has DONE about it, so that a
-- condition pages only once it has lasted (or flapped) long enough to matter,
-- resolves only once it has stayed quiet, and every episode that self-healed
-- before paging is still counted for the daily digest.

CREATE TABLE "notification_incident_paging" (
  "notification_incident_id" bigint PRIMARY KEY
    REFERENCES "notification_incidents"("id") ON DELETE CASCADE,
  -- Newest latch cycle (opened_at) the sweep has observed. A latch opened_at
  -- past this value is a new episode.
  "observed_opened_at" timestamptz NOT NULL,
  "observed_status" text NOT NULL,
  -- The episode the standing page covers, when it was enqueued and under
  -- which rule. paged_resolved_at is null while the page is standing.
  "paged_opened_at" timestamptz,
  "paged_at" timestamptz,
  "paged_mode" text,
  "paged_resolved_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notification_incident_paging_status_check"
    CHECK ("observed_status" IN ('open', 'resolved')),
  CONSTRAINT "notification_incident_paging_mode_check"
    CHECK ("paged_mode" IS NULL OR "paged_mode" IN ('immediate', 'sustained', 'flapping'))
);

CREATE TABLE "notification_incident_cycles" (
  "id" bigserial PRIMARY KEY,
  "notification_incident_id" bigint NOT NULL
    REFERENCES "notification_incidents"("id") ON DELETE CASCADE,
  "incident_key" text NOT NULL,
  "kind" "notification_incident_kind" NOT NULL,
  "platform_account_id" bigint REFERENCES "pages"("id") ON DELETE CASCADE,
  "opened_at" timestamptz NOT NULL,
  "resolved_at" timestamptz,
  "paged" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "notification_incident_cycles_episode_uidx"
  ON "notification_incident_cycles" ("notification_incident_id", "opened_at");

CREATE INDEX "notification_incident_cycles_opened_idx"
  ON "notification_incident_cycles" ("opened_at");

-- Seed: an incident that is open right now and was already paged by the
-- direct send path this migration retires gets a standing page, so the first
-- sweep neither pages it a second time nor forgets to announce its recovery.
INSERT INTO "notification_incident_paging" (
  "notification_incident_id",
  "observed_opened_at",
  "observed_status",
  "paged_opened_at",
  "paged_at",
  "paged_mode",
  "paged_resolved_at"
)
SELECT i."id",
       i."opened_at",
       'open',
       i."opened_at",
       max(a."created_at"),
       'immediate',
       NULL
FROM "notification_incidents" i
JOIN "telegram_delivery_attempts" a
  ON a."notification_incident_id" = i."id"
 AND a."kind" = 'incident_opened'
 AND a."status" = 'sent'
 AND a."created_at" >= i."opened_at"
WHERE i."status" = 'open'
GROUP BY i."id", i."opened_at";

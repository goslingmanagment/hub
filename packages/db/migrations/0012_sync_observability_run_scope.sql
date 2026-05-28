UPDATE "sync_http_attempts" AS a
SET "page_id" = r."page_id",
    "stream" = r."stream"
FROM "sync_runs" AS r
WHERE a."sync_run_id" = r."id"
  AND (
    a."page_id" <> r."page_id"
    OR a."stream" <> r."stream"
  );

UPDATE "sync_run_events" AS e
SET "page_id" = r."page_id",
    "stream" = r."stream"
FROM "sync_runs" AS r
WHERE e."sync_run_id" = r."id"
  AND (
    e."page_id" <> r."page_id"
    OR e."stream" <> r."stream"
  );

ALTER TABLE "sync_runs"
  ADD CONSTRAINT "sync_runs_id_page_stream_uniq"
  UNIQUE ("id", "page_id", "stream");

ALTER TABLE "sync_http_attempts"
  ADD CONSTRAINT "sync_http_attempts_run_page_stream_fk"
  FOREIGN KEY ("sync_run_id", "page_id", "stream")
  REFERENCES "public"."sync_runs"("id", "page_id", "stream")
  ON DELETE cascade
  ON UPDATE no action;

ALTER TABLE "sync_run_events"
  ADD CONSTRAINT "sync_run_events_run_page_stream_fk"
  FOREIGN KEY ("sync_run_id", "page_id", "stream")
  REFERENCES "public"."sync_runs"("id", "page_id", "stream")
  ON DELETE cascade
  ON UPDATE no action;

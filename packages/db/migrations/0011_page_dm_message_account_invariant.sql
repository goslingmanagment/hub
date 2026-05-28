UPDATE "page_dm_messages" AS m
SET "platform_account_id" = c."platform_account_id"
FROM "page_dm_threads" AS c
WHERE m."conversation_id" = c."id"
  AND m."platform_account_id" <> c."platform_account_id";

ALTER TABLE "page_dm_threads"
  ADD CONSTRAINT "page_dm_threads_id_account_uniq"
  UNIQUE ("id", "platform_account_id");

ALTER TABLE "page_dm_messages"
  ADD CONSTRAINT "page_dm_messages_conversation_account_fk"
  FOREIGN KEY ("conversation_id", "platform_account_id")
  REFERENCES "public"."page_dm_threads"("id", "platform_account_id")
  ON DELETE cascade
  ON UPDATE no action;

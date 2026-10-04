import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createFanslyPage, createModel, fanslyDmReaderHeadKey, listAgentTranscript, queryFanslyDmReaderHeads,
} from "@agency_hub_core/db";
import { resetIntegrationDatabase, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let db: StartedTestDatabase;
let pageId: number;
const at = "2026-09-14T12:00:00Z";
const head = { conversationRef: "group", messageId: "head" };
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  const model = await createModel(db.db, { slug: "reader", name: "Reader" });
  const page = await createFanslyPage(db.db, { modelId: model!.id, label: "reader" });
  pageId = page!.id;
});

async function hot(deleted = false, owner = pageId, group = "group") {
  const thread = await db.pool.query(`insert into page_dm_threads
    (platform_account_id, platform_conversation_id, last_message_id)
    values ($1, $2, 'head') returning id`, [owner, group]);
  const id = Number(thread.rows[0].id);
  await db.pool.query(`insert into page_dm_messages
    (conversation_id, platform_account_id, platform_message_id, created_at, content, deleted_at)
    values ($1, $2, 'head', $3, '', case when $4 then now() end)`, [id, owner, at, deleted]);
  return id;
}

async function archive(pending = false, deleted = false, owner = pageId, group = "group") {
  await db.pool.query(`insert into message_archive
    (account_id, platform, conversation_ref, message_ref, occurred_at, content_pending, deleted_at)
    values ($1, 'fansly', $2, 'head', $3, $4, case when $5 then now() end)`,
  [owner, group, at, pending, deleted]);
}

async function cold(group: string | null, pending: boolean, deleted: boolean, binding = "binding") {
  await db.pool.query(`insert into dm_message_archive
    (platform, platform_account_id, ofapi_account_id, platform_conversation_id, platform_message_id,
      message_created_at, deleted_at, source, source_event_type, source_idempotency_key,
      source_journal_id, source_received_at, retain_until)
    values ('fansly', $1, $2, $3, 'head', case when $4 then null else $5::timestamptz end,
      case when $6 then now() end, 'webhook', 'messages.received', $2, 1, now(), now() + interval '100 years')`,
  [pageId, binding, group, pending, at, deleted]);
}

async function readerState() {
  const { rows } = await listAgentTranscript(db.db, {
    pageId, platform: "fansly", conversationRef: "group", sortDir: "asc", limit: 100,
    from: new Date("2026-09-14T00:00:00Z"), to: new Date("2026-09-15T00:00:00Z"), filters: {},
  });
  const row = rows.find(row => row.messageRef === "head");
  return row === undefined ? "missing" : row.deletedAt !== null ? "deleted"
    : row.contentPending ? "content_pending" : "materialized";
}

it.each([
  { hot: false, archive: false, state: "missing" },
  { hot: true, archive: false, state: "materialized" },
  { hot: false, archive: true, state: "materialized" },
  { hot: true, archive: true, pending: true, state: "content_pending" },
  { hot: true, archive: true, deleted: true, state: "deleted" },
  { hot: true, hotDeleted: true, archive: true, state: "deleted" },
  { hot: true, archive: true, coldPending: true, state: "content_pending" },
])("matches Agent transcript precedence for $state: %j", async scenario => {
  if (scenario.hot) await hot(scenario.hotDeleted);
  if (scenario.archive) await archive(scenario.pending, scenario.deleted);
  if (scenario.coldPending) await cold("group", true, false);
  const receipt = (await queryFanslyDmReaderHeads(db.db, pageId, [head])).get(fanslyDmReaderHeadKey(head));
  expect(receipt?.state).toBe(scenario.state);
  expect(receipt?.state).toBe(await readerState());
});

it("uses current page/group binding and cannot turn a foreign same-ID row into evidence", async () => {
  const model = await createModel(db.db, { slug: "foreign", name: "Foreign" });
  const foreign = await createFanslyPage(db.db, { modelId: model!.id, label: "foreign" });
  await hot(false, foreign!.id);
  await hot(false, pageId, "other-group");
  await archive(false, false, foreign!.id);
  await archive(false, false, pageId, "other-group");
  const state = async () => (await queryFanslyDmReaderHeads(db.db, pageId, [head]))
    .get(fanslyDmReaderHeadKey(head))?.state;
  expect(await state()).toBe("missing");
  expect(await readerState()).toBe("missing");
  await hot();
  expect(await state()).toBe("materialized");
});

it("applies cross-source tombstones only through an existing candidate and current binding", async () => {
  await cold(null, true, true);
  await db.pool.query("update pages set ofapi_account_id = 'binding' where id = $1", [pageId]);
  const state = async () => (await queryFanslyDmReaderHeads(db.db, pageId, [head]))
    .get(fanslyDmReaderHeadKey(head))?.state;
  expect(await state()).toBe("missing");
  await archive();
  expect(await state()).toBe("deleted");
  expect(await readerState()).toBe("deleted");
  for (const binding of [null, "different"]) {
    await db.pool.query("update pages set ofapi_account_id = $1 where id = $2", [binding, pageId]);
    expect(await state()).toBe("materialized");
    expect(await readerState()).toBe("materialized");
  }
});

it("resolves an archive-only head from the archive, with no live hot copy", async () => {
  await archive(false, false, pageId, "archive-only");
  const target = { conversationRef: "archive-only", messageId: "head" };
  expect((await queryFanslyDmReaderHeads(db.db, pageId, [target])).get(fanslyDmReaderHeadKey(target))).toEqual({
    state: "materialized", source: "message_archive", liveHotCopy: false,
  });
});

it("rejects oversized batches, keeps invalid-page evidence unknown and handles duplicate targets", async () => {
  await archive();
  expect((await queryFanslyDmReaderHeads(db.db, pageId, [head, head])).size).toBe(1);
  expect((await queryFanslyDmReaderHeads(db.db, 0, [head])).get(fanslyDmReaderHeadKey(head))?.state).toBeNull();
  await expect(queryFanslyDmReaderHeads(db.db, pageId, Array.from({ length: 101 }, () => head)))
    .rejects.toThrow("exceeds one list page");
});

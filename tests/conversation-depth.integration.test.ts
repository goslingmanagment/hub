import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  readConversationDepth,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// chat-extension `coach-depth-v1`: the archive feed's `depth` and Coach's
// prompt count a conversation's messages with the reader a generation uses,
// so «Coach reads N of storedCount» holds and mark N is the oldest message a
// Coach of `messageCount: N` reads.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

const HOUR = 3_600_000;
const T0 = Date.parse("2026-06-01T10:00:00.000Z");
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();
const OFAPI_ACCOUNT = "acct_depth";

function db() {
  if (!testDb) throw new Error("test database required");
  return testDb;
}

async function insertArchiveRow(input: {
  pageId: number;
  platform: "onlyfans" | "fansly";
  conv: string;
  ref: string;
  occurredAt: string | null;
  deletedAt?: string | null;
  contentPending?: boolean;
}) {
  await db().pool.query(
    `insert into message_archive (
       account_id, platform, conversation_ref, message_ref, sender_role,
       is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending, backfill_source
     ) values ($1, $2, $3, $4, 'fan', false, $5, $6, $7, $8, 'seed')`,
    [input.pageId, input.platform, input.conv, input.ref, input.occurredAt, `archive ${input.ref}`,
      input.deletedAt ?? null, input.contentPending ?? false],
  );
}

async function insertDmRow(input: { pageId: number; conv: string; ref: string; createdAt: string; deleted?: boolean }) {
  await db().pool.query(
    `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain,
       is_tip, tip_amount_mills, deleted_at, source, source_event_type, source_idempotency_key,
       source_journal_id, source_received_at, retain_until)
     values ('onlyfans', $1, $2, $3, $3, $4, 'fan', false, $5, $6, false, 0, $7, 'webhook', $8, $9, 1, now(),
       now() + interval '100 years')`,
    [input.pageId, OFAPI_ACCOUNT, input.conv, input.ref, input.createdAt, `dm ${input.ref}`,
      input.deleted === true ? new Date() : null,
      input.deleted === true ? "messages.deleted" : "messages.received",
      `depth-${input.ref}-${input.deleted === true ? "tomb" : "msg"}`],
  );
}

async function seedModel(slug: string) {
  const model = await createModel(db().db, { slug, name: slug });
  if (!model) throw new Error("model seed failed");
  return model;
}

describe("conversation depth", () => {
  it("counts a Fansly chat as the archive reader serves it, and dates each count as Coach would read it", async () => {
    const model = await seedModel("depth-fs");
    const page = await createFanslyPage(db().db, { modelId: model.id, label: "depth-fs" });
    if (!page) throw new Error("page seed failed");
    const conv = "700001";
    const row = (ref: string, occurredAt: string | null, extra: { deletedAt?: string; contentPending?: boolean } = {}) =>
      insertArchiveRow({ pageId: page.id, platform: "fansly", conv, ref, occurredAt, ...extra });
    for (let index = 0; index < 6; index += 1) {
      await row(String(5001 + index), at(index));
    }
    // Never served, so never counted: deleted, a stub, no time, an id the transcript cannot key (none on
    // production; the oldest here, so the shorter read below does not spend a row on it), another chat.
    await row("5007", at(10), { deletedAt: at(11) });
    await row("5008", at(12), { contentPending: true });
    await row("5009", null);
    await row("local-1", at(-1));
    await insertArchiveRow({ pageId: page.id, platform: "fansly", conv: "700002", ref: "6001", occurredAt: at(-5) });

    const depth = await readConversationDepth(db().db, { source: "archive", pageId: page.id, conversationRef: conv, marks: [1, 3, 6, 7] });
    expect(depth.storedCount).toBe(6);
    expect(depth.oldestAt?.toISOString()).toBe(at(0));
    expect(depth.marks.map((mark) => ({ count: mark.count, at: mark.at.toISOString() }))).toEqual([
      { count: 1, at: at(5) },
      { count: 3, at: at(3) },
      { count: 6, at: at(0) },
    ]);

    const transcript = (limit: number) => loadTranscriptContext({ db: db().db }, {
      pageId: page.id, conversationRef: conv, limit, unionMode: "off", liveOverlay: "off",
    });
    expect((await transcript(100)).messages).toHaveLength(depth.storedCount);
    const three = await transcript(3);
    expect(three.messages).toHaveLength(3);
    expect(three.messages[0]!.createdAtMs).toBe(Date.parse(at(3)));
  });

  it("counts an OnlyFans chat through the union: one per message across both stores, tombstones out", async () => {
    const model = await seedModel("depth-of");
    const page = await createOnlyFansPage(db().db, { modelId: model.id, label: "depth-of" });
    if (!page) throw new Error("page seed failed");
    await setPageOfapiAccountId(db().db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
    const conv = "800001";
    for (const [ref, hours] of [["7001", 0], ["7002", 1], ["7003", 2], ["7004", 3]] as const) {
      await insertArchiveRow({ pageId: page.id, platform: "onlyfans", conv, ref, occurredAt: at(hours) });
    }
    await insertArchiveRow({ pageId: page.id, platform: "onlyfans", conv, ref: "7006", occurredAt: at(6), contentPending: true });
    // The same message in both stores counts once; a webhook-only message counts; a deletion hides its message.
    await insertDmRow({ pageId: page.id, conv, ref: "7004", createdAt: at(3) });
    await insertDmRow({ pageId: page.id, conv, ref: "7005", createdAt: at(4) });
    await insertDmRow({ pageId: page.id, conv, ref: "7002", createdAt: at(1), deleted: true });

    const depth = await readConversationDepth(db().db, { source: "union", pageId: page.id, conversationRef: conv, marks: [2, 4, 5] });
    expect(depth.storedCount).toBe(4);
    expect(depth.oldestAt?.toISOString()).toBe(at(0));
    expect(depth.marks.map((mark) => ({ count: mark.count, at: mark.at.toISOString() }))).toEqual([
      { count: 2, at: at(3) },
      { count: 4, at: at(0) },
    ]);

    const transcript = (limit: number) => loadTranscriptContext({ db: db().db }, {
      pageId: page.id, conversationRef: conv, limit, unionMode: "serve", liveOverlay: "off",
    });
    expect((await transcript(100)).messages.map((message) => message.id)).toEqual(["7001", "7003", "7004", "7005"]);
    const two = await transcript(2);
    expect(two.messages[0]!.createdAtMs).toBe(Date.parse(at(3)));
  });

  it("answers an empty chat with nothing", async () => {
    const model = await seedModel("depth-empty");
    const page = await createFanslyPage(db().db, { modelId: model.id, label: "depth-empty" });
    if (!page) throw new Error("page seed failed");
    await expect(readConversationDepth(db().db, { source: "archive", pageId: page.id, conversationRef: "1", marks: [300] }))
      .resolves.toEqual({ storedCount: 0, oldestAt: null, marks: [] });
  });
});

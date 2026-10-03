import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  explainConversationFeedPage,
  listAiTranscriptUnionMessages,
  listArchiveConversationMessagesForAi,
  listConversationFeedPage,
  readConversationFeedSnapshot,
  setPageOfapiAccountId,
  type ConversationFeedPosition,
  type ConversationFeedRow,
  type ConversationFeedSnapshot,
  type ConversationFeedSource,
} from "@agency_hub_core/db";

import { loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound-trap.ts";

// H-9b: the chat extension's archive feed reader. Database only; newest first
// by (event time, guarded-numeric id, id); tombstones are rows flagged
// `deleted`, stubs never show; a walk is bounded by the snapshot it started on.
// The union source is the AI union's own CTE chain, so the feed's live rows
// are exactly a generation's rows.

let testDb: StartedTestDatabase | null = null;
let trap: NoOutboundTrap | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
});

afterEach(async () => {
  await trap?.restore();
  trap = null;
});

const CONV = "555001";
const OFAPI_ACCT = "acct_feed";
const BASE_MS = Date.parse("2026-06-01T00:00:00.000Z");

function db() {
  if (!testDb) throw new Error("test database required");
  return testDb;
}

async function seedPage(label = "feed-of", ofapiAccountId = OFAPI_ACCT) {
  const model = await createModel(db().db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(db().db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  await setPageOfapiAccountId(db().db, { pageId: page.id, ofapiAccountId });
  return page;
}

async function insertArchiveRow(input: {
  pageId: number;
  ref: string;
  conv?: string;
  text?: string;
  occurredAt?: string | null;
  deletedAt?: string | null;
  contentPending?: boolean;
  fromModel?: boolean;
}) {
  await db().pool.query(
    `insert into message_archive (
       account_id, platform, conversation_ref, message_ref, sender_role,
       is_sent_by_me, occurred_at, text_plain, deleted_at, content_pending, backfill_source
     ) values ($1, 'onlyfans', $2, $3, $4, $5, $6, $7, $8, $9, 'seed')`,
    [
      input.pageId,
      input.conv ?? CONV,
      input.ref,
      input.fromModel ? "model" : "fan",
      input.fromModel === true,
      input.occurredAt === null ? null : input.occurredAt ?? "2026-07-01T10:00:00Z",
      input.text ?? `archive ${input.ref}`,
      input.deletedAt ?? null,
      input.contentPending ?? false,
    ],
  );
}

async function insertDmRow(input: {
  pageId: number;
  ref: string;
  conv?: string | null;
  text?: string;
  createdAt?: string | null;
  deletedAt?: string | null;
  isOpened?: boolean | null;
}) {
  await db().pool.query(
    `insert into dm_message_archive (
       platform, platform_account_id, ofapi_account_id, platform_conversation_id,
       fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me,
       message_created_at, text_plain, is_opened, is_tip, tip_amount_mills,
       deleted_at, source, source_event_type, source_idempotency_key,
       source_journal_id, source_received_at, retain_until
     ) values (
       'onlyfans', $1, $2, $3, $4, $5, 'fan', false, $6, $7, $8, false, 0, $9,
       'webhook', $10, $11, 1, now(), now() + interval '100 years'
     )`,
    [
      input.pageId,
      OFAPI_ACCT,
      input.conv === null ? null : input.conv ?? CONV,
      input.conv === null ? null : CONV,
      input.ref,
      input.createdAt === null ? null : input.createdAt ?? "2026-07-01T10:00:00Z",
      input.text ?? `dm ${input.ref}`,
      input.isOpened ?? null,
      input.deletedAt ?? null,
      input.deletedAt != null && input.createdAt === null ? "messages.deleted" : "messages.received",
      `feed-test-${input.ref}-${input.deletedAt != null ? "tomb" : "msg"}`,
    ],
  );
}

async function insertHotRow(input: { pageId: number; ref: string; purchasedAt?: string | null; deletedAt?: string | null }) {
  const thread = await db().pool.query<{ id: number }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id)
     values ($1, $2)
     on conflict (platform_account_id, platform_conversation_id) do update set last_seen_at = now()
     returning id`,
    [input.pageId, CONV],
  );
  await db().pool.query(
    `insert into page_dm_messages (
       conversation_id, platform_account_id, platform_message_id, sender_role,
       created_at, content, purchased_at, deleted_at
     ) values ($1, $2, $3, 'fan', now(), '', $4, $5)`,
    [thread.rows[0]!.id, input.pageId, input.ref, input.purchasedAt ?? null, input.deletedAt ?? null],
  );
}

/** Every row of the snapshot, by walking it `pageSize` at a time. */
async function walk(input: {
  source: ConversationFeedSource;
  pageId: number;
  snapshot: ConversationFeedSnapshot;
  pageSize: number;
  conversationRef?: string;
  between?: (pageIndex: number, before: ConversationFeedPosition) => Promise<void>;
}): Promise<{ rows: ConversationFeedRow[]; pages: number }> {
  const rows: ConversationFeedRow[] = [];
  let before: ConversationFeedPosition | null = null;
  let pages = 0;
  for (;;) {
    const page = await listConversationFeedPage(db().db, {
      source: input.source,
      pageId: input.pageId,
      conversationRef: input.conversationRef ?? CONV,
      snapshot: input.snapshot,
      before,
      limit: input.pageSize,
    });
    pages += 1;
    rows.push(...page.rows);
    if (page.nextBefore === null) {
      return { rows, pages };
    }
    expect(page.rows).toHaveLength(input.pageSize);
    before = page.nextBefore;
    await input.between?.(pages, before);
    if (pages > 10_000) throw new Error("walk did not terminate");
  }
}

function at(seconds: number): string {
  return new Date(BASE_MS + seconds * 1000).toISOString();
}

describe("conversation feed reader (H-9b)", () => {
  it("union: the AI union's live rows, plus tombstones as deleted rows; stubs never show", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await insertArchiveRow({ pageId: page.id, ref: "100", occurredAt: "2026-07-01T10:00:00Z" });
    await insertDmRow({ pageId: page.id, ref: "101", createdAt: "2026-07-01T10:01:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "102", text: "stale copy", occurredAt: "2026-07-01T10:02:00Z" });
    await insertDmRow({ pageId: page.id, ref: "102", text: "fresh copy", createdAt: "2026-07-01T10:02:00Z" });
    // Stubs: archive content-pending, dm without a creation time.
    await insertArchiveRow({ pageId: page.id, ref: "103", contentPending: true, occurredAt: null });
    await insertDmRow({ pageId: page.id, ref: "104", createdAt: null });
    // Tombstoned three ways: a chat-less dm deletion stub (cross-source arm),
    // the archive row itself, the hot table.
    await insertArchiveRow({ pageId: page.id, ref: "200", occurredAt: "2026-07-01T09:00:00Z", text: "said then deleted" });
    await insertDmRow({ pageId: page.id, ref: "200", conv: null, createdAt: null, deletedAt: "2026-07-02T00:00:00Z" });
    await insertDmRow({ pageId: page.id, ref: "201", createdAt: "2026-07-01T11:00:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "201", deletedAt: "2026-07-02T00:00:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "202", occurredAt: "2026-07-01T08:00:00Z" });
    await insertDmRow({ pageId: page.id, ref: "202", createdAt: "2026-07-01T08:00:00Z" });
    await insertHotRow({ pageId: page.id, ref: "202", deletedAt: "2026-07-02T00:00:00Z" });
    // PPV upgrade from the hot table, as in the AI read.
    await insertDmRow({ pageId: page.id, ref: "300", isOpened: false, createdAt: "2026-07-01T07:00:00Z" });
    await insertHotRow({ pageId: page.id, ref: "300", purchasedAt: "2026-07-01T07:05:00Z" });
    // Another conversation never leaks in.
    await insertArchiveRow({ pageId: page.id, ref: "900", conv: "other", occurredAt: "2026-07-01T12:00:00Z" });

    trap = await armNoOutboundTrap(testDb);
    const snapshot = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });
    const { rows } = await walk({ source: "union", pageId: page.id, snapshot, pageSize: 50 });
    const ai = await listAiTranscriptUnionMessages(testDb.db, { pageId: page.id, conversationRef: CONV, limit: 1500 });
    const transcript = await loadTranscriptContext({ db: testDb.db } as never, {
      pageId: page.id, conversationRef: CONV, limit: 100, unionMode: "serve",
    });
    await trap.assertNoOutbound();

    expect(rows.map((row) => [row.messageRef, row.deleted])).toEqual([
      ["201", true], ["102", false], ["101", false], ["100", false],
      ["200", true], ["202", true], ["300", false],
    ]);
    expect(rows.find((row) => row.messageRef === "200")!.textPlain).toBe("said then deleted");
    // The live rows ARE the AI union's rows: same order, same resolution.
    const pick = (row: { messageRef: string; textPlain: string; isOpened: boolean | null; occurredAt: Date | null }) =>
      [row.messageRef, row.textPlain, row.isOpened, row.occurredAt?.toISOString() ?? null];
    expect(rows.filter((row) => !row.deleted).map(pick)).toEqual(ai.map(pick));
    // On one snapshot the feed's newest live row is the generation's served head.
    expect(transcript.contextManifest.source).toBe("union");
    expect(transcript.contextManifest.unionHeadRef).toBe("102");
    expect(String(transcript.messages.at(-1)!.id)).toBe(rows.find((row) => !row.deleted)!.messageRef);
  });

  it("archive: the AI archive reader's rows, deletions flagged, stubs hidden, ties broken by message id", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    // Same second; "11" is inserted FIRST, so the row-id order is the reverse
    // of the message-id order. The feed (and the served transcript) order by
    // message id.
    await insertArchiveRow({ pageId: page.id, ref: "11", occurredAt: "2026-07-01T10:00:00Z", fromModel: true });
    await insertArchiveRow({ pageId: page.id, ref: "10", occurredAt: "2026-07-01T10:00:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "12", occurredAt: "2026-07-01T09:00:00Z", deletedAt: "2026-07-02T00:00:00Z" });
    await insertArchiveRow({ pageId: page.id, ref: "13", occurredAt: null, contentPending: true });
    await insertArchiveRow({ pageId: page.id, ref: "14", occurredAt: "2026-07-01T08:00:00Z" });
    // The dm store is not this source.
    await insertDmRow({ pageId: page.id, ref: "15", createdAt: "2026-07-01T11:00:00Z" });

    trap = await armNoOutboundTrap(testDb);
    const snapshot = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });
    const { rows } = await walk({ source: "archive", pageId: page.id, snapshot, pageSize: 2 });
    const ai = await listArchiveConversationMessagesForAi(testDb.db, { accountId: page.id, conversationRef: CONV, limit: 1500 });
    const transcript = await loadTranscriptContext({ db: testDb.db } as never, {
      pageId: page.id, conversationRef: CONV, limit: 100, unionMode: "off",
    });
    await trap.assertNoOutbound();

    expect(rows.map((row) => [row.messageRef, row.deleted, row.isSentByMe])).toEqual([
      ["11", false, true], ["10", false, false], ["12", true, false], ["14", false, false],
    ]);
    expect(new Set(rows.filter((row) => !row.deleted).map((row) => row.messageRef)))
      .toEqual(new Set(ai.map((row) => row.messageRef)));
    expect(transcript.contextManifest.source).toBe("archive");
    expect(String(transcript.messages.at(-1)!.id)).toBe(rows[0]!.messageRef);
  });

  it.for(["archive", "union"] as const)("%s: a total order — microseconds, numeric ids, lexical ids, undated last — at any page size", async (source, context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    const seeds: Array<{ ref: string; at: string | null }> = [
      { ref: "600", at: "2026-07-01T10:00:00.000002Z" },
      { ref: "601", at: "2026-07-01T10:00:00.000001Z" },
      { ref: "10", at: "2026-07-01T10:00:00Z" },
      { ref: "010", at: "2026-07-01T10:00:00Z" },
      { ref: "9", at: "2026-07-01T10:00:00Z" },
      { ref: "zz-legacy", at: "2026-07-01T10:00:00Z" },
      { ref: "77", at: null },
      { ref: "b2", at: null },
      { ref: "a1", at: null },
    ];
    for (const [index, seed] of seeds.entries()) {
      // The union source reads both stores: alternate them.
      if (source === "union" && index % 2 === 1) {
        if (seed.at === null) {
          // A dm row without a creation time is a stub; undated rows come from the archive.
          await insertArchiveRow({ pageId: page.id, ref: seed.ref, occurredAt: null });
        } else {
          await insertDmRow({ pageId: page.id, ref: seed.ref, createdAt: seed.at });
        }
      } else {
        await insertArchiveRow({ pageId: page.id, ref: seed.ref, occurredAt: seed.at });
      }
    }
    const expected = ["600", "601", "10", "010", "9", "zz-legacy", "77", "b2", "a1"];
    const snapshot = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });
    for (const pageSize of [1, 2, 4, 50]) {
      const { rows, pages } = await walk({ source, pageId: page.id, snapshot, pageSize });
      expect(rows.map((row) => row.messageRef), `page size ${pageSize}`).toEqual(expected);
      expect(pages).toBe(Math.ceil(expected.length / pageSize));
    }
    const head = await listConversationFeedPage(testDb.db, {
      source, pageId: page.id, conversationRef: CONV, snapshot, limit: 3,
    });
    expect(head.rows.map((row) => row.position)).toEqual([
      { at: "2026-07-01T10:00:00.000002Z", ref: "600" },
      { at: "2026-07-01T10:00:00.000001Z", ref: "601" },
      { at: "2026-07-01T10:00:00.000000Z", ref: "10" },
    ]);
    if (source === "union") {
      const ai = await listAiTranscriptUnionMessages(testDb.db, { pageId: page.id, conversationRef: CONV, limit: 1500 });
      expect(ai.map((row) => row.messageRef)).toEqual(expected);
    }
  });

  it.for(["archive", "union"] as const)("%s: a walk stays inside its snapshot; deletions inside it show as deleted", async (source, context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    for (let index = 1; index <= 5; index += 1) {
      if (source === "union" && index % 2 === 0) {
        await insertDmRow({ pageId: page.id, ref: String(index), createdAt: at(index) });
      } else {
        await insertArchiveRow({ pageId: page.id, ref: String(index), occurredAt: at(index) });
      }
    }
    const snapshot = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });

    // After the snapshot: a new message, a late backfill of an OLD message, a
    // newer REST copy of a message the walk will reach, and a deletion.
    await insertArchiveRow({ pageId: page.id, ref: "6", occurredAt: at(6) });
    await insertArchiveRow({ pageId: page.id, ref: "50", occurredAt: at(-50) });
    if (source === "union") {
      await insertDmRow({ pageId: page.id, ref: "3", createdAt: at(3), text: "copy after the snapshot" });
      await insertDmRow({ pageId: page.id, ref: "1", conv: null, createdAt: null, deletedAt: at(100) });
    } else {
      await db().pool.query(
        "update message_archive set deleted_at = now() where account_id = $1 and message_ref = '1'",
        [page.id],
      );
    }

    const { rows } = await walk({ source, pageId: page.id, snapshot, pageSize: 2 });
    expect(rows.map((row) => [row.messageRef, row.deleted])).toEqual([
      ["5", false], ["4", false], ["3", false], ["2", false], ["1", true],
    ]);
    expect(rows.find((row) => row.messageRef === "3")!.textPlain).toBe("archive 3");

    // A fresh snapshot sees all of it.
    const fresh = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });
    expect(fresh.archiveMaxId).toBeGreaterThan(snapshot.archiveMaxId);
    const all = await walk({ source, pageId: page.id, snapshot: fresh, pageSize: 50 });
    expect(all.rows.map((row) => row.messageRef)).toEqual(["6", "5", "4", "3", "2", "1", "50"]);
  });

  it.for(["archive", "union"] as const)("%s: 3200 messages by 100 — no hole, no duplicate — while messages arrive and get deleted", { timeout: 120_000 }, async (source, context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    const total = 3200;
    const ref = (g: number) => String(1_000_000 + g);
    // Time grows with g, so the walk visits g = 3200 … 1.
    if (source === "union") {
      // Archive holds 1..3000, dm holds 2801..3200: 200 in both, 200 dm-only.
      await db().pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
         select $1, 'onlyfans', $2, (1000000 + g)::text, 'fan', false, $3::timestamptz + (g || ' seconds')::interval, 'archive ' || g, 'seed'
         from generate_series(1, 3000) g`,
        [page.id, CONV, at(0)],
      );
      await db().pool.query(
        `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
         select 'onlyfans', $1, $2, $3, $3, (1000000 + g)::text, 'fan', false, $4::timestamptz + (g || ' seconds')::interval, 'dm ' || g, false, 0, 'webhook', 'messages.received', 'walk-' || g, 1, now(), now() + interval '100 years'
         from generate_series(2801, 3200) g`,
        [page.id, OFAPI_ACCT, CONV, at(0)],
      );
    } else {
      await db().pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
         select $1, 'onlyfans', $2, (1000000 + g)::text, 'fan', false, $3::timestamptz + (g || ' seconds')::interval, 'archive ' || g, 'seed'
         from generate_series(1, 3200) g`,
        [page.id, CONV, at(0)],
      );
    }
    // Deleted before the walk starts.
    const deletedBefore = new Set([500, 1500, 2900, 3100].map(ref));
    for (const deleted of deletedBefore) {
      await deleteMessage(page.id, source, deleted);
    }

    const snapshot = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });
    const deletedAhead = new Set<string>();
    const intruders = new Set<string>();
    trap = await armNoOutboundTrap(testDb);
    const { rows, pages } = await walk({
      source,
      pageId: page.id,
      snapshot,
      pageSize: 100,
      between: async (pageIndex) => {
        // Outside the trap's concern: these writes stand in for the webhook,
        // projection and backfill workers running beside the walk.
        const arrival = `20${String(pageIndex).padStart(5, "0")}`;
        const backfill = `90${String(pageIndex).padStart(5, "0")}`;
        intruders.add(arrival).add(backfill);
        await insertArchiveRow({ pageId: page.id, ref: arrival, occurredAt: at(10_000 + pageIndex) });
        await insertArchiveRow({ pageId: page.id, ref: backfill, occurredAt: at(-pageIndex) });
        if (source === "union") {
          const dmArrival = `30${String(pageIndex).padStart(5, "0")}`;
          intruders.add(dmArrival);
          await insertDmRow({ pageId: page.id, ref: dmArrival, createdAt: at(10_000 + pageIndex) });
        }
        const cursorG = total - pageIndex * 100;
        const ahead = cursorG - 50;
        if (ahead >= 1) {
          deletedAhead.add(ref(ahead));
          await deleteMessage(page.id, source, ref(ahead));
        }
        // Already served: deleting it must not bring it back.
        await deleteMessage(page.id, source, ref(cursorG + 50));
      },
    });
    await trap.assertNoOutbound();

    expect(pages).toBe(total / 100);
    const refs = rows.map((row) => row.messageRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual(Array.from({ length: total }, (_unused, index) => ref(total - index)));
    expect(refs.filter((visited) => intruders.has(visited))).toEqual([]);
    const deleted = new Set(rows.filter((row) => row.deleted).map((row) => row.messageRef));
    expect(deleted).toEqual(new Set([...deletedBefore, ...deletedAhead]));
  });

  async function deleteMessage(pageId: number, source: ConversationFeedSource, messageRef: string) {
    if (source === "archive") {
      await db().pool.query(
        "update message_archive set deleted_at = now() where account_id = $1 and message_ref = $2 and deleted_at is null",
        [pageId, messageRef],
      );
      return;
    }
    // Union: a dm deletion — in place when the dm store holds the message,
    // otherwise the chat-less stub a delete webhook leaves.
    const updated = await db().pool.query(
      "update dm_message_archive set deleted_at = now() where platform_account_id = $1 and platform_message_id = $2",
      [pageId, messageRef],
    );
    if (updated.rowCount === 0) {
      await insertDmRow({ pageId, ref: messageRef, conv: null, createdAt: null, deletedAt: new Date().toISOString() });
    }
  }

  it("perf gate: both conversation indexes drive a mid-walk page; no archive store is scanned whole", async (context) => {
    if (!testDb) return context.skip();
    // Plans read pg_class: start from fresh files.
    await resetIntegrationDatabase(testDb.pool, { physical: true });
    const page = await seedPage();
    const otherPage = await seedPage("feed-of-2", "acct_feed2");
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select $1, 'onlyfans', $2, (1000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'archive ' || g, 'seed'
       from generate_series(1, 10000) g`,
      [page.id, CONV],
    );
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       select 'onlyfans', $1, $2, $3, $3, (1000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'dm ' || g, false, 0, 'webhook', 'messages.received', 'perf-' || g, 1, now(), now() + interval '100 years'
       from generate_series(1, 3000) g`,
      [page.id, OFAPI_ACCT, CONV],
    );
    // The spread dominates the tables, as in production.
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at, text_plain, backfill_source)
       select case when g % 2 = 0 then $1::bigint else $2::bigint end, 'onlyfans', 'conv-' || (g % 80), (2000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread ' || g, 'seed'
       from generate_series(1, 80000) g`,
      [page.id, otherPage.id],
    );
    await testDb.pool.query(
      `insert into dm_message_archive (platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id, platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, is_tip, tip_amount_mills, source, source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until)
       select 'onlyfans', case when g % 2 = 0 then $1::bigint else $2::bigint end, case when g % 2 = 0 then $3::text else $4::text end, 'conv-' || (g % 80), 'f', (6000000 + g)::text, 'fan', false, now() - (g || ' seconds')::interval, 'spread dm ' || g, false, 0, 'webhook', 'messages.received', 'perf-spread-' || g, 1, now(), now() + interval '100 years'
       from generate_series(1, 40000) g`,
      [page.id, otherPage.id, OFAPI_ACCT, "acct_feed2"],
    );
    await testDb.pool.query("analyze message_archive, dm_message_archive, page_dm_messages, page_dm_threads, pages");

    const snapshot = await readConversationFeedSnapshot(testDb.db, { pageId: page.id });
    const head = await listConversationFeedPage(testDb.db, {
      source: "union", pageId: page.id, conversationRef: CONV, snapshot, limit: 100,
    });
    const midWalk = {
      pageId: page.id, conversationRef: CONV, snapshot, limit: 100, before: head.nextBefore,
    };
    const unionPlan = await explainConversationFeedPage(testDb.db, { ...midWalk, source: "union" });
    expect(unionPlan).toContain("message_archive_account_conv_idx");
    expect(unionPlan).toContain("dm_message_archive_page_conversation_idx");
    expect(unionPlan).not.toMatch(/Seq Scan on message_archive/);
    expect(unionPlan).not.toMatch(/Seq Scan on dm_message_archive/);
    const archivePlan = await explainConversationFeedPage(testDb.db, { ...midWalk, source: "archive" });
    expect(archivePlan).toContain("message_archive_account_conv_idx");
    expect(archivePlan).not.toMatch(/Seq Scan on message_archive/);

    const durations: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      const pageRows = await listConversationFeedPage(testDb.db, { ...midWalk, source: "union" });
      durations.push(performance.now() - startedAt);
      expect(pageRows.rows).toHaveLength(100);
    }
    // Median, as in the AI union's gate: one run stalled behind a loaded CI
    // host says nothing about the query.
    const median = [...durations].sort((left, right) => left - right)[Math.floor(durations.length / 2)]!;
    expect(median, `runs: ${durations.map((ms) => ms.toFixed(0)).join(", ")} ms`).toBeLessThan(1500);
  }, 120_000);
});

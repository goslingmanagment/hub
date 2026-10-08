// H-8b: silence follows the messages a generation of the page reads. Where the
// AI transcript is served from the union of the archive and the webhook store
// (OnlyFans, `aiTranscriptFreshUnionMode = serve`), the Spenders statistics
// read the fan's last text from that union too, so the stats and the Ping chip
// of one chat agree. This holds the probe that answers it
// (`aiTranscriptUnionLastFanTextAtSql`) to the union's own reader, case by
// case, and pins its plan.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  aiTranscriptUnionLastFanTextAtSql,
  explainPageSpenderSilenceQuery,
  getPageSpenderStats,
  listAiTranscriptUnionMessages,
  setPageOfapiAccountId,
  type Database,
} from "@agency_hub_core/db";

import { sql, type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  SPENDER_STATS_FIXTURE_AS_OF,
  SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT,
  spenderStatsFixture,
} from "./helpers/spender-stats-fixture.ts";

const AS_OF = SPENDER_STATS_FIXTURE_AS_OF;

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

function db() {
  if (!testDb) throw new Error("test database missing");
  return testDb;
}

const { seedPage, seedFan, addTransaction, addThread, addMessage, addDmMessage, seedMainPage, rebuildAll } =
  spenderStatsFixture(db);

async function seedBoundPage(label: string) {
  const page = await seedPage(label);
  await setPageOfapiAccountId(db().db, { pageId: page.id, ofapiAccountId: SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT });
  return page;
}

/** A deletion mark in the hot table, the union's third tombstone source. */
async function addHotTombstone(pageId: number, conversationRef: string, ref: string) {
  const thread = await db().pool.query<{ id: number }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id)
     values ($1, $2)
     on conflict (platform_account_id, platform_conversation_id) do update set last_seen_at = now()
     returning id`,
    [pageId, conversationRef],
  );
  await db().pool.query(
    `insert into page_dm_messages (
       conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content, deleted_at
     ) values ($1, $2, $3, 'fan', now(), '', now())`,
    [thread.rows[0]!.id, pageId, ref],
  );
}

/** The probe's answer for one conversation. */
async function probe(pageId: number, conversationRef: string, database: Database = db().db): Promise<string | null> {
  const result = await database.execute<{ at: Date | string | null }>(
    sql`select ${aiTranscriptUnionLastFanTextAtSql({ pageId, conversationRef: sql`${conversationRef}` })} as at`,
  );
  const at = result.rows[0]?.at ?? null;
  return at === null ? null : new Date(at).toISOString();
}

const DIALECT = new PgDialect();
const ARCHIVE_TAIL = /(from message_archive ma\s+where ma\.account_id = \$\d+)(\s+and ma\.conversation_ref = )/g;

/**
 * The database with the probe as it was until 2026-10-08: every statement
 * runs as rendered, except that the archive tail names the platform again
 * (`ma.platform = 'onlyfans'`). `pinned()` counts the tails it changed, so a
 * test can tell that the statement it compares is the probe's.
 */
function withPlatformLiteral() {
  let pinned = 0;
  const database = {
    execute: async (query: SQL) => {
      const rendered = DIALECT.sqlToQuery(query);
      const text = rendered.sql.replace(ARCHIVE_TAIL, (_match, head: string, rest: string) => {
        pinned += 1;
        return `${head}\n          and ma.platform = 'onlyfans'${rest}`;
      });
      return db().pool.query(text, rendered.params as unknown[]);
    },
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(database),
  };
  return { db: database as unknown as Database, pinned: () => pinned };
}

/** Rows one index scan of an EXPLAIN ANALYZE read: returned plus filtered out, per loop, times the loops. */
function rowsRead(plan: string, scan: string) {
  const match = plan.match(new RegExp(
    `${scan}[^\\n]*actual time=[\\d.]+\\.\\.[\\d.]+ rows=([\\d.]+) loops=(\\d+)\\)[\\s\\S]*?Rows Removed by Filter: (\\d+)`,
  ));
  expect(match, scan).not.toBeNull();
  return { loops: Number(match![2]), read: Math.round((Number(match![1]) + Number(match![3])) * Number(match![2])) };
}

/** The same question asked of the rows a generation reads: the union's own reader, whole chat. */
async function fromUnionReader(pageId: number, conversationRef: string): Promise<string | null> {
  const rows = await listAiTranscriptUnionMessages(db().db, { pageId, conversationRef, limit: 1500 });
  const times = rows
    .filter((row) => !row.isSentByMe && /\S/.test(row.textPlain) && row.occurredAt !== null)
    .map((row) => row.occurredAt!.getTime());
  return times.length === 0 ? null : new Date(Math.max(...times)).toISOString();
}

const T = {
  aug: "2026-08-01T12:00:00.000Z",
  sep10: "2026-09-10T12:00:00.000Z",
  sep20: "2026-09-20T12:00:00.000Z",
  oct1: "2026-10-01T12:00:00.000Z",
  oct2: "2026-10-02T12:00:00.000Z",
  oct3: "2026-10-03T11:00:00.000Z",
} as const;

interface UnionCase {
  name: string;
  /** The fan's last text as the union serves it. */
  expected: string | null;
  seed(pageId: number, conversationRef: string): Promise<void>;
}

const CASES: UnionCase[] = [
  {
    name: "an empty chat",
    expected: null,
    seed: async () => {},
  },
  {
    name: "a fan text only the archive holds",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "hello" });
    },
  },
  {
    name: "a fan text only the webhook store holds yet",
    expected: T.oct3,
    seed: async (pageId, conversationRef) => {
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct3, text: "just now" });
    },
  },
  {
    name: "an old archived text and a fresh one from the webhook store",
    expected: T.oct3,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "old" });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct3, text: "fresh" });
    },
  },
  {
    name: "one message held by both stores",
    expected: T.sep20,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep20, text: "same" });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.sep20, text: "same", ref });
    },
  },
  {
    name: "our messages after the fan's, in both stores",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "last word" });
      await addMessage(pageId, { conversationRef, fromFan: false, at: T.sep20, text: "mass message" });
      await addDmMessage(pageId, { conversationRef, fromFan: false, at: T.oct3, text: "another one" });
    },
  },
  {
    name: "a later fan message without text (media, a tip) in either store",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "text" });
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep20, text: " \n\t " });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct3, text: "" });
    },
  },
  {
    name: "stubs in both stores",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "real" });
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "stub", contentPending: true });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: null, text: "no creation time" });
    },
  },
  {
    name: "an undated fan text",
    expected: null,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: null, text: "when?" });
    },
  },
  {
    name: "a text deleted in the archive",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "kept" });
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "gone", deleted: true });
    },
  },
  {
    name: "a text deleted in the webhook store",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "kept" });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "gone", deleted: true });
    },
  },
  {
    name: "an archived text whose deletion only the webhook store knows (a stub that names no chat)",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "kept" });
      const ref = await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted on the platform" });
      await addDmMessage(pageId, { conversationRef: null, fromFan: true, at: null, text: "", deleted: true, ref });
    },
  },
  {
    name: "an archived text whose webhook copy is deleted",
    expected: null,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted" });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted", deleted: true, ref });
    },
  },
  {
    name: "a webhook text whose archive copy is deleted",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "kept" });
      const ref = await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted" });
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted", deleted: true, ref });
    },
  },
  {
    name: "a webhook text whose archive copy is a deleted stub",
    expected: null,
    seed: async (pageId, conversationRef) => {
      const ref = await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted" });
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "", deleted: true, contentPending: true, ref });
    },
  },
  {
    name: "texts the hot table marks deleted, one per store",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "kept" });
      const archived = await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "deleted" });
      const fresh = await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct2, text: "deleted too" });
      await addHotTombstone(pageId, conversationRef, archived);
      await addHotTombstone(pageId, conversationRef, fresh);
    },
  },
  {
    name: "two copies that disagree on the sender: the webhook copy wins a tie, and it is ours",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "older fan text" });
      const ref = await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "archive says fan" });
      await addDmMessage(pageId, { conversationRef, fromFan: false, at: T.oct1, text: "webhook says model", ref });
    },
  },
  {
    name: "two copies that disagree on the sender: the archive copy has REST material and wins, and it is ours",
    expected: null,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, {
        conversationRef, fromFan: false, at: T.oct1, text: "archive says model", materialObservedAt: T.oct2,
      });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "webhook says fan", ref });
    },
  },
  {
    name: "two copies with REST material: the later platform change wins, here the archive's",
    expected: T.sep20,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, {
        conversationRef, fromFan: true, at: T.sep20, text: "archive", materialObservedAt: T.oct1, vendorChangedAt: T.oct2,
      });
      await addDmMessage(pageId, {
        conversationRef, fromFan: true, at: T.oct1, text: "webhook", ref,
        restMaterialObservedAt: T.oct3, restPlatformChangedAt: T.oct1,
      });
    },
  },
  {
    name: "two copies with REST material and no platform change time: the later observation wins, here the webhook's",
    expected: T.oct1,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, {
        conversationRef, fromFan: true, at: T.sep20, text: "archive", materialObservedAt: T.oct1,
      });
      await addDmMessage(pageId, {
        conversationRef, fromFan: true, at: T.oct1, text: "webhook", ref, restMaterialObservedAt: T.oct2,
      });
    },
  },
  {
    name: "two copies with equal REST material: the webhook copy wins",
    expected: T.oct1,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, {
        conversationRef, fromFan: true, at: T.sep20, text: "archive", materialObservedAt: T.oct2, vendorChangedAt: T.oct2,
      });
      await addDmMessage(pageId, {
        conversationRef, fromFan: true, at: T.oct1, text: "webhook", ref,
        restMaterialObservedAt: T.oct2, restPlatformChangedAt: T.oct2,
      });
    },
  },
  {
    name: "the winning copy has no text, the other one has",
    expected: null,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "archive has text" });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "", ref });
    },
  },
  {
    name: "the winning copy is undated, the other one is dated",
    expected: null,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, {
        conversationRef, fromFan: true, at: null, text: "archive, undated", materialObservedAt: T.oct2,
      });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "webhook, dated", ref });
    },
  },
  {
    name: "a stub copy never outranks the real one",
    expected: T.oct1,
    seed: async (pageId, conversationRef) => {
      const ref = await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct1, text: "real" });
      await addMessage(pageId, {
        conversationRef, fromFan: false, at: T.oct2, text: "stub", contentPending: true, ref, materialObservedAt: T.oct3,
      });
    },
  },
  {
    name: "the same message id in another chat of the page changes nothing here",
    expected: T.sep10,
    seed: async (pageId, conversationRef) => {
      const ref = await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "mine" });
      // The webhook store keeps one row per message id, and this one is filed under another chat.
      await addDmMessage(pageId, { conversationRef: `${conversationRef}-other`, fromFan: false, at: T.oct3, text: "theirs", ref });
    },
  },
  {
    name: "a webhook row filed under an account id the page no longer has is still read",
    expected: T.oct2,
    seed: async (pageId, conversationRef) => {
      await addMessage(pageId, { conversationRef, fromFan: true, at: T.sep10, text: "archived" });
      await addDmMessage(pageId, { conversationRef, fromFan: true, at: T.oct2, text: "before the rebind", ofapiAccountId: "acct_former" });
    },
  },
];

describe("aiTranscriptUnionLastFanTextAtSql", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool);
  });

  it("answers, chat by chat, what the newest fan text among the union reader's rows is", async () => {
    const page = await seedBoundPage("stats-union-of");
    // Every case is a chat of ONE page, so each answer is also read past all the others' rows.
    const refs = CASES.map((_, index) => String(40_000 + index));
    for (const [index, testCase] of CASES.entries()) {
      await testCase.seed(page.id, refs[index]!);
    }

    for (const [index, testCase] of CASES.entries()) {
      const conversationRef = refs[index]!;
      const reader = await fromUnionReader(page.id, conversationRef);
      expect(reader, `${testCase.name}: the union reader`).toBe(testCase.expected);
      expect(await probe(page.id, conversationRef), `${testCase.name}: the probe`).toBe(reader);
    }
  });

  it("reads another page's rows of the same chat id for neither store", async () => {
    const page = await seedBoundPage("stats-union-of");
    const other = await seedPage("stats-union-other-of");
    await setPageOfapiAccountId(db().db, { pageId: other.id, ofapiAccountId: "acct_other" });
    await addMessage(page.id, { conversationRef: "7001", fromFan: true, at: T.sep10, text: "mine" });
    await addMessage(other.id, { conversationRef: "7001", fromFan: true, at: T.oct1, text: "theirs" });
    await addDmMessage(other.id, { conversationRef: "7001", fromFan: true, at: T.oct3, text: "theirs", ofapiAccountId: "acct_other" });

    expect(await probe(page.id, "7001")).toBe(T.sep10);
    expect(await probe(page.id, "7001")).toBe(await fromUnionReader(page.id, "7001"));
    expect(await probe(other.id, "7001")).toBe(T.oct3);
  });
});

// The archive tail used to name the platform (`ma.platform = 'onlyfans'`) and
// no longer does: the page id pins it, since every writer files a page's
// archive rows under the page's own platform. These hold the two together
// beside a Fansly page whose chats carry the very ids of the OnlyFans page's,
// its rows written in between, each chat with a fan text newer than any of
// the OnlyFans page's: were they read, every chat would answer its time.
describe("the probe without the platform literal", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool);
  });

  const FANSLY_TEXT_AT = "2026-10-03T11:30:00.000Z";

  async function addFanslyChat(pageId: number, conversationRef: string) {
    await addThread(pageId, { fanId: null, conversationRef, lastFanMessageAt: FANSLY_TEXT_AT });
    await addMessage(pageId, { platform: "fansly", conversationRef, fromFan: true, at: FANSLY_TEXT_AT, text: "fansly fan" });
  }

  it("answers chat by chat what it answered with the literal", async () => {
    const page = await seedBoundPage("stats-union-of");
    const fansly = await seedPage("stats-union-fansly", "fansly");
    const refs = CASES.map((_, index) => String(40_000 + index));
    for (const [index, testCase] of CASES.entries()) {
      await addFanslyChat(fansly.id, refs[index]!);
      await testCase.seed(page.id, refs[index]!);
      await addMessage(fansly.id, { platform: "fansly", conversationRef: refs[index]!, fromFan: false, at: T.oct3, text: "fansly ours" });
    }

    const literal = withPlatformLiteral();
    for (const [index, testCase] of CASES.entries()) {
      const conversationRef = refs[index]!;
      const answer = await probe(page.id, conversationRef);
      expect(answer, testCase.name).toBe(testCase.expected);
      expect(answer, `${testCase.name}: with the literal`).toBe(await probe(page.id, conversationRef, literal.db));
      expect(answer, `${testCase.name}: the union reader`).toBe(await fromUnionReader(page.id, conversationRef));
    }
    expect(literal.pinned()).toBe(CASES.length);

    // Only the page id keeps the Fansly rows out: asked of the Fansly page
    // (the stats never are), the tail reads them.
    expect(await probe(fansly.id, refs[0]!)).toBe(FANSLY_TEXT_AT);
  });

  it("gives the stats they gave with the literal", async () => {
    const { page, fans } = await seedMainPage();
    await setPageOfapiAccountId(db().db, { pageId: page.id, ofapiAccountId: SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT });
    await rebuildAll(page.id);
    const fansly = await seedPage("stats-union-fansly", "fansly");
    // B wrote again an hour ago and so far only the webhook store has it; D's
    // only text is in the webhook store, in a chat the archive has no row of.
    await addDmMessage(page.id, { conversationRef: "1002", fromFan: true, at: T.oct3, text: "are you there?" });
    await addThread(page.id, { fanId: fans.d, conversationRef: "1004", headRole: "model" });
    await addDmMessage(page.id, { conversationRef: "1004", fromFan: true, at: "2026-09-03T12:00:00Z", text: "hi" });
    for (const conversationRef of ["1001", "1002", "1003", "1004", "1005", "1006", "b-old"]) {
      await addFanslyChat(fansly.id, conversationRef);
      await addMessage(page.id, { conversationRef, fromFan: false, at: "2026-10-03T11:40:00Z", text: "ours" });
    }

    const input = { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource: "union" as const };
    const literal = withPlatformLiteral();
    const before = await getPageSpenderStats(literal.db, input);
    expect(literal.pinned()).toBe(1);
    const after = await getPageSpenderStats(db().db, input);
    expect(after).toEqual(before);
    expect(after.silence).toEqual({
      // F.
      d8to21: { fans: 1, lifetimeGrossMills: 700_000n },
      // C (August) and D (the webhook store's text of 30 days ago).
      over21: { fans: 2, lifetimeGrossMills: 198_000n },
      unknown: { fans: 0, lifetimeGrossMills: 0n },
    });
  });
});

describe("getPageSpenderStats over the union", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool);
  });

  it("counts silence from the archive unless asked for the union, and then from both stores", async () => {
    const { page, fans } = await seedMainPage();
    await setPageOfapiAccountId(db().db, { pageId: page.id, ofapiAccountId: SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT });
    await rebuildAll(page.id);

    // B's last archived text is 10 days old; an hour ago the fan wrote again,
    // and so far only the webhook store has it.
    await addDmMessage(page.id, { conversationRef: "1002", fromFan: true, at: "2026-10-03T11:00:00Z", text: "are you there?" });
    // D never wrote as far as the archive knows; the webhook store holds a text
    // of 30 days ago in a chat the archive has no row of.
    await addThread(page.id, { fanId: fans.d, conversationRef: "1004", headRole: "model" });
    await addDmMessage(page.id, { conversationRef: "1004", fromFan: true, at: "2026-09-03T12:00:00Z", text: "hi" });
    // C's only text was deleted on the platform; the archive has not heard.
    const bye = await db().pool.query<{ message_ref: string }>(
      "select message_ref from message_archive where account_id = $1 and conversation_ref = '1003'",
      [page.id],
    );
    expect(bye.rows).toHaveLength(1);
    await addDmMessage(page.id, { conversationRef: null, fromFan: true, at: null, text: "", deleted: true, ref: bye.rows[0]!.message_ref });

    const archive = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });
    expect(archive.messageSource).toBe("archive");
    expect(archive.silence).toEqual({
      d8to21: { fans: 2, lifetimeGrossMills: 712_000n },
      over21: { fans: 1, lifetimeGrossMills: 197_000n },
      unknown: { fans: 1, lifetimeGrossMills: 1_000n },
    });

    const union = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource: "union" });
    expect(union.messageSource).toBe("union");
    expect(union.silence).toEqual({
      // F alone: B is no longer silent.
      d8to21: { fans: 1, lifetimeGrossMills: 700_000n },
      // D, by the webhook store's text.
      over21: { fans: 1, lifetimeGrossMills: 1_000n },
      // C: its one text is dead, so nothing is known.
      unknown: { fans: 1, lifetimeGrossMills: 197_000n },
    });
    // Only silence follows the switch: the money, the tiers and the queue are the same answer.
    expect({ ...union, messageSource: "archive", silence: archive.silence }).toEqual(archive);
  });

  it("knows the page has messages when only the webhook store holds them", async () => {
    const page = await seedBoundPage("stats-union-fresh-of");
    const payer = await seedFan(page.id, "3001");
    await addTransaction(page.id, { fanId: payer, type: "tip", gross: 20_000n, at: "2026-05-01T10:00:00Z" });
    await addThread(page.id, { fanId: payer, conversationRef: "3001", headRole: "model" });
    await rebuildAll(page.id);

    // No message anywhere: nothing can be said of anyone's silence, in either source.
    for (const messageSource of ["archive", "union"] as const) {
      const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource });
      expect(stats.coverage, messageSource).toEqual({ state: "partial", reasons: ["messages_missing"] });
      expect(stats.silence.unknown, messageSource).toEqual({ fans: 1, lifetimeGrossMills: 20_000n });
    }

    // A deletion stub is not a message.
    await addDmMessage(page.id, { conversationRef: null, fromFan: true, at: null, text: "", deleted: true });
    expect((await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource: "union" })).coverage)
      .toEqual({ state: "partial", reasons: ["messages_missing"] });

    await addDmMessage(page.id, { conversationRef: "3001", fromFan: true, at: "2026-09-20T12:00:00Z", text: "hello" });
    const archive = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF });
    expect(archive.coverage).toEqual({ state: "partial", reasons: ["messages_missing"] });
    expect(archive.silence.unknown.fans).toBe(1);
    const union = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource: "union" });
    expect(union.coverage).toEqual({ state: "complete", reasons: [] });
    expect(union.silence).toEqual({
      d8to21: { fans: 1, lifetimeGrossMills: 20_000n },
      over21: { fans: 0, lifetimeGrossMills: 0n },
      unknown: { fans: 0, lifetimeGrossMills: 0n },
    });
  });
});

describe("spender stats perf gate, union", () => {
  beforeEach(async () => {
    await resetIntegrationDatabase(db().pool, { physical: true });
  });

  // The worst chat for the probe: its newest rows in both stores are ours (mass
  // and media messages), so each tail walks back to the fan's last text. The
  // bound is the chat's own rows in each store; a row of another chat or page
  // is never read, and a message id is looked up through a unique index.
  it("probes each store per chat through its conversation index and looks message ids up through the unique ones", async () => {
    const page = await seedBoundPage("stats-union-perf-of");
    const other = await seedPage("stats-union-perf-other-of");
    await setPageOfapiAccountId(db().db, { pageId: other.id, ofapiAccountId: "acct_other" });
    const chats = 20;
    const ourRowsPerChat = 600;
    const hotRowsPerChat = 300;
    for (let index = 0; index < chats; index += 1) {
      const ref = String(8000 + index);
      const fanId = await seedFan(page.id, ref);
      await addThread(page.id, { fanId, conversationRef: ref, lastModelMessageAt: "2026-10-02T10:00:00Z" });
      await addThread(other.id, { fanId: null, conversationRef: ref, lastModelMessageAt: "2026-10-02T10:00:00Z" });
    }
    await db().pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills)
       select $1, fp.fan_id, 50000, 40000 from page_fans fp where fp.platform_account_id = $1`,
      [page.id],
    );
    for (const [pageId, account] of [[page.id, SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT], [other.id, "acct_other"]] as const) {
      // Each chat: our rows down to August in both stores, then one fan text in
      // the archive (even chats) or in the webhook store (odd chats).
      await db().pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, is_sent_by_me, occurred_at, text_plain)
         select $1, 'onlyfans', (8000 + c)::text, ($1::bigint * 10000000 + c * 10000 + g)::text, true,
                timestamptz '2026-10-02' - (g || ' minutes')::interval, 'mass ' || g
         from generate_series(0, $2::int - 1) c, generate_series(1, $3::int) g`,
        [pageId, chats, ourRowsPerChat],
      );
      await db().pool.query(
        `insert into dm_message_archive (
           platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id,
           platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, source,
           source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until
         )
         select 'onlyfans', $1, $4, (8000 + c)::text, (8000 + c)::text,
                ($1::bigint * 10000000 + 5000000 + c * 10000 + g)::text, 'model', true,
                timestamptz '2026-10-02' - (g || ' minutes')::interval, 'sent ' || g, 'webhook',
                'messages.sent', 'perf-' || $1::text || '-' || c || '-' || g, 1, now(), now() + interval '100 years'
         from generate_series(0, $2::int - 1) c, generate_series(1, $3::int) g`,
        [pageId, chats, ourRowsPerChat, account],
      );
      await db().pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, is_sent_by_me, occurred_at, text_plain)
         select $1, 'onlyfans', (8000 + c)::text, ($1::bigint * 10000000 + 9000000 + c)::text, false,
                timestamptz '2026-08-01', 'hello'
         from generate_series(0, $2::int - 1, 2) c`,
        [pageId, chats],
      );
      await db().pool.query(
        `insert into dm_message_archive (
           platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id,
           platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, source,
           source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until
         )
         select 'onlyfans', $1, $3, (8000 + c)::text, (8000 + c)::text,
                ($1::bigint * 10000000 + 9500000 + c)::text, 'fan', false,
                timestamptz '2026-09-15', 'hello', 'webhook',
                'messages.received', 'perf-fan-' || $1::text || '-' || c, 1, now(), now() + interval '100 years'
         from generate_series(1, $2::int - 1, 2) c`,
        [pageId, chats, account],
      );
    }
    // The hot table: a window of every chat on both pages, a few of its rows deleted.
    await db().pool.query(
      `insert into page_dm_messages (
         conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content, deleted_at
       )
       select th.id, th.platform_account_id, (th.platform_account_id * 10000000 + 7000000 + th.id * 1000 + g)::text,
              'model', timestamptz '2026-10-02' - (g || ' minutes')::interval, 'hot ' || g,
              case when g % 50 = 0 then now() end
       from page_dm_threads th, generate_series(1, $1::int) g`,
      [hotRowsPerChat],
    );
    await db().pool.query(
      "analyze message_archive, dm_message_archive, page_dm_threads, page_dm_messages, fan_spend_lifetime, page_fans, fans, pages",
    );

    const plan = await explainPageSpenderSilenceQuery(
      db().db,
      { pageId: page.id, asOf: AS_OF, messageSource: "union" },
      { analyze: true },
    );
    expect(plan).toMatch(/Index Scan Backward using message_archive_account_conv_idx on message_archive ma/);
    expect(plan).toMatch(/Index Scan using dm_message_archive_page_conversation_idx on dm_message_archive d/);
    expect(plan).not.toMatch(/Seq Scan on message_archive/);
    expect(plan).not.toMatch(/Seq Scan on dm_message_archive/);
    // The lookups by message id (a deletion elsewhere, the other store's copy)
    // read one row through a unique index each. The webhook store's chat index
    // serves its tail and nothing else: a copy is never searched for by
    // scanning the chat.
    expect(plan).toMatch(/Index Scan using dm_message_archive_platform_account_message_uniq on dm_message_archive x/);
    expect(plan).toMatch(/Index Scan using dm_message_archive_platform_account_message_uniq on dm_message_archive w/);
    expect(plan).toMatch(/Index Scan using message_archive_account_id_platform_message_ref_key on message_archive a/);
    expect(plan.match(/dm_message_archive_page_conversation_idx/g)).toHaveLength(1);
    expect(plan.match(/message_archive_account_conv_idx/g)).toHaveLength(1);
    expect(plan).not.toMatch(/Seq Scan on page_dm_messages/);
    expect(plan).not.toMatch(/message_archive_ofapi_native_order_idx/);

    // Rows each tail read.
    const archiveTail = rowsRead(plan, "Index Scan Backward using message_archive_account_conv_idx on message_archive ma");
    const dmTail = rowsRead(plan, "Index Scan using dm_message_archive_page_conversation_idx on dm_message_archive d");
    expect(archiveTail.loops).toBe(chats);
    expect(dmTail.loops).toBe(chats);
    // At most the chat's own rows of the store, on this page.
    expect(archiveTail.read).toBeLessThanOrEqual(chats * ourRowsPerChat + chats / 2);
    expect(dmTail.read).toBeLessThanOrEqual(chats * ourRowsPerChat + chats / 2);

    const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource: "union" });
    // Even chats: the archive's August text. Odd chats: the webhook store's of 18 days ago.
    expect(stats.silence.over21.fans).toBe(chats / 2);
    expect(stats.silence.d8to21.fans).toBe(chats / 2);
    expect(stats.silence.unknown.fans).toBe(0);
  }, 120_000);

  // Production's shape (2026-10-08): Fansly pages hold 88% of message_archive,
  // and the fans of an OnlyFans page write often, so a chat's last fan text is
  // near its newest row. Told `platform = 'onlyfans'`, the planner did not
  // know the page implies it and expected a backward walk to skip most rows
  // as another platform's; it took the partial
  // message_archive_ofapi_native_order_idx instead, ordered by message id,
  // and read, sorted and looked up every fan text of every chat: 5.6 s on the
  // largest page. The walk stops at the chat's newest fan text.
  it("walks the archive back to the chat's newest fan text, among another platform's rows", async () => {
    const page = await seedBoundPage("stats-union-shape-of");
    const fansly = await seedPage("stats-union-shape-fansly", "fansly");
    const chats = 30;
    const rowsPerChat = 100;
    const fanslyChats = 7 * chats;
    for (let index = 0; index < chats; index += 1) {
      const ref = String(8000 + index);
      const fanId = await seedFan(page.id, ref);
      await addThread(page.id, { fanId, conversationRef: ref, lastFanMessageAt: "2026-10-02T09:58:00Z" });
    }
    for (let index = 0; index < fanslyChats; index += 1) {
      await addThread(fansly.id, { fanId: null, conversationRef: String(8000 + index), lastFanMessageAt: "2026-10-02T09:58:00Z" });
    }
    await db().pool.query(
      `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills)
       select $1, fp.fan_id, 50000, 40000 from page_fans fp where fp.platform_account_id = $1`,
      [page.id],
    );
    // Each chat, newest first: our message, the fan's text, ours, the fan's…
    // The Fansly page's chats carry the same ids, and there are seven times as many.
    for (const [pageId, platform, chatCount] of [[page.id, "onlyfans", chats], [fansly.id, "fansly", fanslyChats]] as const) {
      await db().pool.query(
        `insert into message_archive (
           account_id, platform, conversation_ref, message_ref, native_message_id, sender_role, is_sent_by_me,
           occurred_at, text_plain
         )
         select $1, $2, (8000 + c)::text, ($1::bigint * 10000000 + c * 10000 + g)::text,
                $1::bigint * 10000000 + c * 10000 + g, case when g % 2 = 1 then 'model' else 'fan' end, g % 2 = 1,
                timestamptz '2026-10-02 10:00' - (g || ' minutes')::interval, 'text ' || g
         from generate_series(0, $3::int - 1) c, generate_series(1, $4::int) g`,
        [pageId, platform, chatCount, rowsPerChat],
      );
    }
    // The webhook store holds newer rows of each chat (rows of its own: a copy
    // the webhook store holds of an archived message would win the tie and
    // keep the archive's from serving); the hot table holds copies.
    await db().pool.query(
      `insert into dm_message_archive (
         platform, platform_account_id, ofapi_account_id, platform_conversation_id, fan_platform_user_id,
         platform_message_id, sender_role, is_sent_by_me, message_created_at, text_plain, source,
         source_event_type, source_idempotency_key, source_journal_id, source_received_at, retain_until
       )
       select 'onlyfans', $1, $4, (8000 + c)::text, (8000 + c)::text,
              ($1::bigint * 10000000 + 5000000 + c * 10000 + g)::text,
              (case when g % 2 = 1 then 'model' else 'fan' end)::dm_sender_role, g % 2 = 1,
              timestamptz '2026-10-02 10:00' + (g || ' seconds')::interval, 'text ' || g, 'webhook',
              case when g % 2 = 1 then 'messages.sent' else 'messages.received' end,
              'shape-' || c || '-' || g, 1, now(), now() + interval '100 years'
       from generate_series(0, $2::int - 1) c, generate_series(1, $3::int) g`,
      [page.id, chats, rowsPerChat / 4, SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT],
    );
    await db().pool.query(
      `insert into page_dm_messages (
         conversation_id, platform_account_id, platform_message_id, sender_role, created_at, content
       )
       select th.id, th.platform_account_id, (th.platform_account_id * 10000000 + (th.platform_conversation_id::int - 8000) * 10000 + g)::text,
              (case when g % 2 = 1 then 'model' else 'fan' end)::dm_sender_role,
              timestamptz '2026-10-02 10:00' - (g || ' minutes')::interval, 'text ' || g
       from page_dm_threads th, generate_series(1, $1::int) g
       where th.platform_account_id = $2`,
      [rowsPerChat / 2, page.id],
    );
    await db().pool.query(
      "analyze message_archive, dm_message_archive, page_dm_threads, page_dm_messages, fan_spend_lifetime, page_fans, fans, pages",
    );

    const plan = await explainPageSpenderSilenceQuery(
      db().db,
      { pageId: page.id, asOf: AS_OF, messageSource: "union" },
      { analyze: true },
    );
    expect(plan).not.toMatch(/message_archive_ofapi_native_order_idx/);
    expect(plan).not.toMatch(/Sort Key: ma\.occurred_at/);
    // The tail's Limit stops the walk itself: no Sort between them.
    expect(plan).toMatch(
      /Limit[^\n]*\n(?:\s+Buffers:[^\n]*\n)?\s+->\s+Index Scan Backward using message_archive_account_conv_idx on message_archive ma/,
    );
    // Our newest message, then the fan's text: two rows a chat.
    const archiveTail = rowsRead(plan, "Index Scan Backward using message_archive_account_conv_idx on message_archive ma");
    expect(archiveTail.loops).toBe(chats);
    expect(archiveTail.read).toBeLessThanOrEqual(2 * chats);

    // Every fan wrote yesterday: nobody is silent.
    const stats = await getPageSpenderStats(db().db, { pageId: page.id, timeZone: "UTC", asOf: AS_OF, messageSource: "union" });
    expect(stats.silence).toEqual({
      d8to21: { fans: 0, lifetimeGrossMills: 0n },
      over21: { fans: 0, lifetimeGrossMills: 0n },
      unknown: { fans: 0, lifetimeGrossMills: 0n },
    });
  }, 120_000);
});

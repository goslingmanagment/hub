import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmDmLiveMessages,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  dmReaderStoreOf,
  ensureSyncPage,
  insertAgentKey,
  readDmReaderStore,
  setConfigOverride,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { runMigrations } from "../packages/db/src/migrate-runner.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { checkWindow } from "../apps/runtime/src/sync/fansly/lib/chain-checks.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { quietLogger, setModeDirect } from "./helpers/sync-engine-host.ts";

// Step 4, S4-08 (owner decision №11): the DM readers serve a page the Fansly
// Sync Engine runs live from message_archive — the chat routes, the agent
// transcript (no page_dm_messages arm, PPV from the archive), the engine's own
// checks and the overlay's passive confirmation — while an OnlyFans page and a
// Fansly page off the engine keep page_dm_messages. And migration 0236
// recomputes the live pages' thread summaries from the archive, once.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = `${AGENT_KEY_TOKEN_PREFIX}readers-archive-token`;
const OWN = "300000000000000091";
const FAN = "510000000000000091";
const GROUP = "820000000000000091";
const OF_FAN = "of-fan-91";
const BASE = Date.parse("2026-09-20T10:00:00Z");
const at = (seconds: number) => new Date(BASE + seconds * 1000);
const WINDOW = "from=2026-09-20T00:00:00Z&to=2026-09-21T00:00:00Z";
/** M1 is in both stores (a tip), M2 only in the hot table (in flight), M3 in
 *  both (a PPV the hot table saw bought, the archive not opened), M4 only in
 *  the archive (a September sidecar row). */
const M = { m1: "900000000000000911", m2: "900000000000000912", m3: "900000000000000913", m4: "900000000000000914" };

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

interface Fixture {
  fansly: { id: number; threadId: number };
  onlyFans: { id: number };
  get: (path: string) => Promise<Record<string, unknown> & { messages: Array<Record<string, unknown>> }>;
  agent: (path: string) => Promise<{ items: Array<Record<string, unknown>>; capture: { planes: Array<Record<string, unknown>> } }>;
}

async function hot(threadId: number, pageId: number, id: string, seconds: number, input: {
  sender: string; role: "fan" | "model"; content: string; tipCents?: number; purchased?: boolean;
}) {
  await testDb!.pool.query(
    `insert into page_dm_messages (conversation_id, platform_account_id, platform_message_id, sender_platform_user_id,
       sender_role, created_at, content, total_tip_amount_cents, purchased_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [threadId, pageId, id, input.sender, input.role, at(seconds), input.content, input.tipCents ?? 0,
      input.purchased ? at(seconds + 30) : null],
  );
}

async function archive(pageId: number, id: string, seconds: number, input: {
  mine: boolean; text: string; tipMills?: number; priceMills?: number; opened?: boolean | null;
}) {
  await testDb!.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
       is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills, price_mills, is_opened)
     values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [pageId, GROUP, id, FAN, input.mine ? "model" : "fan", input.mine, at(seconds), input.text,
      (input.tipMills ?? 0) > 0, input.tipMills ?? 0, input.priceMills ?? null, input.opened ?? null],
  );
}

async function fixture(): Promise<Fixture> {
  const app = createTestAppContext(testDb!, { authPolicyEnforcement: "enforce" });
  const model = await createModel(db(), { slug: "lilly", name: "Lilly" });
  const fanslyPage = await createFanslyPage(db(), { modelId: model!.id, label: "lilly-1" });
  const onlyFansPage = await createOnlyFansPage(db(), { modelId: model!.id, label: "lora-of" });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [fanslyPage!.id, OWN]);
  await ensureSyncPage(db(), { pageId: fanslyPage!.id });
  await setModeDirect(testDb!.pool, fanslyPage!.id, "live");
  const [fan] = await upsertFans(db(), [{ platform: "fansly", platformUserId: FAN }]);
  const [ofFan] = await upsertFans(db(), [{ platform: "onlyfans", platformUserId: OF_FAN }]);

  // The summary as the engine keeps it on a live page: the archive's window.
  const thread = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
       stored_message_count, newest_stored_message_id, oldest_stored_message_id, last_fan_message_at,
       last_model_message_at, message_coverage_status, last_message_at)
     values ($1, $2, $3, $4, 3, $5, $6, $7, $8, 'partial_window', $8) returning id::text as id`,
    [fanslyPage!.id, fan!.id, GROUP, FAN, M.m4, M.m1, at(120), at(180)],
  );
  const threadId = Number(thread.rows[0]!.id);
  await hot(threadId, fanslyPage!.id, M.m1, 0, { sender: FAN, role: "fan", content: "first", tipCents: 500 });
  await hot(threadId, fanslyPage!.id, M.m2, 60, { sender: OWN, role: "model", content: "hot only" });
  await hot(threadId, fanslyPage!.id, M.m3, 120, { sender: FAN, role: "fan", content: "bought", purchased: true });
  await archive(fanslyPage!.id, M.m1, 0, { mine: false, text: "first", tipMills: 5_000 });
  await archive(fanslyPage!.id, M.m3, 120, { mine: false, text: "bought", priceMills: 10_000, opened: false });
  await archive(fanslyPage!.id, M.m4, 180, { mine: true, text: "archive only" });

  const ofThread = await testDb!.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, partner_platform_user_id,
       stored_message_count, message_coverage_status)
     values ($1, $2, $3, $3, 2, 'complete') returning id::text as id`,
    [onlyFansPage!.id, ofFan!.id, OF_FAN],
  );
  const ofThreadId = Number(ofThread.rows[0]!.id);
  await hot(ofThreadId, onlyFansPage!.id, "of-1", 0, { sender: OF_FAN, role: "fan", content: "of hello" });
  await hot(ofThreadId, onlyFansPage!.id, "of-2", 60, { sender: "of-page", role: "model", content: "of reply" });

  const owner = await createUserAccount(app, { username: "dima", role: "owner", password: "owner-secret" }, { source: "cli" });
  await insertAgentKey(db(), {
    name: "readers",
    keyPrefix: TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(TOKEN),
    capabilities: ["read:messages"],
    pageIds: [fanslyPage!.id, onlyFansPage!.id],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: owner.id,
  });
  await setConfigOverride(db(), { key: "agentReadPlaneMode", value: "full", userId: owner.id, groupId: randomUUID() });

  server = await buildApiServer(app);
  await server.ready();
  const login = await server.inject({ method: "POST", url: "/api/v1/auth/login",
    payload: { username: "dima", password: "owner-secret" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return {
    fansly: { id: fanslyPage!.id, threadId },
    onlyFans: { id: onlyFansPage!.id },
    get: async (path) => {
      const response = await server!.inject({ method: "GET", url: `/api/v1/pages/${path}`, headers: { cookie } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    },
    agent: async (path) => {
      const response = await server!.inject({ method: "GET", url: `/api/v1/agent/pages/${path}`,
        headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    },
  };
}

const ids = (rows: Array<Record<string, unknown>>, key: string) => rows.map((row) => row[key]);

describe("the store a page's DM readers read (S4-08)", () => {
  it("is the archive on a live page and page_dm_messages on every other page", async () => {
    const f = await fixture();
    expect(dmReaderStoreOf("live")).toBe("message_archive");
    for (const mode of ["off", "shadow", "handover", null, undefined] as const) {
      expect(dmReaderStoreOf(mode)).toBe("page_dm_messages");
    }
    expect(await readDmReaderStore(db(), f.fansly.id)).toBe("message_archive");
    expect(await readDmReaderStore(db(), f.onlyFans.id)).toBe("page_dm_messages");
    await setModeDirect(testDb!.pool, f.fansly.id, "shadow");
    expect(await readDmReaderStore(db(), f.fansly.id)).toBe("page_dm_messages");
  });

  it("chat routes: a live page reads the archive; off the engine and on OnlyFans, page_dm_messages", async () => {
    const f = await fixture();
    const messages = await f.get(`lilly-1/conversations/${GROUP}/messages`);
    expect(messages.messages).toEqual([
      { messageId: M.m4, senderRole: "model", content: "archive only", createdAt: at(180).toISOString(), tipAmountCents: 0 },
      { messageId: M.m3, senderRole: "fan", content: "bought", createdAt: at(120).toISOString(), tipAmountCents: 0 },
      // Mills through the codec: 5 000 mills are 500 cents.
      { messageId: M.m1, senderRole: "fan", content: "first", createdAt: at(0).toISOString(), tipAmountCents: 500 },
    ]);
    // The conversation fields stay the thread's (the summary counts the archive).
    expect(messages.conversation).toMatchObject({ storedMessageCount: 3 });
    const preview = await f.get(`lilly-1/conversations/${GROUP}/preview?limit=25`);
    expect(preview.messages.map((row) => [row.platformMessageId, row.senderPlatformUserId, row.totalTipAmountCents]))
      .toEqual([[M.m1, FAN, 500], [M.m3, FAN, 0], [M.m4, OWN, 0]]);

    await setModeDirect(testDb!.pool, f.fansly.id, "shadow");
    expect(ids((await f.get(`lilly-1/conversations/${GROUP}/messages`)).messages, "messageId")).toEqual([M.m3, M.m2, M.m1]);
    expect(ids((await f.get(`lilly-1/conversations/${GROUP}/preview?limit=25`)).messages, "platformMessageId"))
      .toEqual([M.m1, M.m2, M.m3]);

    expect(ids((await f.get(`lora-of/conversations/${OF_FAN}/messages`)).messages, "messageId")).toEqual(["of-2", "of-1"]);
  });

  it("agent transcript: a live page has no hot arm — PPV from message_archive.is_opened, page_dm_messages not read", async () => {
    const f = await fixture();
    const live = await f.agent(`lilly-1/threads/${GROUP}/messages?${WINDOW}`);
    expect(ids(live.items, "messageRef")).toEqual([M.m1, M.m3, M.m4]);
    expect(live.items.find((item) => item.messageRef === M.m3)).toMatchObject({ isOpened: false, priceMills: 10_000 });
    expect(live.capture.planes).toEqual(expect.arrayContaining([
      expect.objectContaining({ plane: "message_archive", state: "read" }),
      expect.objectContaining({ plane: "page_dm_messages", state: "not_read" }),
    ]));

    await setModeDirect(testDb!.pool, f.fansly.id, "shadow");
    const legacy = await f.agent(`lilly-1/threads/${GROUP}/messages?${WINDOW}`);
    expect(ids(legacy.items, "messageRef")).toEqual([M.m1, M.m2, M.m3, M.m4]);
    // The hot arm's purchase upgrade.
    expect(legacy.items.find((item) => item.messageRef === M.m3)).toMatchObject({ isOpened: true });
    expect(legacy.capture.planes).toEqual(expect.arrayContaining([
      expect.objectContaining({ plane: "page_dm_messages", state: "read" }),
    ]));
  });

  it("the overlay's passive pass judges a live page's rows by the archive, other pages' by page_dm_messages", async () => {
    const f = await fixture();
    const overlay = async (id: string) => testDb!.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
         is_sent_by_page, created_at, content, field_mask, decoder_version, first_visible_at, confirm_due_at)
       values ($1, $2, $3, $4, false, $5, 'first', 1, 1, now(), now() - interval '1 second')`,
      [f.fansly.id, id, GROUP, FAN, at(0)],
    );
    const verdict = async (id: string) => (await testDb!.pool.query<{ confirm_outcome: string; confirm_source: string }>(
      "select confirm_outcome, confirm_source from dm_live_messages where page_id = $1 and platform_message_id = $2",
      [f.fansly.id, id],
    )).rows[0];
    await overlay(M.m1);
    expect(await confirmDmLiveMessages(db(), { limit: 10 })).toMatchObject({ checked: 1, match: 1 });
    expect(await verdict(M.m1)).toEqual({ confirm_outcome: "match", confirm_source: "message_archive" });

    await testDb!.pool.query("delete from dm_live_messages");
    await setModeDirect(testDb!.pool, f.fansly.id, "shadow");
    await overlay(M.m1);
    expect(await confirmDmLiveMessages(db(), { limit: 10 })).toMatchObject({ checked: 1, match: 1 });
    expect(await verdict(M.m1)).toEqual({ confirm_outcome: "match", confirm_source: "page_dm_messages" });
  });

  it("sync chain check-window compares a live page's summary with the archive, another page's with page_dm_messages", async () => {
    const f = await fixture();
    const app = { db: db(), logger: quietLogger as never };
    expect(await checkWindow(app, { pageId: f.fansly.id, maxThreads: 10, maxListed: 5 }))
      .toMatchObject({ mode: "live", threadsChecked: 1, drifted: 0 });
    await setModeDirect(testDb!.pool, f.fansly.id, "shadow");
    const shadow = await checkWindow(app, { pageId: f.fansly.id, maxThreads: 10, maxListed: 5 });
    expect(shadow).toMatchObject({ mode: "shadow", drifted: 1 });
    expect(shadow.examples[0]!.fields.newestStoredMessageId).toEqual({ stored: M.m4, recomputed: M.m3 });
  });
});

describe("0236_fansly_thread_summary_from_archive.sql", () => {
  it("recounts the live pages' thread windows from the archive where they differ, nothing else", async () => {
    const partialDb = await startIntegrationTestDatabase({ through: "0235_sync_pages_lifted_dm_exclusions.sql" });
    if (!partialDb) throw new Error("Docker Postgres required");
    try {
      const database = partialDb.db as unknown as Database;
      const pool = partialDb.pool;
      const model = await createModel(database, { slug: `m-${randomUUID()}`, name: "summary" });
      const live = await createFanslyPage(database, { modelId: model!.id, label: `live-${randomUUID().slice(0, 8)}` });
      const shadow = await createFanslyPage(database, { modelId: model!.id, label: `shadow-${randomUUID().slice(0, 8)}` });
      const onlyFans = await createOnlyFansPage(database, { modelId: model!.id, label: `of-${randomUUID().slice(0, 8)}` });
      for (const [page, mode] of [[live!, "live"], [shadow!, "shadow"]] as const) {
        await ensureSyncPage(database, { pageId: page.id });
        await pool.query("update sync_pages set mode = $2 where page_id = $1", [page.id, mode]);
      }
      const thread = async (pageId: number, group: string, count: number, newest: string | null, oldest: string | null) =>
        Number((await pool.query<{ id: string }>(
          `insert into page_dm_threads (platform_account_id, platform_conversation_id, stored_message_count,
             newest_stored_message_id, oldest_stored_message_id, last_fan_message_at, message_coverage_status, updated_at)
           values ($1, $2, $3, $4, $5, '2026-09-01T00:00:00Z', 'partial_window', '2026-01-01T00:00:00Z')
           returning id::text as id`,
          [pageId, group, count, newest, oldest],
        )).rows[0]!.id);
      const stored = async (pageId: number, platform: string, group: string, ref: string, minute: number, extra: {
        deleted?: boolean; pending?: boolean;
      } = {}) => pool.query(
        `insert into message_archive (account_id, platform, conversation_ref, message_ref, occurred_at, text_plain,
           deleted_at, content_pending)
         values ($1, $2, $3, $4, $5, 'x', $6, $7)`,
        [pageId, platform, group, ref, new Date(BASE + minute * 60_000), extra.deleted ? new Date(BASE) : null,
          extra.pending === true],
      );
      // A live thread whose hot-table window missed the archive-only sidecar rows.
      const drifted = await thread(live!.id, "g1", 2, "103", "102");
      for (const [ref, minute] of [["101", 1], ["102", 2], ["103", 3]] as const) await stored(live!.id, "fansly", "g1", ref, minute);
      await stored(live!.id, "fansly", "g1", "104", 4, { deleted: true });
      await stored(live!.id, "fansly", "g1", "105", 5, { deleted: true, pending: true });
      // A live thread already equal to its archive, and one the archive holds nothing of.
      const equal = await thread(live!.id, "g2", 1, "201", "201");
      await stored(live!.id, "fansly", "g2", "201", 1);
      const emptied = await thread(live!.id, "g3", 4, "304", "301");
      // Not live: a shadow Fansly page and an OnlyFans page keep their windows.
      const notLive = await thread(shadow!.id, "g4", 1, "401", "401");
      for (const [ref, minute] of [["401", 1], ["402", 2]] as const) await stored(shadow!.id, "fansly", "g4", ref, minute);
      const ofThread = await thread(onlyFans!.id, "g5", 1, "501", "501");
      for (const [ref, minute] of [["501", 1], ["502", 2]] as const) await stored(onlyFans!.id, "onlyfans", "g5", ref, minute);

      const client = await pool.connect();
      try {
        await runMigrations({ db: client, through: "0236_fansly_thread_summary_from_archive.sql" });
      } finally {
        client.release();
      }
      const rows = new Map((await pool.query<{
        id: string; stored_message_count: number; newest_stored_message_id: string | null;
        oldest_stored_message_id: string | null; last_fan_message_at: Date; message_coverage_status: string; updated_at: Date;
      }>(
        `select id::text as id, stored_message_count, newest_stored_message_id, oldest_stored_message_id,
                last_fan_message_at, message_coverage_status::text, updated_at
           from page_dm_threads`,
      )).rows.map((row) => [Number(row.id), row]));
      const window = (id: number) => {
        const row = rows.get(id)!;
        return [row.stored_message_count, row.newest_stored_message_id, row.oldest_stored_message_id];
      };
      expect(window(drifted)).toEqual([3, "103", "101"]);
      expect(window(emptied)).toEqual([0, null, null]);
      expect(window(equal)).toEqual([1, "201", "201"]);
      expect(window(notLive)).toEqual([1, "401", "401"]);
      expect(window(ofThread)).toEqual([1, "501", "501"]);
      // Only the two changed rows are touched; nothing else of them moves.
      const untouched = new Date("2026-01-01T00:00:00Z").getTime();
      expect([...rows.entries()].filter(([, row]) => row.updated_at.getTime() !== untouched).map(([id]) => id).sort())
        .toEqual([drifted, emptied].sort());
      for (const row of rows.values()) {
        expect(row.last_fan_message_at.toISOString()).toBe("2026-09-01T00:00:00.000Z");
        expect(row.message_coverage_status).toBe("partial_window");
      }
    } finally {
      await partialDb.stop();
    }
  }, 180_000);
});

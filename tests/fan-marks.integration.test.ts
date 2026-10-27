import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientFanMarksResponseSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePollRows,
  ensureSyncPage,
  getSyncPage,
  saveFanslyBlocklistReaderState,
  upsertDemand,
  upsertFanslyBlocklistMessages,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import { parseBlocklistHandles } from "../apps/runtime/src/services/fansly-blocklist/handles.ts";
import { readBlocklistHistory, type BlocklistHistory, type BlocklistMessage } from "../apps/runtime/src/services/fansly-blocklist/reader.ts";
import { createEngineRegistry, pollsFor } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { makeTestActor, okResponse, ScriptedLiveTransport, seedSyncPage, waitFor } from "./helpers/sync-engine-host.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fan marks: the Fansly page's user lists walked for the «💩 Бомж» mark (a
// full walk retires the members it did not see, a list no longer so labelled
// included), the FANSLY BLOCKLIST reader's run over the group's history
// (backfill, edits and deletions in the re-read head), and the marks read the
// chat header asks for.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

const db = () => testDb!.db as unknown as Database;
const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  testDb!.pool.query<R>(text, values);

describe("fan-lists.poll", () => {
  const BOMZH = "727366232164016128";
  const QUIET = "727376030649556992";
  const lists = (bomzhLabel: string) => [
    { id: BOMZH, accountId: "723606174951284736", pos: null, type: 1, label: bomzhLabel, itemCount: 3 },
    { id: QUIET, accountId: "723606174951284736", pos: null, type: 1, label: "Молчун", itemCount: 2 },
  ];
  const item = (id: string, sortId: string) => ({ id, sortId, listId: BOMZH, type: 1, metadata: "" });

  async function walk(pageId: number, answer: { lists: unknown[]; items: Record<string, unknown[]> }, generation: number) {
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const page = await getSyncPage(db(), pageId);
    // Every standing poll parked far ahead: only the walk runs.
    await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
    const spec = fanslyResourceSpec("fan-lists.poll")!;
    await upsertDemand(db(), { pageId, resource: "fan-lists.poll", kind: spec.kind, class: spec.class });
    const transport = new ScriptedLiveTransport();
    const asked: string[] = [];
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      const url = new URL(req.url);
      if (req.spec === "lists.account") return okResponse(answer.lists);
      if (req.spec === "lists.items") {
        asked.push(`${url.searchParams.get("listId")}@${url.searchParams.get("after") ?? "head"}`);
        return okResponse(answer.items[url.searchParams.get("after") ?? "head"] ?? []);
      }
      return okResponse([]);
    };
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const row = await q<{ generation: string }>("select generation::text from page_fan_list_walks where page_id = $1", [pageId]);
        return Number(row.rows[0]?.generation ?? 0) >= generation ? true : null;
      }, 30_000, `walk ${generation}`);
    } finally {
      stop.abort();
      await run;
    }
    return { asked, hits: transport.hits.map((hit) => hit.spec).filter((spec) => spec.startsWith("lists.")) };
  }

  const members = async (pageId: number) => (await q<{ fan: string; active: boolean; generation: string; first: Date }>(
    `select f.platform_user_id as fan, m.is_active as active, m.last_seen_generation::text as generation, m.first_seen_at as first
       from page_fan_list_members m join fans f on f.id = m.fan_id where m.page_id = $1 order by f.platform_user_id`, [pageId])).rows;

  it("walks only the «бомж» lists to an empty page, then retires whom a walk did not see", async (context) => {
    if (!testDb) return context.skip();
    await resetIntegrationDatabase(testDb.pool);
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });

    // Walk 1: three members over two pages, after the last member's sortId.
    const first = await walk(pageId, {
      lists: lists(" 💩 Бомж "),
      items: { head: [item("499983739493822464", "771875290119938254"), item("505123577196978176", "771875320377651504")], "771875320377651504": [item("511111111111111111", "771875400000000000")] },
    }, 1);
    expect(first.hits).toEqual(["lists.account", "lists.items", "lists.items", "lists.items"]);
    expect(first.asked).toEqual([`${BOMZH}@head`, `${BOMZH}@771875320377651504`, `${BOMZH}@771875400000000000`]);
    const walked = await members(pageId);
    expect(walked.map((row) => [row.fan, row.active, row.generation])).toEqual([
      ["499983739493822464", true, "1"], ["505123577196978176", true, "1"], ["511111111111111111", true, "1"],
    ]);
    expect((await q("select list_ref, label, item_count, is_active from page_fan_lists where page_id = $1 order by list_ref", [pageId])).rows).toEqual([
      { list_ref: BOMZH, label: " 💩 Бомж ", item_count: 3, is_active: true },
      { list_ref: QUIET, label: "Молчун", item_count: 2, is_active: true },
    ]);
    // The members are fans of the page, their profiles asked of the lookup walk.
    expect((await q("select count(*)::int as n from page_fans where platform_account_id = $1", [pageId])).rows[0]).toEqual({ n: 3 });
    expect((await q("select kind from observations where account_id = $1 and kind in ('account_lists', 'list_items') order by id", [pageId])).rows.map((row) => row.kind))
      .toEqual(["account_lists", "list_items", "list_items", "list_items"]);

    // Walk 2: one member left the list; the one still there keeps his start.
    await walk(pageId, { lists: lists(" 💩 Бомж "), items: { head: [item("499983739493822464", "771875290119938254")] } }, 2);
    const second = await members(pageId);
    expect(second.map((row) => [row.fan, row.active, row.generation])).toEqual([
      ["499983739493822464", true, "2"], ["505123577196978176", false, "1"], ["511111111111111111", false, "1"],
    ]);
    expect(second[0]!.first.getTime()).toBe(walked[0]!.first.getTime());

    // Walk 3: the list is renamed — not walked any more, so nobody is in it; the list gone from the answer is inactive.
    const third = await walk(pageId, { lists: [{ ...lists("Друзья")[0] }], items: {} }, 3);
    expect(third.hits).toEqual(["lists.account"]);
    expect((await members(pageId)).every((row) => !row.active)).toBe(true);
    expect((await q("select list_ref, is_active from page_fan_lists where page_id = $1 order by list_ref", [pageId])).rows).toEqual([
      { list_ref: BOMZH, is_active: true }, { list_ref: QUIET, is_active: false },
    ]);
    expect((await q("select lists_walked, members_seen from page_fan_list_walks where page_id = $1", [pageId])).rows).toEqual([
      { lists_walked: 0, members_seen: 0 },
    ]);
  });
});

describe("the FANSLY BLOCKLIST reader", () => {
  const CHAT = 1716498488;

  function fakeGroup(count: number) {
    const messages = new Map<number, BlocklistMessage>();
    const at = (id: number) => new Date(Date.UTC(2025, 0, 1) + id * 60_000);
    for (let id = 1; id <= count; id++) {
      messages.set(id, { id, postedAt: at(id), editedAt: null, text: id % 10 === 5 ? `https://fansly.com/user${id}/posts` : `chatter ${id}`, urls: [], authorName: `Member ${id % 3}` });
    }
    const history: BlocklistHistory = {
      chatId: CHAT,
      async page({ offsetId, limit }) {
        const ids = [...messages.keys()].filter((id) => offsetId === 0 || id < offsetId).sort((a, b) => b - a).slice(0, limit);
        return { ids, messages: ids.map((id) => messages.get(id)!) };
      },
    };
    return { messages, history, at };
  }

  const posts = async () => (await q<{ id: number; deleted: boolean; text: string; handles: string | null }>(
    `select p.message_id::int as id, p.deleted_at is not null as deleted, p.text,
            (select string_agg(h.handle_key, ',') from fansly_blocklist_handles h where h.chat_id = p.chat_id and h.message_id = p.message_id and h.is_current) as handles
       from fansly_blocklist_posts p where p.chat_id = $1 order by p.message_id`, [CHAT])).rows;

  it("backfills in capped runs, re-reads the head for edits and deletions, and keeps only posts that name a profile", async (context) => {
    if (!testDb) return context.skip();
    await resetIntegrationDatabase(testDb.pool);
    const group = fakeGroup(450);
    const noSleep = async () => {};

    // Run 1: the newest 200 and 100 of the backfill.
    const run1 = await readBlocklistHistory(db(), group.history, { now: new Date("2026-10-27T10:00:00Z"), maxMessages: 300, sleep: noSleep });
    expect(run1).toMatchObject({ status: "read", requests: 3, messages: 300, fullRead: true, backfillDone: false });
    expect((await posts()).map((row) => row.id)).toEqual(Array.from({ length: 30 }, (_, i) => 155 + i * 10));
    expect((await q("select head_message_id::int as head, tail_message_id::int as tail, read_at is not null as read from fansly_blocklist_reader")).rows)
      .toEqual([{ head: 450, tail: 151, read: true }]);

    // Between the runs: two new posts, one edited to drop its link, one deleted, one edited to add a link.
    group.messages.set(451, { id: 451, postedAt: group.at(451), editedAt: null, text: "https://fansly.com/NewOne\nDNP", urls: [], authorName: null });
    group.messages.set(452, { id: 452, postedAt: group.at(452), editedAt: null, text: "фото", urls: [], authorName: null });
    group.messages.set(445, { ...group.messages.get(445)!, text: "UPD: ✅заплатил", editedAt: group.at(460) });
    group.messages.delete(435);
    group.messages.set(440, { ...group.messages.get(440)!, text: "этот", urls: ["https://fansly.com/Hidden"], editedAt: group.at(461) });

    // Run 2: the head again (452 down to 253), then the rest of the backfill to the first message.
    const run2 = await readBlocklistHistory(db(), group.history, { now: new Date("2026-10-27T10:10:00Z"), sleep: noSleep });
    expect(run2).toMatchObject({ status: "read", fullRead: true, backfillDone: true, deleted: 1 });
    const stored = await posts();
    expect(stored.find((row) => row.id === 451)).toMatchObject({ handles: "newone", deleted: false });
    expect(stored.find((row) => row.id === 452)).toBeUndefined();
    expect(stored.find((row) => row.id === 445)).toMatchObject({ text: "UPD: ✅заплатил", handles: null, deleted: false });
    expect(stored.find((row) => row.id === 435)).toMatchObject({ deleted: true });
    expect(stored.find((row) => row.id === 440)).toMatchObject({ handles: "hidden" });
    // 45 posts named a profile; 445 no longer does, 440 and 451 do now (435 is gone, its row kept).
    expect(stored.filter((row) => row.handles !== null).length).toBe(45 - 1 + 2);
    expect((await q("select head_message_id::int as head, tail_message_id::int as tail, backfill_done_at is not null as done from fansly_blocklist_reader")).rows)
      .toEqual([{ head: 452, tail: 1, done: true }]);
  });
});

describe("clientFanMarks", () => {
  const VERSION = "chat-extension/0.9.0";
  let app: AppContext;
  let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
  let token = "";
  let lora = 0;
  let ari = 0;

  const read = async (label: string, fanRef: string, username?: string) => {
    const response = await server!.inject({
      method: "GET",
      url: `/api/v1/client/pages/${label}/fans/${fanRef}/marks${username === undefined ? "" : `?username=${encodeURIComponent(username)}`}`,
      headers: { authorization: `Bearer ${token}`, "x-client-version": VERSION },
    });
    return response;
  };
  const marks = async (label: string, fanRef: string, username?: string) => {
    const response = await read(label, fanRef, username);
    expect(response.statusCode, response.body).toBe(200);
    return clientFanMarksResponseSchema.parse(response.json());
  };

  beforeAll(async () => {
    if (!testDb) return;
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "vanya", role: "chatter" }, { source: "cli" });
    const vanya = await fixtureUserId(app, "vanya");
    await setUserPassword(app, { userId: vanya, password: "vanya-secret" }, { source: "cli" });
    const loraModel = await createModel(app.db, { slug: "lora", name: "Lora" });
    const ariModel = await createModel(app.db, { slug: "ari", name: "Ari" });
    lora = (await createFanslyPage(app.db, { modelId: loraModel!.id, label: "lora-1" }))!.id;
    ari = (await createFanslyPage(app.db, { modelId: ariModel!.id, label: "ari-1" }))!.id;
    await createOnlyFansPage(app.db, { modelId: loraModel!.id, label: "lora-of" });
    for (const pageId of [lora, ari]) {
      await ensureSyncPage(app.db, { pageId });
      await q("update sync_pages set mode = 'live' where page_id = $1", [pageId]);
    }
    await assignPageToUser(app, { userId: vanya, pageLabel: "lora-1" }, { source: "cli" });
    await assignPageToUser(app, { userId: vanya, pageLabel: "lora-of" }, { source: "cli" });

    const fan = Number((await q<{ id: string }>("insert into fans (platform, platform_user_id, username, first_seen_at) values ('fansly', '9001', 'BadGuy', now()) returning id")).rows[0]!.id);
    const list = async (pageId: number, ref: string, label: string, active = true) => {
      await q(`insert into page_fan_lists (page_id, list_ref, label, list_type, item_count, observation_id, captured_at)
               values ($1, $2, $3, 1, 1, 0, now())`, [pageId, ref, label]);
      await q(`insert into page_fan_list_members (page_id, list_ref, fan_id, first_seen_at, last_seen_at, last_seen_generation, is_active)
               values ($1, $2, $3, '2026-10-20T00:00:00Z', now(), 1, $4)`, [pageId, ref, fan, active]);
    };
    await list(ari, "201", "Бомж");
    await list(ari, "202", "Молчун");
    await list(lora, "101", " 💩 Бомж ");
    await list(lora, "102", "бомжи старые", false);
    await q("insert into page_fan_list_walks (page_id, generation, completed_at, lists_walked, members_seen) values ($1, 1, '2026-10-27T09:00:00Z', 1, 1)", [lora]);

    const message = (id: number, day: number, text: string) => ({
      messageId: id, postedAt: new Date(Date.UTC(2026, 9, day)), editedAt: null, authorName: id === 11 ? null : "Ann", text,
      handles: parseBlocklistHandles(text),
    });
    await upsertFanslyBlocklistMessages(app.db, {
      chatId: 1716498488,
      readAt: new Date("2026-10-27T09:30:00Z"),
      messages: [
        message(10, 1, "https://fansly.com/badguy/posts"),
        message(11, 5, `${"long story ".repeat(70)}https://fansly.com/BADGUY`),
        message(12, 6, "https://fansly.com/someoneelse"),
        message(13, 7, "https://fansly.com/NewName\nTW"),
        message(14, 8, "https://fansly.com/badguy deleted"),
      ],
    });
    await q("update fansly_blocklist_posts set deleted_at = now() where message_id = 14");
    await saveFanslyBlocklistReaderState(app.db, {
      chatId: 1716498488, headMessageId: 14, tailMessageId: 1, backfillDoneAt: new Date(), readAt: new Date("2026-10-27T09:30:00Z"),
      floodUntil: null, messagesRead: 14,
    });

    server = await buildApiServer(app);
    await server.ready();
    const signIn = await server.inject({
      method: "POST", url: "/api/v1/auth/device-tokens/password", headers: { "x-client-version": VERSION },
      payload: { username: "vanya", password: "vanya-secret", label: "Firefox", mode: "active", client: "chat-extension" },
    });
    token = signIn.json<{ token: string }>().token;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("names the «бомж» lists of every Fansly page and the blocklist posts about the fan", async (context) => {
    if (!testDb || !server) return context.skip();
    const first = await marks("lora-1", "9001");
    expect(first.lists).toEqual([
      { pageLabel: "lora-1", modelName: "Lora", granted: true, label: "💩 Бомж", since: "2026-10-20T00:00:00.000Z" },
      { pageLabel: "ari-1", modelName: "Ari", granted: false, label: "Бомж", since: "2026-10-20T00:00:00.000Z" },
    ]);
    // By the username Hub holds, any case, the newest first, the deleted one left out.
    expect(first.blocklist.map((post) => [post.handle, post.link, post.author])).toEqual([
      ["BADGUY", "https://t.me/c/1716498488/11", null],
      ["badguy", "https://t.me/c/1716498488/10", "Ann"],
    ]);
    expect([...first.blocklist[0]!.text].length).toBeLessThanOrEqual(600);
    expect(first.blocklist[0]!.text.endsWith("…")).toBe(true);
    // ari-1 never finished a walk; the reader is off in this process.
    expect([first.listsReadAt, first.blocklistReadAt]).toEqual([null, null]);

    // The username the page shows now finds his posts under it too.
    await q("insert into page_fan_list_walks (page_id, generation, completed_at, lists_walked, members_seen) values ($1, 1, '2026-10-27T03:00:00Z', 1, 1)", [ari]);
    app.config.tgReaderSession = "a-session";
    const renamed = await marks("lora-1", "9001", "newname");
    expect(renamed.blocklist.map((post) => post.link)).toEqual([
      "https://t.me/c/1716498488/13", "https://t.me/c/1716498488/11", "https://t.me/c/1716498488/10",
    ]);
    expect([renamed.listsReadAt, renamed.blocklistReadAt]).toEqual(["2026-10-27T03:00:00.000Z", "2026-10-27T09:30:00.000Z"]);

    // A fan Hub does not know yet: the blocklist by the username alone.
    const unknown = await marks("lora-1", "9002", "NewName");
    expect(unknown.lists).toEqual([]);
    expect(unknown.blocklist.map((post) => post.handle)).toEqual(["NewName"]);

    // OnlyFans: nothing to mark. A page the caller does not work: refused.
    expect(await marks("lora-of", "9001")).toEqual({
      pageLabel: "lora-of", fanRef: "9001", lists: [], blocklist: [], listsReadAt: null, blocklistReadAt: null,
    });
    expect((await read("ari-1", "9001")).statusCode).toBe(403);
    expect((await read("lora-1", "9001", "has space")).statusCode).toBe(200);
  });
});

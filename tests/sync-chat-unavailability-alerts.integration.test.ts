import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countActiveLiveWorkByResource,
  listSyncPages,
  readSyncChatAlertFacts,
  readSyncLivePathFacts,
  type Database,
} from "@agency_hub_core/db";

import {
  buildEngineDomainBlock,
  buildEnginePageSyncUx,
  readEngineStatusFacts,
  readEngineSummaryFacts,
} from "../apps/runtime/src/services/sync-status-engine.ts";
import { checkLiveHour } from "../apps/runtime/src/sync/checks/live-hour.ts";
import { buildSyncChatsCommandGroup } from "../apps/runtime/src/sync/cli/chats.ts";
import { SYNC_CHAT_UNAVAILABILITY_NOTE_AUDIT_EVENT } from "../apps/runtime/src/sync/chats.ts";
import {
  readSyncAlertStatus,
  SYNC_CHATS_REFUSED_CHATS,
  SYNC_CHATS_REFUSED_WINDOW_MS,
  SYNC_UNCONFIRMED_MESSAGE_MS,
  SyncAlertEvaluator,
} from "../apps/runtime/src/sync/engine/alerts.ts";
import { computeSyncMetrics, sampleSyncEngineMetrics } from "../apps/runtime/src/sync/engine/metrics.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { readSyncPageStatuses } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { quietLogger, setModeDirect, testConfig } from "./helpers/sync-engine-host.ts";

// The chat Fansly stopped serving to its page, as the alerts and the surfaces
// read it (arena "vanished chat", plan §4, R2 PR5), against a real database:
// alert 3's `message_unconfirmed` leaves out a chat with an open episode and
// counts a chat Hub has no thread for apart, without paging; five chats
// opening an episode within ten minutes page (`chats_refused`), four do not;
// the work of an established chat is no "blocked by Fansly" in the summary,
// the Settings blocks, `sync page status` or the metrics, which count the
// chat instead (`sync_chats_unavailable`); `sync check live-hour` reads the
// same predicate; the owner's CLI lists the episodes with their evidence and
// writes a note — `owner_note*` and its audit only, no request to Fansly.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

const OWN = "100000000000000001";
const registry = createFanslyRegistry();
const groupOf = (n: number) => `30000000000000${String(n).padStart(4, "0")}`;
const fanOf = (n: number) => `20000000000000${String(n).padStart(4, "0")}`;

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function rows<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

async function livePage(label = "lora-1"): Promise<WsCapturePage> {
  const page = await seedWsCapturePage({ db: db(), pool: testDb!.pool }, { ownRef: OWN, label });
  await setModeDirect(testDb!.pool, page.pageId, "live");
  await testDb!.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [page.pageId]);
  return page;
}

async function thread(pageId: number, n: number): Promise<number> {
  return seedWsThread({ db: db(), pool: testDb!.pool }, { pageId, groupId: groupOf(n), fanRef: fanOf(n) });
}

/** An open episode as the page's actor leaves it; `openedMinutesAgo` is when
 *  its first refusal came. */
async function episode(threadId: number, input: {
  state: "refusing" | "established";
  openedMinutesAgo?: number;
  ended?: "read_served";
  note?: string;
}): Promise<number> {
  const opened = input.openedMinutesAgo ?? 7 * 60;
  const [row] = await rows<{ id: string }>(
    `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, ended_at, end_reason, refusals,
            last_refusal_at, last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
            first_observation_received_at, last_observation_id, last_observation_received_at, owner_note, owner_note_at)
     values ($1, $2::text, now() - make_interval(mins => $3::int),
             case when $2::text = 'established' then now() - interval '1 hour' end,
             case when $4::text is not null then now() - interval '1 minute' end, $4::text,
             case when $2::text = 'established' then 5 else 1 end, now() - interval '1 hour', 500,
             case when $2::text = 'established' then now() + interval '23 hours' end,
             41, 45, 901, now() - make_interval(mins => $3::int), 905, now() - interval '1 hour',
             $5::text, case when $5::text is not null then timestamptz '2026-10-06 22:14:00+00' end)
     returning id::text as id`,
    [threadId, input.state, opened, input.ended ?? null, input.note ?? null],
  );
  return Number(row!.id);
}

/** A fan message the socket showed `minutesAgo` minutes ago that no REST read
 *  confirmed (the parity pass's next look a few minutes ahead). */
async function liveMessage(pageId: number, id: string, groupId: string, minutesAgo = 20): Promise<void> {
  await testDb!.pool.query(
    `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
                                   is_sent_by_page, created_at, decoder_version, first_visible_at, confirm_due_at)
     values ($1, $2, $3, '200000000000009999', false, clock_timestamp() - make_interval(mins => $4::int + 1), 1,
             clock_timestamp() - make_interval(mins => $4::int), clock_timestamp() + interval '194 seconds')`,
    [pageId, id, groupId, minutesAgo],
  );
}

/** An open DM work row of a chat the vendor's block holds (the new head row an
 *  established chat's next socket message opens inherits it). */
async function blockedWork(pageId: number, resource: string, subject: string): Promise<void> {
  await testDb!.pool.query(
    `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, due_at, failure_count, breaker_until,
                            blocked_by_vendor_at, waiting_reason)
     values ($1, false, $2, $3, 'trigger', 'urgent', 'open', clock_timestamp() + interval '20 hours', 5,
             clock_timestamp() + interval '20 hours', clock_timestamp() - interval '4 hours', 'not_due')`,
    [pageId, resource, subject],
  );
}

async function pageRow(pageId: number) {
  return (await listSyncPages(db())).find((row) => row.pageId === pageId)!;
}

async function freshness(pageId: number) {
  const status = await readSyncAlertStatus(db(), { registry, pages: [await pageRow(pageId)] });
  return { status: status.pages[0]!, condition: status.pages[0]!.conditions.find((entry) => entry.subKey === "freshness") };
}

describe("alert 3 and a chat Fansly refuses to the page", () => {
  it("message_unconfirmed leaves out a chat with an open episode, refusing or established, and counts a chat Hub has no thread for apart", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    const refusing = await thread(page.pageId, 1);
    const established = await thread(page.pageId, 2);
    await episode(refusing, { state: "refusing", openedMinutesAgo: 30 });
    await episode(established, { state: "established" });
    await liveMessage(page.pageId, "910000000000000001", groupOf(1));
    await liveMessage(page.pageId, "910000000000000002", groupOf(2));
    // A chat the page has no thread for (its find failed): counted, never paged.
    await liveMessage(page.pageId, "910000000000000003", groupOf(3), 40);
    const evaluator = new SyncAlertEvaluator({ db: db(), logger: quietLogger, registry });
    expect((await evaluator.runOnce())!.opened).toEqual([]);
    const live = await readSyncLivePathFacts(db(), {
      pageId: page.pageId, decodeWindowMs: 600_000, unconfirmedAfterMs: SYNC_UNCONFIRMED_MESSAGE_MS,
    });
    expect(live.unconfirmed).toEqual({ count: 0, oldestVisibleAt: null });
    expect(live.unconfirmedWithoutThread.count).toBe(1);
    const { status, condition } = await freshness(page.pageId);
    expect(condition).toBeUndefined();
    expect(status.chats).toEqual({
      unavailable: 1,
      refusedRecently: 0,
      unconfirmedWithoutThread: { count: 1, oldestVisibleAt: expect.any(Date) },
    });

    // A chat Hub knows, with no episode: it pages, as before.
    await thread(page.pageId, 4);
    await liveMessage(page.pageId, "910000000000000004", groupOf(4));
    expect((await evaluator.runOnce())!.opened).toEqual([{ pageId: page.pageId, subKey: "freshness", detail: "message_unconfirmed" }]);
    expect((await freshness(page.pageId)).condition?.reasons).toEqual([
      expect.objectContaining({ detail: "message_unconfirmed", context: { messages: 1 } }),
    ]);

    // An episode that ended (an applied head read) no longer excuses its chat.
    const ended = await thread(page.pageId, 5);
    await episode(ended, { state: "established", ended: "read_served" });
    await liveMessage(page.pageId, "910000000000000005", groupOf(5));
    expect((await freshness(page.pageId)).condition?.reasons).toEqual([
      expect.objectContaining({ detail: "message_unconfirmed", context: { messages: 2 } }),
    ]);
  });

  it("chats_refused: four chats opening an episode within ten minutes page nobody, five do; an older opening does not count", async (context) => {
    if (!testDb) return context.skip();
    expect(SYNC_CHATS_REFUSED_CHATS).toBe(5);
    expect(SYNC_CHATS_REFUSED_WINDOW_MS).toBe(600_000);
    const page = await livePage();
    // Opened 11 minutes ago: outside the window, open or not.
    await episode(await thread(page.pageId, 1), { state: "refusing", openedMinutesAgo: 11 });
    for (const n of [2, 3, 4]) await episode(await thread(page.pageId, n), { state: "refusing", openedMinutesAgo: 9 });
    // One that opened and already ended inside the window still counts.
    await episode(await thread(page.pageId, 5), { state: "refusing", openedMinutesAgo: 3, ended: "read_served" });
    expect(await readSyncChatAlertFacts(db(), { pageId: page.pageId, refusedWindowMs: SYNC_CHATS_REFUSED_WINDOW_MS }))
      .toMatchObject({ unavailable: 0, refused: { chats: 4 } });
    const evaluator = new SyncAlertEvaluator({ db: db(), logger: quietLogger, registry });
    expect((await evaluator.runOnce())!.opened).toEqual([]);

    await episode(await thread(page.pageId, 6), { state: "refusing", openedMinutesAgo: 1 });
    expect((await evaluator.runOnce())!.opened).toEqual([{ pageId: page.pageId, subKey: "freshness", detail: "chats_refused" }]);
    const { condition, status } = await freshness(page.pageId);
    expect(condition).toMatchObject({ detail: "chats_refused", reasons: [expect.objectContaining({ context: { chats: 5 } })] });
    expect(status.chats).toMatchObject({ refusedRecently: 5 });
  });
});

describe("the surfaces count the chat, not its work", () => {
  it("the summary, the messages block, `sync page status` and the metrics: an established chat's blocked work is the chat, other blocks as before", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    const established = await thread(page.pageId, 1);
    const refusing = await thread(page.pageId, 2);
    await episode(established, { state: "established" });
    await episode(refusing, { state: "refusing", openedMinutesAgo: 60 });
    // The head row the next socket message opened inherited the closed row's
    // block; a catch-up neighbour of the chat still waits for its own next
    // step to close itself (PR4: only a work row settles itself).
    await blockedWork(page.pageId, "dm-messages.head", groupOf(1));
    await blockedWork(page.pageId, "dm-messages.catchup", groupOf(1));
    const counts = async () => Object.fromEntries((await countActiveLiveWorkByResource(db(), { pageIds: [page.pageId] }))
      .map((row) => [row.resource, row.blockedByVendor]));
    expect(await counts()).toEqual({ "dm-messages.head": 0, "dm-messages.catchup": 0 });

    const summary = async () => buildEnginePageSyncUx((await readEngineSummaryFacts(db(), { pageIds: [page.pageId] })).get(page.pageId)!);
    expect(await summary()).toMatchObject({
      state: "healthy",
      label: "Fansly Sync Engine",
      detail: "Managed by the Fansly Sync Engine · Chats Fansly does not serve: 1",
    });
    const blocks = async () => {
      const facts = (await readEngineStatusFacts(db(), { pageIds: [page.pageId], settingMs: 2_000 })).get(page.pageId)!;
      return { messages: buildEngineDomainBlock("messages_history", facts), audience: buildEngineDomainBlock("audience", facts) };
    };
    expect((await blocks()).messages).toMatchObject({
      needsAttention: false,
      engine: { chatsUnavailable: 1, blockedByVendor: { count: 0, resources: [] } },
    });
    const [status] = await readSyncPageStatuses(db(), testConfig(testDb.connectionString), [await pageRow(page.pageId)]);
    expect(status).toMatchObject({ breakers: { open: 0, blockedByVendor: 0 }, chatsUnavailable: 1 });
    const metrics = await computeSyncMetrics(db(), { page: await pageRow(page.pageId), windowMs: 3_600_000 });
    expect(metrics).toMatchObject({ blockedByVendor: 0, chatsUnavailable: 1 });
    const samples = await sampleSyncEngineMetrics(db(), { registry, settingMs: 2_000 });
    const gauge = (metric: string) => samples.find((sample) => sample.metric === metric && sample.quantile === "p95")?.valueMs;
    expect(gauge("sync_chats_unavailable")).toBe(1);
    expect(gauge("sync_blocked_by_vendor")).toBe(0);

    // A chat that is only refusing (not established), and a blocked subject of
    // another block: "blocked by Fansly", as before.
    await blockedWork(page.pageId, "dm-messages.head", groupOf(2));
    await blockedWork(page.pageId, "fan-profiles.probe", groupOf(1));
    expect(await counts()).toEqual({ "dm-messages.head": 1, "dm-messages.catchup": 0, "fan-profiles.probe": 1 });
    expect(await summary()).toMatchObject({
      state: "attention",
      label: "Needs attention",
      detail: "2 blocked by Fansly · Chats Fansly does not serve: 1",
    });
    expect((await blocks()).messages).toMatchObject({
      needsAttention: true,
      engine: { chatsUnavailable: 1, blockedByVendor: { count: 1, resources: ["dm-messages.head"] } },
    });
    expect((await blocks()).audience.engine).not.toHaveProperty("chatsUnavailable");
    const [again] = await readSyncPageStatuses(db(), testConfig(testDb.connectionString), [await pageRow(page.pageId)]);
    expect(again).toMatchObject({ breakers: { blockedByVendor: 2 }, chatsUnavailable: 1 });

    // The episode ends (an applied head read): the row is the vendor's block again.
    await testDb.pool.query(
      "update page_dm_thread_unavailability set ended_at = now(), end_reason = 'read_served' where thread_id = $1",
      [established],
    );
    expect(await counts()).toEqual({ "dm-messages.head": 2, "dm-messages.catchup": 1, "fan-profiles.probe": 1 });
    expect(await summary()).toMatchObject({ detail: "4 blocked by Fansly" });
  });

  it("`sync check live-hour` reads alert 3's predicate: a refused chat is neither unconfirmed nor behind; a chat with no thread is shown apart", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    await testDb.pool.query(
      "update sync_pages set mode_changed_at = clock_timestamp() - interval '2 hours' where page_id = $1",
      [page.pageId],
    );
    const refused = await thread(page.pageId, 1);
    await episode(refused, { state: "established" });
    // The fan wrote; the page's head of the chat is behind and no work reads it.
    await testDb.pool.query(
      `update page_dm_threads set last_message_id = '920000000000000001', last_message_at = clock_timestamp() - interval '30 minutes',
              last_message_sender_role = 'fan', head_confirmed_id = '910000000000000000'
        where id = $1`,
      [refused],
    );
    await liveMessage(page.pageId, "920000000000000001", groupOf(1), 30);
    await liveMessage(page.pageId, "920000000000000002", groupOf(2), 30);
    const report = await checkLiveHour(db(), { pageIds: [page.pageId], since: new Date(Date.now() - 50 * 60_000) });
    const check = (name: string) => report.pages[0]!.checks.find((entry) => entry.name === name)!;
    expect(check("unconfirmed_over_15m")).toMatchObject({ verdict: "pass", detail: { messages: 0, withoutThread: 1 } });
    expect(check("nothing_stuck").detail).toMatchObject({ fanThreadsBehind: 0 });

    // The episode ends: the chat is behind and its message unconfirmed again.
    await testDb.pool.query(
      "update page_dm_thread_unavailability set ended_at = now(), end_reason = 'read_served' where thread_id = $1",
      [refused],
    );
    const after = await checkLiveHour(db(), { pageIds: [page.pageId], since: new Date(Date.now() - 50 * 60_000) });
    const again = (name: string) => after.pages[0]!.checks.find((entry) => entry.name === name)!;
    expect(again("unconfirmed_over_15m")).toMatchObject({ verdict: "fail", detail: { messages: 1, withoutThread: 1 } });
    expect(again("nothing_stuck").detail).toMatchObject({ fanThreadsBehind: 1 });
  });
});

describe("the owner's CLI: `sync chats unavailable | note` (`cli/chats.ts`)", () => {
  async function sync(argv: string[]): Promise<string[]> {
    const printed: string[] = [];
    const command = buildSyncChatsCommandGroup({
      openContext: async () => ({ db: db(), close: async () => undefined }),
      print: (line) => void printed.push(line),
    });
    await command.parseAsync(argv, { from: "user" });
    return printed;
  }

  /** What the engine would have sent or planned: nothing, for these commands. */
  async function engineActivity(): Promise<{ work: number; attempts: number; sends: number }> {
    const [row] = await rows<{ work: number; attempts: number; sends: number }>(
      `select (select count(*)::int from sync_work) as work, (select count(*)::int from sync_attempts) as attempts,
              (select count(*)::int from fansly_send_log) as sends`,
    );
    return row!;
  }

  it("lists a page's open episodes with their evidence (text and JSON); --ended adds the ended ones", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    const established = await thread(page.pageId, 1);
    await testDb.pool.query("update page_dm_threads set partner_username = 'jonnyr850' where id = $1", [established]);
    const id = await episode(established, { state: "established", note: "06.10: профиль не открывается из-под lora-1" });
    await episode(await thread(page.pageId, 2), { state: "refusing", openedMinutesAgo: 30 });
    await episode(await thread(page.pageId, 3), { state: "established", ended: "read_served", openedMinutesAgo: 3 * 24 * 60 });
    const before = await engineActivity();

    const text = await sync(["chats", "unavailable", "--page", "lora-1"]);
    expect(text[0]).toBe("lora-1: 1 established, 1 refusing (sync why --resource dm-messages.head --subject <chat> for a chat's work)");
    expect(text[1]!.split("\t")).toEqual([
      "chat", "partner", "state", "refusals", "opened_at", "established_at", "last_refusal", "retry_not_before", "ended",
      "attempts", "observations", "owner_note",
    ]);
    expect(text).toHaveLength(4);
    const line = text.find((entry) => entry.startsWith(groupOf(1)))!.split("\t");
    expect(line.slice(0, 4)).toEqual([groupOf(1), "jonnyr850", "established", "5"]);
    expect(line.slice(9)).toEqual(["41..45", "901..905", "2026-10-06: 06.10: профиль не открывается из-под lora-1"]);

    const report = JSON.parse((await sync(["chats", "unavailable", "--page", "lora-1", "--json"]))[0]!) as {
      established: number; refusing: number; episodes: Array<Record<string, unknown>>;
    };
    expect(report).toMatchObject({ page: "lora-1", ended: false, established: 1, refusing: 1 });
    expect(report.episodes.find((entry) => entry.episodeId === id)).toMatchObject({
      chat: groupOf(1),
      partner: { username: "jonnyr850" },
      state: "established",
      refusals: 5,
      lastHttpStatus: 500,
      evidence: { firstAttemptId: 41, lastAttemptId: 45, firstObservation: { id: 901 }, lastObservation: { id: 905 } },
      ownerNote: { text: "06.10: профиль не открывается из-под lora-1", at: "2026-10-06T22:14:00.000Z" },
    });
    const all = JSON.parse((await sync(["chats", "unavailable", "--page", "lora-1", "--ended", "--json"]))[0]!) as {
      episodes: Array<{ state: string; endReason: string | null }>;
    };
    expect(all.episodes.map((entry) => entry.state)).toEqual(["refusing", "established", "ended"]);
    expect(all.episodes[2]!.endReason).toBe("read_served");
    expect((await sync(["chats", "unavailable", "--page", "lora-1", "--ended"]))[0]).toMatch(/, 1 ended \(/);
    expect(await engineActivity()).toEqual(before);
  });

  it("note writes the episode's owner_note and owner_note_at only, audited, and sends nothing", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    const chat = await thread(page.pageId, 1);
    const id = await episode(chat, { state: "established" });
    const snapshot = async () => (await rows<Record<string, unknown>>(
      "select * from page_dm_thread_unavailability where id = $1", [id],
    ))[0]!;
    const before = await snapshot();
    const activity = await engineActivity();

    const printed = await sync([
      "chats", "note", "--page", "lora-1", "--chat", groupOf(1), "--note", "  профиль не открывается  ", "--at", "2026-10-06T22:14:00Z",
    ]);
    expect(printed[0]).toMatch(new RegExp(`^lora-1: chat ${groupOf(1)}, episode ${id} \\(established\\): the owner's note written, as of 2026-10-06T22:14:00.000Z \\(audit \\d+\\)$`));
    const after = await snapshot();
    expect(after.owner_note).toBe("профиль не открывается");
    expect(after.owner_note_at).toEqual(new Date("2026-10-06T22:14:00Z"));
    // Nothing else of the episode moved, its bookkeeping included.
    const { owner_note: _n1, owner_note_at: _a1, ...restBefore } = before;
    const { owner_note: _n2, owner_note_at: _a2, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(await engineActivity()).toEqual(activity);
    const audits = await rows<{ eventType: string; metadata: Record<string, unknown> }>(
      `select event_type as "eventType", metadata from audit_events where platform_account_id = $1 order by id`,
      [page.pageId],
    );
    expect(audits).toEqual([{
      eventType: SYNC_CHAT_UNAVAILABILITY_NOTE_AUDIT_EVENT,
      metadata: expect.objectContaining({
        actor: expect.stringMatching(/^cli@.+ pid \d+$/),
        chat: groupOf(1),
        episodeId: id,
        episodeState: "established",
        noteAt: "2026-10-06T22:14:00.000Z",
        noteChars: "профиль не открывается".length,
        noteSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        replaced: false,
      }),
    }]);
    // The audit keeps the note's digest, not its text: the note goes with an erasure of the chat.
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain("профиль");

    // A second note replaces the first, as of now.
    expect((await sync(["chats", "note", "--page", "lora-1", "--chat", groupOf(1), "--note", "fan blocked the page"]))[0])
      .toMatch(/the owner's note replaced, as of /);
    expect((await snapshot()).owner_note).toBe("fan blocked the page");

    // No episode, a malformed chat, an empty or too long note: refused, nothing written.
    await thread(page.pageId, 2);
    await expect(sync(["chats", "note", "--page", "lora-1", "--chat", groupOf(2), "--note", "x"]))
      .rejects.toThrow(`lora-1 has no unavailability episode for chat ${groupOf(2)}`);
    await expect(sync(["chats", "note", "--page", "lora-1", "--chat", "abc", "--note", "x"])).rejects.toThrow(/Fansly group id/);
    await expect(sync(["chats", "note", "--page", "lora-1", "--chat", groupOf(1), "--note", "   "])).rejects.toThrow(/1–2000 characters/);
    await expect(sync(["chats", "note", "--page", "lora-1", "--chat", groupOf(1), "--note", "x".repeat(2001)]))
      .rejects.toThrow(/1–2000 characters/);
    await expect(sync(["chats", "note", "--page", "nope", "--chat", groupOf(1), "--note", "x"])).rejects.toThrow(/No Fansly sync page "nope"/);
    expect(await rows("select 1 from audit_events where platform_account_id = $1", [page.pageId])).toHaveLength(2);
    expect((await snapshot()).owner_note).toBe("fan blocked the page");
  });
});

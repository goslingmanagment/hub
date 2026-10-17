import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ensurePollRows, getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { applyFanslyWsLive } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { openWsCapture, wsCreated } from "./helpers/fansly-ws-capture.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { FakeChats, seedChatThread, type FakeChat, type FakeChatMessage } from "./helpers/sync-engine.ts";
import {
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  routeTestScale,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Skeptic of Д8а (bug hunt 2026-10-09). The hunter's test stops the actor
// right after the list walk and never applies the broadcast's socket frames,
// so it shows catch-up ROWS, not requests, and no overlay row exists that a
// guard could use. Here the whole chain is real: the broadcast's frames go
// through the step-1 live apply with the production post-ack router hook
// (overlay rows + D22 routing), then the real actor runs the head poll and
// every catch-up it asks, with the route budgets at production ratios
// (S = 2 500 ms equivalent). Counted: `/message` requests at the transport.

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

function db(): Database {
  return testDb!.db as unknown as Database;
}

function app() {
  return createTestAppContext(testDb!, { databaseUrl: testDb!.connectionString });
}

const OWN = "300000000000000001";
const CORRELATION = "990000000000000123";
const SETTING_MS = 30;
const SCALE = routeTestScale(SETTING_MS);

/** Fansly chats whose broadcast messages are the page's own type-2 mass message (one correlationId). */
class BroadcastChats extends FakeChats {
  readonly broadcast = new Set<string>();
  override wire(groupId: string, message: FakeChatMessage): Record<string, unknown> {
    const base = super.wire(groupId, message);
    return this.broadcast.has(message.id) ? { ...base, type: 2, correlationId: CORRELATION, content: "new set!" } : base;
  }
}

/** `/messaging/groups` as Fansly serves it: chats by their newest message, newest first, 100 a page. */
function listPage(chats: BroadcastChats, offset: number) {
  const sorted = chats.all()
    .map((chat) => ({ chat, head: chat.messages.at(-1)! }))
    .sort((a, b) => (BigInt(a.head.id) < BigInt(b.head.id) ? 1 : -1))
    .slice(offset, offset + 100);
  return {
    data: sorted.map(({ chat, head }) => ({
      account_id: OWN, groupId: chat.groupId, partnerAccountId: chat.fanRef, partnerUsername: `fan${chat.fanRef.slice(-4)}`,
      flags: 0, unreadCount: 0, subscriptionTierId: null, lastMessageId: head.id, lastUnreadMessageId: null,
    })),
    aggregationData: {
      accounts: sorted.map(({ chat }) => ({
        id: chat.fanRef, username: `fan${chat.fanRef.slice(-4)}`, displayName: `Fan ${chat.fanRef.slice(-4)}`, createdAt: Date.UTC(2025, 0, 1),
      })),
      groups: sorted.map(({ chat, head }) => ({
        id: chat.groupId, type: 1, groupFlags: 0, createdBy: OWN,
        users: [
          { groupId: chat.groupId, userId: OWN, type: 0, permissionFlags: 0 },
          { groupId: chat.groupId, userId: chat.fanRef, type: 0, permissionFlags: 0 },
        ],
        lastMessage: chats.wire(chat.groupId, head),
      })),
    },
  };
}

async function seedLivePage(): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, OWN]);
  return pageId;
}

async function quietRegistry(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
  return registry;
}

async function makeDue(pageId: number, resource: string) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), { pageId, resource, kind: spec.kind, class: spec.class, demand: { reasons: ["test"] } });
}

/** The run's numbers, also to a file when `D8A_OUT` names one (vitest hides a passed test's console). */
function report(label: string, value: unknown) {
  const line = `${label} ${JSON.stringify(value)}`;
  console.log(line);
  if (process.env.D8A_OUT) appendFileSync(process.env.D8A_OUT, `${line}\n`);
}

async function q<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

/** The completion instant of the head poll's last finished walk (null: none yet). */
async function lastHeadWalk(pageId: number): Promise<string | null> {
  const rows = await q<{ completed: string | null }>(
    `select cursor->'last'->>'completedAt' as completed from sync_work
      where page_id = $1 and resource = 'dm-conversations.head' and not shadow order by id desc limit 1`,
    [pageId],
  );
  return rows[0]?.completed ?? null;
}

async function openCatchups(pageId: number): Promise<number> {
  const rows = await q<{ n: number }>(
    `select count(*)::int as n from sync_work
      where page_id = $1 and resource = 'dm-messages.catchup' and state in ('open', 'running') and not shadow`,
    [pageId],
  );
  return rows[0]!.n;
}

/** Seed `recipients` + `others` known, confirmed chats; the broadcast goes to the recipients
 *  (socket frames applied through the production hook). */
async function seedBroadcast(
  pageId: number,
  recipients: number,
  others: number,
  options: { sentAt?: number; socketSaw?: boolean } = {},
) {
  const chats = new BroadcastChats(OWN);
  const all: FakeChat[] = [];
  for (let i = 0; i < recipients + others; i += 1) {
    const chat = chats.add({ count: 4, ageMs: 3 * 24 * 3_600_000 - i * 1_000 });
    await seedChatThread({ db: db(), pool: testDb!.pool }, pageId, chat, { stored: chat.messages, chain: true, ownRef: OWN });
    all.push(chat);
  }
  const capture = await openWsCapture({ db: db() }, { pageId, ownRef: OWN });
  const sentAt = options.sentAt ?? Date.now() - 10 * 60_000;
  const targets = all.slice(0, recipients);
  for (const [i, chat] of targets.entries()) {
    const [message] = chats.append(chat.groupId, 1, "page", sentAt + i);
    chats.broadcast.add(message!.id);
    if (options.socketSaw === false) continue;
    const id = await capture(wsCreated(chats.wire(chat.groupId, message!)));
    expect(await applyFanslyWsLive(app(), id)).not.toBeNull();
  }
  return { chats, targets, capture };
}

describe("skeptic Д8а: an own broadcast to known chats, end to end", () => {
  it("frames → no work; one head poll → one planned catch-up per recipient → one /message each, nothing short-circuits", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const RECIPIENTS = 150;
    const { chats } = await seedBroadcast(pageId, RECIPIENTS, 150);

    // The router (D22): the type-2 frames made no work; the overlay holds them, unconfirmed.
    const routed = await q<{ resource: string; n: number }>(
      "select resource, count(*)::int as n from sync_work where page_id = $1 and not shadow and resource like 'dm-%' group by resource",
      [pageId],
    );
    const overlayBefore = await q<{ n: number; own: number; unconfirmed: number }>(
      `select count(*)::int as n, count(*) filter (where is_sent_by_page)::int as own,
              count(*) filter (where confirmed_at is null)::int as unconfirmed
         from dm_live_messages where page_id = $1`,
      [pageId],
    );
    expect(routed).toEqual([]);
    expect(overlayBefore[0]).toEqual({ n: RECIPIENTS, own: RECIPIENTS, unconfirmed: RECIPIENTS });

    await makeDue(pageId, "dm-conversations.head");
    const transport = new ScriptedLiveTransport();
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") return okResponse(listPage(chats, Number(new URL(req.url).searchParams.get("offset"))));
      if (req.spec === "messages.page") return chats.respond(req);
      throw new Error(`unexpected ${req.spec}`);
    };
    const registry = await quietRegistry(pageId);
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, registry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport,
      ownRef: OWN, settingMs: SETTING_MS, routeTimeScale: SCALE,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    let afterSecondPoll = { listReads: 0, newCatchups: 0 };
    try {
      const firstWalk = await waitFor(async () => lastHeadWalk(pageId), 60_000, "the head walk");
      expect(await openCatchups(pageId)).toBe(RECIPIENTS);
      // The catch-ups wait out their 60 s quiet window (real time), then drain.
      await waitFor(async () => ((await openCatchups(pageId)) === 0 ? true : null), 180_000, "every catch-up closed");
      // One more head poll after the drain: what does the broadcast cost on the next one?
      const listBefore = transport.hits.filter((hit) => hit.spec === "messaging.groups").length;
      const catchupsBefore = (await q<{ n: number }>(
        "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.catchup'", [pageId]))[0]!.n;
      await makeDue(pageId, "dm-conversations.head");
      await waitFor(async () => {
        const last = await lastHeadWalk(pageId);
        return last !== null && last !== firstWalk ? true : null;
      }, 30_000, "the second head walk");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      afterSecondPoll = {
        listReads: transport.hits.filter((hit) => hit.spec === "messaging.groups").length - listBefore,
        newCatchups: (await q<{ n: number }>(
          "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.catchup'", [pageId]))[0]!.n
          - catchupsBefore,
      };
    } finally {
      stop.abort();
      await run;
    }

    const messageHits = transport.hits.filter((hit) => hit.spec === "messages.page");
    const listHits = transport.hits.filter((hit) => hit.spec === "messaging.groups");
    const spanMs = messageHits.length > 1 ? messageHits.at(-1)!.mono - messageHits[0]!.mono : 0;
    const closed = await q<{ close_reason: string; n: number }>(
      `select coalesce(close_reason, state) as close_reason, count(*)::int as n from sync_work
        where page_id = $1 and resource = 'dm-messages.catchup' group by 1 order by 1`,
      [pageId],
    );
    const overlayAfter = await q<{ outcome: string | null; n: number }>(
      "select confirm_outcome as outcome, count(*)::int as n from dm_live_messages where page_id = $1 group by 1 order by 1",
      [pageId],
    );
    const befores = await q<{ with_before: number }>(
      `select count(*) filter (where a.request->>'before' is not null)::int as with_before
         from sync_attempts a join sync_work w on w.id = a.work_id
        where w.page_id = $1 and w.resource = 'dm-messages.catchup'`,
      [pageId],
    );
    const summary = {
      recipients: RECIPIENTS,
      firstWalkListReads: listHits.length - afterSecondPoll.listReads,
      messageReads: messageHits.length,
      catchupsByClose: closed,
      catchupReadsWithBefore: befores[0]!.with_before,
      overlayAfter,
      prodEquivalentSecondsPerCatchup: messageHits.length > 1 ? +(spanMs / SCALE / (messageHits.length - 1) / 1000).toFixed(2) : null,
      afterSecondPoll,
    };
    report("drain", summary);
    // One /message head read per recipient, each a catch-up; nothing closed one without a request.
    expect(messageHits.length).toBe(RECIPIENTS);
    expect(closed).toEqual([{ close_reason: "caught_up", n: RECIPIENTS }]);
    expect(overlayAfter).toEqual([{ outcome: "match", n: RECIPIENTS }]);
    // The cost is once per broadcast: the next head poll reads one list page and asks nothing.
    expect(afterSecondPoll).toEqual({ listReads: 1, newCatchups: 0 });
  }, 300_000);

  it("fans who reply while the catch-ups wait close theirs without a request (the only thing that saves a read)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const RECIPIENTS = 60;
    const REPLIES = 10;
    const { chats, targets, capture } = await seedBroadcast(pageId, RECIPIENTS, 40);
    await makeDue(pageId, "dm-conversations.head");
    const transport = new ScriptedLiveTransport();
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") return okResponse(listPage(chats, Number(new URL(req.url).searchParams.get("offset"))));
      if (req.spec === "messages.page") return chats.respond(req);
      throw new Error(`unexpected ${req.spec}`);
    };
    const registry = await quietRegistry(pageId);
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, registry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport,
      ownRef: OWN, settingMs: SETTING_MS, routeTimeScale: SCALE,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await openCatchups(pageId)) >= RECIPIENTS ? true : null), 60_000, "the catch-ups asked");
      // Ten fans answer the broadcast inside the catch-ups' quiet window.
      for (const chat of targets.slice(0, REPLIES)) {
        const [reply] = chats.append(chat.groupId, 1, "fan", Date.now() - 500);
        const id = await capture(wsCreated(chats.wire(chat.groupId, reply!)));
        expect(await applyFanslyWsLive(app(), id)).not.toBeNull();
      }
      await waitFor(async () => ((await openCatchups(pageId)) === 0 ? true : null), 180_000, "every catch-up closed");
      await waitFor(async () => {
        const rows = await q<{ n: number }>(
          "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.head' and state <> 'done'", [pageId]);
        return rows[0]!.n === 0 ? true : null;
      }, 60_000, "every head closed");
    } finally {
      stop.abort();
      await run;
    }
    const byKey = await q<{ resource: string; reason: string; n: number }>(
      `select resource, coalesce(close_reason, state) as reason, count(*)::int as n from sync_work
        where page_id = $1 and resource like 'dm-messages.%' group by 1, 2 order by 1, 2`,
      [pageId],
    );
    const reads = await q<{ resource: string; n: number }>(
      `select w.resource, count(*)::int as n from sync_attempts a join sync_work w on w.id = a.work_id
        where w.page_id = $1 and w.resource like 'dm-messages.%' group by 1 order by 1`,
      [pageId],
    );
    const messageHits = transport.hits.filter((hit) => hit.spec === "messages.page").length;
    report("replies", { recipients: RECIPIENTS, replies: REPLIES, messageHits, byKey, reads });
    expect(byKey).toEqual([
      { resource: "dm-messages.catchup", reason: "caught_up", n: RECIPIENTS - REPLIES },
      { resource: "dm-messages.catchup", reason: "covered_by_head", n: REPLIES },
      { resource: "dm-messages.head", reason: "confirmed", n: REPLIES },
    ]);
    expect(messageHits).toBe(RECIPIENTS);
  }, 300_000);
  it("a broadcast inside a socket gap: the reconnect's repair asks one URGENT head per recipient", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedLivePage();
    const RECIPIENTS = 120;
    // The socket was down while the broadcast went out (its frames were missed); it went out inside
    // the repair's window (the repair's first demand − 60 s).
    const { chats } = await seedBroadcast(pageId, RECIPIENTS, 80, { sentAt: Date.now() - 20_000, socketSaw: false });
    // The repair's two other follow-ups (money head, subscribers poll) are switched off for the page:
    // this test counts chat reads only.
    await testDb.pool.query(
      `update sync_pages set registry_overrides = registry_overrides
         || '{"transactions.head": {"enabled": false}, "subscribers.poll": {"enabled": false}}'::jsonb where page_id = $1`,
      [pageId],
    );
    const repair = fanslyResourceSpec("repair.ws-gap")!;
    await upsertDemand(db(), { pageId, resource: repair.key, kind: repair.kind, class: repair.class, demand: { reasons: ["ws_gap"] } });
    const transport = new ScriptedLiveTransport();
    transport.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
      if (req.spec === "messaging.groups") return okResponse(listPage(chats, Number(new URL(req.url).searchParams.get("offset"))));
      if (req.spec === "messages.page") return chats.respond(req);
      throw new Error(`unexpected ${req.spec}`);
    };
    const registry = await quietRegistry(pageId);
    const alerts = new RecordingAlerts();
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId, registry, alerts, metrics: new RecordingMetrics(), transport,
      ownRef: OWN, settingMs: SETTING_MS, routeTimeScale: SCALE,
    });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => {
        const rows = await q<{ n: number }>(
          "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.head'", [pageId]);
        return rows[0]!.n >= RECIPIENTS ? true : null;
      }, 60_000, "the repair's heads asked");
      await waitFor(async () => {
        const rows = await q<{ n: number }>(
          "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.head' and state in ('open', 'running')",
          [pageId]);
        return rows[0]!.n === 0 ? true : null;
      }, 120_000, "every head closed");
    } finally {
      stop.abort();
      await run;
    }
    const heads = await q<{ class: string; reason: string; n: number }>(
      `select class, coalesce(close_reason, state) as reason, count(*)::int as n from sync_work
        where page_id = $1 and resource = 'dm-messages.head' group by 1, 2 order by 1, 2`,
      [pageId],
    );
    const catchups = (await q<{ n: number }>(
      "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.catchup'", [pageId]))[0]!.n;
    const messageHits = transport.hits.filter((hit) => hit.spec === "messages.page").length;
    const listReads = transport.hits.filter((hit) => hit.spec === "messaging.groups").length;
    report("repair", { recipients: RECIPIENTS, listReads, messageHits, heads, catchups });
    expect(heads).toEqual([{ class: "urgent", reason: "confirmed", n: RECIPIENTS }]);
    expect(messageHits).toBe(RECIPIENTS);
    expect(catchups).toBe(0);
  }, 300_000);
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getSyncPage,
  markHistoryTurnServed,
  nextOpenWorkDueAt,
  pickRequests,
  upsertDemand,
  upsertFans,
  writeThreadChain,
  type Database,
  type ThreadChainState,
} from "@agency_hub_core/db";
import type { FanslyWireRequest } from "@agency_hub_core/fansly";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import { buildSyncHistoryCommandGroup } from "../apps/runtime/src/sync/cli/history.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { dmMessagesModule } from "../apps/runtime/src/sync/fansly/resources/dm-messages.ts";
import {
  cancelHistoryRequest,
  getHistoryRequest,
  HistoryRequestError,
  onHistoryThreadChainChanged,
  submitHistoryRequest,
  type HistoryIntake,
  type HistoryServiceContext,
} from "../apps/runtime/src/sync/requests/history.ts";
import type { HistoryFanInput } from "../apps/runtime/src/sync/requests/history-rules.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// History requests against a real database (design §7.1): the 409 gate of
// step 2, validation, resolution and refusals, idempotency, one shared work
// per chat, the requests class's round robin and its stamps, chats Fansly
// refuses to the page (the chat-unavailability episode decides), anchors at
// intake, satisfaction through the engine's hook, the end of a
// chat's work, cancel, views and the owner CLI.

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

function ctx(): HistoryServiceContext {
  return { db: db(), rawConfig: testConfig(testDb!.connectionString) };
}

async function rows<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

const EPOCH_MS = 1561494359900;
const OWN = "300000000000000001";
const HOUR = 3_600_000;
const BASE_MS = Date.now() - 30 * 24 * HOUR;
const snowflake = (ms: number) => (BigInt(ms - EPOCH_MS) << 22n).toString();
/** Message k of every chat was created BASE + k minutes. */
const msg = (k: number) => snowflake(BASE_MS + k * 60_000);
const group = (n: number) => snowflake(BASE_MS - n * 1000);
const fan = (n: number) => `51000000000000${String(n).padStart(4, "0")}`;

async function seedPage(options: { mode?: "live" | "shadow"; requests?: "open" | "none" | "future" } = {}) {
  const mode = options.mode ?? "live";
  const seeded = await seedSyncPage({ db: db(), pool: testDb!.pool }, {
    mode,
    guard: mode === "live" ? "fansly_sync_engine" : null,
  });
  // Each page its own Fansly account (the first is OWN).
  await testDb!.pool.query(
    "update pages set external_page_id = (select case when count(*) = 0 then $2 else $2 || count(*)::text end from pages where external_page_id is not null) where id = $1",
    [seeded.pageId, OWN],
  );
  const enabled = options.requests ?? "open";
  await testDb!.pool.query(
    `update sync_pages set requests_enabled_at = case $2::text when 'open' then clock_timestamp() - interval '1 minute'
              when 'future' then clock_timestamp() + interval '1 day' end,
            legacy_imported_at = clock_timestamp(), mode_changed_at = clock_timestamp() - interval '1 day'
      where page_id = $1`,
    [seeded.pageId, enabled],
  );
  return seeded;
}

interface ThreadSeed {
  n: number;
  fan?: string;
  bound?: boolean;
  excluded?: boolean;
  /** Chain of messages `from..to` (newest `to`); complete proves it. */
  chain?: { from: number; to: number; complete?: boolean; upward?: number; epoch?: number };
  lastMessageAgoMs?: number;
}

async function seedThread(pageId: number, seed: ThreadSeed): Promise<number> {
  const partner = seed.fan ?? fan(seed.n);
  const [fanRow] = await upsertFans(db(), [{ platform: "fansly" as const, platformUserId: partner }]);
  const metadata = seed.excluded ? { [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "partner_missing_from_aggregation_accounts" } : {};
  const count = seed.chain === undefined ? 0 : seed.chain.to - seed.chain.from + 1;
  const inserted = await rows<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, partner_platform_user_id,
            stored_message_count, newest_stored_message_id, oldest_stored_message_id, message_coverage_status, is_visible,
            last_message_at, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, 'partial_window', true, now() - ($8::bigint * interval '1 millisecond'), $9::jsonb)
     returning id::text as id`,
    [
      pageId, group(seed.n), seed.bound === false ? null : fanRow!.id, partner, count,
      seed.chain === undefined ? null : msg(seed.chain.to), seed.chain === undefined ? null : msg(seed.chain.from),
      seed.lastMessageAgoMs ?? 0, JSON.stringify(metadata),
    ],
  );
  const threadId = Number(inserted[0]!.id);
  if (seed.chain !== undefined) await writeChain(threadId, seed.chain);
  return threadId;
}

function chainState(chain: NonNullable<ThreadSeed["chain"]>, headAt = new Date(Date.now() - HOUR)): ThreadChainState {
  const complete = chain.complete === true;
  return {
    epoch: chain.epoch ?? 0,
    state: complete ? "complete" : "partial",
    headId: msg(chain.to),
    headAt,
    oldestId: msg(chain.from),
    oldestCreatedAtMs: BASE_MS + chain.from * 60_000,
    count: chain.to - chain.from + 1,
    upwardCount: chain.upward ?? 0,
    proof: complete ? "empty_page" : null,
    proofWitness: complete ? { kind: "raw", rawPayloadId: 1 } : null,
    provenAt: complete ? headAt : null,
  };
}

async function writeChain(threadId: number, chain: NonNullable<ThreadSeed["chain"]>, headAt?: Date) {
  await db().transaction(async (tx) => {
    await writeThreadChain(tx as unknown as Database, threadId, { chain: chainState(chain, headAt), source: "journal_rebuild" });
  });
}

function intake(pageId: number, fans: HistoryFanInput[], overrides: Partial<HistoryIntake> = {}): HistoryIntake {
  return {
    pageId,
    requester: { kind: "owner_cli", userId: null },
    fans,
    depth: { kind: "all" },
    reason: "integration",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

async function refusedWith(promise: Promise<unknown>): Promise<HistoryRequestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HistoryRequestError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function historyWork(pageId: number, n: number) {
  const found = await rows<{ id: string; state: string; class: string; kind: string; due_at: Date; close_reason: string | null }>(
    `select id::text, state, class, kind, due_at, close_reason from sync_work
      where page_id = $1 and resource = 'dm-messages.history' and subject = $2 order by id desc limit 1`,
    [pageId, group(n)],
  );
  return found[0] ?? null;
}

async function openSocket(pageId: number, verifiedAgoMs: number) {
  await testDb!.pool.query(
    `insert into fansly_ws_connections (id, page_id, generation, started_at, last_guard_at, verified_at)
     values (gen_random_uuid(), $1, repeat('a', 64), now() - interval '1 day', now(), now() - ($2::bigint * interval '1 millisecond'))`,
    [pageId, verifiedAgoMs],
  );
}

describe("the gate of step 2", () => {
  it("refuses with 409 on a page that is not live, or whose requests are not enabled yet, and writes nothing", async (context) => {
    if (!testDb) return context.skip();
    const cases = [
      await seedPage({ mode: "shadow" }),
      await seedPage({ requests: "none" }),
      await seedPage({ requests: "future" }),
    ];
    for (const { pageId } of cases) {
      await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
      const refusal = await refusedWith(submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }])));
      expect(refusal).toMatchObject({ status: 409, code: "history_requests_unavailable_on_page" });
    }
    expect(await rows("select id from history_requests")).toEqual([]);
    expect(await rows("select id from sync_work where resource = 'dm-messages.history'")).toEqual([]);
  });

  it("refuses a malformed request with 400", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    const one: HistoryFanInput[] = [{ kind: "fan", platformUserId: fan(1) }];
    for (const bad of [
      intake(pageId, one, { idempotencyKey: "not-a-uuid" }),
      intake(pageId, []),
      intake(pageId, Array.from({ length: 1001 }, (_, index) => ({ kind: "fan" as const, platformUserId: String(index) }))),
      intake(pageId, one, { reason: "" }),
      intake(pageId, one, { depth: { kind: "latest", count: 0 } }),
      intake(pageId, [{ kind: "fan", platformUserId: "   " }]),
    ]) {
      expect(await refusedWith(submitHistoryRequest(ctx(), bad))).toMatchObject({ status: 400, code: "invalid_history_request" });
    }
  });
});

describe("intake", () => {
  it("resolves every fan to a chat or refuses it; fans of one chat share one work; a satisfied fan needs no read", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    const t1 = await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    await seedThread(pageId, { n: 2, excluded: true });
    await seedThread(pageId, { n: 3, bound: false });
    const t4 = await seedThread(pageId, { n: 4, chain: { from: 1, to: 30, complete: true } });
    // [A16]: one fan, two chats — the one with the latest message.
    await seedThread(pageId, { n: 5, fan: fan(50), lastMessageAgoMs: 10 * HOUR });
    const t6 = await seedThread(pageId, { n: 6, fan: fan(50), lastMessageAgoMs: HOUR });
    const result = await submitHistoryRequest(ctx(), intake(pageId, [
      { kind: "fan", platformUserId: fan(1) },
      { kind: "conversation", conversationRef: group(2) },
      { kind: "conversation", conversationRef: group(3) },
      { kind: "fan", platformUserId: "999" },
      { kind: "chat_url", url: `https://fansly.com/messages/${group(1)}` },
      { kind: "conversation", conversationRef: group(4) },
      { kind: "fan", platformUserId: fan(50) },
      { kind: "chat_url", url: "https://fansly.com/user123" },
    ]), { audit: { source: "cli", actorUserId: null } });
    expect(result.disposition).toBe("created");
    expect(result.items.map((item) => [item.ordinal, item.state, item.refusal, item.excludedReason])).toEqual([
      [0, "queued", null, null],
      [1, "refused", "excluded", "partner_missing_from_aggregation_accounts"],
      [2, "refused", "excluded", "unbound"],
      [3, "refused", "not_found", null],
      [4, "refused", "duplicate", null],
      [5, "ready", null, null],
      [6, "queued", null, null],
      [7, "refused", "not_found", null],
    ]);
    expect(result.items[0]).toMatchObject({ fanPlatformUserId: fan(1), conversationRef: group(1), historyState: "partial", loadedMessages: 10 });
    expect(result.items[3]).toMatchObject({ fanPlatformUserId: "999", conversationRef: null });
    expect(result.items[5]).toMatchObject({ satisfiedBy: "already_satisfied", historyState: "complete", historyProof: "empty_page" });
    expect(result.items[6]).toMatchObject({ conversationRef: group(6) });
    expect(result.request).toMatchObject({
      state: "open",
      counts: { total: 8, ready: 1, queued: 2, loading: 0, blocked: 0, refused: 5, cancelled: 0 },
      reads: { done: 0 },
    });
    expect(result.request.estimateAtSubmit).toMatchObject({ settingMs: expect.any(Number), readsMin: expect.any(Number) });
    expect(result.request.eta.basis).toBe("estimate");
    // One shared requests-class work per chat that needs reads; none for the
    // satisfied chat.
    const works = await rows<{ subject: string; class: string; kind: string; state: string }>(
      "select subject, class, kind, state from sync_work where resource = 'dm-messages.history' order by subject",
    );
    expect(works).toEqual([group(6), group(1)].sort().map((subject) => ({ subject, class: "requests", kind: "goal", state: "open" })));
    const items = await rows<{ ordinal: number; thread_id: string | null; work_id: string | null }>(
      "select ordinal, thread_id::text, work_id::text from history_request_items order by ordinal",
    );
    expect(items.filter((item) => item.work_id !== null).map((item) => [item.ordinal, Number(item.thread_id)])).toEqual([[0, t1], [6, t6]]);
    expect(items.find((item) => item.ordinal === 5)!.thread_id).toBe(String(t4));
    expect(await rows("select event_type from audit_events where event_type = 'admin.history_request_create'"))
      .toEqual([{ event_type: "admin.history_request_create" }]);
    // The reason is a digest only.
    expect(await rows("select id from history_requests where reason_sha256 = encode(sha256(convert_to('integration', 'UTF8')), 'hex')"))
      .toHaveLength(1);
  });

  it("is idempotent: the same key and request coalesce, another request under the key is refused, a race files once", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    const filed = intake(pageId, [{ kind: "fan", platformUserId: fan(1) }]);
    const first = await submitHistoryRequest(ctx(), filed);
    const again = await submitHistoryRequest(ctx(), filed);
    expect(again).toMatchObject({ disposition: "coalesced", request: { ref: first.request.ref } });
    expect(await refusedWith(submitHistoryRequest(ctx(), { ...filed, depth: { kind: "latest", count: 5 } })))
      .toMatchObject({ status: 409, code: "idempotency_mismatch" });
    const raced = intake(pageId, [{ kind: "fan", platformUserId: fan(1) }]);
    const both = await Promise.all([submitHistoryRequest(ctx(), raced), submitHistoryRequest(ctx(), raced)]);
    expect(both.map((result) => result.disposition).sort()).toEqual(["coalesced", "created"]);
    expect(both[0].request.ref).toBe(both[1].request.ref);
    expect(await rows("select id from history_requests")).toHaveLength(2);
  });

  /** A chat-unavailability episode of the chat (arena "vanished chat" §2). */
  async function seedEpisode(threadId: number, state: "refusing" | "established", refusals: number): Promise<void> {
    await testDb!.pool.query(
      `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, refusals, last_refusal_at,
              last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
              first_observation_received_at, last_observation_id, last_observation_received_at)
       values ($1, $2::text, now() - interval '7 hours', case when $2::text = 'established' then now() end, $3::int, now(), 500,
               case when $2::text = 'established' then now() + interval '1 day' end, 0, 0, 0, now(), 0, now())`,
      [threadId, state, refusals],
    );
  }

  it("a chat Fansly refuses to the page (an established episode) is refused at intake: excluded, chat_unavailable, no read", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    const threadId = await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    await seedEpisode(threadId, "established", 5);
    const result = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    expect(result.items[0]).toMatchObject({ state: "refused", refusal: "excluded", excludedReason: "chat_unavailable" });
    expect(result.request.state).toBe("done");
    expect(await historyWork(pageId, 1)).toBeNull();
    expect(await pickRequests(db(), { pageId })).toBeNull();
  });

  it("the chat's episode decides, never the latest work of a DM read: a blocked read without an established episode leaves the fan queued", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    const refusing = await seedThread(pageId, { n: 2, chain: { from: 1, to: 10 } });
    await seedEpisode(refusing, "refusing", 4);
    // The chat's history walk met refusals of a deeper page (blocked by the
    // vendor) — the head the new fan needs first says nothing of it.
    await testDb.pool.query(
      `insert into sync_work (page_id, resource, subject, kind, class, state, closed_at, close_reason, failure_count,
              breaker_until, blocked_by_vendor_at)
       values ($1, 'dm-messages.head', $2, 'trigger', 'urgent', 'done', now(), 'test', 5, now() + interval '6 hours', now() - interval '1 hour')`,
      [pageId, group(1)],
    );
    const result = await submitHistoryRequest(ctx(), intake(pageId, [
      { kind: "conversation", conversationRef: group(1) },
      { kind: "conversation", conversationRef: group(2) },
    ]));
    expect(result.items.map((item) => ({ state: item.state, probeAt: item.probeAt })))
      .toEqual([{ state: "queued", probeAt: null }, { state: "queued", probeAt: null }]);
    expect(new Date((await historyWork(pageId, 1))!.due_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await pickRequests(db(), { pageId })).not.toBeNull();
  });

  it("a head confirmed while the page's socket was verified anchors the fan at intake: latest N already met needs no read", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10, upward: 3 } });
    await openSocket(pageId, 2 * HOUR);
    const met = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }], {
      depth: { kind: "latest", count: 10 },
    }));
    expect(met.items[0]).toMatchObject({ state: "ready", satisfiedBy: "already_satisfied", anchorMessageRef: msg(10), loadedMessages: 10 });
    expect(met.request.state).toBe("done");
    const more = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }], {
      depth: { kind: "latest", count: 15 },
    }));
    expect(more.items[0]).toMatchObject({ state: "queued", anchorMessageRef: msg(10), estimate: { readsMin: 1 } });
  });

  it("refuses every fan of an erased page", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    const [operator] = await rows<{ id: string }>("insert into users (username, role) values ('history-eraser', 'owner') returning id::text");
    await testDb.pool.query(
      `insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan)
       values ('page', 'page:x', $1, false, jsonb_build_object('resolvedPageIds', jsonb_build_array($2::bigint)))`,
      [operator!.id, pageId],
    );
    const result = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    expect(result.items.map((item) => item.refusal)).toEqual(["page_erased"]);
    expect(result.request.state).toBe("done");
  });
});

describe("serving and settling", () => {
  it("two requests share a chat's work; the requests class serves them in turn and counts each read on one fan", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    await seedThread(pageId, { n: 2, chain: { from: 1, to: 10 } });
    const a = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    const b = await submitHistoryRequest(ctx(), intake(pageId, [
      { kind: "conversation", conversationRef: group(1) },
      { kind: "conversation", conversationRef: group(2) },
    ]));
    const shared = await rows<{ work_id: string }>("select distinct work_id::text from history_request_items where conversation_ref = $1", [group(1)]);
    expect(shared).toHaveLength(1);
    const turns: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const picked = await pickRequests(db(), { pageId });
      expect(picked).not.toBeNull();
      const [request] = await rows<{ ref: string }>("select request_ref::text as ref from history_requests where id = $1", [picked!.requestId]);
      turns.push(`${request!.ref === a.request.ref ? "a" : "b"}:${picked!.work.subject === group(1) ? 1 : 2}`);
      await markHistoryTurnServed(db(), { requestId: picked!.requestId, itemId: picked!.itemId });
    }
    // Requests alternate; inside b, its fans alternate.
    expect(turns).toEqual(["a:1", "b:1", "a:1", "b:2"]);
    const view = await getHistoryRequest(ctx(), b.request.ref);
    expect(view.items.map((item) => [item.state, item.readsSpent])).toEqual([["loading", 1], ["loading", 1]]);
    expect(view.request.reads.done).toBe(2);
  });

  it("the engine's hook: a fan is ready once the chain below its anchor holds N; the request is done and the chat's work closes", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    const threadId = await seedThread(pageId, { n: 1, chain: { from: 21, to: 30 } });
    await openSocket(pageId, 2 * HOUR);
    const filed = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }], {
      depth: { kind: "latest", count: 15 },
    }));
    expect(filed.items[0]).toMatchObject({ state: "queued", anchorMessageRef: msg(30) });
    // A read below the chain: 25 more messages, and 2 new ones above the
    // anchor (they arrived live and do not count).
    await db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await writeThreadChain(tx, threadId, {
        source: "engine",
        chain: { ...chainState({ from: 1, to: 32, upward: 2 }), count: 32 },
      });
      await onHistoryThreadChainChanged(tx, { pageId, threadId });
    });
    const after = await getHistoryRequest(ctx(), filed.request.ref);
    expect(after.request.state).toBe("done");
    expect(after.items[0]).toMatchObject({ state: "ready", satisfiedBy: "latest_n", loadedMessages: 15 });
    const [item] = await rows<{ satisfied_count: number; final: Record<string, unknown> }>("select satisfied_count, final from history_request_items");
    expect(item!.satisfied_count).toBe(30);
    expect(item!.final).toMatchObject({ readsSpent: 0, loadedMessages: 15 });
    expect(await historyWork(pageId, 1)).toMatchObject({ state: "done", close_reason: "goal_satisfied" });
  });

  it("a new chain epoch clears an anchor", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    const threadId = await seedThread(pageId, { n: 1, chain: { from: 21, to: 30 } });
    await openSocket(pageId, 2 * HOUR);
    const filed = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }], {
      depth: { kind: "latest", count: 100 },
    }));
    expect(filed.items[0]!.anchorMessageRef).toBe(msg(30));
    await db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await writeThreadChain(tx, threadId, { source: "engine", chain: chainState({ from: 25, to: 30, epoch: 1 }, new Date(Date.now() - 2 * HOUR)) });
      await onHistoryThreadChainChanged(tx, { pageId, threadId });
    });
    expect((await getHistoryRequest(ctx(), filed.request.ref)).items[0]).toMatchObject({ state: "queued", anchorMessageRef: null });
  });

  it("cancel stops a request's fans; a chat another request still reads keeps its work; loaded data stays", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    const a = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    const b = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    const cancelledA = await cancelHistoryRequest(ctx(), a.request.ref, { reason: "enough", audit: { source: "cli", actorUserId: null } });
    expect(cancelledA).toMatchObject({ disposition: "cancelled", request: { state: "cancelled", counts: { cancelled: 1 } } });
    expect(await historyWork(pageId, 1)).toMatchObject({ state: "open" });
    expect((await cancelHistoryRequest(ctx(), a.request.ref)).disposition).toBe("already_cancelled");
    await cancelHistoryRequest(ctx(), b.request.ref);
    expect(await historyWork(pageId, 1)).toMatchObject({ state: "cancelled", close_reason: "request_cancelled" });
    expect(await rows("select contiguous_count from page_dm_threads")).toEqual([{ contiguous_count: 10 }]);
    expect(await rows("select event_type from audit_events where event_type = 'admin.history_request_cancel'")).toHaveLength(1);
    expect(await rows("select cancel_reason_sha256 is not null as digest from history_requests order by id")).toEqual([{ digest: true }, { digest: false }]);
    expect(await refusedWith(cancelHistoryRequest(ctx(), randomUUID()))).toMatchObject({ status: 404 });
  });

  it("a chat excluded after intake: the actor's plan ends its work and the fan is refused (no read)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    const threadId = await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    const filed = await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    await testDb.pool.query("update page_dm_threads set metadata = $2::jsonb where id = $1", [
      threadId, JSON.stringify({ [FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY]: "partner_unresolvable_from_account_lookup" }),
    ]);
    const transport = new ScriptedLiveTransport();
    const requests: FanslyWireRequest[] = [];
    transport.respond = (req) => {
      requests.push(req);
      return okResponse({ messages: [] });
    };
    const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
    const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, ownRef: OWN });
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(async () => ((await historyWork(pageId, 1))?.state === "done" ? true : null), 20_000, "the history work to end");
    } finally {
      stop.abort();
      await run;
    }
    expect(requests.filter((req) => req.spec === "messages.page")).toEqual([]);
    const after = await getHistoryRequest(ctx(), filed.request.ref);
    expect(after.items[0]).toMatchObject({ state: "refused", refusal: "excluded", excludedReason: "partner_unresolvable_from_account_lookup" });
    expect(after.request.state).toBe("done");
  });

  it("no history walk without a request (I12); the idle wait never counts work no fan rides on, nor the paused requests class", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    await seedThread(pageId, { n: 1, chain: { from: 1, to: 10 } });
    const orphan = await upsertDemand(db(), {
      pageId, resource: "dm-messages.history", subject: group(1), kind: "goal", class: "requests",
    });
    const [work] = await rows<Record<string, unknown>>("select * from sync_work where id = $1", [orphan.id]);
    const plan = await dmMessagesModule("history").plan({
      id: orphan.id, subject: group(1), cursor: {}, demand: { messageIds: [], txIds: [], reasons: [], overflow: false },
    } as never, { db: db(), pageId, now: new Date() } as never);
    expect(plan).toEqual({ kind: "done", reason: "no_open_items" });
    expect(work).toBeDefined();
    expect(await nextOpenWorkDueAt(db(), { pageId })).toBeNull();

    await submitHistoryRequest(ctx(), intake(pageId, [{ kind: "conversation", conversationRef: group(1) }]));
    expect(await nextOpenWorkDueAt(db(), { pageId })).not.toBeNull();
    expect(await nextOpenWorkDueAt(db(), { pageId, excludeClasses: ["requests"] })).toBeNull();
  });
});

describe("views and the owner CLI", () => {
  it("pages a request's fans and explains what it waits for", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedPage();
    for (const n of [1, 2, 3]) await seedThread(pageId, { n, chain: { from: 1, to: 10 } });
    const filed = await submitHistoryRequest(ctx(), intake(pageId, [1, 2, 3].map((n) => ({ kind: "conversation" as const, conversationRef: group(n) }))));
    const first = await getHistoryRequest(ctx(), filed.request.ref, { limit: 2 });
    expect(first.items.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(first.nextAfterOrdinal).toBe(1);
    const rest = await getHistoryRequest(ctx(), filed.request.ref, { limit: 2, afterOrdinal: first.nextAfterOrdinal });
    expect(rest.items.map((item) => item.ordinal)).toEqual([2]);
    expect(rest.nextAfterOrdinal).toBeNull();
    // No actor owns the page here: the request waits for one.
    expect(first.request).toMatchObject({
      queuePosition: 1,
      waitingReason: "ownership_unconfirmed",
      reads: { done: 0, remainingMin: expect.any(Number) },
      eta: { basis: "estimate", lowerBoundSeconds: expect.any(Number), sharePercent: expect.any(Number) },
    });
    expect(first.request.reads.remainingMin).toBeGreaterThanOrEqual(3);
    expect(first.items[0]).toMatchObject({ waitingReason: "ownership_unconfirmed", estimate: { readsMin: expect.any(Number) } });
  });

  it("`sync history request|status|list|cancel` and the 409 of a shadow page", async (context) => {
    if (!testDb) return context.skip();
    const live = await seedPage();
    const shadow = await seedPage({ mode: "shadow" });
    await seedThread(live.pageId, { n: 1, chain: { from: 1, to: 10 } });
    const printed: string[] = [];
    const exitCodes: number[] = [];
    const sync = buildSyncHistoryCommandGroup({
      openContext: async () => ({
        db: db(),
        rawConfig: testConfig(testDb!.connectionString),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
        close: async () => undefined,
      }),
      print: (line) => printed.push(line),
      readFile: async () => `# list\n${fan(1)}\n`,
      setExitCode: (code) => exitCodes.push(code),
    });
    const key = randomUUID();
    await sync.parseAsync(["history", "request", "--page", live.label, "--file", "fans.txt", "--latest", "50", "--reason", "cli",
      "--idempotency-key", key], { from: "user" });
    const created = JSON.parse(printed.at(-1)!) as { disposition: string; request: { ref: string } };
    expect(created.disposition).toBe("created");
    await sync.parseAsync(["history", "status", "--request", created.request.ref, "--state", "queued"], { from: "user" });
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ request: { ref: created.request.ref }, items: [{ ordinal: 0, state: "queued" }] });
    await sync.parseAsync(["history", "list", "--page", live.label], { from: "user" });
    expect((JSON.parse(printed.at(-1)!) as unknown[]).length).toBe(1);
    await sync.parseAsync(["history", "cancel", "--request", created.request.ref, "--reason", "done"], { from: "user" });
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ disposition: "cancelled" });
    expect(exitCodes).toEqual([]);

    await sync.parseAsync(["history", "request", "--page", shadow.label, "--fan", fan(1), "--all", "--reason", "cli"], { from: "user" });
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ error: { status: 409, code: "history_requests_unavailable_on_page", mode: "shadow" } });
    expect(exitCodes).toEqual([1]);
    await expect(sync.parseAsync(["history", "request", "--page", live.label, "--fan", fan(1), "--reason", "x"], { from: "user" }))
      .rejects.toThrow(/--all or --latest/);
    expect((await getSyncPage(db(), shadow.pageId))!.mode).toBe("shadow");
  });
});

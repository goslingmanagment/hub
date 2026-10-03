import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, upsertDemand, type Database } from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { SyncCrashFault } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeChats, HARNESS_OWN_REF, runActorUntil, seedChatThread, seedHarnessPage, type FakeChat } from "./helpers/sync-engine.ts";
import { makeTestActor, okResponse, pollsRequest, ScriptedLiveTransport, testSpec } from "./helpers/sync-engine-host.ts";

// The erasure fence of the engine's applies (plan §8, design §3.7, I15).
// - While an erasure holds the page's exclusive fence, every apply that writes
//   fan material (`dm-messages.*`, `transactions.*`) is deferred, never
//   blocked and never written; the page keeps serving its other work; once
//   the fence is free the deferred applies run from the journal, without a
//   second request.
// - A fan erased before the read: when the chat comes back (the fan writes
//   again), the vendor still serves the old messages; none of them reaches
//   the ledger's events or the archive (nor `page_dm_messages`, which the
//   engine never writes, step 4 S4-13) — only what the fan wrote after the
//   erasure (the fence is material-time-bounded).
// - A read captured before the erasure and applied after it (the process
//   died in between): the restarted actor finds nothing to bring back.
//
// Every erasure here is the real one (`executeErasure`).

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

const DAY = 86_400_000;
const FREE_KEY = "fence.free";

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

async function count(text: string, values: unknown[] = []): Promise<number> {
  const [row] = await rows<{ n: number }>(text, values);
  return Number(row?.n ?? 0);
}

/** The fenced writers of the DM and money files, and one key that takes no fence. */
function registry(): EngineRegistry {
  const free = {
    plan: async () => ({ kind: "request" as const, request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" as const }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" as const }, followups: [] }),
  };
  return createEngineRegistry([
    ...["dm-messages.head", "dm-messages.catchup", "dm-messages.history", "transactions.head"].map((key) => fanslyResourceSpec(key)!),
    testSpec(FREE_KEY, free, { fence: "none" }),
  ]);
}

async function livePage(): Promise<number> {
  const { pageId } = await seedHarnessPage(handles(), { mode: "live" });
  // What the money resources read of the page (account start, verified).
  await testDb!.pool.query(
    "update pages set metadata = $2::jsonb, last_verified_at = clock_timestamp() where id = $1",
    [pageId, JSON.stringify({ accountCreatedAt: "2026-08-15T00:00:00.000Z" })],
  );
  return pageId;
}

async function headDemand(pageId: number, chat: FakeChat, messageIds: readonly string[]) {
  await upsertDemand(db(), {
    pageId, shadow: false, resource: "dm-messages.head", subject: chat.groupId, kind: "trigger", class: "urgent",
    dueAt: new Date(Date.now() - 1_000), demand: { messageIds: [...messageIds], txIds: [], reasons: ["test"] },
  });
}

function transaction(id: string, fanRef: string) {
  return {
    walletId: "wallet-1", transactionId: id, accountId: HARNESS_OWN_REF, correlationId: null, correlationAccountId: fanRef,
    type: 7001, destination: 1, amount: 10_000, destinationTax: 2_000, destinationAmount: 8_000, newBalance: null,
    newBalance64: 100_000, createdAt: Date.now() - 3_600_000, updatedAt: null, status: 1, senderId: fanRef, receiverId: HARNESS_OWN_REF,
  };
}

function transport(chats: FakeChats, transactions: unknown[] = []): ScriptedLiveTransport {
  const scripted = new ScriptedLiveTransport();
  scripted.respond = (req: FanslyWireRequest): FanslyWireOutcome => {
    if (req.spec === "messages.page") return chats.respond(req);
    if (req.spec === "transactions.page") return okResponse({ total: transactions.length, data: transactions });
    if (req.spec === "polls") return okResponse([]);
    throw new Error(`unexpected ${req.spec}`);
  };
  return scripted;
}

async function withEraser<T>(body: (app: never, operatorId: number) => Promise<T>): Promise<T> {
  const [operator] = await rows<{ id: string }>("insert into users (username, role) values ('fence-owner', 'owner') returning id::text");
  const lakeDir = await mkdtemp(path.join(tmpdir(), "sync-erasure-fence-"));
  try {
    const app = { db: testDb!.db, pool: testDb!.pool, config: { lakeDir }, logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;
    return await body(app, Number(operator!.id));
  } finally {
    await rm(lakeDir, { recursive: true, force: true });
  }
}

function eraseFan(fanRef: string) {
  return withEraser((app, operatorId) =>
    executeErasure(app, { scopeType: "fan", platform: "fansly", fanRef }, { initiatedBy: operatorId }));
}

/** The chat's messages in `message_archive`, a live page's store (step 4 S4-08). */
async function storedIds(pageId: number, groupId: string): Promise<string[]> {
  const result = await rows<{ id: string }>(
    `select message_ref as id from message_archive
      where account_id = $1 and platform = 'fansly' and conversation_ref = $2 order by message_ref::numeric`,
    [pageId, groupId],
  );
  return result.map((row) => row.id);
}

/** The chat's `page_dm_messages` rows: what legacy stored (the fixture's
 *  `stored`); the engine writes none (step 4 S4-13). */
async function hotIds(pageId: number, groupId: string): Promise<string[]> {
  const result = await rows<{ id: string }>(
    `select m.platform_message_id as id from page_dm_messages m join page_dm_threads t on t.id = m.conversation_id
      where t.platform_account_id = $1 and t.platform_conversation_id = $2 order by m.platform_message_id::numeric`,
    [pageId, groupId],
  );
  return result.map((row) => row.id);
}

describe("the erasure fence of the applies (I15)", () => {
  it("an erasure holding the fence defers every fenced apply, the page keeps serving, the applies run from the journal once it is free", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    const chat = chats.add({ count: 10, ageMs: 30 * DAY });
    await seedChatThread(handles(), pageId, chat, { stored: chat.messages.slice(0, 5), chain: true });
    await headDemand(pageId, chat, [chat.messages[9]!.id]);
    await upsertDemand(db(), {
      pageId, shadow: false, resource: "transactions.head", subject: "", kind: "trigger", class: "urgent",
      dueAt: new Date(Date.now() - 1_000), demand: { messageIds: [], txIds: ["tx-1"], reasons: ["test"] },
    });
    await upsertDemand(db(), { pageId, shadow: false, resource: FREE_KEY, subject: "x", kind: "trigger", class: "urgent" });
    const scripted = transport(chats, [transaction("tx-1", chat.fanRef)]);

    // An erasure of the page holds the exclusive fence (its delete transaction).
    const erasure = await testDb.pool.connect();
    try {
      await erasure.query("begin");
      await erasure.query("select pg_advisory_xact_lock($1, $2)", [DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, pageId]);
      const held = await makeTestActor({ db: db(), pageId, mode: "live", registry: registry(), transport: scripted, settingMs: 1 });
      await runActorUntil(held, async () => (await count(
        "select count(*)::int as n from sync_attempts where page_id = $1 and apply_state = 'deferred'", [pageId],
      )) === 2 && (await count(
        "select count(*)::int as n from sync_work where page_id = $1 and resource = $2 and state = 'done'", [pageId, FREE_KEY],
      )) === 1, 30_000, "both fenced applies deferred and the free key served");

      const deferred = await rows<{ resource: string; apply_error: string; work_state: string }>(
        `select a.resource, a.apply_error, w.state as work_state from sync_attempts a join sync_work w on w.id = a.work_id
          where a.page_id = $1 and a.apply_state = 'deferred' order by a.resource`,
        [pageId],
      );
      expect(deferred).toEqual([
        { resource: "dm-messages.head", apply_error: expect.stringContaining("erasure_busy"), work_state: "running" },
        { resource: "transactions.head", apply_error: expect.stringContaining("erasure_busy"), work_state: "running" },
      ]);
      // Nothing of either answer was written under the erasure.
      expect(await storedIds(pageId, chat.groupId)).toEqual([]);
      expect(await count("select count(*)::int as n from transactions where platform_account_id = $1", [pageId])).toBe(0);
      expect(scripted.hits.map((hit) => hit.spec).sort()).toEqual(["messages.page", "polls", "transactions.page"]);
    } finally {
      await erasure.query("commit");
      erasure.release();
    }

    // The fence is free: the restarted actor applies both from the journal.
    const freed = await makeTestActor({ db: db(), pageId, mode: "live", registry: registry(), transport: scripted, settingMs: 1 });
    await runActorUntil(freed, async () => (await count(
      "select count(*)::int as n from sync_attempts where page_id = $1 and apply_state = 'applied'", [pageId],
    )) === 3, 30_000, "every apply done");
    expect(scripted.hits).toHaveLength(3);
    expect(await count("select count(*)::int as n from sync_attempts where page_id = $1", [pageId])).toBe(3);
    expect(await storedIds(pageId, chat.groupId)).toEqual(chat.messages.map((message) => message.id));
    expect(await hotIds(pageId, chat.groupId)).toEqual(chat.messages.slice(0, 5).map((message) => message.id));
    expect(await rows("select transaction_id from transactions where platform_account_id = $1", [pageId])).toEqual([{ transaction_id: "tx-1" }]);
    expect(await count(
      "select count(*)::int as n from sync_work where page_id = $1 and resource in ('dm-messages.head', 'transactions.head') and state = 'running'",
      [pageId],
    )).toBe(0);
  }, 90_000);

  it("a fan erased before the read: the chat's old messages never come back, what the fan wrote after the erasure does", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    const erased = chats.add({ count: 6, ageMs: 30 * DAY });
    const bystander = chats.add({ count: 4, ageMs: 30 * DAY });
    await seedChatThread(handles(), pageId, erased, { stored: erased.messages, chain: true });
    await seedChatThread(handles(), pageId, bystander, { stored: bystander.messages, chain: true });
    const old = erased.messages.map((message) => message.id);

    await eraseFan(erased.fanRef);
    expect(await count("select count(*)::int as n from page_dm_threads where platform_conversation_id = $1", [erased.groupId])).toBe(0);

    // The fan writes again; the chat is found again (as the list or `.find`
    // would recreate it) and the socket asks for the new message.
    const afterMs = Date.now() + 2_000;
    const [fresh] = chats.append(erased.groupId, 1, "fan", afterMs);
    const bystanderNew = chats.append(bystander.groupId, 2, "fan", afterMs);
    await seedChatThread(handles(), pageId, erased);
    await headDemand(pageId, erased, [fresh!.id]);
    await headDemand(pageId, bystander, [bystanderNew.at(-1)!.id]);
    const scripted = transport(chats);
    const made = await makeTestActor({ db: db(), pageId, mode: "live", registry: registry(), transport: scripted, settingMs: 1 });
    await runActorUntil(made, async () => (await count(
      "select count(*)::int as n from sync_work where page_id = $1 and resource = 'dm-messages.head' and state = 'done'", [pageId],
    )) === 2, 30_000, "both heads read");

    // The vendor served all seven; only the one written after the erasure is kept.
    expect(scripted.hits.map((hit) => hit.spec)).toEqual(["messages.page", "messages.page"]);
    expect(await storedIds(pageId, erased.groupId)).toEqual([fresh!.id]);
    // Events of every type (received, material observed) name the new message only.
    expect(await rows("select distinct message_ref from domain_events where account_id = $1 and conversation_ref = $2", [pageId, erased.groupId]))
      .toEqual([{ message_ref: fresh!.id }]);
    expect(await rows("select message_ref from message_archive where account_id = $1 and conversation_ref = $2", [pageId, erased.groupId]))
      .toEqual([{ message_ref: fresh!.id }]);
    expect(await count(
      "select count(*)::int as n from page_dm_messages where platform_account_id = $1 and platform_message_id = any($2::text[])", [pageId, old],
    )).toBe(0);
    // The bystander's chat is untouched by the fence.
    expect(await storedIds(pageId, bystander.groupId)).toEqual(bystander.messages.map((message) => message.id));
    const bystanderNewIds = new Set(bystanderNew.map((message) => message.id));
    expect(await hotIds(pageId, bystander.groupId))
      .toEqual(bystander.messages.filter((message) => !bystanderNewIds.has(message.id)).map((message) => message.id));
  }, 90_000);

  it("a read captured before the erasure and applied after it: the restarted actor brings nothing back and reads nothing again", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage();
    const chats = new FakeChats();
    const erased = chats.add({ count: 8, ageMs: 30 * DAY });
    await seedChatThread(handles(), pageId, erased, { stored: erased.messages.slice(0, 3), chain: true });
    await headDemand(pageId, erased, [erased.messages[7]!.id]);
    const scripted = transport(chats);

    // The process dies between the capture and the apply.
    const dying = await makeTestActor({
      db: db(), pageId, mode: "live", registry: registry(), transport: scripted, settingMs: 1,
      faults: (point) => {
        if (point === "after_capture") throw new SyncCrashFault(point);
      },
    });
    await expect(dying.actor.run({ stop: dying.stop.signal, abort: dying.abort.signal })).rejects.toBeInstanceOf(SyncCrashFault);
    expect(await rows("select apply_state from sync_attempts where page_id = $1", [pageId])).toEqual([{ apply_state: "captured" }]);
    const [captured] = await rows<{ observation_id: string }>("select observation_id::text from sync_attempts where page_id = $1", [pageId]);

    await eraseFan(erased.fanRef);

    // The restart recovers and drains every pending apply; nothing is left.
    const restarted = await makeTestActor({ db: db(), pageId, mode: "live", registry: registry(), transport: scripted, settingMs: 1 });
    await runActorUntil(restarted, async () => (await count(
      "select count(*)::int as n from sync_attempts where page_id = $1 and apply_state in ('captured', 'deferred')", [pageId],
    )) === 0, 30_000, "no pending apply");
    expect(scripted.hits).toHaveLength(1);
    expect(await count("select count(*)::int as n from page_dm_messages where platform_account_id = $1", [pageId])).toBe(0);
    expect(await count("select count(*)::int as n from domain_events where account_id = $1 and conversation_ref = $2", [pageId, erased.groupId])).toBe(0);
    expect(await count("select count(*)::int as n from message_archive where account_id = $1", [pageId])).toBe(0);
    // The erasure took the chat's journal and its engine rows with it.
    expect(await count("select count(*)::int as n from observations where id = $1", [captured!.observation_id])).toBe(0);
    expect(await count("select count(*)::int as n from sync_work where page_id = $1 and subject = $2", [pageId, erased.groupId])).toBe(0);
  }, 90_000);
});

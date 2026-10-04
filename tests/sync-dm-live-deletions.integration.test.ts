import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendDomainEventsInTransaction,
  applyMessageEventsToArchive,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  getSyncPage,
  listDomainEventsByDedupKeys,
  setPageHold,
  upsertDemand,
  upsertPageDmMessages,
  type Database,
} from "@agency_hub_core/db";

import { applyFanslyWsLive } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { ApplyQuarantine } from "../apps/runtime/src/sync/engine/commit.ts";
import { createEngineRegistry, type EngineRegistry, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { DM_LIVE_DELETIONS_OVERFLOW_BATCH } from "../apps/runtime/src/sync/fansly/resources/dm-live.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, seedWsThread, wsCreated, wsDeleted, wsMessage, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { runActorUntil, until } from "./helpers/sync-engine.ts";
import {
  makeTestActor,
  quietLogger,
  RecordingMetrics,
  ScriptedLiveTransport,
  setModeDirect,
  testSpec,
} from "./helpers/sync-engine-host.ts";

// `dm-live.deletions` on a live page (step-3 design §3.3 item 4, G5, E6, E7):
// a socket deletion acked by the step-1 apply (overlay mark + the post-ack
// hook's demand) reaches the hot table, the event ledger and the archive in
// one `local` step of the actor — no request, before the HTTP gate, so no page
// hold or pacer slot delays it (step 3b ruling 9) — under the erasure fence, and
// the stored window of the thread is recounted from the archive by the
// engine's own writer (step 4, S4-08; head and chain untouched). Sticky against a late create frame and a later
// REST copy; an erasure-fenced fan gets nothing written; on a page the engine
// does not own the hook routes nothing.

const OWN = "300000000000000071";
const FAN = "510000000000000071";
const GROUP = "620000000000000071";

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

const app = () => ({ db: db(), logger: quietLogger as never });

async function scalar(text: string, values: unknown[] = []): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>(text, values);
  return Number(result.rows[0]?.n ?? 0);
}

interface Stored {
  page: WsCapturePage;
  threadId: number;
  /** Fan message, then the page's reply, then a second fan message. */
  ids: [string, string, string];
  at: [Date, Date, Date];
}

/** A live page with one bound chat of three stored messages — in the hot
 *  table and in the archive, as the engine's DM apply writes them — and the
 *  window over them; the head is the newest. */
async function seedLivePage(mode: "live" | "off" | "shadow" = "live", label?: string): Promise<Stored> {
  const handles = { db: db(), pool: testDb!.pool };
  const page = await seedWsCapturePage(handles, { ownRef: OWN, ...(label === undefined ? {} : { label }) });
  if (mode !== "off") await setModeDirect(testDb!.pool, page.pageId, mode);
  const threadId = await seedWsThread(handles, { pageId: page.pageId, groupId: GROUP, fanRef: FAN });
  const base = Date.now() - 3_600_000;
  const ids: [string, string, string] = [String(910_000_000_000_100_001n), String(910_000_000_000_100_002n), String(910_000_000_000_100_003n)];
  const at: [Date, Date, Date] = [new Date(base), new Date(base + 60_000), new Date(base + 120_000)];
  const roles = ["fan", "model", "fan"] as const;
  await upsertPageDmMessages(db(), ids.map((id, index) => ({
    conversationId: threadId,
    platformAccountId: page.pageId,
    platformMessageId: id,
    senderPlatformUserId: roles[index] === "fan" ? FAN : OWN,
    senderRole: roles[index]!,
    createdAt: at[index]!,
    content: `message ${id}`,
    totalTipAmountCents: 0,
    inReplyToMessageId: null,
    inReplyToRootMessageId: null,
  })));
  for (const [index, id] of ids.entries()) {
    await testDb!.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role,
         is_sent_by_me, occurred_at, text_plain)
       values ($1, 'fansly', $2, $3, $4, $5, $6, $7, $8)`,
      [page.pageId, GROUP, id, FAN, roles[index], roles[index] === "model", at[index], `message ${id}`],
    );
  }
  await testDb!.pool.query(
    `update page_dm_threads
        set stored_message_count = 3, newest_stored_message_id = $2, oldest_stored_message_id = $3,
            last_fan_message_at = $4, last_model_message_at = $5, last_message_id = $2, last_message_at = $4,
            message_coverage_status = 'partial_window', head_confirmed_id = null
      where id = $1`,
    [threadId, ids[2], ids[0], at[2], at[1]],
  );
  return { page, threadId, ids, at };
}

/** A deletion frame as the receiver captures it, applied and acked by the
 *  step-1 driver with the production post-ack hook. */
async function deleteFrame(page: WsCapturePage, messageId: string, groupId: string | null = GROUP): Promise<number> {
  const observationId = await page.capture(wsDeleted(messageId, groupId));
  const result = await applyFanslyWsLive(app(), observationId);
  expect(result?.status).toBe("applied");
  return observationId;
}

function deletionsRegistry(): EngineRegistry {
  return createEngineRegistry([fanslyResourceSpec("dm-live.deletions")!]);
}

async function work(pageId: number, subject = GROUP) {
  const result = await testDb!.pool.query<{
    id: string; state: string; close_reason: string | null; message_ids: string[];
    waiting_reason: string | null; last_error_class: string | null;
  }>(
    `select id::text, state, close_reason, demand->'messageIds' as message_ids, waiting_reason, last_error_class from sync_work
      where page_id = $1 and not shadow and resource = 'dm-live.deletions' and subject = $2 order by id desc limit 1`,
    [pageId, subject],
  );
  return result.rows[0] ?? null;
}

async function runDeletions(
  pageId: number,
  metrics = new RecordingMetrics(),
  subject = GROUP,
  options: { floorDelayMs?: number } = {},
): Promise<ScriptedLiveTransport> {
  const transport = new ScriptedLiveTransport();
  const made = await makeTestActor({
    db: db(), pageId, registry: deletionsRegistry(), transport, metrics, ownRef: OWN, ...options,
  });
  await runActorUntil(made, async () => (await work(pageId, subject))?.state === "done", 20_000, "the deletions carried");
  return transport;
}

async function hotRow(pageId: number, messageId: string) {
  const result = await testDb!.pool.query<{ deleted_at: Date | null }>(
    "select deleted_at from page_dm_messages where platform_account_id = $1 and platform_message_id = $2",
    [pageId, messageId],
  );
  return result.rows[0] ?? null;
}

async function overlayDeletedAt(pageId: number, messageId: string): Promise<Date | null> {
  const result = await testDb!.pool.query<{ deleted_at: Date | null }>(
    "select deleted_at from dm_live_messages where page_id = $1 and platform_message_id = $2", [pageId, messageId],
  );
  return result.rows[0]?.deleted_at ?? null;
}

async function archiveRow(pageId: number, messageId: string) {
  const result = await testDb!.pool.query<{ deleted_at: Date | null; content_pending: boolean; text_plain: string | null }>(
    "select deleted_at, content_pending, text_plain from message_archive where account_id = $1 and platform = 'fansly' and message_ref = $2",
    [pageId, messageId],
  );
  return result.rows[0] ?? null;
}

async function threadWindow(threadId: number) {
  const result = await testDb!.pool.query<{
    stored_message_count: number;
    newest_stored_message_id: string | null;
    oldest_stored_message_id: string | null;
    last_fan_message_at: Date | null;
    last_model_message_at: Date | null;
    last_message_id: string | null;
    message_coverage_status: string;
    head_confirmed_id: string | null;
    history_state: string;
  }>(
    `select stored_message_count, newest_stored_message_id, oldest_stored_message_id, last_fan_message_at,
            last_model_message_at, last_message_id, message_coverage_status::text, head_confirmed_id, history_state
       from page_dm_threads where id = $1`,
    [threadId],
  );
  return result.rows[0]!;
}

async function deletedEvents(pageId: number): Promise<Array<{ message_ref: string; dedup_key: string; observation_id: string }>> {
  const result = await testDb!.pool.query<{ message_ref: string; dedup_key: string; observation_id: string }>(
    `select message_ref, dedup_key, observation_id::text from domain_events
      where account_id = $1 and type = 'message.deleted' order by message_ref`,
    [pageId],
  );
  return result.rows;
}

describe("dm-live.deletions on a live page", () => {
  it("a stored message: the hot mark, one message.deleted, the archive tombstone and the recomputed window — no request; sticky against a late create and a later REST copy", async (context) => {
    if (!testDb) return context.skip();
    const { page, threadId, ids, at } = await seedLivePage();
    const before = await threadWindow(threadId);
    const observationId = await deleteFrame(page, ids[2]);
    // The ack routed the deletion (I18): urgent, no request.
    expect(await work(page.pageId)).toMatchObject({ state: "open", message_ids: [ids[2]] });

    const metrics = new RecordingMetrics();
    const transport = await runDeletions(page.pageId, metrics);
    expect(transport.hits).toEqual([]);
    expect(await scalar("select count(*)::int as n from sync_attempts where page_id = $1", [page.pageId])).toBe(0);
    expect(await work(page.pageId)).toMatchObject({ state: "done", close_reason: "ws_deletions_applied" });

    const deletedAt = await overlayDeletedAt(page.pageId, ids[2]);
    expect(deletedAt).not.toBeNull();
    expect((await hotRow(page.pageId, ids[2]))!.deleted_at).toEqual(deletedAt);
    expect((await hotRow(page.pageId, ids[1]))!.deleted_at).toBeNull();
    expect(await deletedEvents(page.pageId)).toEqual([
      { message_ref: ids[2], dedup_key: `msg-deleted:fansly:${ids[2]}`, observation_id: String(observationId) },
    ]);
    // The archive's copy is tombstoned, its content kept.
    expect(await archiveRow(page.pageId, ids[2])).toMatchObject({ content_pending: false, text_plain: `message ${ids[2]}` });
    expect((await archiveRow(page.pageId, ids[2]))!.deleted_at).not.toBeNull();
    // The stored window, recounted from the archive, without the deleted fan
    // message; the head is the list's, the chain is not touched.
    const after = await threadWindow(threadId);
    expect(after).toEqual({
      ...before,
      stored_message_count: 2,
      newest_stored_message_id: ids[1],
      oldest_stored_message_id: ids[0],
      last_fan_message_at: at[0],
      last_model_message_at: at[1],
    });

    // A late create frame of the same message: the overlay mark is sticky.
    const late = await page.capture(wsCreated(wsMessage({ id: ids[2], groupId: GROUP, senderId: FAN })));
    await applyFanslyWsLive(app(), late);
    expect(await overlayDeletedAt(page.pageId, ids[2])).toEqual(deletedAt);
    // A later REST copy of the message: neither the hot row nor the archive
    // loses its mark.
    await upsertPageDmMessages(db(), [{
      conversationId: threadId, platformAccountId: page.pageId, platformMessageId: ids[2], senderPlatformUserId: FAN,
      senderRole: "fan", createdAt: at[2], content: `message ${ids[2]}`, totalTipAmountCents: 0,
      inReplyToMessageId: null, inReplyToRootMessageId: null,
    }]);
    expect((await hotRow(page.pageId, ids[2]))!.deleted_at).toEqual(deletedAt);
    await db().transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const key = `test:received:${ids[2]}`;
      await appendDomainEventsInTransaction(tx, page.pageId, [{
        type: "message.received", occurredAt: at[2], fanIdentityRef: FAN, conversationRef: GROUP, messageRef: ids[2],
        data: { text: `message ${ids[2]}`, price: 0, isTip: false }, schemaVersion: 1, observationId, dedupKey: key,
      }]);
      await applyMessageEventsToArchive(tx, {
        accountId: page.pageId, platform: "fansly", events: await listDomainEventsByDedupKeys(tx, page.pageId, [key]),
      });
    });
    const archived = await archiveRow(page.pageId, ids[2]);
    expect(archived).toMatchObject({ content_pending: false, text_plain: `message ${ids[2]}` });
    expect(archived!.deleted_at).not.toBeNull();
  }, 60_000);

  it("a hot row marked before (the retired receipt reconcile's mark): the window, the ledger and the archive still get the deletion", async (context) => {
    if (!testDb) return context.skip();
    const { page, threadId, ids, at } = await seedLivePage();
    await deleteFrame(page, ids[0]);
    const reconciledAt = new Date(Date.now() - 1_000);
    await testDb.pool.query(
      "update page_dm_messages set deleted_at = $3 where platform_account_id = $1 and platform_message_id = $2",
      [page.pageId, ids[0], reconciledAt],
    );
    const metrics = new RecordingMetrics();
    await runDeletions(page.pageId, metrics);
    // The earlier mark stays; the window and the stores follow.
    expect((await hotRow(page.pageId, ids[0]))!.deleted_at).toEqual(reconciledAt);
    expect(await threadWindow(threadId)).toMatchObject({
      stored_message_count: 2,
      newest_stored_message_id: ids[2],
      oldest_stored_message_id: ids[1],
      last_fan_message_at: at[2],
    });
    expect((await deletedEvents(page.pageId)).map((event) => event.message_ref)).toEqual([ids[0]]);
    expect((await archiveRow(page.pageId, ids[0]))!.deleted_at).not.toBeNull();
    expect(metrics.get("sync_apply_effect")).toBeGreaterThan(0);
  }, 60_000);

  it("a message the archive does not hold yet: a tombstone-first stub, and the window that never counted it stays", async (context) => {
    if (!testDb) return context.skip();
    const { page, threadId } = await seedLivePage();
    const inFlight = String(910_000_000_000_100_004n);
    await upsertPageDmMessages(db(), [{
      conversationId: threadId, platformAccountId: page.pageId, platformMessageId: inFlight, senderPlatformUserId: FAN,
      senderRole: "fan", createdAt: new Date(), content: "in flight", totalTipAmountCents: 0,
      inReplyToMessageId: null, inReplyToRootMessageId: null,
    }]);
    const before = await threadWindow(threadId);
    await deleteFrame(page, inFlight);
    const metrics = new RecordingMetrics();
    await runDeletions(page.pageId, metrics);
    // The hot copy is marked; the archive gets the stub carrying the tombstone
    // (a later REST copy hydrates it and keeps the mark).
    expect((await hotRow(page.pageId, inFlight))!.deleted_at).not.toBeNull();
    expect(await archiveRow(page.pageId, inFlight)).toMatchObject({ content_pending: true, text_plain: "" });
    expect((await archiveRow(page.pageId, inFlight))!.deleted_at).not.toBeNull();
    expect(await threadWindow(threadId)).toEqual(before);
  }, 60_000);

  it("an erasure-fenced fan: nothing is written, the work closes", async (context) => {
    if (!testDb) return context.skip();
    const { page, threadId, ids } = await seedLivePage();
    await deleteFrame(page, ids[0]);
    const user = await testDb.pool.query<{ id: string }>(
      "insert into users (username, password_hash, role) values ('owner-dm-live', 'x', 'owner') returning id::text as id",
    );
    await testDb.pool.query(
      "insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan) values ('fan', $1, $2, false, '{}'::jsonb)",
      [`fan:fansly:${FAN}`, Number(user.rows[0]!.id)],
    );
    const before = await threadWindow(threadId);
    await runDeletions(page.pageId);
    expect(await work(page.pageId)).toMatchObject({ state: "done" });
    expect((await hotRow(page.pageId, ids[0]))!.deleted_at).toBeNull();
    expect(await deletedEvents(page.pageId)).toEqual([]);
    expect((await archiveRow(page.pageId, ids[0]))!.deleted_at).toBeNull();
    expect(await threadWindow(threadId)).toEqual(before);
  }, 60_000);

  it("an overflowed demand carries the chat's deletions not carried yet; a frame naming no chat is carried by message id", async (context) => {
    if (!testDb) return context.skip();
    const { page, threadId, ids } = await seedLivePage();
    await deleteFrame(page, ids[0]);
    await deleteFrame(page, ids[2]);
    // More ids than the demand keeps: the row says only "overflow".
    await testDb.pool.query(
      `update sync_work set demand = jsonb_set(jsonb_set(demand, '{messageIds}', '[]'::jsonb), '{overflow}', 'true'::jsonb)
        where page_id = $1 and resource = 'dm-live.deletions' and subject = $2`,
      [page.pageId, GROUP],
    );
    await runDeletions(page.pageId);
    expect((await hotRow(page.pageId, ids[0]))!.deleted_at).not.toBeNull();
    expect((await hotRow(page.pageId, ids[2]))!.deleted_at).not.toBeNull();
    expect((await deletedEvents(page.pageId)).map((event) => event.message_ref)).toEqual([ids[0], ids[2]]);
    expect(await threadWindow(threadId)).toMatchObject({ stored_message_count: 1, newest_stored_message_id: ids[1] });
    expect(DM_LIVE_DELETIONS_OVERFLOW_BATCH).toBeGreaterThan(200);

    // A deletion frame without its chat: subject '', carried by the id.
    await deleteFrame(page, ids[1], null);
    expect(await work(page.pageId, "")).toMatchObject({ state: "open", message_ids: [ids[1]] });
    await runDeletions(page.pageId, new RecordingMetrics(), "");
    expect((await hotRow(page.pageId, ids[1]))!.deleted_at).not.toBeNull();
    expect(await threadWindow(threadId)).toMatchObject({ stored_message_count: 0, newest_stored_message_id: null });
    const events = await testDb.pool.query<{ conversation_ref: string | null }>(
      "select conversation_ref from domain_events where account_id = $1 and type = 'message.deleted' and message_ref = $2",
      [page.pageId, ids[1]],
    );
    expect(events.rows).toEqual([{ conversation_ref: null }]);
  }, 60_000);

  it.each([
    ["auth", "infinity"],
    ["identity_mismatch", "infinity"],
    ["rate_limit", 120_000],
    ["network", 60_000],
  ] as const)("a %s page hold delays requests only: the deletion is carried under it, and the hold stays (ruling 9)", async (kind, forMs) => {
    if (!testDb) return;
    const { page, threadId, ids } = await seedLivePage("live", `ws-hold-${kind.replace("_", "-")}`);
    await deleteFrame(page, ids[2]);
    await setPageHold(db(), {
      pageId: page.pageId,
      kind,
      until: forMs === "infinity" ? "infinity" : new Date(Date.now() + forMs),
      step: 1,
      detail: {},
    });
    const metrics = new RecordingMetrics();
    const transport = await runDeletions(page.pageId, metrics);
    expect(transport.hits).toEqual([]);
    expect(await work(page.pageId)).toMatchObject({ state: "done", close_reason: "ws_deletions_applied" });
    expect((await hotRow(page.pageId, ids[2]))!.deleted_at).not.toBeNull();
    expect((await deletedEvents(page.pageId)).map((event) => event.message_ref)).toEqual([ids[2]]);
    expect((await archiveRow(page.pageId, ids[2]))!.deleted_at).not.toBeNull();
    expect(await threadWindow(threadId)).toMatchObject({ stored_message_count: 2, newest_stored_message_id: ids[1] });
    expect(metrics.get("sync_steps_before_gate")).toBe(1);
    expect((await getSyncPage(db(), page.pageId))!.holdKind).toBe(kind);
  }, 30_000);

  it("the pacer's closed slot does not delay it: carried while the takeover floor keeps the first request a minute away", async (context) => {
    if (!testDb) return context.skip();
    const { page, ids } = await seedLivePage("live", "ws-pacer");
    await deleteFrame(page, ids[0]);
    const transport = await runDeletions(page.pageId, new RecordingMetrics(), GROUP, { floorDelayMs: 60_000 });
    expect(transport.hits).toEqual([]);
    expect((await hotRow(page.pageId, ids[0]))!.deleted_at).not.toBeNull();
  }, 30_000);

  it.each(["off", "shadow"] as const)("an %s page: the post-ack hook routes nothing and no store is marked", async (mode) => {
    if (!testDb) return;
    const { page, ids } = await seedLivePage(mode, `ws-${mode}`);
    await deleteFrame(page, ids[0]);
    expect(await overlayDeletedAt(page.pageId, ids[0])).not.toBeNull();
    expect(await scalar("select count(*)::int as n from sync_work where page_id = $1 and not shadow", [page.pageId])).toBe(0);
    expect((await hotRow(page.pageId, ids[0]))!.deleted_at).toBeNull();
    expect(await deletedEvents(page.pageId)).toEqual([]);
  }, 30_000);

  it("a busy erasure fence: the step waits on its dependency and writes nothing; it is carried once the erasure is done", async (context) => {
    if (!testDb) return context.skip();
    const { page, ids } = await seedLivePage();
    await deleteFrame(page, ids[0]);
    // An erasure in flight holds the fence exclusively.
    const erasure = await testDb.pool.connect();
    await erasure.query("begin");
    await erasure.query("select pg_advisory_xact_lock($1, $2)", [DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, page.pageId]);
    let waited: { waiting_reason: string | null; last_error_class: string | null } | null = null;
    const release = (async () => {
      try {
        await until(async () => (await work(page.pageId))?.last_error_class === "local:erasure_busy", 10_000, "the busy fence");
        waited = await work(page.pageId);
        expect((await hotRow(page.pageId, ids[0]))!.deleted_at).toBeNull();
      } finally {
        await erasure.query("rollback");
        erasure.release();
      }
    })();
    await runDeletions(page.pageId);
    await release;
    expect(waited).toMatchObject({ state: "open", waiting_reason: "dependency", last_error_class: "local:erasure_busy" });
    expect((await hotRow(page.pageId, ids[0]))!.deleted_at).not.toBeNull();
    expect(await work(page.pageId)).toMatchObject({ state: "done" });
  }, 30_000);

  it.each(["off", "shadow"] as const)("a local step writes only on a live page: an actor leaves an %s page before any module runs", async (mode) => {
    if (!testDb) return;
    const { page } = await seedLivePage(mode, `ws-local-${mode}`);
    const ran: string[] = [];
    const module: ResourceModule = {
      plan: async () => {
        ran.push("planned");
        return { kind: "local", reason: "test" };
      },
      applyLocal: async () => {
        ran.push("written");
        return { work: { satisfiesRevision: true, close: "done" }, followups: [] };
      },
      apply: async () => {
        throw new Error("no request");
      },
    };
    await upsertDemand(db(), { pageId: page.pageId, resource: "local.test", kind: "trigger", class: "urgent" });
    const { actor, stop, abort } = await makeTestActor({
      db: db(), pageId: page.pageId, registry: createEngineRegistry([testSpec("local.test", module, { http: false })]),
    });
    expect(await actor.run({ stop: stop.signal, abort: abort.signal })).toEqual({ kind: "mode_changed", mode });
    expect(ran).toEqual([]);
    expect((await testDb.pool.query<{ state: string; waiting_reason: string | null; last_error_class: string | null }>(
      "select state, waiting_reason, last_error_class from sync_work where page_id = $1 and resource = 'local.test'", [page.pageId],
    )).rows).toEqual([{ state: "open", waiting_reason: null, last_error_class: null }]);
  }, 30_000);

  it("a local step whose write is refused for good is quarantined, and the quarantine records why, as an apply's does", async (context) => {
    if (!testDb) return context.skip();
    const { page } = await seedLivePage("live", "ws-local-quarantine");
    const module: ResourceModule = {
      plan: async () => ({ kind: "local", reason: "test" }),
      applyLocal: async () => {
        throw new ApplyQuarantine("row_refused", { messageId: "910000000000100009" });
      },
      apply: async () => {
        throw new Error("no request");
      },
    };
    await upsertDemand(db(), { pageId: page.pageId, resource: "local.test", kind: "trigger", class: "urgent" });
    const transport = new ScriptedLiveTransport();
    const made = await makeTestActor({
      db: db(), pageId: page.pageId, transport, ownRef: OWN,
      registry: createEngineRegistry([testSpec("local.test", module, { http: false })]),
    });
    const row = async () => (await testDb!.pool.query<{
      state: string; last_error_class: string | null; quarantine: Record<string, unknown> | null;
    }>(
      `select state, last_error_class, result->'quarantine' as quarantine from sync_work
        where page_id = $1 and not shadow and resource = 'local.test'`, [page.pageId],
    )).rows[0] ?? null;
    await runActorUntil(made, async () => (await row())?.state === "quarantined", 10_000, "the quarantine");
    expect(await row()).toMatchObject({
      state: "quarantined",
      last_error_class: "local:quarantine:row_refused",
      quarantine: {
        reason: "local:quarantine:row_refused",
        detail: { messageId: "910000000000100009", refusal: "row_refused" },
        attemptId: null,
      },
    });
    expect(transport.hits).toEqual([]);
  }, 30_000);
});

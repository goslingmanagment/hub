import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireTargetedPageSyncLease, countConversationSyncFailuresByAccount, ensurePageSyncStates,
  getConversationSyncHealth, getPageDmConversationById, getPageSyncState, recordConversationSyncFailure,
  requestPageSync, runWithPageSyncExecutionContext, selectNextPageDmMessageSyncCandidate, startSyncRun,
  upsertFans, upsertPageDmConversation, upsertPageDmMessages,
} from "@agency_hub_core/db";
import { executeObservedRequest, resolveFanslyWsHintPolicy,
  type HttpRequestObserver, type HttpRequestFailureKind } from "@agency_hub_core/shared";
import { FanslyApiError, type FanslyMessage, type FanslyRequestContext } from "@agency_hub_core/fansly";
import { resetIntegrationDatabase, seedFanslyPage, startTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fakeTelemetry } from "./helpers/fansly-dm-sweep.ts";
import { fileFanslyWsHintReceipt } from "./helpers/fansly-ws-hint-receipts.ts";
import { saveProxy, resolvePageContext } from "../apps/runtime/src/services/page-context.ts";
import { readProbeGeneration } from "../apps/runtime/src/services/egress/fansly-probe-context.ts";
import { runFanslyWsHintStep } from "../apps/runtime/src/services/sync/fansly-ws-hints.ts";
import { fanslyDmMessagesChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";

let db: StartedTestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

function failRequest(context: FanslyRequestContext, error: Error, failureKind: HttpRequestFailureKind = "transport") {
  return executeObservedRequest<never, never>({
    observer: context.requestObserver ?? null, requestId: randomUUID(), operation: "messages",
    endpointTemplate: "/message", method: "GET", retries: 0,
    execute: async () => { throw error; },
    onTransportError: () => ({ kind: "failed", failureKind, error }),
    onResponse: () => { throw new Error("unexpected response"); },
  });
}

async function fixture(routeInitial = true) {
  const app = createTestAppContext(db, { syncSharedRateLimitEnabled: true });
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey);
  if (!page) throw new Error("page missing");
  await db.pool.query("update pages set external_page_id='999' where id=$1", [page.id]);
  await saveProxy(app, page.id, { url: "http://proxy.example.test:8080", username: "test", password: "test" });
  const generation = await readProbeGeneration(app.db, page.label);
  Object.assign(app.config, {
    fanslyWsCaptureEnabled: true, fanslyWsCapturePageAllowlist: page.label,
    fanslyWsHintsEnabled: true, fanslyWsHintsPageAllowlist: page.label,
    fanslyWsHintsTypeAllowlist: "message_created,group_created",
    fanslyWsHintsPolicies: JSON.stringify({ [page.label]: {
      generation, activationAt: "2026-01-01T00:00:00Z", baselineAttempts24h: 1000, baselineReference: "fixture",
    } }),
  });
  const policy = resolveFanslyWsHintPolicy(app.config, page.label)!;
  const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: "111" }]);
  const thread = await upsertPageDmConversation(app.db, {
    platformAccountId: page.id, fanId: fan!.id, platformConversationId: "100",
    partnerPlatformUserId: "111", partnerUsername: null, partnerDisplayName: null,
    conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
    lastMessageId: "150", lastUnreadMessageId: null, lastMessageAt: new Date("2026-09-15T01:00:00Z"),
    lastMessageSenderId: "111", lastMessageSenderRole: "fan", lastMessagePreview: "head",
    messageCoverageStatus: "complete", newestStoredMessageId: "100", oldestStoredMessageId: "100",
    storedMessageCount: 1, lastMessageSyncAt: new Date("2026-01-01"), isVisible: true, lastSeenGeneration: 1, metadata: {},
  });
  if (!thread) throw new Error("thread missing");
  await upsertPageDmMessages(app.db, [{
    conversationId: thread.id, platformAccountId: page.id, platformMessageId: "100",
    senderPlatformUserId: "111", senderRole: "fan", createdAt: new Date("2026-09-15T00:00:00Z"),
    content: "original boundary", totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
  }]);
  const route = (id = 1, groupRef = "100", messageRef = "150") => fileFanslyWsHintReceipt(db.pool, {
    id, pageId: page.id, observationId: id, receivedAt: new Date(), generation,
    node: { path: [], outcome: "hint", hint: { type: "message_created", groupRef, messageRef } },
  }, policy);
  if (routeInitial) await route();
  await ensurePageSyncStates(app.db, { pageId: page.id });
  const lease = await acquireTargetedPageSyncLease(app.db, {
    pageId: page.id, stream: "dm_messages", workerId: "b1-test", leaseToken: randomUUID(), leaseTtlMs: 120_000,
  });
  if (!lease) throw new Error("lease missing");
  const run = await startSyncRun(app.db, { platformAccountId: page.id, stream: "dm_messages", trigger: "scheduled" });
  const pageContext = await resolvePageContext(app, page.label);
  const telemetry = { ...fakeTelemetry(), getRequestObserver: (): HttpRequestObserver => ({ onRequestEvent: async () => {} }),
    recordDmMessagesChunkSummary: vi.fn(async () => {}) };
  const calls: string[] = [];
  const physical = async (context: FanslyRequestContext, operation: string) => {
    await context.requestObserver?.onRequestEvent({ state: "started", requestId: randomUUID(), operation,
      endpointTemplate: "/message", method: "GET", attemptNumber: 1, timestamp: new Date(), pagination: null, rateLimitWaitMs: null });
    calls.push(operation);
  };
  const messages = Array.from({ length: 51 }, (_, index) => ({
    id: String(150 - index), groupId: "100", senderId: "111", content: `m-${150 - index}`,
    createdAt: Date.parse("2026-09-15T00:00:00Z") + (150 - index) * 1000,
  } as FanslyMessage));
  app.adapter.getMessagesPage = vi.fn(async (context, params) => {
    await physical(context, "messages");
    const start = params.before ? messages.findIndex(message => message.id === params.before) + 1 : 0;
    const items = messages.slice(start, start + (params.limit ?? 25));
    return { items, raw: { messages: items }, groupId: params.groupId, before: params.before ?? null, done: items.length < (params.limit ?? 25) };
  });
  app.adapter.getGroupDetail = vi.fn(async (context, _groupId) => {
    await physical(context, "group_detail");
    throw new FanslyApiError("gone", 404);
  });
  const input = (source = "scheduled", hintOnly = false) => ({
    pageContext, syncRunId: run!.id, budget: new SyncChunkBudget(5), telemetry,
    streamState: { ...lease, dispatchSource: source, requestPayload: { fanslyWsHintOnly: hintOnly } },
  });
  const execution = { ...lease, fetchSeq: 0 };
  const owned = <T>(action: () => Promise<T>) => runWithPageSyncExecutionContext(execution, action);
  const step = () => owned(() => runFanslyWsHintStep(app, input() as never));
  const due = () => db.pool.query("update subject_refresh_state set next_due_at=now(),retry_after_at=null where page_id=$1", [page.id]);
  return { app, page, thread, policy, lease, route, calls, physical, messages, input, owned, step, due };
}

describe("B1 REST execution and rollback", () => {
  async function deletion(f: Awaited<ReturnType<typeof fixture>>, changes: {
    groupRef?: string | null; generation?: string; receivedAt?: Date; bulk?: boolean;
  } = {}) {
    await fileFanslyWsHintReceipt(db.pool, {
      id: 900, pageId: f.page.id, observationId: 900,
      generation: changes.generation ?? f.policy.generation, receivedAt: changes.receivedAt ?? new Date(),
      node: { path: [], outcome: "mutation_debt", mutation: {
        messageRef: "150", groupRef: changes.groupRef === undefined ? "100" : changes.groupRef,
        correlationRef: "12345", bulk: changes.bulk ?? false,
      } },
    }, f.policy);
  }
  it.each([false, true])("settles an exact deleted target (bulk=%s) without claiming hot materialization", async bulk => {
    const f = await fixture();
    f.messages.shift();
    await deletion(f, { bulk });
    await deletion(f, { bulk }); // receipt replay is idempotent
    await f.step();
    expect((await db.pool.query("select applied_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].applied_revision).toBe(0n);
    await f.due(); await f.step();
    await f.due(); await f.step();
    expect((await db.pool.query("select applied_revision,requested_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toMatchObject({ applied_revision: 1n, requested_revision: 1n });
    const receipt = (await db.pool.query("select * from fansly_ws_hint_status where event_id=1")).rows[0];
    expect(receipt).toMatchObject({ settlement_kind: "source_deleted", settlement_observation_id: 900n, hot_applied_at: null });
    expect(receipt.settled_at).toBeInstanceOf(Date);
    expect((await db.pool.query("select settled_at,outcome from fansly_ws_hint_receipts where event_id=900")).rows[0])
      .toEqual({ settled_at: null, outcome: "mutation_debt" });
  });
  it.each(["foreign_group", "null_group", "foreign_generation", "older"])("does not settle a target using %s deletion evidence", async kind => {
    const f = await fixture(); f.messages.shift();
    await deletion(f, { groupRef: kind === "foreign_group" ? "200" : kind === "null_group" ? null : "100",
      generation: kind === "foreign_generation" ? "b".repeat(64) : f.policy.generation,
      receivedAt: kind === "older" ? new Date("2026-01-02") : new Date() });
    for (let n = 0; n < 3; n++) { await f.due(); await f.step(); }
    expect((await db.pool.query("select applied_revision,last_refresh_outcome from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toMatchObject({ applied_revision: 0n, last_refresh_outcome: "target_unconfirmed" });
    expect((await db.pool.query("select settled_at from fansly_ws_hint_receipts where event_id=1")).rows[0].settled_at).toBeNull();
  });
  it("records separate deletion and materialization evidence in a mixed revision", async () => {
    const f = await fixture(); f.messages.shift();
    await deletion(f);
    await fileFanslyWsHintReceipt(db.pool, {
      id: 2, pageId: f.page.id, observationId: 2, generation: f.policy.generation, receivedAt: new Date(),
      node: { path: [], outcome: "hint", hint: { type: "message_created", groupRef: "100", messageRef: "149" } },
    }, f.policy);
    for (let n = 0; n < 3; n++) { await f.due(); await f.step(); }
    const receipts = (await db.pool.query("select event_id,settlement_kind,hot_applied_at from fansly_ws_hint_receipts where outcome='routed' order by event_id")).rows;
    expect(receipts[0]).toEqual({ event_id: 1n, settlement_kind: "source_deleted", hot_applied_at: null });
    expect(receipts[1]).toMatchObject({ event_id: 2n, settlement_kind: "rest_materialized" });
    expect(receipts[1].hot_applied_at).toBeInstanceOf(Date);
  });
  it("keeps actual REST materialization authoritative when a delete receipt also exists", async () => {
    const f = await fixture(); await deletion(f);
    for (let n = 0; n < 3; n++) { await f.due(); await f.step(); }
    const receipt = (await db.pool.query("select settlement_kind,hot_applied_at from fansly_ws_hint_receipts where event_id=1")).rows[0];
    expect(receipt.settlement_kind).toBe("rest_materialized");
    expect(receipt.hot_applied_at).toBeInstanceOf(Date);
  });
  it("preserves pre-migration materialization evidence when revisiting old receipts", async () => {
    const f = await fixture();
    for (let n = 0; n < 3; n++) { await f.due(); await f.step(); }
    await db.pool.query("update fansly_ws_hint_receipts set settled_at=null,settlement_kind=null where event_id=1");
    await db.pool.query("update page_dm_messages set deleted_at=now() where platform_message_id='150'");
    f.messages.shift(); await deletion(f);
    await fileFanslyWsHintReceipt(db.pool, {
      id: 2, pageId: f.page.id, observationId: 2, generation: f.policy.generation, receivedAt: new Date(),
      node: { path: [], outcome: "hint", hint: { type: "message_created", groupRef: "100", messageRef: "149" } },
    }, f.policy);
    for (let n = 0; n < 3; n++) { await f.due(); await f.step(); }
    expect((await db.pool.query("select settlement_kind from fansly_ws_hint_receipts where event_id=1")).rows[0].settlement_kind)
      .toBe("rest_materialized");
  });
  it("does not bypass the five-page contiguity limit when a deletion arrives mid-walk", async () => {
    const f = await fixture();
    const prototype = f.messages[0]!;
    f.messages.splice(0, f.messages.length, ...Array.from({ length: 151 }, (_, n) => ({ ...prototype, id: String(250 - n) }))
      .filter(message => message.id !== "150"));
    await f.step(); await deletion(f);
    for (let n = 0; n < 4; n++) { await f.due(); await f.step(); }
    expect((await db.pool.query("select applied_revision,last_refresh_outcome from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toMatchObject({ applied_revision: 0n, last_refresh_outcome: "walk_limit" });
    expect((await db.pool.query("select settled_at from fansly_ws_hint_receipts where event_id=1")).rows[0].settled_at).toBeNull();
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(1);
  });
  it("settles a previously stuck claim when an exact deletion arrives, preserving R+1", async () => {
    const f = await fixture(); f.messages.shift();
    for (let n = 0; n < 3; n++) { await f.due(); await f.step(); }
    await deletion(f);
    const original = f.app.adapter.getMessagesPage;
    f.app.adapter.getMessagesPage = vi.fn(async (context, params) => {
      await f.route(2);
      return original(context, params);
    });
    await f.due(); await f.step();
    const state = (await db.pool.query("select applied_revision,requested_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0];
    expect(state.applied_revision).toBe(1n);
    expect(state.requested_revision).toBe(2n);
    expect((await db.pool.query("select event_id,settlement_kind from fansly_ws_hint_receipts where outcome='routed' order by event_id")).rows)
      .toEqual([{ event_id: 1n, settlement_kind: "source_deleted" }, { event_id: 2n, settlement_kind: null }]);
  });
  it("stages partial pages without hot overlap, then ordinary polling recovers the full gap after off", async () => {
    const f = await fixture();
    await f.step();
    expect(f.calls).toEqual(["messages"]);
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(1);
    expect(await getPageDmConversationById(db.db, f.thread.id)).toMatchObject({ newestStoredMessageId: "100", storedMessageCount: 1 });
    f.app.config.fanslyWsHintsEnabled = false;
    await f.owned(() => fanslyDmMessagesChunk(f.app, f.input() as never));
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(51);
    expect(await getPageDmConversationById(db.db, f.thread.id)).toMatchObject({ newestStoredMessageId: "150" });
  });
  it("applies the whole staged chain atomically only on reaching the original boundary", async () => {
    const f = await fixture();
    await f.step(); await f.due(); await f.step();
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(1);
    await f.due(); await f.step();
    expect(f.calls).toHaveLength(3);
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(51);
    expect((await db.pool.query("select requested_revision,applied_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows)
      .toEqual([{ requested_revision: 1n, applied_revision: 1n }]);
  });
  it("ends the thread's breaker streak when the hint walk reaches its boundary", async () => {
    const f = await fixture();
    // A transient first-page 5xx breakered the thread in the ordinary lane.
    await recordConversationSyncFailure(db.db, {
      conversationId: f.thread.id, platformAccountId: f.page.id, errorClass: "fansly_500",
      errorMessage: "error getting group messages",
    });
    const debt = () => countConversationSyncFailuresByAccount(db.db, { platformAccountIds: [f.page.id] });
    await f.step(); await f.due(); await f.step();
    // Staged pages write nothing to the thread yet.
    expect(await debt()).toEqual([{ platformAccountId: f.page.id, failingConversationCount: 1 }]);
    await f.due(); await f.step();
    expect(f.calls).toHaveLength(3);
    expect(await getConversationSyncHealth(db.db, f.thread.id)).toBeNull();
    expect(await debt()).toEqual([]);
    // The head is stored now, so the ordinary lane would never walk the
    // thread again; before, the row kept /health/sync degraded for good.
    expect(await selectNextPageDmMessageSyncCandidate(db.db, { platformAccountId: f.page.id })).toBeNull();
  });
  it("certifies the head only as of the walk's head page, so a head listed since stays due", async () => {
    const f = await fixture();
    await f.step();
    const cursor = async () => (await db.pool.query(
      "select backfill_cursor from subject_refresh_state where plane='fansly_ws_dm'",
    )).rows[0].backfill_cursor as { before?: string; headReadAt?: string };
    expect(await cursor()).toMatchObject({ before: "126", headReadAt: expect.any(String) });
    // The prod shape: the head page was read days before the continuation
    // (lilly-2 thread 15378: 22.09 head page, 27.09 finalize), and the list
    // recorded a newer head in between.
    await db.pool.query(`update subject_refresh_state
      set backfill_cursor = jsonb_set(backfill_cursor, '{headReadAt}', '"2026-09-22T00:11:00.000Z"')
      where plane='fansly_ws_dm'`);
    await db.pool.query(`update page_dm_threads set last_message_id = '151',
      last_message_at = '2026-09-27T19:32:00Z' where id = $1`, [f.thread.id]);
    await f.due(); await f.step(); await f.due(); await f.step();
    expect(f.calls).toHaveLength(3);

    expect(await getPageDmConversationById(db.db, f.thread.id)).toMatchObject({
      newestStoredMessageId: "150", lastMessageSyncAt: new Date("2026-09-22T00:11:00.000Z"),
    });
    // Before, the continuation stamped "now" and the new head left selection.
    expect(await selectNextPageDmMessageSyncCandidate(db.db, { platformAccountId: f.page.id }))
      .toMatchObject({ id: f.thread.id, lastMessageId: "151" });
  });
  it("rolls back all hot writes and settlement together if finalization fails", async () => {
    const f = await fixture();
    await f.step(); await f.due(); await f.step(); await f.due();
    await db.pool.query(`create function b1_fail_finalize() returns trigger language plpgsql as $$
      begin raise exception 'injected finalize failure'; end $$;
      create trigger b1_fail_finalize before update on page_dm_threads for each row execute function b1_fail_finalize()`);
    try {
      await expect(f.step()).rejects.toThrow();
      expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(1);
      expect((await db.pool.query("select applied_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].applied_revision).toBe(0n);
      expect((await db.pool.query("select hot_applied_at from fansly_ws_hint_receipts")).rows[0].hot_applied_at).toBeNull();
    } finally {
      await db.pool.query("drop trigger b1_fail_finalize on page_dm_threads; drop function b1_fail_finalize()");
    }
  });
  it("keeps an unseen exact target dirty even when stale REST reaches the old boundary", async () => {
    const f = await fixture();
    const original = f.app.adapter.getMessagesPage;
    f.app.adapter.getMessagesPage = vi.fn(async (context, params) => {
      await f.physical(context, "messages");
      const items = f.messages.slice(-1);
      return { items, raw: { messages: items }, groupId: params.groupId, before: null, done: true };
    });
    await f.step();
    const state = (await db.pool.query("select applied_revision,last_refresh_outcome,backfill_cursor from subject_refresh_state where plane='fansly_ws_dm'")).rows[0];
    expect(state).toMatchObject({ applied_revision: 0n, last_refresh_outcome: "target_unconfirmed" });
    expect(state.backfill_cursor).not.toHaveProperty("before");
    expect((await db.pool.query("select hot_applied_at from fansly_ws_hint_receipts")).rows[0].hot_applied_at).toBeNull();
    f.app.adapter.getMessagesPage = original;
    for (let page = 0; page < 3; page++) { await f.due(); await f.step(); }
    expect(f.calls).toHaveLength(4);
    expect((await db.pool.query("select applied_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].applied_revision).toBe(1n);
    expect((await db.pool.query("select hot_applied_at from fansly_ws_hint_receipts")).rows[0].hot_applied_at).not.toBeNull();
  });
  it("rechecks the type allowlist immediately before physical dispatch", async () => {
    const f = await fixture();
    const original = f.app.adapter.getMessagesPage;
    f.app.adapter.getMessagesPage = vi.fn(async (context, params) => {
      f.app.config.fanslyWsHintsTypeAllowlist = "group_created";
      return original.call(f.app.adapter, context, params);
    });
    await f.step();
    expect(f.calls).toEqual([]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
  });
  function boundPolicy(f: Awaited<ReturnType<typeof fixture>>, bounds: { expiresAt?: string; attemptLimit24h?: number }) {
    const policies = JSON.parse(f.app.config.fanslyWsHintsPolicies!);
    Object.assign(policies[f.page.label], bounds);
    f.app.config.fanslyWsHintsPolicies = JSON.stringify(policies);
  }
  it("refuses physical dispatch when the canary expires after claim selection", async () => {
    const f = await fixture();
    const deadline = new Date(Date.now() + 1000);
    boundPolicy(f, { expiresAt: deadline.toISOString() });
    const original = f.app.adapter.getMessagesPage;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      f.app.adapter.getMessagesPage = vi.fn(async (context, params) => {
        vi.setSystemTime(deadline);
        return original.call(f.app.adapter, context, params);
      });
      await f.step();
      expect(f.calls).toEqual([]);
      expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
      expect(f.app.config.fanslyWsHintsEnabled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("retains a response admitted before expiry and leaves ordinary polling able to finish the gap", async () => {
    const f = await fixture();
    const deadline = new Date(Date.now() + 1000);
    boundPolicy(f, { expiresAt: deadline.toISOString() });
    const original = f.app.adapter.getMessagesPage;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      f.app.adapter.getMessagesPage = vi.fn(async (context, params) => {
        const result = await original.call(f.app.adapter, context, params);
        vi.setSystemTime(deadline);
        return result;
      });
      await f.step();
      const staged = (await db.pool.query("select backfill_cursor from subject_refresh_state where plane='fansly_ws_dm'")).rows[0];
      expect(staged.backfill_cursor.rawPageIds).toHaveLength(1);
      await f.due();
      await f.owned(() => fanslyDmMessagesChunk(f.app, f.input("event", true) as never));
      expect(f.calls).toEqual(["messages"]);
      await f.owned(() => fanslyDmMessagesChunk(f.app, f.input() as never));
      expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(51);
      expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(1);
      expect(f.app.config.fanslyWsCaptureEnabled).toBe(true);
      expect(f.app.config.fanslyWsHintsEnabled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("rolls back admission if a database wait crosses the deadline", async () => {
    const f = await fixture();
    const deadline = new Date(Date.now() + 1000);
    boundPolicy(f, { expiresAt: deadline.toISOString() });
    const blocker = await db.pool.connect();
    await blocker.query("select pg_advisory_lock(36410)");
    await db.pool.query(`create function b1_wait_admission() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(36410); return new; end $$;
      create trigger b1_wait_admission before insert on fansly_ws_hint_attempts
      for each row execute function b1_wait_admission()`);
    vi.useFakeTimers({ toFake: ["Date"] });
    const pending = f.step();
    try {
      await vi.waitFor(async () => {
        // pg_locks spans the whole cluster; sibling test databases share it.
        const locks = await db.pool.query("select count(*)::int n from pg_locks where locktype='advisory' and objid=36410 and not granted and database=(select oid from pg_database where datname=current_database())");
        expect(locks.rows[0].n).toBe(1);
      });
      vi.setSystemTime(deadline);
      await blocker.query("select pg_advisory_unlock(36410)");
      await pending;
      expect(f.calls).toEqual([]);
      expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
    } finally {
      await blocker.query("select pg_advisory_unlock(36410)");
      await pending.finally(() => {
        vi.useRealTimers();
        blocker.release();
      });
      await db.pool.query("drop trigger b1_wait_admission on fansly_ws_hint_attempts; drop function b1_wait_admission()");
    }
  });
  it("refuses dispatch after a late telemetry write and retains the committed reservation", async () => {
    const f = await fixture();
    const deadline = new Date(Date.now() + 1000);
    boundPolicy(f, { expiresAt: deadline.toISOString() });
    const input = f.input();
    const states: string[] = [];
    input.telemetry.getRequestObserver = () => ({ onRequestEvent: async event => {
      states.push(event.state);
      if (event.state === "started") vi.setSystemTime(deadline);
    } });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await f.owned(() => runFanslyWsHintStep(f.app, input as never));
      expect(f.calls).toEqual([]);
      expect(states).toEqual(["started", "failed"]);
      expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it("counts a lower canary cap against existing physical attempts without resetting on a policy edit", async () => {
    const f = await fixture();
    boundPolicy(f, { attemptLimit24h: 2 });
    await f.step(); await f.due(); await f.step(); await f.due();
    boundPolicy(f, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await f.step();
    expect(f.calls).toEqual(["messages", "messages"]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(2);
    expect((await db.pool.query("select applied_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].applied_revision).toBe(0n);
  });
  const spendBudget = (f: Awaited<ReturnType<typeof fixture>>) => db.pool.query(`insert into fansly_ws_hint_attempts
    (page_id,request_id,attempt_number,generation,admitted_at)
    select $1, 'spent-'||n, 1, $2, now() - interval '23 hours' + n * interval '1 minute' from generate_series(1,50) n`,
  [f.page.id, f.policy.generation]);
  it("refuses a spent budget before any adapter call and waits for the window, not a failure backoff", async () => {
    const f = await fixture();
    await spendBudget(f);
    await f.step();
    expect(f.app.adapter.getMessagesPage).not.toHaveBeenCalled();
    const subject = (await db.pool.query(`select s.*, extract(epoch from s.retry_after_at
        - (select min(admitted_at) + interval '24 hours' from fansly_ws_hint_attempts)) as reopen_delta
      from subject_refresh_state s where plane='fansly_ws_dm'`)).rows[0];
    expect(subject).toMatchObject({ last_refresh_outcome: "budget_exhausted", consecutive_failures: 0,
      applied_revision: 0n, claim_token: null, backfill_cursor: { conversationId: f.thread.id } });
    expect(subject.next_due_at).toEqual(subject.retry_after_at);
    expect(Math.abs(Number(subject.reopen_delta))).toBeLessThan(0.001);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(50);
    // Unknown groups are refused before their detail read the same way.
    await db.pool.query("update subject_refresh_state set next_due_at=now()+interval '2 hours'");
    await f.route(2, "99");
    await f.step();
    expect(f.app.adapter.getGroupDetail).not.toHaveBeenCalled();
    expect((await db.pool.query("select last_refresh_outcome,consecutive_failures from subject_refresh_state where subject_ref='99'")).rows[0])
      .toEqual({ last_refresh_outcome: "budget_exhausted", consecutive_failures: 0 });
  });
  it("does not count a budget refused at dispatch as a target failure", async () => {
    const f = await fixture();
    const original = f.app.adapter.getMessagesPage;
    f.app.adapter.getMessagesPage = vi.fn(async (context, params) => {
      // Spent between the pre-check and admission.
      await spendBudget(f);
      return original(context, params);
    });
    await f.step();
    expect(f.calls).toEqual([]);
    expect((await db.pool.query("select last_refresh_outcome,consecutive_failures from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toEqual({ last_refresh_outcome: "budget_exhausted", consecutive_failures: 0 });
  });
  const storeMessage = (f: Awaited<ReturnType<typeof fixture>>, conversationId: number, id: string) => upsertPageDmMessages(db.db, [{
    conversationId, platformAccountId: f.page.id, platformMessageId: id,
    senderPlatformUserId: "999", senderRole: "model", createdAt: new Date("2026-09-27T19:32:00Z"),
    content: "mass message", totalTipAmountCents: 0, inReplyToMessageId: null, inReplyToRootMessageId: null,
  }]);
  // Another visible thread whose announced message ordinary polling already stored.
  async function storedTarget(f: Awaited<ReturnType<typeof fixture>>, groupRef: string, eventId: number,
    { stored = true, visible = true } = {}) {
    const [fan] = await upsertFans(db.db, [{ platform: "fansly", platformUserId: `7${groupRef}` }]);
    const thread = await upsertPageDmConversation(db.db, {
      platformAccountId: f.page.id, fanId: fan!.id, platformConversationId: groupRef,
      partnerPlatformUserId: `7${groupRef}`, partnerUsername: null, partnerDisplayName: null,
      conversationFlags: 0, unreadCount: 0, subscriptionTierId: null,
      lastMessageId: `${groupRef}1`, lastUnreadMessageId: null, lastMessageAt: new Date("2026-09-27T19:32:00Z"),
      lastMessageSenderId: "999", lastMessageSenderRole: "model", lastMessagePreview: "mass message",
      messageCoverageStatus: "complete", newestStoredMessageId: `${groupRef}1`, oldestStoredMessageId: `${groupRef}1`,
      storedMessageCount: 1, lastMessageSyncAt: new Date("2026-09-27T20:00:00Z"), isVisible: visible, lastSeenGeneration: 1, metadata: {},
    });
    if (stored) await storeMessage(f, thread!.id, `${groupRef}1`);
    await fileFanslyWsHintReceipt(db.pool, {
      id: eventId, pageId: f.page.id, observationId: eventId, receivedAt: new Date(), generation: f.policy.generation,
      node: { path: [], outcome: "hint", hint: { type: "message_created", groupRef, messageRef: `${groupRef}1` } },
    }, f.policy);
    return thread!;
  }
  // Prod 27.09: lilly-1/2 spent ~800 hint GETs a day on threads whose target the
  // scheduled lane had already stored; ari-1's spent budget settled none.
  it.each([false, true])("settles an already stored target without a request or hint budget (budget spent=%s)", async spent => {
    const f = await fixture();
    if (spent) await spendBudget(f);
    await storeMessage(f, f.thread.id, "150");
    const thread = await getPageDmConversationById(db.db, f.thread.id);
    await f.step();
    expect(f.app.adapter.getMessagesPage).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(spent ? 50 : 0);
    expect((await db.pool.query("select * from subject_refresh_state where plane='fansly_ws_dm'")).rows[0]).toMatchObject({
      requested_revision: 1n, applied_revision: 1n, last_refresh_outcome: "already_materialized",
      claim_token: null, next_due_at: null, consecutive_failures: 0, refresh_checks: 0n, last_checked_at: null,
      backfill_cursor: { generation: f.policy.generation },
    });
    const receipt = (await db.pool.query("select * from fansly_ws_hint_receipts where event_id=1")).rows[0];
    expect(receipt).toMatchObject({ settlement_kind: "rest_materialized", settlement_observation_id: null, rest_raw_page_ids: [] });
    expect(receipt.settled_at).toBeInstanceOf(Date);
    expect(receipt.hot_applied_at).toBeInstanceOf(Date);
    // No head was read: the thread keeps its freshness stamp and breaker state.
    expect(await getPageDmConversationById(db.db, f.thread.id)).toEqual(thread);
  });
  it("settles stored targets first, then reads the head once for a missing one", async () => {
    const f = await fixture();
    await storedTarget(f, "200", 2);
    await db.pool.query("update subject_refresh_state set next_due_at=now()-interval '1 hour' where subject_ref='200'");
    await f.step();
    expect(f.calls).toEqual(["messages"]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(1);
    expect((await db.pool.query(`select subject_ref,applied_revision,last_refresh_outcome from subject_refresh_state
      where plane='fansly_ws_dm' order by subject_ref`)).rows).toEqual([
      { subject_ref: "100", applied_revision: 0n, last_refresh_outcome: "walk_pending" },
      { subject_ref: "200", applied_revision: 1n, last_refresh_outcome: "already_materialized" },
    ]);
  });
  it("bounds the zero-request settles of one step", async () => {
    const f = await fixture(false);
    for (let n = 0; n < 51; n++) await storedTarget(f, String(300 + n), 10 + n);
    const dirty = async () => (await db.pool.query(`select count(*)::int n from subject_refresh_state
      where plane='fansly_ws_dm' and requested_revision > applied_revision`)).rows[0].n;
    await f.step();
    expect(await dirty()).toBe(1);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_receipts where settled_at is not null")).rows[0].n).toBe(50);
    await f.step();
    expect(await dirty()).toBe(0);
    expect(f.calls).toEqual([]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
  });
  // The claim FIFO in the given order, oldest first.
  const inOrder = (f: Awaited<ReturnType<typeof fixture>>, refs: string[]) => db.pool.query(`update subject_refresh_state
    set next_due_at = now() - interval '1 hour' + array_position($2::text[], subject_ref) * interval '1 second'
    where page_id = $1 and plane = 'fansly_ws_dm'`, [f.page.id, refs]);
  const subjects = async () => (await db.pool.query(`select subject_ref, applied_revision, last_refresh_outcome, refresh_visits
    from subject_refresh_state where plane='fansly_ws_dm' order by subject_ref`)).rows;
  const settled = (ref: string) => ({ subject_ref: ref, applied_revision: 1n, last_refresh_outcome: "already_materialized", refresh_visits: 1n });
  // Prod 30.09 (d2d75ff4): the due FIFO interleaves subjects that need REST
  // (lilly-1 70 of 1,289, ari-1 39 of 403). Each step stopped at the first,
  // so settling stalled while ari-1's spent budget deferred one per chunk.
  it("defers every REST subject of a spent budget and settles the stored targets between them", async () => {
    const f = await fixture(false);
    await spendBudget(f);
    const refs = Array.from({ length: 12 }, (_, n) => String(300 + n));
    for (const [n, ref] of refs.entries()) await storedTarget(f, ref, 10 + n, { stored: n % 3 !== 2 });
    await inOrder(f, refs);
    await f.step();
    expect(f.calls).toEqual([]);
    expect(await subjects()).toEqual(refs.map((ref, n) => n % 3 === 2
      ? { subject_ref: ref, applied_revision: 0n, last_refresh_outcome: "budget_exhausted", refresh_visits: 1n }
      : settled(ref)));
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(50);
  });
  // A spent-budget deferral shares the budget's reopen time, so they cluster
  // at the head of the queue. The bound keeps the chunk's wall clock for
  // ordinary polling; the stored targets behind them still settle.
  it("bounds the zero-request deferrals of one step and still settles the stored targets behind them", async () => {
    const f = await fixture(false);
    await spendBudget(f);
    const rest = Array.from({ length: 51 }, (_, n) => String(400 + n));
    for (const [n, ref] of rest.entries()) await storedTarget(f, ref, 10 + n, { stored: false });
    await storedTarget(f, "300", 100);
    await storedTarget(f, "301", 101);
    await inOrder(f, [...rest, "300", "301"]);
    await f.step();
    expect(f.calls).toEqual([]);
    expect(await subjects()).toEqual([
      settled("300"), settled("301"),
      ...rest.slice(0, 50).map(ref => ({ subject_ref: ref, applied_revision: 0n, last_refresh_outcome: "budget_exhausted", refresh_visits: 1n })),
      // Past the bound: not claimed, still first in line.
      { subject_ref: "450", applied_revision: 0n, last_refresh_outcome: null, refresh_visits: 0n },
    ]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(50);
  });
  it("keeps settling stored targets after the step's one head read and leaves later reads queued", async () => {
    const f = await fixture();
    await storedTarget(f, "200", 2);
    await storedTarget(f, "201", 3);
    await storedTarget(f, "400", 4, { stored: false });
    await storedTarget(f, "202", 5);
    await inOrder(f, ["200", "100", "201", "400", "202"]);
    await f.step();
    expect(f.calls).toEqual(["messages"]);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(1);
    expect(await subjects()).toEqual([
      { subject_ref: "100", applied_revision: 0n, last_refresh_outcome: "walk_pending", refresh_visits: 1n },
      settled("200"), settled("201"), settled("202"),
      // Not claimed: still first in line for the next step's read.
      { subject_ref: "400", applied_revision: 0n, last_refresh_outcome: null, refresh_visits: 0n },
    ]);
  });
  it("rolls back a listed subject whose target is gone by its claim and settles the rest", async () => {
    const f = await fixture();
    await storedTarget(f, "201", 3);
    await storedTarget(f, "202", 5);
    await inOrder(f, ["100", "201", "202"]);
    // Listed after the read, then its target is deleted inside its own claim.
    await db.pool.query(`create function b1_drop_target() returns trigger language plpgsql as $$
      begin update page_dm_messages set deleted_at = now() where platform_message_id = '2011'; return new; end $$;
      create trigger b1_drop_target after update of claim_token on subject_refresh_state for each row
      when (new.subject_ref = '201' and new.claim_token is not null) execute function b1_drop_target()`);
    try {
      await f.step();
    } finally {
      await db.pool.query("drop trigger b1_drop_target on subject_refresh_state; drop function b1_drop_target()");
    }
    expect(f.calls).toEqual(["messages"]);
    expect(await subjects()).toEqual([
      { subject_ref: "100", applied_revision: 0n, last_refresh_outcome: "walk_pending", refresh_visits: 1n },
      { subject_ref: "201", applied_revision: 0n, last_refresh_outcome: null, refresh_visits: 0n },
      settled("202"),
    ]);
    // The claim rolled back together with the trigger's write.
    expect((await db.pool.query("select deleted_at from page_dm_messages where platform_message_id='2011'")).rows[0].deleted_at)
      .toBeNull();
  });
  it("defers an ineligible conversation and keeps settling behind it", async () => {
    const f = await fixture(false);
    await storedTarget(f, "300", 10, { visible: false });
    await storedTarget(f, "301", 11);
    await inOrder(f, ["300", "301"]);
    await f.step();
    expect(f.calls).toEqual([]);
    expect(await subjects()).toEqual([
      { subject_ref: "300", applied_revision: 0n, last_refresh_outcome: "conversation_ineligible", refresh_visits: 1n },
      settled("301"),
    ]);
    expect((await db.pool.query("select consecutive_failures from subject_refresh_state where subject_ref='300'")).rows[0])
      .toEqual({ consecutive_failures: 1 });
  });
  it.each(["group_created", "mid_walk"])("still reads the head for a stored target with %s", async kind => {
    const f = await fixture();
    if (kind === "mid_walk") { await f.step(); await f.due(); }
    await storeMessage(f, f.thread.id, "150");
    if (kind === "group_created") await fileFanslyWsHintReceipt(db.pool, {
      id: 2, pageId: f.page.id, observationId: 2, receivedAt: new Date(), generation: f.policy.generation,
      node: { path: [], outcome: "hint", hint: { type: "group_created", groupRef: "100", messageRef: null } },
    }, f.policy);
    await f.step();
    expect(f.calls).toHaveLength(kind === "mid_walk" ? 2 : 1);
    expect((await db.pool.query("select applied_revision,last_refresh_outcome from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toEqual({ applied_revision: 0n, last_refresh_outcome: "walk_pending" });
  });
  // One body per rejection class (#259). Which shapes are rejected is pinned by
  // the contract's unit matrix; persistence here is shape-agnostic. Kept: JSON
  // null, the matching-id-but-invalid-membership class the pre-#259 step
  // accepted, and an id mismatch.
  it.each([
    null, { id: "99", users: [{}] }, { id: "wrong-group", users: [] },
  ])("journals rejected group detail without marking discovery captured: %j", async raw => {
    const f = await fixture(false);
    await f.route(2, "99");
    f.app.adapter.getGroupDetail = vi.fn(async context => {
      await f.physical(context, "group_detail");
      return { parsed: raw as never, raw: raw as never };
    });

    await expect(f.step()).rejects.toThrow("group detail response contract rejected");

    expect(f.calls).toEqual(["group_detail"]);
    expect((await db.pool.query("select payload from observations where account_id=$1 and kind='group_detail'", [f.page.id])).rows)
      .toEqual([{ payload: { contractAccepted: false, raw } }]);
    const state = (await db.pool.query("select backfill_cursor, applied_revision from subject_refresh_state where page_id=$1 and subject_ref='99'", [f.page.id])).rows[0];
    expect(state.backfill_cursor).not.toHaveProperty("groupDetailCaptured");
    expect(state.applied_revision).toBe(0n);
    expect((await db.pool.query("select count(*)::int n from page_dm_threads where platform_account_id=$1 and platform_conversation_id='99'", [f.page.id])).rows[0].n)
      .toBe(0);
  });

  it("reads an unknown group once without inventing visible membership", async () => {
    const f = await fixture();
    await db.pool.query("update subject_refresh_state set next_due_at=now()+interval '1 hour'");
    await f.route(2, "99");
    f.app.adapter.getGroupDetail = vi.fn(async (context, id) => {
      await f.physical(context, "group_detail");
      const parsed = { id, type: 1, groupFlags: 0, users: [{ groupId: id, userId: "999", type: 1, permissionFlags: 0 }] };
      return { parsed, raw: parsed };
    });
    await f.step();
    await db.pool.query("update subject_refresh_state set next_due_at=now(),retry_after_at=null where subject_ref='99'");
    await f.step();
    expect(f.calls).toEqual(["group_detail"]);
    expect((await db.pool.query("select count(*)::int n from page_dm_threads where platform_conversation_id='99'")).rows[0].n).toBe(0);
    expect((await db.pool.query("select last_refresh_outcome from subject_refresh_state where subject_ref='99'")).rows[0].last_refresh_outcome).toBe("membership_pending");
  });
  it("erasure reaches known group custody and all page-owned B1 stores", async () => {
    const f = await fixture(); await f.step();
    const ownerId = Number((await db.pool.query("insert into users(username,role) values ('b1-owner','owner') returning id")).rows[0].id);
    const scope = { scopeType: "fan", platform: "fansly", fanRef: "111" } as const;
    expect((await planErasure(f.app, scope)).resolvedFanGroupIds).toContain("100");
    await executeErasure(f.app, scope, { initiatedBy: ownerId });
    expect((await db.pool.query("select count(*)::int n from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].n).toBe(0);
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_receipts")).rows[0].n).toBe(0);
    // Attempt budget has no fan reference and remains conservative after fan erasure.
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(1);
    await executeErasure(f.app, { scopeType: "page", pageLabel: f.page.label }, { initiatedBy: ownerId });
    expect((await db.pool.query("select count(*)::int n from fansly_ws_hint_attempts")).rows[0].n).toBe(0);
  });
  it("does no ordinary HTTP in an event-only wakeup, including when disabled or out of budget", async () => {
    const f = await fixture();
    f.app.config.fanslyWsHintsEnabled = false;
    await f.owned(() => fanslyDmMessagesChunk(f.app, f.input("event", true) as never));
    expect(f.calls).toEqual([]);
    f.app.config.fanslyWsHintsEnabled = true;
    await db.pool.query(`insert into fansly_ws_hint_attempts(page_id,request_id,attempt_number,generation)
      select $1, 'spent-'||n, 1, $2 from generate_series(1,50) n`, [f.page.id, f.policy.generation]);
    await f.owned(() => fanslyDmMessagesChunk(f.app, f.input("event", true) as never));
    expect(f.calls).toEqual([]);
  });
  it("isolates an observed transport failure and persists backoff while ordinary polling progresses", async () => {
    const f = await fixture();
    const ordinary = f.app.adapter.getMessagesPage;
    f.app.adapter.getMessagesPage = vi.fn(ordinary).mockImplementationOnce(context =>
      failRequest(context, new TypeError("fetch failed")));
    await f.owned(() => fanslyDmMessagesChunk(f.app, f.input() as never));
    expect(f.calls).toEqual(["messages", "messages", "messages"]);
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(51);
    const subject = (await db.pool.query("select * from subject_refresh_state where plane='fansly_ws_dm'")).rows[0];
    expect(subject).toMatchObject({ last_refresh_outcome: "target_transport", consecutive_failures: 1, applied_revision: 0n });
    expect(subject.retry_after_at.getTime() - Date.now()).toBeGreaterThan(50_000);
    await f.route(2, "100", "151");
    expect((await db.pool.query("select retry_after_at from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].retry_after_at)
      .toEqual(subject.retry_after_at);
    expect((await getPageSyncState(db.db, f.page.id, "dm_messages"))?.consecutiveFailures).toBe(0);
    await f.due();
    f.app.adapter.getMessagesPage = context => failRequest(context, new TypeError("fetch failed"));
    // Ordinary polling stored 150, so R settles without a request; R+1's
    // unstored target keeps failing and backs off from its own streak.
    await f.step();
    expect((await db.pool.query("select applied_revision,consecutive_failures from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toEqual({ applied_revision: 1n, consecutive_failures: 1 });
    await f.due(); await f.step();
    expect((await db.pool.query("select consecutive_failures,extract(epoch from retry_after_at-clock_timestamp()) seconds from subject_refresh_state where plane='fansly_ws_dm'")).rows[0])
      .toMatchObject({ consecutive_failures: 2 });
    const seconds = (await db.pool.query("select extract(epoch from retry_after_at-clock_timestamp()) seconds from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].seconds;
    expect(Number(seconds)).toBeGreaterThan(110);
    // The container clock can differ from the application clock by milliseconds.
    expect(Number(seconds)).toBeLessThanOrEqual(121);
  });
  it.each(["unobserved", "policy", "auth", "rate_limit", "telemetry"])("propagates %s failures instead of disguising them as B1 debt", async kind => {
    const f = await fixture();
    const error = kind === "auth" ? new FanslyApiError("auth", 401)
      : kind === "rate_limit" ? new FanslyApiError("rate", 429)
      : new TypeError("injected failure");
    f.app.adapter.getMessagesPage = context => kind === "unobserved" ? Promise.reject(error)
      : failRequest(context, error, kind === "policy" ? "policy" : "transport");
    const input = f.input();
    if (kind === "telemetry") input.telemetry.getRequestObserver = () => ({ onRequestEvent: async event => {
      if (event.state === "failed") throw error;
    } });
    await expect(f.owned(() => runFanslyWsHintStep(f.app, input as never))).rejects.toBe(error);
    expect((await db.pool.query("select consecutive_failures from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].consecutive_failures).toBe(0);
  });
  it.each(["generation", "lease"])("handles %s revocation while deferring a transport failure", async reason => {
    const f = await fixture(); const original = f.app.adapter.getMessagesPage;
    f.app.adapter.getMessagesPage = vi.fn(original).mockImplementationOnce(async context => {
      try { return await failRequest(context, new TypeError("transport failed")); }
      catch (error) {
        if (reason === "generation") await saveProxy(f.app, f.page.id, { url: "http://rotated.example.test:8080" });
        else await db.pool.query("update page_sync_states set lease_token=$1 where page_id=$2 and stream='dm_messages'", [randomUUID(), f.page.id]);
        throw error;
      }
    });
    const run = f.owned(() => fanslyDmMessagesChunk(f.app, f.input() as never));
    if (reason === "generation") {
      await expect(run).resolves.toBeDefined();
      expect(f.calls).toEqual(["messages", "messages", "messages"]);
    } else await expect(run).rejects.toThrow();
    expect((await db.pool.query("select applied_revision from subject_refresh_state where plane='fansly_ws_dm'")).rows[0].applied_revision).toBe(0n);
  });
  it("isolates a disappeared hinted group while ordinary history still progresses", async () => {
    const f = await fixture();
    await db.pool.query("update subject_refresh_state set next_due_at=now()+interval '1 hour'");
    await f.route(2, "99");
    await f.owned(() => fanslyDmMessagesChunk(f.app, f.input() as never));
    expect(f.calls[0]).toBe("group_detail");
    expect(f.calls.filter(call => call === "messages")).toHaveLength(3);
    expect((await db.pool.query("select count(*)::int n from page_dm_messages")).rows[0].n).toBe(51);
  });
  it("event wakeup cannot replace an existing ordinary request", async () => {
    const f = await fixture();
    const before = await getPageSyncState(db.db, f.page.id, "dm_messages");
    expect(await requestPageSync(db.db, { pageId: f.page.id, streams: ["dm_messages"], source: "event" })).toEqual([]);
    expect(await getPageSyncState(db.db, f.page.id, "dm_messages")).toEqual(before);
    await db.pool.query(`update page_sync_states set status='idle',applied_seq=request_seq,
      leased_seq=null,lease_token=null,lease_expires_at=null where page_id=$1 and stream='dm_messages'`, [f.page.id]);
    await requestPageSync(db.db, { pageId: f.page.id, streams: ["dm_messages"], source: "event" });
    expect(await getPageSyncState(db.db, f.page.id, "dm_messages")).toMatchObject({
      dispatchSource: "event", requestPayload: { fanslyWsHintOnly: true },
    });
  });
});

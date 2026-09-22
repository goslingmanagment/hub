// Characterization pins for the Fansly dm_conversations sweep
// (`fanslyDmConversationsChunk`, apps/runtime/src/services/sync/fansly-dm-conversations.ts).
// Written BEFORE a refactor of that handler: every expectation below records
// what the code does TODAY, not what it ought to do. Where today's behavior is
// arguably wrong the test says so in its name and in a comment — it still pins
// the current outcome, so the refactor has to change it deliberately.
//
// The sibling suite tests/fansly-dm-generation-membership.integration.test.ts
// (G3) owns the membership/erasure/finalization verdicts. This file owns the
// REQUEST level: for each churn scenario, the exact sequence of adapter calls
// (method, offset/limit/id), the resulting page_dm_threads rows, the exact
// checkpoint document in page_sync_cursors, and whether a dm_messages follow-up
// was requested. Scenarios G3 already covers (two-page sweep, v2 resume,
// withheld finalization, erasure, duplicate id restart) are not repeated.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  getPageDmSyncCoverage,
  startSyncRun,
  upsertFans,
  upsertPageDmConversation,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

import {
  PAGE_ACCOUNT_ID, HEAD_CREATED_AT_MS, MESSAGE_SYNC_AT, DM_MESSAGES_SEED_REQUEST_SEQ,
  fakeTelemetry, groupsPage, sweepAdapter, seedThreadInput,
} from "./helpers/fansly-dm-sweep.ts";

let testDb: StartedTestDatabase | null = null;

describe("Fansly dm_conversations sweep — request-level characterization", () => {
  let appContext: AppContext;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
  });

  async function seedPage(label: string, adapterInput: Parameters<typeof sweepAdapter>[0]) {
    const { adapter, calls } = sweepAdapter(adapterInput);
    appContext = createTestAppContext(testDb!, {
      syncSharedRateLimitEnabled: true,
      adapter,
    });
    const model = await createModel(appContext.db, { slug: `${label}-model`, name: label });
    if (!model) throw new Error("model seed failed");
    const page = await createFanslyPage(appContext.db, { modelId: model.id, label });
    if (!page) throw new Error("page seed failed");
    await ensurePageSyncStates(appContext.db, { pageId: page.id });
    const stored = await findPageById(appContext.db, page.id);
    if (!stored) throw new Error("page reload failed");
    return { page, stored, calls };
  }

  /** One dispatch of the stream — a fresh sync run and a fresh budget, exactly
   *  like the executor gives it. Nothing but the database carries state from
   *  one dispatch to the next. */
  async function runChunk(
    stored: { page: { id: number } },
    telemetry: ReturnType<typeof fakeTelemetry>,
    maxRequests: number,
  ) {
    const run = await startSyncRun(appContext.db, {
      platformAccountId: stored.page.id,
      stream: "dm_conversations",
      trigger: "manual",
    });
    if (!run) throw new Error("sync run seed failed");

    const result = await fanslyDmConversationsChunk(appContext, {
      pageContext: {
        page: { ...stored.page, platformAccountId: PAGE_ACCOUNT_ID },
        platform: "fansly" as const,
        session: { authorization: "token" },
        proxy: null,
        egressKey: "direct",
      } as never,
      streamState: { requestSeq: 1 } as never,
      syncRunId: run.id,
      telemetry: telemetry as never,
      budget: new SyncChunkBudget(maxRequests),
    } as never);

    return { result, runId: run.id };
  }

  async function readThreads(platformAccountId: number) {
    const { rows } = await testDb!.pool.query<{
      platform_conversation_id: string;
      last_seen_generation: string | null;
      is_visible: boolean;
      last_message_id: string | null;
      unread_count: number;
      conversation_flags: number;
      subscription_tier_id: string | null;
      last_unread_message_id: string | null;
    }>(
      `select platform_conversation_id, last_seen_generation, is_visible, last_message_id,
              unread_count, conversation_flags, subscription_tier_id, last_unread_message_id
       from page_dm_threads
       where platform_account_id = $1
       order by platform_conversation_id`,
      [platformAccountId],
    );
    return Object.fromEntries(rows.map((row) => [row.platform_conversation_id, {
      generation: row.last_seen_generation === null ? null : Number(row.last_seen_generation),
      isVisible: row.is_visible,
      lastMessageId: row.last_message_id,
      unreadCount: row.unread_count,
      conversationFlags: row.conversation_flags,
      subscriptionTierId: row.subscription_tier_id,
      lastUnreadMessageId: row.last_unread_message_id,
    }]));
  }

  /** The head block a thread ended up with — what head repair actually wrote. */
  async function readThreadHead(platformAccountId: number, platformConversationId: string) {
    const { rows } = await testDb!.pool.query<{
      last_message_id: string | null;
      last_message_at: Date | null;
      last_message_sender_id: string | null;
      last_message_sender_role: string;
      last_message_preview: string | null;
      newest_stored_message_id: string | null;
      message_coverage_status: string;
    }>(
      `select last_message_id, last_message_at, last_message_sender_id, last_message_sender_role,
              last_message_preview, newest_stored_message_id, message_coverage_status
       from page_dm_threads
       where platform_account_id = $1 and platform_conversation_id = $2`,
      [platformAccountId, platformConversationId],
    );
    const row = rows[0];
    if (!row) throw new Error(`thread ${platformConversationId} not found`);
    return {
      lastMessageId: row.last_message_id,
      lastMessageAt: row.last_message_at === null ? null : row.last_message_at.toISOString(),
      lastMessageSenderId: row.last_message_sender_id,
      lastMessageSenderRole: row.last_message_sender_role,
      lastMessagePreview: row.last_message_preview,
      newestStoredMessageId: row.newest_stored_message_id,
      messageCoverageStatus: row.message_coverage_status,
    };
  }

  /** The dm_messages follow-up is a `requestPageSync` on the sibling stream:
   *  one bump of its request_seq per applied page that needed it. */
  async function readDmMessagesRequest(pageId: number) {
    const { rows } = await testDb!.pool.query<{
      request_seq: string | number;
      request_source: string | null;
    }>(
      `select request_seq, request_source
       from page_sync_states
       where page_id = $1 and stream = 'dm_messages'`,
      [pageId],
    );
    const row = rows[0];
    if (!row) throw new Error("dm_messages sync state missing");
    return { requestSeq: Number(row.request_seq), requestSource: row.request_source };
  }

  /** What a completed dm_messages pass leaves behind: coverage "complete" and
   *  a stored head equal to the thread head. Without it every thread is
   *  `pending_backfill` and the follow-up predicate is trivially true. */
  async function markThreadSynced(pageId: number, platformConversationId: string) {
    await testDb!.pool.query(
      `update page_dm_threads
          set message_coverage_status = 'complete',
              message_backfill_complete = true,
              stored_message_count = 1,
              newest_stored_message_id = last_message_id,
              last_message_sync_at = $3::timestamptz
        where platform_account_id = $1 and platform_conversation_id = $2`,
      [pageId, platformConversationId, MESSAGE_SYNC_AT],
    );
  }

  it.each([
    null, { id: "grp-1" }, { id: "grp-1", users: null },
    { id: "grp-1", users: [{}] }, { id: "wrong-group", users: [] },
  ])("captures rejected group detail without replacing identity or advancing the page: %j", async raw => {
    if (!testDb) throw new Error("Test database required");
    const response = groupsPage({ conversations: ["grp-1"], total: 1, offset: 0, done: true });
    // A contradictory roster partner requires the detail lookup even though
    // the stored thread already has a valid fan binding.
    response.groups[0]!.users[1]!.userId = "contradictory-partner";
    const { stored } = await seedPage("sweep-detail-contract", { pages: [response] });
    const [fan] = await upsertFans(appContext.db, [{ platform: "fansly", platformUserId: "fan-grp-1" }]);
    if (!fan) throw new Error("fan seed failed");
    await upsertPageDmConversation(appContext.db, {
      ...seedThreadInput(stored.page.id, "grp-1", 1), fanId: fan.id,
    });
    const before = (await testDb.pool.query("select * from page_dm_threads where platform_account_id=$1", [stored.page.id])).rows;
    appContext.adapter.getGroupDetail = vi.fn(async () => ({ parsed: raw as never, raw: raw as never }));

    await expect(runChunk(stored, fakeTelemetry(), 5)).rejects.toThrow("group detail response contract rejected");

    expect(appContext.adapter.getGroupDetail).toHaveBeenCalledTimes(1);
    expect((await testDb.pool.query("select * from page_dm_threads where platform_account_id=$1", [stored.page.id])).rows)
      .toEqual(before);
    expect((await testDb.pool.query("select payload from observations where account_id=$1 and kind='group_detail'", [stored.page.id])).rows)
      .toEqual([{ payload: { contractAccepted: false, raw } }]);
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({ offset: 0, observedCount: 0, pageCount: 0 });
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("finalizes a small inbox in one chunk: one request, certified, unseen threads hidden", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-small-inbox", {
      pages: [groupsPage({ conversations: ["grp-1", "grp-2"], total: 2, offset: 0, done: true })],
    });
    // A thread from an older sweep that the provider no longer lists.
    await upsertPageDmConversation(appContext.db, seedThreadInput(stored.page.id, "grp-gone", 1));

    const { result, runId } = await runChunk(stored, telemetry, 5);

    // data.length (2) < limit (100) on the first page: the walk is over before
    // a second request is spent.
    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(result).toMatchObject({
      satisfied: true,
      yieldReason: null,
      stats: {
        generation: 2,
        offset: 0,
        pageCount: 1,
        observedCount: 2,
        generationSetCount: 2,
        processedConversations: 2,
        repairedHeads: 0,
        providerTotalMode: "present",
        providerReportedTotal: 2,
        destructiveFinalization: true,
        membershipCertified: true,
        finalizationWithheld: false,
        fullSweepCompleted: true,
      },
    });
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": {
        generation: 2,
        isVisible: true,
        lastMessageId: "msg-grp-1",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
      "grp-2": {
        generation: 2,
        isVisible: true,
        lastMessageId: "msg-grp-2",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
      // Stamped by generation 1, not seen by generation 2 → hidden.
      "grp-gone": {
        generation: 1,
        isVisible: false,
        lastMessageId: "msg-grp-gone",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    // The completed document deliberately carries NO `mode`/`offset`/
    // `pageCount`/`fullSweepStartedAt`: the parser refuses it as a resumable
    // cursor, so the next dispatch opens a fresh sweep.
    expect(checkpoint?.state).toEqual({
      version: 2,
      generation: 2,
      observedCount: 2,
      generationSetCount: 2,
      providerTotalMode: "present",
      providerReportedTotal: 2,
      destructiveFinalization: true,
      membershipCertified: true,
      lastFullSweepCompletedAt: expect.any(String),
    });
    expect(checkpoint?.cursorLastSucceededRunId).toBe(runId);
    // Both threads are brand new (`pending_backfill`), so the page asked the
    // sibling stream for messages exactly once — one bump per applied page,
    // not per thread, and it overwrites the seeded "recovery" source.
    expect(await readDmMessagesRequest(stored.page.id)).toEqual({
      requestSeq: DM_MESSAGES_SEED_REQUEST_SEQ + 1,
      requestSource: "scheduled",
    });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("withholds an EMPTY first page and keeps every previously visible thread", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-empty-page", {
      pages: [groupsPage({ conversations: [], total: 0, offset: 0, done: true })],
    });
    await upsertPageDmConversation(appContext.db, seedThreadInput(stored.page.id, "grp-live", 1));

    const { result } = await runChunk(stored, telemetry, 5);

    // The requests are unchanged by the guard: the walk still ends on the one
    // page the provider served.
    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    // 0 observed reproduces 0 stamped rows, so the bare membership check would
    // certify the sweep and the destructive pass would hide the whole inbox off
    // one empty or truncated `total: 0` response. The empty-sweep guard —
    // mirroring the OFAPI audience sweep's `subscribers_empty_sweep_guard` —
    // refuses to read "nothing" as membership evidence while the page still has
    // a visible thread.
    expect(result).toMatchObject({
      satisfied: false,
      continuationRequestSource: "scheduled",
      stats: {
        generation: 2,
        observedCount: 0,
        generationSetCount: 0,
        processedConversations: 0,
        membershipCertified: false,
        destructiveFinalization: false,
        finalizationWithheld: true,
        emptySweepGuard: true,
        fullSweepCompleted: false,
      },
    });
    // Same throttled retry as any other uncertified sweep, and a fresh walk.
    expect(result.continuationRetryAt).toBeInstanceOf(Date);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_empty_sweep_guard",
      severity: "warn",
      details: expect.objectContaining({
        generation: 2,
        observedCount: 0,
        generationSetCount: 0,
        visibleThreadCount: 1,
        providerTotalMode: "present",
        providerReportedTotal: 0,
        finalizationWithheld: true,
      }),
    }));
    // Untouched: the thread the pre-guard sweep hid on exactly this evidence.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-live": {
        generation: 1,
        isVisible: true,
        lastMessageId: "msg-grp-live",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    // The withheld document, not the certified one: same completed shape (no
    // `mode`, so the next dispatch opens a fresh sweep) with the verdict flags
    // false and the coverage timestamp left where it was — here, never set.
    expect(checkpoint?.state).toEqual({
      version: 2,
      generation: 2,
      observedCount: 0,
      generationSetCount: 0,
      providerTotalMode: "present",
      providerReportedTotal: 0,
      destructiveFinalization: false,
      membershipCertified: false,
      lastFullSweepCompletedAt: null,
    });
    // A refused finalization is not this stream's last successful run.
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();
    // ...and the coverage view, which reads that one timestamp, does not
    // advertise a full sweep the guard refused to certify.
    expect((await getPageDmSyncCoverage(appContext.db, stored.page.id)).lastConversationFullSweepAt)
      .toBeNull();
    // No conversation was applied, so no follow-up was requested: dm_messages
    // still carries exactly what page seeding left there.
    expect(await readDmMessagesRequest(stored.page.id)).toEqual({
      requestSeq: DM_MESSAGES_SEED_REQUEST_SEQ,
      requestSource: "recovery",
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("certifies an empty response on a page with nothing visible to lose", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-empty-no-visible", {
      pages: [groupsPage({ conversations: [], total: 0, offset: 0, done: true })],
    });
    // Already hidden by an earlier sweep: the destructive pass has nothing left
    // to take, so the guard has nothing to protect and stays out of the way.
    await upsertPageDmConversation(appContext.db, {
      ...seedThreadInput(stored.page.id, "grp-hidden", 1),
      isVisible: false,
    });

    const { result, runId } = await runChunk(stored, telemetry, 5);

    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 2,
        observedCount: 0,
        generationSetCount: 0,
        processedConversations: 0,
        membershipCertified: true,
        destructiveFinalization: true,
        finalizationWithheld: false,
        emptySweepGuard: false,
        fullSweepCompleted: true,
      },
    });
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-hidden": {
        generation: 1,
        isVisible: false,
        lastMessageId: "msg-grp-hidden",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toEqual({
      version: 2,
      generation: 2,
      observedCount: 0,
      generationSetCount: 0,
      providerTotalMode: "present",
      providerReportedTotal: 0,
      destructiveFinalization: true,
      membershipCertified: true,
      lastFullSweepCompletedAt: expect.any(String),
    });
    expect(checkpoint?.cursorLastSucceededRunId).toBe(runId);
    expect((await getPageDmSyncCoverage(appContext.db, stored.page.id)).lastConversationFullSweepAt)
      .toBeInstanceOf(Date);
    expect(await readDmMessagesRequest(stored.page.id)).toEqual({
      requestSeq: DM_MESSAGES_SEED_REQUEST_SEQ,
      requestSource: "recovery",
    });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("completes without a provider total: certified, non-destructive, unseen threads stay visible", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-total-absent", {
      // No `aggregationData.total` at all.
      pages: [groupsPage({ conversations: ["grp-1"], offset: 0, done: true })],
    });
    await upsertPageDmConversation(appContext.db, seedThreadInput(stored.page.id, "grp-stale", 1));

    const { result, runId } = await runChunk(stored, telemetry, 5);

    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 2,
        observedCount: 1,
        generationSetCount: 1,
        providerTotalMode: "absent",
        providerReportedTotal: null,
        // Certified membership, but no total to bound it → nothing is hidden.
        membershipCertified: true,
        destructiveFinalization: false,
        finalizationWithheld: false,
        fullSweepCompleted: true,
      },
    });
    expect(telemetry.addNote).toHaveBeenCalledWith(
      expect.stringContaining("completed without a provider total"),
      expect.objectContaining({
        code: "dm_conversations_provider_total_absent_nondestructive",
        observedCount: 1,
        providerTotalMode: "absent",
      }),
    );
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    const threads = await readThreads(stored.page.id);
    expect(threads["grp-1"]).toMatchObject({ generation: 2, isVisible: true });
    expect(threads["grp-stale"]).toMatchObject({ generation: 1, isVisible: true });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toEqual({
      version: 2,
      generation: 2,
      observedCount: 1,
      generationSetCount: 1,
      providerTotalMode: "absent",
      providerReportedTotal: null,
      destructiveFinalization: false,
      membershipCertified: true,
      lastFullSweepCompletedAt: expect.any(String),
    });
    // A non-destructive sweep still counts as this stream's successful run.
    expect(checkpoint?.cursorLastSucceededRunId).toBe(runId);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("yields on the request budget and the next dispatch resumes from the persisted offset", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-budget-yield", {
      pages: [
        groupsPage({ conversations: ["grp-1"], total: 6, offset: 0, done: false }),
        groupsPage({ conversations: ["grp-2"], total: 6, offset: 100, done: false }),
        groupsPage({ conversations: ["grp-3"], total: 6, offset: 200, done: false }),
        groupsPage({ conversations: ["grp-4"], total: 6, offset: 300, done: false }),
        groupsPage({ conversations: ["grp-5"], total: 6, offset: 400, done: false }),
        // Only reachable from a SECOND dispatch, on the persisted checkpoint.
        groupsPage({ conversations: ["grp-6"], total: 6, offset: 500, done: true }),
      ],
    });

    const first = await runChunk(stored, telemetry, 5);

    expect(calls).toEqual([0, 100, 200, 300, 400].map((offset) => ({
      method: "messaging_groups",
      offset,
      limit: 100,
      sortOrder: 1,
      flags: 0,
    })));
    expect(first.result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: {
        generation: 1,
        offset: 500,
        pageCount: 5,
        observedCount: 5,
        processedConversations: 5,
        fullSweepCompleted: false,
      },
    });
    const progress = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    // The whole crash-safe contract in one document: mode + offset + counters.
    // `generationSetCount` rides along as telemetry — the parser drops it.
    expect(progress?.state).toEqual({
      version: 2,
      mode: "full_scan",
      generation: 1,
      offset: 500,
      observedCount: 5,
      pageCount: 5,
      providerTotalMode: "present",
      providerReportedTotal: 6,
      unchangedPageStreak: 0,
      fullSweepStartedAt: expect.any(String),
      lastFullSweepCompletedAt: null,
      generationSetCount: 5,
    });
    expect(progress?.cursorLastSucceededRunId ?? null).toBeNull();

    // Second dispatch — a crash between chunks looks exactly like this: a new
    // run, a new budget, and nothing but the checkpoint above to go on.
    const second = await runChunk(stored, telemetry, 5);

    expect(calls.at(-1)).toEqual({
      method: "messaging_groups",
      offset: 500,
      limit: 100,
      sortOrder: 1,
      flags: 0,
    });
    expect(calls).toHaveLength(6);
    expect(second.result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 1,
        offset: 500,
        pageCount: 6,
        observedCount: 6,
        generationSetCount: 6,
        // Per-chunk, not per-sweep: only this dispatch's page counts.
        processedConversations: 1,
        membershipCertified: true,
        destructiveFinalization: true,
        fullSweepCompleted: true,
      },
    });
    const completed = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(completed?.state).toEqual({
      version: 2,
      generation: 1,
      observedCount: 6,
      generationSetCount: 6,
      providerTotalMode: "present",
      providerReportedTotal: 6,
      destructiveFinalization: true,
      membershipCertified: true,
      lastFullSweepCompletedAt: expect.any(String),
    });
    expect(completed?.cursorLastSucceededRunId).toBe(second.runId);
    expect(Object.keys(await readThreads(stored.page.id))).toEqual([
      "grp-1",
      "grp-2",
      "grp-3",
      "grp-4",
      "grp-5",
      "grp-6",
    ]);
    // One follow-up request per applied page that needed one: 6 pages.
    expect(await readDmMessagesRequest(stored.page.id))
      .toMatchObject({ requestSeq: DM_MESSAGES_SEED_REQUEST_SEQ + 6 });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("restarts the sweep when the provider total drifts between offset pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-total-drift", {
      pages: [
        groupsPage({ conversations: ["grp-1"], total: 3, offset: 0, done: false }),
        // Same sweep, different aggregationData.total.
        groupsPage({ conversations: ["grp-2"], total: 4, offset: 100, done: true }),
      ],
    });

    await expect(runChunk(stored, telemetry, 5))
      .rejects.toThrow("restarted the DM conversation sweep");

    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
      { method: "messaging_groups", offset: 100, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_provider_total_drift_guard",
      severity: "error",
      details: expect.objectContaining({
        providerTotalMode: "present",
        currentProviderTotalMode: "present",
        providerReportedTotal: 3,
        currentProviderReportedTotal: 4,
        observedCount: 1,
        pageCount: 2,
        offset: 100,
        abandonedGeneration: 1,
        restartGeneration: 2,
      }),
    }));
    // The drift check runs before hydration, so page 2 costs no group-detail
    // and no head-repair request and writes no thread: only page 1 stands.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": {
        generation: 1,
        isVisible: true,
        lastMessageId: "msg-grp-1",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toEqual({
      version: 2,
      mode: "full_scan",
      generation: 2,
      offset: 0,
      observedCount: 0,
      pageCount: 0,
      providerTotalMode: "unobserved",
      providerReportedTotal: null,
      unchangedPageStreak: 0,
      fullSweepStartedAt: expect.any(String),
      lastFullSweepCompletedAt: null,
    });
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("never revisits a thread whose head changed behind the sweep cursor; the next sweep picks it up", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-head-behind-cursor", {
      pages: [
        // Sweep 1, page 1 — grp-1 is applied here and never listed again.
        groupsPage({ conversations: ["grp-1", "grp-2"], total: 3, offset: 0, done: false }),
        // Sweep 1, page 2 — meanwhile a fan replied in grp-1, which now sits
        // at the top of the provider's sortOrder=1 list, BEHIND this cursor.
        groupsPage({ conversations: ["grp-3"], total: 3, offset: 100, done: true }),
        // Sweep 2 sees the new head.
        groupsPage({
          conversations: [
            {
              groupId: "grp-1",
              lastMessageId: "msg-grp-1-v2",
              headContent: "reply that landed behind the cursor",
              headCreatedAt: Date.UTC(2026, 2, 11, 9, 0, 0),
            },
            "grp-2",
            "grp-3",
          ],
          total: 3,
          offset: 0,
          done: true,
        }),
      ],
    });

    // Chunk 1 stops on a one-request budget, mid-sweep.
    const first = await runChunk(stored, telemetry, 1);
    expect(first.result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { generation: 1, offset: 100, observedCount: 2 },
    });

    // Chunk 2 finishes the sweep from offset 100 and certifies it.
    const second = await runChunk(stored, telemetry, 5);
    expect(second.result).toMatchObject({
      satisfied: true,
      stats: { observedCount: 3, generationSetCount: 3, membershipCertified: true },
    });
    // CURRENT BEHAVIOR: the sweep completed "successfully" while grp-1's head
    // is already stale in the database — a full offset walk has no way to see
    // a change behind its own cursor.
    expect(await readThreadHead(stored.page.id, "grp-1")).toMatchObject({
      lastMessageId: "msg-grp-1",
      lastMessageAt: new Date(HEAD_CREATED_AT_MS).toISOString(),
      lastMessagePreview: "hello from grp-1",
    });

    for (const conversationId of ["grp-1", "grp-2", "grp-3"]) {
      await markThreadSynced(stored.page.id, conversationId);
    }
    const beforeSecondSweep = await readDmMessagesRequest(stored.page.id);
    // Sweep 1 applied two pages, each with a new thread on it.
    expect(beforeSecondSweep.requestSeq).toBe(DM_MESSAGES_SEED_REQUEST_SEQ + 2);

    // Sweep 2 (fresh generation, offset 0) is the first thing that can see it.
    const third = await runChunk(stored, telemetry, 5);

    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
      { method: "messaging_groups", offset: 100, limit: 100, sortOrder: 1, flags: 0 },
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(third.result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 2,
        observedCount: 3,
        generationSetCount: 3,
        repairedHeads: 0,
        membershipCertified: true,
        destructiveFinalization: true,
      },
    });
    expect(await readThreadHead(stored.page.id, "grp-1")).toMatchObject({
      lastMessageId: "msg-grp-1-v2",
      lastMessageAt: new Date(Date.UTC(2026, 2, 11, 9, 0, 0)).toISOString(),
      lastMessagePreview: "reply that landed behind the cursor",
      // The stored-message pointer still trails the new head — that is exactly
      // what the follow-up below is for.
      newestStoredMessageId: "msg-grp-1",
    });
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": {
        generation: 2,
        isVisible: true,
        lastMessageId: "msg-grp-1-v2",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
      "grp-2": {
        generation: 2,
        isVisible: true,
        lastMessageId: "msg-grp-2",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
      "grp-3": {
        generation: 2,
        isVisible: true,
        lastMessageId: "msg-grp-3",
        unreadCount: 0,
        conversationFlags: 0,
        subscriptionTierId: null,
        lastUnreadMessageId: null,
      },
    });
    // Exactly one new follow-up: the page carried one moved head.
    expect(await readDmMessagesRequest(stored.page.id))
      .toMatchObject({ requestSeq: beforeSecondSweep.requestSeq + 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("repairs a deleted head with a limit-1 messages request per affected thread", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-head-deleted", {
      pages: [
        groupsPage({ conversations: ["grp-repair", "grp-empty"], total: 2, offset: 0, done: true }),
        // Both heads are gone from the provider: no lastMessageId on the item
        // AND no lastMessage in the aggregation block.
        groupsPage({
          conversations: [
            { groupId: "grp-repair", lastMessageId: null, headMissing: true },
            { groupId: "grp-empty", lastMessageId: null, headMissing: true },
          ],
          total: 2,
          offset: 0,
          done: true,
        }),
      ],
      headRepairs: {
        // The message that survived under the deleted head…
        "grp-repair": [{
          id: "msg-grp-repair-older",
          senderId: "fan-grp-repair",
          content: "older surviving message",
          createdAt: Date.UTC(2026, 2, 8, 12, 0, 0),
        }],
        // …and a thread whose history is now empty.
        "grp-empty": [],
      },
    });

    await runChunk(stored, telemetry, 5);
    for (const conversationId of ["grp-repair", "grp-empty"]) {
      await markThreadSynced(stored.page.id, conversationId);
    }
    const beforeRepair = await readDmMessagesRequest(stored.page.id);
    expect(beforeRepair.requestSeq).toBe(DM_MESSAGES_SEED_REQUEST_SEQ + 1);

    const { result } = await runChunk(stored, telemetry, 5);

    // One group page, then one head repair per thread whose head vanished, in
    // page order. No group-detail request: the partner resolved from the
    // aggregation block.
    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
      { method: "head_repair", groupId: "grp-repair", limit: 1 },
      { method: "head_repair", groupId: "grp-empty", limit: 1 },
    ]);
    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: 2,
        observedCount: 2,
        generationSetCount: 2,
        processedConversations: 2,
        // Only the thread whose repair returned a message counts as repaired.
        repairedHeads: 1,
        membershipCertified: true,
        destructiveFinalization: true,
      },
    });
    // CURRENT BEHAVIOR: `preserveHeadForRetry` (executor-handlers.ts:3282) only
    // holds the previous head when the provider still reports SOME id, so a
    // deleted head nulls `last_message_id` while the rest of the head block is
    // taken from the repaired (older) message. Id and preview then describe
    // different messages.
    expect(await readThreadHead(stored.page.id, "grp-repair")).toEqual({
      lastMessageId: null,
      lastMessageAt: new Date(Date.UTC(2026, 2, 8, 12, 0, 0)).toISOString(),
      lastMessageSenderId: "fan-grp-repair",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "older surviving message",
      // Still points at the deleted message.
      newestStoredMessageId: "msg-grp-repair",
      messageCoverageStatus: "complete",
    });
    // An empty repair keeps the previous head block and only drops the id.
    expect(await readThreadHead(stored.page.id, "grp-empty")).toEqual({
      lastMessageId: null,
      lastMessageAt: new Date(HEAD_CREATED_AT_MS).toISOString(),
      lastMessageSenderId: "fan-grp-empty",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "hello from grp-empty",
      newestStoredMessageId: "msg-grp-empty",
      messageCoverageStatus: "complete",
    });
    // One follow-up for the page. It is grp-empty that asks for it (its
    // preserved lastMessageAt is newer than its last message sync); grp-repair,
    // whose repaired head is OLDER than that sync, asks for nothing even though
    // its stored head id no longer exists.
    expect(await readDmMessagesRequest(stored.page.id))
      .toMatchObject({ requestSeq: beforeRepair.requestSeq + 1 });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("applies an unread-only change and requests no dm_messages follow-up", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-unread-only", {
      pages: [
        groupsPage({ conversations: ["grp-1"], total: 1, offset: 0, done: true }),
        // Same head, three unread messages now.
        groupsPage({
          conversations: [{ groupId: "grp-1", unreadCount: 3 }],
          total: 2,
          offset: 0,
          done: false,
        }),
      ],
    });

    await runChunk(stored, telemetry, 5);
    await markThreadSynced(stored.page.id, "grp-1");
    expect((await readDmMessagesRequest(stored.page.id)).requestSeq)
      .toBe(DM_MESSAGES_SEED_REQUEST_SEQ + 1);

    const { result } = await runChunk(stored, telemetry, 1);

    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { generation: 2, offset: 100, observedCount: 1, processedConversations: 1 },
    });
    const threads = await readThreads(stored.page.id);
    expect(threads["grp-1"]).toEqual({
      generation: 2,
      isVisible: true,
      lastMessageId: "msg-grp-1",
      unreadCount: 3,
      conversationFlags: 0,
      subscriptionTierId: null,
      lastUnreadMessageId: null,
    });
    // The head did not move and the stored head still matches it, so the
    // sibling stream is not woken: unread alone is not new-message evidence.
    expect(await readDmMessagesRequest(stored.page.id))
      .toMatchObject({ requestSeq: DM_MESSAGES_SEED_REQUEST_SEQ + 1 });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    // unreadCount IS part of the changed-page predicate, so the streak resets.
    expect(checkpoint?.state).toMatchObject({
      mode: "full_scan",
      generation: 2,
      offset: 100,
      observedCount: 1,
      pageCount: 1,
      unchangedPageStreak: 0,
      generationSetCount: 1,
      // The completed sweep's UX timestamp survives into the next sweep.
      lastFullSweepCompletedAt: expect.any(String),
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts a page as unchanged when only flags, lastUnreadMessageId and subscriptionTierId moved (current behavior, not desired)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored, calls } = await seedPage("sweep-flags-only", {
      pages: [
        groupsPage({ conversations: ["grp-1"], total: 1, offset: 0, done: true }),
        // Same head, same unread — but three other provider fields moved.
        groupsPage({
          conversations: [{
            groupId: "grp-1",
            flags: 2,
            lastUnreadMessageId: "msg-grp-1",
            subscriptionTierId: "tier-vip",
          }],
          total: 2,
          offset: 0,
          done: false,
        }),
      ],
    });

    await runChunk(stored, telemetry, 5);
    await markThreadSynced(stored.page.id, "grp-1");

    const { result } = await runChunk(stored, telemetry, 1);

    expect(calls).toEqual([
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
      { method: "messaging_groups", offset: 0, limit: 100, sortOrder: 1, flags: 0 },
    ]);
    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: "request_budget",
      stats: { generation: 2, offset: 100, processedConversations: 1 },
    });
    // The row DOES get the new values — the write is unconditional.
    const threads = await readThreads(stored.page.id);
    expect(threads["grp-1"]).toEqual({
      generation: 2,
      isVisible: true,
      lastMessageId: "msg-grp-1",
      unreadCount: 0,
      conversationFlags: 2,
      subscriptionTierId: "tier-vip",
      lastUnreadMessageId: "msg-grp-1",
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    // CURRENT BEHAVIOR, NOT DESIRED: the changed-page predicate
    // (executor-handlers.ts:3286-3295) compares only lastMessageId,
    // unreadCount, isVisible and the two metadata reasons — so a page on which
    // conversationFlags, lastUnreadMessageId and subscriptionTierId all moved
    // is classified "unchanged" and the streak grows. Harmless today only
    // because nothing reads `unchangedPageStreak` back (it is written to the
    // cursor and never consulted); a refactor that starts trusting the streak
    // — to skip pages, shorten a sweep, or throttle — would act on a lie.
    expect(checkpoint?.state).toMatchObject({
      mode: "full_scan",
      generation: 2,
      offset: 100,
      observedCount: 1,
      pageCount: 1,
      unchangedPageStreak: 1,
      generationSetCount: 1,
    });
    // Same head, stored head still matching → no follow-up either: only the
    // seeding bump and sweep 1's remain.
    expect(await readDmMessagesRequest(stored.page.id))
      .toMatchObject({ requestSeq: DM_MESSAGES_SEED_REQUEST_SEQ + 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

// G3 (checkpoint cutover) — the Fansly dm_conversations sweep's membership is
// now the row-side generation set (page_dm_threads.last_seen_generation) plus
// one persisted count, and the cumulative `snapshotConversationIds` array is
// gone from page_sync_cursors.state. These run against a real Postgres because
// the thing under test IS the database: which rows carry the generation, what
// the page transaction sees when it counts them, and whether the destructive
// finalization is allowed to run at all.
//
// The two-page baseline below is the behavior recorded from the pre-G3 code at
// main @ 61f7c1dd (tests/fansly-dm-dual-proof.integration.test.ts, "proves a
// two-page sweep against the generation set", green on that checkout): the
// same three threads visible at the same generation. G3 must reproduce it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeErasureLog,
  createFanslyPage,
  createModel,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  insertErasureLog,
  startSyncRun,
  upsertCheckpointProgress,
  upsertPageDmConversation,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const PAGE_ACCOUNT_ID = "acct-generation-membership";
const SWEEP_GENERATION = 7;
/** Far enough back that an erasure recorded during the test lands inside it. */
const SWEEP_STARTED_AT = new Date(Date.now() - 60_000).toISOString();

let testDb: StartedTestDatabase | null = null;

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  };
}

/** One provider page shaped so the sweep resolves every partner from the
 *  aggregation block — no group-detail fetch, no head repair, no second
 *  adapter method to stub. */
function groupsPage(input: { groupIds: string[]; total: number | null; offset: number; done: boolean }) {
  const items = input.groupIds.map((groupId) => ({
    groupId,
    flags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: `msg-${groupId}`,
    lastUnreadMessageId: null,
    partnerAccountId: `fan-${groupId}`,
    partnerUsername: `fan_${groupId}`,
  }));
  const accounts = input.groupIds.map((groupId) => ({
    id: `fan-${groupId}`,
    username: `fan_${groupId}`,
    displayName: `Fan ${groupId}`,
  }));
  const groups = input.groupIds.map((groupId) => ({
    id: groupId,
    users: [
      { groupId, userId: PAGE_ACCOUNT_ID },
      { groupId, userId: `fan-${groupId}` },
    ],
    lastMessage: {
      id: `msg-${groupId}`,
      senderId: `fan-${groupId}`,
      content: `hello from ${groupId}`,
      createdAt: Date.UTC(2026, 2, 10, 12, 0, 0),
    },
  }));

  return {
    total: input.total,
    items,
    accounts,
    groups,
    offset: input.offset,
    done: input.done,
    raw: { data: items, aggregationData: { total: input.total, accounts, groups } },
  };
}

/** Serves the queued pages in order and depletes the chunk budget the way the
 *  real transport does. */
function sweepAdapter(pages: ReturnType<typeof groupsPage>[]) {
  let call = 0;
  const getMessagingGroupsPage = vi.fn(async (
    requestContext: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
  ) => {
    const page = pages[call];
    if (!page) {
      throw new Error(`unexpected messaging-groups call #${call + 1}`);
    }
    call += 1;
    await requestContext.requestObserver?.onRequestEvent({
      requestId: `dm-conversations-${call}`,
      operation: "messaging_groups",
      endpointTemplate: "/messaging/groups",
      method: "GET",
      attemptNumber: 1,
      timestamp: new Date(),
      state: "started",
    });
    return page;
  });

  return { getMessagingGroupsPage } as never;
}

function seedThreadInput(
  platformAccountId: number,
  platformConversationId: string,
  lastSeenGeneration: number,
) {
  return {
    platformAccountId,
    fanId: null,
    platformConversationId,
    partnerPlatformUserId: `fan-${platformConversationId}`,
    partnerUsername: `fan_${platformConversationId}`,
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: `msg-${platformConversationId}`,
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-03-09T12:00:00.000Z"),
    lastMessageSenderId: `fan-${platformConversationId}`,
    lastMessageSenderRole: "fan" as const,
    lastMessagePreview: "seeded",
    isVisible: true,
    lastSeenGeneration,
    metadata: {},
  };
}

describe("Fansly dm_conversations generation membership (G3)", () => {
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

  async function seedPage(label: string, pages: ReturnType<typeof groupsPage>[]) {
    appContext = createTestAppContext(testDb!, {
      syncSharedRateLimitEnabled: true,
      adapter: sweepAdapter(pages),
    });
    const model = await createModel(appContext.db, { slug: `${label}-model`, name: label });
    if (!model) throw new Error("model seed failed");
    const page = await createFanslyPage(appContext.db, { modelId: model.id, label });
    if (!page) throw new Error("page seed failed");
    await ensurePageSyncStates(appContext.db, { pageId: page.id });
    const stored = await findPageById(appContext.db, page.id);
    if (!stored) throw new Error("page reload failed");
    return { page, stored };
  }

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

    return fanslyDmConversationsChunk(appContext, {
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
  }

  async function readThreads(platformAccountId: number) {
    const { rows } = await testDb!.pool.query<{
      platform_conversation_id: string;
      last_seen_generation: string | null;
      is_visible: boolean;
    }>(
      `select t.platform_conversation_id, t.last_seen_generation, t.is_visible
       from page_dm_threads t
       where t.platform_account_id = $1
       order by t.platform_conversation_id`,
      [platformAccountId],
    );
    return Object.fromEntries(rows.map((row) => [row.platform_conversation_id, {
      generation: row.last_seen_generation === null ? null : Number(row.last_seen_generation),
      isVisible: row.is_visible,
    }]));
  }

  /** Resumes a sweep whose first page already landed, so the terminal page can
   *  drive the completion verdict directly. v2: a count, no id array. */
  async function seedResumedCheckpoint(pageId: number, observedCount: number) {
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: pageId,
      stream: "dm_conversations",
      state: {
        version: 2,
        mode: "full_scan",
        generation: SWEEP_GENERATION,
        offset: 100,
        observedCount,
        pageCount: 1,
        providerTotalMode: "present",
        providerReportedTotal: 3,
        unchangedPageStreak: 0,
        fullSweepStartedAt: SWEEP_STARTED_AT,
        lastFullSweepCompletedAt: null,
      },
    });
  }

  async function seedOwner(username: string) {
    const owner = await createUserAccount(
      appContext,
      { username, role: "owner", password: "owner-secret" },
      { source: "cli" },
    );
    if (!owner) throw new Error("owner seed failed");
    return owner;
  }

  it("walks a two-page sweep and finalizes exactly as the pre-G3 array did", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-agree", [
      groupsPage({ groupIds: ["grp-1", "grp-2"], total: 3, offset: 0, done: false }),
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        observedCount: 3,
        generationSetCount: 3,
        membershipCertified: true,
        destructiveFinalization: true,
        fullSweepCompleted: true,
      },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({
      version: 2,
      generation: 1,
      observedCount: 3,
      generationSetCount: 3,
      membershipCertified: true,
      destructiveFinalization: true,
    });
    expect(checkpoint?.state).not.toHaveProperty("snapshotConversationIds");
    expect(checkpoint?.state).not.toHaveProperty("erasureDelta");
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).not.toHaveBeenCalled();
    // Byte-for-byte the pre-G3 outcome.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: 1, isVisible: true },
      "grp-2": { generation: 1, isVisible: true },
      "grp-3": { generation: 1, isVisible: true },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("resumes a v2 checkpoint, keeps its observed count, and hides only the threads it did not see", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-resume", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    // What the interrupted first page left behind: two stamped rows and the
    // count that says so. Nothing in the checkpoint names them any more.
    for (const conversationId of ["grp-1", "grp-2"]) {
      await upsertPageDmConversation(
        appContext.db,
        seedThreadInput(stored.page.id, conversationId, SWEEP_GENERATION),
      );
    }
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-gone", SWEEP_GENERATION - 1),
    );
    await seedResumedCheckpoint(stored.page.id, 2);

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        generation: SWEEP_GENERATION,
        // 2 carried across the resume + 1 from the terminal page.
        observedCount: 3,
        generationSetCount: 3,
        membershipCertified: true,
        destructiveFinalization: true,
        fullSweepCompleted: true,
      },
    });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-2": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-3": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-gone": { generation: SWEEP_GENERATION - 1, isVisible: false },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("withholds the destructive finalization when a stamped row is missing for no reason", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-shortfall", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    // The checkpoint says the first page saw two conversations; only one of
    // them carries the generation. Pre-G3 the array decided alone and the
    // finalization hid "grp-live" — a LIVE thread — anyway.
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-live", SWEEP_GENERATION - 1),
    );
    await seedResumedCheckpoint(stored.page.id, 2);

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({
      satisfied: false,
      stats: {
        observedCount: 3,
        generationSetCount: 2,
        membershipCertified: false,
        finalizationWithheld: true,
        destructiveFinalization: false,
        fullSweepCompleted: false,
      },
    });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_generation_membership_guard",
      severity: "error",
      details: expect.objectContaining({
        generation: SWEEP_GENERATION,
        observedCount: 3,
        generationSetCount: 2,
        finalizationWithheld: true,
      }),
    }));
    // Nothing was hidden — including the thread the pre-G3 sweep would have
    // hidden on the same evidence.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-3": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-live": { generation: SWEEP_GENERATION - 1, isVisible: true },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({
      membershipCertified: false,
      destructiveFinalization: false,
      lastFullSweepCompletedAt: null,
    });
    // A refused finalization is not this stream's last successful run.
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();
    expect(checkpoint?.cursorLastSucceededAt ?? null).toBeNull();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("still withholds when an erasure inside the sweep window could explain the shortfall", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-erasure", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-gone", SWEEP_GENERATION - 1),
    );
    // The second thread page 1 stamped was legitimately deleted by the Stage-28
    // module mid-sweep: the row is gone, the count still counts it.
    await seedResumedCheckpoint(stored.page.id, 2);

    const owner = await seedOwner("erasure-owner");
    const erasure = await insertErasureLog(appContext.db, {
      scopeType: "fan",
      scopeRef: "fan-erased-1",
      initiatedBy: owner.id,
      dryRun: false,
      plan: { scopeType: "fan", scopeRef: "fan-erased-1", resolvedPageIds: [stored.page.id] },
    });
    await completeErasureLog(appContext.db, {
      id: erasure.id,
      executedCounts: { "hot:page_dm_threads:delete": 1 },
    });

    const result = await runChunk(stored, telemetry, 5);

    // The erasure log says an erasure touched this page — not that it deleted
    // the row that is missing. A lost stamp beside an abandoned erasure looks
    // exactly like this, so the sweep refuses to hide anything on it and lets
    // the next sweep, under a fresh generation, settle the question.
    expect(result).toMatchObject({
      satisfied: false,
      stats: {
        membershipCertified: false,
        finalizationWithheld: true,
        destructiveFinalization: false,
        fullSweepCompleted: false,
      },
    });
    // Calm, not an incident: the shortfall has a plausible benign cause.
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).toHaveBeenCalledWith(
      expect.stringContaining("an erasure could have removed inside the sweep window"),
      expect.objectContaining({
        code: "dm_conversations_dual_proof_erasure_delta",
        erasureDelta: 1,
        observedCount: 3,
        generationSetCount: 2,
        finalizationWithheld: true,
      }),
    );
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({ membershipCertified: false, erasureDelta: 1 });
    expect(checkpoint?.cursorLastSucceededRunId ?? null).toBeNull();
    // Decision #208: stale visibility beats a thread vanishing from every
    // chatter's list. "grp-gone" is genuinely gone and STAYS VISIBLE here.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-3": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-gone": { generation: SWEEP_GENERATION - 1, isVisible: true },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("ignores a dry-run erasure, a stale completed one, and a superseded one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-erasure-noise", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await seedResumedCheckpoint(stored.page.id, 2);

    const owner = await seedOwner("erasure-owner");
    // A dry run deletes nothing…
    await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "membership-erasure-noise",
      initiatedBy: owner.id,
      dryRun: true,
      plan: { resolvedPageIds: [stored.page.id] },
    });
    // …and an execution that finished before the sweep started cannot explain
    // rows the sweep itself stamped.
    const stale = await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "membership-erasure-noise",
      initiatedBy: owner.id,
      dryRun: false,
      plan: { resolvedPageIds: [stored.page.id] },
    });
    await testDb.pool.query(
      `update erasure_log
         set started_at = $2::timestamptz - interval '2 hours',
             completed_at = $2::timestamptz - interval '2 hours',
             resolution_kind = 'completed',
             resolved_at = $2::timestamptz - interval '2 hours'
       where id = $1`,
      [stale.id, SWEEP_STARTED_AT],
    );
    // …and neither can a SUPERSEDED attempt that was resolved before the sweep
    // started. Its completed_at is null by the schema's resolution-shape check,
    // so a completed_at-only window would call it live forever and excuse every
    // future shortfall on this page.
    const superseder = await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "membership-erasure-noise-other",
      initiatedBy: owner.id,
      dryRun: false,
      // Deliberately does NOT touch this page, so only the superseded row
      // below is under test here.
      plan: { resolvedPageIds: [] },
    });
    const superseded = await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "membership-erasure-noise",
      initiatedBy: owner.id,
      dryRun: false,
      plan: { resolvedPageIds: [stored.page.id] },
    });
    await testDb.pool.query(
      `update erasure_log
         set started_at = $2::timestamptz - interval '3 hours',
             resolution_kind = 'superseded',
             resolved_at = $2::timestamptz - interval '3 hours',
             superseded_by_id = $3
       where id = $1`,
      [superseded.id, SWEEP_STARTED_AT, superseder.id],
    );

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({ satisfied: false, stats: { finalizationWithheld: true } });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_generation_membership_guard",
    }));
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).not.toHaveProperty("erasureDelta");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("defers the chunk while an erasure holds the page fence, and writes nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-fence", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await seedResumedCheckpoint(stored.page.id, 2);
    const before = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");

    // Exactly what executeErasure holds while it deletes: the EXCLUSIVE
    // transaction-scoped lock on (namespace, page id), from another session.
    const erasureSession = await testDb.pool.connect();
    let result: Awaited<ReturnType<typeof runChunk>>;
    try {
      await erasureSession.query("begin");
      await erasureSession.query("select pg_advisory_xact_lock($1, $2)", [
        DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
        stored.page.id,
      ]);
      // No throw: a fenced chunk yields, it does not fail.
      result = await runChunk(stored, telemetry, 5);
    } finally {
      await erasureSession.query("rollback");
      erasureSession.release();
    }

    expect(result).toMatchObject({
      satisfied: false,
      yieldReason: null,
      continuationRequestSource: "scheduled",
      stats: { erasureFenceDeferred: true, observedCount: 2, fullSweepCompleted: false },
    });
    expect(result.continuationRetryAt).toBeInstanceOf(Date);
    expect(telemetry.addNote).toHaveBeenCalledWith(
      expect.stringContaining("erasure held the page fence"),
      expect.objectContaining({ code: "dm_conversations_erasure_fence_deferred", offset: 100 }),
    );
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    // The page it fetched was journaled (DP-7) and nothing else moved: no new
    // thread, no stamp, no checkpoint advance.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: SWEEP_GENERATION, isVisible: true },
    });
    const after = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(after?.state).toEqual(before?.state);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("restarts the sweep when the provider repeats a conversation id across offset pages", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-overlap", [
      groupsPage({ groupIds: ["grp-1"], total: 2, offset: 0, done: false }),
      // The same id again on the next offset page — pagination drift.
      groupsPage({ groupIds: ["grp-1"], total: 2, offset: 100, done: true }),
    ]);

    await expect(runChunk(stored, telemetry, 5))
      .rejects.toThrow("restarted the DM conversation sweep");

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_snapshot_overlap_guard",
      severity: "error",
      details: expect.objectContaining({
        overlappingConversationIds: ["grp-1"],
        overlapCount: 1,
        observedCount: 1,
        abandonedGeneration: 1,
        restartGeneration: 2,
      }),
    }));
    // The first page stands (it was applied and committed); the second was
    // refused, and the next sweep starts above the stamp the first one left.
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: 1, isVisible: true },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({ version: 2, generation: 2, offset: 0, observedCount: 0 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts an id repeated across offset pages once when the provider sends no total", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("membership-overlap-total-absent", [
      groupsPage({ groupIds: ["grp-1", "grp-2"], total: null, offset: 0, done: false }),
      // grp-2 again: a thread below the cursor jumped to the top between the
      // two requests. Fansly has never sent a total for this list.
      groupsPage({ groupIds: ["grp-2", "grp-3"], total: null, offset: 100, done: true }),
    ]);

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({
      satisfied: true,
      stats: {
        observedCount: 3,
        generationSetCount: 3,
        membershipCertified: true,
        destructiveFinalization: false,
        finalizationWithheld: false,
        fullSweepCompleted: true,
        crossPageRepeats: 1,
      },
    });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        code: "dm_conversations_cross_page_repeat_counted_once",
        repeatedConversationIds: ["grp-2"],
        repeatCount: 1,
      }),
    );
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: 1, isVisible: true },
      "grp-2": { generation: 1, isVisible: true },
      "grp-3": { generation: 1, isVisible: true },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.cursorLastSucceededRunId ?? null).not.toBeNull();
    expect(checkpoint?.state).toMatchObject({
      version: 2,
      generation: 1,
      observedCount: 3,
      generationSetCount: 3,
      providerTotalMode: "absent",
      membershipCertified: true,
      destructiveFinalization: false,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

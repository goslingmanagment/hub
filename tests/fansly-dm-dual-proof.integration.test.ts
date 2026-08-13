// G2 slice 2 — the dual proof runs against a real Postgres because the thing
// under test IS the database: the cumulative `snapshotConversationIds` array in
// page_sync_cursors.state versus the rows the sweep stamped, read off
// page_dm_threads_generation_idx. Nothing here changes behavior; the array is
// still the authority, and these tests pin that alongside the new evidence.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeErasureLog,
  createFanslyPage,
  createModel,
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
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/executor-handlers.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const PAGE_ACCOUNT_ID = "acct-dual-proof";
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
function groupsPage(input: { groupIds: string[]; total: number; offset: number; done: boolean }) {
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

describe("Fansly dm_conversations dual proof (G2 slice 2)", () => {
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
   *  drive the completion verdict directly. */
  async function seedResumedCheckpoint(pageId: number, snapshotConversationIds: string[]) {
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: pageId,
      stream: "dm_conversations",
      state: {
        version: 1,
        mode: "full_scan",
        generation: SWEEP_GENERATION,
        offset: 100,
        observedCount: snapshotConversationIds.length,
        snapshotConversationIds,
        pageCount: 1,
        providerTotalMode: "present",
        providerReportedTotal: 3,
        unchangedPageStreak: 0,
        fullSweepStartedAt: SWEEP_STARTED_AT,
        lastFullSweepCompletedAt: null,
      },
    });
  }

  it("proves a two-page sweep against the generation set", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("dual-proof-agree", [
      groupsPage({ groupIds: ["grp-1", "grp-2"], total: 3, offset: 0, done: false }),
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({
      satisfied: true,
      stats: { observedCount: 3, destructiveFinalization: true, fullSweepCompleted: true },
    });
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({
      generation: 1,
      observedCount: 3,
      dualProofOk: true,
      dualProofSetCount: 3,
    });
    expect(checkpoint?.state).not.toHaveProperty("dualProofErasureDelta");
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).not.toHaveBeenCalled();
    expect(await readThreads(stored.page.id)).toEqual({
      "grp-1": { generation: 1, isVisible: true },
      "grp-2": { generation: 1, isVisible: true },
      "grp-3": { generation: 1, isVisible: true },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("raises an anomaly when a stamp regressed behind the sweep, and finalizes per the legacy array", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("dual-proof-regressed", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    // The sweep's first page stamped both threads; a racing writer then left
    // "ghost-1" behind at the previous generation (pre-G2 this was possible,
    // and the destructive finalization below then hid a LIVE thread).
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "ghost-1", SWEEP_GENERATION - 1),
    );
    await seedResumedCheckpoint(stored.page.id, ["ghost-1", "grp-1"]);

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({ satisfied: true, stats: { fullSweepCompleted: true } });
    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_dual_proof_mismatch",
      severity: "warn",
      details: expect.objectContaining({
        generation: SWEEP_GENERATION,
        snapshotCount: 3,
        generationSetCount: 2,
        missingFromGenerationSet: ["ghost-1"],
        missingFromGenerationSetCount: 1,
        missingFromSnapshot: [],
        missingFromSnapshotCount: 0,
      }),
    }));
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({
      dualProofOk: false,
      dualProofSetCount: 2,
      observedCount: 3,
    });
    expect(checkpoint?.state).not.toHaveProperty("dualProofErasureDelta");
    // Behavior unchanged: the array still decided, so the trailing thread is
    // hidden exactly as it was before the shadow existed.
    expect(await readThreads(stored.page.id)).toEqual({
      "ghost-1": { generation: SWEEP_GENERATION - 1, isVisible: false },
      "grp-1": { generation: SWEEP_GENERATION, isVisible: true },
      "grp-3": { generation: SWEEP_GENERATION, isVisible: true },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("records an erasure delta note instead of an anomaly when an erasure ran inside the sweep window", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("dual-proof-erasure", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    // "erased-1" was stamped by page 1 and then legitimately deleted by the
    // Stage-28 module — the row is gone, the cumulative array still names it.
    await seedResumedCheckpoint(stored.page.id, ["erased-1", "grp-1"]);

    const owner = await createUserAccount(
      appContext,
      { username: "erasure-owner", role: "owner", password: "owner-secret" },
      { source: "cli" },
    );
    const erasure = await insertErasureLog(appContext.db, {
      scopeType: "fan",
      scopeRef: "fan-erased-1",
      initiatedBy: owner!.id,
      dryRun: false,
      plan: { scopeType: "fan", scopeRef: "fan-erased-1", resolvedPageIds: [stored.page.id] },
    });
    await completeErasureLog(appContext.db, {
      id: erasure.id,
      executedCounts: { "hot:page_dm_threads:delete": 1 },
    });

    const result = await runChunk(stored, telemetry, 5);

    expect(result).toMatchObject({ satisfied: true, stats: { fullSweepCompleted: true } });
    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    expect(telemetry.addNote).toHaveBeenCalledWith(
      expect.stringContaining("an erasure removed inside the sweep window"),
      expect.objectContaining({
        code: "dm_conversations_dual_proof_erasure_delta",
        dualProofErasureDelta: 1,
        observedCount: 3,
        generationSetCount: 2,
      }),
    );
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({
      dualProofOk: false,
      dualProofSetCount: 2,
      dualProofErasureDelta: 1,
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("accepts a genuinely in-flight erasure as an explanation", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("dual-proof-erasure-inflight", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await seedResumedCheckpoint(stored.page.id, ["erased-1", "grp-1"]);

    const owner = await createUserAccount(
      appContext,
      { username: "erasure-owner", role: "owner", password: "owner-secret" },
      { source: "cli" },
    );
    // Neither completed nor resolved: the tombstone commits before the delete
    // transaction, so this is exactly what a sweep racing a live erasure sees.
    await insertErasureLog(appContext.db, {
      scopeType: "fan",
      scopeRef: "fan-erased-1",
      initiatedBy: owner!.id,
      dryRun: false,
      plan: { resolvedPageIds: [stored.page.id] },
    });

    await runChunk(stored, telemetry, 5);

    expect(telemetry.addAnomaly).not.toHaveBeenCalled();
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).toMatchObject({ dualProofOk: false, dualProofErasureDelta: 1 });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("ignores a dry-run erasure, a stale completed one, and a superseded one", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const telemetry = fakeTelemetry();
    const { stored } = await seedPage("dual-proof-erasure-noise", [
      groupsPage({ groupIds: ["grp-3"], total: 3, offset: 100, done: true }),
    ]);
    await upsertPageDmConversation(
      appContext.db,
      seedThreadInput(stored.page.id, "grp-1", SWEEP_GENERATION),
    );
    await seedResumedCheckpoint(stored.page.id, ["erased-1", "grp-1"]);

    const owner = await createUserAccount(
      appContext,
      { username: "erasure-owner", role: "owner", password: "owner-secret" },
      { source: "cli" },
    );
    // A dry run deletes nothing…
    await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "dual-proof-erasure-noise",
      initiatedBy: owner!.id,
      dryRun: true,
      plan: { resolvedPageIds: [stored.page.id] },
    });
    // …and an execution that finished before the sweep started cannot explain
    // rows the sweep itself stamped.
    const stale = await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "dual-proof-erasure-noise",
      initiatedBy: owner!.id,
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
      scopeRef: "dual-proof-erasure-noise-other",
      initiatedBy: owner!.id,
      dryRun: false,
      // Deliberately does NOT touch this page, so only the superseded row
      // below is under test here.
      plan: { resolvedPageIds: [] },
    });
    const superseded = await insertErasureLog(appContext.db, {
      scopeType: "page",
      scopeRef: "dual-proof-erasure-noise",
      initiatedBy: owner!.id,
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

    await runChunk(stored, telemetry, 5);

    expect(telemetry.addAnomaly).toHaveBeenCalledWith(expect.objectContaining({
      code: "dm_conversations_dual_proof_mismatch",
    }));
    const checkpoint = await getCheckpoint(appContext.db, stored.page.id, "dm_conversations");
    expect(checkpoint?.state).not.toHaveProperty("dualProofErasureDelta");
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

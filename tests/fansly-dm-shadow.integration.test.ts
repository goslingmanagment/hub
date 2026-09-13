import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbRepo from "@agency_hub_core/db";

import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
import { SyncRunTelemetry } from "../apps/runtime/src/services/sync/observability.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { groupsPage, HEAD_CREATED_AT_MS, PAGE_ACCOUNT_ID, seedThreadInput,
  sweepAdapter } from "./helpers/fansly-dm-sweep.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const START = new Date("2026-09-10T12:00:00Z");
const BOUNDARY = "2026-09-10T11:30:00Z";

describe("A0 shadow against the real sweep", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  beforeAll(async () => { db = await startTestDatabase(); }, INTEGRATION_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await resetIntegrationDatabase(db.pool);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function fixture(enabled: boolean, pages = [0, 1, 2, 3].map((n) => groupsPage({
    conversations: [{ groupId: `g${n}`, flags: n === 3 ? 1 : 0 }],
    total: 4, offset: n * 100, done: n === 3,
  }))) {
    const adapter = sweepAdapter({ pages });
    const app = createTestAppContext(db, { adapter: adapter.adapter, syncSharedRateLimitEnabled: true });
    app.config.fanslyDmShadowPageAllowlist = enabled ? "shadow" : "none";
    const model = await dbRepo.createModel(app.db, { slug: "shadow", name: "Shadow" });
    const page = await dbRepo.createFanslyPage(app.db, { modelId: model!.id, label: "shadow" });
    await dbRepo.ensurePageSyncStates(app.db, { pageId: page!.id });
    const stored = await dbRepo.findPageById(app.db, page!.id);
    for (let n = 0; n < 4; n += 1) {
      await dbRepo.upsertPageDmConversation(app.db, {
        ...seedThreadInput(page!.id, `g${n}`, 1), lastMessageAt: new Date(HEAD_CREATED_AT_MS),
      });
    }
    await dbRepo.upsertCheckpointProgress(app.db, {
      platformAccountId: page!.id, stream: "dm_conversations", state: {
        version: 2, generation: 1, observedCount: 4, generationSetCount: 4,
        providerTotalMode: "present", providerReportedTotal: 4,
        destructiveFinalization: true, membershipCertified: true,
        lastFullSweepCompletedAt: BOUNDARY,
      },
    });
    async function chunk(maxRequests: number) {
      const run = await dbRepo.startSyncRun(app.db, {
        platformAccountId: page!.id, stream: "dm_conversations", trigger: "manual",
      });
      await db.pool.query("update sync_runs set started_at = $1 where id = $2", [START, run!.id]);
      const telemetry = new SyncRunTelemetry(app, {
        runId: run!.id, platformAccountId: page!.id, pageLabel: "shadow", provider: "fansly",
        stream: "dm_conversations", trigger: "manual", egressKey: "direct",
      });
      const result = await fanslyDmConversationsChunk(app, {
        pageContext: { ...stored, platform: "fansly", page: {
          ...stored!.page, platformAccountId: PAGE_ACCOUNT_ID,
        }, session: { authorization: "token" }, proxy: null, egressKey: "direct" },
        streamState: { requestSeq: 1 }, syncRunId: run!.id, telemetry,
        budget: new SyncChunkBudget(maxRequests),
      } as never);
      await telemetry.finish(result.satisfied ? "success" : "partial");
      return result;
    }
    const checkpoint = () => dbRepo.getCheckpoint(app.db, page!.id, "dm_conversations");
    return { app, chunk, checkpoint, calls: adapter.calls };
  }

  async function report() {
    const result = await db.pool.query("select fansly_events_measurement_report($1, $2) as report", [
      START.toISOString(), "2026-09-11T00:00:00Z",
    ]);
    return result.rows[0].report;
  }

  async function businessSnapshot() {
    const threads = await db.pool.query(`select platform_conversation_id, last_message_id,
      last_message_at, last_message_preview, unread_count, conversation_flags,
      last_seen_generation, is_visible from page_dm_threads order by platform_conversation_id`);
    const captures = await db.pool.query(`select endpoint, request_params, response_payload
      from sync_raw_payloads order by id`);
    const cursors = await db.pool.query(`select stream, state - 'diagnostics' as state,
      last_succeeded_run_id from page_sync_cursors order by stream`);
    const queue = await db.pool.query(`select stream, request_seq, applied_seq,
      cadence_seconds, last_scheduled_slot from page_sync_states order by stream`);
    return { threads: threads.rows, captures: captures.rows, cursors: cursors.rows, queue: queue.rows };
  }

  it("keeps HTTP, raw capture, business state, success and scheduled slots identical across resumes", async () => {
    const off = await fixture(false);
    const offResults = [await off.chunk(2), await off.chunk(2)];
    const baseline = await businessSnapshot();
    expect((await report()).sweeps).toHaveLength(0);
    await resetIntegrationDatabase(db.pool);
    const on = await fixture(true);
    expect([await on.chunk(2), await on.chunk(2)]).toEqual(offResults);
    expect(on.calls).toEqual(off.calls);
    expect(await businessSnapshot()).toEqual(baseline);
    const measured = await report();
    expect(measured.sweeps).toHaveLength(1);
    expect(measured.sweeps[0]).toMatchObject({ status: "complete", diagnostics: {
      pageCount: 4, stopPage: 3, pagesBelowStop: 1, flagsChangesBelowStop: 1,
      missingHotHeadsBelowStop: 1, resumes: 1,
    } });
  });

  it("counts a sweep whose start and terminal reports both fail, while business completion succeeds", async () => {
    const source = await fixture(true);
    vi.spyOn(dbRepo, "saveFanslyDmShadowReport").mockRejectedValue(new Error("diagnostic sink down"));
    expect((await source.chunk(4)).satisfied).toBe(true);
    const measured = await report();
    expect(measured.sweeps).toEqual([]);
    expect(measured.dmCoverage).toEqual([expect.objectContaining({ lost_report_runs: 1 })]);
    expect(source.calls).toHaveLength(4);
    expect((await source.checkpoint())?.state).toMatchObject({ membershipCertified: true });
  });

  it("retains pre-apply reason categories after the real writer repairs the stored head", async () => {
    const pages = [0, 1, 2, 3].map((n) => groupsPage({
      conversations: [{
        groupId: `g${n}`, subscriptionTierId: n === 3 ? "new-tier" : null,
        headCreatedAt: HEAD_CREATED_AT_MS + (n === 3 ? 60_000 : 0),
      }], total: 4, offset: n * 100, done: n === 3,
    }));
    const source = await fixture(true, pages);
    await db.pool.query(`update page_dm_threads set is_visible = false,
      metadata = coalesce(metadata, '{}'::jsonb) ||
        '{"unresolvedIdentity":true,"messageSyncExcludedReason":"partner_missing_from_aggregation_accounts"}'::jsonb,
      last_message_sender_id = 'previous-sender'
      where platform_conversation_id = 'g3'`);
    await source.chunk(3);
    expect((await source.checkpoint())?.state).toMatchObject({ diagnostics: { stopPage: 3 } });
    expect((await source.chunk(1)).satisfied).toBe(true);
    const measured = (await report()).sweeps[0];
    expect(measured).toMatchObject({ status: "complete", diagnostics: {
      stateChangesBelowStop: 1, visibilityChangesBelowStop: 1,
      unresolvedIdentityChangesBelowStop: 1, exclusionReasonChangesBelowStop: 1,
      subscriptionTierChangesBelowStop: 1, headTimestampChangesBelowStop: 1,
      headSenderChangesBelowStop: 1, changedHeadsBelowStop: 0,
      unreadChangesBelowStop: 0, flagsChangesBelowStop: 0, headRollbacksBelowStop: 0,
    } });
    const repaired = await db.pool.query(`select is_visible, metadata,
      subscription_tier_id, last_message_sender_id,
      last_message_at from page_dm_threads where platform_conversation_id = 'g3'`);
    expect(repaired.rows[0]).toEqual({
      is_visible: true, metadata: {},
      subscription_tier_id: "new-tier", last_message_sender_id: "fan-g3",
      last_message_at: new Date(HEAD_CREATED_AT_MS + 60_000),
    });
    expect(source.calls).toHaveLength(4);
  });

  it("keeps a missing material read unknown without rolling back the sweep", async () => {
    const source = await fixture(true);
    vi.spyOn(dbRepo, "readFanslyDmShadowMaterial").mockRejectedValue(new Error("read unavailable"));
    expect((await source.chunk(4)).satisfied).toBe(true);
    expect((await report()).sweeps[0]).toMatchObject({ status: "incomplete", diagnostics: {
      unknownMaterialChecks: 4, missingHotHeadsBelowStop: 0,
    } });
  });

  it("marks a disabled continuation incomplete and preserves the full sweep", async () => {
    const source = await fixture(true);
    await source.chunk(2);
    source.app.config.fanslyDmShadowPageAllowlist = "none";
    expect((await source.chunk(2)).satisfied).toBe(true);
    expect((await source.checkpoint())?.state).not.toHaveProperty("diagnostics");
    expect((await report()).sweeps[0]).toMatchObject({ status: "incomplete", reason: "disabled_during_sweep" });
  });

  it("completes a legacy sweep without inventing its missing reason counts", async () => {
    const source = await fixture(true);
    await source.chunk(3);
    await db.pool.query(`update page_sync_cursors set state = jsonb_set(
      state, '{diagnostics}', (state -> 'diagnostics') - array[
        'visibilityChangesBelowStop', 'unresolvedIdentityChangesBelowStop',
        'exclusionReasonChangesBelowStop', 'subscriptionTierChangesBelowStop',
        'headTimestampChangesBelowStop', 'headSenderChangesBelowStop'
      ]) where stream = 'dm_conversations'`);
    expect((await source.chunk(1)).satisfied).toBe(true);
    expect((await report()).sweeps[0]).toMatchObject({ status: "complete", diagnostics: {
      stateChangesBelowStop: 1, flagsChangesBelowStop: 1,
      visibilityChangesBelowStop: null, unresolvedIdentityChangesBelowStop: null,
      exclusionReasonChangesBelowStop: null, subscriptionTierChangesBelowStop: null,
      headTimestampChangesBelowStop: null, headSenderChangesBelowStop: null,
    } });
    expect((await source.checkpoint())?.state).toMatchObject({ membershipCertified: true });
    expect(source.calls).toHaveLength(4);
  });

  it("keeps the unobserved prefix unknown when shadow starts during a running sweep", async () => {
    const source = await fixture(false);
    await source.chunk(3);
    expect((await source.checkpoint())?.state).not.toHaveProperty("diagnostics");
    source.app.config.fanslyDmShadowPageAllowlist = "shadow";
    expect((await source.chunk(1)).satisfied).toBe(true);
    expect((await report()).sweeps[0]).toMatchObject({ status: "incomplete", diagnostics: {
      completeCoverage: false, visibilityChangesBelowStop: null,
      unresolvedIdentityChangesBelowStop: null, exclusionReasonChangesBelowStop: null,
      subscriptionTierChangesBelowStop: null, headTimestampChangesBelowStop: null,
      headSenderChangesBelowStop: null,
    } });
    expect((await source.checkpoint())?.state).toMatchObject({ membershipCertified: true });
    expect(source.calls).toHaveLength(4);
  });

  it("distinguishes exact live hot receipts from deleted rows and measures known debt latency", async () => {
    const source = await fixture(true);
    await db.pool.query(`insert into page_dm_messages
      (conversation_id, platform_account_id, platform_message_id, created_at, deleted_at)
      select id, platform_account_id, last_message_id, last_message_at,
        case when platform_conversation_id = 'g1' then now() else null end
      from page_dm_threads where platform_conversation_id in ('g0', 'g1')`);
    await db.pool.query(`insert into fansly_dm_head_debt
      (conversation_id, message_id, first_observed_at, captured_at)
      select id, last_message_id, '2026-09-10T11:00:00Z', '2026-09-10T11:00:12.3456Z'
      from page_dm_threads where platform_conversation_id = 'g0'`);
    await source.chunk(2);
    await source.chunk(2);
    expect((await report()).sweeps[0]).toMatchObject({ status: "complete", diagnostics: {
      materialLagSamples: 1, maxDiscoveryToCaptureMs: 12346, missingHotHeadsBelowStop: 1,
    } });
  });

  it("keeps a rejected full sweep incomplete rather than reporting zero misses", async () => {
    const source = await fixture(true, [groupsPage({
      conversations: ["g0", "g0"], total: 2, offset: 0, done: true,
    })]);
    await expect(source.chunk(2)).rejects.toThrow("restarted the DM conversation sweep");
    expect((await report()).sweeps[0]).toMatchObject({
      status: "incomplete", reason: "dm_conversations_snapshot_overlap_guard",
    });
    expect((await source.checkpoint())?.state).toMatchObject({ generation: 3, mode: "full_scan" });
  });

  it("resumes the same scalar shadow after an outage over one hour", async () => {
    const source = await fixture(true);
    await source.chunk(2);
    vi.setSystemTime(new Date(START.getTime() + 2 * 3_600_000));
    expect((await source.chunk(2)).satisfied).toBe(true);
    expect((await report()).sweeps[0]).toMatchObject({ status: "complete", diagnostics: {
      resumes: 1, maxObservationGapMs: 2 * 3_600_000, stopPage: 3, pageCount: 4,
    } });
  });

  it.each([null, "1773144000000", true])("rejects coerced raw timestamps as stop evidence: %j", async (value) => {
    const page = groupsPage({ conversations: ["g0", "g1", "g2", "g3"], total: 4, offset: 0, done: true });
    for (const group of page.groups) Object.assign(group.lastMessage!, { createdAt: value });
    const source = await fixture(true, [page]);
    await source.chunk(5);
    expect((await report()).sweeps[0].diagnostics).toMatchObject({ invalidMarkers: 4, stopPage: null });
  });
});

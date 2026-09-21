import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as repo from "@agency_hub_core/db";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { fanslyDmConversationsChunk } from "../apps/runtime/src/services/sync/fansly-dm-conversations.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { fakeTelemetry, groupsPage, HEAD_CREATED_AT_MS, PAGE_ACCOUNT_ID,
  seedThreadInput, sweepAdapter } from "./helpers/fansly-dm-sweep.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

const FULL_START = "2026-09-15T00:00:00.000Z";
const FULL_END = "2026-09-15T00:12:00.000Z";
const NOW = new Date("2026-09-15T00:30:00.000Z");
const anchorSlot = repo.computeCurrentPageSyncSlot(new Date(FULL_START), 1800, 0);
const headAt = (n: number) => HEAD_CREATED_AT_MS - n * 1000;
const pageAt = (n: number, extra = {}) => groupsPage({
  conversations: [{ groupId: `g${n}`, headCreatedAt: headAt(n), ...extra }],
  offset: n * 100, total: 5, done: n === 4,
});

describe("A1 bounded scans through the real handler", () => {
  let db: Awaited<ReturnType<typeof startTestDatabase>>;
  beforeAll(async () => { db = await startTestDatabase(); }, INTEGRATION_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => {
    await resetIntegrationDatabase(db.pool);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function fixture(pages = [0, 1, 2, 3, 4].map((n) => pageAt(n))) {
    const adapter = sweepAdapter({ pages });
    const app = createTestAppContext(db, { adapter: adapter.adapter, syncSharedRateLimitEnabled: true });
    Object.assign(app.config, { fanslyDmBoundedEnabled: true, fanslyDmBoundedPageAllowlist: "a1",
      fanslyDmBoundedPolicies: '{"a1":{"fullIntervalMinutes":60}}' });
    const model = await repo.createModel(app.db, { slug: "a1", name: "A1" });
    const page = await repo.createFanslyPage(app.db, { modelId: model!.id, label: "a1" });
    await repo.ensurePageSyncStates(app.db, { pageId: page!.id });
    const stored = await repo.findPageById(app.db, page!.id);
    for (let n = 0; n < 5; n++) await repo.upsertPageDmConversation(app.db, {
      ...seedThreadInput(page!.id, `g${n}`, 1), lastMessageAt: new Date(headAt(n)),
    });
    const previousRun = await repo.startSyncRun(app.db, {
      platformAccountId: page!.id, stream: "dm_conversations", trigger: "manual",
    });
    await repo.upsertCheckpoint(app.db, { platformAccountId: page!.id, stream: "dm_conversations",
      lastSuccessfulRunId: previousRun!.id, state: {
        version: 2, generation: 1, observedCount: 5, generationSetCount: 5,
        providerTotalMode: "present", providerReportedTotal: 5, destructiveFinalization: true,
        membershipCertified: true, lastFullSweepCompletedAt: FULL_END,
        polling: { anchorSlot, slotOffsetSeconds: 0,
          lastCertifiedFull: { anchorSlot, startedAt: FULL_START, completedAt: FULL_END } },
      } });
    async function chunk(maxRequests = 5) {
      const run = await repo.startSyncRun(app.db, {
        platformAccountId: page!.id, stream: "dm_conversations", trigger: "manual",
      });
      return fanslyDmConversationsChunk(app, {
        pageContext: { ...stored, platform: "fansly", page: { ...stored!.page, platformAccountId: PAGE_ACCOUNT_ID },
          session: { authorization: "token" }, proxy: null, egressKey: "direct" },
        streamState: { requestSeq: 1, cadenceSeconds: 1800, slotOffsetSeconds: 0,
          lastScheduledSlot: repo.computeCurrentPageSyncSlot(new Date(), 1800, 0) },
        syncRunId: run!.id, telemetry: fakeTelemetry(), budget: new SyncChunkBudget(maxRequests),
      } as never);
    }
    const checkpoint = () => repo.getCheckpoint(app.db, page!.id, "dm_conversations");
    const threads = async () => (await db.pool.query(`select platform_conversation_id, last_seen_generation,
      is_visible, conversation_flags from page_dm_threads where platform_account_id=$1 order by id`, [page!.id])).rows;
    return { app, page: page!, chunk, checkpoint, threads, calls: adapter.calls, previousRun: previousRun! };
  }

  it("stops after three unchanged pages without stamping membership, hiding rows, or full success", async () => {
    const f = await fixture();
    const before = await f.checkpoint();
    expect(await f.chunk()).toMatchObject({ satisfied: true, qualityHold: "fansly_dm_bounded_only" });
    expect(f.calls.map((c) => c.method === "messaging_groups" ? c.offset : c.method)).toEqual([0, 100, 200]);
    const after = await f.checkpoint();
    expect(after?.state).toMatchObject({ mode: "bounded", pageCount: 3, lastFullSweepCompletedAt: FULL_END,
      polling: { lastCertifiedFull: { startedAt: FULL_START, completedAt: FULL_END } } });
    expect(after?.cursorLastSucceededRunId).toBe(f.previousRun.id);
    expect(after?.cursorLastSucceededAt).toEqual(before?.cursorLastSucceededAt);
    expect((await f.threads()).every((row) => row.is_visible && Number(row.last_seen_generation) === 1)).toBe(true);
    const raw = await db.pool.query("select request_params from sync_raw_payloads where endpoint='dm_conversations' order by id");
    expect(raw.rows.map((r) => r.request_params.offset)).toEqual([0, 100, 200]);
  });

  it("retains the original boundary and offset across capped dispatches", async () => {
    const f = await fixture();
    expect(await f.chunk(1)).toMatchObject({ satisfied: false });
    expect((await f.checkpoint())?.state).toMatchObject({ mode: "bounded", offset: 100, completedAt: null });
    expect(await f.chunk(1)).toMatchObject({ satisfied: false });
    expect(await f.chunk(1)).toMatchObject({ satisfied: true, qualityHold: "fansly_dm_bounded_only" });
    expect(f.calls.map((c) => c.method === "messaging_groups" ? c.offset : c.method)).toEqual([0, 100, 200]);
    expect((await f.checkpoint())?.state).toMatchObject({ lastFullSweepCompletedAt: FULL_END });
  });

  it.each(["off", "deadline"])("abandons bounded on %s and opens a new full generation at offset zero", async (reason) => {
    const f = await fixture([pageAt(0), ...[0, 1, 2, 3, 4].map((n) => pageAt(n))]);
    await f.chunk(1);
    if (reason === "off") f.app.config.fanslyDmBoundedEnabled = false;
    else vi.setSystemTime(new Date("2026-09-15T01:00:00Z"));
    expect(await f.chunk()).toMatchObject({ satisfied: true, stats: { fullSweepCompleted: true } });
    expect(f.calls.map((c) => c.method === "messaging_groups" ? c.offset : c.method)).toEqual([0, 0, 100, 200, 300, 400]);
    expect((await f.threads()).every((row) => row.is_visible && Number(row.last_seen_generation) === 2)).toBe(true);
    expect((await f.checkpoint())?.state).toMatchObject({ generation: 2, membershipCertified: true });
    expect((await f.checkpoint())?.state).not.toHaveProperty("mode");
  });

  it("full30 walks every page in the 00:30 slot despite a 00:12 prior completion", async () => {
    const f = await fixture();
    f.app.config.fanslyDmBoundedPolicies = '{"a1":{"fullIntervalMinutes":30}}';
    expect(await f.chunk()).toMatchObject({ satisfied: true, stats: { fullSweepCompleted: true } });
    expect(f.calls).toHaveLength(5);
    expect((await f.checkpoint())?.state).toMatchObject({ polling: { anchorSlot: anchorSlot + 1,
      lastCertifiedFull: { startedAt: NOW.toISOString(), completedAt: NOW.toISOString() } } });
  });

  it("a flags-only change resets the full-scope streak and provider exhaustion stays bounded", async () => {
    const f = await fixture([pageAt(0), pageAt(1), pageAt(2, { flags: 1 }), pageAt(3), pageAt(4)]);
    expect(await f.chunk()).toMatchObject({ satisfied: true, qualityHold: "fansly_dm_bounded_only" });
    expect(f.calls).toHaveLength(5);
    expect((await f.threads())[2]).toMatchObject({ conversation_flags: 1 });
    expect((await f.threads()).every((row) => Number(row.last_seen_generation) === 1)).toBe(true);
    expect((await f.checkpoint())?.state).toMatchObject({ mode: "bounded", lastFullSweepCompletedAt: FULL_END });
  });

  it("keeps an already started full scan full after the interval changes", async () => {
    const f = await fixture();
    f.app.config.fanslyDmBoundedPolicies = '{"a1":{"fullIntervalMinutes":30}}';
    await f.chunk(1);
    f.app.config.fanslyDmBoundedPolicies = '{"a1":{"fullIntervalMinutes":360}}';
    expect(await f.chunk()).toMatchObject({ satisfied: true, stats: { fullSweepCompleted: true } });
    expect((await f.threads()).every((row) => Number(row.last_seen_generation) === 2)).toBe(true);
  });

  it.each(["deadline", "off"])("keeps the A0 boundary and below-stop witness after A1 (%s), including resume", async reason => {
    const f = await fixture([
      ...[0, 1, 2].map(n => pageAt(n)),
      ...[0, 1, 2, 3, 4].map(n => pageAt(n, n === 4 ? { lastMessageId: "changed-head" } : {})),
    ]);
    f.app.config.fanslyDmShadowPageAllowlist = "a1";
    await f.chunk();
    if (reason === "off") f.app.config.fanslyDmBoundedEnabled = false;
    else vi.setSystemTime(new Date("2026-09-15T01:00:00Z"));
    await f.chunk(2);
    expect((await f.checkpoint())?.state).toMatchObject({ diagnostics: {
      boundaryMs: Date.parse(FULL_END), pageCount: 2, completeCoverage: true,
    } });
    await f.chunk();
    const reports = await db.pool.query("select status,diagnostics from fansly_dm_shadow_sweeps where page_id=$1", [f.page.id]);
    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]).toMatchObject({ status: "complete", diagnostics: {
      boundaryMs: Date.parse(FULL_END), stopPage: 3, changedHeadsBelowStop: 1, resumes: 1,
    } });
  });

  it("does not advance a bounded cursor or apply rows on raw capture failure", async () => {
    const f = await fixture();
    await db.pool.query(`create function reject_a1_raw() returns trigger language plpgsql as $$
      begin raise exception 'injected capture failure'; end $$`);
    await db.pool.query("create trigger reject_a1_raw before insert on sync_raw_payloads for each row execute function reject_a1_raw()");
    try {
      await expect(f.chunk()).rejects.toThrow();
      expect((await f.checkpoint())?.state).toMatchObject({ mode: "bounded", offset: 0, pageCount: 0, completedAt: null });
      expect((await f.threads()).every((row) => Number(row.last_seen_generation) === 1)).toBe(true);
    } finally {
      await db.pool.query("drop trigger reject_a1_raw on sync_raw_payloads");
      await db.pool.query("drop function reject_a1_raw()");
    }
  });
});

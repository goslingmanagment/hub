import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeCurrentPageSyncSlot,
  computePageSyncSlotOffsetSeconds,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getSyncStreamsForPlatform,
  listPageSyncStates,
  scheduleDuePageSync,
  SYNC_STREAM_POLICY,
  upsertFans,
  upsertPageFollows,
  type SyncStream,
} from "@agency_hub_core/db";

import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";

const NOW = new Date("2026-09-12T12:00:00Z");
const FANSLY_STREAMS = getSyncStreamsForPlatform("fansly");

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface ExplainNode {
  "Relation Name"?: string;
  "Actual Loops"?: number;
  Plans?: ExplainNode[];
}

function allPlanNodes(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(allPlanNodes)];
}

describe("sync-state seeding follower reads", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>>;

  beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await testDb?.stop(); });
  beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

  async function seedPage(platform: "fansly" | "onlyfans" = "fansly") {
    const model = await createModel(testDb.db, { slug: "seed-count", name: "Seed Count" });
    if (!model) throw new Error("Expected model");
    const createPage = platform === "fansly" ? createFanslyPage : createOnlyFansPage;
    const page = await createPage(testDb.db, { modelId: model.id, label: "seed-count" });
    if (!page) throw new Error("Expected page");
    await testDb.pool.query(`
      update pages set last_light_sync_at = $2, last_follower_sync_at = $2, follower_count = 2
      where id = $1
    `, [page.id, NOW]);
    const fans = await upsertFans(testDb.db, ["active-1", "active-2", "inactive"].map((id) => ({
      platform, platformUserId: id,
    })));
    await upsertPageFollows(testDb.db, fans.map((fan) => ({
      platformAccountId: page.id, fanId: fan.id,
      platformFollowId: fan.platformUserId, followedAt: NOW,
    })));
    await testDb.pool.query(`
      update page_follows set is_active = false
      where platform_account_id = $1 and platform_follow_id = 'inactive'
    `, [page.id]);
    return page;
  }

  // Existing states are deliberately populated without invoking the seeder:
  // partial fixtures must have their missing streams absent on the first call.
  async function seedExistingStates(pageId: number, streams: SyncStream[]) {
    for (const stream of streams) {
      const policy = SYNC_STREAM_POLICY[stream];
      const offset = computePageSyncSlotOffsetSeconds(pageId, stream);
      await testDb.pool.query(`
        insert into page_sync_states (
          page_id, stream, status, cadence_seconds, slot_offset_seconds,
          last_scheduled_slot, work_class
        ) values ($1, $2, $3, $4, $5, $6, $7)
      `, [pageId, stream, stream === "followers_reconcile" ? "paused" : "idle",
        policy.cadenceSeconds, offset,
        computeCurrentPageSyncSlot(NOW, policy.cadenceSeconds, offset), policy.defaultWorkClass]);
    }
  }

  async function captureSeedQueries(run: () => Promise<unknown>): Promise<CapturedQuery[]> {
    const query = vi.spyOn(testDb.pool, "query");
    try {
      await run();
      return query.mock.calls.flatMap((call) => {
        const [statement, values] = call as unknown[];
        const text = typeof statement === "string" ? statement
          : typeof statement === "object" && statement !== null && "text" in statement
            ? statement.text : undefined;
        return typeof text === "string" && text.includes('as "activeFollowerCount"')
          ? [{ text, values: Array.isArray(values) ? values : [] }] : [];
      });
    } finally {
      query.mockRestore();
    }
  }

  async function expectNoFollowerReads(queries: CapturedQuery[]) {
    expect(queries.length).toBeGreaterThan(0);
    // Run the exact repository SELECT, with its original bind values. This
    // tests execution, not merely a CASE substring or a mocked row count.
    for (const query of queries) {
      const result = await testDb.pool.query<{ "QUERY PLAN": Array<{ Plan: ExplainNode }> }>(
        `explain (analyze, format json) ${query.text}`, query.values,
      );
      const plan = result.rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (!plan) throw new Error("Expected analyzed PostgreSQL plan");
      const followerScans = allPlanNodes(plan).filter((node) => node["Relation Name"] === "page_follows");
      for (const scan of followerScans) expect(scan["Actual Loops"]).toBe(0);
    }
  }

  it("does not read followers in complete planner/executor preflights, including a paused reconcile", async () => {
    const page = await seedPage();
    await seedExistingStates(page.id, FANSLY_STREAMS);
    const before = await listPageSyncStates(testDb.db, { pageId: page.id });
    await testDb.pool.query("update pages set follower_count = 999999 where id = $1", [page.id]);

    const queries = await captureSeedQueries(async () => {
      // The planner calls ensure itself, then schedule calls ensure again.
      await ensurePageSyncStates(testDb.db, { now: NOW });
      await scheduleDuePageSync(testDb.db, { now: NOW });
      // The executor independently preflights the selected page.
      const after = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });
      expect(after).toEqual(before);
    });
    expect(queries).toHaveLength(3);
    await expectNoFollowerReads(queries);
  });

  it("seeds missing DM and gated states without reopening or counting a present reconcile", async () => {
    const page = await seedPage();
    await seedExistingStates(page.id, FANSLY_STREAMS.filter((stream) =>
      stream !== "dm_messages" && stream !== "posts"));
    const queries = await captureSeedQueries(async () => {
      const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });
      expect(states).toHaveLength(FANSLY_STREAMS.length);
      expect(states.find((row) => row.stream === "followers_reconcile")).toMatchObject({
        status: "paused", requestSeq: 0, appliedSeq: 0,
      });
      expect(states.find((row) => row.stream === "dm_messages")).toMatchObject({
        status: "pending", requestSeq: 1, requestSource: "recovery",
      });
      expect(states.find((row) => row.stream === "posts")).toMatchObject({
        status: "paused", requestSeq: 0, requestSource: null,
      });
    });
    await expectNoFollowerReads(queries);
  });

  it.each([
    { name: "matching active count", count: 2, syncedAt: NOW, recover: false },
    { name: "count mismatch", count: 3, syncedAt: NOW, recover: true },
    { name: "unknown source count", count: null, syncedAt: NOW, recover: true },
    { name: "no trusted sync", count: 2, syncedAt: null, recover: true },
    { name: "expired trusted sync", count: 2, syncedAt: new Date("2026-01-01T00:00:00Z"), recover: true },
  ])("preserves missing reconcile recovery for $name", async ({ count, syncedAt, recover }) => {
    const page = await seedPage();
    await seedExistingStates(page.id, FANSLY_STREAMS.filter((stream) => stream !== "followers_reconcile"));
    await testDb.pool.query("update pages set follower_count = $2, last_follower_sync_at = $3 where id = $1",
      [page.id, count, syncedAt]);
    const before = await listPageSyncStates(testDb.db, { pageId: page.id });
    const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });
    expect(states.filter((row) => row.stream !== "followers_reconcile")).toEqual(before);
    expect(states.find((row) => row.stream === "followers_reconcile")).toMatchObject({
      status: recover ? "pending" : "idle",
      requestSeq: recover ? 1 : 0, appliedSeq: 0,
      requestSource: recover ? "recovery" : null,
      succeededAt: recover ? null : syncedAt,
    });
  });

  it("preserves onboarding seeding and skips a count onboarding does not consume", async () => {
    const page = await seedPage();
    const queries = await captureSeedQueries(async () => {
      const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW, onboarding: true });
      expect(states).toHaveLength(FANSLY_STREAMS.length);
      expect(states.find((row) => row.stream === "followers_reconcile")).toMatchObject({
        status: "idle", requestSeq: 0, requestSource: null,
      });
      expect(states.find((row) => row.stream === "light")).toMatchObject({
        status: "pending", requestSeq: 1, requestSource: "onboarding",
      });
    });
    await expectNoFollowerReads(queries);
  });

  it("keeps legacy repair and cadence maintenance when all streams already exist", async () => {
    const page = await seedPage();
    await seedExistingStates(page.id, FANSLY_STREAMS);
    await testDb.pool.query(`
      update page_sync_states set succeeded_at = $2
      where page_id = $1 and stream = 'transactions'
    `, [page.id, NOW]);
    await testDb.pool.query(`
      update page_sync_states set cadence_seconds = 1, slot_offset_seconds = 0
      where page_id = $1 and stream = 'light'
    `, [page.id]);
    const queries = await captureSeedQueries(async () => {
      const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });
      expect(states.find((row) => row.stream === "transactions")).toMatchObject({
        status: "pending", requestSeq: 1, appliedSeq: 0, requestSource: "recovery", succeededAt: null,
      });
      expect(states.find((row) => row.stream === "light")).toMatchObject({
        cadenceSeconds: SYNC_STREAM_POLICY.light.cadenceSeconds,
        slotOffsetSeconds: computePageSyncSlotOffsetSeconds(page.id, "light"),
      });
    });
    await expectNoFollowerReads(queries);
  });

  it("does not read followers when seeding OnlyFans, which has no reconcile stream", async () => {
    const page = await seedPage("onlyfans");
    const queries = await captureSeedQueries(async () => {
      const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });
      expect(states.map((row) => row.stream)).toEqual(getSyncStreamsForPlatform("onlyfans"));
    });
    await expectNoFollowerReads(queries);
  });
});

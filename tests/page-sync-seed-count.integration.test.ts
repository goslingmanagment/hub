import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeCurrentPageSyncSlot,
  computePageSyncSlotOffsetSeconds,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  getSyncStreamsForPlatform,
  LEGACY_EXECUTOR_STREAMS,
  listPageSyncStates,
  refreshPageSyncDependencies,
  retireLegacyOnlyFansDmMessages,
  scheduleDuePageSync,
  SYNC_STREAM_POLICY,
  syncStreamOrderIndex,
  type LegacyExecutorStream,
  type SyncStream,
} from "@agency_hub_core/db";

import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { FORMER_FANSLY_STREAMS, seedFormerFanslyRows } from "./helpers/fansly-legacy-rows.ts";

const NOW = new Date("2026-09-12T12:00:00Z");
const ONLYFANS_STREAMS = getSyncStreamsForPlatform("onlyfans");

// Step 4, S4-24: the seeder seeds and maintains the legacy executor's streams
// only. A Fansly page gets no row (the Fansly Sync Engine reads it), the rows
// it holds are records the seeder leaves alone, and the follower count the
// seed of a Fansly `followers_reconcile` row once needed is not read at all.
describe("sync-state seeding", () => {
  let testDb: Awaited<ReturnType<typeof startTestDatabase>>;

  beforeAll(async () => { testDb = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await testDb?.stop(); });
  beforeEach(async () => { await resetIntegrationDatabase(testDb.pool); });

  async function seedPage(platform: "fansly" | "onlyfans", label = "seed-count") {
    const model = await createModel(testDb.db, { slug: label, name: "Seed Count" });
    if (!model) throw new Error("Expected model");
    const createPage = platform === "fansly" ? createFanslyPage : createOnlyFansPage;
    const page = await createPage(testDb.db, { modelId: model.id, label });
    if (!page) throw new Error("Expected page");
    await testDb.pool.query("update pages set last_light_sync_at = $2 where id = $1", [page.id, NOW]);
    return page;
  }

  // Existing states are deliberately populated without invoking the seeder:
  // partial fixtures must have their missing streams absent on the first call.
  async function seedExistingStates(pageId: number, streams: readonly LegacyExecutorStream[]) {
    for (const stream of streams) {
      const policy = SYNC_STREAM_POLICY[stream];
      const offset = computePageSyncSlotOffsetSeconds(pageId, stream);
      await testDb.pool.query(`
        insert into page_sync_states (
          page_id, stream, status, cadence_seconds, slot_offset_seconds,
          last_scheduled_slot, work_class
        ) values ($1, $2, 'idle', $3, $4, $5, $6)
      `, [pageId, stream, policy.cadenceSeconds, offset,
        computeCurrentPageSyncSlot(NOW, policy.cadenceSeconds, offset), policy.defaultWorkClass]);
    }
  }

  /** A Fansly page's rows as migration "retire_fansly_legacy_sync_states" left them. */
  async function seedParkedFanslyRows(pageId: number) {
    for (const stream of FORMER_FANSLY_STREAMS) {
      await testDb.pool.query(`
        insert into page_sync_states (
          page_id, stream, status, cadence_seconds, slot_offset_seconds, last_scheduled_slot,
          blocker_kind, blocker_code, blocker_message, blocked_at
        ) values ($1, $2, 'paused', 7, 3, 41, 'retired', 'fansly_sync_engine_owned', 'parked', $3)
      `, [pageId, stream, NOW]);
    }
  }

  async function rawRows(pageId: number) {
    const result = await testDb.pool.query(
      "select to_jsonb(s) as row from page_sync_states s where page_id = $1 order by stream::text", [pageId],
    );
    return result.rows.map((row) => row.row);
  }

  async function captureSeedQueries(run: () => Promise<unknown>): Promise<string[]> {
    const query = vi.spyOn(testDb.pool, "query");
    try {
      await run();
      return query.mock.calls.flatMap((call) => {
        const [statement] = call as unknown[];
        const text = typeof statement === "string" ? statement
          : typeof statement === "object" && statement !== null && "text" in statement
            ? statement.text : undefined;
        return typeof text === "string" && text.includes('p.last_light_sync_at as "lastLightSyncAt"') ? [text] : [];
      });
    } finally {
      query.mockRestore();
    }
  }

  it("seeds no row on a Fansly page and leaves its parked rows byte-identical, schedule columns included", async () => {
    const bare = await seedPage("fansly", "seed-bare");
    const parked = await seedPage("fansly", "seed-parked");
    await seedParkedFanslyRows(parked.id);
    const before = await rawRows(parked.id);

    expect(await ensurePageSyncStates(testDb.db, { pageId: bare.id, now: NOW })).toEqual([]);
    expect(await ensurePageSyncStates(testDb.db, { pageId: bare.id, now: NOW, onboarding: true })).toEqual([]);
    // No platform set, a set that names Fansly, and the page itself: the
    // seeder serves the executor's platforms whatever the caller names.
    await ensurePageSyncStates(testDb.db, { now: NOW });
    await ensurePageSyncStates(testDb.db, { now: NOW, platforms: ["fansly", "onlyfans"] });
    await scheduleDuePageSync(testDb.db, { now: NOW });
    expect(await ensurePageSyncStates(testDb.db, { pageId: parked.id, now: NOW })).toEqual([]);

    expect(await rawRows(bare.id)).toEqual([]);
    // The parked rows keep their stored cadence (7 s) and slot — also those of
    // the names the executor runs elsewhere (light, transactions, …): on a
    // Fansly page they are records, and nothing "repairs" them to a policy.
    expect(await rawRows(parked.id)).toEqual(before);
    // Listed in the one total order: the executor's streams by policy index,
    // the record streams after them.
    const listed = await listPageSyncStates(testDb.db, { pageId: parked.id });
    expect(listed.map((row) => row.stream)).toEqual(
      [...FORMER_FANSLY_STREAMS].sort((left, right) => syncStreamOrderIndex(left) - syncStreamOrderIndex(right)),
    );
  });

  it("neither blocks nor releases a Fansly page's rows by a dependency: they are records, parked or not", async () => {
    const page = await seedPage("fansly", "seed-unparked");
    // The rows as an old planner left them: pending for recovery, no blocker,
    // none of them ever succeeded (the state before the parking migration).
    await seedFormerFanslyRows(testDb.pool, page.id, NOW);
    // One the old ordering had blocked on its prerequisites.
    await testDb.pool.query(`
      update page_sync_states
         set status = 'blocked', blocker_kind = 'dependency', blocker_code = 'unmet_dependency',
             blocker_message = 'Waiting for light', blocked_at = $2
       where page_id = $1 and stream = 'dm_messages'
    `, [page.id, NOW]);
    const before = await rawRows(page.id);
    expect(before.find((row) => row.stream === "dm_conversations")).toMatchObject({ status: "pending", blocker_kind: null });

    await refreshPageSyncDependencies(testDb.db, { now: NOW });
    await refreshPageSyncDependencies(testDb.db, { pageId: page.id, now: NOW });
    await refreshPageSyncDependencies(testDb.db, { now: NOW, platforms: ["fansly", "onlyfans"] });

    expect(await rawRows(page.id)).toEqual(before);
  });

  it("seeds an OnlyFans page's missing streams: the capture lane paused, the rest for recovery, light as trusted", async () => {
    const page = await seedPage("onlyfans");
    await seedExistingStates(page.id, ["transactions"]);

    const queries = await captureSeedQueries(async () => {
      const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });
      expect(states.map((row) => row.stream)).toEqual(ONLYFANS_STREAMS);
      // The page row records the last account read: trusted, nothing to recover.
      expect(states.find((row) => row.stream === "light")).toMatchObject({
        status: "idle", requestSeq: 0, requestSource: null, succeededAt: NOW,
      });
      expect(states.find((row) => row.stream === "subscribers")).toMatchObject({
        status: "pending", requestSeq: 1, requestSource: "recovery", succeededAt: null,
      });
      expect(states.find((row) => row.stream === "posts")).toMatchObject({
        status: "paused", requestSeq: 0, requestSource: null,
      });
      for (const row of states) {
        expect(row.cadenceSeconds, row.stream).toBe(SYNC_STREAM_POLICY[row.stream as LegacyExecutorStream].cadenceSeconds);
      }
    });

    // The seed reads the page row alone: no follower table, no follower count.
    expect(queries.length).toBeGreaterThan(0);
    for (const text of queries) expect(text).not.toMatch(/page_follows|follower/i);
  });

  it("seeds every stream of a new OnlyFans page for onboarding but the paused capture lane", async () => {
    const page = await seedPage("onlyfans");
    const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW, onboarding: true });
    expect(states.map((row) => row.stream)).toEqual(ONLYFANS_STREAMS);
    for (const row of states) {
      expect(row, row.stream).toMatchObject(row.stream === "posts"
        ? { status: "paused", requestSeq: 0, requestSource: null }
        : { status: "pending", requestSeq: 1, requestSource: "onboarding" });
    }
  });

  it("keeps legacy repair and cadence maintenance when all streams already exist, and no record row's schedule", async () => {
    const page = await seedPage("onlyfans");
    await seedExistingStates(page.id, LEGACY_EXECUTOR_STREAMS);
    await retireLegacyOnlyFansDmMessages(testDb.db, NOW);
    await testDb.pool.query(`
      update page_sync_states set succeeded_at = $2
      where page_id = $1 and stream = 'transactions'
    `, [page.id, NOW]);
    await testDb.pool.query(`
      update page_sync_states set cadence_seconds = 1, slot_offset_seconds = 0
      where page_id = $1 and stream in ('light', 'dm_messages')
    `, [page.id]);

    const states = await ensurePageSyncStates(testDb.db, { pageId: page.id, now: NOW });

    expect(states.find((row) => row.stream === "transactions")).toMatchObject({
      status: "pending", requestSeq: 1, appliedSeq: 0, requestSource: "recovery", succeededAt: null,
    });
    expect(states.find((row) => row.stream === "light")).toMatchObject({
      cadenceSeconds: SYNC_STREAM_POLICY.light.cadenceSeconds,
      slotOffsetSeconds: computePageSyncSlotOffsetSeconds(page.id, "light"),
    });
    // The retired crawler's parked row is a record: its schedule is not the
    // executor's to maintain, and it stays parked.
    expect(states.find((row) => row.stream === "dm_messages")).toMatchObject({
      status: "paused", blockerKind: "retired", cadenceSeconds: 1, slotOffsetSeconds: 0,
    });
    expect((await listPageSyncStates(testDb.db, { pageId: page.id })).map((row) => row.stream))
      .toEqual([...ONLYFANS_STREAMS, "dm_messages"].sort((left, right) =>
        syncStreamOrderIndex(left as SyncStream) - syncStreamOrderIndex(right as SyncStream)));
  });

  it("parks a retired OnlyFans dm_messages row with the schedule the lane had", async () => {
    const page = await seedPage("onlyfans");
    await retireLegacyOnlyFansDmMessages(testDb.db, NOW);
    const [row] = await listPageSyncStates(testDb.db, { pageId: page.id, streams: ["dm_messages"] });
    expect(row).toMatchObject({
      status: "paused",
      blockerKind: "retired",
      blockerCode: "legacy_ofapi_dm_messages_retired",
      cadenceSeconds: 86_400,
      slotOffsetSeconds: Number((BigInt(page.id) * 2654435761n + 9n * 2246822519n) % 86_400n),
    });
  });
});

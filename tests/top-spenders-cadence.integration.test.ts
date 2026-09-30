// Owner decision 2026-09-30: Fansly top spenders are read every 6 hours, not
// every hour. These tests drive the real planner, lease and completion paths
// through the deploy that moves an existing hourly row onto the 6-hour grid.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePageSyncLease,
  completePageSync,
  computeCurrentPageSyncSlot,
  computePageSyncSlotOffsetSeconds,
  computeSyncStreamNextDueAt,
  createFanslyPage,
  createModel,
  ensurePageSyncStates,
  getFanslySyncLiveness,
  getPageSyncState,
  listRunnablePageSync,
  requestPageSync,
  scheduleDuePageSync,
  SYNC_STREAM_POLICY,
  type SyncStream,
} from "@agency_hub_core/db";

import { getSyncStatusSnapshot } from "../apps/runtime/src/services/sync-status.ts";
import { resetIntegrationDatabase, startTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const HOUR_MS = 3600_000;
const SIX_HOURS_MS = 6 * HOUR_MS;
const TICK_MS = 5 * 60_000;
// The last hourly top_spenders run before the deploy (prod lilly-1, 2026-09-30).
const LAST_HOURLY_RUN = new Date("2026-09-30T03:32:10Z");
const DEPLOY = new Date("2026-09-30T03:50:00Z");

let db: Awaited<ReturnType<typeof startTestDatabase>>;

beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });

/** The slot offset the hourly runtime gave the row: same hash, mod 3600. */
function hourlySlotOffsetSeconds(pageId: number) {
  return Number(
    (BigInt(pageId) * 2654435761n + BigInt(SYNC_STREAM_POLICY.top_spenders.streamIndex) * 2246822519n) % 3600n,
  );
}

/** A healthy Fansly page as it stands just before the deploy. Every lane has
 * succeeded; `active` lanes stay schedulable, the rest are paused so only
 * they move. top_spenders carries the hourly runtime's cadence and slot. */
async function seedPageBeforeDeploy(active: SyncStream[]) {
  const model = await createModel(db.db, { slug: "tsc", name: "TSC" });
  if (!model) throw new Error("model seed failed");
  const page = await createFanslyPage(db.db, { modelId: model.id, label: "tsc-fansly" });
  if (!page) throw new Error("page seed failed");
  await ensurePageSyncStates(db.db, { pageId: page.id, now: LAST_HOURLY_RUN });
  await db.pool.query(`
    update page_sync_states
    set status = case when stream = any($3::sync_stream[]) then 'idle' else 'paused' end::page_sync_status,
        request_seq = 1, applied_seq = 1, request_source = 'scheduled', dispatch_source = 'scheduled',
        requested_at = $2, finished_at = $2, succeeded_at = $2, retry_kind = null, retry_at = null,
        blocker_kind = null, blocker_code = null, blocker_message = null, blocked_at = null
    where page_id = $1
  `, [page.id, LAST_HOURLY_RUN, active]);
  const hourlyOffset = hourlySlotOffsetSeconds(page.id);
  const hourlySlot = computeCurrentPageSyncSlot(LAST_HOURLY_RUN, 3600, hourlyOffset);
  await db.pool.query(`
    update page_sync_states
    set cadence_seconds = 3600, slot_offset_seconds = $2, last_scheduled_slot = $3,
        request_seq = 4159, applied_seq = 4159
    where page_id = $1 and stream = 'top_spenders'
  `, [page.id, hourlyOffset, hourlySlot]);
  const lastHourlySlotStart = new Date((hourlySlot * 3600 + hourlyOffset) * 1000);
  const sixHourOffset = computePageSyncSlotOffsetSeconds(page.id, "top_spenders");
  // The first 6-hour boundary after the last hourly slot: the lane's next run.
  const firstBoundary = new Date(
    ((computeCurrentPageSyncSlot(lastHourlySlotStart, 21_600, sixHourOffset) + 1) * 21_600 + sixHourOffset) * 1000,
  );
  return { page, lastHourlySlotStart, firstBoundary };
}

async function topSpendersRow(pageId: number) {
  const row = await getPageSyncState(db.db, pageId, "top_spenders");
  if (!row) throw new Error("top_spenders row missing");
  return row;
}

/** One planner tick, then the worker drains everything runnable at once. */
async function tick(pageId: number, now: Date) {
  await scheduleDuePageSync(db.db, { pageId, now });
  const ran: SyncStream[] = [];
  for (;;) {
    const lease = await acquirePageSyncLease(db.db, {
      pageId, workerId: "test-worker", leaseToken: `lease-${now.getTime()}-${ran.length}`,
      leaseTtlMs: 60_000, now,
    });
    if (!lease) return ran;
    expect(await completePageSync(db.db, {
      pageId, stream: lease.stream, requestSeq: lease.leasedSeq!, leaseToken: lease.leaseToken!, now,
    })).toBe(true);
    ran.push(lease.stream);
  }
}

function roundUpToTick(at: Date) {
  const offset = at.getTime() - DEPLOY.getTime();
  return new Date(DEPLOY.getTime() + Math.ceil(offset / TICK_MS) * TICK_MS);
}

describe("top_spenders runs every 6 hours", () => {
  it("moves an hourly row onto the 6-hour grid at deploy with no catch-up run, then runs every 6 hours", async () => {
    const { page, lastHourlySlotStart, firstBoundary } = await seedPageBeforeDeploy(["transactions", "top_spenders"]);

    // Deploy: the first planner tick of the new runtime reconciles the row.
    await ensurePageSyncStates(db.db, { pageId: page.id, now: DEPLOY });
    const moved = await topSpendersRow(page.id);
    expect(moved).toMatchObject({
      cadenceSeconds: 21_600,
      slotOffsetSeconds: computePageSyncSlotOffsetSeconds(page.id, "top_spenders"),
      requestSeq: 4159,
      appliedSeq: 4159,
      status: "idle",
    });
    expect(computeSyncStreamNextDueAt(moved)).toEqual(firstBoundary);
    expect(firstBoundary.getTime() - lastHourlySlotStart.getTime()).toBeLessThanOrEqual(SIX_HOURS_MS);
    // Reconciling again changes nothing.
    await ensurePageSyncStates(db.db, { pageId: page.id, now: DEPLOY });
    expect(await topSpendersRow(page.id)).toEqual(moved);

    const topSpenderRuns: Date[] = [];
    let transactionRuns = 0;
    let statusChecked = false;
    const end = new Date(DEPLOY.getTime() + 13 * HOUR_MS);
    for (let now = DEPLOY; now <= end; now = new Date(now.getTime() + TICK_MS)) {
      const ran = await tick(page.id, now);
      if (ran.includes("top_spenders")) topSpenderRuns.push(now);
      transactionRuns += ran.filter((stream) => stream === "transactions").length;

      // Five hours after a 6-hour run: what an operator sees between runs.
      const first = topSpenderRuns[0];
      if (!statusChecked && first && now.getTime() === first.getTime() + 5 * HOUR_MS) {
        statusChecked = true;
        const snapshot = await getSyncStatusSnapshot(createTestAppContext(db), {
          pageIds: [page.id], now, includeMonitorRows: false,
        });
        const financials = snapshot.pages[0]?.blocks.financials;
        expect(financials?.state).toBe("up_to_date");
        expect(financials?.substreams.find((sub) => sub.stream === "top_spenders")).toMatchObject({
          role: "supporting",
          state: "up_to_date",
          cadenceSeconds: 21_600,
          nextDueAt: new Date(firstBoundary.getTime() + SIX_HOURS_MS).toISOString(),
          needsAttention: false,
        });
        expect(financials?.intervals).toContainEqual({ stream: "top_spenders", cadenceSeconds: 21_600 });
      }
    }

    const expectedRuns: Date[] = [];
    for (let boundary = firstBoundary; boundary <= end; boundary = new Date(boundary.getTime() + SIX_HOURS_MS)) {
      if (roundUpToTick(boundary) <= end) expectedRuns.push(roundUpToTick(boundary));
    }
    expect(expectedRuns.length).toBeGreaterThanOrEqual(2);
    expect(topSpenderRuns).toEqual(expectedRuns);
    expect(topSpenderRuns[0]!.getTime()).toBeGreaterThan(DEPLOY.getTime());
    expect(statusChecked).toBe(true);
    // Money is untouched: transactions keeps its hourly slot.
    const transactionsOffset = computePageSyncSlotOffsetSeconds(page.id, "transactions");
    expect(transactionRuns).toBe(
      computeCurrentPageSyncSlot(end, 3600, transactionsOffset) -
        computeCurrentPageSyncSlot(LAST_HOURLY_RUN, 3600, transactionsOffset),
    );
    expect(transactionRuns).toBeGreaterThanOrEqual(13);
  });

  it("keeps the watchdog and Sync now working on the 6-hour grid", async () => {
    const { page, firstBoundary } = await seedPageBeforeDeploy(["top_spenders"]);
    await ensurePageSyncStates(db.db, { pageId: page.id, now: DEPLOY });
    const secondBoundary = new Date(firstBoundary.getTime() + SIX_HOURS_MS);
    expect(await tick(page.id, firstBoundary)).toEqual(["top_spenders"]);

    // sync_silent: an idle lane between 6-hour slots is not due...
    const midGap = new Date(firstBoundary.getTime() + 3 * HOUR_MS);
    expect(await tick(page.id, midGap)).toEqual([]);
    expect((await getFanslySyncLiveness(db.db, { since: midGap, dueBefore: midGap })).hasDueStream).toBe(false);
    // ...and a planner that stopped claiming its next slot still shows.
    const afterSecond = new Date(secondBoundary.getTime() + 10 * 60_000);
    expect((await getFanslySyncLiveness(db.db, { since: afterSecond, dueBefore: afterSecond })).hasDueStream)
      .toBe(true);

    // Sync now between slots runs at once, at manual priority...
    const manualAt = new Date(midGap.getTime() + 30 * 60_000);
    const [requested] = await requestPageSync(db.db, {
      pageId: page.id, streams: ["top_spenders"], source: "manual", now: manualAt,
    });
    expect(requested).toMatchObject({ stream: "top_spenders" });
    expect(await topSpendersRow(page.id)).toMatchObject({ status: "pending", requestSource: "manual" });
    expect(await listRunnablePageSync(db.db, manualAt)).toEqual([
      expect.objectContaining({ pageId: page.id, priority: 85 }),
    ]);
    expect(await tick(page.id, manualAt)).toEqual(["top_spenders"]);

    // ...and leaves the 6-hour grid where it was.
    expect(await tick(page.id, new Date(secondBoundary.getTime() - TICK_MS))).toEqual([]);
    expect(await tick(page.id, secondBoundary)).toEqual(["top_spenders"]);
    expect(await topSpendersRow(page.id)).toMatchObject({ requestSource: "scheduled", status: "idle" });
  });
});

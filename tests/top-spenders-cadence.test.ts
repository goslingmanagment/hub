import { describe, expect, it } from "vitest";

import {
  computeCurrentPageSyncSlot,
  computePageSyncSlotOffsetSeconds,
  getSyncStreamDependenciesForPage,
  rebasePageSyncLastScheduledSlot,
  SYNC_DOMAIN_POLICY,
  SYNC_STREAM_DEPENDENCIES,
  SYNC_STREAM_POLICY,
} from "@agency_hub_core/db";

import { FANSLY_ENGINE_SCOPE_STREAMS } from "../apps/runtime/src/services/sync-engine-levers.ts";

const HOUR = 3600;
const SIX_HOURS = 6 * HOUR;

// page_sync_states on production, 2026-09-30 (read-only): every Fansly
// top_spenders row as the hourly runtime left it.
const PROD_HOURLY_ROWS = [
  { label: "lora-1", pageId: 1, slotOffsetSeconds: 2637, lastScheduledSlot: 497426 },
  { label: "lora-2", pageId: 2, slotOffsetSeconds: 3598, lastScheduledSlot: 497426 },
  { label: "lora-3", pageId: 3, slotOffsetSeconds: 959, lastScheduledSlot: 497427 },
  { label: "lilly-1", pageId: 4, slotOffsetSeconds: 1920, lastScheduledSlot: 497427 },
  { label: "lilly-2", pageId: 5, slotOffsetSeconds: 2881, lastScheduledSlot: 497426 },
  { label: "ari-1", pageId: 10, slotOffsetSeconds: 486, lastScheduledSlot: 497427 },
];

function slotStartSeconds(slot: number, grid: { cadenceSeconds: number; slotOffsetSeconds: number }) {
  return slot * grid.cadenceSeconds + grid.slotOffsetSeconds;
}

describe("top_spenders cadence (owner decision 2026-09-30: read Fansly top spenders every 6 h)", () => {
  it("schedules the lane every 6 hours and still never judges it by a freshness target", () => {
    expect(SYNC_STREAM_POLICY.top_spenders).toMatchObject({
      cadenceSeconds: SIX_HOURS,
      defaultWorkClass: "maintenance",
      freshnessSlaSeconds: null,
    });
  });

  it("keeps the lane's place in financials, its dependency and the DM ordering unchanged", () => {
    // Money freshness is judged on transactions alone; top_spenders only
    // supports the block, next to the already 6-hourly fan_identities lane.
    expect(SYNC_DOMAIN_POLICY.financials).toMatchObject({
      primaryStreams: ["transactions"],
      supportingStreams: ["fan_identities", "top_spenders"],
      freshnessSlaSeconds: 3 * HOUR,
    });
    expect(SYNC_STREAM_DEPENDENCIES.top_spenders).toEqual(["transactions"]);
    // The DM lanes wait for the first top_spenders success only (dependencyMet
    // reads succeeded_at/applied_seq, not age), so a 6-hour gap never blocks them.
    for (const stream of ["dm_conversations", "dm_messages"] as const) {
      expect(getSyncStreamDependenciesForPage({ platform: "fansly", stream })).toContain("top_spenders");
    }
    expect(FANSLY_ENGINE_SCOPE_STREAMS.data).toContain("top_spenders");
    expect(FANSLY_ENGINE_SCOPE_STREAMS.all).toContain("top_spenders");
  });

  it("re-expresses the last scheduled slot on the new grid, keeping the instant it covered", () => {
    const hourly = { cadenceSeconds: HOUR, slotOffsetSeconds: 0 };
    const sixHourly = { cadenceSeconds: SIX_HOURS, slotOffsetSeconds: 0 };
    // Slot 13 of the hourly grid starts at 13:00; the 6-hour slot holding it
    // is slot 2 (12:00-18:00), so the next scheduled run is at 18:00.
    expect(rebasePageSyncLastScheduledSlot({ lastScheduledSlot: 13, from: hourly, to: sixHourly })).toBe(2);
    // Shrinking the cadence lands on the hourly slot the 6-hour slot started
    // in: an overdue lane gets its one catch-up run, never a stream of them.
    expect(rebasePageSyncLastScheduledSlot({ lastScheduledSlot: 2, from: sixHourly, to: hourly })).toBe(12);
    // An offset move alone shifts the grid, not the instant.
    expect(rebasePageSyncLastScheduledSlot({
      lastScheduledSlot: 2,
      from: sixHourly,
      to: { cadenceSeconds: SIX_HOURS, slotOffsetSeconds: 5 * HOUR },
    })).toBe(1);
    // Same grid: unchanged. Never scheduled: stays never scheduled.
    expect(rebasePageSyncLastScheduledSlot({ lastScheduledSlot: 13, from: hourly, to: hourly })).toBe(13);
    expect(rebasePageSyncLastScheduledSlot({ lastScheduledSlot: -1, from: hourly, to: sixHourly })).toBe(-1);
  });

  it.each(PROD_HOURLY_ROWS)("moves $label to its next 6-hour boundary within 6 hours of its last hourly slot", (row) => {
    const hourly = { cadenceSeconds: HOUR, slotOffsetSeconds: row.slotOffsetSeconds };
    const sixHourly = {
      cadenceSeconds: SIX_HOURS,
      slotOffsetSeconds: computePageSyncSlotOffsetSeconds(row.pageId, "top_spenders"),
    };
    const lastHourlyStart = slotStartSeconds(row.lastScheduledSlot, hourly);
    const rebased = rebasePageSyncLastScheduledSlot({
      lastScheduledSlot: row.lastScheduledSlot,
      from: hourly,
      to: sixHourly,
    });
    const nextDueSeconds = slotStartSeconds(rebased + 1, sixHourly);

    expect(slotStartSeconds(rebased, sixHourly)).toBeLessThanOrEqual(lastHourlyStart);
    expect(nextDueSeconds).toBeGreaterThan(lastHourlyStart);
    expect(nextDueSeconds - lastHourlyStart).toBeLessThanOrEqual(SIX_HOURS);
    // Not due at the moment of the last hourly slot: no catch-up run on deploy.
    expect(computeCurrentPageSyncSlot(new Date(lastHourlyStart * 1000), SIX_HOURS, sixHourly.slotOffsetSeconds))
      .toBe(rebased);
    // Kept as-is, the hourly slot number is not reached on the 6-hour grid
    // until the year 2310: the planner would never claim the lane again.
    expect(row.lastScheduledSlot).toBeGreaterThan(
      computeCurrentPageSyncSlot(new Date("2060-01-01T00:00:00Z"), SIX_HOURS, sixHourly.slotOffsetSeconds),
    );
  });
});

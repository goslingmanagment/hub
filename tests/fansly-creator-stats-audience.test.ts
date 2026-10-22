import { describe, expect, it } from "vitest";

import type { PlanContext } from "../apps/runtime/src/sync/engine/resource.ts";
import {
  lastFullHour,
  lastSettledDay,
  monthEndingWith,
  previousMonth,
  steadyGeoDays,
} from "../apps/runtime/src/sync/fansly/lib/creator-stats-audience.ts";
import { creatorStatsAudienceModule } from "../apps/runtime/src/sync/fansly/resources/creator-stats-audience.ts";
import type { SyncWorkRow } from "@agency_hub_core/db";

// The audience plane of Fansly's creator statistics (reference/fansly-creator-stats
// §5.5–5.9): which days, months and hours the polls and the history walk ask for.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("audience windows", () => {
  it("counts a day final two hours after it ends, an hour a lag after it ends", () => {
    expect(lastSettledDay(new Date("2026-10-22T01:59:00Z"))).toBe(D("2026-10-20"));
    expect(lastSettledDay(new Date("2026-10-22T02:00:00Z"))).toBe(D("2026-10-21"));
    expect(lastFullHour(new Date("2026-10-22T10:14:00Z"), 15 * 60_000)).toBe(Date.parse("2026-10-22T08:00:00Z"));
    expect(lastFullHour(new Date("2026-10-22T10:15:00Z"), 15 * 60_000)).toBe(Date.parse("2026-10-22T09:00:00Z"));
  });

  it("reads geo day by day from the first day not yet read final, at most a week back, yesterday on a first sweep", () => {
    const now = new Date("2026-10-22T09:00:00Z");
    expect(steadyGeoDays(now, null, 7)).toEqual({ firstDayMs: D("2026-10-21"), todayMs: D("2026-10-22") });
    expect(steadyGeoDays(now, D("2026-10-21"), 7)).toEqual({ firstDayMs: D("2026-10-22"), todayMs: D("2026-10-22") });
    expect(steadyGeoDays(now, D("2026-10-19"), 7).firstDayMs).toBe(D("2026-10-20"));
    expect(steadyGeoDays(now, D("2026-09-01"), 7).firstDayMs).toBe(D("2026-10-16"));
  });

  it("walks calendar months back to the account's first day", () => {
    const floor = Date.parse("2024-02-10T13:00:00Z");
    expect(monthEndingWith(D("2026-10-21"), floor)).toEqual({ afterMs: D("2026-10-01"), beforeMs: D("2026-10-21") });
    expect(previousMonth(D("2026-10-01"), floor)).toEqual({ afterMs: D("2026-09-01"), beforeMs: D("2026-09-30") });
    expect(previousMonth(D("2024-03-01"), floor)).toEqual({ afterMs: D("2024-02-10"), beforeMs: D("2024-02-29") });
    expect(previousMonth(D("2024-02-10"), floor)).toBeNull();
    expect(monthEndingWith(D("2024-02-09"), floor)).toBeNull();
  });
});

describe("audience sweeps", () => {
  const ctx = (now: string) => ({ now: new Date(now), pageId: 1 }) as unknown as PlanContext;
  const work = (cursor: unknown) => ({ cursor }) as unknown as SyncWorkRow;

  it("asks geo for yesterday and today per surface, then the 30-day tags, on a first sweep", async () => {
    const plan = await creatorStatsAudienceModule("audience").plan(work({}), ctx("2026-10-22T09:00:00Z"));
    expect(plan).toMatchObject({
      kind: "request",
      request: {
        spec: "stats.geo",
        params: { source: 0, afterMs: D("2026-10-21"), beforeMs: D("2026-10-21"), limit: 200 },
        step: { anchor: { firstDayMs: D("2026-10-21"), todayMs: D("2026-10-22"), settledMs: D("2026-10-21") }, index: 0 },
      },
    });
    const anchor = { firstDayMs: D("2026-10-21"), todayMs: D("2026-10-22"), settledMs: D("2026-10-21") };
    const last = await creatorStatsAudienceModule("audience").plan(work({ sweep: { anchor, index: 8 } }), ctx("2026-10-22T09:00:00Z"));
    expect(last).toMatchObject({
      kind: "request",
      request: { spec: "stats.tags", params: { source: 4, kind: 1, afterMs: D("2026-09-23"), beforeMs: D("2026-10-22"), limit: 200 } },
    });
    const past = await creatorStatsAudienceModule("audience").plan(work({ sweep: { anchor, index: 9 } }), ctx("2026-10-22T09:00:00Z"));
    expect(past).toMatchObject({ kind: "quarantine" });
  });

  it("reads each full hour of media shown once, catching up at most a day", async () => {
    const module = creatorStatsAudienceModule("media-shown");
    const nine = Date.parse("2026-10-22T09:00:00Z");
    expect(await module.plan(work({ memo: { lastHourMs: nine } }), ctx("2026-10-22T10:20:00Z")))
      .toEqual({ kind: "wait", reason: "not_due", until: new Date("2026-10-22T11:15:00Z") });
    expect(await module.plan(work({ memo: { lastHourMs: nine } }), ctx("2026-10-22T11:20:00Z"))).toMatchObject({
      kind: "request",
      request: { spec: "stats.media_shown", params: { endMs: nine + HOUR, hours: 1 }, step: { index: 0 } },
    });
    expect(await module.plan(work({ memo: { lastHourMs: nine - 3 * DAY } }), ctx("2026-10-22T11:20:00Z"))).toMatchObject({
      request: { params: { endMs: nine + HOUR - 23 * HOUR }, step: { anchor: { firstHourMs: nine + HOUR - 23 * HOUR, lastHourMs: nine + HOUR } } },
    });
  });

  it("reads benchmarks and active hours once per settled day", async () => {
    const module = creatorStatsAudienceModule("daily");
    expect(await module.plan(work({ memo: { settledMs: D("2026-10-21") } }), ctx("2026-10-22T23:00:00Z")))
      .toEqual({ kind: "wait", reason: "not_due", until: new Date("2026-10-23T02:00:00Z") });
    expect(await module.plan(work({ memo: { settledMs: D("2026-10-21") } }), ctx("2026-10-23T02:30:00Z"))).toMatchObject({
      request: { spec: "stats.media_benchmarks", params: { source: 0, afterMs: D("2026-09-23"), beforeMs: D("2026-10-22") } },
    });
    expect(await module.plan(work({ sweep: { anchor: { settledMs: D("2026-10-22") }, index: 3 } }), ctx("2026-10-23T02:30:00Z"))).toMatchObject({
      request: { spec: "stats.active_hours", params: { source: 0, afterMs: D("2026-07-25"), beforeMs: D("2026-10-22"), timezoneOffsetMinutes: 0 } },
    });
  });
});

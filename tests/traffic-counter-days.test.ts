import { describe, expect, it } from "vitest";

import { counterDayOf } from "../packages/db/src/repositories/traffic-counter-days.ts";

// A source without links is measured by its page's counter of new subscribers; a day's figure is final only once
// its row was written after the day ended.

const endOf17 = new Date("2026-11-17T21:00:00.000Z");
const day = { businessDate: "2026-11-17", endAt: endOf17, today: false };

describe("a counter page's day", () => {
  it("is final when its row was written after the day ended", () => {
    expect(counterDayOf({ newSubscribers: 14, updatedAt: new Date("2026-11-18T01:10:00.000Z") }, day))
      .toEqual({ businessDate: "2026-11-17", newSubscribers: 14, partial: null });
  });

  it("is partial when its row was last written before the day ended, and today always", () => {
    expect(counterDayOf({ newSubscribers: 9, updatedAt: new Date("2026-11-17T15:00:00.000Z") }, day))
      .toEqual({ businessDate: "2026-11-17", newSubscribers: null, partial: 9 });
    expect(counterDayOf({ newSubscribers: 3, updatedAt: new Date("2026-11-18T23:00:00.000Z") }, { ...day, today: true }))
      .toEqual({ businessDate: "2026-11-17", newSubscribers: null, partial: 3 });
  });

  it("is unknown without a row, never a zero", () => {
    expect(counterDayOf(undefined, day)).toEqual({ businessDate: "2026-11-17", newSubscribers: null, partial: null });
  });
});

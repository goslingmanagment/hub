import { describe, expect, it } from "vitest";

import { diffBusinessDays, toBusinessDate } from "@agency_hub_core/shared";

import { firstOfLast30BusinessDates } from "../packages/db/src/business-day.ts";

// «За 30 дней» of the fan card, «Онлайн» and the fan queues: 30 Moscow business
// dates, today among them. The lists once took 31 (`>= today - 30`) and, from
// 21:00 UTC, 32 (the session's UTC date), so one fan showed two sums.

describe("the last 30 business dates", () => {
  it.each([
    ["2026-11-06T16:00:00.000Z", "2026-10-08"],
    // Moscow's 23:59: still the 6th.
    ["2026-11-06T20:59:59.999Z", "2026-10-08"],
    // Moscow's 00:30 on the 7th while UTC is still on the 6th.
    ["2026-11-06T21:30:00.000Z", "2026-10-09"],
    ["2026-01-15T10:00:00.000Z", "2025-12-17"],
    ["2028-03-01T10:00:00.000Z", "2028-02-01"],
  ])("at %s start on %s and hold exactly 30 dates up to the Moscow today", (at, first) => {
    const now = new Date(at);
    expect(firstOfLast30BusinessDates(now)).toBe(first);
    expect(diffBusinessDays(first, toBusinessDate(now, "Europe/Moscow"))).toBe(30);
  });
});

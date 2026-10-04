import { describe, expect, it } from "vitest";

import {
  businessDateToUtcStart,
  nextBusinessDate,
  previousBusinessDate,
  toBusinessDate,
} from "@agency_hub_core/shared";

import { calendarDayStart } from "../apps/runtime/src/services/ai-usage.ts";

// chat-extension H-15: where a report day of the caller's own AI spend is cut
// (`clientAiUsageDaily` takes any IANA zone). The plain cut of the hub's other
// reports (businessDateToUtcStart) reads the zone's offset once, at the day's
// UTC midnight, and is an hour off next to a clock change in zones far from
// UTC or with a change at midnight. The route is
// tests/client-ai-usage.integration.test.ts.

const HOUR_MS = 60 * 60 * 1000;

/** Every day of 2026 in a zone, with where it starts and how long it is. */
function yearOfDays(timeZone: string): Array<{ day: string; start: Date; hours: number; plain: Date }> {
  const days = [];
  let day = "2026-01-01";
  let start = calendarDayStart(day, timeZone);
  while (day < "2027-01-01") {
    const next = nextBusinessDate(day);
    const nextStart = calendarDayStart(next, timeZone);
    days.push({
      day,
      start,
      hours: (nextStart.getTime() - start.getTime()) / HOUR_MS,
      plain: businessDateToUtcStart(day, timeZone),
    });
    day = next;
    start = nextStart;
  }
  return days;
}

describe("calendarDayStart", () => {
  it("cuts at the zone's own midnight on the days its clocks change", () => {
    // Zones whose rules have stood for many years, so the instants are safe to pin.
    const cases: ReadonlyArray<readonly [zone: string, day: string, start: string]> = [
      // Sydney enters summer time at 16:00Z on 3 October 2026 (+10 to +11): 4 October is 23 hours long.
      ["Australia/Sydney", "2026-10-03", "2026-10-02T14:00:00.000Z"],
      ["Australia/Sydney", "2026-10-04", "2026-10-03T14:00:00.000Z"],
      ["Australia/Sydney", "2026-10-05", "2026-10-04T13:00:00.000Z"],
      // ... and leaves it at 16:00Z on 3 April 2027: 4 April is 25 hours long.
      ["Australia/Sydney", "2027-04-04", "2027-04-03T13:00:00.000Z"],
      ["Australia/Sydney", "2027-04-05", "2027-04-04T14:00:00.000Z"],
      // Auckland, +12 to +13 at 14:00Z on 26 September 2026.
      ["Pacific/Auckland", "2026-09-27", "2026-09-26T12:00:00.000Z"],
      ["Pacific/Auckland", "2026-09-28", "2026-09-27T11:00:00.000Z"],
      // Lord Howe moves by half an hour.
      ["Australia/Lord_Howe", "2026-10-04", "2026-10-03T13:30:00.000Z"],
      ["Australia/Lord_Howe", "2026-10-05", "2026-10-04T13:00:00.000Z"],
      // West of UTC the plain cut is right already, and stays as it was.
      ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z"],
      ["America/New_York", "2026-11-02", "2026-11-02T05:00:00.000Z"],
      ["Europe/Moscow", "2026-10-04", "2026-10-03T21:00:00.000Z"],
      ["UTC", "2026-10-04", "2026-10-04T00:00:00.000Z"],
    ];
    for (const [zone, day, start] of cases) {
      expect(calendarDayStart(day, zone).toISOString(), `${zone} ${day}`).toBe(start);
    }
    // What the plain cut answers for the first of them: 23:00 on 3 October in Sydney.
    expect(businessDateToUtcStart("2026-10-04", "Australia/Sydney").toISOString()).toBe("2026-10-03T13:00:00.000Z");
  });

  it("starts every day of a year where the zone's date turns to it", () => {
    // Clock changes far east of UTC, by half an hour, at local midnight (the
    // midnight is skipped or comes twice: Santiago, Cairo, Beirut, Nuuk,
    // Havana), and none at all. No instant is pinned here, so a rule a
    // government changes later does not break the test.
    const zones = [
      "Australia/Sydney", "Australia/Lord_Howe", "Pacific/Auckland", "Pacific/Chatham",
      "America/Santiago", "Africa/Cairo", "Asia/Beirut", "America/Godthab", "America/Havana",
      "Asia/Jerusalem", "America/New_York", "Europe/London", "Europe/Moscow", "UTC",
    ];
    for (const zone of zones) {
      for (const { day, start, hours } of yearOfDays(zone)) {
        const label = `${zone} ${day}`;
        expect(toBusinessDate(start, zone), label).toBe(day);
        expect(toBusinessDate(new Date(start.getTime() - 1), zone), label).toBe(previousBusinessDate(day));
        // Days abut by construction (each ends where the next starts); none is
        // longer or shorter than a clock change makes it.
        expect(hours, label).toBeGreaterThanOrEqual(23);
        expect(hours, label).toBeLessThanOrEqual(25);
      }
    }
  });

  it("differs from the plain cut only next to a clock change", () => {
    const moved = (zone: string) => yearOfDays(zone).filter(({ start, plain }) => start.getTime() !== plain.getTime());
    // The hub's own zones have no clock changes: nothing moves for the cabinet's reports.
    expect(moved("Europe/Moscow")).toEqual([]);
    expect(moved("UTC")).toEqual([]);
    expect(moved("America/New_York")).toEqual([]);
    // Sydney: the two days its clocks change on, whose midnights come before the change.
    expect(moved("Australia/Sydney").map(({ day }) => day)).toEqual(["2026-04-05", "2026-10-04"]);
  });
});

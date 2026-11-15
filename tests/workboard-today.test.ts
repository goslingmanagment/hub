import { describe, expect, it } from "vitest";

import type { PersonScheduleSlotRow } from "@agency_hub_core/db";
import { ruleSlotsOf } from "../apps/runtime/src/services/sale-homes.ts";
import { absentNow, scheduleGaps, type TodayTeamMember } from "../apps/runtime/src/services/workboard-today.ts";

// Workboard «Сегодня» of a team lead: whom the schedule names now and who is not on a shift, and the hours of the
// next three days no slot covers. The slots are read as the «whose sale» rule reads them (`slotRuns`).

const msk = (day: string, time: string) => Date.parse(`${day}T${time}:00+03:00`);

function slot(id: number, personId: number, start: number, end: number, pageId: number | null = null): PersonScheduleSlotRow {
  return { id, personId, pageId, pageLabel: null, startMinute: start * 60, endMinute: end * 60, weekdays: null, validFrom: "2026-11-01", validTo: null, kind: null, questionId: null };
}

const members: TodayTeamMember[] = [
  { personId: 1, name: "Аня", userIds: [11], pageIds: [100] },
  { personId: 2, name: "Боря", userIds: [12], pageIds: [100] },
];
// Аня 10:00–18:00, Боря 18:00–02:00: the night 02:00–10:00 is nobody's.
const rows = [slot(1, 1, 10, 18), slot(2, 2, 18, 2)];
const slots = ruleSlotsOf({ slots: rows, logins: [{ personId: 1, userId: 11 }, { personId: 2, userId: 12 }], from: new Date(msk("2026-11-14", "00:00")), to: new Date(msk("2026-11-20", "00:00")) });

describe("absentNow", () => {
  it("names a person whose slot began a quarter of an hour ago or more and who is not on a shift, with the slot's clock", () => {
    const now = msk("2026-11-15", "18:30");
    expect(absentNow({ members, slots, rows, going: new Set(), now }).map((one) => [one.member.name, one.start, one.end])).toEqual([["Боря", "18:00", "02:00"]]);
    // On a shift: not absent. Ten minutes into the slot: not yet.
    expect(absentNow({ members, slots, rows, going: new Set([12]), now })).toEqual([]);
    expect(absentNow({ members, slots, rows, going: new Set(), now: msk("2026-11-15", "18:10") })).toEqual([]);
  });
});

describe("scheduleGaps", () => {
  it("joins the uncovered half hours into ranges, cut at Moscow midnight, over the next three days", () => {
    const gaps = scheduleGaps({ members, slots, now: msk("2026-11-15", "12:00") });
    expect(gaps).toEqual([
      { day: "2026-11-16", start: "02:00", end: "10:00" },
      { day: "2026-11-17", start: "02:00", end: "10:00" },
      { day: "2026-11-18", start: "02:00", end: "10:00" },
    ]);
  });

  it("says the whole day is open when nobody has a slot", () => {
    const gaps = scheduleGaps({ members, slots: [], now: msk("2026-11-15", "23:10") });
    expect(gaps[0]).toEqual({ day: "2026-11-15", start: "23:30", end: "24:00" });
    expect(gaps[1]).toEqual({ day: "2026-11-16", start: "00:00", end: "24:00" });
  });
});

import { describe, expect, it } from "vitest";

import type { ShiftRowFacts, ShiftRowRecord } from "@agency_hub_core/db";
import { dayOfWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { planShiftRows, reportDateOfShift } from "../apps/runtime/src/services/shift-rows.ts";

// A shift as a row with a stable id (shift-rows.ts): its id survives a start that moves, two pieces that merge and a
// shift late activity unmade; and the one report date of a shift, pinned by ledger's examples.

const msk = (at: string) => new Date(`${at.replace(" ", "T")}:00+03:00`);

function facts(userId: number, from: string, to: string, state: ShiftRowFacts["state"] = "closed"): ShiftRowFacts {
  const startedAt = msk(from);
  const endedAt = msk(to);
  return {
    userId, state, startedAt, endedAt, workedMinutes: Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000), messages: 80,
    reportDate: reportDateOfShift({ startedAt: startedAt.getTime(), endedAt: endedAt.getTime() }), pages: [], pauses: [],
  };
}

function row(id: number, one: ShiftRowFacts, state: ShiftRowRecord["state"] = one.state): ShiftRowRecord {
  return { ...one, id, state, mergedInto: null };
}

const from = msk("2026-11-10 00:00");

describe("the report date of a shift (ledger internal/payroll/source_test.go)", () => {
  // The day it starts, unless it starts in the last two hours before midnight and mostly lies in the next day.
  const cases: Array<[string, string, string]> = [
    ["2026-11-10 10:00", "2026-11-10 18:00", "2026-11-10"], // a day shift
    ["2026-11-10 23:00", "2026-11-11 07:00", "2026-11-11"], // an hour before midnight, seven after: the next day
    ["2026-11-10 22:00", "2026-11-11 02:30", "2026-11-11"], // two hours before, two and a half after
    ["2026-11-10 22:00", "2026-11-11 02:00", "2026-11-10"], // half and half: the day it starts
    ["2026-11-10 22:30", "2026-11-11 01:00", "2026-11-10"], // mostly before midnight
    ["2026-11-10 21:00", "2026-11-11 05:00", "2026-11-10"], // three hours before midnight: too early for the exception
    ["2026-11-10 22:00", "2026-11-10 23:50", "2026-11-10"], // ends before midnight
    ["2026-11-11 00:00", "2026-11-11 08:00", "2026-11-11"], // starts at midnight
  ];
  it.each(cases)("%s — %s is reported on %s", (start, end, want) => {
    expect(reportDateOfShift({ startedAt: msk(start).getTime(), endedAt: msk(end).getTime() })).toBe(want);
  });

  it("differs from the day the screens give a shift only for an evening start that mostly lies after midnight", () => {
    const work = (start: string, end: string) => ({ startedAt: msk(start).getTime(), endedAt: msk(end).getTime() });
    const differ = cases.filter(([start, end]) => reportDateOfShift(work(start, end)) !== dayOfWork(work(start, end)));
    expect(differ.map(([start, end]) => `${start} — ${end}`)).toEqual(["2026-11-10 21:00 — 2026-11-11 05:00"]);
  });
});

describe("shift rows across syncs", () => {
  it("opens a row for a shift it has not seen, going or over", () => {
    const going = facts(1, "2026-11-11 16:00", "2026-11-11 19:00", "going");
    expect(planShiftRows({ existing: [], computed: [going], from })).toEqual({ open: [going], update: [], merge: [], drop: [] });
  });

  it("keeps a going shift's id as its end moves, and traces only its close and a moved start", () => {
    const before = row(7, facts(1, "2026-11-11 16:00", "2026-11-11 19:00", "going"));
    const later = facts(1, "2026-11-11 16:00", "2026-11-11 19:10", "going");
    expect(planShiftRows({ existing: [before], computed: [later], from }).update).toEqual([{ id: 7, change: null, before, after: later }]);
    const closed = facts(1, "2026-11-11 16:00", "2026-11-12 00:05");
    expect(planShiftRows({ existing: [before], computed: [closed], from }).update).toEqual([{ id: 7, change: "closed", before, after: closed }]);
    // A look-in before it joined it: the same id, its start moved.
    const joined = facts(1, "2026-11-11 15:10", "2026-11-11 19:10", "going");
    expect(planShiftRows({ existing: [before], computed: [joined], from }).update).toEqual([{ id: 7, change: "moved", before, after: joined }]);
    // Nothing changed: nothing written.
    const over = row(8, closed);
    expect(planShiftRows({ existing: [over], computed: [closed], from })).toEqual({ open: [], update: [], merge: [], drop: [] });
  });

  it("merges two rows late activity made one shift into the older id", () => {
    const morning = row(3, facts(1, "2026-11-11 08:00", "2026-11-11 10:30"));
    const noon = row(5, facts(1, "2026-11-11 11:20", "2026-11-11 16:00"));
    const day = facts(1, "2026-11-11 08:00", "2026-11-11 16:00");
    const plan = planShiftRows({ existing: [noon, morning], computed: [day], from });
    expect(plan.update).toEqual([{ id: 3, change: "moved", before: morning, after: day }]);
    expect(plan.merge).toEqual([{ id: 5, into: 3, before: noon }]);
    expect(plan.open).toEqual([]);
    expect(plan.drop).toEqual([]);
  });

  it("splits a row late activity cut in two: the first keeps the id, the second is new", () => {
    const day = row(3, facts(1, "2026-11-11 08:00", "2026-11-11 16:00"));
    const morning = facts(1, "2026-11-11 08:00", "2026-11-11 10:30");
    const noon = facts(1, "2026-11-11 11:40", "2026-11-11 16:00");
    const plan = planShiftRows({ existing: [day], computed: [noon, morning], from });
    expect(plan.update).toEqual([{ id: 3, change: "moved", before: day, after: morning }]);
    expect(plan.open).toEqual([noon]);
  });

  it("drops a row no shift overlaps any more, and restores it when one does again", () => {
    const short = row(4, facts(1, "2026-11-11 08:00", "2026-11-11 09:30"));
    expect(planShiftRows({ existing: [short], computed: [], from }).drop).toEqual([{ id: 4, before: short }]);
    const dropped = { ...short, state: "dropped" as const };
    expect(planShiftRows({ existing: [dropped], computed: [], from })).toEqual({ open: [], update: [], merge: [], drop: [] });
    const again = facts(1, "2026-11-11 08:00", "2026-11-11 10:30");
    expect(planShiftRows({ existing: [dropped], computed: [again], from }).update).toEqual([{ id: 4, change: "restored", before: dropped, after: again }]);
  });

  it("leaves the rows before the look-back alone, and never takes another person's row", () => {
    const old = row(1, facts(1, "2026-11-09 08:00", "2026-11-09 16:00"));
    const edge = row(2, facts(2, "2026-11-09 20:00", "2026-11-10 04:00"));
    // The read cut the edge shift: it only keeps its row from being dropped.
    const cut = facts(2, "2026-11-09 23:00", "2026-11-10 04:00");
    const colleague = facts(3, "2026-11-10 10:00", "2026-11-10 18:00");
    const plan = planShiftRows({ existing: [old, edge], computed: [cut, colleague], from });
    expect(plan).toEqual({ open: [colleague], update: [], merge: [], drop: [] });
  });
});

import type { HandinRow, HandinShift } from "@agency_hub_core/db";
import { describe, expect, it } from "vitest";

import { otherShiftsOf } from "../apps/runtime/src/services/shift-report-board-view.ts";

// A day split by a long break (2026-11-19): the morning shift closed without a report holds the person's sale, the
// afternoon one is going. The board of the afternoon must point at the morning, or the sale stays out of every report.

const shift = (id: number, state: HandinShift["state"], from: string, to: string): HandinShift => ({
  id, userId: 31, state, startedAt: new Date(from), endedAt: new Date(to), workedMinutes: 120, reportDate: from.slice(0, 10), pages: [], mergedInto: null,
});
const handin = (phase: HandinRow["phase"], state: HandinRow["state"] = "open"): Pick<HandinRow, "phase" | "state"> => ({ phase, state });

const morning = shift(110, "closed", "2026-11-19T05:00:00Z", "2026-11-19T08:02:00Z");
const afternoon = shift(112, "going", "2026-11-19T10:24:00Z", "2026-11-19T13:20:00Z");
const yesterday = shift(103, "closed", "2026-11-18T05:01:00Z", "2026-11-18T13:10:00Z");

describe("otherShiftsOf", () => {
  it("names the morning shift not handed in on the afternoon's board, and the way back from the morning's", () => {
    const shifts = [afternoon, morning, yesterday];
    const handins = new Map([[103, handin("counted", "submitted")], [112, handin("draft")]]);
    expect(otherShiftsOf({ shifts, handins, shiftId: 112 }).map((one) => [one.shift.id, one.phase])).toEqual([[110, "draft"]]);
    expect(otherShiftsOf({ shifts, handins, shiftId: 110 }).map((one) => one.shift.id)).toEqual([112]);
  });

  it("keeps a closed shift waiting for «Подтверждаю» or a fix, drops one checked or counted", () => {
    const shifts = [afternoon, morning, yesterday];
    expect(otherShiftsOf({ shifts, handins: new Map([[110, handin("confirm")], [103, handin("fixing")]]), shiftId: 112 })
      .map((one) => [one.shift.id, one.phase])).toEqual([[103, "fixing"], [110, "confirm"]]);
    expect(otherShiftsOf({ shifts, handins: new Map([[110, handin("checking")], [103, handin("draft", "submitted")]]), shiftId: 112 })).toEqual([]);
  });
});

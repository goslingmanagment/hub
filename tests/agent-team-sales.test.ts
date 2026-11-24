import { describe, expect, it } from "vitest";

import { agentTeamSalesBodySchema, agentTeamSalesResponseSchema } from "@agency_hub_core/contracts";
import type { ShiftRowRecord } from "@agency_hub_core/db";
import type { ComputedWork } from "../apps/runtime/src/services/chatter-shifts.ts";
import { holdersOf, workRef, workReportDateOf } from "../apps/runtime/src/services/agent-team-sales.ts";

// The ledger's split rules read who held a page at a sale from Hub (ledger release 2): a shift by `workHoldsSale`, a
// look-in only when its person wrote to the fan last — as «Заработок» counts it.

const MIN = 60_000;
const T = Date.parse("2026-11-10T12:00:00Z");

function work(kind: "shift" | "visit", startedAt: number, endedAt: number, salesSince: Record<string, number>): ComputedWork {
  return {
    kind, startedAt, endedAt, ongoing: false, workedMinutes: Math.round((endedAt - startedAt) / MIN), pauses: [], lastInputAt: endedAt - MIN,
    lastBeatAt: endedAt - MIN, pages: new Map(Object.keys(salesSince).map((label) => [label, 60])), messages: new Map(), salesSince: new Map(Object.entries(salesSince)),
  };
}

describe("who held a page at a sale", () => {
  const shift = work("shift", T - 60 * MIN, T + 60 * MIN, { "page-a": T - 30 * MIN });
  const visit = work("visit", T - 10 * MIN, T + 10 * MIN, { "page-a": T - 10 * MIN });
  const works = [{ userId: 1, work: shift }, { userId: 2, work: visit }];

  it("names a shift that held the page, and a look-in only when its person wrote to the fan last", () => {
    expect(holdersOf(works, { pageLabel: "page-a", at: T }, null)).toEqual([workRef(1, shift)]);
    expect(holdersOf(works, { pageLabel: "page-a", at: T }, 2)).toEqual([workRef(1, shift), workRef(2, visit)]);
  });

  it("names nobody before the shift began on the page, after it ended, or on another page", () => {
    expect(holdersOf(works, { pageLabel: "page-a", at: T - 40 * MIN }, 1)).toEqual([]);
    expect(holdersOf(works, { pageLabel: "page-a", at: T + 60 * MIN }, 1)).toEqual([]);
    expect(holdersOf(works, { pageLabel: "page-b", at: T }, 1)).toEqual([]);
  });
});

describe("the window of one read", () => {
  it("takes at most 31 days, from before to", () => {
    expect(agentTeamSalesBodySchema.safeParse({ from: "2026-11-01T00:00:00+03:00", to: "2026-12-01T00:00:00+03:00" }).success).toBe(true);
    expect(agentTeamSalesBodySchema.safeParse({ from: "2026-11-01T00:00:00+03:00", to: "2026-12-03T00:00:00+03:00" }).success).toBe(false);
    expect(agentTeamSalesBodySchema.safeParse({ from: "2026-11-02T00:00:00+03:00", to: "2026-11-01T00:00:00+03:00" }).success).toBe(false);
  });
});

describe("works[] optional personCode/reportDate and marks: [] compatibility", () => {
  it("resolves reportDate for handed-in shifts, open shifts, and visits", () => {
    const start = Date.parse("2026-11-11T15:00:00Z"); // 18:00 MSK
    const end = Date.parse("2026-11-11T23:00:00Z"); // 02:00 MSK next day
    const shiftRow: ShiftRowRecord = {
      id: 42,
      userId: 1,
      state: "closed",
      startedAt: new Date(start),
      endedAt: new Date(end),
      workedMinutes: 480,
      messages: 50,
      reportDate: "2026-11-11",
      pages: [],
      pauses: [],
      mergedInto: null,
    };
    const shiftWork = work("shift", start, end, { "page-a": start });
    const visitWork = work("visit", Date.parse("2026-11-12T07:00:00Z"), Date.parse("2026-11-12T07:30:00Z"), { "page-a": Date.parse("2026-11-12T07:00:00Z") });
    expect(workReportDateOf({ userId: 1, work: shiftWork, shiftRows: [shiftRow], handedInDates: new Map([[42, "2026-11-10"]]) })).toBe("2026-11-10");
    expect(workReportDateOf({ userId: 1, work: shiftWork, shiftRows: [shiftRow], handedInDates: new Map() })).toBe("2026-11-11");
    expect(workReportDateOf({ userId: 1, work: visitWork, shiftRows: [shiftRow], handedInDates: new Map() })).toBe("2026-11-12");
  });

  it("accepts works[] with or without personCode/reportDate and preserves marks: [] on sales", () => {
    const base = {
      from: "2026-11-11T00:00:00.000Z",
      to: "2026-11-12T00:00:00.000Z",
      workFrom: "2026-11-10T00:00:00.000Z",
      workTo: "2026-11-12T00:00:00.000Z",
      pages: ["mia-1"],
      works: [
        {
          ref: "1:2026-11-11T10:00:00.000Z",
          userId: 1,
          username: "anna",
          role: "chatter" as const,
          personCode: "anna",
          reportDate: "2026-11-11",
          kind: "shift" as const,
          startedAt: "2026-11-11T10:00:00.000Z",
          endedAt: "2026-11-11T16:00:00.000Z",
          ongoing: false,
          workedMinutes: 360,
          pages: [{ pageLabel: "mia-1", messages: 12, salesFrom: "2026-11-11T10:00:00.000Z" }],
        },
        {
          ref: "2:2026-11-11T10:00:00.000Z",
          userId: 2,
          username: "boris",
          role: "chatter" as const,
          kind: "visit" as const,
          startedAt: "2026-11-11T10:00:00.000Z",
          endedAt: "2026-11-11T10:30:00.000Z",
          ongoing: false,
          workedMinutes: 30,
          pages: [],
        },
      ],
      sales: [{
        transactionRef: "9001",
        pageLabel: "mia-1",
        platform: "fansly",
        fanRef: "fan-1",
        kind: "tip" as const,
        netMills: 10_000,
        occurredAt: "2026-11-11T12:00:00.000Z",
        holders: ["1:2026-11-11T10:00:00.000Z"],
        ppvSender: null,
        ppvSentAt: null,
        ppvWithoutAuthor: false,
        postTip: false,
        campaign: false,
        lastWriterUserId: null,
        writers: [],
        marks: [],
        resolution: null,
        decision: null,
      }],
      serverNow: "2026-11-12T00:00:00.000Z",
    };
    const parsed = agentTeamSalesResponseSchema.parse(base);
    expect(parsed.works[0]).toMatchObject({ personCode: "anna", reportDate: "2026-11-11" });
    expect(parsed.works[1]!.personCode).toBeUndefined();
    expect(parsed.sales[0]!.marks).toEqual([]);
  });
});

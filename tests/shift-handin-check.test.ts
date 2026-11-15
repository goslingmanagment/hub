import { agentShiftReportsFeedItemSchema } from "@agency_hub_core/contracts";
import type { HandinVersionLine } from "@agency_hub_core/db";
import { describe, expect, it } from "vitest";

import { compareWindow, pageCheckState } from "../apps/runtime/src/services/shift-handin-check.ts";
import { feedLineOf } from "../apps/runtime/src/services/shift-handins.ts";
import { confirmedLines } from "../apps/runtime/src/services/shift-report-phases.ts";

// «Hub сверяет суммы» (package R §5): a page is «сошлись» only with proof that its window was read after the cutoff,
// and every row of the window compared; and the ledger's feed keeps its format whatever the board's words.

function line(id: number, over: Partial<HandinVersionLine> = {}): HandinVersionLine {
  return {
    transactionId: id, offPlatformId: null, group: "mine", pageLabel: "mia-2", kind: "tip", occurredAt: "2026-11-12T19:00:00.000Z", netMills: 10_000,
    rule: { home: "shift", reason: "holder", shareMills: 10_000, toUserId: null, senderUserId: null }, alreadyIn: null, statement: null,
    shareWithUserId: null, note: null, amountMills: 10_000, added: false, disputed: false, ...over,
  };
}

describe("a page's state in Hub's check", () => {
  const base = { askable: true, covered: false, missing: { count: 0, mills: 0 }, changed: 0, platform: "fansly" as const, waitedMs: 0 };

  it("is never «matched» without proof of coverage: running, then unchecked after 10 minutes", () => {
    expect(pageCheckState(base)).toBe("running");
    expect(pageCheckState({ ...base, platform: "onlyfans" })).toBe("statement");
    expect(pageCheckState({ ...base, waitedMs: 10 * 60_000 })).toBe("unchecked");
  });

  it("is unchecked at once for a page Hub cannot ask", () => {
    expect(pageCheckState({ ...base, askable: false, covered: true })).toBe("unchecked");
  });

  it("is matched when covered and nothing differs, found when a sale is missing or a sum or a state changed", () => {
    expect(pageCheckState({ ...base, covered: true })).toBe("matched");
    expect(pageCheckState({ ...base, covered: true, missing: { count: 2, mills: 40_000 } })).toBe("found");
    expect(pageCheckState({ ...base, covered: true, changed: 1 })).toBe("found");
    // Proven late is still proven: the check completes after the 10 minutes too.
    expect(pageCheckState({ ...base, covered: true, waitedMs: 3 * 3_600_000 })).toBe("matched");
  });
});

describe("what the check compares on a page", () => {
  it("finds the sales of the window the candidate lacks and the lines whose net or state changed", () => {
    const candidate = [line(1), line(2, { netMills: 20_000, amountMills: 20_000 }), line(3, { pageLabel: "mia-3" })];
    const draft = [...candidate, line(4, { amountMills: 15_000 }), line(5, { group: "near", amountMills: 0 })];
    const now = new Map([[1, { netMills: 10_000, state: "posted" }], [2, { netMills: 18_000, state: "posted" }], [3, { netMills: 10_000, state: "posted" }]]);
    const compared = compareWindow({ candidate, draft, now, pageLabel: "mia-2" });
    expect(compared.missing).toEqual({ count: 1, mills: 15_000, ids: [4] });
    expect(compared.changed).toBe(1);
  });

  it("counts a row Hub no longer knows, or one gone unknown, as changed", () => {
    const compared = compareWindow({ candidate: [line(1), line(2)], draft: [], now: new Map([[2, { netMills: 10_000, state: "unknown" }]]), pageLabel: "mia-2" });
    expect(compared.changed).toBe(2);
  });
});

describe("the ledger's feed keeps its format", () => {
  it("serves a version holding «отдал» and «в общак» lines in its own schema, as «не моё»", () => {
    const given = line(10, { statement: "give", toUserId: 77, amountMills: 0 });
    const pot = line(11, { statement: "pot", amountMills: 0 });
    const lines = [given, pot, line(12, { statement: "share", shareWithUserId: 77, amountMills: 5_000 })].flatMap(feedLineOf);
    const item = agentShiftReportsFeedItemSchema.parse({
      id: 1, seq: 1, person: "anna", hubUserId: 5, shiftId: 9, reportDate: "2026-11-12", version: 1, submittedAt: "2026-11-12T23:10:00.000Z",
      door: "workboard", telegramMessageRef: null, totalMills: 5_000, pages: [{ pageLabel: "mia-2", amountMills: 5_000 }], lines,
      offPlatform: [], comment: "", dayPaid: null, ruleVersion: "2026-11-12.1", madeFor: null,
    });
    expect(item.lines.map((one) => one.statement)).toEqual(["not_mine", "not_mine", "share"]);
    expect(JSON.stringify(item)).not.toMatch(/"give"|"pot"|toUserId/);
  });

  it("serves the system's version of a cancelled shift: no lines, a decision with no ids", () => {
    const item = agentShiftReportsFeedItemSchema.parse({
      id: 2, seq: 2, person: "anna", hubUserId: 5, shiftId: 9, reportDate: "2026-11-12", version: 2, submittedAt: "2026-11-13T10:00:00.000Z",
      door: "workboard", telegramMessageRef: null, totalMills: 0, pages: [{ pageLabel: "mia-2", amountMills: 0 }], lines: [],
      offPlatform: [], comment: "", dayPaid: null, ruleVersion: "2026-11-12.1",
      madeFor: { kind: "decision", claimId: null, decisionId: null, offPlatformId: null, transactionId: null, outcome: "cancelled", byUserId: 5 },
    });
    expect(item.lines).toEqual([]);
  });
});

describe("a sighting and a version", () => {
  it("never makes a version line without a Hub transaction: a version is made of the candidate's lines only", () => {
    // A «нет в Hub» row added on the board is no line of the draft (it has no transaction), so no candidate and no
    // version holds it until Hub holds the sale.
    const lines = confirmedLines([line(1), line(2)], []);
    expect(lines.every((one) => one.transactionId !== null)).toBe(true);
  });
});

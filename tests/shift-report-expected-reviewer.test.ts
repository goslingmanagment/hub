import { describe, expect, it, vi } from "vitest";

import { resolveExpectedReviewer, selectExpectedReviewer } from "../apps/runtime/src/services/shift-report-board.ts";
import type { PageCatalog } from "../apps/runtime/src/services/shift-report-draft.ts";

// Expected reviewer resolution at hand-in (OA-002 / 0440):
// 0 matching agents -> null; 1 -> that person; >1 -> first alphabetically by people.code with a warning;
// empty or unresolved shift pages -> null without matching partial page grants.

describe("selectExpectedReviewer", () => {
  it("returns null with no warning when no reviewer matches", () => {
    const warn = vi.fn();
    expect(selectExpectedReviewer([], warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the single matching reviewer with no warning", () => {
    const warn = vi.fn();
    expect(selectExpectedReviewer([{ personId: 42, code: "agent-a" }], warn)).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });

  it("picks the first reviewer alphabetically by people.code and invokes the warning callback when multiple match", () => {
    const warn = vi.fn();
    const picked = selectExpectedReviewer(
      [
        { personId: 1, code: "zeta-reviewer" },
        { personId: 99, code: "alpha-reviewer" },
        { personId: 5, code: "mid-reviewer" },
      ],
      warn,
    );
    expect(picked).toBe(99);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { personId: 99, code: "alpha-reviewer" },
      [
        { personId: 99, code: "alpha-reviewer" },
        { personId: 5, code: "mid-reviewer" },
        { personId: 1, code: "zeta-reviewer" },
      ],
    );
  });
});

describe("resolveExpectedReviewer", () => {
  const catalog: Pick<PageCatalog, "idOf"> = {
    idOf: new Map([
      ["mia-1", 101],
      ["mia-2", 102],
    ]),
  };

  it("returns null without querying reviewers when the shift has no pages or an unresolved page label", async () => {
    const execute = vi.fn();
    const logger = { warn: vi.fn() };
    const app = { db: { execute }, logger } as unknown as Parameters<typeof resolveExpectedReviewer>[0];

    expect(await resolveExpectedReviewer(app, { shift: { id: 1, userId: 7, pages: [] }, catalog })).toBeNull();
    expect(await resolveExpectedReviewer(app, {
      shift: {
        id: 2,
        userId: 7,
        pages: [
          { pageLabel: "mia-1", activeMinutes: 60, messages: 10, salesFrom: null },
          { pageLabel: "unknown-page", activeMinutes: 60, messages: 10, salesFrom: null },
        ],
      },
      catalog,
    })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("queries active reviewers in the shift's realm and warns when multiple cover all shift pages", async () => {
    const execute = vi.fn()
      // isTestUser
      .mockResolvedValueOnce({ rows: [{ test: false }] })
      // listShiftReportReviewers
      .mockResolvedValueOnce({
        rows: [
          { id: "20", code: "alpha-rev" },
          { id: "10", code: "beta-rev" },
        ],
      });
    const logger = { warn: vi.fn() };
    const app = { db: { execute }, logger } as unknown as Parameters<typeof resolveExpectedReviewer>[0];

    const picked = await resolveExpectedReviewer(app, {
      shift: {
        id: 55,
        userId: 7,
        pages: [
          { pageLabel: "mia-1", activeMinutes: 60, messages: 10, salesFrom: null },
          { pageLabel: "mia-2", activeMinutes: 60, messages: 10, salesFrom: null },
        ],
      },
      catalog,
      at: new Date("2026-11-12T20:00:00Z"),
    });

    expect(picked).toBe(20);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { shiftId: 55, realm: "live", picked: "alpha-rev", reviewers: ["alpha-rev", "beta-rev"] },
      expect.stringContaining("multiple active reviewers"),
    );
  });
});

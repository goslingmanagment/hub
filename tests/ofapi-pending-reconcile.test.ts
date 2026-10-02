import { describe, expect, it } from "vitest";

import { rescanProvesWindow } from "../apps/runtime/src/services/ofapi-pending-reconcile.ts";
import type { OfapiTransactionsBackfillPageResult } from "../apps/runtime/src/services/ofapi-transactions-backfill.ts";

function pageResult(
  overrides: Partial<OfapiTransactionsBackfillPageResult>,
): OfapiTransactionsBackfillPageResult {
  return {
    pageLabel: "lora-vip-of",
    pageId: 9,
    ofapiAccountId: "acct_vip",
    status: "written",
    reason: null,
    hasCredentials: false,
    activeNonOfapiTransactions: 0,
    apiPages: 1,
    rawRows: 40,
    normalizedRows: 40,
    skippedRows: 0,
    writtenRows: 40,
    minOccurredAt: null,
    maxOccurredAt: null,
    typeHistogram: {},
    statusHistogram: {},
    skippedReasons: {},
    overlap: { checked: 0, matched: 0, matchRate: null },
    months: [],
    paginationStopReason: "completed",
    budgetBlock: null,
    ...overrides,
  };
}

describe("rescanProvesWindow", () => {
  it("accepts a walk that read the feed to its end", () => {
    expect(rescanProvesWindow(pageResult({}))).toBe(true);
    expect(rescanProvesWindow(pageResult({ paginationStopReason: "reached_window_end" }))).toBe(true);
    expect(rescanProvesWindow(pageResult({ status: "dry_run" }))).toBe(true);
  });

  it("rejects the 2026-09-06 shape: refused before the first request, still `written`", () => {
    expect(rescanProvesWindow(pageResult({
      apiPages: 0,
      rawRows: 0,
      normalizedRows: 0,
      writtenRows: 0,
      paginationStopReason: "budget_exhausted",
      budgetBlock: "ofapi_credit_floor",
    }))).toBe(false);
  });

  it("rejects truncated walks, empty feeds, blocked and unknown pages", () => {
    expect(rescanProvesWindow(pageResult({
      paginationStopReason: "budget_exhausted",
      budgetBlock: "ofapi_daily_credit_budget",
    }))).toBe(false);
    expect(rescanProvesWindow(pageResult({ paginationStopReason: "page_cap" }))).toBe(false);
    expect(rescanProvesWindow(pageResult({ rawRows: 0, normalizedRows: 0, writtenRows: 0 }))).toBe(false);
    expect(rescanProvesWindow(pageResult({ status: "blocked", paginationStopReason: null }))).toBe(false);
    expect(rescanProvesWindow(pageResult({ pageId: null }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { parseTransactionUrl } from "../apps/dashboard/src/lib/transactionNavigation.ts";

// The one piece of «Операции» a sum depends on (design/screens/home-money.md §12.2):
// the list must add up to the number that was clicked on Главная.
const NOW = new Date("2026-11-04T10:00:00Z");
const query = (search: string, ctx: Partial<Parameters<typeof parseTransactionUrl>[1]> = {}) =>
  parseTransactionUrl(new URLSearchParams(search), { pageLabel: null, platform: "fansly", period: "7d", now: NOW, ...ctx });

describe("parseTransactionUrl", () => {
  it("turns the period into the platform's window, as the server counts it", () => {
    const fansly = query("", { pageLabel: "mia-1" });
    const onlyfans = query("", { pageLabel: "mia-of", platform: "onlyfans" });
    // 7 Moscow days: 29 Oct 00:00 MSK to 5 Nov 00:00 MSK.
    expect(fansly.success && fansly.data).toMatchObject({ pageLabel: "mia-1", from: "2026-10-28T21:00:00.000Z", to: "2026-11-04T21:00:00.000Z", reportableOnly: true, limit: 50 });
    // OnlyFans counts the same days.
    expect(onlyfans.success && onlyfans.data).toMatchObject({ from: "2026-10-28T21:00:00.000Z", to: "2026-11-04T21:00:00.000Z" });
  });

  it("keeps the exact window of a clicked sum over the period", () => {
    const parsed = query("from=2026-10-20T00:00:00.000Z&to=2026-10-27T00:00:00.000Z&type=tip", { period: "30d" });
    expect(parsed.success && parsed.data).toMatchObject({ from: "2026-10-20T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z", type: "tip" });
  });

  it("asks for the whole history for all time", () => {
    const parsed = query("", { period: "all" });
    expect(parsed.success && parsed.data.from).toBeUndefined();
    expect(parsed.success && parsed.data.to).toBeUndefined();
  });

  it("counts only reportable operations unless the address says otherwise", () => {
    expect(query("").success && query("").data?.reportableOnly).toBe(true);
    const all = query("reportableOnly=false");
    expect(all.success && all.data.reportableOnly).toBe(false);
  });

  it("refuses a link with half a window", () => {
    expect(query("from=2026-10-20T00:00:00.000Z").success).toBe(false);
  });

  it("never sends the page filter's reserved value", () => {
    const parsed = query("page=all", { pageLabel: null });
    expect(parsed.success && parsed.data.pageLabel).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import type { TeamLedgerReportPost } from "@agency_hub_core/contracts";
import { unparsedPostsToDecide } from "../packages/ui/src/shiftReports.ts";

/**
 * Which posts the ledger could not use wait for the owner (Workboard Решения, its sidebar count, the «Ждут решения»
 * line on Смены, the console's «Ждут вас»): none while the payout sheets pay, and once the posted reports accrue,
 * only those of the days they accrue — by the report date, or by the Moscow day of sending when the date was not read.
 */

const msk = (day: string, time: string) => new Date(`${day}T${time}:00+03:00`).toISOString();

function post(id: number, reportDate: string | null, postedAt: string, blocking = true): TeamLedgerReportPost {
  return {
    id, postedAt, sender: "Sender", tag: "", person: { slug: null, hubUser: null, name: "Sender" }, model: "Model",
    reportDate, totalMills: 100_000, pagesMills: 90_000, flags: blocking ? ["sum_mismatch"] : ["unknown_page"], blocking,
    pages: [], link: null,
  };
}

const ids = (posts: readonly TeamLedgerReportPost[]) => posts.map((one) => one.id);

describe("unparsedPostsToDecide", () => {
  const posts = [
    post(1, "2026-11-04", msk("2026-11-05", "02:00")),
    post(2, "2026-11-05", msk("2026-11-06", "01:00")),
    post(3, "2026-11-08", msk("2026-11-09", "00:30")),
    post(4, null, msk("2026-11-04", "23:59")),
    post(5, null, msk("2026-11-05", "00:10")),
    post(6, "2026-11-08", msk("2026-11-09", "00:30"), false),
  ];

  it("holds none while the reports do not accrue: no reportsFrom, or an empty one", () => {
    expect(unparsedPostsToDecide({ posts }, { reportsFrom: null })).toEqual([]);
    expect(unparsedPostsToDecide({ posts }, { reportsFrom: "" })).toEqual([]);
  });

  it("leaves out a post whose report date is before the switch and keeps one on it or after", () => {
    expect(ids(unparsedPostsToDecide({ posts: posts.slice(0, 3) }, { reportsFrom: "2026-11-05" }))).toEqual([2, 3]);
  });

  it("dates a post without a read date by the Moscow day it was sent: before the switch out, on it in", () => {
    // 23:59 Moscow on the 4th is 20:59 UTC — still the 4th; 00:10 Moscow on the 5th is the 4th in UTC, the 5th in Moscow.
    expect(ids(unparsedPostsToDecide({ posts: posts.slice(3, 5) }, { reportsFrom: "2026-11-05" }))).toEqual([5]);
  });

  it("never holds a post the ledger used (no blocking flag), whatever its day", () => {
    expect(ids(unparsedPostsToDecide({ posts }, { reportsFrom: "2026-11-01" }))).toEqual([1, 2, 3, 4, 5]);
  });
});

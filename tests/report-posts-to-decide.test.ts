import { describe, expect, it } from "vitest";

import type { TeamLedgerReportPost } from "@agency_hub_core/contracts";
import { reportPostItems } from "../apps/runtime/src/services/matters-mirror.ts";

/**
 * Which posts the ledger could not use wait for the owner («Ждут вас», the matters of kind `ledger.report_post`):
 * none while the payout sheets pay, and once the posted reports accrue, only those of the days they accrue — by the
 * report date, or by the Moscow day of sending when the date was not read.
 */

const msk = (day: string, time: string) => new Date(`${day}T${time}:00+03:00`).toISOString();

function post(id: number, reportDate: string | null, postedAt: string, blocking = true): TeamLedgerReportPost {
  return {
    id, postedAt, sender: "Sender", tag: "", person: { slug: null, hubUser: null, name: "Sender" }, model: "Model",
    reportDate, totalMills: 100_000, pagesMills: 90_000, flags: blocking ? ["sum_mismatch"] : ["unknown_page"], blocking,
    pages: [], link: null,
  };
}

/** The posts that wait, by their ids: one matter per post. */
const waiting = (posts: readonly TeamLedgerReportPost[], reportsFrom: string | null) =>
  reportPostItems({ posts: [...posts] }, { reportsFrom }).map((item) => Number(item.object!.id));

describe("the posts that wait for the owner (reportPostItems)", () => {
  const posts = [
    post(1, "2026-11-04", msk("2026-11-05", "02:00")),
    post(2, "2026-11-05", msk("2026-11-06", "01:00")),
    post(3, "2026-11-08", msk("2026-11-09", "00:30")),
    post(4, null, msk("2026-11-04", "23:59")),
    post(5, null, msk("2026-11-05", "00:10")),
    post(6, "2026-11-08", msk("2026-11-09", "00:30"), false),
  ];

  it("holds none while the reports do not accrue: no reportsFrom, or an empty one", () => {
    expect(waiting(posts, null)).toEqual([]);
    expect(waiting(posts, "")).toEqual([]);
  });

  it("leaves out a post whose report date is before the switch and keeps one on it or after", () => {
    expect(waiting(posts.slice(0, 3), "2026-11-05")).toEqual([2, 3]);
  });

  it("dates a post without a read date by the Moscow day it was sent: before the switch out, on it in", () => {
    // 23:59 Moscow on the 4th is 20:59 UTC — still the 4th; 00:10 Moscow on the 5th is the 4th in UTC, the 5th in Moscow.
    expect(waiting(posts.slice(3, 5), "2026-11-05")).toEqual([5]);
  });

  it("never holds a post the ledger used (no blocking flag), whatever its day", () => {
    expect(waiting(posts, "2026-11-01")).toEqual([1, 2, 3, 4, 5]);
  });
});

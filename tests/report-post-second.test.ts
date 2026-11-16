import { describe, expect, it } from "vitest";

import { reportPostFixItems } from "../apps/runtime/src/services/matters-mirror.ts";

// A message in «Отчётность» that holds two reports (the ledger's flag `second_report`, ledger#98): the first is read and
// paid, the second is read by nobody. Its author is told in «Ждут вас», in words of its own: the post IS accrued, so the
// sentence of a blocked post («не начислен») would be a lie.

type Reports = Parameters<typeof reportPostFixItems>[0];
type Payouts = Parameters<typeof reportPostFixItems>[1];

const post = (id: number, flags: string[]) => ({
  id, flags, reportDate: "2026-11-10", postedAt: "2026-11-11T03:10:00.000Z", link: `https://t.me/c/1/${id}`,
  person: { slug: "alice", name: "Alice" }, pages: [{ pageLabel: "lora-1" }, { pageLabel: null }],
});
const reports = (posts: unknown[]) => ({ posts }) as unknown as Reports;
const payouts = { reportsFrom: "2026-11-01" } as unknown as Payouts;
const loginOf = new Map([["alice", 7]]);

describe("a message with two reports", () => {
  it("is the author's matter, in its own words, and never «не начислен»", () => {
    const [item, ...rest] = reportPostFixItems(reports([post(801, ["second_report"])]), payouts, loginOf);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      key: "report.post_fix:801", owner: { userId: 7 }, money: false, pageLabels: ["lora-1"],
      title: "В сообщении за 10 нояб. два отчёта: прочитан только первый. Отправьте второй в «Отчётность» отдельным сообщением",
      link: "/workboard/shifts/mine?week=2026-11-10&report=2026-11-10",
    });
    expect((item!.evidence as { flags: string[] }).flags).toEqual(["second_report"]);
  });

  it("keeps a blocked post's words first, and a clean post opens nothing", () => {
    const items = reportPostFixItems(reports([post(802, ["sum_mismatch", "second_report"]), post(803, [])]), payouts, loginOf);
    expect(items.map((one) => one.key)).toEqual(["report.post_fix:802"]);
    expect(items[0]!.title).toContain("не начислен: строки аккаунтов не дают итог");
    expect((items[0]!.evidence as { flags: string[] }).flags).toEqual(["sum_mismatch", "second_report"]);
  });

  it("closes once the author sent the second report as its own message (the ledger's own rule: a later post of the day)", () => {
    const resent = { ...post(806, []), postedAt: "2026-11-11T03:40:00.000Z" };
    expect(reportPostFixItems(reports([post(805, ["second_report"]), resent]), payouts, loginOf)).toEqual([]);
    // An earlier post of the day, or another person's, is no resend.
    const earlier = { ...post(807, []), postedAt: "2026-11-11T02:00:00.000Z" };
    const other = { ...post(808, []), postedAt: "2026-11-11T03:40:00.000Z", person: { slug: "bob", name: "Bob" } };
    expect(reportPostFixItems(reports([post(805, ["second_report"]), earlier, other]), payouts, loginOf).map((one) => one.key)).toEqual(["report.post_fix:805"]);
  });

  it("waits, like every post's matter, for the day the reports accrue from", () => {
    expect(reportPostFixItems(reports([post(804, ["second_report"])]), { reportsFrom: null } as unknown as Payouts, loginOf)).toEqual([]);
  });
});

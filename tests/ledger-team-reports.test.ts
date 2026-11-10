import { describe, expect, it } from "vitest";

import { readTeamLedgerReports, telegramPostLink } from "../apps/runtime/src/services/ledger-team-reports.ts";

/**
 * Every chatter's shift reports from the agency ledger for the owner: three reads joined per person and day,
 * micro-dollars in, mills out, a person by the report's Hub user id before any name, and never a wrong sum on a
 * changed answer. The posts may still be closed to Hub's key: that is «none read», not a 503.
 */

const users = [
  { id: 4, username: "alex.k" },
  { id: 5, username: "kate.v" },
  // Someone whose login is the ledger's code of another person: the Hub user id must win over the name.
  { id: 9, username: "anna" },
];

function app(logs: { info: unknown[]; warn: unknown[] } = { info: [], warn: [] }) {
  return {
    db: { query: { users: { findMany: async () => users } } },
    config: { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: "test-payouts-key" },
    logger: { warn: (details: unknown) => logs.warn.push(details), info: (details: unknown, message: string) => logs.info.push(message) },
  } as never;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 21, person: "anna", hub_username: "alex.k", hub_user_id: 4, chatter: "Алекс",
    report_date: "2026-11-08", window_from: "2026-11-08T16:00:00+03:00", window_to: "2026-11-09T00:00:00+03:00",
    cut_at: "2026-11-08T23:53:00+03:00", version: 2, versions: 2, status: "posted", source: "agent", total_micros: 100_000_000,
    created_at: "2026-11-08T23:54:10+03:00", posted_at: "2026-11-09T00:20:00+03:00",
    pages: [
      { page: "page-a", model: "model-x", amount_micros: 80_000_000, posted_micros: 92_500_000, post_state: "posted_changed" },
      { page: "page-b", model: "model-x", amount_micros: 20_000_000, posted_micros: 20_000_000, post_state: "posted_equal" },
    ],
    lines: [{
      n: 1, transaction_ref: "tx-1", page: "page-a", fan_ref: "fan-1", fan_name: "nick", kind: "tip", occurred_at: "2026-11-08T18:10:00+03:00",
      net_micros: 80_000_000, gross_micros: 100_000_000, counted: true, decision: "auto", added: false, what: "", flags: null, notes: null,
      ppv_author: "", ppv_sent_at: "",
    }],
    ...overrides,
  };
}

function day(overrides: Record<string, unknown> = {}) {
  return {
    person: "anna", report_date: "2026-11-08", page: "page-a", model: "model-x", posted_micros: 92_500_000, draft_micros: 80_000_000,
    diff_micros: 12_500_000, state: "posted_changed", posted_at: "2026-11-09T00:20:00+03:00", report_id: 21, post_id: 301,
    ...overrides,
  };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: 302, peer: "-1001000000001", topic: 4, msg_id: 77, posted_at: "2026-11-07T23:40:00+03:00", sender_id: "1", sender: "Катя",
    tag: "#катя", person: "kate", model: "model-x", report_date: "2026-11-07", total_micros: 134_200_000, pages_micros: 124_200_000,
    flags: ["sum_mismatch"], flag_texts: ["…"], blocked: true, versions: 1, text: "the post's own words", current: true,
    pages: [{ name: "page-a", page: "page-a", in_shift: true, amount_micros: 124_200_000 }],
    ...overrides,
  };
}

interface Answers {
  reports?: { status: number; body: unknown };
  days?: { status: number; body: unknown };
  posts?: { status: number; body: unknown };
}

function ledger(answers: Answers, seen: string[] = []) {
  const window = { from: "2026-11-02", to: "2026-11-08" };
  const by: Record<string, { status: number; body: unknown }> = {
    "/v1/reports": answers.reports ?? { status: 200, body: { ...window, reports: [draft()] } },
    "/v1/report-days": answers.days ?? { status: 200, body: { ...window, days: [day(), day({ page: "page-b", posted_micros: 20_000_000, draft_micros: 20_000_000, diff_micros: null, state: "posted_equal" })] } },
    "/v1/report-posts": answers.posts ?? { status: 200, body: { ...window, posts: [post()] } },
  };
  return (async (input: URL) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}?${url.searchParams.toString()}`);
    const answer = by[url.pathname] ?? { status: 404, body: { error: "no" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const query = { from: "2026-11-02", to: "2026-11-08" };
const now = new Date("2026-11-09T10:00:00Z");

describe("readTeamLedgerReports", () => {
  it("joins the drafts, the pay base and the posts per person and day, in mills, the person by the report's Hub user id", async () => {
    const seen: string[] = [];
    const result = await readTeamLedgerReports(app(), query, { fetchImpl: ledger({}, seen), now });

    expect(seen.sort()).toEqual([
      "/v1/report-days?from=2026-11-02&to=2026-11-08",
      "/v1/report-posts?from=2026-11-02&to=2026-11-08&flagged=1",
      "/v1/reports?from=2026-11-02&to=2026-11-08",
    ]);
    const [kate, anna] = [result.reports.find((one) => one.person.slug === "kate"), result.reports.find((one) => one.person.slug === "anna")];
    // The ledger's «anna» is Hub user 4 (alex.k) by the report — not the Hub login «anna», whose name only matches.
    expect(anna).toMatchObject({
      key: "person:anna:2026-11-08",
      person: { slug: "anna", hubUser: { userId: 4, username: "alex.k" }, name: "alex.k" },
      reportDate: "2026-11-08",
      postedMills: 112_500,
      draftMills: 100_000,
      pages: [
        { pageLabel: "page-a", model: "model-x", postedMills: 92_500, draftMills: 80_000, diffMills: 12_500, state: "posted_changed" },
        { pageLabel: "page-b", postedMills: 20_000, draftMills: 20_000, diffMills: null, state: "posted_equal" },
      ],
      postIds: [],
    });
    expect(anna!.draft).toMatchObject({ id: 21, totalMills: 100_000, pages: [{ pageLabel: "page-a", amountMills: 80_000 }, { pageLabel: "page-b", amountMills: 20_000 }] });
    expect(anna!.draft!.lines[0]).toMatchObject({ netMills: 80_000, flags: [], notes: [] });

    // A post the ledger could not use, on its person's day: that day exists for it, out of the pay base.
    expect(kate).toMatchObject({ person: { slug: "kate", hubUser: null, name: "kate" }, reportDate: "2026-11-07", pages: [], postedMills: null, draft: null, postIds: [302] });
    expect(result.posts).toEqual([{
      id: 302, postedAt: "2026-11-07T23:40:00+03:00", sender: "Катя", tag: "#катя",
      person: { slug: "kate", hubUser: null, name: "kate" }, model: "model-x", reportDate: "2026-11-07",
      totalMills: 134_200, pagesMills: 124_200, flags: ["sum_mismatch"], blocking: true,
      pages: [{ name: "page-a", pageLabel: "page-a", inShift: true, amountMills: 124_200 }],
      link: "https://t.me/c/1000000001/4/77",
    }]);
    expect(result.postsRead).toBe(true);
    // The post's text never reaches Hub's answer.
    expect(JSON.stringify(result)).not.toContain("the post's own words");
    // The newest day first.
    expect(result.reports.map((one) => one.reportDate)).toEqual(["2026-11-08", "2026-11-07"]);
  });

  it("keeps an unknown author unknown, and a draft of nobody the ledger knows is a day of its own", async () => {
    const result = await readTeamLedgerReports(app(), query, {
      fetchImpl: ledger({
        reports: { status: 200, body: { ...query, reports: [draft({ id: 30, person: null, hub_user_id: null, hub_username: "kate.v", pages: [{ page: "page-c", amount_micros: 5_000_000 }] })] } },
        days: { status: 200, body: { ...query, days: null } },
        posts: { status: 200, body: { ...query, posts: [post({ id: 303, person: null, report_date: null, flags: ["unknown_author"], sender: "alex.k" })] } },
      }),
      now,
    });
    expect(result.reports).toMatchObject([{
      key: "report:30",
      person: { slug: null, hubUser: { userId: 5, username: "kate.v" } },
      pages: [{ pageLabel: "page-c", postedMills: null, draftMills: 5_000, state: "draft_only" }],
    }]);
    // The sender's name is shown, never matched to a login.
    expect(result.posts[0]).toMatchObject({ person: { slug: null, hubUser: null, name: "alex.k" }, reportDate: null, blocking: true });
  });

  it("answers «none read» while the ledger refuses Hub the posts, said once in the log", async () => {
    const logs = { info: [] as unknown[], warn: [] as unknown[] };
    for (const status of [403, 404, 403]) {
      const result = await readTeamLedgerReports(app(logs), query, { fetchImpl: ledger({ posts: { status, body: { error: "no" } } }), now });
      expect(result.posts).toEqual([]);
      expect(result.postsRead).toBe(false);
      expect(result.reports).toHaveLength(1);
    }
    expect(logs.info).toHaveLength(1);
  });

  it("is a 503 on a changed answer of any read and on any other refusal", async () => {
    const changed = { ...query, reports: [draft({ total_micros: "100.00" })] };
    await expect(readTeamLedgerReports(app(), query, { fetchImpl: ledger({ reports: { status: 200, body: changed } }), now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readTeamLedgerReports(app(), query, { fetchImpl: ledger({ days: { status: 200, body: { ...query, days: [day({ posted_micros: "92.5" })] } } }), now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readTeamLedgerReports(app(), query, { fetchImpl: ledger({ posts: { status: 200, body: { ...query, posts: [post({ total_micros: null })] } } }), now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readTeamLedgerReports(app(), query, { fetchImpl: ledger({ posts: { status: 500, body: { error: "no" } } }), now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readTeamLedgerReports(app(), query, { fetchImpl: ledger({ days: { status: 403, body: { error: "no" } } }), now })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("refuses a window past 62 days before asking", async () => {
    const seen: string[] = [];
    await expect(readTeamLedgerReports(app(), { from: "2026-09-01", to: "2026-11-08" }, { fetchImpl: ledger({}, seen), now })).rejects.toMatchObject({ statusCode: 400 });
    expect(seen).toEqual([]);
  });
});

describe("telegramPostLink", () => {
  it("is the supergroup's message, in its topic when there is one", () => {
    expect(telegramPostLink("-1001000000001", 4, 77)).toBe("https://t.me/c/1000000001/4/77");
    expect(telegramPostLink("-1001000000001", 1, 77)).toBe("https://t.me/c/1000000001/77");
    expect(telegramPostLink("-1001000000001", 0, 77)).toBe("https://t.me/c/1000000001/77");
    expect(telegramPostLink("-4000000001", 4, 77)).toBeNull();
    expect(telegramPostLink("-1001000000001", 4, 0)).toBeNull();
  });
});

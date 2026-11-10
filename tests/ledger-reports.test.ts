import { describe, expect, it } from "vitest";

import { readAccountReports, reportsWindow } from "../apps/runtime/src/services/ledger-reports.ts";

/** The chatter's own shift reports from the agency ledger: micro-dollars in, mills out, only the caller's reports. */

const warnings: unknown[] = [];

function app(key: string | null = "test-payouts-key") {
  return {
    config: { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: key },
    logger: { warn: (details: unknown) => warnings.push(details) },
  } as never;
}

const principal = {
  authMethod: "session",
  authSessionId: 31,
  user: { id: 4, username: "Alex.K", role: "chatter", mustChangePassword: false, assignedPages: [] },
  assignedPageIds: [],
} as never;

function line(overrides: Record<string, unknown> = {}) {
  return {
    n: 1, transaction_ref: "tx-1", page: "page-a", fan_ref: "fan-1", fan_name: "nick", kind: "message_purchase",
    occurred_at: "2026-11-08T17:28:00+03:00", net_micros: 28_000_000, gross_micros: 35_000_000,
    counted: true, decision: "auto", added: false, what: "", flags: [], notes: ["text"], ppv_author: "alex.k", ppv_sent_at: "08.11 17:26",
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: 12, person: "alex", hub_username: "alex.k", hub_user_id: 4, chatter: "alex",
    report_date: "2026-11-08", window_from: "2026-11-08T16:00:00+03:00", window_to: "2026-11-09T00:00:00+03:00",
    cut_at: "2026-11-08T23:53:00+03:00", version: 2, versions: 2, status: "draft", source: "agent", total_micros: 31_520_000,
    created_at: "2026-11-08T23:54:10+03:00",
    pages: [{ page: "page-a", model: "model-a", amount_micros: 31_520_000 }, { page: "page-b", model: "", amount_micros: 0 }],
    lines: [
      line(),
      line({ n: 2, transaction_ref: null, fan_ref: "", fan_name: "", kind: "tip", occurred_at: null, net_micros: 3_520_000, gross_micros: null, added: true, what: "тип до окна смены", notes: null }),
      line({ n: null, transaction_ref: "tx-3", net_micros: 9_999_999, counted: false, flags: ["второй чаттер писал фану (§4.2)"] }),
    ],
    ...overrides,
  };
}

/** One page of a report day, as GET /v1/report-days serves it: posted as drafted by default. */
function day(overrides: Record<string, unknown> = {}) {
  return {
    person: "alex", report_date: "2026-11-08", page: "page-a", model: "model-a", posted_micros: 31_520_000, draft_micros: 31_520_000,
    diff_micros: null, state: "posted_equal", posted_at: "2026-11-09T00:20:00+03:00", report_id: 12, post_id: 301,
    ...overrides,
  };
}

type Answer = { status: number; body: unknown } | "unreachable";
interface Seen { urls: URL[]; auth: Array<string | undefined> }

/**
 * A fake ledger: GET /v1/reports answers `reports`, GET /v1/report-days answers `days` (by default: none of the
 * caller's days posted — an empty list).
 */
function ledger(reports: Answer, days: Answer = { status: 200, body: { from: "2026-10-28", to: "2026-11-10", days: [] } }, seen: Seen = { urls: [], auth: [] }) {
  return (async (input: URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.urls.push(url);
    seen.auth.push(new Headers(init?.headers).get("authorization") ?? undefined);
    const answer = url.pathname === "/v1/reports" ? reports : url.pathname === "/v1/report-days" ? days : { status: 404, body: { error: "no" } };
    if (answer === "unreachable") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const fetchReturning = (status: number, body: unknown) => ledger({ status, body });

const now = new Date("2026-11-10T09:00:00Z");
const answer = (reports: unknown[]) => ({ from: "2026-10-28", to: "2026-11-10", reports });
const daysAnswer = (days: unknown[]) => ({ status: 200, body: { from: "2026-10-28", to: "2026-11-10", days } });
const read = (reports: unknown[], days: Answer) => readAccountReports(app(), principal, {}, { fetchImpl: ledger({ status: 200, body: answer(reports) }, days), now });

describe("readAccountReports", () => {
  it("asks the ledger for the session's user and passes the report on in mills, without what the screen does not need", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const result = await readAccountReports(app(), principal, {}, { fetchImpl: ledger({ status: 200, body: answer([report()]) }, undefined, seen), now });

    // Both reads — the drafts and the posts — for the session's user, with Hub's key.
    expect(seen.urls.map((url) => url.origin + url.pathname).sort()).toEqual(["https://ledger.test/v1/report-days", "https://ledger.test/v1/reports"]);
    for (const url of seen.urls) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ from: "2026-10-28", to: "2026-11-10", hub_user_id: "4", hub_username: "Alex.K" });
    }
    expect(seen.auth).toEqual(["Bearer test-payouts-key", "Bearer test-payouts-key"]);
    expect(result.from).toBe("2026-10-28");
    expect(result.to).toBe("2026-11-10");
    expect(result.postsRead).toBe(true);
    const [only] = result.reports;
    expect(only).toMatchObject({
      source: "draft", id: 12, reportDate: "2026-11-08", version: 2, versions: 2, status: "draft", totalMills: 31_520, draftTotalMills: 31_520,
      savedAt: "2026-11-08T23:54:10+03:00", cutAt: "2026-11-08T23:53:00+03:00", postedAt: null,
      pages: [
        { pageLabel: "page-a", amountMills: 31_520, draftMills: 31_520, postedMills: null, postState: "draft_only" },
        { pageLabel: "page-b", amountMills: 0, draftMills: 0, postedMills: null, postState: "draft_only" },
      ],
    });
    expect(only!.lines).toEqual([
      { n: 1, pageLabel: "page-a", fanRef: "fan-1", fanName: "nick", kind: "message_purchase", occurredAt: "2026-11-08T17:28:00+03:00", netMills: 28_000, counted: true, added: false, what: "", flags: [], notes: ["text"], ppvAuthor: "alex.k", ppvSentAt: "08.11 17:26" },
      { n: 2, pageLabel: "page-a", fanRef: "", fanName: "", kind: "tip", occurredAt: null, netMills: 3_520, counted: true, added: true, what: "тип до окна смены", flags: [], notes: [], ppvAuthor: "alex.k", ppvSentAt: "08.11 17:26" },
      // Below the mill is cut, as everywhere the ledger's micro-dollars become mills.
      { n: null, pageLabel: "page-a", fanRef: "fan-1", fanName: "nick", kind: "message_purchase", occurredAt: "2026-11-08T17:28:00+03:00", netMills: 9_999, counted: false, added: false, what: "", flags: ["второй чаттер писал фану (§4.2)"], notes: ["text"], ppvAuthor: "alex.k", ppvSentAt: "08.11 17:26" },
    ]);
    for (const hidden of ["person", "chatter", "transaction_ref", "transactionRef", "gross_micros", "grossMills", "decision", "model"]) {
      expect(JSON.stringify(result)).not.toContain(`"${hidden}"`);
    }
  });

  it("drops a report of another user the ledger sent, by id or by username when it has no id", async () => {
    warnings.length = 0;
    const reports = [
      report({ id: 1, report_date: "2026-11-07" }),
      report({ id: 2, hub_user_id: 5, hub_username: "alex.k" }),
      report({ id: 3, hub_user_id: null, hub_username: "ALEX.K", report_date: "2026-11-09" }),
      report({ id: 4, hub_user_id: null, hub_username: "kate.v" }),
      report({ id: 5, hub_user_id: null, hub_username: "" }),
    ];
    const result = await readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(200, answer(reports)), now });
    // Newest first.
    expect(result.reports.map((one) => one.id)).toEqual([3, 1]);
    expect(warnings).toEqual([{ userId: 4, dropped: 3 }]);
  });

  it("takes Go's null lists as empty", async () => {
    const result = await readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(200, { ...answer([]), reports: null }), now });
    expect(result.reports).toEqual([]);
    const bare = await readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(200, answer([report({ pages: null, lines: null })])), now });
    expect(bare.reports[0]).toMatchObject({ pages: [], lines: [] });
  });

  it("is a 503 without the key, on the ledger's error, its 404 and an answer of another shape", async () => {
    const ok = fetchReturning(200, answer([report()]));
    await expect(readAccountReports(app(null), principal, {}, { fetchImpl: ok, now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(401, { error: "no" }), now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(404, { error: "no" }), now })).rejects.toMatchObject({ statusCode: 503 });
    const changed = answer([report({ total_micros: "31.52" })]);
    await expect(readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(200, changed), now })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readAccountReports(app(), principal, {}, { fetchImpl: ledger("unreachable"), now })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("refuses a window past 62 days or backwards before asking", async () => {
    let asked = false;
    const fetchImpl = (async () => { asked = true; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(readAccountReports(app(), principal, { from: "2026-09-01", to: "2026-11-08" }, { fetchImpl, now })).rejects.toMatchObject({ statusCode: 400 });
    await expect(readAccountReports(app(), principal, { from: "2026-11-09", to: "2026-11-08" }, { fetchImpl, now })).rejects.toMatchObject({ statusCode: 400 });
    expect(asked).toBe(false);
  });
});

describe("readAccountReports: the posts in «Отчётность»", () => {
  it("serves a post written without the agent as a report of its own: its pages, no sales, the posted sum", async () => {
    const result = await read([], daysAnswer([
      day({ report_date: "2026-11-07", page: "page-a", posted_micros: 40_000_000, draft_micros: null, state: "post_only", report_id: null, posted_at: "2026-11-08T01:10:00+03:00" }),
      day({ report_date: "2026-11-07", page: "page-b", posted_micros: 2_500_000, draft_micros: null, state: "post_only", report_id: null, posted_at: "2026-11-08T01:10:00+03:00" }),
    ]));
    expect(result.postsRead).toBe(true);
    expect(result.reports).toEqual([{
      source: "post", id: null, reportDate: "2026-11-07", windowFrom: null, windowTo: null, cutAt: null, version: null, versions: null,
      status: "posted", totalMills: 42_500, draftTotalMills: null, savedAt: null, postedAt: "2026-11-08T01:10:00+03:00",
      pages: [
        { pageLabel: "page-a", amountMills: 40_000, draftMills: null, postedMills: 40_000, postState: "post_only" },
        { pageLabel: "page-b", amountMills: 2_500, draftMills: null, postedMills: 2_500, postState: "post_only" },
      ],
      lines: [],
    }]);
  });

  it("joins a draft and its post posted as drafted: one report, the posted sum, the sales of the draft", async () => {
    const result = await read([report()], daysAnswer([day(), day({ page: "page-b", posted_micros: 0, draft_micros: 0 })]));
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      source: "both", id: 12, status: "posted", totalMills: 31_520, draftTotalMills: 31_520, postedAt: "2026-11-09T00:20:00+03:00",
      pages: [
        { pageLabel: "page-a", amountMills: 31_520, draftMills: 31_520, postedMills: 31_520, postState: "posted_equal" },
        { pageLabel: "page-b", amountMills: 0, draftMills: 0, postedMills: 0, postState: "posted_equal" },
      ],
    });
    expect(result.reports[0]!.lines).toHaveLength(3);
  });

  it("makes the posted sum the report's one number when the chatter changed a page, the draft's total beside it", async () => {
    // Only page-a is in the pay base: the draft's page-b, at zero, keeps its own word. Below the mill is cut.
    const result = await read([report()], daysAnswer([
      day({ posted_micros: 39_999_999, diff_micros: 8_479_999, state: "posted_changed", report_id: null }),
    ]));
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      source: "both", id: 12, totalMills: 39_999, draftTotalMills: 31_520,
      pages: [
        { pageLabel: "page-a", amountMills: 39_999, draftMills: 31_520, postedMills: 39_999, postState: "posted_changed" },
        { pageLabel: "page-b", amountMills: 0, draftMills: 0, postedMills: null, postState: "draft_only" },
      ],
    });
  });

  it("counts only the posted pages of a partly posted report: a page left out of the post adds nothing", async () => {
    const draft = report({
      total_micros: 31_520_000,
      pages: [{ page: "page-a", model: "model-a", amount_micros: 20_000_000 }, { page: "page-b", model: "", amount_micros: 11_520_000 }],
    });
    const result = await read([draft], daysAnswer([
      day({ posted_micros: 20_000_000, draft_micros: 20_000_000 }),
      day({ page: "page-b", posted_micros: null, draft_micros: 11_520_000, state: "draft_only", posted_at: null, post_id: null }),
    ]));
    expect(result.reports[0]).toMatchObject({
      source: "both", status: "posted", totalMills: 20_000, draftTotalMills: 31_520,
      pages: [
        { pageLabel: "page-a", amountMills: 20_000, postedMills: 20_000 },
        { pageLabel: "page-b", amountMills: 0, draftMills: 11_520, postedMills: null, postState: "draft_only" },
      ],
    });
  });

  it("keeps a draft not posted yet as a draft, and a post of another day as a report of its own", async () => {
    const result = await read([report()], daysAnswer([
      day({ posted_micros: null, state: "draft_only", posted_at: null, post_id: null }),
      day({ report_date: "2026-11-06", posted_micros: 15_000_000, draft_micros: null, state: "post_only", report_id: null }),
    ]));
    expect(result.reports.map((one) => [one.reportDate, one.source, one.status, one.totalMills])).toEqual([
      ["2026-11-08", "draft", "draft", 31_520],
      ["2026-11-06", "post", "posted", 15_000],
    ]);
  });

  it("drops the day rows when they hold more than one person, or another person than the drafts: the drafts alone", async () => {
    warnings.length = 0;
    const two = await read([report()], daysAnswer([day(), day({ person: "kate", report_date: "2026-11-07", draft_micros: null, state: "post_only", report_id: null })]));
    expect(two.postsRead).toBe(false);
    expect(two.reports.map((one) => [one.id, one.source, one.totalMills])).toEqual([[12, "draft", 31_520]]);
    expect(JSON.stringify(two)).not.toContain("2026-11-07");

    const other = await read([report()], daysAnswer([day({ person: "kate" })]));
    expect(other.postsRead).toBe(false);
    expect(other.reports.map((one) => one.source)).toEqual(["draft"]);
    expect(warnings).toHaveLength(2);

    // Without a draft to compare with, one person's rows are the caller's (the ledger filtered them by the caller)…
    const alone = await read([], daysAnswer([day({ person: "kate", draft_micros: null, state: "post_only", report_id: null })]));
    expect(alone).toMatchObject({ postsRead: true, reports: [{ source: "post", totalMills: 31_520 }] });
    // …unless they are of the person a draft of someone else in the answer is of.
    const theirs = await read([report({ hub_user_id: 5, hub_username: "kate.v", person: "kate" })], daysAnswer([day({ person: "kate", draft_micros: null, state: "post_only", report_id: null })]));
    expect(theirs).toMatchObject({ postsRead: false, reports: [] });
  });

  it("serves the drafts when the posts alone fail: an error, no answer, another shape — and says so", async () => {
    for (const days of [{ status: 500, body: { error: "boom" } }, "unreachable" as const, { status: 200, body: { days: [{ person: "alex" }] } }]) {
      const result = await read([report()], days);
      expect(result.postsRead).toBe(false);
      expect(result.reports.map((one) => [one.id, one.source, one.totalMills])).toEqual([[12, "draft", 31_520]]);
    }
    // Go's null list is no rows, not a failure.
    expect((await read([report()], { status: 200, body: { from: "2026-10-28", to: "2026-11-10", days: null } })).postsRead).toBe(true);
  });
});

describe("reportsWindow", () => {
  it("is the last 14 Moscow days without a query, and a day's end in Moscow is already the next day", () => {
    expect(reportsWindow({}, new Date("2026-11-10T09:00:00Z"))).toEqual({ from: "2026-10-28", to: "2026-11-10" });
    expect(reportsWindow({}, new Date("2026-11-09T21:30:00Z"))).toEqual({ from: "2026-10-28", to: "2026-11-10" });
    expect(reportsWindow({ to: "2026-11-05" }, now)).toEqual({ from: "2026-10-23", to: "2026-11-05" });
    expect(reportsWindow({ from: "2026-10-01", to: "2026-12-01" }, now)).toEqual({ from: "2026-10-01", to: "2026-12-01" });
  });
});

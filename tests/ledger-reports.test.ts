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

function fetchReturning(status: number, body: unknown, seen: { url?: string; auth?: string | undefined } = {}) {
  return (async (input: URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.auth = new Headers(init?.headers).get("authorization") ?? undefined;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const now = new Date("2026-11-10T09:00:00Z");
const answer = (reports: unknown[]) => ({ from: "2026-10-28", to: "2026-11-10", reports });

describe("readAccountReports", () => {
  it("asks the ledger for the session's user and passes the report on in mills, without what the screen does not need", async () => {
    const seen: { url?: string; auth?: string | undefined } = {};
    const result = await readAccountReports(app(), principal, {}, { fetchImpl: fetchReturning(200, answer([report()]), seen), now });

    const url = new URL(seen.url!);
    expect(url.origin + url.pathname).toBe("https://ledger.test/v1/reports");
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: "2026-10-28", to: "2026-11-10", hub_user_id: "4", hub_username: "Alex.K" });
    expect(seen.auth).toBe("Bearer test-payouts-key");
    expect(result.from).toBe("2026-10-28");
    expect(result.to).toBe("2026-11-10");
    const [only] = result.reports;
    expect(only).toMatchObject({
      id: 12, reportDate: "2026-11-08", version: 2, versions: 2, status: "draft", totalMills: 31_520,
      savedAt: "2026-11-08T23:54:10+03:00", cutAt: "2026-11-08T23:53:00+03:00",
      pages: [{ pageLabel: "page-a", amountMills: 31_520 }, { pageLabel: "page-b", amountMills: 0 }],
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
    const unreachable = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(readAccountReports(app(), principal, {}, { fetchImpl: unreachable, now })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("refuses a window past 62 days or backwards before asking", async () => {
    let asked = false;
    const fetchImpl = (async () => { asked = true; return new Response("{}"); }) as unknown as typeof fetch;
    await expect(readAccountReports(app(), principal, { from: "2026-09-01", to: "2026-11-08" }, { fetchImpl, now })).rejects.toMatchObject({ statusCode: 400 });
    await expect(readAccountReports(app(), principal, { from: "2026-11-09", to: "2026-11-08" }, { fetchImpl, now })).rejects.toMatchObject({ statusCode: 400 });
    expect(asked).toBe(false);
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

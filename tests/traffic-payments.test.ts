import { describe, expect, it } from "vitest";

import {
  contractorPayments,
  ledgerPaymentsReader,
  type LedgerPayment,
  type LedgerPaymentsAnswer,
  type TrafficContractorNames,
} from "../apps/runtime/src/services/traffic-payments.ts";

// What is paid to a traffic contractor: the ledger's journal rows, mapped back by the contractor's names in it.
// Money: every rule here is a sum somebody pays by.

const contractors: TrafficContractorNames[] = [
  { key: "alpha", title: "Alpha", ledgerNames: ["Alpha Media", "  alpha studio "] },
  { key: "beta", title: "Beta", ledgerNames: ["Beta", "Shared Desk"] },
  { key: "gamma", title: "Gamma", ledgerNames: ["shared desk"] },
  { key: "delta", title: "Delta", ledgerNames: [] },
];

let num = 0;
function row(counterparty: string, dollars: number, extra: Partial<LedgerPayment> = {}): LedgerPayment {
  num += 1;
  return {
    num, date: "2026-11-10", type: "expense", category: "traffic", counterparty, model: null,
    amountMicros: dollars * 1_000_000, currency: "USD", status: "paid", note: null, ...extra,
  };
}

function paid(answer: LedgerPaymentsAnswer, asked = ["alpha", "beta", "gamma", "delta"], sources: Record<string, number> = {}) {
  return contractorPayments({ contractors, asked, sourcesOf: new Map(Object.entries(sources)), answer });
}

describe("what is paid to a traffic contractor", () => {
  it("sums paid dollar rows by the contractor's names, trimmed and case aside; a refund subtracts", () => {
    const result = paid({ state: "answered", payments: [
      row("ALPHA MEDIA", 500, { date: "2026-11-01" }),
      row("Alpha Studio ", 400, { date: "2026-11-12" }),
      row("alpha media", 150, { type: "income", date: "2026-11-14", note: "refund" }),
      row("Someone Else", 999),
    ] }).get("alpha")!;
    expect(result.paid).toEqual({
      status: "known", reason: null, paidMills: 750_000, paymentCount: 3, lastPaymentDate: "2026-11-14", shared: false, otherCurrency: false,
    });
    expect(result.payments.map((payment) => payment.amountMills)).toEqual([-150_000, 400_000, 500_000]);
  });

  it("lists a pending row without summing it, and a row in another currency with a flag", () => {
    const result = paid({ state: "answered", payments: [
      row("Alpha Media", 300),
      row("Alpha Media", 200, { status: "pending", date: "2026-11-15" }),
      row("Alpha Media", 100, { currency: "usdt" }),
      row("Alpha Media", 7000, { currency: "RUB" }),
    ] }).get("alpha")!;
    expect(result.paid.paidMills).toBe(400_000);
    expect(result.paid.otherCurrency).toBe(true);
    expect(result.paid.paymentCount).toBe(3);
    expect(result.payments.map((payment) => [payment.currency, payment.summed])).toEqual([
      ["USD", false], ["RUB", false], ["USDT", true], ["USD", true],
    ]);
  });

  it("gives a name two contractors share to neither", () => {
    const result = paid({ state: "answered", payments: [row("Shared Desk", 800), row("Beta", 100)] });
    expect(result.get("beta")!.paid.paidMills).toBe(100_000);
    // Gamma's only name is shared: Hub has no name to ask by.
    expect(result.get("gamma")!.paid).toMatchObject({ status: "unknown", reason: "no_ledger_names", paidMills: null });
  });

  it("is known and zero when the journal has no row, unknown without names, unknown when the ledger does not answer", () => {
    expect(paid({ state: "answered", payments: [] }).get("alpha")!.paid).toMatchObject({ status: "known", paidMills: 0, paymentCount: 0, lastPaymentDate: null });
    expect(paid({ state: "answered", payments: [] }).get("delta")!.paid).toMatchObject({ status: "unknown", reason: "no_ledger_names" });
    const down = paid({ state: "unavailable" });
    expect(down.get("alpha")!.paid).toMatchObject({ status: "unknown", reason: "ledger_unavailable", paidMills: null });
    expect(down.get("alpha")!.payments).toEqual([]);
    // No names is said before the ledger's silence: asking would not help.
    expect(down.get("delta")!.paid.reason).toBe("no_ledger_names");
  });

  it("marks the figure shared when the contractor has terms on several sources", () => {
    const result = paid({ state: "answered", payments: [row("Alpha Media", 50)] }, ["alpha"], { alpha: 2 });
    expect(result.get("alpha")!.paid).toMatchObject({ status: "known", paidMills: 50_000, shared: true });
  });
});

describe("the ledger's answer", () => {
  const app = { config: { ledgerPayoutsKey: "key", ledgerUrl: "https://ledger.example" }, logger: { warn: () => undefined } } as never;
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("asks once with every name repeated", async () => {
    let asked = "";
    const fetchImpl = (async (url: URL) => {
      asked = url.search;
      return new Response(JSON.stringify({ generatedAt: "2026-11-18T00:00:00Z", truncated: false, payments: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const answer = await ledgerPaymentsReader(app, { fetchImpl })(["Alpha Media", "Beta"]);
    expect(answer).toEqual({ state: "answered", payments: [] });
    expect(new URLSearchParams(asked).getAll("name")).toEqual(["Alpha Media", "Beta"]);
  });

  it("is unavailable when truncated, refused, not opened yet, or in an unknown shape", async () => {
    const read = (fetchImpl: typeof fetch) => ledgerPaymentsReader(app, { fetchImpl })(["Alpha Media"]);
    expect(await read(answering(200, { generatedAt: "x", truncated: true, payments: [] }))).toEqual({ state: "unavailable" });
    expect(await read(answering(404, {}))).toEqual({ state: "unavailable" });
    expect(await read(answering(403, {}))).toEqual({ state: "unavailable" });
    expect(await read(answering(500, {}))).toEqual({ state: "unavailable" });
    expect(await read(answering(200, { payments: "no" }))).toEqual({ state: "unavailable" });
  });
});

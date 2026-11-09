import { describe, expect, it } from "vitest";

import { readLedgerPayouts } from "../apps/runtime/src/services/ledger-payouts.ts";

/** Money from the agency ledger: micro-dollars in, mills out, never a wrong sum on a changed answer. */

const users = [
  { id: 4, username: "alex.k" },
  { id: 5, username: "Kate.V" },
];

function app(key: string | null = "test-payouts-key") {
  return {
    db: { query: { users: { findMany: async () => users } } },
    config: { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: key },
    logger: { warn: () => undefined },
  } as never;
}

function ledgerAnswer(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    from: "2026-11-02",
    to: "2026-11-08",
    accrualFrom: "2026-09-01",
    generatedAt: "2026-11-09T10:00:00Z",
    people: [
      {
        slug: "alex",
        name: "Алекс",
        aliases: ["alex.k"],
        status: "active",
        days: [{ date: "2026-11-03", model: "Mia", amountMicros: 45_670_000, worked: true, pages: [{ page: "mia-1", revenueMicros: 300_000_000 }], source: "sheet" }],
        accruedMicros: 45_670_000,
        paidMicros: 0,
        balanceMicros: 145_670_000,
        toPayMicros: 145_670_000,
        oldestUnpaidDate: "2026-08-20",
        unpaidDays: [
          { date: "2026-09-01", kind: "opening", unpaidMicros: 100_000_000 },
          { date: "2026-11-03", kind: "day", model: "Mia", unpaidMicros: 45_670_000 },
        ],
      },
      {
        slug: "kate.v",
        name: "Катя",
        aliases: null,
        status: "active",
        days: null,
        accruedMicros: 0,
        paidMicros: 12_340_000,
        balanceMicros: -1_500_000,
        toPayMicros: null,
        oldestUnpaidDate: null,
        unpaidDays: null,
      },
    ],
    checks: { stale: false, lastSheetsCollectAt: "2026-11-09T09:40:00Z", lastRebuildAt: null },
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

describe("readLedgerPayouts", () => {
  it("passes the ledger's money on in mills, empty lists and the Hub user filled in", async () => {
    const seen: { url?: string; auth?: string | undefined } = {};
    const result = await readLedgerPayouts(app(), { from: "2026-11-02", to: "2026-11-08" }, { fetchImpl: fetchReturning(200, ledgerAnswer(), seen), now: new Date("2026-11-09T10:00:01Z") });

    expect(seen.url).toBe("https://ledger.test/v1/payouts?from=2026-11-02&to=2026-11-08");
    expect(seen.auth).toBe("Bearer test-payouts-key");
    const [alex, kate] = result.people;
    expect(alex).toMatchObject({
      hubUser: { userId: 4, username: "alex.k" },
      days: [{ date: "2026-11-03", model: "Mia", amountMills: 45_670, worked: true, source: "sheet" }],
      accruedMills: 45_670,
      balanceMills: 145_670,
      toPayMills: 145_670,
      unpaidDays: [
        { date: "2026-09-01", kind: "opening", model: null, unpaidMills: 100_000 },
        { date: "2026-11-03", kind: "day", model: "Mia", unpaidMills: 45_670 },
      ],
    });
    // The slug matches a username case aside; Go's null slices are empty lists; a paid-ahead balance stays negative.
    expect(kate).toMatchObject({ hubUser: { userId: 5, username: "Kate.V" }, aliases: [], days: [], unpaidDays: [], paidMills: 12_340, balanceMills: -1_500, toPayMills: null });
    expect(result.serverNow).toBe("2026-11-09T10:00:01.000Z");
  });

  it("is a 503 without the key, on the ledger's error and on an answer of another shape", async () => {
    await expect(readLedgerPayouts(app(null), { from: "2026-11-02", to: "2026-11-08" }, { fetchImpl: fetchReturning(200, ledgerAnswer()) })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readLedgerPayouts(app(), { from: "2026-11-02", to: "2026-11-08" }, { fetchImpl: fetchReturning(401, { error: "no" }) })).rejects.toMatchObject({ statusCode: 503 });
    const changed = ledgerAnswer({ people: [{ ...ledgerAnswer().people[0], balanceMicros: "145.67" }] });
    await expect(readLedgerPayouts(app(), { from: "2026-11-02", to: "2026-11-08" }, { fetchImpl: fetchReturning(200, changed) })).rejects.toMatchObject({ statusCode: 503 });
  });

  it("refuses a window past the ledger's 62 days before asking", async () => {
    await expect(readLedgerPayouts(app(), { from: "2026-09-01", to: "2026-11-08" }, { fetchImpl: fetchReturning(200, ledgerAnswer()) })).rejects.toMatchObject({ statusCode: 400 });
  });
});

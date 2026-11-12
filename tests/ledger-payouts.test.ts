import { describe, expect, it } from "vitest";

import { payMillsOf, readLedgerPayoutPrepare, readLedgerPayouts } from "../apps/runtime/src/services/ledger-payouts.ts";

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
        unentered: { days: 3, shareMicros: 64_120_000, unknown: 1 },
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

describe("payMillsOf", () => {
  // Production 12.11: a debt of 2214.548000 read as $2214.54 on the screen while `ledger payables` printed 2214.55.
  it("reads pay to the ledger's own cent, half to even, as `ledger payables` prints it", () => {
    expect(payMillsOf(2_214_548_000)).toBe(2_214_550);
    expect(payMillsOf(626_825_834)).toBe(626_830);
    expect(payMillsOf(129_533_334)).toBe(129_530);
    expect(payMillsOf(48_795_000)).toBe(48_800);
    expect(payMillsOf(48_785_000)).toBe(48_780);
    expect(payMillsOf(-1_234_565_000)).toBe(-1_234_560);
    expect(payMillsOf(-1_234_575_000)).toBe(-1_234_580);
    expect(payMillsOf(0)).toBe(0);
  });
});

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
      unentered: { days: 3, shareMills: 64_120, unknown: 1 },
    });
    // The slug matches a username case aside; Go's null slices are empty lists; a paid-ahead balance stays negative.
    expect(kate).toMatchObject({ hubUser: { userId: 5, username: "Kate.V" }, aliases: [], days: [], unpaidDays: [], unentered: { days: 0, shareMills: 0, unknown: 0 }, paidMills: 12_340, balanceMills: -1_500, toPayMills: null });
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

  it("takes the reports' new fields when they come and stays as it was without them", async () => {
    const window = { from: "2026-11-02", to: "2026-11-08" };
    // Without them (the ledger of today): no switch dates, no pending changes — not a 503.
    const before = await readLedgerPayouts(app(), window, { fetchImpl: fetchReturning(200, ledgerAnswer()) });
    expect({ factsFrom: before.factsFrom, reportsFrom: before.reportsFrom, pending: before.people.map((person) => person.pendingChanges) }).toEqual({ factsFrom: null, reportsFrom: null, pending: [[], []] });

    const [alex, kate] = ledgerAnswer().people;
    const after = await readLedgerPayouts(app(), window, {
      fetchImpl: fetchReturning(200, ledgerAnswer({
        reports_from: "2026-11-05",
        people: [
          {
            ...alex,
            // A source the screen does not know yet passes as it came; the ledger's Hub user id beats the name.
            days: [{ ...alex!.days![0], source: "reports" }, { date: "2026-11-04", model: "Mia", amountMicros: 1_000_000, worked: true, source: "posts-v2" }],
            hub_user_id: 5,
            pending_changes: [{ id: 7, day: "2026-11-03", model: "Mia", posted_micros: 45_670_000, new_micros: 48_795_000, reason: "пост изменён после выплаты" }],
          },
          { ...kate, pendingChanges: [{ id: 8, day: "2026-11-01", postedMicros: 10_000_000, newMicros: 9_000_000 }] },
        ],
      })),
    });
    expect(after.reportsFrom).toBe("2026-11-05");
    expect(after.people[0]).toMatchObject({
      hubUser: { userId: 5, username: "Kate.V" },
      days: [{ source: "reports" }, { source: "posts-v2", amountMills: 1_000 }],
      // Pay reads as the ledger prints it, to its cent (half to even): 48.795 → 48.80, never Hub's truncated 48.79.
      pendingChanges: [{ id: 7, day: "2026-11-03", model: "Mia", postedMills: 45_670, newMills: 48_800, reason: "пост изменён после выплаты" }],
    });
    expect(after.people[1]!.pendingChanges).toEqual([{ id: 8, day: "2026-11-01", model: "", postedMills: 10_000, newMills: 9_000, reason: "" }]);
  });

  it("says which switches price the days: the terms and the basis from Hub, null while off or not said", async () => {
    const window = { from: "2026-11-02", to: "2026-11-08" };
    // A ledger of today says nothing: the payout sheets price the days, the posts are the reports.
    const before = await readLedgerPayouts(app(), window, { fetchImpl: fetchReturning(200, ledgerAnswer()) });
    expect({ terms: before.termsHubFrom, basis: before.basisHubFrom }).toEqual({ terms: null, basis: null });
    const off = await readLedgerPayouts(app(), window, { fetchImpl: fetchReturning(200, ledgerAnswer({ termsHubFrom: null, basisHubFrom: null })) });
    expect({ terms: off.termsHubFrom, basis: off.basisHubFrom }).toEqual({ terms: null, basis: null });
    const on = await readLedgerPayouts(app(), window, { fetchImpl: fetchReturning(200, ledgerAnswer({ termsHubFrom: "2026-12-01", basisHubFrom: "2026-11-20" })) });
    expect({ terms: on.termsHubFrom, basis: on.basisHubFrom }).toEqual({ terms: "2026-12-01", basis: "2026-11-20" });
  });

  it("is a 503 on a pending change it cannot read in full: a decision about money is never half-shown", async () => {
    const [alex] = ledgerAnswer().people;
    const broken = ledgerAnswer({ people: [{ ...alex, pending_changes: [{ id: 7, day: "2026-11-03", posted_micros: 45_670_000 }] }] });
    await expect(readLedgerPayouts(app(), { from: "2026-11-02", to: "2026-11-08" }, { fetchImpl: fetchReturning(200, broken) })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("readLedgerPayoutPrepare", () => {
  it("passes one person's brief on in mills, the message untouched", async () => {
    const seen: { url?: string; auth?: string | undefined } = {};
    const brief = {
      ok: true, slug: "alex", name: "Алекс", status: "active", generatedAt: "2026-11-09T10:00:00+03:00", accrualFrom: "2026-09-01",
      amountMicros: 45_670_000, toPayMicros: 45_670_000, period: { from: "2026-11-03", to: "2026-11-03" },
      lines: [{ kind: "week", model: "Mia", tab: "Алекс", week: "2026-11-02", from: "2026-11-03", to: "2026-11-03", payMicros: 45_670_000, shownMicros: 45_670_000, text: "03.11: 182.68 × 25% = 45.67" }],
      blocks: [], flags: [{ kind: "unentered", blocker: true, text: "не занесено 04.11" }], blockers: 1,
      suggestion: { transferMicros: 46_000_000, aboveTableMicros: 330_000, note: "до доллара вверх на 0.33" },
      message: "закинул зп, {перевод} usdt\nитого 45.67 → {перевод}", placeholder: "{перевод}",
      checks: { stale: false, lastSheetsCollectAt: null, lastRebuildAt: null },
    };
    const result = await readLedgerPayoutPrepare(app(), { person: "alex" }, { fetchImpl: fetchReturning(200, brief, seen) });
    expect(seen.url).toBe("https://ledger.test/v1/payouts/prepare?person=alex");
    expect(result).toMatchObject({
      amountMills: 45_670, nothing: null, lines: [{ kind: "week", model: "Mia", shownMills: 45_670 }], blockers: 1,
      suggestion: { transferMills: 46_000, aboveTableMills: 330 }, message: brief.message, placeholder: "{перевод}",
    });
  });

  it("is a 404 for a person without a tab and a 503 on a changed answer", async () => {
    await expect(readLedgerPayoutPrepare(app(), { person: "nobody" }, { fetchImpl: fetchReturning(404, { error: "no" }) })).rejects.toMatchObject({ statusCode: 404 });
    await expect(readLedgerPayoutPrepare(app(), { person: "alex" }, { fetchImpl: fetchReturning(200, { slug: "alex" }) })).rejects.toMatchObject({ statusCode: 503 });
  });
});

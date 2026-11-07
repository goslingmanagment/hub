import { describe, expect, it } from "vitest";

import {
  dueMonthlyCredit,
  forecastPool,
  moscowDate,
  renewalsFrom,
} from "../apps/runtime/src/services/ai-account-balance.ts";

const DAY = 86_400_000;
const at = (text: string) => new Date(text);

type Row = Parameters<typeof dueMonthlyCredit>[0]["row"];
const row = (overrides: Partial<Row>): Row => ({
  status: "active",
  statusChangedAt: null,
  balanceSnapshotMicroUsd: 0,
  balanceSnapshotAt: at("2026-10-23T21:48:04Z"),
  balanceSnapshotSource: "credit_refusal",
  ...overrides,
});

describe("renewalsFrom", () => {
  it("starts at the last Moscow renewal and clamps a short month", () => {
    // 07.11 15:00 MSK, renewal on the 3rd: the last one is 03.11 00:00 MSK.
    expect(renewalsFrom(3, at("2026-11-07T12:00:00Z"), 2).map(moscowDate)).toEqual(["2026-11-03", "2026-12-03"]);
    expect(renewalsFrom(3, at("2026-11-07T12:00:00Z"), 1)[0]!.toISOString()).toBe("2026-11-02T21:00:00.000Z");
    // Before the 12th: the last renewal is last month's.
    expect(renewalsFrom(12, at("2026-11-07T12:00:00Z"), 1).map(moscowDate)).toEqual(["2026-10-12"]);
    // The 31st renews on 30.11 in November.
    expect(renewalsFrom(31, at("2026-12-05T12:00:00Z"), 2).map(moscowDate)).toEqual(["2026-11-30", "2026-12-31"]);
  });
});

describe("dueMonthlyCredit", () => {
  const renewal = at("2026-11-02T21:00:00Z"); // 03.11 MSK

  it("counts the credit when the account answers again after its zero inside the window", () => {
    // main on prod: out of credit 23.10, answering again 03.11 22:25 UTC.
    const due = dueMonthlyCredit({
      row: row({ statusChangedAt: at("2026-11-03T22:25:30Z") }),
      renewal,
      recorded: false,
      now: at("2026-11-07T12:00:00Z"),
    });
    expect(due).toEqual({ at: at("2026-11-03T22:25:30Z"), source: "revived" });
  });

  it("counts it at the window's end for an account that never ran dry", () => {
    const input = {
      row: row({ balanceSnapshotMicroUsd: 50_000_000, balanceSnapshotSource: "reading" as const, balanceSnapshotAt: at("2026-10-30T10:00:00Z") }),
      renewal,
      recorded: false,
    };
    expect(dueMonthlyCredit({ ...input, now: at("2026-11-04T12:00:00Z") })).toBeNull();
    expect(dueMonthlyCredit({ ...input, now: at("2026-11-06T12:00:00Z") })).toEqual({
      at: new Date(renewal.getTime() + 3 * DAY),
      source: "schedule",
    });
  });

  it("counts nothing while the account stays out of credit, or once it is recorded", () => {
    const now = at("2026-11-07T12:00:00Z");
    expect(dueMonthlyCredit({ row: row({ status: "exhausted", statusChangedAt: at("2026-10-23T21:48:04Z") }), renewal, recorded: false, now })).toBeNull();
    expect(dueMonthlyCredit({ row: row({ statusChangedAt: at("2026-11-03T22:25:30Z") }), renewal, recorded: true, now })).toBeNull();
  });

  it("counts nothing when the account came back outside the window (a purchase of unknown size)", () => {
    // Out of credit inside the window, answering again a week later.
    expect(dueMonthlyCredit({
      row: row({ balanceSnapshotAt: at("2026-11-03T10:00:00Z"), statusChangedAt: at("2026-11-10T10:00:00Z") }),
      renewal,
      recorded: false,
      now: at("2026-11-10T12:00:00Z"),
    })).toBeNull();
  });

  it("leaves a renewal the starting point already holds", () => {
    // The owner's reading after the renewal, or a zero after the window.
    expect(dueMonthlyCredit({
      row: row({ balanceSnapshotMicroUsd: 120_000_000, balanceSnapshotSource: "reading", balanceSnapshotAt: at("2026-11-04T09:00:00Z") }),
      renewal,
      recorded: false,
      now: at("2026-11-07T12:00:00Z"),
    })).toBeNull();
    expect(dueMonthlyCredit({
      row: row({ balanceSnapshotAt: at("2026-11-06T09:00:00Z"), status: "exhausted" }),
      renewal,
      recorded: false,
      now: at("2026-11-07T12:00:00Z"),
    })).toBeNull();
  });
});

describe("forecastPool", () => {
  const now = at("2026-11-07T12:00:00Z");
  const usd = (value: number) => value * 1_000_000;

  it("finds the gap before the next credit and what bridges it", () => {
    const forecast = forecastPool({
      now,
      dailyBurnMicroUsd: usd(20),
      balances: [{ label: "main", estimatedMicroUsd: usd(100) }, { label: "bukake", estimatedMicroUsd: 0 }],
      upcoming: [{ label: "bukake", microUsd: usd(200), expectedAt: new Date(now.getTime() + 7 * DAY) }],
    });
    expect(forecast.runsOutAt).toEqual(new Date(now.getTime() + 5 * DAY));
    expect(forecast.gap).toEqual({ untilAt: new Date(now.getTime() + 7 * DAY), label: "bukake", shortfallMicroUsd: usd(40) });
  });

  it("carries the money through the credits that come in time", () => {
    const forecast = forecastPool({
      now,
      dailyBurnMicroUsd: usd(20),
      balances: [{ label: "main", estimatedMicroUsd: usd(100) }],
      upcoming: [
        { label: "bukake", microUsd: usd(200), expectedAt: new Date(now.getTime() + 4 * DAY) },
        { label: "oag", microUsd: usd(200), expectedAt: new Date(now.getTime() + 8 * DAY) },
      ],
    });
    // 100 − 80 + 200 − 80 + 200 = 340 at day 8: 17 more days.
    expect(forecast.gap).toBeNull();
    expect(forecast.runsOutAt).toEqual(new Date(now.getTime() + 25 * DAY));
  });

  it("names the accounts it leaves out", () => {
    const forecast = forecastPool({
      now,
      dailyBurnMicroUsd: 0,
      balances: [{ label: "main", estimatedMicroUsd: usd(10) }, { label: "oag", estimatedMicroUsd: null }],
      upcoming: [],
    });
    expect(forecast).toMatchObject({ leftMicroUsd: usd(10), missing: ["oag"], runsOutAt: null, gap: null });
  });
});

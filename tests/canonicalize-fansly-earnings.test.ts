import { describe, expect, it } from "vitest";

import {
  canonicalizeFanslyEarningsObservation,
} from "../apps/runtime/src/services/canonicalize/fansly-earnings.ts";
import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

function observation(id: number, gross: number): CanonicalizableObservation {
  return {
    id, source: "pull", producer: "sync:fansly:fan_earnings", platform: "fansly",
    accountId: 1, kind: "fan_earnings_stats", observedAt: null,
    receivedAt: new Date("2026-09-10T00:00:00Z"),
    payload: [{ correlationAccountId: "fan-1", type: 2110, totalGross: gross, totalNet: gross }],
  };
}

function event(id: number, gross: number) {
  return canonicalizeFanslyEarningsObservation(observation(id, gross))[0]!;
}

describe("Fansly earnings observation identity", () => {
  it("preserves A → B → A and keeps replay identity separate from content", () => {
    const first = event(1, 100);
    const changed = event(2, 200);
    const returned = event(3, 100);
    expect(new Set([first.dedupKey, changed.dedupKey, returned.dedupKey]).size).toBe(3);
    expect(first.data.contentFingerprint).toBe(returned.data.contentFingerprint);
    expect(first.data.contentFingerprint).not.toBe(changed.data.contentFingerprint);
    expect(first.data.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(event(1, 100)).toEqual(first);
  });

  it("fingerprints the same breakdown independently of provider row order", () => {
    const input = observation(1, 100);
    const rows = [
      { correlationAccountId: "fan-1", type: 2110, totalGross: 100, totalNet: 80 },
      { correlationAccountId: "fan-1", type: 15001, totalGross: 50, totalNet: 40 },
    ];
    const first = canonicalizeFanslyEarningsObservation({ ...input, payload: rows });
    const reversed = canonicalizeFanslyEarningsObservation({ ...input, payload: [...rows].reverse() });
    expect(first).toEqual(reversed);
  });

  it.each([
    { amounts: [Number.MAX_SAFE_INTEGER - 1, 1], total: Number.MAX_SAFE_INTEGER },
    { amounts: [Number.MIN_SAFE_INTEGER + 1, -1], total: Number.MIN_SAFE_INTEGER },
    { amounts: [-1000, 250], total: -750 },
  ])("preserves integer mills at the supported boundary: $total", ({ amounts, total }) => {
    const input = observation(1, 0);
    const events = canonicalizeFanslyEarningsObservation({
      ...input,
      payload: amounts.map((amount, type) => ({
        correlationAccountId: "fan-1", type, totalGross: amount, totalNet: amount,
      })),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ grossMills: total, netMills: total });
  });

  it("keeps an unscoped empty response unknown and preserves an explicit zero", () => {
    const input = observation(1, 0);
    expect(canonicalizeFanslyEarningsObservation({ ...input, payload: [] })).toEqual([]);
    expect(canonicalizeFanslyEarningsObservation(input)[0]!.data)
      .toMatchObject({ grossMills: 0, netMills: 0 });
  });

  it("raises only earnings parse debt and routes new events through checkpoints", () => {
    const input = observation(1, 100);
    for (const kind of ["fan_earnings_stats", "fan_earnings_monthly"]) {
      expect(familyForObservation({ ...input, kind }))
        .toMatchObject({ lane: "earnings", version: 7, projectionOnly: true, prioritizeUnparsed: true });
    }
    for (const kind of ["dm_messages", "purchase_history"]) {
      expect(familyForObservation({ ...input, kind })).toMatchObject({ lane: "sync", version: 6 });
    }
  });
});

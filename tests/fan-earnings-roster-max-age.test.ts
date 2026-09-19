// Decision 368: the pure config → window helper. 0 keeps today's behavior and
// 1..47 is deliberately the same as 0 — the daily cadence already re-reads
// inside 24 hours, so a shorter window could never skip anything.

import { describe, expect, it } from "vitest";

import type { AppConfig } from "@agency_hub_core/shared";

import {
  FAN_EARNINGS_RECOVERY_MAX_AGE_MS,
  fanEarningsEffectiveMaxAgeMs,
  fanEarningsRosterMaxAgeMs,
} from "../apps/runtime/src/services/sync/fan-earnings-targets.ts";

const HOUR_MS = 60 * 60_000;

function config(hours?: number): AppConfig {
  return { fanslyFanEarningsRosterMaxAgeHours: hours } as unknown as AppConfig;
}

describe("fan-earnings roster max age (Decision 368)", () => {
  it("treats the default, an unset key and every value below 48 hours as off", () => {
    for (const hours of [undefined, 0, 1, 23, 24, 47]) {
      expect(fanEarningsRosterMaxAgeMs(config(hours))).toBeNull();
    }
  });

  it("rejects out-of-range and non-integer values instead of guessing a window", () => {
    for (const hours of [-48, 169, 1000, 48.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fanEarningsRosterMaxAgeMs(config(hours))).toBeNull();
    }
  });

  it("enables the window from 48 up to 168 hours", () => {
    expect(fanEarningsRosterMaxAgeMs(config(48))).toBe(48 * HOUR_MS);
    expect(fanEarningsRosterMaxAgeMs(config(72))).toBe(72 * HOUR_MS);
    expect(fanEarningsRosterMaxAgeMs(config(168))).toBe(168 * HOUR_MS);
  });

  it("keeps the effective age at 24 hours while the roster age is off", () => {
    expect(FAN_EARNINGS_RECOVERY_MAX_AGE_MS).toBe(24 * HOUR_MS);
    for (const hours of [undefined, 0, 47]) {
      expect(fanEarningsEffectiveMaxAgeMs(config(hours))).toBe(24 * HOUR_MS);
    }
  });

  it("widens the effective age to the roster age once it is on", () => {
    expect(fanEarningsEffectiveMaxAgeMs(config(48))).toBe(48 * HOUR_MS);
    expect(fanEarningsEffectiveMaxAgeMs(config(168))).toBe(168 * HOUR_MS);
  });
});

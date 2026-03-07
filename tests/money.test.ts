import { describe, expect, it } from "vitest";

import {
  formatUsdFromMills,
  millsToDecimalString,
  parsePeriod,
  resolvePeriodBounds,
} from "@fansly-connect/shared";

describe("money helpers", () => {
  it("formats mills without floating point drift", () => {
    expect(millsToDecimalString(1234500n)).toBe("1234.500");
    expect(formatUsdFromMills(1234500n)).toBe("$1,234.50");
    expect(formatUsdFromMills(-5600n)).toBe("-$5.60");
  });

  it("builds Moscow trailing windows that include today", () => {
    const now = new Date("2026-03-07T10:00:00.000Z");
    const sevenDay = resolvePeriodBounds("7d", now);
    const thirtyDay = resolvePeriodBounds("30d", now);

    expect(sevenDay.from?.toISOString()).toBe("2026-02-28T21:00:00.000Z");
    expect(sevenDay.to?.toISOString()).toBe("2026-03-07T21:00:00.000Z");
    expect(thirtyDay.from?.toISOString()).toBe("2026-02-05T21:00:00.000Z");
    expect(thirtyDay.to?.toISOString()).toBe("2026-03-07T21:00:00.000Z");
  });

  it("rejects unsupported periods with the canonical option list", () => {
    expect(() => parsePeriod("90d")).toThrow(
      'Unsupported period "90d". Valid options: today, 7d, 30d, all, custom.',
    );
  });

  it("keeps custom period validation specific to custom ranges", () => {
    const now = new Date("2026-03-07T10:00:00.000Z");
    expect(() => resolvePeriodBounds("custom", now)).toThrow(
      "Custom period requires from/to dates",
    );
  });
});

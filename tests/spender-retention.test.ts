import { describe, expect, it } from "vitest";

import {
  SPENDER_RETENTION_ACTIVE_DAYS,
  SPENDER_RETENTION_INACTIVE_DAYS,
  SPENDER_RETENTION_NEEDS_REACTIVATION_LIFETIME_NET_MILLS,
  classifyRetention,
  isSpenderRetentionStatus,
} from "@agency_hub_core/shared";

const ONE_DAY_MS = 86_400_000;
const NOW = new Date("2026-05-27T12:00:00.000Z");

function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * ONE_DAY_MS);
}

describe("classifyRetention", () => {
  it("marks supporters with very recent activity as active", () => {
    const status = classifyRetention({
      lifetimeLastTransactionAt: daysAgo(SPENDER_RETENTION_ACTIVE_DAYS - 1),
      lifetimeCreatorNetAmountMills: 1_000,
      now: NOW,
    });
    expect(status).toBe("active");
  });

  it("uses cooling for supporters between active and inactive thresholds", () => {
    const status = classifyRetention({
      lifetimeLastTransactionAt: daysAgo(SPENDER_RETENTION_ACTIVE_DAYS + 1),
      lifetimeCreatorNetAmountMills: 1_000,
      now: NOW,
    });
    expect(status).toBe("cooling");
  });

  it("marks low-value quiet supporters as inactive", () => {
    const status = classifyRetention({
      lifetimeLastTransactionAt: daysAgo(SPENDER_RETENTION_INACTIVE_DAYS + 5),
      lifetimeCreatorNetAmountMills: SPENDER_RETENTION_NEEDS_REACTIVATION_LIFETIME_NET_MILLS - 1,
      now: NOW,
    });
    expect(status).toBe("inactive");
  });

  it("flags high-value quiet supporters as needing reactivation", () => {
    const status = classifyRetention({
      lifetimeLastTransactionAt: daysAgo(SPENDER_RETENTION_INACTIVE_DAYS + 5),
      lifetimeCreatorNetAmountMills: SPENDER_RETENTION_NEEDS_REACTIVATION_LIFETIME_NET_MILLS,
      now: NOW,
    });
    expect(status).toBe("needs_reactivation");
  });

  it("treats fans with no recorded purchase as inactive (low-value) or needs reactivation (high-value)", () => {
    expect(classifyRetention({
      lifetimeLastTransactionAt: null,
      lifetimeCreatorNetAmountMills: 0,
      now: NOW,
    })).toBe("inactive");

    expect(classifyRetention({
      lifetimeLastTransactionAt: null,
      lifetimeCreatorNetAmountMills: SPENDER_RETENTION_NEEDS_REACTIVATION_LIFETIME_NET_MILLS + 1,
      now: NOW,
    })).toBe("needs_reactivation");
  });
});

describe("isSpenderRetentionStatus", () => {
  it("accepts known statuses and rejects unknown values", () => {
    for (const value of ["all", "active", "cooling", "inactive", "needs_reactivation"]) {
      expect(isSpenderRetentionStatus(value)).toBe(true);
    }
    expect(isSpenderRetentionStatus("idle")).toBe(false);
    expect(isSpenderRetentionStatus("")).toBe(false);
  });
});

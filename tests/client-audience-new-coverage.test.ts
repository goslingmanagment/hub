import { describe, expect, it } from "vitest";

import {
  audienceCoverageSource,
  evaluateAudienceCoverage,
  evaluateChatspaceAudienceCoverage,
} from "../apps/runtime/src/services/client-audience-new.ts";
import { OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS } from "../apps/runtime/src/services/ofapi-delivery-history-signal.ts";

// «Новые» vouch for their list by the source that feeds the page: OFAPI's webhook delivery history until the cutoff,
// then the poll of ChatSpace's own notifications, with the same thresholds.

const to = new Date("2026-11-01T12:00:00.000Z");
const from = new Date(to.getTime() - 24 * 3_600_000);
const minutes = (n: number) => new Date(to.getTime() - n * 60_000);
const chatspace = (poll: { subscribersPassedAt: Date | null; failedAt: Date | null } | null, pendingNotifications = 0) =>
  evaluateChatspaceAudienceCoverage({ from, to, poll, pendingNotifications });

describe("which source vouches for «Новые»", () => {
  it("is ChatSpace's poll once the page's money writer is chatspace, else OFAPI's", () => {
    expect(audienceCoverageSource("chatspace")).toBe("chatspace");
    expect(audienceCoverageSource("ofapi")).toBe("ofapi");
    expect(audienceCoverageSource(null)).toBe("ofapi");
  });
});

describe("«Новые» of a page fed by ChatSpace", () => {
  it("are complete while the poll read the notifications whole lately", () => {
    expect(chatspace({ subscribersPassedAt: minutes(10), failedAt: null })).toEqual({ state: "complete", reasons: [] });
  });

  it("are unknown before the poll ever read them, or when it last did before the window", () => {
    expect(chatspace(null)).toEqual({ state: "unknown", reasons: ["notifications_poll_pending"] });
    expect(chatspace({ subscribersPassedAt: null, failedAt: minutes(5) })).toEqual({
      state: "unknown",
      reasons: ["notifications_poll_pending", "notifications_poll_failing"],
    });
    expect(chatspace({ subscribersPassedAt: new Date(from.getTime() - 1), failedAt: null })).toEqual({
      state: "unknown",
      reasons: ["notifications_poll_before_window"],
    });
  });

  it("are partial when the poll's last whole read is older than OFAPI's own threshold", () => {
    const threshold = OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS / 60_000;
    expect(chatspace({ subscribersPassedAt: minutes(threshold - 1), failedAt: null }).state).toBe("complete");
    expect(chatspace({ subscribersPassedAt: minutes(threshold + 1), failedAt: null })).toEqual({
      state: "partial",
      reasons: ["notifications_poll_behind"],
    });
  });

  it("are partial while the poll fails since its last whole read, and whole again once it reads them", () => {
    expect(chatspace({ subscribersPassedAt: minutes(20), failedAt: minutes(10) })).toEqual({
      state: "partial",
      reasons: ["notifications_poll_failing"],
    });
    expect(chatspace({ subscribersPassedAt: minutes(5), failedAt: minutes(10) }).state).toBe("complete");
  });

  it("are partial while a journaled notification is not a row yet; OFAPI's sweep and projection are not asked", () => {
    expect(chatspace({ subscribersPassedAt: minutes(5), failedAt: null }, 2)).toEqual({
      state: "partial",
      reasons: ["subscription_event_pending"],
    });
  });
});

describe("«Новые» of a page OFAPI still feeds", () => {
  it("keep OFAPI's own witnesses", () => {
    expect(evaluateAudienceCoverage({
      from, to, delivery: { frontier: minutes(10) }, pendingNotifications: 0, backlog: { pending: 0, failed: 0 },
      sweep: { lastCompletedAt: minutes(30), unverified: false },
    })).toEqual({ state: "complete", reasons: [] });
    expect(evaluateAudienceCoverage({
      from, to, delivery: null, pendingNotifications: 0, backlog: { pending: 0, failed: 0 }, sweep: null,
    })).toEqual({ state: "unknown", reasons: ["delivery_history_off", "audience_sweep_missing"] });
  });
});

import { describe, expect, it } from "vitest";

import {
  decideNotificationPaging,
  notificationPagingPolicyFor,
} from "../apps/runtime/src/services/notification-paging-policy.ts";

// 2026-10-24, ari-1 freshness: five short episodes paged as flapping, the
// page resolved after its hold, and the next sweep paged the same five
// episodes again — 43 pages in five hours until the window let go of them.
const policy = notificationPagingPolicyFor("fansly_sync_engine", "freshness");
const now = new Date("2026-10-24T11:40:00Z");
const resolvedStorm = {
  status: "resolved" as const,
  openedAt: new Date("2026-10-24T09:40:09Z"),
  resolvedAt: new Date("2026-10-24T09:54:39Z"),
  manuallyResolvedSincePage: false,
};

describe("flapping pages", () => {
  it("page a storm of uncovered episodes once", () => {
    const decision = decideNotificationPaging({
      ...resolvedStorm,
      paging: null,
      unpagedEpisodesInWindow: 5,
      earliestUnpagedEpisodeInWindowAt: new Date("2026-10-24T06:35:01Z"),
    }, policy, now);
    expect(decision).toMatchObject({ action: "page", mode: "flapping" });
  });

  it("do not page the same storm again after its recovery", () => {
    const decision = decideNotificationPaging({
      ...resolvedStorm,
      paging: {
        pagedAt: new Date("2026-10-24T11:37:07Z"),
        pagedOpenedAt: new Date("2026-10-24T06:35:01Z"),
        pagedMode: "flapping",
        pagedResolvedAt: new Date("2026-10-24T11:39:07Z"),
      },
      unpagedEpisodesInWindow: 0,
      earliestUnpagedEpisodeInWindowAt: null,
    }, policy, now);
    expect(decision).toEqual({ action: "none" });
  });
});

// Review 2026-10-25: the 15-minute hold of #837 is for the short cycles a
// restart heals; the reasons inside the same latches that wait for a fix or
// the owner page at once.
describe("held Sync Engine latches", () => {
  const held = notificationPagingPolicyFor("fansly_sync_engine", "freshness");
  const atOnce = notificationPagingPolicyFor("fansly_sync_engine", null);

  it("hold a socket that may come back and a lost browser link", () => {
    expect(notificationPagingPolicyFor("fansly_sync_engine", "live_degraded", "socket_down · since 2026-10-20T06:53:21.561Z · {\"reasons\":[\"socket_down\"]}")).toEqual(held);
    expect(notificationPagingPolicyFor("fansly_sync_engine", "browser:cdp_lost", "cdp_lost · since 2026-10-17T11:57:03.763Z")).toEqual(held);
  });

  it("page a changed protocol, a halted buffer, a quarantine and an owner's stop at once", () => {
    for (const summary of [
      "socket_down · since 2026-10-20T06:53:21.561Z · {\"reasons\":[\"socket_down\",\"protocol_changed\"]}",
      "browser_buffer_halted · since 2026-10-20T06:53:21.561Z",
      "quarantined · {\"resources\":[\"dm_messages\"]}",
    ]) expect(notificationPagingPolicyFor("fansly_sync_engine", "live_degraded", summary)).toEqual(atOnce);
    expect(notificationPagingPolicyFor("fansly_sync_engine", "browser:cdp_lost", "holder_overflow · since 2026-10-17T11:57:03.763Z")).toEqual(atOnce);
  });
});

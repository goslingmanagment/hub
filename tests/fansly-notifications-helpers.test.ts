// WP-F2 — the notification walk's pure helpers. No database: the overlap,
// backfill, coverage and attempt invariants that need one stay in
// fansly-notifications-lane.integration.test.ts.

import { describe, expect, it } from "vitest";

import { FANSLY_NOTIFICATION_DECLARED_TYPE_CSV } from "@agency_hub_core/shared";

import {
  backfillAttemptCeiling,
  backfillContinuationAt,
  FORWARD_HEAD_RESERVED_ATTEMPTS,
  forwardPollDue,
  nextForwardPollAt,
} from "../apps/runtime/src/services/sync/fansly-notifications.ts";
import {
  classifyNotificationResponse,
  compareNotificationRefs,
  typesForFilterMode,
} from "../apps/runtime/src/sync/fansly/lib/notifications-rules.ts";
import { envelope, NOW, ref, row } from "./helpers/fansly-notifications-fixtures.ts";

describe("WP-F2 walk helpers", () => {
  it("refuses a non-empty page with no usable id, and tolerates one odd row", () => {
    expect(classifyNotificationResponse(envelope([]))).toBe("empty");
    expect(classifyNotificationResponse({ notifications: [null] })).toBe("invalid");
    expect(classifyNotificationResponse({ notifications: [{}] })).toBe("invalid");
    expect(classifyNotificationResponse({ notifications: [{ id: 7 }] })).toBe("invalid");
    expect(classifyNotificationResponse({})).toBe("invalid");
    // Per-row tolerance stays: one good id makes the page walkable.
    expect(classifyNotificationResponse({ notifications: [row(1), null, {}] })).toBe("nonempty");
    expect(classifyNotificationResponse({ notifications: [{ idString: ref(1) }] }))
      .toBe("nonempty");
  });

  it("orders snowflake refs by length first, then lexicographically", () => {
    expect(compareNotificationRefs("100", "99")).toBeGreaterThan(0);
    expect(compareNotificationRefs("100", "101")).toBeLessThan(0);
    expect(compareNotificationRefs("100", "100")).toBe(0);
  });

  it("spaces backfill continuations with ±30% jitter", () => {
    // Burst shape, not daily volume, is the real ban-risk surface.
    expect(backfillContinuationAt(NOW, 20_000, () => 0).getTime() - NOW.getTime()).toBe(14_000);
    expect(backfillContinuationAt(NOW, 20_000, () => 1).getTime() - NOW.getTime()).toBe(26_000);
  });

  it("makes a head poll due again after the stream's cadence", () => {
    const base = { lastForwardPollAt: NOW.toISOString() } as never;
    expect(forwardPollDue(base, new Date(NOW.getTime() + 1_000))).toBe(false);
    expect(forwardPollDue(base, new Date(NOW.getTime() + 1_800_000))).toBe(true);
    // A lane that has never polled is always due.
    expect(forwardPollDue({ lastForwardPollAt: null } as never, NOW)).toBe(true);
  });

  it("reserves the head's share of the daily allowance from the backfill", () => {
    // 48 scheduled polls plus a quarter as pagination/retry headroom.
    expect(FORWARD_HEAD_RESERVED_ATTEMPTS).toBe(60);
    // The shipped cap: the backfill gets what is left, not the whole day.
    expect(backfillAttemptCeiling(96)).toBe(36);
    // A deliberately small cap slows the one-off walk down; it never parks it.
    expect(backfillAttemptCeiling(8)).toBe(1);
  });

  it("sends a reserve-deferred backfill back when the head is next due", () => {
    const state = { lastForwardPollAt: NOW.toISOString() };
    expect(nextForwardPollAt(state, new Date(NOW.getTime() + 60_000)).toISOString())
      .toBe(new Date(NOW.getTime() + 1_800_000).toISOString());
    // Never into the past, and a lane that has never polled goes now.
    const overdue = new Date(NOW.getTime() + 3_600_000);
    expect(nextForwardPollAt(state, overdue)).toEqual(overdue);
    expect(nextForwardPollAt({ lastForwardPollAt: null }, NOW)).toEqual(NOW);
  });

  it("maps each filter mode to the form it issues", () => {
    expect(typesForFilterMode("unfiltered", 0)).toBeNull();
    expect(typesForFilterMode("declared_csv", 0)?.join(","))
      .toBe(FANSLY_NOTIFICATION_DECLARED_TYPE_CSV);
    // The purchase group leads the iteration: money first on the degraded path.
    expect(typesForFilterMode("type_groups", 0)).toEqual([2007, 2008, 32007, 45012]);
  });
});

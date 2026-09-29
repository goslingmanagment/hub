// WP-F6 — the post_engagement tier boundaries, as pure arithmetic. The queue
// itself (due-ness, priority, failures, rebuild survival) is SQL and stays in
// fansly-post-engagement-queue.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  POST_ENGAGEMENT_FRESH_DAYS,
  POST_ENGAGEMENT_MID_DAYS,
  postEngagementIntervalDays,
  postEngagementTier,
} from "@agency_hub_core/db";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe("[sync-critical] WP-F6 the post_engagement refresh queue", () => {
  it("classifies a post's tier from its publication age", () => {
    // Pure arithmetic, pinned so the boundary lives in one place: the handler
    // computes a row's next due date from the same function the SQL tiers with.
    expect(postEngagementTier(daysAgo(1), NOW)).toBe("fresh");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_FRESH_DAYS), NOW)).toBe("fresh");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_FRESH_DAYS + 1), NOW)).toBe("mid");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_MID_DAYS), NOW)).toBe("mid");
    expect(postEngagementTier(daysAgo(POST_ENGAGEMENT_MID_DAYS + 1), NOW)).toBe("long_tail");
    // Publication date unknown ⇒ treat it as fresh rather than inventing an age.
    expect(postEngagementTier(null, NOW)).toBe("fresh");

    expect(postEngagementIntervalDays("fresh")).toBe(1);
    expect(postEngagementIntervalDays("mid")).toBe(7);
    expect(postEngagementIntervalDays("long_tail")).toBe(30);
  });
});

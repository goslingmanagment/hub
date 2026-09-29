// WP-F2 — the notification-page wire shapes, shared by the DB-backed lane
// suite (fansly-notifications-lane.integration.test.ts) and its walk-helper
// unit suite (fansly-notifications-helpers.test.ts).

export const NOW = new Date("2026-08-19T09:00:00.000Z");

/** Synthetic snowflakes, newest first. Length-then-lexicographic ordering is
 *  what the walk compares on, and every id here is the same length. */
export function ref(n: number): string {
  return `0009${String(90000000000000 - n * 100).padStart(14, "0")}`;
}

export function row(n: number, type = 3003, extra: Record<string, unknown> = {}) {
  return {
    id: ref(n),
    idString: ref(n),
    accountId: "000910000000000001",
    type,
    correlationId: "000920000000000001",
    correlationGroupId: "000930000000000001",
    acknowledgedAt: 1787000000 - n * 60,
    createdAt: 1787000000 - n * 3600,
    metadata: null,
    ...extra,
  };
}

/** The [A20] hazard: the sidecar the platform serves is a FULL account record. */
function fullAccountSidecar() {
  return [{
    id: "000920000000000001",
    username: "fixture_fan",
    displayName: "Fixture Fan",
    createdAt: 1690000000,
    followsYou: true,
    notes: "fixture note",
    // The eight [A20]-rejected fields. `lastSeenAt` moves every minute and is
    // the one that destroys the dedup collapse.
    lastSeenAt: 1787000123,
    followCount: 41,
    subscriberCount: 7,
    postLikes: 19,
    accountMediaLikes: 4,
    timelineStats: { imageCount: 12 },
    streaming: { lastFetchedAt: 0 },
    version: 3,
  }];
}

export function envelope(rows: ReturnType<typeof row>[]) {
  return {
    notifications: rows,
    tips: [],
    accountMedia: [],
    accountMediaBundles: [],
    subscriptions: [],
    subscriptionHistory: [],
    accounts: fullAccountSidecar(),
  };
}

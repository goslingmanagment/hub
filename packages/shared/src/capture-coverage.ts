/** Stable names written to `capture_coverage.plane`. */
export const CAPTURE_COVERAGE_PLANES = Object.freeze({
  statsAccountDaily: "stats_account_daily",
  statsAccountHourly: "stats_account_hourly",
  statsEarnings: "stats_earnings",
  notifications: "notifications",
  postLikes: "post_likes",
  catalog: "catalog",
  catalogVaultMedia: "catalog_vault_media",
  catalogMediaHydration: "catalog_media_hydration",
  postReplies: "post_replies",
  payouts: "payouts",
  mediaStats: "media_stats",
} as const);

export type CaptureCoveragePlane =
  typeof CAPTURE_COVERAGE_PLANES[keyof typeof CAPTURE_COVERAGE_PLANES];

/** Required capture evidence for each Analytics panel. */
export const ANALYTICS_COVERAGE_PLANES = Object.freeze({
  traffic: Object.freeze([CAPTURE_COVERAGE_PLANES.statsAccountDaily]),
  fyp: Object.freeze([CAPTURE_COVERAGE_PLANES.statsAccountDaily]),
  topMedia: Object.freeze([CAPTURE_COVERAGE_PLANES.mediaStats]),
  topTags: Object.freeze([CAPTURE_COVERAGE_PLANES.statsAccountDaily]),
  revenue: Object.freeze([CAPTURE_COVERAGE_PLANES.statsEarnings]),
  contentPerformance: Object.freeze([
    CAPTURE_COVERAGE_PLANES.catalog,
    CAPTURE_COVERAGE_PLANES.mediaStats,
  ]),
  comments: Object.freeze([CAPTURE_COVERAGE_PLANES.postReplies]),
} as const);

/** Maximum acceptable lag behind the selected window's head. */
export const CAPTURE_COVERAGE_HEAD_TOLERANCE_MS: Readonly<
  Partial<Record<CaptureCoveragePlane, number>>
> = Object.freeze({
  [CAPTURE_COVERAGE_PLANES.statsAccountHourly]: 12 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.statsAccountDaily]: 48 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.statsEarnings]: 48 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.notifications]: 48 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.catalog]: 8 * 24 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.catalogVaultMedia]: 8 * 24 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.catalogMediaHydration]: 8 * 24 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.postReplies]: 8 * 24 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.payouts]: 8 * 24 * 60 * 60 * 1_000,
  [CAPTURE_COVERAGE_PLANES.mediaStats]: 8 * 24 * 60 * 60 * 1_000,
});

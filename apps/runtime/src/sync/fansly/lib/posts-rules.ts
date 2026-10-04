// The posts rules of the Sync Engine's `posts.*` resources and capture helper
// (resources/posts.ts, capture.ts): the `posts` stream's cursor (the legacy
// executor's walk, shared by both platforms, with the Fansly engagement
// phase's state inside it), the Fansly timeline page's item contract and
// publication instant, and the post-tips scope check. Pure. The legacy
// executor's OnlyFans `posts` stream (posts.ts) reads the same cursor.

/** Every six-hour posts run refreshes at least this recent publication window.
 * One additional fully-old provider page may be captured to prove the bound. */
export const FANSLY_RECENT_POST_REFRESH_LOOKBACK_DAYS = 14;

export type PostsCursorState = {
  version: 1;
  platform: "fansly" | "onlyfans";
  revision: number;
  headPostId: string | null;
  anchorPostId: string | null;
  capturedHeadPostId: string | null;
  before: string;
  pageIndex: number;
  pendingCaptureJobId: string | null;
  /** Null only on checkpoints written before the companion tip request. */
  fanslyPostTipsCaptureVersion: 1 | null;
  /** Durable one-time upgrade marker. Null on legacy checkpoints forces a
   * full Fansly walk so pre-existing posts receive monetization/tip capture. */
  fanslyPostTipsBackfilledAt: string | null;
  /** Frozen lower publication bound for this ordinary refresh walk. Null only
   * for the one-time full backfill and for non-Fansly state. */
  fanslyRecentRefreshCutoffAt: string | null;
  /** Durable because a refresh may cross chunk or request-generation bounds. */
  fanslyRecentRefreshAnchorReached: boolean;
  completedAt: string | null;
  /** WP-F6. The engagement refresh phase's own state, carried ACROSS request
   *  generations: the timeline walk restarts every cadence, the day's call
   *  count and the seeding sweep must not. */
  fanslyPostEngagement: PostsEngagementCursor;
};

/** WP-F6: the engagement phase's durable state, nested inside the posts cursor
 *  because the phase rides the EXISTING `posts` stream and a stream has one
 *  checkpoint. Its call counter is SEPARATE from the timeline walk's budget by
 *  construction — the timeline is not capped, and capping it here would let a
 *  refresh phase starve the capture the whole system depends on. */
export type PostsEngagementCursor = {
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string | null;
  /** HTTP ATTEMPTS this phase spent on `utcDay`. Retries included. */
  callsToday: number;
  /** Keyset cursor of the first-enable seeding sweep over `creator_posts`. */
  seedCursor: string | null;
  seedComplete: boolean;
};

export function emptyPostsEngagementCursor(): PostsEngagementCursor {
  return { utcDay: null, callsToday: 0, seedCursor: null, seedComplete: false };
}

function parsePostsEngagementCursor(value: unknown): PostsEngagementCursor {
  const state = asRecord(value);
  if (!state) {
    // Legacy checkpoints predate the phase. An absent block is "never run",
    // not a parse failure: refusing the whole cursor here would restart the
    // timeline walk from the head on the deploy that ships WP-F6.
    return emptyPostsEngagementCursor();
  }
  const utcDay = typeof state.utcDay === "string" && state.utcDay.length > 0
    ? state.utcDay
    : null;
  const callsToday = typeof state.callsToday === "number"
      && Number.isSafeInteger(state.callsToday) && state.callsToday >= 0
    ? state.callsToday
    : 0;
  const seedCursor = typeof state.seedCursor === "string" && state.seedCursor.length > 0
    ? state.seedCursor
    : null;
  return { utcDay, callsToday, seedCursor, seedComplete: state.seedComplete === true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

type FanslyPostTipScopeReason = "receiver_mismatch" | "post_target_out_of_scope";

export function inspectFanslyPostTipsScope(
  raw: unknown,
  input: { requestedTargetIds: readonly string[]; receiverId: string },
): {
  accepted: boolean;
  rejectedItemIndexes: number[];
  reasons: FanslyPostTipScopeReason[];
} {
  if (!Array.isArray(raw)) {
    // Top-level drift stays in the ordinary post_tips lane as replayable parse
    // debt. Scope is unknowable until a future parser recognizes the envelope.
    return { accepted: true, rejectedItemIndexes: [], reasons: [] };
  }
  const requested = new Set(input.requestedTargetIds);
  const rejectedItemIndexes = new Set<number>();
  const reasons = new Set<FanslyPostTipScopeReason>();
  for (const [index, item] of raw.entries()) {
    const tip = asRecord(item);
    if (!tip) continue;
    const receiverId = typeof tip.receiverId === "string"
      ? tip.receiverId
      : typeof tip.receiverId === "number" && Number.isFinite(tip.receiverId)
        ? String(tip.receiverId)
        : null;
    if (receiverId !== null && receiverId !== input.receiverId) {
      rejectedItemIndexes.add(index);
      reasons.add("receiver_mismatch");
    }
    const flatPostRef = typeof tip.targetId === "string"
      ? tip.targetId
      : typeof tip.targetId === "number" && Number.isFinite(tip.targetId)
        ? String(tip.targetId)
        : null;
    if (flatPostRef !== null && !requested.has(flatPostRef)) {
      rejectedItemIndexes.add(index);
      reasons.add("post_target_out_of_scope");
    }
    if (!Array.isArray(tip.targets)) continue;
    for (const candidate of tip.targets) {
      const target = asRecord(candidate);
      if (!target || target.type !== 1000) continue;
      const postRef = typeof target.id === "string"
        ? target.id
        : typeof target.id === "number" && Number.isFinite(target.id)
          ? String(target.id)
          : null;
      if (postRef !== null && !requested.has(postRef)) {
        rejectedItemIndexes.add(index);
        reasons.add("post_target_out_of_scope");
      }
    }
  }
  return {
    accepted: rejectedItemIndexes.size === 0,
    rejectedItemIndexes: [...rejectedItemIndexes].sort((a, b) => a - b),
    reasons: [...reasons].sort(),
  };
}

export function parsePostsCursorState(value: unknown): PostsCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1 || (state.platform !== "fansly" && state.platform !== "onlyfans")) {
    return null;
  }
  const revision = state.revision;
  const headPostId = nullableString(state.headPostId);
  const anchorPostId = nullableString(state.anchorPostId);
  const capturedHeadPostId = nullableString(state.capturedHeadPostId);
  const before = state.before;
  const pageIndex = state.pageIndex;
  const pendingCaptureJobId = nullableString(state.pendingCaptureJobId);
  const fanslyPostTipsCaptureVersion = state.fanslyPostTipsCaptureVersion === undefined
    || state.fanslyPostTipsCaptureVersion === null
    ? null
    : state.fanslyPostTipsCaptureVersion === 1
      ? 1
      : undefined;
  const fanslyPostTipsBackfilledAt = state.fanslyPostTipsBackfilledAt === undefined
    ? null
    : nullableString(state.fanslyPostTipsBackfilledAt);
  const fanslyRecentRefreshCutoffAt = state.fanslyRecentRefreshCutoffAt === undefined
    ? null
    : nullableString(state.fanslyRecentRefreshCutoffAt);
  const fanslyRecentRefreshAnchorReached = state.fanslyRecentRefreshAnchorReached === undefined
    ? false
    : typeof state.fanslyRecentRefreshAnchorReached === "boolean"
      ? state.fanslyRecentRefreshAnchorReached
      : undefined;
  const completedAt = nullableString(state.completedAt);
  const fanslyPostEngagement = parsePostsEngagementCursor(state.fanslyPostEngagement);
  if (
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
    headPostId === undefined || anchorPostId === undefined || capturedHeadPostId === undefined ||
    typeof before !== "string" || before.length === 0 ||
    typeof pageIndex !== "number" || !Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
    pendingCaptureJobId === undefined || fanslyPostTipsCaptureVersion === undefined
    || fanslyPostTipsBackfilledAt === undefined
    || fanslyRecentRefreshCutoffAt === undefined
    || (fanslyRecentRefreshCutoffAt !== null
      && Number.isNaN(new Date(fanslyRecentRefreshCutoffAt).getTime()))
    || fanslyRecentRefreshAnchorReached === undefined
    || completedAt === undefined
  ) {
    return null;
  }
  return {
    version: 1,
    platform: state.platform,
    revision,
    headPostId,
    anchorPostId,
    capturedHeadPostId,
    before,
    pageIndex,
    pendingCaptureJobId,
    fanslyPostTipsCaptureVersion,
    fanslyPostTipsBackfilledAt,
    fanslyRecentRefreshCutoffAt,
    fanslyRecentRefreshAnchorReached,
    completedAt,
    fanslyPostEngagement,
  };
}

/** A Fansly `createdAt` (seconds, milliseconds or ISO) as an instant. */
export function fanslyPublishedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(value >= 1_000_000_000_000 ? value : value * 1_000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function fanslyPublishedAtIsValid(value: unknown) {
  return fanslyPublishedAt(value) !== null;
}

/** The timeline page's item contract, checked AFTER the page is journaled. */
export function assertFanslyPostsPageContract(page: {
  contractAccepted: boolean;
  items: Array<{
    id?: unknown;
    createdAt?: unknown;
    content?: unknown;
  }>;
}) {
  if (!page.contractAccepted) {
    throw new Error("Fansly posts response drifted away from {posts: [...]}");
  }
  for (const post of page.items) {
    if (
      typeof post.id !== "string" || post.id.length === 0 ||
      !fanslyPublishedAtIsValid(post.createdAt) ||
      (post.content !== undefined && post.content !== null && typeof post.content !== "string")
    ) {
      throw new Error("Fansly posts response contains an invalid post item");
    }
  }
}

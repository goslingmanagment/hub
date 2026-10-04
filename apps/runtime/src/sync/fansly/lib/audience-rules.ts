import type { UpsertFanPageInput, UpsertPageSubscriptionInput } from "@agency_hub_core/db";
import { mapFanslySubscriptionStatus, type FanslyFollower, type FanslySubscriber } from "@agency_hub_core/fansly";
import { millsFromInteger } from "@agency_hub_core/shared";

// The audience rules of the Sync Engine's resources (resources/subscribers.ts,
// followers.ts): subscribers, followers, followers reconcile. Pure. The legacy
// chunk handlers (executor-handlers.ts, followers-reconcile-floor.ts) import
// them from here until step 4 deletes them.

/** Restarts of a subscribers walk (total changed, partial result, offset
 *  duplicates) before the walk is withheld. */
export const SUBSCRIBERS_MAX_WALK_RESTARTS = 2;
/** How long a restarted subscribers walk waits before its first page. */
export const SUBSCRIBERS_WALK_RESTART_DELAY_MS = 60_000;
// Most current subscriptions a stated-empty active snapshot retires on its
// own, each already lapsed with auto-renew off before the walk began. A share
// cannot tell one-to-zero from ten-thousand-to-zero; any larger or unexplained
// drop needs the account counter's confirmation below or keeps the
// empty-first-page guard.
export const SUBSCRIBERS_EMPTY_SNAPSHOT_MAX_RETIREMENTS = 5;
// A stated zero the lapsed rule cannot explain is accepted when Fansly's own
// /account/me subscriberCount, which the light and followers streams write to
// the page hourly, also reads 0 and was verified no earlier than this long
// before the walk began. The counter trails a lapse by about a day, which is
// the confirmation pause.
export const SUBSCRIBERS_EMPTY_SNAPSHOT_COUNTER_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Owner policy: a full followers walk starts at most once a day on every
 *  page. The walk's two-walk grace is unchanged, so an unfollow shows 24-48 h
 *  after it happens instead of within a few hours. */
export const FOLLOWERS_RECONCILE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const FOLLOWERS_RECONCILE_PAGE_SIZE = 100;
export const FOLLOWERS_RECONCILE_MAX_SNAPSHOT_RESTARTS = 2;
export const FOLLOWERS_RECONCILE_RETRY_DELAY_MS = 15 * 60_000;

export function expectedFollowersReconcileTerminalPageCount(observedCount: number) {
  // `done` means the terminal page is short. An exact multiple therefore has
  // one final empty page; every other count ends on its last partial page.
  return Math.floor(observedCount / FOLLOWERS_RECONCILE_PAGE_SIZE) + 1;
}

export function uniqueFollowerIds(followers: readonly FanslyFollower[]) {
  return Array.from(new Set(
    followers
      .map((follower) => follower.followerId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  ));
}

export function findUnmappedFollowerIds(
  sourceFollowerIds: readonly string[],
  fanMap: ReadonlyMap<string, number>,
) {
  return sourceFollowerIds.filter((id) => !fanMap.has(id));
}

/**
 * A zero the provider states outright: an accepted contract on the first and
 * terminal page of an active walk, an explicit active total of zero, and
 * nothing positive earlier in the same walk. An empty array alone (a missing
 * total, an absent or rejected contract) is not a statement of zero.
 */
export function isStatedEmptyActiveSnapshot(
  state: { mode: "active" | "expired"; offset: number; observedCount: number },
  page: { contractAccepted?: boolean; total?: number | null; items: readonly unknown[]; done: boolean },
  totalChanged: boolean,
) {
  return state.mode === "active" &&
    state.offset === 0 &&
    state.observedCount === 0 &&
    !totalChanged &&
    page.contractAccepted === true &&
    page.done &&
    page.items.length === 0 &&
    page.total === 0;
}

/**
 * The rows one `/subscribers` page writes: a subscription per served item
 * whose subscriber maps to a fan, stamped with the walk's generation, and —
 * for the active walk — the fan's page link. An item whose subscriber has no
 * fan row is skipped.
 */
export function buildFanslySubscriptionRows(input: {
  platformAccountId: number;
  generation: number;
  mode: "active" | "expired";
  items: readonly FanslySubscriber[];
  fanMap: ReadonlyMap<string, number>;
}): { subscriptions: UpsertPageSubscriptionInput[]; fanPages: UpsertFanPageInput[] } {
  const subscriptions: UpsertPageSubscriptionInput[] = [];
  const fanPages: UpsertFanPageInput[] = [];
  for (const item of input.items) {
    const fanId = input.fanMap.get(item.subscriberId);
    if (!fanId) {
      continue;
    }

    const sourceCreatedAt = item.createdAt ? new Date(item.createdAt) : null;
    const endsAt = item.endsAt ? new Date(item.endsAt) : null;
    const autoRenew = item.autoRenew === null ? null : item.autoRenew === 1;
    const canonicalStatus = mapFanslySubscriptionStatus(item.status);
    subscriptions.push({
      platformSubscriptionId: item.id,
      platformAccountId: input.platformAccountId,
      fanId,
      platformHistoryId: item.historyId,
      subscriptionTierId: item.subscriptionTierId,
      subscriptionTierName: item.subscriptionTierName,
      subscriptionTierColor: item.subscriptionTierColor,
      planId: item.planId,
      rawStatus: item.status,
      canonicalStatus,
      priceMills: millsFromInteger(item.price),
      renewPriceMills: millsFromInteger(item.renewPrice),
      autoRenew,
      billingCycleDays: item.billingCycle,
      durationDays: item.duration,
      renewDate: item.renewDate ? new Date(item.renewDate) : null,
      sourceCreatedAt,
      sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
      endsAt,
      lastSeenGeneration: input.generation,
    });
    if (input.mode === "active") {
      fanPages.push({
        fanId,
        platformAccountId: input.platformAccountId,
        isSubscriber: true,
        subscriberSince: sourceCreatedAt,
        subscriptionExpiresAt: endsAt,
        autoRenew,
      });
    }
  }
  return { subscriptions, fanPages };
}

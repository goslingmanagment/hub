import type { FanslyAccount, FanslyFollower } from "@agency_hub_core/fansly";
import {
  FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN,
  type FanslyExternalPresenceSource,
} from "@agency_hub_core/shared";

export const FANSLY_ACTIVE_NOW_WINDOW_MS = 30 * 60 * 1000;
export const FANSLY_RECENTLY_ACTIVE_WINDOW_MS = 120 * 60 * 1000;

export type FanslyPresenceBucket = "active_now" | "recently_active";

export interface FanslyPagePresenceSignal {
  platformUserId: string;
  lastSeenAt: Date;
  observedAt: Date;
  source: FanslyExternalPresenceSource;
  bucket: FanslyPresenceBucket;
}

function normalizeTimestamp(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function classifyFanslyPresenceBucket(lastSeenAt: Date, now: Date): FanslyPresenceBucket | null {
  const ageMs = Math.max(0, now.getTime() - lastSeenAt.getTime());

  if (ageMs < FANSLY_ACTIVE_NOW_WINDOW_MS) {
    return "active_now";
  }
  if (ageMs < FANSLY_RECENTLY_ACTIVE_WINDOW_MS) {
    return "recently_active";
  }

  return null;
}

export function buildFanslyFollowerPresenceSignals(input: {
  followers: FanslyFollower[];
  accounts: FanslyAccount[];
  observedAt?: Date;
  now?: Date;
}): FanslyPagePresenceSignal[] {
  const observedAt = input.observedAt ?? new Date();
  const now = input.now ?? observedAt;
  const accountsById = new Map(input.accounts.map((account) => [account.id, account] as const));
  const signals = new Map<string, FanslyPagePresenceSignal>();

  for (const follower of input.followers) {
    const account = accountsById.get(follower.followerId);
    const lastSeenAt = normalizeTimestamp(account?.lastSeenAt ?? follower.lastSeenAt);
    if (!lastSeenAt) {
      continue;
    }

    const bucket = classifyFanslyPresenceBucket(lastSeenAt, now);
    if (!bucket) {
      continue;
    }

    const current = signals.get(follower.followerId);
    if (current && current.lastSeenAt >= lastSeenAt) {
      continue;
    }

    signals.set(follower.followerId, {
      platformUserId: follower.followerId,
      lastSeenAt,
      observedAt,
      source: FANSLY_EXTERNAL_PRESENCE_SOURCE_FOLLOWERS_LAST_SEEN,
      bucket,
    });
  }

  return Array.from(signals.values());
}

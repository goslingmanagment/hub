import type { Database } from "@agency_hub_core/db";

import { resolveFanslyPlatformAccountId } from "../../../services/fansly.ts";
import type { DemandSignal, StepPlan } from "../../engine/resource.ts";

// What the audience resources read about their page before a step (design
// §5.11, §5.12): the native account id the follower routes name, and the two
// `/account/me` counters with the instant they were read. Read-only.

/** The plan of a step that needs the page's native Fansly id before it has
 *  one: `account.poll` writes it (made due here). */
export function waitForPageIdentity(key: string): StepPlan {
  const enqueue: DemandSignal[] = [{ resource: "account.poll", demand: { reason: `dependency:${key}` } }];
  return { kind: "wait", reason: "dependency", until: null, enqueue };
}

/** The `/account/me` counters are fresh for a walk that starts at most this
 *  long after they were read: the subscribers stated-empty rule's window
 *  (`SUBSCRIBERS_EMPTY_SNAPSHOT_COUNTER_MAX_AGE_MS`), and the window in which
 *  the followers head reuses the count instead of re-reading `/account/me`. */
export const ACCOUNT_COUNTERS_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface FanslyPageFacts {
  pageId: number;
  label: string;
  /** `pages.external_page_id` (or the legacy metadata copy); null before the
   *  first `/account/me`. */
  externalId: string | null;
  followerCount: number | null;
  subscriberCount: number | null;
  lastVerifiedAt: Date | null;
  metadata: Record<string, unknown>;
}

export async function readFanslyPageFacts(db: Database, pageId: number): Promise<FanslyPageFacts | null> {
  const page = await db.query.pages.findFirst({
    where: (pages, { eq }) => eq(pages.id, pageId),
    columns: {
      id: true,
      label: true,
      platformAccountId: true,
      followerCount: true,
      subscriberCount: true,
      lastVerifiedAt: true,
      metadata: true,
    },
  });
  if (page === undefined) return null;
  let externalId: string | null;
  try {
    externalId = resolveFanslyPlatformAccountId({
      label: page.label,
      platformAccountId: page.platformAccountId,
      metadata: page.metadata ?? {},
    });
  } catch {
    // No native id yet (before the page's first `/account/me`).
    externalId = null;
  }
  return {
    pageId: page.id,
    label: page.label,
    externalId,
    followerCount: page.followerCount,
    subscriberCount: page.subscriberCount,
    lastVerifiedAt: page.lastVerifiedAt,
    metadata: page.metadata ?? {},
  };
}

/** The counters were read (`pages.last_verified_at`: every `account` apply
 *  writes it) within `ACCOUNT_COUNTERS_MAX_AGE_MS` of `now`. */
export function accountCountersFresh(readAt: Date | null, now: Date): boolean {
  return readAt !== null && now.getTime() - readAt.getTime() <= ACCOUNT_COUNTERS_MAX_AGE_MS;
}

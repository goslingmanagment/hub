import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

import { resolveFanslyPlatformAccountId } from "../../../services/fansly.ts";
import type { DemandSignal, StepPlan } from "../../engine/resource.ts";

// What the audience resources read about their page before a step (design
// §5.11, §5.12): the native account id the follower routes name, and the two
// `/account/me` counters with the instant they were read. Read-only.

/** In shadow nothing writes a page's native id: a step that needs it
 *  re-checks this often. */
export const PAGE_IDENTITY_RECHECK_MS = 60 * 60 * 1000;

/** The plan of a step that needs the page's native Fansly id before it has
 *  one: live, `account.poll` writes it (made due here); in shadow nothing
 *  will, so the step only re-checks hourly. */
export function waitForPageIdentity(key: string, shadow: boolean, now: Date): StepPlan {
  if (shadow) return { kind: "wait", reason: "dependency", until: new Date(now.getTime() + PAGE_IDENTITY_RECHECK_MS) };
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

/**
 * The newest `/account/me` read of the page that a step may rely on: the
 * page's `last_verified_at` (every live `account` apply and the legacy light
 * stream write it), and — in shadow, where the engine's own `account` steps
 * write nothing — the newest shadow `account.*` step, which live would have
 * turned into exactly that write.
 */
export async function accountCountersReadAt(
  db: Database,
  input: { facts: FanslyPageFacts; shadow: boolean },
): Promise<Date | null> {
  let newest = input.facts.lastVerifiedAt;
  if (input.shadow) {
    const result = await db.execute<{ at: Date | string | null }>(sql`
      select max(a.completed_at) as at
        from sync_attempts a
       where a.page_id = ${input.facts.pageId}
         and a.shadow
         and a.outcome = 'shadow'
         and a.operation = 'account.me'
         and a.admitted_at > clock_timestamp() - ${ACCOUNT_COUNTERS_MAX_AGE_MS}::double precision * interval '1 millisecond'
    `);
    const raw = result.rows[0]?.at ?? null;
    const shadowAt = raw === null ? null : new Date(raw);
    if (shadowAt !== null && (newest === null || shadowAt.getTime() > newest.getTime())) newest = shadowAt;
  }
  return newest;
}

/** The counters were read within `ACCOUNT_COUNTERS_MAX_AGE_MS` of `now`. */
export function accountCountersFresh(readAt: Date | null, now: Date): boolean {
  return readAt !== null && now.getTime() - readAt.getTime() <= ACCOUNT_COUNTERS_MAX_AGE_MS;
}

import { sql } from "drizzle-orm";

import {
  countCurrentPageSubscriptionsByGeneration,
  deactivatePageSubscriptionsByGeneration,
  getCurrentSubscribers,
  maxPageSubscriptionGeneration,
  rebuildSubscriberRollups,
  refreshFanPageSubscriberState,
  retireLapsedPageSubscriptionsForEmptySnapshot,
  upsertArchivedPageSubscriptions,
  upsertFanPages,
  upsertPageSubscriptions,
  type Database,
} from "@agency_hub_core/db";
import {
  FANSLY_SUBSCRIBERS_PAGE_LIMIT,
  mapFanslySubscriptionStatus,
  parseFanslySubscribersPage,
  type FanslySubscribersPageContract,
  type FanslySubscribersStatus,
} from "@agency_hub_core/fansly";

import {
  buildFanslySubscriptionRows,
  isStatedEmptyActiveSnapshot,
  SUBSCRIBERS_EMPTY_SNAPSHOT_COUNTER_MAX_AGE_MS,
  SUBSCRIBERS_EMPTY_SNAPSHOT_MAX_RETIREMENTS,
  SUBSCRIBERS_MAX_WALK_RESTARTS,
  SUBSCRIBERS_WALK_RESTART_DELAY_MS,
} from "../../../services/sync/audience-rules.ts";
import { upsertHydratedFansForPage } from "../../../services/sync/fan-hydration.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  ResourceModule,
  ShadowResult,
  StepPlan,
  WorkOutcome,
} from "../../engine/resource.ts";
import { accountCountersFresh, accountCountersReadAt, readFanslyPageFacts } from "../lib/page-facts.ts";
import { advanceShadowWalk, offsetPageDone, offsetWalkPages, type ShadowWalkProgress } from "../lib/offset-walk.ts";
import { lookupFollowups, partitionLookupIds } from "./fan-profiles.ts";

// `subscribers.poll` and `subscribers.history` (plan §5, design §5.11): the
// offset walk of `GET /subscribers?offset&limit=100&status=…`, one page per
// step, journaled as `subscribers` verbatim. The apply is the legacy chunk's
// page transaction (executor-handlers.ts `fanslySubscribersChunk`) with its
// cursor in the work row and its throws turned into outcomes:
//
// - restart  — the total moved, a multi-page walk came back short, or rows
//              were served twice: a fresh generation from offset 0 after
//              60 s, at most twice per walk;
// - withheld — past that bound: the walk closes and retires nothing;
// - refused  — an empty first page the walk cannot vouch for: nothing
//              retired, the poll waits for its next period (legacy retried it
//              as a transient error forever).
//
// A walk's generation is the next above every stored one; it starts at the
// admission of its first page (`walkStartedAt`), so a row touched before that
// read is one the read could observe and one touched after it survives the
// finalization (Audit P-25). The active walk needs the `/account/me`
// subscriber counter read within 2 h (the stated-empty rule): without it the
// walk waits on `account.poll`, which it makes due.
//
// Subscribers arrive without profiles: their fan rows are ensured as
// unverified and the profiles are asked of `fan-profiles.lookup` (one request
// a step, never inside this apply).

export type SubscribersVariant = "poll" | "history";

type WithheldReason = "total_changed" | "partial_result" | "offset_duplicates";

interface SubscribersWalk {
  generation: number;
  /** ISO instant: the admission of the walk's first page. */
  walkStartedAt: string;
  offset: number;
  observedCount: number;
  distinctObservedCount: number;
  pageCount: number;
  providerReportedTotal: number | null;
  restartCount: number;
  historyWithheldReason?: WithheldReason;
}

export interface SubscribersCursor {
  /** The newest generation a walk of this row used. */
  generation: number;
  walk: SubscribersWalk | null;
  /** The next walk restarts an abandoned one (its restart count). */
  restartCount: number;
  /** The receipt of the last finished walk. */
  last: Record<string, unknown> | null;
  /** Shadow: the simulated walk. */
  shadow: ShadowWalkProgress | null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseWalk(value: unknown): SubscribersWalk | null {
  const record = recordOf(value);
  const generation = count(record.generation);
  const offset = count(record.offset);
  if (generation === null || offset === null || typeof record.walkStartedAt !== "string") return null;
  const reason = record.historyWithheldReason;
  return {
    generation,
    walkStartedAt: record.walkStartedAt,
    offset,
    observedCount: count(record.observedCount) ?? 0,
    distinctObservedCount: count(record.distinctObservedCount) ?? 0,
    pageCount: count(record.pageCount) ?? 0,
    providerReportedTotal: count(record.providerReportedTotal),
    restartCount: count(record.restartCount) ?? 0,
    ...(reason === "total_changed" || reason === "partial_result" || reason === "offset_duplicates"
      ? { historyWithheldReason: reason }
      : {}),
  };
}

export function parseSubscribersCursor(value: unknown): SubscribersCursor {
  const record = recordOf(value);
  const shadow = recordOf(record.shadow);
  return {
    generation: count(record.generation) ?? 0,
    walk: parseWalk(record.walk),
    restartCount: count(record.restartCount) ?? 0,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: count(shadow.steps) !== null && count(shadow.done) !== null
      ? { steps: count(shadow.steps)!, done: count(shadow.done)! }
      : null,
  };
}

function statusOf(variant: SubscribersVariant): FanslySubscribersStatus {
  return variant === "poll" ? "3,4" : "5";
}

/** A walk that cannot be certified starts over from offset 0 under a fresh
 *  generation (taken at its first page) after `SUBSCRIBERS_WALK_RESTART_DELAY_MS`. */
function restartOutcome(cursor: SubscribersCursor, walk: SubscribersWalk, reason: WithheldReason, now: Date): WorkOutcome {
  return {
    satisfiesRevision: false,
    nextDueAt: new Date(now.getTime() + SUBSCRIBERS_WALK_RESTART_DELAY_MS),
    waitingReason: "not_due",
    cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: walk.restartCount + 1, shadow: null },
    result: { restartReason: reason, restartCount: walk.restartCount + 1, pageCount: walk.pageCount },
  };
}

export function subscribersModule(variant: SubscribersVariant): ResourceModule {
  const mode = variant === "poll" ? "active" as const : "expired" as const;
  const status = statusOf(variant);
  const key = `subscribers.${variant}`;

  return {
    async plan(work, ctx): Promise<StepPlan> {
      const cursor = parseSubscribersCursor(work.cursor);
      if (cursor.walk === null && mode === "active") {
        const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
        if (facts === null) return { kind: "quarantine", reason: "page_missing" };
        const readAt = await accountCountersReadAt(ctx.db, { facts, shadow: ctx.shadow });
        if (!accountCountersFresh(readAt, ctx.now)) {
          const enqueue: DemandSignal[] = [{ resource: "account.poll", demand: { reason: `dependency:${key}` } }];
          return { kind: "wait", reason: "dependency", until: null, enqueue };
        }
      }
      const offset = cursor.walk?.offset ?? (ctx.shadow ? (cursor.shadow?.done ?? 0) * FANSLY_SUBSCRIBERS_PAGE_LIMIT : 0);
      return { kind: "request", request: { spec: "subscribers.page", params: { status, offset } } };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const page = input.parsed as FanslySubscribersPageContract;
      const pageId = input.pageId;
      const now = input.now;
      const cursor = parseSubscribersCursor(input.work.cursor);
      const requestedOffset = count(recordOf(input.request.params).offset);
      let walk: SubscribersWalk = cursor.walk ?? {
        generation: Math.max(cursor.generation, await maxPageSubscriptionGeneration(tx, pageId)) + 1,
        walkStartedAt: input.attempt.admittedAt.toISOString(),
        offset: 0,
        observedCount: 0,
        distinctObservedCount: 0,
        pageCount: 0,
        providerReportedTotal: null,
        restartCount: cursor.restartCount,
      };
      if (requestedOffset !== walk.offset) {
        throw new ApplyQuarantine("subscribers_cursor_mismatch", { requestedOffset, walkOffset: walk.offset });
      }
      const items = page.subscriptions;
      const pageTotal = page.total;
      // Offsets index one provider snapshot. A shifted total moves rows between
      // pages already read and pages still ahead, so this walk can no longer
      // be certified; restart it, bounded.
      const totalChanged = walk.providerReportedTotal !== null && pageTotal !== walk.providerReportedTotal;
      if (totalChanged && walk.restartCount < SUBSCRIBERS_MAX_WALK_RESTARTS) {
        return { work: restartOutcome(cursor, walk, "total_changed", now), followups: [], counters: { walk_restart_total_changed: 1 } };
      }
      walk = {
        ...walk,
        pageCount: walk.pageCount + 1,
        providerReportedTotal: totalChanged ? pageTotal : walk.providerReportedTotal ?? pageTotal,
      };
      const done = offsetPageDone({ offset: walk.offset, itemCount: items.length, limit: FANSLY_SUBSCRIBERS_PAGE_LIMIT, total: pageTotal });

      // An empty first page vouches for nothing unless the provider states the
      // zero outright; even then the finalization retires only what it can
      // explain, or refuses.
      const statedEmpty = isStatedEmptyActiveSnapshot(
        { mode, offset: walk.offset, observedCount: walk.observedCount },
        { contractAccepted: true, total: pageTotal, items, done },
        totalChanged,
      );
      if (!statedEmpty && mode === "active" && walk.offset === 0 && items.length === 0) {
        const current = await getCurrentSubscribers(tx, pageId);
        if (current.rows.length > 0) {
          return refused(cursor, walk, now, { reason: "zero_not_stated", currentCount: current.rows.length });
        }
      }

      const finalObservedCount = walk.observedCount + items.length;
      const partialResult = !totalChanged && done && walk.providerReportedTotal !== null &&
        finalObservedCount !== walk.providerReportedTotal;
      if (partialResult) {
        // One response is one snapshot: a single-page walk reads it again
        // from offset 0 (legacy: a transient retry of the same read).
        if (walk.pageCount === 1) {
          return {
            work: {
              satisfiesRevision: false,
              nextDueAt: new Date(now.getTime() + SUBSCRIBERS_WALK_RESTART_DELAY_MS),
              waitingReason: "not_due",
              cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: walk.restartCount, shadow: null },
              result: { retryReason: "partial_result", providerReportedTotal: walk.providerReportedTotal, observedCount: finalObservedCount },
            },
            followups: [],
            counters: { walk_partial_single_page: 1 },
          };
        }
        if (walk.restartCount < SUBSCRIBERS_MAX_WALK_RESTARTS) {
          return { work: restartOutcome(cursor, walk, "partial_result", now), followups: [], counters: { walk_restart_partial_result: 1 } };
        }
      }
      // Past the restart bound, keep what this walk saw and retire nothing.
      const withheldReason: WithheldReason | null = totalChanged ? "total_changed" : partialResult ? "partial_result" : null;
      if (mode === "expired" && withheldReason !== null) {
        // The archive retires nothing, so it reads on to its end; the
        // completion stays uncertified.
        walk = { ...walk, historyWithheldReason: walk.historyWithheldReason ?? withheldReason };
      }
      const lastPage = done || (mode === "active" && withheldReason !== null);

      // Fans: every subscriber maps (an unknown one is ensured, unverified);
      // the profiles not read through this page within the day are asked of
      // the lookup walk.
      const subscriberIds = [...new Set(items.map((item) => item.subscriberId))];
      const lookup = await partitionLookupIds(tx, { pageId, ids: subscriberIds, now });
      const fanMap = await upsertHydratedFansForPage(tx, {
        platformAccountId: pageId,
        accounts: [],
        unverifiedIds: lookup.due,
        reusedIds: lookup.fresh,
      });
      const followups = lookupFollowups(lookup.due, key);
      const rows = buildFanslySubscriptionRows({ platformAccountId: pageId, generation: walk.generation, mode, items, fanMap });
      if (mode === "active") {
        await upsertPageSubscriptions(tx, rows.subscriptions);
        await upsertFanPages(tx, rows.fanPages);
      } else {
        await upsertArchivedPageSubscriptions(tx, rows.subscriptions);
      }
      const pageDistinctCount = new Set(items.map((item) => item.id)).size;

      if (!lastPage) {
        walk = {
          ...walk,
          offset: walk.offset + FANSLY_SUBSCRIBERS_PAGE_LIMIT,
          observedCount: finalObservedCount,
          distinctObservedCount: walk.distinctObservedCount + pageDistinctCount,
        };
        return {
          work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...cursor, generation: walk.generation, walk, shadow: null } },
          followups,
        };
      }

      const walkStartedAt = new Date(walk.walkStartedAt);
      if (mode === "expired") {
        await rebuildSubscriberRollups(tx, pageId);
        const receipt = {
          mode,
          generation: walk.generation,
          completedAt: now.toISOString(),
          pageCount: walk.pageCount,
          observedCount: finalObservedCount,
          historyCertified: walk.historyWithheldReason === undefined,
          ...(walk.historyWithheldReason === undefined ? {} : { historyWithheldReason: walk.historyWithheldReason }),
        };
        return {
          work: {
            satisfiesRevision: true,
            close: "done",
            closeReason: "history_walked",
            cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: receipt, shadow: null },
            proof: receipt,
          },
          followups,
        };
      }

      let finalWithheld: WithheldReason | null = withheldReason;
      let membership: { generationCurrentCount: number; expectedCount: number } | null = null;
      if (finalWithheld === null && walk.pageCount > 1) {
        // Summed page lengths cannot tell a row served on two pages from two
        // rows; rows stamped with this generation are the distinct ones seen.
        const generationCurrentCount = await countCurrentPageSubscriptionsByGeneration(tx, {
          platformAccountId: pageId,
          generation: walk.generation,
        });
        const expectedCount = walk.distinctObservedCount + pageDistinctCount;
        if (generationCurrentCount < expectedCount) {
          membership = { generationCurrentCount, expectedCount };
          if (walk.restartCount < SUBSCRIBERS_MAX_WALK_RESTARTS) {
            const restart = restartOutcome(cursor, walk, "offset_duplicates", now);
            return {
              work: { ...restart, result: { ...recordOf(restart.result), membership } },
              followups,
              counters: { walk_restart_offset_duplicates: 1 },
            };
          }
          finalWithheld = "offset_duplicates";
        }
      }
      let retirement: Record<string, unknown> | null = null;
      if (finalWithheld === null && statedEmpty) {
        // The assessment and the retirement act on one locked set.
        const retired = await retireLapsedPageSubscriptionsForEmptySnapshot(tx, {
          platformAccountId: pageId,
          generation: walk.generation,
          walkStartedAt,
          maxRetirements: SUBSCRIBERS_EMPTY_SNAPSHOT_MAX_RETIREMENTS,
          counterVerifiedSince: new Date(walkStartedAt.getTime() - SUBSCRIBERS_EMPTY_SNAPSHOT_COUNTER_MAX_AGE_MS),
        });
        if (!retired.certified) {
          return refused(cursor, walk, now, {
            reason: retired.reason,
            currentCount: retired.currentCount,
            ...(retired.counter === undefined ? {} : {
              subscriberCount: retired.counter.subscriberCount,
              lastVerifiedAt: retired.counter.lastVerifiedAt?.toISOString() ?? null,
            }),
          });
        }
        retirement = {
          retiredCount: retired.retiredCount,
          confirmedBy: retired.counter === undefined ? "lapsed_rule" : "account_counter",
        };
      } else if (finalWithheld === null) {
        await deactivatePageSubscriptionsByGeneration(tx, {
          platformAccountId: pageId,
          generation: walk.generation,
          lastSeenBefore: walkStartedAt,
        });
      }
      await refreshFanPageSubscriberState(tx, pageId);
      await rebuildSubscriberRollups(tx, pageId);
      const receipt = {
        mode,
        generation: walk.generation,
        walkStartedAt: walk.walkStartedAt,
        completedAt: now.toISOString(),
        pageCount: walk.pageCount,
        observedCount: finalObservedCount,
        providerReportedTotal: walk.providerReportedTotal,
        restartCount: walk.restartCount,
        destructiveFinalization: finalWithheld === null,
        ...(finalWithheld === null ? {} : { withheldReason: finalWithheld }),
        ...(membership === null ? {} : { membership }),
        ...(retirement === null ? {} : { emptySnapshot: retirement }),
      };
      return {
        work: {
          satisfiesRevision: true,
          close: "done",
          closeReason: finalWithheld === null ? "walk_certified" : "walk_withheld",
          cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: receipt, shadow: null },
          proof: receipt,
        },
        followups,
        ...(finalWithheld === null ? {} : { counters: { walk_withheld: 1 } }),
      };
    },

    async shadow(work, _request, ctx): Promise<ShadowResult> {
      const cursor = parseSubscribersCursor(work.cursor);
      const total = await countSubscriptions(ctx.db, ctx.pageId, mode);
      const step = advanceShadowWalk(cursor.shadow, () =>
        offsetWalkPages({ total, limit: FANSLY_SUBSCRIBERS_PAGE_LIMIT, statedTotal: true }));
      if (!step.finished) {
        return { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
      }
      // What the live walk would ask of the lookup walk: the current
      // subscribers whose profile was not read through the page today.
      const followups = mode === "active"
        ? lookupFollowups((await partitionLookupIds(ctx.db, {
          pageId: ctx.pageId,
          ids: await currentSubscriberIds(ctx.db, ctx.pageId),
          now: ctx.now,
        })).due, key)
        : [];
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } },
        followups,
      };
    },

    async replay(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
      return replaySubscribersPage(observation, ctx);
    },
  };
}

/** The empty first page the walk cannot vouch for: nothing retired, the walk
 *  dropped, the poll back at its period (a `.history` goal closes). */
function refused(
  cursor: SubscribersCursor,
  walk: SubscribersWalk,
  now: Date,
  detail: Record<string, unknown>,
): ApplyResult {
  const receipt = { refusedAt: now.toISOString(), generation: walk.generation, ...detail };
  return {
    work: {
      satisfiesRevision: true,
      close: "done",
      closeReason: "empty_snapshot_refused",
      cursor: { ...cursor, generation: walk.generation, walk: null, restartCount: 0, last: { refused: receipt }, shadow: null },
      result: receipt,
    },
    followups: [],
    counters: { empty_snapshot_refused: 1 },
  };
}

async function countSubscriptions(db: Database, pageId: number, mode: "active" | "expired"): Promise<number> {
  const result = await db.execute<{ n: number | string }>(sql`
    select count(*)::int as n from page_subscriptions
     where platform_account_id = ${pageId} and is_current = ${mode === "active"}
  `);
  return Number(result.rows[0]?.n ?? 0);
}

async function currentSubscriberIds(db: Database, pageId: number): Promise<string[]> {
  const current = await getCurrentSubscribers(db, pageId);
  return current.rows
    .map((row) => (row as { platform_user_id?: unknown }).platform_user_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Replay of a legacy `subscribers` observation (design §5.11): the new
 * contract accepts what legacy accepted, and every served subscription is
 * stored with the canonical status the page states — or was seen again after
 * the observation (its status may have moved since). A body legacy refused is
 * journaled as `{contractAccepted: false, raw}`; the new contract must refuse
 * it too.
 */
async function replaySubscribersPage(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  const payload = recordOf(observation.payload);
  if (payload.contractAccepted === false) {
    const raw = payload.raw;
    return parseFanslySubscribersPage(raw, "3,4") === null && parseFanslySubscribersPage(raw, "5") === null
      ? { kind: "match", detail: { legacyRefused: true } }
      : { kind: "mismatch", reason: "legacy_refused_new_accepts" };
  }
  // The journal does not say which status filter asked; the active walk is
  // the one that runs (every page's history walk finished in 2026-08).
  const page = parseFanslySubscribersPage(observation.payload, "3,4") ?? parseFanslySubscribersPage(observation.payload, "5");
  if (page === null) return { kind: "mismatch", reason: "contract_refused" };
  if (page.subscriptions.length === 0) return { kind: "match", detail: { served: 0 } };
  const ids = page.subscriptions.map((item) => item.id);
  const stored = await ctx.db.execute<{ id: string; canonicalStatus: string; lastSeenAt: Date | string }>(sql`
    select platform_subscription_id as id, canonical_status as "canonicalStatus", last_seen_at as "lastSeenAt"
      from page_subscriptions
     where platform_account_id = ${ctx.pageId}
       and platform_subscription_id = any(${sql.param(ids)}::text[])
  `);
  const byId = new Map(stored.rows.map((row) => [row.id, row] as const));
  const mismatched: string[] = [];
  for (const item of page.subscriptions) {
    const row = byId.get(item.id);
    if (row === undefined) {
      mismatched.push(item.id);
      continue;
    }
    const seenLater = new Date(row.lastSeenAt).getTime() > observation.receivedAt.getTime();
    if (row.canonicalStatus !== mapFanslySubscriptionStatus(item.status) && !seenLater) mismatched.push(item.id);
  }
  return mismatched.length === 0
    ? { kind: "match", detail: { served: ids.length } }
    : { kind: "mismatch", reason: "subscriptions_differ", detail: { served: ids.length, mismatched: mismatched.length, examples: mismatched.slice(0, 5) } };
}

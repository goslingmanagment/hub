import { sql } from "drizzle-orm";

import {
  countActivePageFollows,
  countPageFollowsByGeneration,
  deactivatePageFollowsByGeneration,
  latestClosedWorkForKey,
  maxPageFollowGeneration,
  readPageFollowDeactivationGenerationBuckets,
  readPageFollowReconcileActivity,
  rebuildFollowerRollups,
  refreshFanPageFollowerState,
  updatePageSyncTimestampCache,
  upsertFanPageExternalPresences,
  upsertFanPages,
  upsertPageFollows,
  type Database,
  type UpsertFanPageExternalPresenceInput,
  type UpsertFanPageInput,
  type UpsertPageFollowInput,
} from "@agency_hub_core/db";
import {
  FANSLY_FOLLOWERS_PAGE_LIMIT,
  parseFanslyFollowersPage,
  type FanslyAccount,
  type FanslyAccountMe,
  type FanslyFollower,
  type FanslyFollowersPage,
} from "@agency_hub_core/fansly";
import { compareFanslyFollowIds, fanslyFollowIdToDate } from "@agency_hub_core/shared";

import { buildFanslyFollowerPresenceSignals } from "../../../services/fansly-presence.ts";
import {
  expectedFollowersReconcileTerminalPageCount,
  findUnmappedFollowerIds,
  FOLLOWERS_RECONCILE_MAX_SNAPSHOT_RESTARTS,
  FOLLOWERS_RECONCILE_RETRY_DELAY_MS,
  uniqueFollowerIds,
} from "../../../services/sync/audience-rules.ts";
import { upsertHydratedFansForPage } from "../../../services/sync/fan-hydration.ts";
import { followersReconcileDecision } from "../../../services/sync/followers-reconcile-decision.ts";
import { FOLLOWERS_RECONCILE_MIN_INTERVAL_MS } from "../../../services/sync/followers-reconcile-floor.ts";
import { followersReconcileDeactivationLimit } from "../../../services/sync/followers-reconcile-safety.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import type {
  ApplyInput,
  ApplyResult,
  DemandSignal,
  LegacyImport,
  ReplayContext,
  ReplayObservation,
  ReplayVerdict,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";
import { advanceShadowWalk, offsetWalkPages, type ShadowWalkProgress } from "../lib/offset-walk.ts";
import { accountCountersFresh, accountCountersReadAt, readFanslyPageFacts, waitForPageIdentity } from "../lib/page-facts.ts";
import { ACCOUNT_ME_REQUEST, applyAccountMeToPage } from "./account.ts";
import { lookupFollowups, partitionLookupIds } from "./fan-profiles.ts";

// `followers.head` and `followers.reconcile` (plan §5, design §5.12):
// `GET /account/{id}/followersnew?offset&limit=100`, journaled as `followers`
// through the [A20] trim (`captureFanslyFollowerPayload`), exactly as the
// legacy streams journal it.
//
// head (planned poll, hourly): the newest follows down to the one the last
// walk saw (`knownFollowId`), one page per step. It reuses the follower count
// `account.poll` wrote within 2 h instead of reading `/account/me` again
// (24 requests a day per page less); a staler count makes `account.poll` due
// and waits. On completion: the follower rollups, `last_follower_sync_at`,
// the new known follow, and the reconcile decision — a requested reconcile
// becomes `followers.reconcile` demand.
//
// reconcile (planned goal): at most one full walk a day (owner floor #330,
// `FOLLOWERS_RECONCILE_MIN_INTERVAL_MS`; an owner demand bypasses it). Steps:
// `/account/me` (the count the walk starts from), every page from offset 0 to
// a short one stamping the walk's generation, then a terminal `/account/me`
// whose apply proves the membership and only then deactivates the unseen
// follows (two-generation grace). A walk it cannot certify restarts after
// 15 min, at most twice, then closes without retiring anything; a
// deactivation past the safety ceiling, an empty first page against known
// followers, or rows that map to no fan quarantine the step for the owner.
//
// Presence ("active now") is read from the served page before its trim; a
// re-apply from the journal has no `lastSeenAt` and writes no presence (D8).

export type FollowersVariant = "head" | "reconcile";

/** The demand reason that bypasses the floor (owner CLI / reset). */
export const OWNER_DEMAND_REASON = "owner";

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseShadow(value: unknown): ShadowWalkProgress | null {
  const record = recordOf(value);
  const steps = count(record.steps);
  const done = count(record.done);
  return steps === null || done === null ? null : { steps, done };
}

function followersRequest(accountId: string, offset: number): RequestPlan<"followers.page"> {
  return { spec: "followers.page", params: { accountId, offset } };
}

/** Wait for a fresh `/account/me`: the page's own `account.poll` becomes due. */
function waitForAccount(key: string): StepPlan {
  const enqueue: DemandSignal[] = [{ resource: "account.poll", demand: { reason: `dependency:${key}` } }];
  return { kind: "wait", reason: "dependency", until: null, enqueue };
}

/** What one followers page writes, before its rows are filtered by a walk. */
interface HydratedPage {
  followers: FanslyFollower[];
  fanMap: Map<string, number>;
  presence: UpsertFanPageExternalPresenceInput[];
  followups: DemandSignal[];
}

/**
 * The fans of one served followers page: accounts from the page's own
 * aggregation data; a follower served without one is ensured unverified and
 * its profile asked of the lookup walk. Presence from the served object
 * (untrimmed only right after the capture). Rows that map to no fan refuse
 * the page (legacy: the walk blocked).
 */
async function hydrateFollowersPage(
  tx: Database,
  input: { pageId: number; page: FanslyFollowersPage; served: unknown; now: Date; key: string; refusal: string },
): Promise<HydratedPage> {
  const followers = input.page.followers;
  const accounts: FanslyAccount[] = (input.page.aggregationData?.accounts ?? []).filter((account) => account.id);
  const withAccount = new Set(accounts.map((account) => account.id));
  const sourceFollowerIds = uniqueFollowerIds(followers);
  const missing = sourceFollowerIds.filter((id) => !withAccount.has(id));
  const lookup = await partitionLookupIds(tx, { pageId: input.pageId, ids: missing, now: input.now });
  const fanMap = await upsertHydratedFansForPage(tx, {
    platformAccountId: input.pageId,
    accounts,
    unverifiedIds: lookup.due,
    reusedIds: lookup.fresh,
  });
  const unmapped = findUnmappedFollowerIds(sourceFollowerIds, fanMap);
  if (unmapped.length > 0) {
    throw new ApplyQuarantine(input.refusal, { unmappedFollowerCount: unmapped.length, examples: unmapped.slice(0, 5) });
  }
  const served = recordOf(input.served);
  const servedFollowers = Array.isArray(served.followers) ? served.followers as FanslyFollower[] : [];
  const servedAccounts = recordOf(served.aggregationData).accounts;
  const signals = buildFanslyFollowerPresenceSignals({
    followers: servedFollowers,
    accounts: Array.isArray(servedAccounts) ? servedAccounts as FanslyAccount[] : [],
    observedAt: input.now,
    now: input.now,
  });
  const presence: UpsertFanPageExternalPresenceInput[] = [];
  for (const signal of signals) {
    const fanId = fanMap.get(signal.platformUserId);
    if (!fanId) continue;
    presence.push({
      fanId,
      platformAccountId: input.pageId,
      externalPresenceAt: signal.lastSeenAt,
      externalPresenceObservedAt: signal.observedAt,
      externalPresenceSource: signal.source,
    });
  }
  return { followers, fanMap, presence, followups: lookupFollowups(lookup.due, input.key) };
}

async function writeFollowRows(
  tx: Database,
  rows: { follows: UpsertPageFollowInput[]; fanPages: UpsertFanPageInput[]; presence: UpsertFanPageExternalPresenceInput[] },
) {
  await upsertPageFollows(tx, rows.follows);
  await upsertFanPages(tx, rows.fanPages);
  await upsertFanPageExternalPresences(tx, rows.presence);
}

function followRow(pageId: number, fanId: number, follower: FanslyFollower, generation?: number) {
  const followedAt = fanslyFollowIdToDate(follower.id);
  return {
    follow: {
      platformAccountId: pageId,
      fanId,
      platformFollowId: follower.id,
      followedAt,
      ...(generation === undefined ? {} : { lastSeenGeneration: generation }),
    } satisfies UpsertPageFollowInput,
    fanPage: { fanId, platformAccountId: pageId, isFollower: true, followerSince: followedAt } satisfies UpsertFanPageInput,
  };
}

function requestedOffset(request: RequestPlan): number | null {
  return count(recordOf(request.params).offset);
}

/**
 * Replay of a legacy `followers` observation (design §5.12): the new contract
 * accepts the journaled page, and every follow it served is stored for the
 * page and was active when the page was captured (still active, or retired
 * after it). A body legacy refused is journaled trimmed inside a wrapper and
 * cannot be re-read.
 */
async function replayFollowersPage(observation: ReplayObservation, ctx: ReplayContext): Promise<ReplayVerdict> {
  if (recordOf(observation.payload).contractAccepted === false) {
    return { kind: "not_replayable", reason: "legacy_refused_body_trimmed" };
  }
  const page = parseFanslyFollowersPage(observation.payload);
  if (page === null) return { kind: "mismatch", reason: "contract_refused" };
  const ids = [...new Set(page.followers.map((follower) => follower.id))];
  if (ids.length === 0) return { kind: "match", detail: { served: 0 } };
  const stored = await ctx.db.execute<{ id: string; active: boolean; lastSeenAt: Date | string }>(sql`
    select platform_follow_id as id, is_active as active, last_seen_at as "lastSeenAt"
      from page_follows
     where platform_account_id = ${ctx.pageId}
       and platform_follow_id = any(${sql.param(ids)}::text[])
  `);
  const byId = new Map(stored.rows.map((row) => [row.id, row] as const));
  const mismatched = ids.filter((id) => {
    const row = byId.get(id);
    if (row === undefined) return true;
    return !row.active && new Date(row.lastSeenAt).getTime() < observation.receivedAt.getTime();
  });
  return mismatched.length === 0
    ? { kind: "match", detail: { served: ids.length } }
    : { kind: "mismatch", reason: "follows_differ", detail: { served: ids.length, mismatched: mismatched.length, examples: mismatched.slice(0, 5) } };
}

// ── head ────────────────────────────────────────────────────────────────────

interface HeadWalk {
  newestFollowId: string | null;
  offset: number;
  pageCount: number;
  /** `pages.follower_count` at the walk's start; null when `/account/me`
   *  omitted the count (the rollup then states no total for today). */
  sourceFollowerCount: number | null;
  sawKnownCheckpoint: boolean;
  crossedKnownBoundary: boolean;
  processed: number;
}

export interface FollowersHeadCursor {
  knownFollowId: string | null;
  walk: HeadWalk | null;
  last: Record<string, unknown> | null;
  shadow: ShadowWalkProgress | null;
}

export function parseFollowersHeadCursor(value: unknown): FollowersHeadCursor {
  const record = recordOf(value);
  const walkRecord = recordOf(record.walk);
  const offset = count(walkRecord.offset);
  const walk: HeadWalk | null = offset === null ? null : {
    newestFollowId: text(walkRecord.newestFollowId),
    offset,
    pageCount: count(walkRecord.pageCount) ?? 0,
    sourceFollowerCount: count(walkRecord.sourceFollowerCount),
    sawKnownCheckpoint: walkRecord.sawKnownCheckpoint === true,
    crossedKnownBoundary: walkRecord.crossedKnownBoundary === true,
    processed: count(walkRecord.processed) ?? 0,
  };
  return {
    knownFollowId: text(record.knownFollowId),
    walk,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: parseShadow(record.shadow),
  };
}

const HEAD_KEY = "followers.head";
const RECONCILE_KEY = "followers.reconcile";

export const followersHeadModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseFollowersHeadCursor(work.cursor);
    const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
    if (facts === null) return { kind: "quarantine", reason: "page_missing" };
    if (facts.externalId === null) return waitForPageIdentity(HEAD_KEY, ctx.shadow, ctx.now);
    // A new walk's count is the one `account.poll` wrote; it must be fresh.
    if (cursor.walk === null &&
      !accountCountersFresh(await accountCountersReadAt(ctx.db, { facts, shadow: ctx.shadow }), ctx.now)) {
      return waitForAccount(HEAD_KEY);
    }
    const offset = cursor.walk?.offset ?? (ctx.shadow ? (cursor.shadow?.done ?? 0) * FANSLY_FOLLOWERS_PAGE_LIMIT : 0);
    return { kind: "request", request: followersRequest(facts.externalId, offset) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const pageId = input.pageId;
    const now = input.now;
    const cursor = parseFollowersHeadCursor(input.work.cursor);
    const page = input.parsed as FanslyFollowersPage;
    let walk: HeadWalk = cursor.walk ?? {
      newestFollowId: null,
      offset: 0,
      pageCount: 0,
      sourceFollowerCount: (await readFanslyPageFacts(tx, pageId))?.followerCount ?? null,
      sawKnownCheckpoint: false,
      crossedKnownBoundary: false,
      processed: 0,
    };
    if (requestedOffset(input.request) !== walk.offset) {
      throw new ApplyQuarantine("followers_head_cursor_mismatch", { requestedOffset: requestedOffset(input.request), walkOffset: walk.offset });
    }
    walk = { ...walk, pageCount: walk.pageCount + 1, newestFollowId: walk.newestFollowId ?? page.followers[0]?.id ?? null };
    const newestFollowId = walk.newestFollowId ?? cursor.knownFollowId;
    const pageDone = page.followers.length < FANSLY_FOLLOWERS_PAGE_LIMIT;
    const hydrated = await hydrateFollowersPage(tx, {
      pageId,
      page,
      served: input.response,
      now,
      key: HEAD_KEY,
      refusal: "followers_unmapped_rows",
    });

    const follows: UpsertPageFollowInput[] = [];
    const fanPages: UpsertFanPageInput[] = [];
    let sawKnown = false;
    let crossedBoundary = false;
    for (const follower of hydrated.followers) {
      if (cursor.knownFollowId !== null && follower.id === cursor.knownFollowId) {
        sawKnown = true;
        break;
      }
      // Rows descend by follow id and every follow, a re-follow too, gets a
      // new larger id. A row older than the known one means that row is gone
      // and the rest of the list predates the last walk; the reconcile owns
      // it. Skip rather than stop, so a newer row out of order still lands.
      if (cursor.knownFollowId !== null && compareFanslyFollowIds(follower.id, cursor.knownFollowId) === -1) {
        crossedBoundary = true;
        continue;
      }
      const fanId = hydrated.fanMap.get(follower.followerId);
      if (!fanId) continue;
      const row = followRow(pageId, fanId, follower);
      follows.push(row.follow);
      fanPages.push(row.fanPage);
    }
    await writeFollowRows(tx, { follows, fanPages, presence: hydrated.presence });
    walk = {
      ...walk,
      sawKnownCheckpoint: walk.sawKnownCheckpoint || sawKnown,
      crossedKnownBoundary: walk.crossedKnownBoundary || crossedBoundary,
      processed: walk.processed + follows.length,
    };

    if (!(sawKnown || crossedBoundary || pageDone)) {
      walk = { ...walk, offset: walk.offset + FANSLY_FOLLOWERS_PAGE_LIMIT };
      return {
        work: { satisfiesRevision: false, nextDueAt: now, cursor: { ...cursor, walk, shadow: null } },
        followups: hydrated.followups,
      };
    }

    await rebuildFollowerRollups(tx, pageId, walk.sourceFollowerCount);
    await updatePageSyncTimestampCache(tx, { pageId, syncType: "followers", now });
    const activeFollowerCount = Number(await countActivePageFollows(tx, pageId));
    const decision = followersReconcileDecision({
      activeFollowerCount,
      // An unknown count proves no mismatch (the shadow head judges alike).
      sourceFollowerCount: walk.sourceFollowerCount ?? activeFollowerCount,
      knownFollowId: cursor.knownFollowId,
      newestFollowId,
      pageDone,
      crossedKnownBoundary: walk.crossedKnownBoundary,
      sawKnownCheckpoint: walk.sawKnownCheckpoint,
      processedThisChunk: walk.processed,
    });
    const receipt = {
      completedAt: now.toISOString(),
      pageCount: walk.pageCount,
      processed: walk.processed,
      sourceFollowerCount: walk.sourceFollowerCount,
      activeFollowerCount,
      knownFollowId: cursor.knownFollowId,
      newestFollowId,
      reconcile: decision,
    };
    const followups = [...hydrated.followups];
    if (decision.requested) followups.push({ resource: RECONCILE_KEY, demand: { reason: "head_decision" } });
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "head_walked",
        cursor: { knownFollowId: newestFollowId, walk: null, last: receipt, shadow: null },
        proof: receipt,
      },
      followups,
    };
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    const cursor = parseFollowersHeadCursor(work.cursor);
    // The head of an hourly walk is one page in steady state (design §5.12).
    const step = advanceShadowWalk(cursor.shadow, () => 1);
    if (!step.finished) {
      return { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [] };
    }
    // The decision's count branch, as live would take it: the stored active
    // follows against the count `account.poll` keeps (the floor then holds
    // the walk to one a day).
    const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
    const active = Number(await countActivePageFollows(ctx.db, ctx.pageId));
    const followups: DemandSignal[] = facts?.followerCount !== null && facts?.followerCount !== undefined && facts.followerCount !== active
      ? [{ resource: RECONCILE_KEY, demand: { reason: "head_decision" } }]
      : [];
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups };
  },

  replay: replayFollowersPage,

  async importLegacy(tx, page): Promise<LegacyImport> {
    // Mandatory (design §5.12): without the known follow the first head walk
    // reads the whole list (≤ 184 pages on lilly-2).
    const legacy = await tx.execute<{ cursorText: string | null }>(sql`
      select cursor_text as "cursorText" from page_sync_cursors where page_id = ${page.pageId} and stream = 'followers'
    `);
    let knownFollowId = text(legacy.rows[0]?.cursorText);
    let source = "page_sync_cursors.followers";
    if (knownFollowId === null) {
      const newest = await tx.execute<{ id: string }>(sql`
        select platform_follow_id as id from page_follows
         where platform_account_id = ${page.pageId}
         order by followed_at desc, length(platform_follow_id) desc, platform_follow_id desc
         limit 1
      `);
      knownFollowId = text(newest.rows[0]?.id);
      source = knownFollowId === null ? "none" : "page_follows.newest";
    }
    const cursor: FollowersHeadCursor = { knownFollowId, walk: null, last: null, shadow: null };
    return { cursors: [{ resource: HEAD_KEY, subject: "", cursor }], notes: { knownFollowId: source } };
  },
};

// ── reconcile ───────────────────────────────────────────────────────────────

interface ReconcileWalk {
  generation: number;
  /** ISO: the admission of the walk's first `/account/me`. */
  fullSweepStartedAt: string;
  offset: number;
  observedCount: number;
  pageCount: number;
  sourceFollowerCount: number;
  verificationPending: boolean;
}

export interface FollowersReconcileCursor {
  /** The newest generation a walk of the page used. */
  generation: number;
  walk: ReconcileWalk | null;
  snapshotRestartCount: number;
  /** ISO: the start of the newest walk (the owner floor's anchor). */
  lastFullSweepStartedAt: string | null;
  last: Record<string, unknown> | null;
  /** Shadow: the simulated walk and when it began. */
  shadow: (ShadowWalkProgress & { startedAt: string }) | null;
}

export function parseFollowersReconcileCursor(value: unknown): FollowersReconcileCursor {
  const record = recordOf(value);
  const walkRecord = recordOf(record.walk);
  const generation = count(walkRecord.generation);
  const fullSweepStartedAt = text(walkRecord.fullSweepStartedAt);
  const walk: ReconcileWalk | null = generation === null || fullSweepStartedAt === null ? null : {
    generation,
    fullSweepStartedAt,
    offset: count(walkRecord.offset) ?? 0,
    observedCount: count(walkRecord.observedCount) ?? 0,
    pageCount: count(walkRecord.pageCount) ?? 0,
    sourceFollowerCount: count(walkRecord.sourceFollowerCount) ?? 0,
    verificationPending: walkRecord.verificationPending === true,
  };
  const shadow = parseShadow(record.shadow);
  const shadowStartedAt = text(recordOf(record.shadow).startedAt);
  return {
    generation: count(record.generation) ?? 0,
    walk,
    snapshotRestartCount: count(record.snapshotRestartCount) ?? 0,
    lastFullSweepStartedAt: text(record.lastFullSweepStartedAt),
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
    shadow: shadow === null || shadowStartedAt === null ? null : { ...shadow, startedAt: shadowStartedAt },
  };
}

/** The legacy reconcile's anchor: its last walk start, else its last success. */
async function legacyReconcileAnchor(db: Database, pageId: number): Promise<Date | null> {
  const result = await db.execute<{ startedAt: string | null; succeededAt: Date | string | null }>(sql`
    select state ->> 'fullSweepStartedAt' as "startedAt", last_succeeded_at as "succeededAt"
      from page_sync_cursors
     where page_id = ${pageId} and stream = 'followers_reconcile'
  `);
  const row = result.rows[0];
  const raw = row?.startedAt ?? row?.succeededAt ?? null;
  if (raw === null) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The start of the page's newest reconcile walk: this row's, the previous
 *  closed row's, else the legacy engine's. */
async function reconcileAnchor(
  db: Database,
  input: { pageId: number; shadow: boolean; cursor: FollowersReconcileCursor },
): Promise<Date | null> {
  const own = input.cursor.lastFullSweepStartedAt;
  if (own !== null) return new Date(own);
  const previous = await latestClosedWorkForKey(db, { pageId: input.pageId, shadow: input.shadow, resource: RECONCILE_KEY, subject: "" });
  const previousAt = previous === null ? null : parseFollowersReconcileCursor(previous.cursor).lastFullSweepStartedAt;
  if (previousAt !== null) return new Date(previousAt);
  return legacyReconcileAnchor(db, input.pageId);
}

/** Which request the reconcile's next step is (live: by its walk; shadow: by
 *  the simulated step). */
function reconcilePhase(cursor: FollowersReconcileCursor, shadow: boolean): { kind: "start" | "verify" } | { kind: "page"; offset: number } {
  if (shadow) {
    const progress = cursor.shadow;
    if (progress === null || progress.done === 0) return { kind: "start" };
    if (progress.done >= progress.steps - 1) return { kind: "verify" };
    return { kind: "page", offset: (progress.done - 1) * FANSLY_FOLLOWERS_PAGE_LIMIT };
  }
  if (cursor.walk === null) return { kind: "start" };
  return cursor.walk.verificationPending ? { kind: "verify" } : { kind: "page", offset: cursor.walk.offset };
}

function restartedCursor(cursor: FollowersReconcileCursor, walk: ReconcileWalk): FollowersReconcileCursor {
  return {
    ...cursor,
    generation: walk.generation,
    walk: null,
    snapshotRestartCount: cursor.snapshotRestartCount + 1,
    shadow: null,
  };
}

function finishedCursor(cursor: FollowersReconcileCursor, walk: ReconcileWalk, receipt: Record<string, unknown>): FollowersReconcileCursor {
  return {
    generation: walk.generation,
    walk: null,
    snapshotRestartCount: 0,
    lastFullSweepStartedAt: walk.fullSweepStartedAt,
    last: receipt,
    shadow: null,
  };
}

/**
 * The cursor a quarantined walk leaves once the owner's blast-radius override
 * (design step 3 §3.2 item 4) retired its unseen follows: the walk finished,
 * its start the owner floor's anchor, the override's receipt as the last
 * outcome. Null when the cursor holds no walk.
 */
export function followersReconcileCursorAfterOverride(
  cursorValue: unknown,
  receipt: Record<string, unknown>,
): FollowersReconcileCursor | null {
  const cursor = parseFollowersReconcileCursor(cursorValue);
  return cursor.walk === null ? null : finishedCursor(cursor, cursor.walk, receipt);
}

async function applyReconcileStart(
  tx: Database,
  input: ApplyInput,
  cursor: FollowersReconcileCursor,
): Promise<ApplyResult> {
  const account = (input.parsed as FanslyAccountMe).account;
  const facts = await applyAccountMeToPage(tx, { pageId: input.pageId, account });
  const stored = Number(await maxPageFollowGeneration(tx, input.pageId));
  const walk: ReconcileWalk = {
    generation: Math.max(cursor.generation, stored) + 1,
    fullSweepStartedAt: input.attempt.admittedAt.toISOString(),
    offset: 0,
    observedCount: 0,
    pageCount: 0,
    sourceFollowerCount: facts.followCount ?? 0,
    verificationPending: false,
  };
  return {
    work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, generation: walk.generation, walk, shadow: null } },
    followups: [],
    pageIdentity: { accountId: facts.accountId },
  };
}

async function applyReconcilePage(
  tx: Database,
  input: ApplyInput,
  cursor: FollowersReconcileCursor,
  walk: ReconcileWalk,
): Promise<ApplyResult> {
  const pageId = input.pageId;
  const page = input.parsed as FanslyFollowersPage;
  if (requestedOffset(input.request) !== walk.offset || walk.verificationPending) {
    throw new ApplyQuarantine("followers_reconcile_cursor_mismatch", { requestedOffset: requestedOffset(input.request), walkOffset: walk.offset });
  }
  if (walk.offset === 0 && page.followers.length === 0 && walk.sourceFollowerCount > 0) {
    const existingActiveFollowers = Number(await countActivePageFollows(tx, pageId));
    if (existingActiveFollowers > 0) {
      throw new ApplyQuarantine("followers_reconcile_empty_first_page", {
        sourceFollowerCount: walk.sourceFollowerCount,
        existingActiveFollowers,
      });
    }
  }
  const hydrated = await hydrateFollowersPage(tx, {
    pageId,
    page,
    served: input.response,
    now: input.now,
    key: RECONCILE_KEY,
    refusal: "followers_reconcile_unmapped_rows",
  });
  const follows: UpsertPageFollowInput[] = [];
  const fanPages: UpsertFanPageInput[] = [];
  for (const follower of hydrated.followers) {
    const fanId = hydrated.fanMap.get(follower.followerId);
    if (!fanId) continue;
    const row = followRow(pageId, fanId, follower, walk.generation);
    follows.push(row.follow);
    fanPages.push(row.fanPage);
  }
  await writeFollowRows(tx, { follows, fanPages, presence: hydrated.presence });
  const pageDone = page.followers.length < FANSLY_FOLLOWERS_PAGE_LIMIT;
  const next: ReconcileWalk = pageDone
    ? { ...walk, pageCount: walk.pageCount + 1, observedCount: walk.observedCount + page.followers.length, verificationPending: true }
    : {
      ...walk,
      pageCount: walk.pageCount + 1,
      observedCount: walk.observedCount + page.followers.length,
      offset: walk.offset + FANSLY_FOLLOWERS_PAGE_LIMIT,
    };
  return {
    work: { satisfiesRevision: false, nextDueAt: input.now, cursor: { ...cursor, walk: next, shadow: null } },
    followups: hydrated.followups,
  };
}

/**
 * The terminal `/account/me` and the membership proof (legacy
 * `verifyPendingGeneration`): the generation the walk stamped must reproduce
 * the count Fansly states now, exactly or explained by follows first seen
 * during the walk. Only then are the unseen follows retired — and never more
 * than the safety ceiling.
 */
async function applyReconcileVerify(
  tx: Database,
  input: ApplyInput,
  cursor: FollowersReconcileCursor,
  walk: ReconcileWalk,
): Promise<ApplyResult> {
  const pageId = input.pageId;
  const account = (input.parsed as FanslyAccountMe).account;
  const facts = await applyAccountMeToPage(tx, { pageId, account });
  const pageIdentity = { accountId: facts.accountId };
  const finalizationFollowerCount = facts.followCount;
  const fullSweepStartedAt = new Date(walk.fullSweepStartedAt);
  const generationObservedCount = Number(await countPageFollowsByGeneration(tx, { platformAccountId: pageId, generation: walk.generation }));
  const activity = await readPageFollowReconcileActivity(tx, { platformAccountId: pageId, generation: walk.generation, fullSweepStartedAt });
  const expectedTerminalPageCount = expectedFollowersReconcileTerminalPageCount(walk.observedCount);
  const terminalPageShapeComplete = walk.pageCount === expectedTerminalPageCount;
  const terminalDelta = finalizationFollowerCount === null ? null : finalizationFollowerCount - generationObservedCount;
  const explainedByNewFollowers = terminalDelta !== null && terminalDelta > 0
    && terminalPageShapeComplete
    && walk.observedCount >= generationObservedCount
    && terminalDelta === activity.firstSeenDuringSweepOutsideGeneration;
  const membershipProof = finalizationFollowerCount !== null && generationObservedCount === finalizationFollowerCount
    ? "exact_generation" as const
    : explainedByNewFollowers ? "new_followers_seen_during_sweep" as const : null;
  const evidence = {
    generation: walk.generation,
    fullSweepStartedAt: walk.fullSweepStartedAt,
    startingSourceFollowerCount: walk.sourceFollowerCount,
    sourceFollowerCount: finalizationFollowerCount,
    observedCount: walk.observedCount,
    pageCount: walk.pageCount,
    generationObservedCount,
    expectedTerminalPageCount,
    terminalPageShapeComplete,
    terminalDelta,
    snapshotRestartCount: cursor.snapshotRestartCount,
    ...activity,
  };

  if (membershipProof === null) {
    if (cursor.snapshotRestartCount < FOLLOWERS_RECONCILE_MAX_SNAPSHOT_RESTARTS) {
      return {
        work: {
          satisfiesRevision: false,
          nextDueAt: new Date(input.now.getTime() + FOLLOWERS_RECONCILE_RETRY_DELAY_MS),
          waitingReason: "not_due",
          cursor: restartedCursor(cursor, walk),
          result: { outcome: "restart", ...evidence },
        },
        followups: [],
        pageIdentity,
        counters: { reconcile_restart: 1 },
      };
    }
    await rebuildFollowerRollups(tx, pageId, finalizationFollowerCount);
    const receipt = { outcome: "non_destructive_complete", membershipCertified: false, destructiveFinalization: false, ...evidence };
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "reconcile_withheld", cursor: finishedCursor(cursor, walk, receipt), proof: receipt },
      followups: [],
      pageIdentity,
      counters: { reconcile_withheld: 1 },
    };
  }

  const deactivationLimit = followersReconcileDeactivationLimit(activity.activeFollowerCount);
  if (activity.deactivationCandidateCount > deactivationLimit) {
    const candidateGenerationBuckets = await readPageFollowDeactivationGenerationBuckets(tx, {
      platformAccountId: pageId,
      generation: walk.generation,
      fullSweepStartedAt,
    });
    throw new ApplyQuarantine("followers_reconcile_deactivation_blast_radius", {
      membershipProof,
      deactivationLimit,
      candidateGenerationBuckets,
      ...evidence,
    });
  }
  const deactivated = await deactivatePageFollowsByGeneration(tx, {
    platformAccountId: pageId,
    generation: walk.generation,
    lastSeenBefore: fullSweepStartedAt,
  });
  await refreshFanPageFollowerState(tx, pageId);
  await rebuildFollowerRollups(tx, pageId, finalizationFollowerCount);
  await updatePageSyncTimestampCache(tx, { pageId, syncType: "followers", now: input.now });
  const receipt = {
    outcome: "complete",
    membershipProof,
    destructiveFinalization: true,
    deactivationLimit,
    deactivatedCount: deactivated.length,
    ...evidence,
  };
  return {
    work: { satisfiesRevision: true, close: "done", closeReason: "reconcile_certified", cursor: finishedCursor(cursor, walk, receipt), proof: receipt },
    followups: [],
    pageIdentity,
  };
}

/** The steps of a reconcile walk: the start and terminal `/account/me` and
 *  every followers page to the short one, over the page's follower count
 *  (the shadow's estimate at a walk's start, and the shadow report's assumed
 *  run size, rule A1.rate-assumed). */
async function reconcileWalkSteps(db: Database, pageId: number): Promise<number> {
  const facts = await readFanslyPageFacts(db, pageId);
  return offsetWalkPages({ total: facts?.followerCount ?? null, limit: FANSLY_FOLLOWERS_PAGE_LIMIT, statedTotal: false }) + 2;
}

export const followersReconcileModule: ResourceModule = {
  async estimateRunSteps(_work, ctx): Promise<number> {
    return reconcileWalkSteps(ctx.db, ctx.pageId);
  },

  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseFollowersReconcileCursor(work.cursor);
    const phase = reconcilePhase(cursor, ctx.shadow);
    const starting = ctx.shadow ? cursor.shadow === null : cursor.walk === null;
    // The owner floor holds a fresh walk, never a restart of the same one,
    // never the owner's own demand.
    if (starting && cursor.snapshotRestartCount === 0 && !work.demand.reasons.includes(OWNER_DEMAND_REASON)) {
      const anchor = await reconcileAnchor(ctx.db, { pageId: ctx.pageId, shadow: ctx.shadow, cursor });
      if (anchor !== null) {
        const until = new Date(anchor.getTime() + FOLLOWERS_RECONCILE_MIN_INTERVAL_MS);
        if (until.getTime() > ctx.now.getTime()) return { kind: "wait", reason: "not_due", until };
      }
    }
    if (phase.kind !== "page") return { kind: "request", request: ACCOUNT_ME_REQUEST };
    const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
    if (facts === null) return { kind: "quarantine", reason: "page_missing" };
    if (facts.externalId === null) return waitForPageIdentity(RECONCILE_KEY, ctx.shadow, ctx.now);
    return { kind: "request", request: followersRequest(facts.externalId, phase.offset) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const cursor = parseFollowersReconcileCursor(input.work.cursor);
    const walk = cursor.walk;
    if (input.request.spec === "followers.page") {
      if (walk === null) throw new ApplyQuarantine("followers_reconcile_page_without_walk");
      return applyReconcilePage(tx, input, cursor, walk);
    }
    if (walk === null) return applyReconcileStart(tx, input, cursor);
    if (!walk.verificationPending) {
      throw new ApplyQuarantine("followers_reconcile_unexpected_account_read", { offset: walk.offset });
    }
    return applyReconcileVerify(tx, input, cursor, walk);
  },

  async shadow(work, _request, ctx): Promise<ShadowResult> {
    const cursor = parseFollowersReconcileCursor(work.cursor);
    const startedAt = cursor.shadow?.startedAt ?? ctx.now.toISOString();
    const steps = cursor.shadow === null ? await reconcileWalkSteps(ctx.db, ctx.pageId) : cursor.shadow.steps;
    const step = advanceShadowWalk(cursor.shadow, () => steps);
    if (!step.finished) {
      return {
        work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: { ...step.progress, startedAt } } },
        followups: [],
      };
    }
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "shadow",
        cursor: { ...cursor, shadow: null, snapshotRestartCount: 0, lastFullSweepStartedAt: startedAt },
      },
      followups: [],
    };
  },

  replay: replayFollowersPage,

  async importLegacy(tx, page): Promise<LegacyImport> {
    const anchor = await legacyReconcileAnchor(tx, page.pageId);
    const cursor: FollowersReconcileCursor = {
      generation: Number(await maxPageFollowGeneration(tx, page.pageId)),
      walk: null,
      snapshotRestartCount: 0,
      lastFullSweepStartedAt: anchor?.toISOString() ?? null,
      last: null,
      shadow: null,
    };
    return {
      cursors: [{ resource: RECONCILE_KEY, subject: "", cursor }],
      notes: { lastFullSweepStartedAt: anchor === null ? "none" : "page_sync_cursors.followers_reconcile" },
    };
  },
};

export function followersModule(variant: FollowersVariant): ResourceModule {
  return variant === "head" ? followersHeadModule : followersReconcileModule;
}

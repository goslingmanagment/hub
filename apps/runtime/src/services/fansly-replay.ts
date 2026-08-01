// Fansly replay runner (agent read plane, slice D).
//
// One owner-run command that turns four years-old-but-never-parsed Fansly pull
// kinds into facts, and then into read planes. It costs zero vendor credits:
// every byte it reads was already journaled at capture time.
//
// ORDER OF OPERATIONS — the first step is the one that matters.
//
//   0. Gate on `fanslyReplayMode` (effective config, so a dashboard flip
//      applies without a restart). `off` = inert, returns before touching
//      anything.
//   1. PREFLIGHT. Refuse outright when any partition of the journal covering
//      the replay window is DETACHED. Rows in a parked partition still exist
//      but are invisible to the reader; canonicalizing across that hole and
//      then publishing "captured from <date>" mints a floor that is a lie
//      about which months were ever captured. Nothing is written on refusal.
//   2. Floors BEFORE.
//   3. Canonicalize (append domain events) — `shadow` runs this as a dry run:
//      counts drafts, appends nothing, stamps nothing.
//   4. Project (`on` only): events → fans / page_fans / page_follows, then the
//      audience rollups.
//   5. Floors AFTER.
//
// Resumable and idempotent by construction: step 3 stamps `parse_version`
// forward-only and dedupes on `domain_event_keys`, step 4 rides a projection
// watermark, and every projection write is an additive upsert. A second run
// over the same journal appends zero events and changes no row.

import {
  getFanslyReplayEligibleSpan,
  getFanslyReplayFloors,
  getProjectionWatermark,
  listDetachedJournalPartitions,
  listEventsSince,
  listPageNativeAccountRefs,
  setProjectionWatermark,
  applyFanslyReplayEvents,
  refreshFanslyReplayAudienceRollups,
  FANSLY_REPLAY_PROJECTION,
  type DetachedJournalPartition,
  type FanslyReplayFloors,
  type FanslyReplayFollowInput,
  type FanslyReplayIdentityInput,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  FANSLY_REPLAY_CANONICALIZED_KINDS,
  FANSLY_REPLAY_CANONICALIZER_VERSION,
  FANSLY_REPLAY_EVENT_TYPES,
  FANSLY_REPLAY_FAMILY,
} from "./canonicalize/fansly-replay.ts";
import { runCanonicalization, type CanonicalizationRunResult } from "./canonicalize-driver.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

export type FanslyReplayMode = "off" | "shadow" | "on";

/** Pages this family can serve, as a membership set rather than an equality
 *  branch on the platform column (Stage 18 ratchet). */
const FANSLY_REPLAY_PLATFORMS: ReadonlySet<string> = new Set(["fansly"]);

const EVENT_PAGE_SIZE = 500;

export interface FanslyReplayOptions {
  /** Restrict to one page (internal id); default = every Fansly page. */
  accountId?: number | null;
  /** received_at window, matching the observations partition key. */
  from?: Date | null;
  to?: Date | null;
  /** Narrow the replayed kinds; default = all four. */
  kinds?: readonly string[];
  pageSize?: number;
  maxPages?: number;
  /** Resume a bounded run after this observation id (see report.coverage). */
  afterId?: number | null;
}

export interface FanslyReplayProjectionResult {
  accounts: number;
  eventsSeen: number;
  fansTouched: number;
  followsInserted: number;
  followerDaysTouched: number;
  knownTotalDaysTouched: number;
}

export interface FanslyReplayReport {
  mode: FanslyReplayMode;
  /** True only when the preflight found detached journal partitions. */
  refused: boolean;
  preflight: {
    ok: boolean;
    window: { from: string | null; to: string | null };
    /** `occurred_at` range this run would write into; null when nothing is
     *  eligible. Scopes the domain_events arm of the census. */
    writeRange: { from: string | null; to: string | null };
    detachedPartitions: DetachedJournalPartition[];
  };
  kinds: readonly string[];
  accountIds: number[];
  /**
   * What this bounded run actually looked at. A dry run stamps nothing and so
   * cannot advance on its own; without this an operator repeating the default
   * shadow invocation would re-examine the same prefix forever and never learn
   * that the corpus is larger than the bound. `nextAfterId` is the exact
   * continuation cursor — feed it back as `--after-id`.
   */
  coverage: {
    eligibleTotal: number;
    examined: number;
    remaining: number;
    complete: boolean;
    nextAfterId: number | null;
  };
  /** Counts-only parser diagnostics (e.g. refused vendor timestamps). A
   *  systematic decode failure must not read as a clean run. */
  parserDiagnostics: Record<string, number>;
  canonicalize: CanonicalizationRunResult | null;
  projection: FanslyReplayProjectionResult | null;
  floors: {
    before: FanslyReplayFloors[];
    after: FanslyReplayFloors[];
  };
}

function emptyProjectionResult(): FanslyReplayProjectionResult {
  return {
    accounts: 0,
    eventsSeen: 0,
    fansTouched: 0,
    followsInserted: 0,
    followerDaysTouched: 0,
    knownTotalDaysTouched: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asOptionalDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Folds one batch of ledger events into the two projection inputs, deduped per
 * platform user so a single statement never hits the same conflict target
 * twice. `page_fans` is deliberately absent: a replay knows only about PAST
 * relationships and those columns describe the CURRENT one (see
 * applyFanslyReplayEvents).
 */
function foldEvents(events: readonly { type: string; occurredAt: Date; data: unknown }[]) {
  const identities = new Map<string, FanslyReplayIdentityInput>();
  const follows = new Map<string, FanslyReplayFollowInput>();

  const touchIdentity = (
    platformUserId: string,
    occurredAt: Date,
    profile?: { username: string | null; displayName: string | null; createdAtExternal: Date | null },
  ) => {
    const current = identities.get(platformUserId);
    if (current === undefined) {
      identities.set(platformUserId, {
        platformUserId,
        username: profile?.username ?? null,
        displayName: profile?.displayName ?? null,
        createdAtExternal: profile?.createdAtExternal ?? null,
        observedAt: occurredAt,
      });
      return;
    }
    identities.set(platformUserId, {
      platformUserId,
      username: current.username ?? profile?.username ?? null,
      displayName: current.displayName ?? profile?.displayName ?? null,
      createdAtExternal: current.createdAtExternal ?? profile?.createdAtExternal ?? null,
      observedAt: occurredAt < current.observedAt ? occurredAt : current.observedAt,
    });
  };

  for (const event of events) {
    const data = asRecord(event.data);
    const platformUserId = typeof data.platformUserId === "string" ? data.platformUserId : null;

    if (event.type === "fan.identity_observed" && platformUserId !== null) {
      // Instants arrive already interpreted (ISO or null) — the canonicalizer
      // owns the seconds-vs-milliseconds decision, this layer never repeats it.
      touchIdentity(platformUserId, event.occurredAt, {
        username: typeof data.username === "string" ? data.username : null,
        displayName: typeof data.displayName === "string" ? data.displayName : null,
        createdAtExternal: asOptionalDate(data.createdAtExternal),
      });
      continue;
    }

    if (event.type === "follow.observed" && platformUserId !== null) {
      const platformFollowId = typeof data.followId === "string" ? data.followId : null;
      // REFUSED, not defaulted. `followedAt` is null when the follow id did
      // not decode to a plausible Fansly moment; dating the row by the
      // observation instead would write a follow date we never observed, and
      // `page_follows.followed_at` is a floor that folds monotonically
      // earlier — a wrong value there is unrepairable. The fan's identity
      // still lands; only the dated row is withheld.
      const followedAt = asOptionalDate(data.followedAt);
      touchIdentity(platformUserId, event.occurredAt);
      if (platformFollowId !== null && followedAt !== null) {
        const current = follows.get(platformFollowId);
        if (current === undefined || event.occurredAt < current.observedAt) {
          follows.set(platformFollowId, {
            platformUserId,
            platformFollowId,
            followedAt,
            observedAt: event.occurredAt,
          });
        }
      }
      continue;
    }

    if (event.type === "subscription.observed" && platformUserId !== null) {
      // Identity only. The subscription INTERVAL stays in the ledger: writing
      // it into `page_fans.subscriber_since` would backdate a fan's current
      // membership with an ended historical one.
      touchIdentity(platformUserId, event.occurredAt);
      continue;
    }

    if (event.type === "conversation.observed") {
      const partner = typeof data.partnerPlatformUserId === "string"
        ? data.partnerPlatformUserId
        : null;
      if (partner !== null) {
        // A conversation proves the fan existed and reached this page, and
        // nothing about following or subscribing.
        touchIdentity(partner, event.occurredAt, {
          username: typeof data.partnerUsername === "string" ? data.partnerUsername : null,
          displayName: null,
          createdAtExternal: null,
        });
      }
      continue;
    }
  }

  return {
    identities: [...identities.values()],
    follows: [...follows.values()],
  };
}

/** Watermarked, resumable projection over the ledger for the given pages. */
export async function runFanslyReplayProjection(
  app: Pick<AppContext, "db" | "logger">,
  accountIds: readonly number[],
): Promise<FanslyReplayProjectionResult> {
  const totals = emptyProjectionResult();

  for (const accountId of accountIds) {
    totals.accounts += 1;
    let watermark = await getProjectionWatermark(app.db, FANSLY_REPLAY_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) {
        break;
      }
      const replayEvents = events.filter((event) => FANSLY_REPLAY_EVENT_TYPES.has(event.type));
      totals.eventsSeen += replayEvents.length;
      if (replayEvents.length > 0) {
        const folded = foldEvents(replayEvents);
        const applied = await applyFanslyReplayEvents(app.db, {
          platformAccountId: accountId,
          identities: folded.identities,
          follows: folded.follows,
        });
        totals.fansTouched += applied.fansTouched;
        totals.followsInserted += applied.followsInserted;
      }
      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, FANSLY_REPLAY_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }

    // UNCONDITIONAL, for every selected account, every run. The rollups are
    // re-derived from durable state, and the live hourly rebuild wipes the
    // historical values this slice writes — so gating on "did this run see new
    // events" would make the refresh happen exactly once and the advertised
    // floors evaporate at the next live rebuild. Same for a crash between the
    // watermark advance and the refresh: the next run repairs it.
    const rollups = await refreshFanslyReplayAudienceRollups(app.db, accountId);
    totals.followerDaysTouched += rollups.followerDaysTouched;
    totals.knownTotalDaysTouched += rollups.knownTotalDaysTouched;
  }

  return totals;
}

export async function runFanslyReplay(
  app: Pick<AppContext, "db" | "logger" | "config">,
  options: FanslyReplayOptions = {},
): Promise<FanslyReplayReport> {
  const effective = await loadEffectiveConfig(app.db, app.config);
  const mode: FanslyReplayMode = effective.fanslyReplayMode ?? "off";
  const kinds = options.kinds !== undefined && options.kinds.length > 0
    ? FANSLY_REPLAY_CANONICALIZED_KINDS.filter((kind) => options.kinds!.includes(kind))
    : FANSLY_REPLAY_CANONICALIZED_KINDS;
  const window = { from: options.from ?? null, to: options.to ?? null };
  const windowIso = {
    from: window.from === null ? null : window.from.toISOString(),
    to: window.to === null ? null : window.to.toISOString(),
  };

  const base: FanslyReplayReport = {
    mode,
    refused: false,
    preflight: {
      ok: true,
      window: windowIso,
      writeRange: { from: null, to: null },
      detachedPartitions: [],
    },
    kinds,
    accountIds: [],
    coverage: {
      eligibleTotal: 0,
      examined: 0,
      remaining: 0,
      complete: true,
      nextAfterId: null,
    },
    parserDiagnostics: {},
    canonicalize: null,
    projection: null,
    floors: { before: [], after: [] },
  };

  if (mode === "off") {
    return base;
  }

  const pages = await listPageNativeAccountRefs(app.db);
  const accountIds = pages
    .filter((page) => FANSLY_REPLAY_PLATFORMS.has(page.platform))
    .filter((page) => options.accountId == null || page.id === options.accountId)
    .map((page) => page.id)
    .sort((left, right) => left - right);

  // What this run is ELIGIBLE to consume, and therefore the exact
  // `occurred_at` range it can write into (events are stamped at observation
  // time). Both feed the preflight: a partition that cannot hold a row this
  // run reads or writes is not a violation.
  const eligible = await getFanslyReplayEligibleSpan(app.db, {
    belowParseVersion: FANSLY_REPLAY_CANONICALIZER_VERSION,
    source: FANSLY_REPLAY_FAMILY.source,
    kinds,
    accountIds,
    from: window.from,
    to: window.to,
    afterId: options.afterId ?? null,
  });
  const writeRangeIso = {
    from: eligible.writeFrom === null ? null : eligible.writeFrom.toISOString(),
    to: eligible.writeTo === null ? null : eligible.writeTo.toISOString(),
  };

  // Step 1 — the preflight, before any read of the journal and long before any
  // write. A detached month is not a warning here.
  const detachedPartitions = await listDetachedJournalPartitions(app.db, {
    from: window.from,
    to: window.to,
    accountIds,
    journalKinds: kinds,
    eventTypes: [...FANSLY_REPLAY_EVENT_TYPES],
    writeFrom: eligible.writeFrom,
    writeTo: eligible.writeTo,
  });
  if (detachedPartitions.length > 0) {
    app.logger.error(
      { detachedPartitions, window: windowIso, writeRange: writeRangeIso },
      "Fansly replay refused: detached journal partitions intersect this run",
    );
    return {
      ...base,
      accountIds,
      refused: true,
      preflight: {
        ok: false,
        window: windowIso,
        writeRange: writeRangeIso,
        detachedPartitions,
      },
    };
  }

  const floorsBefore: FanslyReplayFloors[] = [];
  for (const accountId of accountIds) {
    floorsBefore.push(await getFanslyReplayFloors(app.db, accountId, kinds));
  }

  const diagnosticCounts = new Map<string, number>();
  const diagnostics = {
    record: (code: string) => {
      diagnosticCounts.set(code, (diagnosticCounts.get(code) ?? 0) + 1);
    },
  };

  const canonicalize = await runCanonicalization(app, {
    families: [FANSLY_REPLAY_FAMILY],
    kinds,
    accountId: options.accountId ?? null,
    // MUST be scoped to Fansly pages. `dm_conversations` is journaled by the
    // OFAPI DM sync under the same kind, and the driver stamps parse_version
    // even for observations that produced zero events — an unscoped run would
    // mark OnlyFans rows consumed by version 1, and a future OnlyFans
    // canonicalizer at that version would never look at them again (Stage 8's
    // parse-version contract).
    accountIds,
    from: window.from,
    to: window.to,
    // shadow = canonicalize and count; the driver's dry run appends nothing
    // and stamps nothing, so the next `on` run sees exactly the same corpus.
    dryRun: mode === "shadow",
    diagnostics,
    ...(options.afterId != null ? { afterId: options.afterId } : {}),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages !== undefined ? { maxPagesPerFamily: options.maxPages } : {}),
  });

  const projection = mode === "on"
    ? await runFanslyReplayProjection(app, accountIds)
    : null;

  const floorsAfter: FanslyReplayFloors[] = [];
  for (const accountId of accountIds) {
    floorsAfter.push(await getFanslyReplayFloors(app.db, accountId, kinds));
  }

  const remaining = Math.max(0, eligible.total - canonicalize.scanned);
  const coverage = {
    eligibleTotal: eligible.total,
    examined: canonicalize.scanned,
    remaining,
    complete: remaining === 0,
    nextAfterId: remaining === 0 ? null : canonicalize.lastObservationId,
  };
  if (!coverage.complete) {
    // A shadow run cannot advance by itself (it stamps nothing), so silence
    // here would let the same prefix be verified over and over while the
    // staged-flag ritual believes the corpus was covered.
    app.logger.warn(
      { coverage, mode },
      "Fansly replay examined only part of the eligible corpus; resume with afterId",
    );
  }
  const parserDiagnostics = Object.fromEntries([...diagnosticCounts.entries()].sort());
  if (diagnosticCounts.size > 0) {
    app.logger.warn({ parserDiagnostics }, "Fansly replay refused vendor values it could not read");
  }

  return {
    ...base,
    accountIds,
    preflight: { ok: true, window: windowIso, writeRange: writeRangeIso, detachedPartitions: [] },
    coverage,
    parserDiagnostics,
    canonicalize,
    projection,
    floors: { before: floorsBefore, after: floorsAfter },
  };
}

// The projection registry (WP-F1(0), the spine precursor).
//
// WHAT IT REPLACES, and why that was the expensive-forever shape: adding a
// projector used to mean editing a hardcoded three-name if-chain in the CLI AND
// a hand-written try/catch block in the worker tick — two sites nothing checks,
// on a plan that adds ~10 projections. A projector registered nowhere is a
// table that silently stops filling; a projector nobody can REBUILD is a
// projection you cannot repair. Both are omissions a passing end-to-end test
// does not notice.
//
// WHAT IS DELIBERATELY *NOT* HERE:
//
// - **[D1] the typed ledger read is DEFERRED** (owner, 2026-08-21). Every
//   definition declares its `eventTypes` from day one — that half is nearly
//   free and it is what makes the deferral reopenable — but `listEventsSince`
//   still has no positive type filter and the supporting index is not built.
//   The named TRIGGER to build it: the tick-duration alert on either shared
//   queue firing, a measured sweep-tick regression after new families land, or
//   a drain measurably lengthening another projector's tick.
// - **Per-family tick scheduling is deferred** with it. Every projection here
//   still rides the one minutely queue it rode before.
// - **Observation-driven consumers are not projections in this sense.**
//   `ai_acceptance` walks `observations` by id, not the event ledger, so it has
//   no `eventTypes` to declare and stays wired inline in the worker tick. A
//   registry entry with an empty type list would be a lie the registry test is
//   written to catch.
//
// THE THIRD STATE CLASS (§3.4). Rebuild = truncate + replay. No event carries a
// cursor, a floor or a blocker, so a rebuild that truncated capture-plane state
// would reset every refresh cycle and re-trigger "first sight" backfills for
// the whole catalogue — an egress storm against a platform whose failure mode
// is a model ban. `OPERATIONAL_STATE_TABLES` names those tables, and the
// registry test asserts no projection's `tables` intersects it: that
// intersection being empty IS "operational state is never truncated by a
// rebuild", checked rather than promised.

import { listDetachedPartitionsHoldingAccount, listEventAccounts } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  CREATOR_POSTS_PROJECTION,
  rebuildCreatorPostsProjection,
  runCreatorPostsProjection,
} from "./creator-posts.ts";
import {
  FAN_EARNINGS_PROJECTION,
  rebuildFanEarningsProjection,
  runFanEarningsProjection,
} from "./fan-earnings.ts";
import {
  FANSLY_STATS_PROJECTION,
  rebuildFanslyStatsProjection,
  runFanslyStatsProjection,
} from "./fansly-stats.ts";
import {
  MEDIA_PLANE_PROJECTION,
  rebuildMediaPlaneProjection,
  runMediaPlaneProjection,
} from "./media-plane.ts";
import { MESSAGE_EVENT_TYPES, runMessageArchiveProjection } from "./message-archive.ts";
import { buildMessageArchiveShadow } from "./message-archive-rebuild.ts";
import {
  OFAPI_MESSAGE_COVERAGE_PROJECTION,
  runOfapiMessageCoverageProjection,
} from "./ofapi-message-coverage.ts";

export type ProjectionStateClass = "fact_projection" | "operational_state";

/**
 * How a projection is repaired.
 *
 * - `truncate_replay` — delete the scope, reset the watermark, replay the
 *   ledger. The ordinary case.
 * - `bespoke_shadow` — `message_archive`: the in-place rebuild is LOSSY by
 *   construction (the replay sees only attached partitions and the reset
 *   destroys legacy-seed rows with no event counterpart), so the sanctioned
 *   path builds a SHADOW and the swap is a separate owner-gated command
 *   (decision #134). Declared here rather than hidden in a CLI branch.
 * - `none` — no repair path exists yet; the registry says so out loud instead
 *   of the CLI failing with "Unknown projection".
 */
export type ProjectionRebuildKind = "truncate_replay" | "bespoke_shadow" | "none";

export interface ProjectionDefinition {
  /** The name `projection:rebuild <name>` takes, and the watermark key. */
  name: string;
  /** The event types this projection consumes. Non-empty, pinned by a test. */
  eventTypes: readonly string[];
  /** The tables it writes. Non-empty, pinned by a test. */
  tables: readonly string[];
  stateClass: ProjectionStateClass;
  rebuildKind: ProjectionRebuildKind;
  /** Human-readable label for the tick log line. */
  label: string;
  run: (
    app: Pick<AppContext, "db" | "logger">,
    input?: { accountId?: number | null },
  ) => Promise<Record<string, unknown>>;
  /** null when `rebuildKind` is "none". */
  rebuild:
    | ((
      app: Pick<AppContext, "db" | "logger">,
      input?: { accountId?: number | null },
    ) => Promise<unknown>)
    | null;
  /** Whether this run produced anything worth a log line (quiet when idle). */
  didWork: (result: Record<string, unknown>) => boolean;
}

function count(result: Record<string, unknown>, key: string): number {
  const value = result[key];
  return typeof value === "number" ? value : 0;
}

export const PROJECTION_REGISTRY: readonly ProjectionDefinition[] = [
  {
    name: "message_archive",
    eventTypes: [...MESSAGE_EVENT_TYPES],
    tables: ["dm_message_archive"],
    stateClass: "fact_projection",
    // Decision #134: never in place. `projection:rebuild message_archive`
    // builds the shadow; `archive:rebuild-verify` then the owner-gated
    // `archive:rebuild-switch --execute` complete the ritual.
    rebuildKind: "bespoke_shadow",
    label: "Message-archive projection sweep complete",
    run: async (app, input) => ({ ...await runMessageArchiveProjection(app, input) }),
    rebuild: async (app, input) => await buildMessageArchiveShadow(app, input),
    didWork: (result) => count(result, "eventsSeen") > 0,
  },
  {
    name: OFAPI_MESSAGE_COVERAGE_PROJECTION,
    eventTypes: ["capture.coverage_observed", "capture.coverage_revoked"],
    tables: ["ofapi_message_coverage"],
    stateClass: "fact_projection",
    // No rebuild path has ever been built for it; saying so is better than a
    // CLI that reports "Unknown projection" for something that exists.
    rebuildKind: "none",
    label: "OFAPI message-coverage projection sweep complete",
    run: async (app, input) => ({ ...await runOfapiMessageCoverageProjection(app, input) }),
    rebuild: null,
    didWork: (result) => count(result, "projected") > 0,
  },
  {
    name: FAN_EARNINGS_PROJECTION,
    eventTypes: ["fan.earnings_observed"],
    tables: ["fan_earnings_stats"],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Fan-earnings projection sweep complete",
    run: async (app, input) => ({ ...await runFanEarningsProjection(app, input) }),
    rebuild: async (app, input) => await rebuildFanEarningsProjection(app, input),
    didWork: (result) => count(result, "upserted") > 0,
  },
  {
    name: CREATOR_POSTS_PROJECTION,
    eventTypes: ["post.observed", "post.tip_observed"],
    tables: ["creator_posts", "creator_post_tips"],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Creator-posts projection sweep complete",
    run: async (app, input) => ({ ...await runCreatorPostsProjection(app, input) }),
    rebuild: async (app, input) => await rebuildCreatorPostsProjection(app, input),
    didWork: (result) => count(result, "upserted") > 0,
  },
  {
    name: MEDIA_PLANE_PROJECTION,
    eventTypes: [
      "media.observed",
      "media.order_observed",
      "media.offer_location_observed",
      "message.attachments_observed",
    ],
    tables: [
      "creator_media",
      "creator_media_bundles",
      "media_orders",
      "message_media_offers",
      "media_offer_locations",
    ],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Media-plane projection sweep complete",
    run: async (app, input) => ({ ...await runMediaPlaneProjection(app, input) }),
    rebuild: async (app, input) => await rebuildMediaPlaneProjection(app, input),
    didWork: (result) =>
      count(result, "media") > 0 || count(result, "orders") > 0
      || count(result, "offers") > 0 || count(result, "locations") > 0,
  },
  {
    name: FANSLY_STATS_PROJECTION,
    // WP-F1: ONE family-grouped projector over the statistics events, with a
    // single watermark and a reducer per table — not six independent ledger
    // scans over the same stream (F1(0).5).
    eventTypes: [
      "traffic.datapoint_observed",
      "media_traffic.datapoint_observed",
      "stats.window_top_observed",
      "tag.counters_observed",
      "media.sale_stats_observed",
      "earnings.breakdown_observed",
      "earnings.month_observed",
      "tracking_link.snapshot_observed",
      "broadcast.stats_observed",
      "broadcast.scheduled_observed",
      "poll.observed",
      "recap.stat_observed",
    ],
    tables: [
      "stats_traffic_buckets",
      "stats_top_media",
      "stats_top_tags",
      "platform_tag_daily",
      "revenue_mix_daily",
      "revenue_month_totals",
      "page_promo_links",
      "page_broadcasts",
      "page_polls",
      "page_poll_options",
      "page_recap_stats",
    ],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Fansly-stats projection sweep complete",
    run: async (app, input) => ({ ...await runFanslyStatsProjection(app, input) }),
    rebuild: async (app, input) => await rebuildFanslyStatsProjection(app, input),
    didWork: (result) => count(result, "applied") > 0,
  },
];

/**
 * §3.4's third state class, declared once so nothing lands in the wrong one.
 *
 * These tables are written by the CAPTURE plane, not by a projector, and they
 * are excluded from the §9.1 truncate-and-replay checksum BY CLASSIFICATION —
 * never by a quiet executor exemption in the test file.
 */
export const OPERATIONAL_STATE_TABLES: readonly {
  table: string;
  stateClass: Extract<ProjectionStateClass, "operational_state">;
  writer: string;
  justification: string;
}[] = [
  {
    table: "capture_coverage",
    stateClass: "operational_state",
    writer: "services/sync/fansly-stats.ts",
    justification:
      "A17-6: cursors, floors and blockers that no event carries. `proof_observation_id` "
      + "points into the 100-year journal at the response that proves the claim, so the "
      + "EVIDENCE is durable even though the row is not replayable. Truncating it would "
      + "erase every retention floor the backfill paid egress to discover and re-trigger "
      + "the whole first-sight backfill set.",
  },
];

const OPERATIONAL_STATE_TABLE_SET = new Set(
  OPERATIONAL_STATE_TABLES.map((entry) => entry.table),
);

export function isOperationalStateTable(table: string): boolean {
  return OPERATIONAL_STATE_TABLE_SET.has(table);
}

export function findProjection(name: string): ProjectionDefinition | null {
  return PROJECTION_REGISTRY.find((projection) => projection.name === name) ?? null;
}

export function projectionNames(): string[] {
  return PROJECTION_REGISTRY.map((projection) => projection.name);
}

/**
 * §3.2c(i) READ-SIDE PREFLIGHT, applied to EVERY registry rebuild.
 *
 * Tiering exports and DETACHES `domain_events` monthlies older than ~6 months,
 * and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran
 * anyway would truncate the projection, replay a truncated ledger, and call the
 * result authoritative — silently. Refusing is the only honest answer.
 *
 * Before this registry only `media_plane` and `message_archive` had the gate;
 * `creator_posts` and `fan_earnings` would have replayed a truncated ledger
 * without a word. Putting it in the one function every rebuild goes through is
 * why that class of omission stops being possible.
 */
export async function assertProjectionRebuildable(
  app: Pick<AppContext, "db">,
  projectionName: string,
  accountIds: readonly number[],
): Promise<void> {
  for (const accountId of accountIds) {
    const holding = await listDetachedPartitionsHoldingAccount(app.db, accountId);
    if (holding.length > 0) {
      throw new Error(
        `${projectionName} rebuild REFUSED for account ${accountId}: `
          + `${holding.map((row) => `${row.schema}.${row.name} (${row.rows} rows)`).join(", ")} `
          + "is detached and holds this account's events, so a replay would produce a "
          + "TRUNCATED projection and call it authoritative. Recovery: re-attach the month "
          + "(the 0077 ritual — DETACH/ATTACH only, never DROP) or replay hot + lake for the "
          + "range, then re-run. See docs/runbooks/domain-event-partitions.md",
      );
    }
  }
}

export class UnknownProjectionError extends Error {
  constructor(name: string) {
    super(`Unknown projection: ${name}. Known: ${projectionNames().join(" | ")}`);
    this.name = "UnknownProjectionError";
  }
}

export class ProjectionNotRebuildableError extends Error {
  constructor(name: string) {
    super(
      `Projection ${name} declares rebuildKind "none": no repair path is built for it. `
        + "Adding one means giving its registry entry a rebuild function, not special-casing "
        + "a command.",
    );
    this.name = "ProjectionNotRebuildableError";
  }
}

/**
 * The one entry point `projection:rebuild` uses. Resolves the definition, runs
 * the detached-partition preflight over the scope, then delegates.
 */
export async function rebuildRegisteredProjection(
  app: Pick<AppContext, "db" | "logger">,
  name: string,
  input?: { accountId?: number | null },
): Promise<unknown> {
  const projection = findProjection(name);
  if (projection === null) {
    throw new UnknownProjectionError(name);
  }
  if (projection.rebuild === null) {
    throw new ProjectionNotRebuildableError(name);
  }
  const accountIds = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);
  await assertProjectionRebuildable(app, projection.name, accountIds);
  return projection.rebuild(app, input);
}

export interface ProjectionTickOutcome {
  name: string;
  result: Record<string, unknown> | null;
  error: unknown;
  durationMs: number;
}

/**
 * The minutely tick, table-driven.
 *
 * Each projection owns its watermark, so a poison fact in one must stay
 * retryable without starving the neighbours that share this pg-boss handler —
 * which is why every entry is isolated in its own try/catch, exactly as the six
 * hand-written blocks this replaced were.
 */
export async function runProjectionTick(
  app: Pick<AppContext, "db" | "logger">,
): Promise<ProjectionTickOutcome[]> {
  const outcomes: ProjectionTickOutcome[] = [];
  for (const projection of PROJECTION_REGISTRY) {
    const startedAt = Date.now();
    try {
      const result = await projection.run(app);
      const durationMs = Date.now() - startedAt;
      if (projection.didWork(result)) {
        app.logger.info({ ...result, projection: projection.name }, projection.label);
      }
      outcomes.push({ name: projection.name, result, error: null, durationMs });
    } catch (error) {
      app.logger.error(
        { error, projection: projection.name },
        `${projection.label.replace(" complete", "")} failed`,
      );
      outcomes.push({
        name: projection.name,
        result: null,
        error,
        durationMs: Date.now() - startedAt,
      });
    }
  }
  return outcomes;
}

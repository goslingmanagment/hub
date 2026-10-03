import { FANSLY_WS_HINT_PROJECTION, runFanslyWsHintProjection } from "./fansly-ws-hints.ts";
import { OFAPI_MEDIA_EVENT, OFAPI_MEDIA_PROJECTION, runOfapiMediaProjection, rebuildOfapiMediaProjection } from "./ofapi-media.ts";
import { OFAPI_CONTENT_PROJECTION, runOfapiContentProjection, rebuildOfapiContentProjection } from "./ofapi-content-events.ts";
import { OFAPI_READ_SNAPSHOT_PROJECTION, runOfapiReadSnapshotProjection, rebuildOfapiReadSnapshotProjection } from "./ofapi-read-snapshots.ts";
import { OFAPI_TYPED_EXPORT_EVENT, OFAPI_TYPED_EXPORT_PROJECTION, runOfapiTypedExportsProjection, rebuildOfapiTypedExportsProjection } from "./ofapi-typed-exports.ts";
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
// registry test permits it only for non-rebuildable operational consumers:
// excluding every truncating rebuild IS "operational state is never truncated by a
// rebuild", checked rather than promised.

import { listDetachedPartitionsHoldingAccount, listEventAccounts } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import {
  AI_MEDIA_CANDIDATES_PROJECTION,
  runAiMediaCandidatesProjection,
} from "./ai-media-candidates.ts";
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
  FANSLY_ENGAGEMENT_PROJECTION,
  rebuildFanslyEngagementProjection,
  runFanslyEngagementProjection,
} from "./fansly-engagement.ts";
import {
  FANSLY_CATALOG_PROJECTION,
  FANSLY_CATALOG_PROJECTION_TABLES,
  rebuildFanslyCatalogProjection,
  runFanslyCatalogProjection,
} from "./fansly-catalog.ts";
import {
  FANSLY_COMMENTS_PROJECTION,
  FANSLY_COMMENTS_PROJECTION_TABLES,
  rebuildFanslyCommentsProjection,
  runFanslyCommentsProjection,
} from "./fansly-comments.ts";
import {
  FANSLY_PAYOUTS_PROJECTION,
  FANSLY_PAYOUTS_PROJECTION_TABLES,
  rebuildFanslyPayoutsProjection,
  runFanslyPayoutsProjection,
} from "./fansly-payouts.ts";
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
    // AI media describer candidates: reads the media plane's and the WS
    // hints' event types but writes only its own operational tables.
    name: AI_MEDIA_CANDIDATES_PROJECTION,
    eventTypes: ["message.attachments_observed", "fansly.ws_signal_observed"],
    tables: ["ai_media_descriptions", "ai_media_description_links", "ai_media_accelerator_reads"],
    stateClass: "operational_state", rebuildKind: "none", rebuild: null,
    label: "AI media describer candidates projected", run: runAiMediaCandidatesProjection,
    didWork: result => count(result, "candidates") > 0 || count(result, "accelerations") > 0,
  },
  {
    name: FANSLY_WS_HINT_PROJECTION, eventTypes: ["fansly.ws_signal_observed"],
    tables: ["fansly_ws_hint_receipts", "subject_refresh_state"], stateClass: "operational_state",
    rebuildKind: "none", rebuild: null, label: "Fansly WS hints routed", run: runFanslyWsHintProjection,
    didWork: result => count(result, "applied") > 0,
  },
  { name:OFAPI_CONTENT_PROJECTION, eventTypes:["ofapi.chat_queue_observed"], tables:["ofapi_chat_queue_state"], stateClass:"fact_projection", rebuildKind:"truncate_replay", label:"OFAPI queue evidence projected", run:runOfapiContentProjection, rebuild:rebuildOfapiContentProjection, didWork:result=>count(result,"applied")>0 },
  { name:OFAPI_READ_SNAPSHOT_PROJECTION, eventTypes:["ofapi.read_snapshot_observed"], tables:["ofapi_read_snapshots"], stateClass:"fact_projection", rebuildKind:"truncate_replay", label:"OFAPI read snapshots projected", run:runOfapiReadSnapshotProjection, rebuild:rebuildOfapiReadSnapshotProjection, didWork:result=>count(result,"applied")>0 },
  { name: OFAPI_MEDIA_PROJECTION, eventTypes: [OFAPI_MEDIA_EVENT], tables: ["ofapi_media_catalog"], stateClass: "fact_projection", rebuildKind: "truncate_replay", label: "OFAPI media metadata projection complete", run: runOfapiMediaProjection, rebuild: rebuildOfapiMediaProjection, didWork: result => count(result, "applied") > 0 },
  { name: OFAPI_TYPED_EXPORT_PROJECTION, eventTypes: [OFAPI_TYPED_EXPORT_EVENT], tables: ["ofapi_typed_export_rows", "ofapi_profile_visitors_daily"], stateClass: "fact_projection", rebuildKind: "truncate_replay", label: "Typed OFAPI exports projection complete", run: runOfapiTypedExportsProjection, rebuild: rebuildOfapiTypedExportsProjection, didWork: result => count(result, "applied") > 0 },
  {
    name: "message_archive",
    eventTypes: [...MESSAGE_EVENT_TYPES],
    tables: ["message_archive"],
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
      "media.file_observed",
      "media.order_observed",
      "media.offer_location_observed",
      "message.attachments_observed",
    ],
    tables: [
      "creator_media",
      "creator_raw_media",
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
      count(result, "media") > 0 || count(result, "rawMedia") > 0 || count(result, "orders") > 0
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
      // WP-F4: per-media `topFypTags` rows, in the SAME family.
      "media_tag.stats_observed",
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
      // WP-F4. `subject_refresh_state` is deliberately NOT here: this lane
      // WRITES it, but it is capture-plane operational state and a rebuild that
      // truncated it would re-mark the whole catalogue as first-sight.
      "fansly_media_tag_stats",
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
  {
    name: FANSLY_ENGAGEMENT_PROJECTION,
    // WP-F2. `notification.observed` is the VERBATIM row — every code, known
    // or not — and `media.purchase_notification_observed` is the commerce
    // signal that marks a media dirty. `engagement.notification_observed` is
    // deliberately NOT consumed: it carries no field-level semantics anything
    // can store today, and declaring an event type this projector ignores
    // would make the registry's `eventTypes` a wish rather than a contract.
    eventTypes: [
      "ofapi.post_like_observed",
      "notification.observed",
      "media.purchase_notification_observed",
    ],
    // `subject_refresh_state` is ABSENT on purpose: the projector WRITES it,
    // but it is capture-plane operational state and a rebuild must never
    // truncate it. `OPERATIONAL_STATE_TABLES` below names it, and the registry
    // test asserts the two lists cannot intersect.
    tables: ["platform_notifications", "post_likes"],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Fansly-engagement projection sweep complete",
    run: async (app, input) => ({ ...await runFanslyEngagementProjection(app, input) }),
    rebuild: async (app, input) => await rebuildFanslyEngagementProjection(app, input),
    didWork: (result) => count(result, "applied") > 0,
  },
  {
    name: FANSLY_CATALOG_PROJECTION,
    // WP-F3. Seven types, and the last of them is the one that makes the other
    // six honest: `catalog.listing_observed` carries the full roster a listing
    // served, and applying it is what marks a retired tier, a revoked gift code
    // or a deleted album `missing_since` — including in the case that produces
    // no row events at all, an EMPTY listing.
    //
    // `media.observed` is deliberately NOT declared here even though this
    // family emits it (vault walk, batch hydration): the media plane is and
    // stays the SINGLE writer of `creator_media`, and declaring the type on two
    // projections would make the registry's `eventTypes` a wish rather than a
    // contract.
    eventTypes: [
      "vault.album_observed",
      "vault.album_membership_observed",
      "vault.album_walk_completed",
      "subscription.tier_observed",
      "subscription.tier_plan_observed",
      "promo.gift_code_observed",
      "automation.definition_observed",
      "page.wall_observed",
      "catalog.listing_observed",
    ],
    tables: [...FANSLY_CATALOG_PROJECTION_TABLES],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Fansly-catalog projection sweep complete",
    run: async (app, input) => ({ ...await runFanslyCatalogProjection(app, input) }),
    rebuild: async (app, input) => await rebuildFanslyCatalogProjection(app, input),
    didWork: (result) => count(result, "applied") > 0,
  },
  {
    name: FANSLY_COMMENTS_PROJECTION,
    // WP-F5. Two types, and the second is what makes the first honest:
    // `post.comment_list_observed` carries the full ref set one walk served, and
    // applying it is what marks a deleted comment `missing_since` — including
    // in the case that produces no row events at all, a post whose comments
    // were ALL deleted.
    eventTypes: [
      "post.comment_observed",
      "post.comment_list_observed",
    ],
    // `subject_refresh_state` is ABSENT on purpose: the walk queue for
    // `plane='post_replies'` is written by the capture handler and by the
    // creator-posts seeding hook, and a rebuild that truncated it would re-run a
    // first-pass crawl of the whole post back-catalogue for a repair that should
    // cost zero platform calls.
    tables: [...FANSLY_COMMENTS_PROJECTION_TABLES],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Fansly-comments projection sweep complete",
    run: async (app, input) => ({ ...await runFanslyCommentsProjection(app, input) }),
    rebuild: async (app, input) => await rebuildFanslyCommentsProjection(app, input),
    didWork: (result) => count(result, "applied") > 0,
  },
  {
    name: FANSLY_PAYOUTS_PROJECTION,
    // WP-F7. Three types, and the third is what makes the first honest:
    // `payout.method_list_observed` carries the full ref set one listing
    // served, and applying it is what marks a removed payout method
    // `missing_since` — including in the case that produces no row events at
    // all, a creator who removed their last method.
    eventTypes: [
      "payout.method_observed",
      "payout.method_list_observed",
      "payout.observed",
    ],
    tables: [...FANSLY_PAYOUTS_PROJECTION_TABLES],
    stateClass: "fact_projection",
    rebuildKind: "truncate_replay",
    label: "Fansly-payouts projection sweep complete",
    run: async (app, input) => ({ ...await runFanslyPayoutsProjection(app, input) }),
    rebuild: async (app, input) => await rebuildFanslyPayoutsProjection(app, input),
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
    table: "ai_media_descriptions", stateClass: "operational_state",
    writer: "services/projections/ai-media-candidates.ts, services/ai-media-describe/worker.ts",
    justification: "AI media describer work items and PAID results (descriptions, refusal memory). Truncation would resend every image to the provider and forget refusals the owner ruled must never be retried.",
  },
  {
    table: "ai_media_description_links", stateClass: "operational_state",
    writer: "services/projections/ai-media-candidates.ts, modules/ai/context/media-notes-context.ts",
    justification: "Where each described file appeared (fan, conversation, message); generation-requested links carry no event, so a replay cannot rebuild them.",
  },
  {
    table: "ai_media_accelerator_reads", stateClass: "operational_state",
    writer: "services/projections/ai-media-candidates.ts, services/sync/ai-media-accelerator.ts",
    justification: "Fansly accelerator physical-attempt admissions enforce the agency-wide rolling cap; resetting them would grant additional Fansly requests again within the same window.",
  },
  {
    table: "fansly_ws_hint_receipts", stateClass: "operational_state",
    writer: "services/projections/fansly-ws-hints.ts",
    justification: "B1 routing custody and revision receipts must survive replay. Truncation would increment dirty revisions twice and spend additional platform attempts.",
  },
  {
    table: "fan_earnings_target_attempts", stateClass: "operational_state",
    writer: "services/sync/fan-earnings-targets.ts",
    justification: "C2c physical-attempt custody; replay or config changes must not reset the rolling budget.",
  },
  {
    table: "fansly_ws_hint_attempts", stateClass: "operational_state",
    writer: "services/sync/fansly-ws-hints.ts",
    justification: "B1 physical attempt admissions enforce the rolling additional egress cap. Resetting this ledger would grant the budget again within the same window.",
  },
  {
    table: "capture_coverage",
    stateClass: "operational_state",
    writer: "sync/fansly/lib/lane.ts",
    justification:
      "A17-6: cursors, floors and blockers that no event carries. `proof_observation_id` "
      + "points into the 100-year journal at the response that proves the claim, so the "
      + "EVIDENCE is durable even though the row is not replayable. Truncating it would "
      + "erase every retention floor the backfill paid egress to discover and re-trigger "
      + "the whole first-sight backfill set.",
  },
  {
    table: "subject_refresh_state",
    stateClass: "operational_state",
    writer: "services/projections/fansly-engagement.ts",
    justification:
      "§3.4: the shared refresh QUEUE — due dates, dirty reasons, walk cursors and failure "
      + "counts that NO event carries. Rebuild is truncate + replay, so a rebuild that "
      + "truncated it would clear every pending refresh and re-mark the whole catalogue as "
      + "first-sight, releasing an egress storm bounded only by the media lane's daily cap "
      + "against a platform whose failure mode is a model ban. It is written by the capture "
      + "plane and by the WP-F2 purchase signal; it is replayable by neither, which is "
      + "exactly why v1's four queue columns on the rebuildable `creator_media` were wrong. "
      + "WP-F5 added its second plane (`post_replies`): one row per root post, written by "
      + "the replies handler and by the creator-posts projector's same-transaction seeding "
      + "hook, and truncating it would re-run a first-pass crawl of the entire post "
      + "back-catalogue for a repair that should cost zero platform calls.",
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
  /**
   * Set when the whole run threw and the per-account pass still failed for
   * these accounts: their watermarks stay parked, every other account advanced.
   */
  failedAccounts?: number[];
}

export interface ProjectionTickResult {
  /** One entry per projection that RAN this tick, in the order it ran. */
  outcomes: ProjectionTickOutcome[];
  /**
   * The tick stopped early because `maxDurationMs` ran out. NOT a failure and
   * not an error: every projection it did run advanced its own watermark, and
   * the ones it never reached are named in `skippedProjections` and take the
   * head of the next tick (see the rotation below). It IS starvation pressure,
   * so the worker logs it at warn level.
   */
  truncatedByBudget: boolean;
  /**
   * The `name` of every projection that did not run AT ALL this tick because
   * the budget was already gone when its turn came. The projection that was
   * running when the budget expired is absent from this list — it ran to
   * completion and advanced its watermark like any other.
   */
  skippedProjections: string[];
}

export interface ProjectionTickOptions {
  /**
   * Wall-clock budget for the WHOLE tick (defect 2026-08-22). Default: none —
   * the CLI and any non-tick caller keep the unbudgeted, registry-ordered
   * behaviour. The minutely sweep passes one, because pg-boss kills a handler
   * that outruns the queue's expiration and a killed tick is strictly worse
   * than a truncated one: it settles nothing extra and takes down whatever was
   * scheduled after it.
   *
   * The budget is checked BETWEEN PROJECTIONS, never inside one. A projection
   * that starts gets one whole `run()` call, which bounds itself by paging the
   * ledger from its own watermark and committing per page — so a tick that
   * ends here never abandons work mid-page and never rewinds a watermark.
   */
  maxDurationMs?: number;
}

/**
 * Wall-clock budget the minutely projection tick passes `runProjectionTick`.
 * Sibling of `CANONICALIZE_SWEEP_BUDGET_MS` rather than a shared constant: the
 * two ride DIFFERENT queues, and one of them wanting a different minute must
 * not silently retune the other. Ten minutes sits well under pg-boss's 900s
 * default handler expiration for this queue — the queue keeps that default on
 * purpose, so the budget is the thing that ends a long tick and the expiration
 * stays the backstop. The gap leaves room for the projection in flight when the
 * budget expires (the check is BETWEEN projections).
 */
export const PROJECTION_TICK_BUDGET_MS = 600_000;

/**
 * Where the NEXT budgeted tick starts its rotation — a projection `name`, or
 * null for "the registry head" (defect 2026-08-22).
 *
 * Why rotate at all: with a wall-clock budget the registry order becomes a
 * priority order, and the projections at the end of it (`fansly_catalog`,
 * `fansly_comments`, `fansly_payouts` — the WP-F1..F7 additions) are exactly
 * the ones that never got a turn while the tick was outrunning pg-boss's
 * handler expiration: `page_payout_requests` sat empty with 91
 * `payout.observed` events in the ledger. Each budgeted tick therefore resumes
 * at the projection AFTER the one that ran the budget out, so every projection
 * reaches the head within a few ticks.
 *
 * Module-level and in-memory, deliberately mirroring the canonicalize driver's
 * sweep cursors: a worker restart costs one pass that starts at the head, and
 * the DURABLE "where was I" state — each projection's own watermark — is
 * untouched by rotation, so a projection resumes exactly where it stopped
 * whenever its turn comes round.
 *
 * Rotation is safe because projections do not read each other's tables: each
 * one consumes the ledger from its own watermark and writes only the tables it
 * declares (the registry test pins that no two claim one event type, and that
 * none of them touch operational state). Run order is scheduling here, never
 * semantics.
 */
let tickRotationName: string | null = null;

/** Test hook: start the next budgeted tick at the registry head. */
export function resetProjectionTickRotation(): void {
  tickRotationName = null;
}

function rotateProjections(
  projections: readonly ProjectionDefinition[],
): readonly ProjectionDefinition[] {
  if (tickRotationName === null) {
    return projections;
  }
  const start = projections.findIndex((projection) => projection.name === tickRotationName);
  // A name that no longer resolves (registry edited between ticks) means
  // "start at the head" — never "skip the tick".
  return start <= 0 ? projections : [...projections.slice(start), ...projections.slice(0, start)];
}

/**
 * The fallback after a projection's whole run threw: run it once per account,
 * each in its own try/catch. Every registered `run` scopes itself to
 * `input.accountId` through the same code path, so this is the same work.
 *
 * - Every account is attempted. No breaker stops at the first failure: the
 *   poison account fails with exactly the whole run's error, and stopping
 *   there would park every later account again.
 * - Accounts the whole run already finished run a second time. That is safe:
 *   a projection resumes from its own watermark (usually an empty read), and
 *   its writes are idempotent. `fansly_ws_hints`, which takes one ledger page
 *   per tick, routes its next page early; the refreshes it asks for stay
 *   coalesced and under their own caps.
 * - Nothing is skipped or quarantined: a failing account's watermark stays
 *   where it is, and the next tick retries it.
 *
 * Returns null when even the account list cannot be read (the database is
 * down, typically); the caller then reports the whole-run error alone.
 */
async function runAccountsInIsolation(
  app: Pick<AppContext, "db" | "logger">,
  projection: ProjectionDefinition,
): Promise<{ accounts: number; failed: { accountId: number; error: unknown }[] } | null> {
  let accountIds: number[];
  try {
    accountIds = await listEventAccounts(app.db);
  } catch {
    return null;
  }
  const failed: { accountId: number; error: unknown }[] = [];
  for (const accountId of accountIds) {
    try {
      await projection.run(app, { accountId });
    } catch (error) {
      failed.push({ accountId, error });
    }
  }
  return { accounts: accountIds.length, failed };
}

/**
 * The minutely tick, table-driven.
 *
 * Each projection owns its watermark, so a poison fact in one must stay
 * retryable without starving the neighbours that share this pg-boss handler —
 * which is why every entry is isolated in its own try/catch, exactly as the six
 * hand-written blocks this replaced were.
 *
 * The watermark is per (projection, account), so the same isolation is owed
 * one level down: a projection walks its accounts in id order with no
 * try/catch between them, and one account's poison fact used to park every
 * account after it, tick after tick. A failed whole run is therefore retried account by account
 * (`runAccountsInIsolation`): the failing accounts stay parked and retryable,
 * the others advance in the same tick.
 *
 * Defect 2026-08-22: isolation was never the same thing as fairness. This loop
 * awaited every projection to completion in registry order and had no clock, so
 * once WP-F6's v6 drain and the F1..F7 families made a full pass longer than
 * the queue's handler expiration, the tail of the registry never ran at all —
 * pg-boss killed the handler mid-pass, the next tick started at the head, and
 * it was killed again. `maxDurationMs` + the rotation above are that fix.
 */
export async function runProjectionTick(
  app: Pick<AppContext, "db" | "logger">,
  options: ProjectionTickOptions = {},
): Promise<ProjectionTickResult> {
  const outcomes: ProjectionTickOutcome[] = [];
  const deadlineAt = options.maxDurationMs !== undefined && options.maxDurationMs > 0
    ? Date.now() + options.maxDurationMs
    : null;
  // Only a budgeted tick rotates. The CLI and any other caller keep registry
  // order — they pass no budget, so there is nothing for a rotation to be fair
  // about, and a rebuild/diagnostic run must stay deterministic.
  const rotates = deadlineAt !== null;
  const ordered = rotates ? rotateProjections(PROJECTION_REGISTRY) : PROJECTION_REGISTRY;
  /** Index in `ordered` the NEXT tick should start at; null = a full pass. */
  let nextStartIndex: number | null = null;
  let truncatedByBudget = false;
  let skippedProjections: string[] = [];
  for (const [index, projection] of ordered.entries()) {
    // Checked BETWEEN projections only. The head of `ordered` always runs: the
    // deadline is taken from `Date.now()` at the top of this function, so it
    // cannot already be spent when the first turn comes.
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
      // The budget died in the PREVIOUS projection: this one and everything
      // after it did not run at all, and this one heads the next tick.
      truncatedByBudget = true;
      skippedProjections = ordered.slice(index).map((skipped) => skipped.name);
      nextStartIndex = index;
      break;
    }
    const startedAt = Date.now();
    try {
      const result = await projection.run(app);
      const durationMs = Date.now() - startedAt;
      if (projection.didWork(result)) {
        app.logger.info({ ...result, projection: projection.name }, projection.label);
      }
      outcomes.push({ name: projection.name, result, error: null, durationMs });
    } catch (error) {
      const label = projection.label.replace(" complete", "");
      const isolated = await runAccountsInIsolation(app, projection);
      if (isolated !== null && isolated.accounts > 0 && isolated.failed.length === 0) {
        // Transient: every account went through on its own (a serialization
        // failure, a busy erasure lock), so nothing is parked.
        app.logger.warn(
          { error, projection: projection.name, accounts: isolated.accounts },
          `${label}: whole-run error recovered by the per-account pass`,
        );
        outcomes.push({
          name: projection.name,
          result: { recoveredAfterError: true, accounts: isolated.accounts },
          error: null,
          durationMs: Date.now() - startedAt,
        });
        continue;
      }
      // One line per projection per tick, however many accounts failed.
      const failedAccounts = isolated?.failed.map((failure) => failure.accountId);
      app.logger.error(
        {
          error,
          projection: projection.name,
          ...(isolated === null ? {} : {
            failedAccounts,
            accountErrors: isolated.failed.map((failure) => ({
              accountId: failure.accountId,
              error: failure.error instanceof Error ? failure.error.message : String(failure.error),
            })),
          }),
        },
        `${label} failed`,
      );
      outcomes.push({
        name: projection.name,
        result: null,
        error,
        durationMs: Date.now() - startedAt,
        ...(failedAccounts === undefined ? {} : { failedAccounts }),
      });
    }
  }
  if (rotates) {
    // A completed pass clears the offset: the next tick starts at the head,
    // exactly as every tick did before the budget existed.
    tickRotationName = nextStartIndex === null ? null : ordered[nextStartIndex]!.name;
  }
  return { outcomes, truncatedByBudget, skippedProjections };
}

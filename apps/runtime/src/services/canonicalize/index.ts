import { OFAPI_CONTENT_KINDS, canonicalizeOfapiContentObservation } from "./ofapi-content-events.ts";
import { canParseFanslyWsObservation } from "./fansly-ws.ts";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";
import { canonicalizeOfapiReadObservation, canParseOfapiReadObservation, classifyOfapiReadQuarantine } from "./ofapi-read-collections.ts";
// Canonicalizer registry. The driver job and the parse_version
// sweep dispatch on observation.source through this table; a family's
// `kinds` (null = every kind of that source, filtered inside the function)
// scopes which observations the sweep picks up, and `version` is the
// parse_version stamped after consumption. Bumping a family's version makes
// the sweep revisit its kinds — replay is the steady-state mechanism.

import type {
  CanonicalizableObservation,
  Canonicalizer,
  CanonicalParser,
  CanonicalParseRejection,
  CanonicalQuarantine,
} from "./types.ts";
import { canonicalizeOnlyFansPostsObservation, canParseOnlyFansPostsObservation, ONLYFANS_POSTS_CANONICALIZER_VERSION } from "./onlyfans-post-media.ts";
import {
  canonicalizeClientOnlyfansFeedObservation,
  canParseClientOnlyfansFeedObservation,
  CLIENT_ONLYFANS_FEED_CANONICALIZER_VERSION,
  CLIENT_ONLYFANS_FEED_OBSERVATION_KIND,
} from "./client-onlyfans-feed.ts";
import {
  canonicalizeClientCaptureObservation,
  CLIENT_CAPTURE_CANONICALIZED_KINDS,
  CLIENT_CAPTURE_CANONICALIZER_VERSION,
  CLIENT_CAPTURE_MINTING_KINDS,
} from "./client-capture.ts";
import {
  canonicalizeOfapiWebhookObservation,
  classifyOfapiWebhookQuarantine,
  OFAPI_WEBHOOK_CANONICALIZED_KINDS,
  OFAPI_WEBHOOK_CANONICALIZER_VERSION,
} from "./ofapi-webhook.ts";
import {
  canonicalizeFanslyEarningsObservation,
  parseFanslyEarningsObservation,
  FANSLY_EARNINGS_CANONICALIZER_VERSION,
  FANSLY_EARNINGS_KINDS,
} from "./fansly-earnings.ts";
import {
  canonicalizeSyncPullObservation,
  canParseSyncPullObservation,
  diagnoseSyncPullObservationRejection,
  SYNC_PULL_CANONICALIZED_KINDS,
  SYNC_PULL_CANONICALIZER_VERSION,
} from "./sync-pull.ts";
import {
  canParsePostsObservation,
  canonicalizePostsObservation,
  diagnosePostsObservationRejection,
  POSTS_CANONICALIZED_KINDS,
  POSTS_CANONICALIZER_VERSION,
} from "./posts.ts";
import {
  canonicalizeCommandResultObservation,
  COMMAND_RESULT_CANONICALIZER_VERSION,
} from "./command-result.ts";
import {
  canonicalizeFanslyStatsObservation,
  canParseFanslyStatsObservation,
  diagnoseFanslyStatsObservationRejection,
  FANSLY_STATS_CANONICALIZED_KINDS,
  FANSLY_STATS_CANONICALIZER_VERSION,
} from "./fansly-stats.ts";
import {
  canonicalizeFanslyEngagementObservation,
  canParseFanslyEngagementObservation,
  FANSLY_ENGAGEMENT_CANONICALIZED_KINDS,
  FANSLY_ENGAGEMENT_CANONICALIZER_VERSION,
} from "./fansly-engagement.ts";
import {
  canonicalizeFanslyCatalogObservation,
  canParseFanslyCatalogObservation,
  FANSLY_CATALOG_CANONICALIZED_KINDS,
  FANSLY_CATALOG_CANONICALIZER_VERSION,
} from "./fansly-catalog.ts";
import {
  canonicalizeFanslyCommentsObservation,
  canParseFanslyCommentsObservation,
  FANSLY_COMMENTS_CANONICALIZED_KINDS,
  FANSLY_COMMENTS_CANONICALIZER_VERSION,
} from "./fansly-comments.ts";
import {
  canonicalizeOfapiLinkStatsObservation,
  canParseOfapiLinkStatsObservation,
  OFAPI_LINK_STATS_CANONICALIZED_KINDS,
  OFAPI_LINK_STATS_CANONICALIZER_VERSION,
} from "./ofapi-link-stats.ts";
import {
  canonicalizeFanslyPayoutsObservation,
  canParseFanslyPayoutsObservation,
  FANSLY_PAYOUTS_CANONICALIZED_KINDS,
  FANSLY_PAYOUTS_CANONICALIZER_VERSION,
} from "./fansly-payouts.ts";

interface CanonicalizerFamilyBase {
  source: "webhook" | "pull" | "command_result" | "client_capture" | "ofapi_capture" | "fansly_ws";
  /** Only replay settled material; lower versions remain owned by capture jobs. */
  minimumParseVersion?: number;
  /**
   * Stable per-family lane id, unique across the registry and INDEPENDENT of
   * the version. It disambiguates families that share a `source`: the
   * health-floor gauge name is `obs_backlog_<source>_<lane>_v<version>`
   * (health-floors.ts), and without the lane the `posts` and `sync-pull`
   * families collide on `obs_backlog_pull_v5` the moment sync-pull reaches v5
   * — two different backlogs written under one metric name every tick.
   * NEVER renamed casually: the name is the ops metric series.
   */
  lane: string;
  /** null = all kinds of the source (the function is total over them). */
  kinds: readonly string[] | null;
  version: number;
  /** Share the existing sweep budget between never-parsed capture and replay. */
  prioritizeUnparsed?: boolean;
  canonicalize: Canonicalizer;
  /**
   * H2 (INC-001): asked ONLY about an accepted observation that produced zero
   * events. Non-null names it a TERMINAL quarantine: the driver records an
   * `observation_parse_quarantine` row with the code, counts it, and still
   * stamps parse_version in the same transaction — so the row leaves the
   * backlog-age gauge instead of paging golden_signal_lag forever, without
   * pretending it was an ordinary empty parse. Pure; fixed codes only.
   */
  quarantine?: (observation: CanonicalizableObservation) => CanonicalQuarantine | null;
  /**
   * The family's events are projection material, not client-deliverable news
   * (every type it emits must be in PROJECTION_ONLY_DOMAIN_EVENT_TYPES). The
   * driver then appends through the projection-only protocol, which adds the
   * atomic stream.projection_checkpoint covering the hidden seq range — the
   * SSE replay validator REQUIRES that checkpoint, so this flag and the type
   * list are one decision, never two.
   */
  projectionOnly?: boolean;
  /**
   * §3.2a: this family emits DELIVERABLE events and projection-only material
   * for the same observation, so the driver appends through
   * `appendMixedDomainEvents` — deliverables first, then the hidden block,
   * then the atomic checkpoint covering exactly the hidden rows appended.
   * Mutually exclusive with `projectionOnly` (a family is one or the other).
   */
  mixed?: boolean;
  /**
   * The family can never mint an event, quarantine or refuse a row of its
   * kinds (except `exceptKinds`): its sweep visit is nothing but the
   * parse_version stamp. Writers then stamp such a row at INSERT with the
   * family's current version (`stampOnlyParseVersion`), so the sweep never
   * reads it back and never rewrites it with a non-HOT UPDATE. Rows written
   * without the stamp, and every row below a future version bump, are swept
   * exactly as before. `exceptKinds` names the kinds the canonicalizer CAN
   * mint from; they stay at parse_version 0 for the sweep.
   * Only on a family with no `parse`, no `quarantine`, and whose `canParse`
   * (if any) every writer of the kinds satisfies by construction.
   */
  stampOnly?: { exceptKinds: readonly string[] };
}

export type CanonicalizerFamily = CanonicalizerFamilyBase & (
  | {
    /**
     * Context-free families may validate and build drafts in ONE pass. The
     * driver uses this result for acceptance, diagnostics and append; it does
     * not invoke `canonicalize` again. The standalone canonicalizer remains
     * available to direct callers. A refusal discards all returned drafts.
     */
    parse: CanonicalParser;
    canParse?: never;
    parseRejection?: never;
    replayContext?: never;
  }
  | {
    parse?: never;
    /** Load the original post acceptance boundary from the attached ledger. */
    replayContext?: "accepted_posts";
    /**
     * Shape gate. `false` leaves the row UNSTAMPED for a future parser instead
     * of consuming it with zero events. Without it a drifted payload is
     * indistinguishable from a legitimately EMPTY snapshot. Families without
     * drift risk omit it.
     */
    canParse?: (observation: CanonicalizableObservation) => boolean;
    /** Optional fixed-code detail, called only after `canParse` returns false. */
    parseRejection?: (
      observation: CanonicalizableObservation,
    ) => CanonicalParseRejection | null;
  }
);

export const CANONICALIZER_FAMILIES: readonly CanonicalizerFamily[] = [
  // Registration + validation only — zero domain events. Nothing has read
  // `fansly.ws_signal_observed` since step 4 (#441, #447): the live path and
  // the recovery manifest decode the journaled frame itself. With no drafts
  // the sweep only stamps the frame, so no event and no checkpoint per frame.
  // A future reader registers canonicalizeFanslyWsObservation with a version
  // bump, and the sweep replays the journaled frames.
  {
    source: "fansly_ws", lane: "signals", kinds: [FANSLY_WS_CAPTURE_KIND], version: 1,
    canonicalize: () => [], canParse: canParseFanslyWsObservation,
    projectionOnly: true,
    // Its one writer (captureBrowserWsFrame) builds exactly the shape
    // canParseFanslyWsObservation accepts.
    stampOnly: { exceptKinds: [] },
  },
  { source:"ofapi_capture", lane:"read_collections", kinds:["ofapi.collection_read_response.v1"], version:1, canonicalize:canonicalizeOfapiReadObservation, canParse:canParseOfapiReadObservation, quarantine:classifyOfapiReadQuarantine, projectionOnly:true },
  {
    source: "ofapi_capture", lane: "ofapi-posts", kinds: ["ofapi.posts_page.v1"],
    version: ONLYFANS_POSTS_CANONICALIZER_VERSION, minimumParseVersion: 7,
    replayContext: "accepted_posts", projectionOnly: true,
    canonicalize: canonicalizeOnlyFansPostsObservation, canParse: canParseOnlyFansPostsObservation,
  },
  {
    source: "webhook",
    lane: "ofapi",
    kinds: [...OFAPI_WEBHOOK_CANONICALIZED_KINDS],
    version: OFAPI_WEBHOOK_CANONICALIZER_VERSION,
    canonicalize: canonicalizeOfapiWebhookObservation,
    quarantine: classifyOfapiWebhookQuarantine,
    canParse: observation => !(OFAPI_CONTENT_KINDS as readonly string[]).includes(observation.kind) || canonicalizeOfapiContentObservation(observation).length > 0,
    mixed: true,
  },
  {
    // Creator posts are projection material, not client-deliverable news.
    // Keep this BEFORE the broader pull family so kind=posts receives the
    // atomic projection checkpoint required by v2 replay gap validation.
    source: "pull",
    lane: "posts",
    kinds: [...POSTS_CANONICALIZED_KINDS],
    version: POSTS_CANONICALIZER_VERSION,
    canonicalize: canonicalizePostsObservation,
    canParse: canParsePostsObservation,
    parseRejection: diagnosePostsObservationRejection,
    projectionOnly: true,
  },
  {
    source: "pull",
    lane: "earnings",
    kinds: [...FANSLY_EARNINGS_KINDS],
    version: FANSLY_EARNINGS_CANONICALIZER_VERSION,
    prioritizeUnparsed: true,
    canonicalize: canonicalizeFanslyEarningsObservation,
    parse: parseFanslyEarningsObservation,
    projectionOnly: true,
  },
  {
    // WP-F0(b): deliverable message.* news AND the projection-only media plane
    // come out of ONE dm_messages observation, so this family is `mixed`.
    source: "pull",
    lane: "sync",
    kinds: [...SYNC_PULL_CANONICALIZED_KINDS],
    version: SYNC_PULL_CANONICALIZER_VERSION,
    prioritizeUnparsed: true,
    canonicalize: canonicalizeSyncPullObservation,
    canParse: canParseSyncPullObservation,
    parseRejection: diagnoseSyncPullObservationRejection,
    mixed: true,
  },
  {
    // WP-F1: the `stats_snapshot` lane. Projection-only throughout — traffic,
    // rankings, the revenue mix and the mass-DM surface are analytics, not
    // client-deliverable news. It sits BEFORE the broad sync family so its
    // kinds are claimed by it and not by a wider `pull` entry.
    source: "pull",
    lane: "stats",
    kinds: [...FANSLY_STATS_CANONICALIZED_KINDS],
    version: FANSLY_STATS_CANONICALIZER_VERSION,
    canonicalize: canonicalizeFanslyStatsObservation,
    canParse: canParseFanslyStatsObservation,
    parseRejection: diagnoseFanslyStatsObservationRejection,
    projectionOnly: true,
  },
  {
    // WP-F2: the `notifications` lane. Projection-only, and the ONE family
    // whose layer 1 emits a verbatim event for a code it cannot name — which
    // is what lets `platform_notifications` rebuild rows for codes the label
    // table gets wrong (it got eight of sixteen wrong; A22-1).
    source: "pull",
    lane: "engagement",
    kinds: [...FANSLY_ENGAGEMENT_CANONICALIZED_KINDS],
    version: FANSLY_ENGAGEMENT_CANONICALIZER_VERSION,
    canonicalize: canonicalizeFanslyEngagementObservation,
    canParse: canParseFanslyEngagementObservation,
    projectionOnly: true,
  },
  {
    // WP-F3: the `catalog` lane. Projection-only, and the ONE family that emits
    // an event about an ABSENCE — `catalog.listing_observed` carries the full
    // roster a listing served, which is what lets a rebuild derive
    // `missing_since` from the ledger instead of from whatever the sweep
    // happened to notice at the time.
    source: "pull",
    lane: "catalog",
    kinds: [...FANSLY_CATALOG_CANONICALIZED_KINDS],
    version: FANSLY_CATALOG_CANONICALIZER_VERSION,
    canonicalize: canonicalizeFanslyCatalogObservation,
    canParse: canParseFanslyCatalogObservation,
    projectionOnly: true,
  },
  {
    // WP-F5: the `post_replies` lane. Projection-only — a comment is a fact
    // about the archive, not news an SSE v2 client should be handed as it
    // happens. It is the one family whose observation payload is an ENVELOPE
    // (`{walk, response}`): the post id lives in the request PATH, so the
    // response that matters most — the empty one — cannot say which post it is
    // about, and a parser that could not answer that could never mark a
    // deleted comment missing.
    source: "pull",
    lane: "comments",
    kinds: [...FANSLY_COMMENTS_CANONICALIZED_KINDS],
    version: FANSLY_COMMENTS_CANONICALIZER_VERSION,
    canonicalize: canonicalizeFanslyCommentsObservation,
    canParse: canParseFanslyCommentsObservation,
    projectionOnly: true,
  },
  {
    // WP-F7: the `payouts` lane. Projection-only — money OUT is a fact about
    // the agency's own books, never news an SSE v2 client should be handed as
    // it happens. It is also the family with the strictest read on what it may
    // emit: `/payments/payoutmethods` carries the creator's payout CREDENTIALS
    // (provider 2 returns a plaintext email), and the ONLY thing derived from
    // that field which ever leaves this family is a mask this repository owns.
    source: "pull",
    lane: "payouts",
    kinds: [...FANSLY_PAYOUTS_CANONICALIZED_KINDS],
    version: FANSLY_PAYOUTS_CANONICALIZER_VERSION,
    canonicalize: canonicalizeFanslyPayoutsObservation,
    canParse: canParseFanslyPayoutsObservation,
    projectionOnly: true,
  },
  {
    // BL-C3: OFAPI link-stats pages (`ofapi-link-stats-sync.ts`) project
    // directly into `page_link_stat_runs` / `page_link_stat_snapshots` while
    // journaling `{ items, hasNextPage }` first. Registered as stamp-only so
    // `HEALTH_FLOOR_REGISTRY` tracks `obs_backlog_pull_link_stats_v1` and a
    // future version bump replays every captured page.
    source: "pull",
    lane: "link_stats",
    kinds: [...OFAPI_LINK_STATS_CANONICALIZED_KINDS],
    version: OFAPI_LINK_STATS_CANONICALIZER_VERSION,
    canonicalize: canonicalizeOfapiLinkStatsObservation,
    canParse: canParseOfapiLinkStatsObservation,
    projectionOnly: true,
    stampOnly: { exceptKinds: [] },
  },
  {
    source: "command_result",
    lane: "result",
    kinds: null,
    version: COMMAND_RESULT_CANONICALIZER_VERSION,
    canonicalize: canonicalizeCommandResultObservation,
  },
  // The OnlyFans feed from the chat extension on ChatSpace: what the page
  // already received becomes the message events every OnlyFans writer before
  // it minted (deliverable news under OFAPI's own keys, and the archive's
  // material) — mixed, like the webhook family.
  {
    source: "client_capture",
    lane: "onlyfans-feed",
    kinds: [CLIENT_ONLYFANS_FEED_OBSERVATION_KIND],
    version: CLIENT_ONLYFANS_FEED_CANONICALIZER_VERSION,
    canonicalize: canonicalizeClientOnlyfansFeedObservation,
    canParse: canParseClientOnlyfansFeedObservation,
    mixed: true,
  },
  // Registration + validation only — zero domain events by design
  // (desktop facts are not account-scoped platform truth).
  {
    source: "client_capture",
    lane: "desktop",
    kinds: [...CLIENT_CAPTURE_CANONICALIZED_KINDS],
    version: CLIENT_CAPTURE_CANONICALIZER_VERSION,
    canonicalize: canonicalizeClientCaptureObservation,
    stampOnly: { exceptKinds: CLIENT_CAPTURE_MINTING_KINDS },
  },
];

export function familyForObservation(
  observation: { source: string; kind: string; platform?: string | null },
): CanonicalizerFamily | null {
  for (const family of CANONICALIZER_FAMILIES) {
    if (family.source !== observation.source) {
      continue;
    }
    if (family.kinds === null || family.kinds.includes(observation.kind)) {
      return family;
    }
  }
  return null;
}

/**
 * The parse_version a writer stamps at INSERT for an observation its family
 * would only stamp (see `stampOnly`): the family's CURRENT version, so a later
 * bump replays it like any sweep-stamped row. Undefined — insert at 0 and let
 * the sweep decide, as before — for every other family, for a kind the
 * family can mint from, and for a kind no family claims (desktop.unknown:*).
 */
export function stampOnlyParseVersion(source: string, kind: string): number | undefined {
  const family = familyForObservation({ source, kind });
  if (family?.stampOnly === undefined || family.stampOnly.exceptKinds.includes(kind)) return undefined;
  return family.version;
}

/**
 * Explicit allowlist of written `(source, kind)` observations intentionally NOT
 * claimed by `CANONICALIZER_FAMILIES` (keyed by `${source}:${kind}`), each with
 * its rationale. Pinned by `tests/observation-kinds-ratchet.test.ts` so a new
 * observation writer can never silently land uncanonicalized without either a
 * registered family or an explicit documented raw-only decision (BL-C3).
 */
export const RAW_ONLY_OBSERVATION_KINDS: Readonly<Record<string, string>> = {
  // Direct OFAPI REST projections (written to dedicated tables; replay uses sync_raw_payloads / direct projectors):
  "pull:ofapi_chargebacks": "Direct OFAPI chargebacks projection (ofapi-chargebacks-sync.ts -> ofapi_chargebacks); raw pages preserved for future replay.",
  "pull:ofapi_users_list": "Direct OFAPI fan account-check projection (ofapi-fan-account-check.ts -> page_fans probe fields).",
  "pull:fans_active": "Direct OFAPI active-audience projection (ofapi-audience-sync.ts -> fans / page_fans).",
  "pull:dm_conversations": "Direct OFAPI DM conversation-list projection (ofapi-dm-sync.ts -> page_dm_threads).",
  "pull:link_lists_tracking_live": "Direct OFAPI link-discovery inventory journal (ofapi-fan-identities.ts).",
  "pull:link_lists_trial_live": "Direct OFAPI trial-link discovery inventory journal (ofapi-fan-identities.ts).",
  "pull:link_fans_tracking_subscribers": "Consumed by dedicated link-fans journal projector (ofapi-link-fans-projection.ts).",
  "pull:link_fans_tracking_spenders": "Consumed by dedicated link-fans journal projector (ofapi-link-fans-projection.ts).",
  "pull:link_fans_trial_subscribers": "Consumed by dedicated link-fans journal projector (ofapi-link-fans-projection.ts).",
  // Diagnostic / error / completion markers and dedicated-projector artifacts:
  "pull:ofapi.account.response": "OFAPI account error diagnostic journal (ofapi-credential-policy.ts).",
  "pull:account_lookup_public": "Direct public Fansly account lookup projection (sync/fansly/public-lookup.ts).",
  "pull:account_lookup_public:failed": "Failed public Fansly account lookup diagnostic envelope.",
  "client_capture:client.sale_sightings.v1": "Direct shift-handin sale sightings journal (shift-handin-check.ts); no domain events.",
  "webhook:ofapi.webhook.invalid_identity": "Quarantined OFAPI webhook envelope with invalid identity header.",
  "webhook:ofapi.webhook.malformed": "Quarantined malformed OFAPI webhook envelope.",
  "webhook:ofapi.webhook.fact_conflict": "Quarantined OFAPI webhook payload hash conflict record.",
  "webhook:ofapi_webhook_lineage_backfill": "Lineage backfill reconstruction audit journal (dm-corrections-lineage-intake.ts).",
  "fansly_ws:fansly.ws.frame.v1:refused": "Refused Fansly WS frame kept unstamped for inspection.",
  "ofapi_capture:ofapi.export_artifact_pointer.v1": "OFAPI export artifact pointer (consumed by export materializer, not domain-event sweep).",
  "ofapi_capture:ofapi.typed_export_artifact.v1": "OFAPI typed export artifact blob (consumed synchronously by ofapi-typed-exports.ts).",
};

import { OFAPI_CONTENT_KINDS, canonicalizeOfapiContentObservation } from "./ofapi-content-events.ts";
import { canonicalizeOfapiReadObservation, canParseOfapiReadObservation } from "./ofapi-read-collections.ts";
// Canonicalizer registry (Stage 8). The driver job and the parse_version
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
} from "./types.ts";
import { canonicalizeOnlyFansPostsObservation, canParseOnlyFansPostsObservation } from "./onlyfans-post-media.ts";
import {
  canonicalizeClientCaptureObservation,
  CLIENT_CAPTURE_CANONICALIZED_KINDS,
  CLIENT_CAPTURE_CANONICALIZER_VERSION,
} from "./client-capture.ts";
import {
  canonicalizeOfapiWebhookObservation,
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
  canonicalizeFanslyPayoutsObservation,
  canParseFanslyPayoutsObservation,
  FANSLY_PAYOUTS_CANONICALIZED_KINDS,
  FANSLY_PAYOUTS_CANONICALIZER_VERSION,
} from "./fansly-payouts.ts";

interface CanonicalizerFamilyBase {
  source: "webhook" | "pull" | "command_result" | "client_capture" | "ofapi_capture";
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
  { source:"ofapi_capture", lane:"read_collections", kinds:["ofapi.collection_read_response.v1"], version:1, canonicalize:canonicalizeOfapiReadObservation, canParse:canParseOfapiReadObservation, projectionOnly:true },
  {
    source: "ofapi_capture", lane: "ofapi-posts", kinds: ["ofapi.posts_page.v1"],
    version: POSTS_CANONICALIZER_VERSION, minimumParseVersion: 7,
    replayContext: "accepted_posts", projectionOnly: true,
    canonicalize: canonicalizeOnlyFansPostsObservation, canParse: canParseOnlyFansPostsObservation,
  },
  {
    source: "webhook",
    lane: "ofapi",
    kinds: [...OFAPI_WEBHOOK_CANONICALIZED_KINDS],
    version: OFAPI_WEBHOOK_CANONICALIZER_VERSION,
    canonicalize: canonicalizeOfapiWebhookObservation,
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
    source: "command_result",
    lane: "result",
    kinds: null,
    version: COMMAND_RESULT_CANONICALIZER_VERSION,
    canonicalize: canonicalizeCommandResultObservation,
  },
  // Stage 11: registration + validation only — zero domain events by design
  // (desktop facts are not account-scoped platform truth until Stage 29).
  {
    source: "client_capture",
    lane: "desktop",
    kinds: [...CLIENT_CAPTURE_CANONICALIZED_KINDS],
    version: CLIENT_CAPTURE_CANONICALIZER_VERSION,
    canonicalize: canonicalizeClientCaptureObservation,
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

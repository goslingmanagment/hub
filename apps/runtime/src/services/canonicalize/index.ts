// Canonicalizer registry (Stage 8). The driver job and the parse_version
// sweep dispatch on observation.source through this table; a family's
// `kinds` (null = every kind of that source, filtered inside the function)
// scopes which observations the sweep picks up, and `version` is the
// parse_version stamped after consumption. Bumping a family's version makes
// the sweep revisit its kinds — replay is the steady-state mechanism.

import type { CanonicalizableObservation, Canonicalizer } from "./types.ts";
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
  canonicalizeSyncPullObservation,
  SYNC_PULL_CANONICALIZED_KINDS,
  SYNC_PULL_CANONICALIZER_VERSION,
} from "./sync-pull.ts";
import {
  canParsePostsObservation,
  canonicalizePostsObservation,
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
  FANSLY_STATS_CANONICALIZED_KINDS,
  FANSLY_STATS_CANONICALIZER_VERSION,
} from "./fansly-stats.ts";

export interface CanonicalizerFamily {
  source: "webhook" | "pull" | "command_result" | "client_capture";
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
  canonicalize: Canonicalizer;
  /**
   * Shape gate. `false` = the payload matches NO shape this family knows, so
   * the row is left UNSTAMPED for a future parser instead of being consumed
   * with zero events. Without it a drifted payload is indistinguishable from a
   * legitimately EMPTY snapshot, and "capture now, parse later" quietly
   * becomes "capture now, never parse". Families without drift risk omit it.
   */
  canParse?: (observation: CanonicalizableObservation) => boolean;
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

export const CANONICALIZER_FAMILIES: readonly CanonicalizerFamily[] = [
  {
    source: "webhook",
    lane: "ofapi",
    kinds: [...OFAPI_WEBHOOK_CANONICALIZED_KINDS],
    version: OFAPI_WEBHOOK_CANONICALIZER_VERSION,
    canonicalize: canonicalizeOfapiWebhookObservation,
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
    projectionOnly: true,
  },
  {
    // WP-F0(b): deliverable message.* news AND the projection-only media plane
    // come out of ONE dm_messages observation, so this family is `mixed`.
    source: "pull",
    lane: "sync",
    kinds: [...SYNC_PULL_CANONICALIZED_KINDS],
    version: SYNC_PULL_CANONICALIZER_VERSION,
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

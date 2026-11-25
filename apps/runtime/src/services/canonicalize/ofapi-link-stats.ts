import {
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
} from "./types.ts";

/**
 * OFAPI tracking/trial link-stats pull observations (`ofapi-link-stats-sync.ts`).
 *
 * The worker projects every fetched page directly into `page_link_stat_runs` +
 * `page_link_stat_snapshots` while journaling the untrimmed `{ items, hasNextPage }`
 * envelope first. Registering the family here gives both kinds a health-floor
 * gauge (`obs_backlog_pull_link_stats_v1`), a shape gate matching the producer,
 * and a replay hook (bump `OFAPI_LINK_STATS_CANONICALIZER_VERSION` if a future
 * domain event / rebuild consumer attaches to this journal).
 */
export const OFAPI_LINK_STATS_CANONICALIZER_VERSION = 1;

export const OFAPI_LINK_STATS_CANONICALIZED_KINDS = [
  "link_stats_tracking",
  "link_stats_trial",
] as const;

const LINK_STATS_KIND_SET: ReadonlySet<string> = new Set(OFAPI_LINK_STATS_CANONICALIZED_KINDS);

export function canParseOfapiLinkStatsObservation(observation: CanonicalizableObservation): boolean {
  return observation.source === "pull"
    && LINK_STATS_KIND_SET.has(observation.kind)
    && isRecord(observation.payload)
    && Array.isArray(observation.payload.items)
    && typeof observation.payload.hasNextPage === "boolean";
}

export function canonicalizeOfapiLinkStatsObservation(
  _observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  return [];
}

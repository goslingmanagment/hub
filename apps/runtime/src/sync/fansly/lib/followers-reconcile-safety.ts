import { createHash } from "node:crypto";

import type { PageFollowDeactivationCandidate } from "@agency_hub_core/db";

export type FollowersReconcileCandidateGenerationBucket = {
  lastSeenGeneration: number | null;
  count: number;
};

export function followersReconcileDeactivationLimit(activeFollowerCount: number) {
  return Math.max(50, Math.floor(activeFollowerCount / 100));
}

/**
 * How many unseen follows a proven sweep may still retire past the per-sweep
 * limit, or null: none. The limit guards against a list that shrank (a cut or
 * self-consistent answer). Past it, the excess is churn that piled up while
 * sweeps were withheld or held — when Fansly's own count has not fallen since
 * the page's previous stated count by more than the limit, the list did not
 * shrink. A tenth of the page stays the ceiling either way; above it, or after
 * a fall, the owner looks (the blast-radius quarantine).
 */
export function followersReconcileBacklogCeiling(input: {
  activeFollowerCount: number;
  sourceFollowerCount: number | null;
  previousSourceFollowerCount: number | null;
  deactivationLimit: number;
}): number | null {
  const { sourceFollowerCount, previousSourceFollowerCount, deactivationLimit } = input;
  if (sourceFollowerCount === null || previousSourceFollowerCount === null) return null;
  if (sourceFollowerCount < previousSourceFollowerCount - deactivationLimit) return null;
  return Math.max(deactivationLimit, Math.floor(input.activeFollowerCount / 10));
}

/** Stable approval fingerprint. The surrogate ids never leave the API; only
 *  this digest does. Sorting here makes the binding independent of a caller's
 *  query plan while still committing to every exact row the UPDATE may touch. */
export function followersReconcileCandidateSha256(
  candidates: readonly Pick<PageFollowDeactivationCandidate, "id">[],
) {
  const ids = candidates.map((candidate) => candidate.id).sort((left, right) => left - right);
  return createHash("sha256").update(ids.map(String).join("\n")).digest("hex");
}

export function followersReconcileCandidateGenerationBuckets(
  candidates: readonly PageFollowDeactivationCandidate[],
): FollowersReconcileCandidateGenerationBucket[] {
  const counts = new Map<number | null, number>();
  for (const candidate of candidates) {
    counts.set(candidate.lastSeenGeneration, (counts.get(candidate.lastSeenGeneration) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => {
      if (left === null) return right === null ? 0 : -1;
      if (right === null) return 1;
      return left - right;
    })
    .map(([lastSeenGeneration, count]) => ({ lastSeenGeneration, count }));
}

import { z } from "zod";
import { DM_SHADOW_WITNESS_LIMIT, dmShadowWitnessSchema } from "./dm-shadow-witness.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const dmShadowPolicySchema = z.object({
  depth: z.number().int().min(1).max(20),
  overlapMs: z.number().int().min(0).max(86_400_000),
});

export const DEFAULT_DM_SHADOW_POLICY = { depth: 3, overlapMs: 60_000 };
export type DmShadowPolicy = z.infer<typeof dmShadowPolicySchema>;

// Bounded scalars and at most 20 capture pointers travel in the cursor.
// No conversation IDs or payloads are copied into checkpoint state.
export const dmShadowStateSchema = z.object({
  version: z.literal(1),
  depth: dmShadowPolicySchema.shape.depth,
  overlapMs: dmShadowPolicySchema.shape.overlapMs,
  boundaryMs: count.nullable(),
  startedAtMs: count,
  lastObservedAtMs: count,
  pageCount: count,
  unchangedStreak: count,
  stopPage: count.nullable(),
  pagesBelowStop: count,
  bytesBelowStop: count,
  conversationsBelowStop: count,
  newHeadsBelowStop: count,
  changedHeadsBelowStop: count,
  stateChangesBelowStop: count,
  unreadChangesBelowStop: count,
  flagsChangesBelowStop: count,
  // A resumed legacy sweep has no earlier counts for these categories.
  // Only measurement from the sweep's start gets zero; null remains unknown on resume.
  visibilityChangesBelowStop: count.nullable().default(null),
  unresolvedIdentityChangesBelowStop: count.nullable().default(null),
  exclusionReasonChangesBelowStop: count.nullable().default(null),
  subscriptionTierChangesBelowStop: count.nullable().default(null),
  headTimestampChangesBelowStop: count.nullable().default(null),
  headSenderChangesBelowStop: count.nullable().default(null),
  headRollbacksBelowStop: count,
  missingHotHeadsBelowStop: count,
  // Absent on older cursors: never invent reader evidence for earlier pages.
  readerHeadsChecked: count.nullable().default(null),
  unknownReaderHeadChecks: count.nullable().default(null),
  readerMaterializedHeadsBelowStop: count.nullable().default(null),
  readerMissingHeadsBelowStop: count.nullable().default(null),
  readerDeletedHeadsBelowStop: count.nullable().default(null),
  readerPendingHeadsBelowStop: count.nullable().default(null),
  readerArchiveOnlyHeadsBelowStop: count.nullable().default(null),
  readerWitnesses: z.array(dmShadowWitnessSchema).max(DM_SHADOW_WITNESS_LIMIT).nullable().default(null),
  readerWitnessesOmitted: count.nullable().default(null),
  materialLagSamples: count,
  maxDiscoveryToCaptureMs: count,
  unknownMaterialChecks: count,
  invalidMarkers: count,
  invalidMarkersBelowStop: count,
  timestampTies: count,
  previousTimestampMs: count.nullable(),
  maxUnconfirmedHeadAgeMs: count,
  pendingHistoryCount: count,
  unknownHistoryAgeCount: count,
  maxHistorySyncAgeMs: count,
  resumes: count,
  maxObservationGapMs: count,
  completeCoverage: z.boolean(),
});

export type DmShadowState = z.infer<typeof dmShadowStateSchema>;

export function parseDmShadowState(value: unknown): DmShadowState | undefined {
  const parsed = dmShadowStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function createDmShadowState(input: {
  startedAtMs: number;
  boundaryMs: number | null;
  completeCoverage: boolean;
  policy?: DmShadowPolicy;
}): DmShadowState {
  const policy = dmShadowPolicySchema.parse(input.policy ?? DEFAULT_DM_SHADOW_POLICY);
  const reasonCount = input.completeCoverage ? 0 : null;
  return {
    version: 1,
    ...policy,
    boundaryMs: input.boundaryMs,
    startedAtMs: input.startedAtMs,
    lastObservedAtMs: input.startedAtMs,
    pageCount: 0,
    unchangedStreak: 0,
    stopPage: null,
    pagesBelowStop: 0,
    bytesBelowStop: 0,
    conversationsBelowStop: 0,
    newHeadsBelowStop: 0,
    changedHeadsBelowStop: 0,
    stateChangesBelowStop: 0,
    unreadChangesBelowStop: 0,
    flagsChangesBelowStop: 0,
    visibilityChangesBelowStop: reasonCount,
    unresolvedIdentityChangesBelowStop: reasonCount,
    exclusionReasonChangesBelowStop: reasonCount,
    subscriptionTierChangesBelowStop: reasonCount,
    headTimestampChangesBelowStop: reasonCount,
    headSenderChangesBelowStop: reasonCount,
    headRollbacksBelowStop: 0,
    missingHotHeadsBelowStop: 0,
    readerHeadsChecked: reasonCount,
    unknownReaderHeadChecks: reasonCount,
    readerMaterializedHeadsBelowStop: reasonCount,
    readerMissingHeadsBelowStop: reasonCount,
    readerDeletedHeadsBelowStop: reasonCount,
    readerPendingHeadsBelowStop: reasonCount,
    readerArchiveOnlyHeadsBelowStop: reasonCount,
    readerWitnesses: input.completeCoverage ? [] : null,
    readerWitnessesOmitted: reasonCount,
    materialLagSamples: 0,
    maxDiscoveryToCaptureMs: 0,
    unknownMaterialChecks: 0,
    invalidMarkers: 0,
    invalidMarkersBelowStop: 0,
    timestampTies: 0,
    previousTimestampMs: null,
    maxUnconfirmedHeadAgeMs: 0,
    pendingHistoryCount: 0,
    unknownHistoryAgeCount: 0,
    maxHistorySyncAgeMs: 0,
    resumes: 0,
    maxObservationGapMs: 0,
    completeCoverage: input.completeCoverage,
  };
}

/** The three existing OR branches. `exhaustedWithoutKnown` means the walk
 *  ended without the known follow: it ran off the list or stopped at the first
 *  row older than it. The note keeps its shape for the diagnostics SQL. */
export function followersReconcileDecision(input: {
  activeFollowerCount: number;
  sourceFollowerCount: number;
  knownFollowId: string | null;
  newestFollowId: string | null;
  pageDone: boolean;
  crossedKnownBoundary: boolean;
  sawKnownCheckpoint: boolean;
  processedThisChunk: number;
}) {
  const countMismatch = input.activeFollowerCount !== input.sourceFollowerCount;
  const exhaustedWithoutKnown = Boolean(input.knownFollowId)
    && (input.pageDone || input.crossedKnownBoundary) && !input.sawKnownCheckpoint;
  const unchangedHeadWithRows = Boolean(input.knownFollowId)
    && input.newestFollowId === input.knownFollowId && input.processedThisChunk > 0;
  return {
    countMismatch,
    exhaustedWithoutKnown,
    unchangedHeadWithRows,
    requested: countMismatch || exhaustedWithoutKnown || unchangedHeadWithRows,
  };
}

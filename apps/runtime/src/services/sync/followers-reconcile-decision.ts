/** The three existing OR branches, named without changing their semantics. */
export function followersReconcileDecision(input: {
  activeFollowerCount: number;
  sourceFollowerCount: number;
  knownFollowId: string | null;
  newestFollowId: string | null;
  pageDone: boolean;
  sawKnownCheckpoint: boolean;
  processedThisChunk: number;
}) {
  const countMismatch = input.activeFollowerCount !== input.sourceFollowerCount;
  const exhaustedWithoutKnown = Boolean(input.knownFollowId)
    && input.pageDone && !input.sawKnownCheckpoint;
  const unchangedHeadWithRows = Boolean(input.knownFollowId)
    && input.newestFollowId === input.knownFollowId && input.processedThisChunk > 0;
  return {
    countMismatch,
    exhaustedWithoutKnown,
    unchangedHeadWithRows,
    requested: countMismatch || exhaustedWithoutKnown || unchangedHeadWithRows,
  };
}

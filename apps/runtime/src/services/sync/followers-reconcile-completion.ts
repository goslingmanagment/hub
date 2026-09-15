import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const completedState = z.object({
  revision: count,
  generation: count,
  fullSweepStartedAt: z.iso.datetime(),
  observedCount: count,
  pageCount: count.positive(),
  sourceFollowerCount: count,
  verificationPending: z.literal(false),
  completion: z.object({
    version: z.literal(1),
    runId: count.positive(),
    completedAt: z.iso.datetime(),
    membershipProof: z.enum(["exact_generation", "new_followers_seen_during_sweep"]),
    generationObservedCount: count,
  }),
});

/** Only a certified terminal commit for this exact request can be settled again. */
export function readFollowersReconcileCompletion(checkpoint: {
  state: unknown;
  cursorSeq: number | null;
  cursorLastSucceededRunId: number | null;
  cursorLastSucceededAt: Date | null;
} | null, revision: number, now: Date) {
  if (checkpoint?.cursorSeq !== revision) return null;
  const parsed = completedState.safeParse(checkpoint.state);
  if (!parsed.success) return null;
  const state = parsed.data;
  const proof = state.completion;
  const at = Date.parse(proof.completedAt);
  if (state.revision !== revision || proof.runId !== checkpoint.cursorLastSucceededRunId ||
    at !== checkpoint.cursorLastSucceededAt?.getTime() || at > now.getTime() ||
    Date.parse(state.fullSweepStartedAt) > at ||
    proof.generationObservedCount > state.observedCount ||
    (proof.membershipProof === "exact_generation"
      ? proof.generationObservedCount !== state.sourceFollowerCount
      : proof.generationObservedCount >= state.sourceFollowerCount)) return null;
  return {
    succeededAt: new Date(at),
    stats: {
      generation: state.generation, pageCount: state.pageCount, processedThisChunk: 0,
      sourceFollowerCount: state.sourceFollowerCount,
      generationObservedCount: proof.generationObservedCount,
      membershipProof: proof.membershipProof, destructiveFinalization: true,
      reusedCompletedWalk: true,
    },
  };
}

import { createHash } from "node:crypto";

/**
 * G2 slice 2 — the dual proof for the Fansly dm_conversations sweep.
 *
 * The sweep's authority WAS `snapshotConversationIds`: every group id it had
 * seen, accumulated in `page_sync_cursors.state` and rewritten on every page
 * (O(N²) bytes across a sweep). This module produced the production evidence
 * that the row-side generation set reproduces that array exactly; G3 acted on
 * the evidence and removed the array, so the id-set comparison below no longer
 * runs inside the sweep. It is RETAINED for replaying archived v1 states (the
 * checkpoints and telemetry that recorded the array are still on disk), and
 * because the count-shaped erasure predicate the live sweep does use is
 * derived from it — one definition of "only a shortfall can be an erasure",
 * not two.
 */

/** Differing-id samples are capped: an anomaly payload must stay bounded even
 *  when the two representations disagree about thousands of threads. */
export const DM_SWEEP_DUAL_PROOF_SAMPLE_LIMIT = 3;

export const DM_SWEEP_DUAL_PROOF_ANOMALY_CODE = "dm_conversations_dual_proof_mismatch";
export const DM_SWEEP_DUAL_PROOF_PAGE_NOTE_CODE = "dm_conversations_dual_proof_page_divergence";
export const DM_SWEEP_DUAL_PROOF_ERASURE_NOTE_CODE = "dm_conversations_dual_proof_erasure_delta";

/**
 * sha256 over the SET of ids: sorted and de-duplicated, so the digest depends
 * only on membership and not on the order the two sources happened to produce
 * (the array is offset-page order, the index read is id order). Duplicates
 * still surface — they change the counts, which are compared separately.
 *
 * Each id is netstring-framed by its UTF-8 BYTE length, not merely separated:
 * a plain separator is ambiguous the moment an id can contain that separator
 * (`["a","b\nc"]` and `["a\nb","c"]` serialize identically under newline
 * separation). Framing by byte length — the same unit the hash consumes —
 * makes the serialization injective for any id content whatsoever.
 */
export function digestDmSweepMembership(conversationIds: readonly string[]) {
  const hash = createHash("sha256");
  for (const conversationId of [...new Set(conversationIds)].sort()) {
    const encoded = Buffer.from(conversationId, "utf8");
    hash.update(`${encoded.length}:`);
    hash.update(encoded);
  }
  return hash.digest("hex");
}

export interface DmSweepDualProofVerdict {
  ok: boolean;
  snapshotCount: number;
  generationSetCount: number;
  /** Reporting artifacts only — `ok` is decided by the set differences and the
   *  counts below, never by digest equality. A digest is a fingerprint that
   *  travels well in a telemetry payload; it is not the comparison. */
  snapshotDigest: string;
  generationSetDigest: string;
  /** Bounded, sorted samples — never the full difference. */
  missingFromGenerationSet: string[];
  missingFromSnapshot: string[];
  missingFromGenerationSetCount: number;
  missingFromSnapshotCount: number;
}

function boundedSortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const difference: string[] = [];
  for (const value of left) {
    if (!right.has(value)) {
      difference.push(value);
    }
  }
  difference.sort();
  return {
    sample: difference.slice(0, DM_SWEEP_DUAL_PROOF_SAMPLE_LIMIT),
    count: difference.length,
  };
}

export function compareDmSweepMembership(input: {
  snapshotConversationIds: readonly string[];
  generationSetConversationIds: readonly string[];
}): DmSweepDualProofVerdict {
  const snapshotSet = new Set(input.snapshotConversationIds);
  const generationSet = new Set(input.generationSetConversationIds);
  const missingFromGenerationSet = boundedSortedDifference(snapshotSet, generationSet);
  const missingFromSnapshot = boundedSortedDifference(generationSet, snapshotSet);
  const snapshotDigest = digestDmSweepMembership(input.snapshotConversationIds);
  const generationSetDigest = digestDmSweepMembership(input.generationSetConversationIds);

  return {
    // Decided by the actual set differences plus the raw lengths, NOT by
    // digest equality: a digest collision (or any future framing bug) must not
    // be able to pronounce two different sets equal. The differences catch
    // membership drift; the length compare catches a duplicate inside one
    // source, which leaves both digests equal.
    ok: missingFromGenerationSet.count === 0 &&
      missingFromSnapshot.count === 0 &&
      input.snapshotConversationIds.length === input.generationSetConversationIds.length,
    snapshotCount: input.snapshotConversationIds.length,
    generationSetCount: input.generationSetConversationIds.length,
    snapshotDigest,
    generationSetDigest,
    missingFromGenerationSet: missingFromGenerationSet.sample,
    missingFromSnapshot: missingFromSnapshot.sample,
    missingFromGenerationSetCount: missingFromGenerationSet.count,
    missingFromSnapshotCount: missingFromSnapshot.count,
  };
}

/**
 * The count-shaped form, and the one the live (v2) sweep uses: an erasure can
 * only ever REMOVE stamped rows, so the generation set may trail the count of
 * ids the sweep observed and never exceed it. A surplus is never erasure-
 * shaped — it means the sweep's own count is wrong — and equality is not a
 * shortfall at all.
 *
 * Being count-only, this is a necessary condition, not a sufficient one: the
 * caller still has to find an erasure that actually touched the page inside
 * the sweep window before it may tolerate the gap.
 */
export function isDmSweepErasureShapedCountShortfall(input: {
  observedCount: number;
  generationSetCount: number;
}) {
  return input.generationSetCount < input.observedCount;
}

/**
 * The id-set form (v1 replay). Only a shortfall an erasure could actually have
 * produced qualifies: the Stage-28 module DELETES stamped rows, so every
 * missing row must show up as an id the array holds and the generation set
 * does not (no extras the other way), and the whole count gap must be
 * accounted for by exactly those ids — a gap wider than the missing set means
 * something else (a duplicated id in the array) is also in play, and that is
 * not an erasure.
 */
export function isDmSweepErasureShapedShortfall(verdict: DmSweepDualProofVerdict) {
  return !verdict.ok &&
    isDmSweepErasureShapedCountShortfall({
      observedCount: verdict.snapshotCount,
      generationSetCount: verdict.generationSetCount,
    }) &&
    verdict.missingFromSnapshotCount === 0 &&
    verdict.missingFromGenerationSetCount > 0 &&
    verdict.snapshotCount - verdict.generationSetCount === verdict.missingFromGenerationSetCount;
}

/** The bounded anomaly payload — scalars plus two capped id samples. */
export function buildDmSweepDualProofAnomalyDetails(input: {
  verdict: DmSweepDualProofVerdict;
  generation: number;
  pageCount: number;
}) {
  return {
    generation: input.generation,
    pageCount: input.pageCount,
    snapshotCount: input.verdict.snapshotCount,
    generationSetCount: input.verdict.generationSetCount,
    snapshotDigest: input.verdict.snapshotDigest,
    generationSetDigest: input.verdict.generationSetDigest,
    missingFromGenerationSetCount: input.verdict.missingFromGenerationSetCount,
    missingFromSnapshotCount: input.verdict.missingFromSnapshotCount,
    missingFromGenerationSet: input.verdict.missingFromGenerationSet,
    missingFromSnapshot: input.verdict.missingFromSnapshot,
  };
}

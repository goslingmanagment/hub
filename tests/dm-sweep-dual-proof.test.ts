// G2 slice 2: the digest that will justify the G3 cutover. It must depend on
// SET MEMBERSHIP alone — the cumulative cursor array arrives in offset-page
// order, the index read arrives in id order, and neither ordering may decide
// whether the two representations agree.

import { describe, expect, it } from "vitest";

import {
  buildDmSweepDualProofAnomalyDetails,
  compareDmSweepMembership,
  digestDmSweepMembership,
  isDmSweepErasureShapedShortfall,
  DM_SWEEP_DUAL_PROOF_SAMPLE_LIMIT,
} from "../apps/runtime/src/services/sync/dm-sweep-dual-proof.ts";

describe("dm sweep dual proof digest", () => {
  it("is deterministic and order-independent for the same set", () => {
    const digest = digestDmSweepMembership(["group-3", "group-1", "group-2"]);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digestDmSweepMembership(["group-3", "group-1", "group-2"])).toBe(digest);
    expect(digestDmSweepMembership(["group-1", "group-2", "group-3"])).toBe(digest);
    expect(digestDmSweepMembership(["group-2", "group-3", "group-1"])).toBe(digest);
    // Duplicates do not change membership; the counts catch them instead.
    expect(digestDmSweepMembership(["group-1", "group-1", "group-2", "group-3"])).toBe(digest);
  });

  it("frames ids so a concatenation cannot collide", () => {
    expect(digestDmSweepMembership(["ab", "c"])).not.toBe(digestDmSweepMembership(["a", "bc"]));
  });

  it("cannot be forged by an id containing the framing characters", () => {
    // Under plain separator framing these two DIFFERENT sets serialized to the
    // same bytes and carried equal counts, so `ok` passed on distinct sets.
    const snapshotConversationIds = ["a", "b\nc"];
    const generationSetConversationIds = ["a\nb", "c"];

    expect(digestDmSweepMembership(snapshotConversationIds))
      .not.toBe(digestDmSweepMembership(generationSetConversationIds));

    const verdict = compareDmSweepMembership({
      snapshotConversationIds,
      generationSetConversationIds,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.snapshotCount).toBe(2);
    expect(verdict.generationSetCount).toBe(2);
    expect(verdict.missingFromGenerationSet).toEqual(["a", "b\nc"]);
    expect(verdict.missingFromSnapshot).toEqual(["a\nb", "c"]);
  });

  it("decides ok from the set differences, not from digest equality", () => {
    // A digest is a reporting artifact. Even if two digests agreed, a set
    // difference must still veto the verdict — this pins that ordering of
    // authority by asserting on the differences that produced `ok`.
    const verdict = compareDmSweepMembership({
      snapshotConversationIds: ["group-1", "group-2"],
      generationSetConversationIds: ["group-1", "group-3"],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.snapshotCount).toBe(verdict.generationSetCount);
    expect(verdict.missingFromGenerationSet).toEqual(["group-2"]);
    expect(verdict.missingFromSnapshot).toEqual(["group-3"]);
  });

  it("changes when a single id changes", () => {
    expect(digestDmSweepMembership(["group-1", "group-2"]))
      .not.toBe(digestDmSweepMembership(["group-1", "group-9"]));
  });

  it("agrees across the two representations of an identical sweep", () => {
    const verdict = compareDmSweepMembership({
      snapshotConversationIds: ["group-3", "group-1", "group-2"],
      generationSetConversationIds: ["group-1", "group-2", "group-3"],
    });

    expect(verdict).toMatchObject({
      ok: true,
      snapshotCount: 3,
      generationSetCount: 3,
      missingFromGenerationSet: [],
      missingFromSnapshot: [],
      missingFromGenerationSetCount: 0,
      missingFromSnapshotCount: 0,
    });
    expect(verdict.snapshotDigest).toBe(verdict.generationSetDigest);
  });

  it("fails a duplicate-inflated snapshot on counts even though the digests match", () => {
    const verdict = compareDmSweepMembership({
      snapshotConversationIds: ["group-1", "group-1", "group-2"],
      generationSetConversationIds: ["group-1", "group-2"],
    });

    expect(verdict.snapshotDigest).toBe(verdict.generationSetDigest);
    expect(verdict).toMatchObject({ ok: false, snapshotCount: 3, generationSetCount: 2 });
    // Nothing is actually missing on either side, so this is NOT erasure shaped.
    expect(verdict.missingFromGenerationSetCount).toBe(0);
    expect(isDmSweepErasureShapedShortfall(verdict)).toBe(false);
  });

  it("bounds the differing-id samples and reports the true difference sizes", () => {
    const snapshotConversationIds = Array.from({ length: 40 }, (_, index) => `group-${index}`);
    const verdict = compareDmSweepMembership({
      snapshotConversationIds,
      generationSetConversationIds: ["group-extra"],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.missingFromGenerationSetCount).toBe(40);
    expect(verdict.missingFromGenerationSet).toHaveLength(DM_SWEEP_DUAL_PROOF_SAMPLE_LIMIT);
    // Sorted, so the sample is reproducible run to run.
    expect(verdict.missingFromGenerationSet).toEqual(["group-0", "group-1", "group-10"]);
    expect(verdict.missingFromSnapshot).toEqual(["group-extra"]);
  });

  it("calls only a no-extras shortfall erasure shaped", () => {
    const shortfall = compareDmSweepMembership({
      snapshotConversationIds: ["group-1", "group-2"],
      generationSetConversationIds: ["group-1"],
    });
    const stowaway = compareDmSweepMembership({
      snapshotConversationIds: ["group-1"],
      generationSetConversationIds: ["group-1", "group-2"],
    });
    const swap = compareDmSweepMembership({
      snapshotConversationIds: ["group-1", "group-2"],
      generationSetConversationIds: ["group-1", "group-3"],
    });

    expect(isDmSweepErasureShapedShortfall(shortfall)).toBe(true);
    expect(isDmSweepErasureShapedShortfall(stowaway)).toBe(false);
    expect(isDmSweepErasureShapedShortfall(swap)).toBe(false);
  });

  it("builds a bounded anomaly payload of scalars plus capped samples", () => {
    const verdict = compareDmSweepMembership({
      snapshotConversationIds: Array.from({ length: 500 }, (_, index) => `group-${index}`),
      generationSetConversationIds: [],
    });
    const details = buildDmSweepDualProofAnomalyDetails({
      verdict,
      generation: 7,
      pageCount: 5,
    });

    expect(Object.keys(details).sort()).toEqual([
      "generation",
      "generationSetCount",
      "generationSetDigest",
      "missingFromGenerationSet",
      "missingFromGenerationSetCount",
      "missingFromSnapshot",
      "missingFromSnapshotCount",
      "pageCount",
      "snapshotCount",
      "snapshotDigest",
    ]);
    expect(details.missingFromGenerationSet).toHaveLength(DM_SWEEP_DUAL_PROOF_SAMPLE_LIMIT);
    expect(details.missingFromSnapshot).toEqual([]);
    expect(details.missingFromGenerationSetCount).toBe(500);
    // The whole payload stays small no matter how wide the divergence is.
    expect(JSON.stringify(details).length).toBeLessThan(500);
  });
});

import { describe, expect, it } from "vitest";

import { nextVaultCursor } from "../apps/runtime/src/sync/fansly/lib/catalog-rules.ts";
import { observeVaultWalkPage, parseVaultWalkProof, vaultWalkIsComplete, type VaultWalkProof } from "../apps/runtime/src/sync/fansly/lib/vault-walk-proof.ts";

// These are adversarial checks of proposed optimizations, not claims of existing
// engine defects. Pure helpers only: no DB, transport, credentials or Fansly calls.
const proof = (refs: string[], expectedCount = refs.length): VaultWalkProof => ({
  walkRef: "audit-proof", startedAt: "2026-10-08T00:00:00Z", expectedCount,
  headRef: "X", seenMediaRefs: refs, observationRefs: [1], valid: true,
});

describe("vault optimization constraints", () => {
  it("requires a versioned completed-summary format, not deleting arrays in place", () => {
    const full = proof(["A", "B"]);
    expect(parseVaultWalkProof(full)).toEqual(full);
    const { seenMediaRefs: _refs, observationRefs: _observations, ...stripped } = full;
    expect(parseVaultWalkProof(stripped)).toBeUndefined();
  });

  it("needs active inventory identity to detect a duplicate across pages", () => {
    const next = observeVaultWalkPage(proof(["A"], 2), "album", [
      { id: "different-membership", albumId: "album", mediaId: "A" },
    ], 2);
    expect(next.valid).toBe(false);
    expect(next.seenMediaRefs).toEqual(["A"]);
  });

  it("pages by membership ID when old media is newly added at the head", () => {
    // Source: retained observation 3411370, first membership row. The media ID
    // is older than the previous proof's header; its membership ID is newer.
    const newMembership = { id: "963263974470606849", mediaId: "917940531491782657" };
    expect(BigInt(newMembership.mediaId)).toBeLessThan(BigInt("962792280748474368"));
    expect(nextVaultCursor([newMembership])).toBe(newMembership.id);
    expect(nextVaultCursor([newMembership])).not.toBe(newMembership.mediaId);
  });

  it("refutes count reconciliation as proof of the unseen suffix", () => {
    const previous = ["A", "B", "C", "D"];
    const currentActual = ["X", "A", "Y", "C", "D"];
    const fetchedPrefix = ["X", "A"]; // stop at first known A
    const additions = fetchedPrefix.filter(ref => !previous.includes(ref));
    const inferredInventory = [...additions, ...previous];

    expect(previous.length + additions.length).toBe(currentActual.length);
    // Minting today's full-walk proof from this inferred inventory would pass
    // the current completeness helper, while omitting Y and retaining gone B.
    expect(vaultWalkIsComplete(proof(inferredInventory), { itemCount: 5, lastItemRef: "X" })).toBe(true);
    expect(inferredInventory).not.toEqual(currentActual);
    expect(inferredInventory).not.toContain("Y");
    expect(inferredInventory).toContain("B");
  });

  it("refutes header/count alone for same-size deep replacement", () => {
    const prior = ["A", "B", "C", "D"];
    const actual = ["A", "Y", "C", "D"];
    expect(actual[0]).toBe(prior[0]);
    expect(actual.length).toBe(prior.length);
    expect(actual).not.toEqual(prior);
    // A periodic full scan is necessary even when the incremental trigger
    // sees unchanged metadata. This is a counterexample, not production loss.
  });
});

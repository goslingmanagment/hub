// A resumable proof of one unfiltered walk, never an inference from `done`.
import { randomUUID } from "node:crypto";

export interface VaultWalkProof {
  walkRef: string;
  startedAt: string;
  expectedCount: number | null;
  headRef: string | null;
  seenMediaRefs: string[];
  observationRefs: number[];
  valid: boolean;
}

export function newVaultWalkProof(album: { itemCount: number | null; lastItemRef: string | null }): VaultWalkProof {
  return {
    walkRef: randomUUID(), startedAt: new Date().toISOString(),
    expectedCount: album.itemCount, headRef: album.lastItemRef,
    seenMediaRefs: [], observationRefs: [], valid: true,
  };
}

export function parseVaultWalkProof(value: unknown): VaultWalkProof | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.walkRef !== "string" || !p.walkRef
    || typeof p.startedAt !== "string" || !Number.isFinite(Date.parse(p.startedAt))
    || !(p.expectedCount === null || Number.isSafeInteger(p.expectedCount) && Number(p.expectedCount) >= 0)
    || !(p.headRef === null || typeof p.headRef === "string")
    || !Array.isArray(p.seenMediaRefs) || !p.seenMediaRefs.every(x => typeof x === "string" && x.length > 0)
    || !Array.isArray(p.observationRefs) || !p.observationRefs.every(x => Number.isSafeInteger(x) && x > 0)
    || typeof p.valid !== "boolean") return undefined;
  return p as unknown as VaultWalkProof;
}

export function observeVaultWalkPage(
  proof: VaultWalkProof, albumRef: string, rows: readonly Record<string, unknown>[],
  observationRef: number | null,
): VaultWalkProof {
  const seen = new Set(proof.seenMediaRefs);
  let valid = proof.valid && observationRef !== null;
  for (const row of rows) {
    if (row.albumId !== albumRef || typeof row.id !== "string" || !row.id
      || typeof row.mediaId !== "string" || !row.mediaId || seen.has(row.mediaId)) {
      valid = false;
    } else seen.add(row.mediaId);
  }
  return { ...proof, valid, seenMediaRefs: [...seen],
    observationRefs: observationRef === null ? proof.observationRefs : [...proof.observationRefs, observationRef] };
}

export function vaultWalkIsComplete(proof: VaultWalkProof, album: { itemCount: number | null; lastItemRef: string | null }): boolean {
  return proof.valid && proof.observationRefs.length > 0
    && proof.headRef === album.lastItemRef && proof.expectedCount === album.itemCount
    && proof.expectedCount !== null && proof.seenMediaRefs.length === proof.expectedCount;
}

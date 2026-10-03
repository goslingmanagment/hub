import { describe, expect, it } from "vitest";
import {
  newVaultWalkProof,
  observeVaultWalkPage,
  parseVaultWalkProof,
  vaultWalkIsComplete,
} from "../apps/runtime/src/sync/fansly/lib/vault-walk-proof.ts";

describe("full vault walk evidence", () => {
  const album = { itemCount: 2, lastItemRef: "member-2" };
  const row = (n: number) => ({ id: `member-${n}`, mediaId: `file-${n}`, albumId: "album" });
  it("survives a persisted cursor between pages and distinguishes a changed album", () => {
    const first = observeVaultWalkPage(newVaultWalkProof(album), "album", [row(1)], 101);
    const resumed = parseVaultWalkProof(JSON.parse(JSON.stringify(first)))!;
    const second = observeVaultWalkPage(resumed, "album", [row(2)], 102);
    expect(vaultWalkIsComplete(second, album)).toBe(true);
    expect(vaultWalkIsComplete(second, { ...album, lastItemRef: "new-head" })).toBe(false);
    expect(vaultWalkIsComplete(second, { ...album, itemCount: 3 })).toBe(false);
  });
  it.each([
    { rows: [{ ...row(1), albumId: "different-album" }] },
    { rows: [{ ...row(1), mediaId: null }] },
    { rows: [row(1), row(1)] },
  ])("does not certify invalid or repeated rows even if a terminal page follows", ({ rows }) => {
    const proof = observeVaultWalkPage(newVaultWalkProof(album), "album", rows, 101);
    expect(vaultWalkIsComplete(observeVaultWalkPage(proof, "album", [], 102), album)).toBe(false);
  });
  it("requires a known count and a journal address; old cursors carry no proof", () => {
    expect(parseVaultWalkProof({ beforeRef: "tail", done: true })).toBeUndefined();
    const unknown = { itemCount: null, lastItemRef: null };
    expect(vaultWalkIsComplete(observeVaultWalkPage(newVaultWalkProof(unknown), "album", [], 1), unknown)).toBe(false);
    const empty = { itemCount: 0, lastItemRef: null };
    expect(vaultWalkIsComplete(observeVaultWalkPage(newVaultWalkProof(empty), "album", [], null), empty)).toBe(false);
  });
});

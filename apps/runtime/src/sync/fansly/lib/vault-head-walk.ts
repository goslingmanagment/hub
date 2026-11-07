import type { VaultAlbumWalkState } from "./catalog-rules.ts";
import type { VaultWalkProof } from "./vault-walk-proof.ts";

// The head walk of a moved vault album (owner decision №6 «каталог —
// инкрементально ежедневно, полностью еженедельно», plan §6.2 «инкрементально
// до известного элемента»; switched on page by page, owner 2026-11-07).
//
// A moved album is read from its head only until a page names a media id of
// the album's last proven inventory (the old head). The rows above it are the
// new members, and the album is caught up when the proven count plus them is
// Fansly's own count. Anything else — the old head not met within the rows the
// count can have grown by, the end of the album, a page the proof rejects, a
// count that does not add up, an album that moved during the walk — hands the
// album to a full walk at once. A head walk never proves removals: only the
// full walk writes `vault_album_walk_completed`, and it stays due a week after
// the album's last full walk. Pure.

/** The newest media ids of a proven inventory the head walk looks for. */
export const VAULT_HEAD_BASIS_REFS = 20;

/** An album's inventory as last proven: Fansly's count then and its newest
 *  media ids, newest first. */
export interface VaultHeadBasis {
  count: number;
  headMediaRefs: string[];
}

/** Why a head walk handed its album to a full walk. */
export type VaultHeadFallback = "count_mismatch" | "old_head_not_found" | "invalid_page";

const FALLBACKS: readonly VaultHeadFallback[] = ["count_mismatch", "old_head_not_found", "invalid_page"];

export function parseVaultHeadBasis(value: unknown): VaultHeadBasis | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const refs = record.headMediaRefs;
  if (!Number.isSafeInteger(record.count) || Number(record.count) < 0
    || !Array.isArray(refs) || refs.length === 0 || !refs.every((ref) => typeof ref === "string" && ref.length > 0)) return undefined;
  return { count: Number(record.count), headMediaRefs: refs as string[] };
}

export function parseVaultHeadFallback(value: unknown): VaultHeadFallback | undefined {
  return FALLBACKS.find((reason) => reason === value);
}

/** The UTC day the album's last full walk closed (a walk closed before head
 *  walks existed was a full one: its close day). */
export function lastFullWalkDay(walk: VaultAlbumWalkState): string | undefined {
  return walk.fullWalkOnUtcDay ?? walk.completedOnUtcDay;
}

/** The weekly full walk is due: `fullEveryMs` since the last full walk. */
export function vaultFullWalkDue(walk: VaultAlbumWalkState, utcDay: string, fullEveryMs: number): boolean {
  const day = lastFullWalkDay(walk);
  return day === undefined || Date.parse(utcDay) - Date.parse(day) >= fullEveryMs;
}

/**
 * The inventory a closed walk proved, or undefined: a head walk that caught
 * up carries it; a full walk proved it when its own generation completed
 * (`lastCompleteWalkAt` is that generation's, not an earlier one's) with
 * every counted member seen — its first seen refs are the album's head.
 */
export function provenVaultBasis(walk: VaultAlbumWalkState): VaultHeadBasis | undefined {
  if (!walk.done) return undefined;
  if (walk.mode === "head") return walk.basis;
  const proof = walk.proof;
  if (proof === undefined || walk.lastCompleteWalkAt === undefined) return undefined;
  if (!(Date.parse(walk.lastCompleteWalkAt) >= Date.parse(proof.startedAt))) return undefined;
  if (!proof.valid || proof.expectedCount === null || proof.expectedCount === 0
    || proof.seenMediaRefs.length !== proof.expectedCount) return undefined;
  return { count: proof.expectedCount, headMediaRefs: proof.seenMediaRefs.slice(0, VAULT_HEAD_BASIS_REFS) };
}

/**
 * How an album that is due again is walked: from the head down to the old
 * head when the page reads that way, the weekly full walk is not due, the
 * last inventory is proven and the album only grew; else in full, as before.
 */
export function vaultRewalkMode(input: {
  headWalkOn: boolean;
  walk: VaultAlbumWalkState;
  album: { itemCount: number | null };
  utcDay: string;
  fullEveryMs: number;
}): { mode: "head"; basis: VaultHeadBasis; fullWalkOnUtcDay: string } | { mode: "full" } {
  if (!input.headWalkOn || vaultFullWalkDue(input.walk, input.utcDay, input.fullEveryMs)) return { mode: "full" };
  const basis = provenVaultBasis(input.walk);
  const fullWalkOnUtcDay = lastFullWalkDay(input.walk);
  if (basis === undefined || fullWalkOnUtcDay === undefined) return { mode: "full" };
  // A count that did not grow means a removal (or nothing new at all): only
  // the full walk proves what is gone.
  if (input.album.itemCount === null || input.album.itemCount <= basis.count) return { mode: "full" };
  return { mode: "head", basis, fullWalkOnUtcDay };
}

/** What one served page of a head walk decides. */
export type VaultHeadPage =
  | { kind: "continue" }
  | { kind: "caught_up"; basis: VaultHeadBasis; newMembers: number }
  | { kind: "fallback"; reason: VaultHeadFallback };

/**
 * One page of a head walk. `before` / `after`: the walk's proof before and
 * after this page (every ref seen before it is new: the walk stops at the
 * first page that names a known one). `album`: the album as this page's
 * request saw it; the walk's proof holds it as the walk started.
 */
export function vaultHeadWalkPage(input: {
  basis: VaultHeadBasis;
  before: VaultWalkProof;
  after: VaultWalkProof;
  rows: readonly Record<string, unknown>[];
  /** The `before` of the next page (null: the page names none). */
  next: string | null;
  requestedBefore: string;
  pages: number;
  maxPages: number;
  album: { itemCount: number | null; lastItemRef: string | null };
}): VaultHeadPage {
  if (!input.after.valid) return { kind: "fallback", reason: "invalid_page" };
  const known = new Set(input.basis.headMediaRefs);
  const at = input.rows.findIndex((row) => typeof row.mediaId === "string" && known.has(row.mediaId));
  const expected = input.after.expectedCount;
  if (at === -1) {
    // No known row yet: every row seen is new, and the count can only have
    // grown by so many.
    const grew = (expected ?? 0) - input.basis.count;
    if (input.rows.length === 0 || input.after.seenMediaRefs.length > grew) return { kind: "fallback", reason: "old_head_not_found" };
    if (input.next === null || input.next === input.requestedBefore || input.pages >= input.maxPages) {
      return { kind: "fallback", reason: "invalid_page" };
    }
    return { kind: "continue" };
  }
  const fresh = [...input.before.seenMediaRefs, ...input.rows.slice(0, at).map((row) => row.mediaId as string)];
  if (expected === null || expected !== input.album.itemCount || input.after.headRef !== input.album.lastItemRef
    || input.basis.count + fresh.length !== expected) {
    return { kind: "fallback", reason: "count_mismatch" };
  }
  return {
    kind: "caught_up",
    newMembers: fresh.length,
    basis: { count: expected, headMediaRefs: [...fresh, ...input.basis.headMediaRefs].slice(0, VAULT_HEAD_BASIS_REFS) },
  };
}

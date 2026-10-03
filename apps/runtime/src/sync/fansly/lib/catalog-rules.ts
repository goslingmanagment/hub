import { VAULT_MEDIA_HEAD_CURSOR } from "@agency_hub_core/fansly";

import { classifyFanslyResponse } from "./lane.ts";
import { parseVaultWalkProof, type VaultWalkProof } from "./vault-walk-proof.ts";

// The catalog rules of the Sync Engine's `catalog.*` resources
// (resources/catalog.ts): the observation kind of each catalog route, the
// `catalog` cursor with each vault album's walk, and the reads of a served
// page (its response class, the vault rows and the next `before`). Pure. The
// legacy `catalog` lane (fansly-catalog.ts) imports them from here until step 4
// deletes it.

/** One kind PER ROUTE: nine routes, nine response shapes. */
export const FANSLY_CATALOG_OBSERVATION_KINDS = {
  vaultAlbums: "vault_albums",
  userVaultAlbums: "uservault_albums",
  subscriptionTiers: "subscription_tiers",
  giftCodes: "gift_codes",
  automatedMessages: "automated_messages",
  accountWalls: "account_walls",
  vaultMedia: "vault_media",
  accountMediaBatch: "account_media_batch",
  accountMediaBundleBatch: "account_media_bundle_batch",
} as const;

/**
 * Pages one album's walk may take in a single first-enable crawl before the
 * lane gives up on it.
 *
 * The largest album observed live holds 4 760 items. At an unknown server page
 * size this is a safety net against a cursor that advances by one row a page,
 * not a coverage limit: hitting it stops THAT album with an anomaly and leaves
 * the rest of the vault alone.
 */
export const VAULT_ALBUM_MAX_PAGES = 400;

// ── cursor state ─────────────────────────────────────────────────────────────

/** Where one album's walk stands. Durable — a crawl that spans a week of daily
 *  caps resumes at the exact page it deferred on. */
export interface VaultAlbumWalkState {
  /** `before` for the next call. `"0"` is the head (the LITERAL string). */
  beforeRef: string;
  /** Repeat-request guard: the `before` the previous call carried. */
  lastRequestedBefore: string | null;
  /** Has any page of this album come back non-empty? Until it has, an empty
   *  page is ambiguous rather than terminal. */
  sawRows: boolean;
  pages: number;
  /** The album's `lastItemId` at the time the walk finished. When the platform
   *  serves a different one, the album's head is re-walked. */
  completedAtLastItemRef: string | null;
  done: boolean;
  proof?: VaultWalkProof | undefined;
  completedOnUtcDay?: string | undefined;
  /** Last proven complete generation, retained when a recheck starts. */
  lastCompleteWalkAt?: string | undefined;
}

export interface FanslyCatalogCursorState {
  version: 1;
  /** The UTC day `callsToday` belongs to; a different day resets the counter. */
  utcDay: string;
  /** HTTP ATTEMPTS spent by this lane on `utcDay`. Retries included. */
  callsToday: number;
  /** The UTC day whose FIXED steps are already done. */
  fixedStepsDay: string | null;
  /** Which fixed step the next dispatch resumes at (index into FIXED_STEPS). */
  fixedStepIndex: number;
  /** Per-album walk state, keyed by album ref. */
  vaultWalk: Record<string, VaultAlbumWalkState>;
  /** Durable round-robin position, independent of the HTTP/page budget. */
  vaultWalkAfterAlbumRef?: string | null;
  /** DEPRECATED. An empty FIRST page on an album the platform says is
   *  non-empty used to set this and stop the whole vault walk; it now parks
   *  only that album. Still parsed so older cursors load; the vault walk
   *  clears it and nothing sets it any more. */
  vaultWalkBlockedAlbumRef: string | null;
  /** True once every known album's walk has completed at least once. */
  vaultWalkExhausted: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseAlbumWalk(value: unknown): VaultAlbumWalkState | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  return {
    beforeRef: asNullableString(record.beforeRef) ?? VAULT_MEDIA_HEAD_CURSOR,
    lastRequestedBefore: asNullableString(record.lastRequestedBefore),
    sawRows: record.sawRows === true,
    pages: Math.max(0, asInt(record.pages, 0)),
    completedAtLastItemRef: asNullableString(record.completedAtLastItemRef),
    done: record.done === true,
    proof: parseVaultWalkProof(record.proof),
    completedOnUtcDay: asNullableString(record.completedOnUtcDay) ?? undefined,
    lastCompleteWalkAt: asNullableString(record.lastCompleteWalkAt) ?? undefined,
  };
}

export function parseFanslyCatalogCursorState(
  value: unknown,
): FanslyCatalogCursorState | null {
  const state = asRecord(value);
  if (!state || state.version !== 1) {
    return null;
  }
  const utcDay = asNullableString(state.utcDay);
  if (utcDay === null) {
    return null;
  }
  const walkRecord = asRecord(state.vaultWalk) ?? {};
  const vaultWalk: Record<string, VaultAlbumWalkState> = {};
  for (const [albumRef, walk] of Object.entries(walkRecord)) {
    const parsed = parseAlbumWalk(walk);
    if (parsed !== null) {
      vaultWalk[albumRef] = parsed;
    }
  }
  return {
    version: 1,
    utcDay,
    callsToday: Math.max(0, asInt(state.callsToday, 0)),
    fixedStepsDay: asNullableString(state.fixedStepsDay),
    fixedStepIndex: Math.max(0, asInt(state.fixedStepIndex, 0)),
    vaultWalk,
    vaultWalkAfterAlbumRef: asNullableString(state.vaultWalkAfterAlbumRef),
    vaultWalkBlockedAlbumRef: asNullableString(state.vaultWalkBlockedAlbumRef),
    vaultWalkExhausted: state.vaultWalkExhausted === true,
  };
}

export function emptyAlbumWalk(): VaultAlbumWalkState {
  return {
    beforeRef: VAULT_MEDIA_HEAD_CURSOR,
    lastRequestedBefore: null,
    sawRows: false,
    pages: 0,
    completedAtLastItemRef: null,
    done: false,
  };
}

// ── shape helpers over the journaled bodies ──────────────────────────────────

/** The `albumMedia[]` rows of a `/media/vaultnew` page, or `[]`. The `media[]`
 *  array beside it is RAW media with signed locations and is never read here. */
export function vaultMediaRows(payload: unknown): Record<string, unknown>[] {
  const record = asRecord(payload);
  if (record === null) {
    return [];
  }
  return Array.isArray(record.albumMedia)
    ? record.albumMedia.filter((row): row is Record<string, unknown> => asRecord(row) !== null)
    : [];
}

export function classifyCatalogResponse(kind: string, payload: unknown) {
  return classifyFanslyResponse(payload, {
    isValid: (value) => {
      const record = asRecord(value);
      if (kind === FANSLY_CATALOG_OBSERVATION_KINDS.vaultAlbums
        || kind === FANSLY_CATALOG_OBSERVATION_KINDS.userVaultAlbums) {
        return record !== null && Array.isArray(record.albums);
      }
      if (kind === FANSLY_CATALOG_OBSERVATION_KINDS.vaultMedia) {
        return record !== null && Array.isArray(record.albumMedia);
      }
      return Array.isArray(value)
        || (record !== null && Object.values(record).some((member) => Array.isArray(member)));
    },
    isEmpty: (value) => {
      if (Array.isArray(value)) {
        return value.length === 0;
      }
      const record = asRecord(value)!;
      const firstArray = Object.values(record).find((member) => Array.isArray(member));
      return Array.isArray(firstArray) && firstArray.length === 0;
    },
  });
}

/** The membership id the NEXT page's `before` must carry: the last row's own
 *  `id`, exactly as the app's `loadMore` reads it. NOT `mediaOfferId` — that is
 *  a different value and paging on it walks nowhere. */
export function nextVaultCursor(rows: readonly Record<string, unknown>[]): string | null {
  const last = rows[rows.length - 1];
  return last === undefined ? null : asNullableString(last.id);
}

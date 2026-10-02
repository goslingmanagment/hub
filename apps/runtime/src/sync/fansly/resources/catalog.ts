import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  insertObservation,
  latestClosedWorkForKey,
  listCreatorVaultAlbumsForWalk,
  listUnhydratedVaultBundleRefs,
  listUnhydratedVaultMediaRefs,
  type CaptureCoverageProof,
  type CaptureCoverageStatus,
  type Database,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import { ACCOUNT_MEDIA_BATCH_SIZE, VAULT_MEDIA_HEAD_CURSOR, type FanslyWireId } from "@agency_hub_core/fansly";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import { FANSLY_CATALOG_EVENT_TYPES } from "../../../services/canonicalize/fansly-catalog.ts";
import { FANSLY_CATALOG_PROJECTION } from "../../../services/projections/fansly-catalog.ts";
import { MEDIA_PLANE_PROJECTION } from "../../../services/projections/media-plane.ts";
import {
  classifyCatalogResponse,
  emptyAlbumWalk,
  nextVaultCursor,
  parseAlbumWalk,
  parseFanslyCatalogCursorState,
  VAULT_ALBUM_MAX_PAGES,
  vaultMediaRows,
  type VaultAlbumWalkState,
} from "../../../services/sync/fansly-catalog.ts";
import { fanslyUtcDayKey, writeFanslyLaneCoverage } from "../../../services/sync/fansly-lane.ts";
import { observeVaultWalkPage, vaultWalkIsComplete, type VaultWalkProof } from "../../../services/sync/vault-walk-proof.ts";
import { ApplyQuarantine } from "../../engine/commit.ts";
import {
  effectiveCadence,
  type ApplyInput,
  type ApplyResult,
  type CadenceSpec,
  type DemandSignal,
  type LegacyImport,
  type RequestPlan,
  type ResourceModule,
  type ShadowResult,
  type StepPlan,
} from "../../engine/resource.ts";
import { replayByCanonicalDrafts } from "../lib/family-replay.ts";
import { advanceShadowWalk, type ShadowWalkProgress } from "../lib/offset-walk.ts";
import { readFanslyPageFacts } from "../lib/page-facts.ts";
import { projectionBehind } from "../lib/projection-lag.ts";
import { standingRecheckAt } from "../lib/subject-queue.ts";
import { fanslyResourceSpec } from "../registry.ts";

// `catalog.fixed`, `catalog.vault`, `catalog.hydrate` (plan §5, design §5.17,
// owner decision №6 "экономно"): the page's inventory. Every answer is
// journaled under its legacy kind with the legacy [A20] trim and becomes
// events by inline canonicalization (`pull/catalog`); the `fansly_catalog`
// and `media_plane` projections build the tables, as today.
//
// fixed (poll, 24 h): six single reads — the vault albums, the user-vault
// albums (only with the page's own account id; otherwise skipped with the
// coverage `own_account_ref_unknown`), tiers, gift codes, automations, walls —
// one a step, the position in the poll row's cursor; each full listing is the
// provider's whole surface for its kind (`provider_exhausted`).
//
// vault (standing walk, re-checked daily): `/media/vaultnew` album by album,
// `before` = the last row's id, down to an empty page, ≤ 400 pages an album.
// The albums come from the projection, in a durable rotation, never-completed
// first; an album is walked again when its head or count moved, its proof is
// missing, or its last walk is a week old (incremental daily, full weekly —
// owner decision №6; a page's override changes either period). A
// new walk waits while album events of the page are not projected yet, so it
// never walks a list the last `.fixed` read has not reached. An empty first
// page of a non-empty album, a cursor that does not move, rows without ids or
// the page cap park THAT album; a walk that proves the whole album writes the
// synthetic `vault_album_walk_completed` observation, as legacy.
//
// hydrate (planned trigger after the walk and the fixed reads): ≤ 100 refs a
// step from the members no card was projected for yet, media first, then
// bundles; it waits while its last batch is unprojected, and refs a batch did
// not return are not asked again for 24 h.

export type CatalogVariant = "fixed" | "vault" | "hydrate";

const FIXED_KEY = "catalog.fixed";
const VAULT_KEY = "catalog.vault";
const HYDRATE_KEY = "catalog.hydrate";
const DAY_MS = 86_400_000;
/** The vault walk's cadence (owner decision №6): it looks at its albums
 *  again `everyMs` after it found none to walk (incremental daily), and an
 *  album walked `fullEveryMs` ago is due again (full weekly) — the registry's
 *  values, or the page's override (`sync page override --resource
 *  catalog.vault --period-ms/--full-period-ms --owner-approved`). */
export function vaultCadence(page: Parameters<typeof effectiveCadence>[1]): Required<CadenceSpec> {
  const cadence = effectiveCadence(fanslyResourceSpec(VAULT_KEY)!, page);
  if (cadence === null || cadence.fullEveryMs === undefined) throw new Error(`${VAULT_KEY} needs a cadence with a full sweep`);
  return { everyMs: cadence.everyMs, fullEveryMs: cadence.fullEveryMs };
}
/** Rows `/media/vaultnew` serves a page (production 2026-10: 50). Shadow only:
 *  an album's walk length is estimated from its item count. */
export const VAULT_PAGE_ESTIMATE = 50;
/** A ref a batch did not return is not asked again for this long. */
const UNSERVED_MEMORY_MS = DAY_MS;
/** The album events whose projection the walk's list depends on. */
const ALBUM_EVENT_TYPES: readonly string[] = FANSLY_CATALOG_EVENT_TYPES.filter((type) => (
  type === "vault.album_observed" || type === "catalog.listing_observed"
));

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function coverageWriter(tx: Database, pageId: number, plane: string, now: Date) {
  return (scopeRef: string, status: CaptureCoverageStatus, proof: CaptureCoverageProof, extra: {
    proofObservationId?: number | null;
    reasonCode?: string | null;
    expectedCount?: number | null;
    observedUniqueCount?: number | null;
    cursor?: Record<string, unknown>;
  } = {}) => writeFanslyLaneCoverage({
    db: tx,
    pageId,
    plane,
    scopeRef,
    status,
    acquisitionMode: "retroactive",
    proof,
    newestCapturedAt: now,
    ...extra,
  });
}

// ── fixed ────────────────────────────────────────────────────────────────────

export const CATALOG_FIXED_STEPS: ReadonlyArray<{ spec: FanslyWireId; kind: string }> = [
  { spec: "vault.albums", kind: "vault_albums" },
  { spec: "uservault.albums", kind: "uservault_albums" },
  { spec: "subscriptions.tiers", kind: "subscription_tiers" },
  { spec: "subscriptions.giftcodes", kind: "gift_codes" },
  { spec: "message.automated", kind: "automated_messages" },
  { spec: "account.walls", kind: "account_walls" },
];
const USERVAULT_STEP = 1;

interface FixedCursor {
  /** The step the next read is (0–5). */
  index: number;
  last: Record<string, unknown> | null;
}

function parseFixedCursor(value: unknown): FixedCursor {
  const record = recordOf(value);
  const index = int(record.index);
  return {
    index: index !== null && index >= 0 && index < CATALOG_FIXED_STEPS.length ? index : 0,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

interface FixedStep {
  index: number;
  /** The user-vault read was skipped: the page has no own account id yet. */
  skippedUservault: boolean;
}

function fixedStepOf(request: Pick<RequestPlan, "step">): FixedStep | null {
  const record = recordOf(request.step);
  const index = int(record.index);
  return index === null || index < 0 || index >= CATALOG_FIXED_STEPS.length
    ? null
    : { index, skippedUservault: record.skippedUservault === true };
}

/** The followups of a finished sweep: the walk looks at the albums just
 *  listed, the hydration at what the walk named. */
const AFTER_FIXED: readonly DemandSignal[] = [
  { resource: VAULT_KEY, demand: { reason: "albums_listed" } },
  { resource: HYDRATE_KEY, demand: { reason: "catalog_fixed" } },
];

function stepFixed(index: number, now: Date): { cursor: FixedCursor; finished: boolean } {
  const next = index + 1;
  return next >= CATALOG_FIXED_STEPS.length
    ? { cursor: { index: 0, last: { completedAt: now.toISOString() } }, finished: true }
    : { cursor: { index: next, last: null }, finished: false };
}

const fixedModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseFixedCursor(work.cursor);
    const facts = await readFanslyPageFacts(ctx.db, ctx.pageId);
    if (facts === null) return { kind: "quarantine", reason: "page_missing" };
    // The page's OWN account ref, never a guess: without it the user-vault
    // read is skipped and the coverage says why.
    const skippedUservault = cursor.index === USERVAULT_STEP && facts.externalId === null;
    const index = skippedUservault ? USERVAULT_STEP + 1 : cursor.index;
    const spec = CATALOG_FIXED_STEPS[index]!.spec;
    const params = spec === "uservault.albums" ? { accountId: facts.externalId! } : {};
    return { kind: "request", request: { spec, params, step: { index, skippedUservault } satisfies FixedStep } as RequestPlan };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const step = fixedStepOf(input.request);
    const expected = step === null ? null : CATALOG_FIXED_STEPS[step.index]!;
    if (step === null || expected!.spec !== input.request.spec) {
      throw new ApplyQuarantine("catalog_fixed_step_mismatch", { spec: input.request.spec });
    }
    const kind = expected!.kind;
    if (classifyCatalogResponse(kind, input.response) === "invalid") {
      throw new ApplyQuarantine("catalog_response_invalid", { kind });
    }
    const coverage = coverageWriter(tx, input.pageId, CAPTURE_COVERAGE_PLANES.catalog, input.now);
    if (step.skippedUservault) {
      await coverage("uservault_albums", "partial_provider_surface", "none", {
        reasonCode: "own_account_ref_unknown",
        cursor: { note: "pages.external_page_id is null; account.poll writes it" },
      });
    }
    // A full listing served in one call IS the provider's whole surface for
    // that kind: there is no deeper page to reach.
    await coverage(kind, "provider_exhausted", "terminal_response", {
      proofObservationId: input.observation.id,
      reasonCode: "full_listing",
    });
    const next = stepFixed(step.index, input.now);
    return next.finished
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "fixed_steps_read", cursor: next.cursor, result: next.cursor.last }, followups: AFTER_FIXED, counters: { catalog_fixed_sweeps: 1 } }
      : { work: { satisfiesRevision: false, nextDueAt: input.now, cursor: next.cursor }, followups: [] };
  },

  async shadow(work, request, ctx): Promise<ShadowResult> {
    const step = fixedStepOf(request) ?? { index: parseFixedCursor(work.cursor).index, skippedUservault: false };
    const next = stepFixed(step.index, ctx.now);
    return next.finished
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: next.cursor }, followups: AFTER_FIXED }
      : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: next.cursor }, followups: [] };
  },

  replay: replayByCanonicalDrafts,

  async importLegacy(tx, page): Promise<LegacyImport> {
    const legacy = parseFanslyCatalogCursorState((await legacyCatalogState(tx, page.pageId)) ?? null);
    // A sweep legacy left mid-way today resumes at its step; otherwise the
    // next sweep starts at the head.
    const midWay = legacy !== null && legacy.fixedStepsDay !== fanslyUtcDayKey(new Date()) && legacy.fixedStepIndex > 0;
    const cursor: FixedCursor = { index: midWay ? legacy.fixedStepIndex : 0, last: null };
    return { cursors: [{ resource: FIXED_KEY, subject: "", cursor }], notes: { fixed: legacy === null ? "none" : midWay ? "resumed" : "head" } };
  },
};

async function legacyCatalogState(db: Database, pageId: number): Promise<unknown> {
  const result = await db.execute<{ state: unknown }>(sql`
    select state from page_sync_cursors where page_id = ${pageId} and stream = 'catalog'
  `);
  return result.rows[0]?.state;
}

// ── vault ────────────────────────────────────────────────────────────────────

interface VaultAlbum {
  albumRef: string;
  itemCount: number | null;
  lastItemRef: string | null;
}

interface VaultCursor {
  /** Per-album walk state (the legacy lane's, carried over at the switch). */
  vaultWalk: Record<string, VaultAlbumWalkState>;
  /** The album the rotation last served. */
  afterAlbumRef: string | null;
  /** Shadow: the walk state was seeded from the legacy cursor. */
  seeded: boolean;
  last: Record<string, unknown> | null;
}

function parseVaultCursor(value: unknown): VaultCursor {
  const record = recordOf(value);
  const vaultWalk: Record<string, VaultAlbumWalkState> = {};
  for (const [albumRef, walk] of Object.entries(recordOf(record.vaultWalk))) {
    const parsed = parseAlbumWalk(walk);
    if (parsed !== null) vaultWalk[albumRef] = parsed;
  }
  return {
    vaultWalk,
    afterAlbumRef: text(record.afterAlbumRef),
    seeded: record.seeded === true,
    last: typeof record.last === "object" && record.last !== null ? record.last as Record<string, unknown> : null,
  };
}

type ParkReason = "repeat_request" | "page_cap";

interface VaultStep {
  album: VaultAlbum;
  /** This request opens a new walk of the album at its head (fresh, or a
   *  re-walk): the proof header the walk is proved against. */
  start: { walkRef: string; startedAt: string; lastCompleteWalkAt: string | null } | null;
  /** Albums the choice passed over that cannot be asked again as they stand
   *  (an imported walk at a repeated cursor or at the page cap): parked by
   *  the apply. */
  parked: Array<{ album: VaultAlbum; reason: ParkReason }>;
}

function parseAlbum(value: unknown): VaultAlbum | null {
  const record = recordOf(value);
  const albumRef = text(record.albumRef);
  if (albumRef === null) return null;
  return { albumRef, itemCount: int(record.itemCount), lastItemRef: text(record.lastItemRef) };
}

function vaultStepOf(request: Pick<RequestPlan, "step">): VaultStep | null {
  const record = recordOf(request.step);
  const album = parseAlbum(record.album);
  if (album === null) return null;
  const start = recordOf(record.start);
  const walkRef = text(start.walkRef);
  const startedAt = text(start.startedAt);
  const parked = (Array.isArray(record.parked) ? record.parked : []).flatMap((entry) => {
    const item = recordOf(entry);
    const parkedAlbum = parseAlbum(item.album);
    const reason: ParkReason | null = item.reason === "repeat_request" || item.reason === "page_cap" ? item.reason : null;
    return parkedAlbum === null || reason === null ? [] : [{ album: parkedAlbum, reason }];
  });
  return {
    album,
    start: walkRef === null || startedAt === null ? null : { walkRef, startedAt, lastCompleteWalkAt: text(start.lastCompleteWalkAt) },
    parked,
  };
}

/** An album's walk is due again: its head or count moved, its proof is
 *  missing or stale, or its last walk is `fullEveryMs` old (legacy rule: a
 *  week, by UTC day). */
function rewalkDue(walk: VaultAlbumWalkState, album: VaultAlbum, utcDay: string, fullEveryMs: number): boolean {
  return walk.completedAtLastItemRef !== album.lastItemRef
    || walk.proof === undefined || walk.proof.expectedCount !== album.itemCount
    || walk.completedOnUtcDay === undefined
    || Date.parse(utcDay) - Date.parse(walk.completedOnUtcDay) >= fullEveryMs;
}

/** The album the walk serves next and its effective walk state (the legacy
 *  lane's rotation: never-completed first, round robin after the last
 *  served), or null when every album is walked. */
export function chooseVaultAlbum(
  albums: readonly VaultAlbum[],
  cursor: Pick<VaultCursor, "vaultWalk" | "afterAlbumRef">,
  utcDay: string,
  fullEveryMs: number,
): { album: VaultAlbum; walk: VaultAlbumWalkState; start: boolean; parked: VaultStep["parked"] } | null {
  const start = albums.findIndex((album) => album.albumRef === cursor.afterAlbumRef) + 1;
  const rotated = [...albums.slice(start), ...albums.slice(0, start)];
  const ordered = [
    ...rotated.filter((album) => !cursor.vaultWalk[album.albumRef]?.lastCompleteWalkAt),
    ...rotated.filter((album) => cursor.vaultWalk[album.albumRef]?.lastCompleteWalkAt),
  ];
  const parked: VaultStep["parked"] = [];
  for (const album of ordered) {
    let walk = cursor.vaultWalk[album.albumRef] ?? emptyAlbumWalk();
    if (walk.done && rewalkDue(walk, album, utcDay, fullEveryMs)) walk = { ...emptyAlbumWalk(), lastCompleteWalkAt: walk.lastCompleteWalkAt };
    if (walk.done) continue;
    // A walk without an inventory proof (fresh, re-opened, or a legacy tail)
    // starts its generation at the head.
    const opens = walk.proof === undefined;
    if (opens) walk = { ...emptyAlbumWalk(), lastCompleteWalkAt: walk.lastCompleteWalkAt };
    if (walk.lastRequestedBefore === walk.beforeRef) {
      parked.push({ album, reason: "repeat_request" });
      continue;
    }
    if (walk.pages >= VAULT_ALBUM_MAX_PAGES) {
      parked.push({ album, reason: "page_cap" });
      continue;
    }
    return { album, walk, start: opens, parked };
  }
  return null;
}

function headProof(album: VaultAlbum, start: NonNullable<VaultStep["start"]>): VaultWalkProof {
  return {
    walkRef: start.walkRef,
    startedAt: start.startedAt,
    expectedCount: album.itemCount,
    headRef: album.lastItemRef,
    seenMediaRefs: [],
    observationRefs: [],
    valid: true,
  };
}

function closedWalk(walk: VaultAlbumWalkState, album: VaultAlbum, utcDay: string): VaultAlbumWalkState {
  return { ...walk, done: true, completedAtLastItemRef: album.lastItemRef, completedOnUtcDay: utcDay };
}

/** Shadow's walk state: its own, seeded once from the legacy cursor (proofs
 *  without their member lists) so shadow walks what live would walk after
 *  the switch imports that cursor. */
async function shadowVaultWalk(db: Database, pageId: number, cursor: VaultCursor): Promise<VaultCursor> {
  if (cursor.seeded) return cursor;
  const legacy = parseFanslyCatalogCursorState((await legacyCatalogState(db, pageId)) ?? null);
  const vaultWalk: Record<string, VaultAlbumWalkState> = {};
  for (const [albumRef, walk] of Object.entries(legacy?.vaultWalk ?? {})) {
    vaultWalk[albumRef] = walk.proof === undefined
      ? walk
      : { ...walk, proof: { ...walk.proof, seenMediaRefs: [], observationRefs: [] } };
  }
  return { ...cursor, vaultWalk, afterAlbumRef: legacy?.vaultWalkAfterAlbumRef ?? cursor.afterAlbumRef, seeded: true };
}

const HYDRATE_AFTER_WALK: readonly DemandSignal[] = [{ resource: HYDRATE_KEY, demand: { reason: "album_walked" } }];

const vaultModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    let cursor = parseVaultCursor(work.cursor);
    if (ctx.shadow) cursor = await shadowVaultWalk(ctx.db, ctx.pageId, cursor);
    const cadence = vaultCadence(ctx.page);
    const albums = await listCreatorVaultAlbumsForWalk(ctx.db, ctx.pageId);
    const choice = albums.length === 0 ? null : chooseVaultAlbum(albums, cursor, fanslyUtcDayKey(ctx.now), cadence.fullEveryMs);
    if (choice === null) return { kind: "wait", reason: "not_due", until: standingRecheckAt(ctx.now, cadence.everyMs) };
    // A new walk waits for the album list the last `.fixed` read put in the
    // journal; a walk under way finishes the album it started.
    if (choice.start && await projectionBehind(ctx.db, { pageId: ctx.pageId, projection: FANSLY_CATALOG_PROJECTION, eventTypes: ALBUM_EVENT_TYPES })) {
      return { kind: "wait", reason: "dependency", until: null };
    }
    const step: VaultStep = {
      album: choice.album,
      start: choice.start
        ? { walkRef: randomUUID(), startedAt: ctx.now.toISOString(), lastCompleteWalkAt: choice.walk.lastCompleteWalkAt ?? null }
        : null,
      parked: choice.parked,
    };
    return {
      kind: "request",
      request: { spec: "vault.media", params: { albumId: choice.album.albumRef, before: choice.walk.beforeRef }, step },
    };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const utcDay = fanslyUtcDayKey(now);
    const step = vaultStepOf(input.request);
    if (step === null) throw new ApplyQuarantine("catalog_vault_step_missing");
    const cursor = parseVaultCursor(input.work.cursor);
    const walks: Record<string, VaultAlbumWalkState> = { ...cursor.vaultWalk };
    const album = step.album;
    const requestedBefore = text(recordOf(input.request.params).before) ?? "";
    const coverage = coverageWriter(tx, input.pageId, CAPTURE_COVERAGE_PLANES.catalogVaultMedia, now);
    const counters: Record<string, number> = {};
    const count = (name: string) => {
      counters[name] = (counters[name] ?? 0) + 1;
    };

    for (const parked of step.parked) {
      const walk = walks[parked.album.albumRef] ?? emptyAlbumWalk();
      walks[parked.album.albumRef] = closedWalk(walk, parked.album, utcDay);
      await coverage(parked.album.albumRef, "partial_provider_surface", "none", {
        reasonCode: parked.reason,
        expectedCount: parked.album.itemCount,
        cursor: { beforeRef: walk.beforeRef, pages: walk.pages },
      });
      count(`vault_album_parked:${parked.reason}`);
    }

    let walk: VaultAlbumWalkState;
    if (step.start !== null) {
      if (requestedBefore !== VAULT_MEDIA_HEAD_CURSOR) throw new ApplyQuarantine("catalog_vault_cursor_mismatch", { album: album.albumRef });
      walk = { ...emptyAlbumWalk(), lastCompleteWalkAt: step.start.lastCompleteWalkAt ?? undefined, proof: headProof(album, step.start) };
    } else {
      const stored = walks[album.albumRef];
      if (stored === undefined || stored.done || stored.proof === undefined || stored.beforeRef !== requestedBefore) {
        throw new ApplyQuarantine("catalog_vault_cursor_mismatch", { album: album.albumRef, before: requestedBefore });
      }
      walk = stored;
    }
    if (classifyCatalogResponse("vault_media", input.response) === "invalid") {
      throw new ApplyQuarantine("catalog_response_invalid", { kind: "vault_media" });
    }

    walk = { ...walk, lastRequestedBefore: requestedBefore, pages: walk.pages + 1 };
    const rows = vaultMediaRows(input.response);
    let proof = observeVaultWalkPage(walk.proof!, album.albumRef, rows, input.observation.id);
    const served = recordOf(input.response).albumMedia;
    if (Array.isArray(served) && served.length !== rows.length) proof = { ...proof, valid: false };
    walk = { ...walk, proof };
    let finished = true;
    let outcome: string;

    if (rows.length === 0) {
      const firstPage = requestedBefore === VAULT_MEDIA_HEAD_CURSOR && !walk.sawRows;
      const albumClaimsEmpty = album.itemCount === 0;
      if (firstPage && !albumClaimsEmpty) {
        // An empty first page of a non-empty album is a request the server did
        // not honour, never an empty inventory: this album is parked.
        walk = closedWalk(walk, album, utcDay);
        await coverage(album.albumRef, "partial_provider_surface", "terminal_response", {
          proofObservationId: input.observation.id,
          reasonCode: "empty_first_page_on_non_empty_album",
          expectedCount: album.itemCount,
          observedUniqueCount: 0,
          cursor: { before: requestedBefore },
        });
        outcome = "empty_first_page";
      } else {
        const complete = vaultWalkIsComplete(proof, album);
        if (complete) {
          // The derived proof record, journaled apart: the HTTP body stays as
          // served, and the catalog family turns this into the walk event.
          const completedAt = now.toISOString();
          const payload = { ...proof, albumRef: album.albumRef, vaultKind: "creator", completedAt, pages: walk.pages };
          await insertObservation(tx, {
            source: "pull",
            producer: "fansly-sync:catalog",
            platform: "fansly",
            accountId: input.pageId,
            nativeAccountRef: input.ownRef,
            kind: "vault_album_walk_completed",
            payload,
            payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
            idempotencyKey: `fansly-sync:${input.pageId}:attempt:${input.attempt.id}:vault_album_walk_completed`,
          });
          walk = { ...walk, lastCompleteWalkAt: completedAt };
        }
        walk = closedWalk(walk, album, utcDay);
        await coverage(album.albumRef, complete ? "provider_exhausted" : "partial_provider_surface", "empty_window", {
          proofObservationId: input.observation.id,
          reasonCode: !complete ? "walk_inventory_mismatch" : albumClaimsEmpty ? "album_empty" : "walk_exhausted",
          expectedCount: album.itemCount,
          observedUniqueCount: proof.seenMediaRefs.length,
          cursor: { pages: walk.pages, lastItemRef: album.lastItemRef },
        });
        outcome = complete ? "walk_exhausted" : "walk_inventory_mismatch";
      }
    } else {
      const next = nextVaultCursor(rows);
      if (next === null) {
        walk = closedWalk({ ...walk, sawRows: true }, album, utcDay);
        await coverage(album.albumRef, "partial_provider_surface", "terminal_response", {
          proofObservationId: input.observation.id,
          reasonCode: "cursor_missing",
          expectedCount: album.itemCount,
        });
        outcome = "cursor_missing";
      } else if (next === requestedBefore || walk.pages >= VAULT_ALBUM_MAX_PAGES) {
        // The identical `before` twice is a loop's first step; the page cap a
        // safety net against a cursor that advances a row a page.
        const reason = next === requestedBefore ? "repeat_request" : "page_cap";
        walk = closedWalk({ ...walk, sawRows: true, beforeRef: next }, album, utcDay);
        await coverage(album.albumRef, "partial_provider_surface", "none", {
          reasonCode: reason,
          expectedCount: album.itemCount,
          cursor: { beforeRef: next, pages: walk.pages },
        });
        outcome = reason;
      } else {
        walk = { ...walk, sawRows: true, beforeRef: next };
        await coverage(album.albumRef, "in_progress", "none", {
          reasonCode: "walking",
          expectedCount: album.itemCount,
          cursor: { beforeRef: next, pages: walk.pages },
        });
        finished = false;
        outcome = "walking";
      }
    }
    count(`vault_page:${outcome}`);
    walks[album.albumRef] = walk;
    const receipt = finished
      ? { albumRef: album.albumRef, outcome, pages: walk.pages, seen: proof.seenMediaRefs.length, at: now.toISOString() }
      : cursor.last;
    const next: VaultCursor = { vaultWalk: walks, afterAlbumRef: album.albumRef, seeded: cursor.seeded, last: receipt };
    return {
      work: { satisfiesRevision: finished, nextDueAt: now, cursor: next, ...(finished ? { result: receipt } : {}) },
      followups: finished ? HYDRATE_AFTER_WALK : [],
      counters,
    };
  },

  async shadow(work, request, ctx): Promise<ShadowResult> {
    const cursor = await shadowVaultWalk(ctx.db, ctx.pageId, parseVaultCursor(work.cursor));
    const step = vaultStepOf(request);
    if (step === null) return { work: { satisfiesRevision: true, nextDueAt: ctx.now, cursor }, followups: [] };
    const utcDay = fanslyUtcDayKey(ctx.now);
    const walks: Record<string, VaultAlbumWalkState> = { ...cursor.vaultWalk };
    for (const parked of step.parked) {
      walks[parked.album.albumRef] = closedWalk(walks[parked.album.albumRef] ?? emptyAlbumWalk(), parked.album, utcDay);
    }
    const album = step.album;
    let walk = step.start !== null || walks[album.albumRef] === undefined
      ? { ...emptyAlbumWalk(), lastCompleteWalkAt: step.start?.lastCompleteWalkAt ?? undefined, proof: headProof(album, step.start ?? { walkRef: randomUUID(), startedAt: ctx.now.toISOString(), lastCompleteWalkAt: null }) }
      : walks[album.albumRef]!;
    // The walk ends on the empty page after its rows (50 a page, production).
    const pages = album.itemCount === null || album.itemCount <= 0 ? 1 : Math.ceil(album.itemCount / VAULT_PAGE_ESTIMATE) + 1;
    walk = { ...walk, pages: walk.pages + 1, lastRequestedBefore: walk.beforeRef };
    const finished = walk.pages >= pages;
    walk = finished
      ? { ...closedWalk(walk, album, utcDay), lastCompleteWalkAt: ctx.now.toISOString() }
      : { ...walk, sawRows: true, beforeRef: `shadow-${walk.pages}` };
    walks[album.albumRef] = walk;
    const next: VaultCursor = { ...cursor, vaultWalk: walks, afterAlbumRef: album.albumRef };
    return {
      work: { satisfiesRevision: finished, nextDueAt: ctx.now, cursor: next },
      followups: finished ? HYDRATE_AFTER_WALK : [],
      counters: finished ? { vault_albums_estimated: 1 } : {},
    };
  },

  replay: replayByCanonicalDrafts,

  async importLegacy(tx, page): Promise<LegacyImport> {
    const legacy = parseFanslyCatalogCursorState((await legacyCatalogState(tx, page.pageId)) ?? null);
    const vaultWalk: Record<string, VaultAlbumWalkState> = { ...legacy?.vaultWalk };
    // The legacy block of the whole walk is lifted as legacy lifts it: the
    // refused album is asked once more from its head.
    const blockedRef = legacy?.vaultWalkBlockedAlbumRef ?? null;
    if (blockedRef !== null) {
      vaultWalk[blockedRef] = { ...emptyAlbumWalk(), lastCompleteWalkAt: vaultWalk[blockedRef]?.lastCompleteWalkAt };
    }
    // Mid-walk positions (lora-1/2/3: paid egress) are kept page for page.
    const cursor: VaultCursor = { vaultWalk, afterAlbumRef: legacy?.vaultWalkAfterAlbumRef ?? null, seeded: true, last: null };
    return {
      cursors: [{ resource: VAULT_KEY, subject: "", cursor }],
      notes: { vault: legacy === null ? "none" : "page_sync_cursors.catalog", albums: Object.keys(vaultWalk).length },
    };
  },
};

// ── hydrate ──────────────────────────────────────────────────────────────────

interface HydrateCursor {
  /** Refs a batch did not return, by when they were asked (epoch ms). */
  unserved: Record<string, number>;
  /** The last batch's observation: the next batch waits until its cards are
   *  projected (the queue is read from the projection). */
  lastObservationId: number | null;
  hydratedMedia: number;
  hydratedBundles: number;
  shadow: ShadowWalkProgress | null;
}

function parseHydrateCursor(value: unknown): HydrateCursor {
  const record = recordOf(value);
  const unserved: Record<string, number> = {};
  for (const [ref, at] of Object.entries(recordOf(record.unserved))) {
    const ms = int(at);
    if (ms !== null) unserved[ref] = ms;
  }
  const shadow = recordOf(record.shadow);
  const steps = int(shadow.steps);
  const done = int(shadow.done);
  return {
    unserved,
    lastObservationId: int(record.lastObservationId),
    hydratedMedia: int(record.hydratedMedia) ?? 0,
    hydratedBundles: int(record.hydratedBundles) ?? 0,
    shadow: steps === null || done === null ? null : { steps, done },
  };
}

/** The unserved memory still in force at `now`. */
function freshUnserved(unserved: Record<string, number>, now: Date): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [ref, at] of Object.entries(unserved)) {
    if (now.getTime() - at < UNSERVED_MEMORY_MS) kept[ref] = at;
  }
  return kept;
}

/**
 * What a hydration row starts from: its own memory, or — for a row a new
 * trigger just opened — the memory and last batch of the row before it, so
 * a ref the provider left out is not asked again the next day (the fixed
 * sweep re-triggers the hydration daily).
 */
async function hydrateMemory(db: Database, work: SyncWorkRow, now: Date): Promise<Pick<HydrateCursor, "unserved" | "lastObservationId">> {
  const own = parseHydrateCursor(work.cursor);
  if (Object.keys(own.unserved).length > 0 || own.lastObservationId !== null) {
    return { unserved: freshUnserved(own.unserved, now), lastObservationId: own.lastObservationId };
  }
  const previous = await latestClosedWorkForKey(db, { pageId: work.pageId, shadow: work.shadow, resource: HYDRATE_KEY, subject: work.subject });
  const before = parseHydrateCursor(previous?.cursor);
  return { unserved: freshUnserved(before.unserved, now), lastObservationId: before.lastObservationId };
}

function hydrateStepOf(request: Pick<RequestPlan, "step">): Record<string, number> {
  const unserved: Record<string, number> = {};
  for (const [ref, at] of Object.entries(recordOf(recordOf(request.step).unserved))) {
    const ms = int(at);
    if (ms !== null) unserved[ref] = ms;
  }
  return unserved;
}

/** The next batch: media refs first, then bundle refs, none asked within the
 *  memory window. */
async function nextHydrationBatch(
  db: Database,
  input: { pageId: number; skip: ReadonlySet<string> },
): Promise<RequestPlan | null> {
  const limit = ACCOUNT_MEDIA_BATCH_SIZE + input.skip.size;
  const media = (await listUnhydratedVaultMediaRefs(db, { pageId: input.pageId, limit }))
    .filter((ref) => !input.skip.has(ref)).slice(0, ACCOUNT_MEDIA_BATCH_SIZE);
  if (media.length > 0) return { spec: "account.media_by_ids", params: { ids: media } };
  const bundles = (await listUnhydratedVaultBundleRefs(db, { pageId: input.pageId, limit }))
    .filter((ref) => !input.skip.has(ref)).slice(0, ACCOUNT_MEDIA_BATCH_SIZE);
  return bundles.length > 0 ? { spec: "account.bundles_by_ids", params: { ids: bundles } } : null;
}

/** The ids a batch answer named (a bare array of cards, or an object
 *  wrapping one). */
export function servedCardIds(response: unknown): Set<string> {
  const rows = Array.isArray(response)
    ? response
    : Object.values(recordOf(response)).find((value) => Array.isArray(value)) as unknown[] | undefined ?? [];
  return new Set(rows.flatMap((row) => {
    const id = text(recordOf(row).id);
    return id === null ? [] : [id];
  }));
}

const hydrateModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    const cursor = parseHydrateCursor(work.cursor);
    const memory = await hydrateMemory(ctx.db, work, ctx.now);
    if (!ctx.shadow && memory.lastObservationId !== null && await projectionBehind(ctx.db, {
      pageId: ctx.pageId,
      projection: MEDIA_PLANE_PROJECTION,
      eventTypes: ["media.observed"],
      observationId: memory.lastObservationId,
    })) {
      return { kind: "wait", reason: "dependency", until: null };
    }
    const batch = await nextHydrationBatch(ctx.db, { pageId: ctx.pageId, skip: new Set(Object.keys(memory.unserved)) });
    if (batch === null) return { kind: "done", reason: "hydrated", cursor: { ...cursor, ...memory } };
    return { kind: "request", request: { ...batch, step: { unserved: memory.unserved } } };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const now = input.now;
    const kind = input.request.spec === "account.media_by_ids" ? "account_media_batch" : "account_media_bundle_batch";
    if (classifyCatalogResponse(kind, input.response) === "invalid") {
      throw new ApplyQuarantine("catalog_response_invalid", { kind });
    }
    const cursor = parseHydrateCursor(input.work.cursor);
    const asked = stringList(recordOf(input.request.params).ids);
    const served = servedCardIds(input.response);
    // The memory the plan asked from (a new row's is its predecessor's).
    const unserved = freshUnserved({ ...hydrateStepOf(input.request), ...cursor.unserved }, now);
    for (const ref of asked) if (!served.has(ref)) unserved[ref] = now.getTime();
    const media = input.request.spec === "account.media_by_ids";
    const next: HydrateCursor = {
      unserved,
      lastObservationId: input.observation.id,
      hydratedMedia: cursor.hydratedMedia + (media ? asked.length : 0),
      hydratedBundles: cursor.hydratedBundles + (media ? 0 : asked.length),
      shadow: null,
    };
    await coverageWriter(tx, input.pageId, CAPTURE_COVERAGE_PLANES.catalogMediaHydration, now)("", "in_progress", "none", {
      reasonCode: "batch_hydration",
      cursor: { hydratedMedia: next.hydratedMedia, hydratedBundles: next.hydratedBundles },
    });
    return {
      work: { satisfiesRevision: false, nextDueAt: now, cursor: next },
      followups: [],
      counters: { cards_asked: asked.length, cards_unserved: asked.filter((ref) => !served.has(ref)).length },
    };
  },

  async shadow(work, request, ctx): Promise<ShadowResult> {
    // Shadow hydrates nothing, so the queue does not shrink under it: the
    // pass is the batches the queue holds when it starts, then it closes.
    const cursor = parseHydrateCursor(work.cursor);
    const progress = cursor.shadow ?? await (async () => {
      const result = await ctx.db.execute<{ n: string }>(sql`
        select (
          (select count(distinct m.media_offer_ref) from creator_vault_album_members m
            where m.page_id = ${ctx.pageId} and m.vault_kind = 'creator' and m.media_offer_ref is not null
              and not exists (select 1 from creator_media c where c.page_id = m.page_id and c.media_offer_ref = m.media_offer_ref))
          + (select count(distinct m.bundle_ref) from creator_vault_album_members m
            where m.page_id = ${ctx.pageId} and m.vault_kind = 'creator' and m.bundle_ref is not null
              and not exists (select 1 from creator_media_bundles b where b.page_id = m.page_id and b.bundle_ref = m.bundle_ref))
        )::text as n
      `);
      return { steps: Math.max(1, Math.ceil(Number(result.rows[0]?.n ?? 0) / ACCOUNT_MEDIA_BATCH_SIZE)), done: 0 };
    })();
    const step = advanceShadowWalk(progress, () => progress.steps);
    const asked = stringList(recordOf(request.params).ids).length;
    return step.finished
      ? { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", cursor: { ...cursor, shadow: null } }, followups: [], counters: { cards_asked: asked } }
      : { work: { satisfiesRevision: false, nextDueAt: ctx.now, cursor: { ...cursor, shadow: step.progress } }, followups: [], counters: { cards_asked: asked } };
  },

  replay: replayByCanonicalDrafts,
};

export function catalogModule(variant: CatalogVariant): ResourceModule {
  switch (variant) {
    case "fixed":
      return fixedModule;
    case "vault":
      return vaultModule;
    case "hydrate":
      return hydrateModule;
  }
}

// WP-F3 — the `catalog` capture handler.
//
// The lane that measures **M**: how many distinct media offers a page actually
// has. Everything else it captures — tiers, gift codes, automations, walls,
// both vaults — is inventory the agency wants for its own sake, but M is the
// reason this package ships BEFORE the per-media statistics lane. WP-F4's whole
// sizing (300 calls/page/day against a round-robin whose long-tail cycle is
// M/rate) rests on a number nobody has ever computed. This lane computes it.
//
// ── THE SWEEP, once a UTC day ────────────────────────────────────────────────
//
// SIX FIXED STEPS, one journaled call each, each with its own observation kind:
//
//   vault_albums          /vault/albumsnew                (the REAL vault)
//   uservault_albums      /uservault/albumsnew?accountId= (a DIFFERENT resource)
//   subscription_tiers    /subscriptions/tiers            (FEAT-002)
//   gift_codes            /subscriptions/giftcodes
//   automated_messages    /message/automated
//   account_walls         /account/walls?correlationPostIds=
//
// THEN THE VAULT WALK: `/media/vaultnew` per creator album, first-enable
// exhaustion with a durable per-album cursor, incremental afterwards.
//
// THEN THE BATCH HYDRATIONS: `/account/media?ids=` and
// `/account/media/bundle?ids=`, 100 ids a call, for offers the walk named that
// have no `creator_media` row yet.
//
// Everything rides ONE cap of 60 attempts/page/UTC-day. Crossing it DEFERS to
// the next UTC day and never drops a response already fetched. That is why the
// first-enable exhaustion crawl of a 4 760-item album takes days rather than an
// afternoon, and that is the intended shape: burst is the ban-risk surface.
//
// ── THE `/media/vaultnew` QUERY FORM — the whole reason this lane could have
//    shipped broken ────────────────────────────────────────────────────────────
//
// The 2026-08-22 probe asked `albumId=…&search=&before=&after=` for an album
// with 4 760 items and got `{albumMedia: [], media: []}`. An empty first page
// is INDISTINGUISHABLE from an exhausted album, so a lane that trusted it would
// have recorded "this creator has no media", sized WP-F4 against zero, and been
// wrong in a way no error surfaced.
//
// The app bundle settled it: `before` and `after` are the LITERAL STRING "0" on
// the first page, not empty, and `mediaType` is present-and-empty when
// unfiltered. The adapter now sends exactly that form.
//
// AND THE GUARD STAYS ANYWAY. An empty page is treated as "end of pages" ONLY
// after a non-empty one, or on the first page of an album whose `itemCount` is
// 0. An empty FIRST page on an album the platform says is non-empty means the
// request was not honoured: THAT album's walk is parked with
// `partial_provider_surface` and ONE anomaly, and it never loops. That is
// WP-F1's lesson — a walk that re-asks the question it cannot answer spends a
// day's cap proving it. The album is asked again only when its head or count
// moves, or at the weekly recheck; the rest of the vault keeps walking.
//
// ── WHAT NEVER LEAVES THE JOURNAL ───────────────────────────────────────────
//
// `/vault/albumsnew` and `/media/vaultnew` both embed raw `media[]` rows with
// `location`, `locations[]` and `variants[]` — signed CDN material. The bodies
// are journaled verbatim (DP 7); NOTHING downstream reads those keys. No media
// bytes are fetched, ever.
//
// [A20]: no catalog response carried an `accounts[]` sidecar in the 2026-08-19
// capture, and every one of them goes through `trimFanslyCatalogPayload`
// anyway — see the note there for why a no-op guard is worth having on a DAILY
// lane whose envelope family serves `accounts[]` elsewhere.

import {
  assertOwnedPageSyncLease,
  countCreatorVaultUniqueMembers,
  countPageUniqueCreatorMedia,
  getCheckpoint,
  listCreatorVaultAlbumsForWalk,
  listUnhydratedVaultBundleRefs,
  listUnhydratedVaultMediaRefs,
  sumCreatorVaultAlbumItemCounts,
} from "@agency_hub_core/db";
import { ACCOUNT_MEDIA_BATCH_SIZE, VAULT_MEDIA_HEAD_CURSOR } from "@agency_hub_core/fansly";
import { CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import {
  classifyCatalogResponse,
  emptyAlbumWalk,
  FANSLY_CATALOG_OBSERVATION_KINDS,
  nextVaultCursor,
  parseFanslyCatalogCursorState,
  VAULT_ALBUM_MAX_PAGES,
  vaultMediaRows,
  type FanslyCatalogCursorState,
} from "../../sync/fansly/lib/catalog-rules.ts";
import { fanslyUtcDayKey } from "../../sync/fansly/lib/lane.ts";
import { newVaultWalkProof, observeVaultWalkPage, vaultWalkIsComplete } from "../../sync/fansly/lib/vault-walk-proof.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { composeRequestObservers } from "./chunk-budget.ts";
import type { ExecutorRequestContext, StreamChunkResult } from "./executor-handlers.ts";
import {
  createFanslyLaneCoverageWriter,
  createFanslyLaneJournal,
  createFanslyLaneRuntime,
  FanslyLaneInvalidResponseError,
  nextFanslyUtcDayStart,
  rollFanslyUtcDay,
  spreadFanslyContinuation,
} from "./fansly-lane.ts";
import { evaluateFanslyStreamGate } from "./fansly-stream-gate.ts";
import { summarizeCheckpoint } from "./observability.ts";
import { retentionDate } from "./shared.ts";
import { FANSLY_CATALOG_CAPTURE_MAPPER_VERSION, trimFanslyCatalogPayload } from "../../sync/fansly/lib/capture-trims.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

const STREAM = "catalog" as const;

/** The coverage planes this lane claims. One per capture surface, so a partial
 *  vault walk cannot make the tier capture look degraded and vice versa. */
/**
 * Vault-walk pages in ONE dispatch before a jittered continuation.
 *
 * The chunk budget (5 requests / 45 s) bites long before this on a healthy
 * lane; this is the ceiling for a lane being re-queued aggressively, and it
 * keeps a first-enable crawl from turning into a contiguous burst.
 */
const VAULT_WALK_PAGES_PER_CHUNK = 20;


// ── cursor state ─────────────────────────────────────────────────────────────

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function emptyFanslyCatalogCursorState(now: Date): FanslyCatalogCursorState {
  return {
    version: 1,
    utcDay: utcDayKey(now),
    callsToday: 0,
    fixedStepsDay: null,
    fixedStepIndex: 0,
    vaultWalk: {},
    vaultWalkAfterAlbumRef: null,
    vaultWalkBlockedAlbumRef: null,
    vaultWalkExhausted: false,
  };
}

export const utcDayKey = fanslyUtcDayKey;

/** A new UTC day resets the attempt counter and re-arms the fixed steps.
 *  Nothing else changes: a vault walk that deferred mid-album resumes at
 *  exactly that page. */
export const rollUtcDay = rollFanslyUtcDay;

/** Backfill continuation spacing: the configured delay ± 30 % jitter, so a deep
 *  walk cannot run contiguously. Burst shape, not daily volume, is the real
 *  ban-risk surface. */
export function walkContinuationAt(
  now: Date,
  delayMs: number,
  random: () => number = Math.random,
): Date {
  return spreadFanslyContinuation(now, delayMs, random);
}

// ── the handler ──────────────────────────────────────────────────────────────

function skip(reason: string): StreamChunkResult {
  return { satisfied: true, yieldReason: null, stats: { skipped: reason }, gatedSkip: reason };
}

export async function fanslyCatalogChunk(
  app: AppContext,
  input: ExecutorRequestContext & { syncRunId: number; now?: Date },
): Promise<StreamChunkResult> {
  if (input.pageContext.platform !== "fansly") {
    return skip("not_fansly");
  }
  await input.telemetry.recordPhaseStarted(STREAM);

  const effective = await loadEffectiveConfig(app.db, app.config);
  const gate = evaluateFanslyStreamGate(effective, STREAM, input.pageContext.page.label);
  if (gate.state !== "ramped") {
    return skip(gate.state);
  }

  const now = input.now ?? new Date();
  const pageId = input.pageContext.page.id;
  const dailyCap = Math.max(1, effective.fanslyCatalogDailyCallBudget ?? 60);
  const continuationDelayMs = Math.max(0, effective.fanslyBackfillContinuationDelayMs ?? 20_000);
  const ownAccountRef = asNullableString(input.pageContext.page.platformAccountId);

  const checkpoint = await getCheckpoint(app.db, pageId, STREAM);
  await input.telemetry.recordCheckpointLoaded(STREAM, summarizeCheckpoint(checkpoint));
  let state = rollUtcDay(
    parseFanslyCatalogCursorState(checkpoint?.state) ?? emptyFanslyCatalogCursorState(now),
    now,
  );

  const lane = createFanslyLaneRuntime({
    db: app.db,
    pageId,
    stream: STREAM,
    cursorText: () => state.fixedStepsDay,
    dailyCap,
    telemetry: input.telemetry,
    downstreamObserver: composeRequestObservers(
      input.telemetry.getRequestObserver(),
      input.budget,
    ),
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    session: input.pageContext.session,
    proxy: input.pageContext.proxy,
    egressKey: input.pageContext.egressKey,
    sendGuard: fanslyPageSendGuard(app, input.pageContext.page.id, "sync_stream"),
  });
  const { attemptBudget, complete: completeLane, requestContext, saveProgress } = lane;

  let journaled = 0;
  let deferred: string | null = null;

  /**
   * Journal FIRST, always, and apply the [A20] allowlist to embedded
   * `accounts[]` on the way in.
   *
   * The trim runs HERE rather than in the adapter for the same reason every
   * other Fansly lane puts it here: the adapter is a transport and must hand
   * the whole body through, and the ONE place that decides what reaches the
   * journal should be the one place a test can pin.
   */
  const journal = createFanslyLaneJournal({
    db: app.db,
    pageId,
    syncRunId: input.syncRunId,
    mapperVersion: FANSLY_CATALOG_CAPTURE_MAPPER_VERSION,
    payloadKind: "mapping_critical",
    retainUntil: retentionDate(),
    onJournal: () => { journaled += 1; },
  });
  const persist = async (
    kind: string,
    requestParams: Record<string, unknown>,
    payload: unknown,
  ) => {
    const result = await journal(kind, requestParams, trimFanslyCatalogPayload(payload));
    if (classifyCatalogResponse(kind, payload) === "invalid") {
      throw new FanslyLaneInvalidResponseError(kind);
    }
    return result;
  };

  /** Room for one more call today? Crossing this defers; it never drops. */
  const hasDayCapacity = attemptBudget.hasCapacity;


  const coverage = createFanslyLaneCoverageWriter({
    db: app.db,
    pageId,
    scopeRef: "",
    acquisitionMode: "retroactive",
    newestCapturedAt: now,
  });

  // ── THE SIX FIXED STEPS ────────────────────────────────────────────────────
  //
  // Each is one call, journaled under its own kind. They run in order and the
  // index is durable, so a chunk that defers mid-sweep resumes at the step it
  // did not reach rather than re-issuing the ones it did.
  const fixedSteps: {
    kind: string;
    run: () => Promise<{ items: unknown; raw: unknown }> | null;
    requestParams: Record<string, unknown>;
  }[] = [
    {
      kind: FANSLY_CATALOG_OBSERVATION_KINDS.vaultAlbums,
      requestParams: {},
      run: () => app.adapter.getVaultAlbums(requestContext),
    },
    {
      kind: FANSLY_CATALOG_OBSERVATION_KINDS.userVaultAlbums,
      requestParams: { accountId: ownAccountRef },
      // The page's OWN account ref. Null means the `light` sync has not yet
      // written it; the step is skipped rather than guessed at, and the
      // coverage row says which.
      run: () =>
        ownAccountRef === null
          ? null
          : app.adapter.getUserVaultAlbums(requestContext, { accountId: ownAccountRef }),
    },
    {
      kind: FANSLY_CATALOG_OBSERVATION_KINDS.subscriptionTiers,
      requestParams: {},
      run: () => app.adapter.getSubscriptionTiers(requestContext),
    },
    {
      kind: FANSLY_CATALOG_OBSERVATION_KINDS.giftCodes,
      requestParams: {},
      run: () => app.adapter.getGiftCodes(requestContext),
    },
    {
      kind: FANSLY_CATALOG_OBSERVATION_KINDS.automatedMessages,
      requestParams: {},
      run: () => app.adapter.getAutomatedMessages(requestContext),
    },
    {
      kind: FANSLY_CATALOG_OBSERVATION_KINDS.accountWalls,
      // The app sends `correlationPostIds=` as an encoded CSV; the bare form
      // returned all ten walls on the 2026-08-22 probe, which is what this lane
      // wants — every wall, not the walls of some posts.
      requestParams: { correlationPostIds: "" },
      run: () => app.adapter.getAccountWalls(requestContext, { correlationPostIds: "" }),
    },
  ];

  const fixedStepsDueToday = state.fixedStepsDay !== utcDayKey(now);

  if (fixedStepsDueToday) {
    while (state.fixedStepIndex < fixedSteps.length) {
      if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
        break;
      }
      if (!hasDayCapacity()) {
        deferred = "daily_call_budget";
        break;
      }
      const step = fixedSteps[state.fixedStepIndex]!;
      await assertOwnedPageSyncLease(app.db);
      const pending = step.run();
      if (pending === null) {
        // A step whose precondition is missing is SKIPPED, loudly. Guessing an
        // account ref would ask the platform about somebody else's vault.
        await coverage(
          CAPTURE_COVERAGE_PLANES.catalog,
          "partial_provider_surface",
          "none",
          {
            scopeRef: step.kind,
            reasonCode: "own_account_ref_unknown",
            cursor: { note: "pages.external_page_id is null; run the light sync first" },
          },
        );
        state = { ...state, fixedStepIndex: state.fixedStepIndex + 1 };
        await saveProgress();
        continue;
      }
      const response = await pending;
      const persisted = await persist(step.kind, step.requestParams, response.raw);
      state = { ...state, fixedStepIndex: state.fixedStepIndex + 1 };
      await coverage(
        CAPTURE_COVERAGE_PLANES.catalog,
        // A full listing served in one call IS the provider's whole surface for
        // that kind — there is no deeper page to reach.
        "provider_exhausted",
        "terminal_response",
        {
          scopeRef: step.kind,
          proofObservationId: persisted.observationId ?? null,
          reasonCode: "full_listing",
        },
      );
      await saveProgress();
    }

    if (state.fixedStepIndex >= fixedSteps.length) {
      state = { ...state, fixedStepsDay: utcDayKey(now), fixedStepIndex: 0 };
      await saveProgress();
    } else {
      // Out of budget mid-sweep. The steps already taken are journaled; the
      // rest resume at the index above.
      return await finish({ phase: "fixed_steps" });
    }
  }

  // ── THE VAULT WALK ─────────────────────────────────────────────────────────
  //
  // Albums come from the projection, which means the walk only ever runs after
  // the first `/vault/albumsnew` capture has been canonicalized and projected.
  // That ordering is deliberate: walking an album list we have not stored would
  // make the walk's state unattributable to anything a rebuild can reproduce.
  const albums = await listCreatorVaultAlbumsForWalk(app.db, pageId);
  let walkPages = 0;
  let walkStatus: string = state.vaultWalkExhausted ? "exhausted" : "walking";

  if (state.vaultWalkBlockedAlbumRef !== null) {
    // LEGACY BLOCK, lifted. It stopped the walk for every album "until an
    // operator looks", and nothing ever looked: one refused album froze the
    // vault's inventory while the lane reported success. The refused album's
    // walk still points at the head it already asked, which the repeat guard
    // would read as a loop; re-open it so it is asked once more and, if the
    // refusal stands, parked on its own (below).
    const blockedRef = state.vaultWalkBlockedAlbumRef;
    const blocked = state.vaultWalk[blockedRef];
    state = {
      ...state,
      vaultWalkBlockedAlbumRef: null,
      vaultWalk: blocked === undefined
        ? state.vaultWalk
        : { ...state.vaultWalk, [blockedRef]: { ...emptyAlbumWalk(), lastCompleteWalkAt: blocked.lastCompleteWalkAt } },
    };
  }

  if (albums.length === 0) {
    walkStatus = "no_albums";
  }

  if (walkStatus === "walking" || walkStatus === "exhausted") {
    let exhausted = true;
    const start = albums.findIndex(album => album.albumRef === state.vaultWalkAfterAlbumRef) + 1;
    const rotated = [...albums.slice(start), ...albums.slice(0, start)];
    // First inventory takes priority, with round-robin fairness inside each
    // cohort. Do not reset the rotation when the UTC daily budget rolls over.
    const ordered = [
      ...rotated.filter(album => !state.vaultWalk[album.albumRef]?.lastCompleteWalkAt),
      ...rotated.filter(album => state.vaultWalk[album.albumRef]?.lastCompleteWalkAt),
    ];
    for (const album of ordered) {
      if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
        exhausted = false;
        break;
      }
      if (walkPages >= VAULT_WALK_PAGES_PER_CHUNK) {
        exhausted = false;
        break;
      }
      if (!hasDayCapacity()) {
        deferred = "daily_call_budget";
        exhausted = false;
        break;
      }

      const stored = state.vaultWalk[album.albumRef];
      let walk = stored === undefined ? emptyAlbumWalk() : { ...stored };
      // INCREMENTAL RE-WALK: the platform's `lastItemId` moved, so the album's
      // head holds rows this walk has never seen. Re-open it from the head; the
      // re-observation advances freshness even when membership is unchanged.
      if (
        walk.done && (walk.completedAtLastItemRef !== album.lastItemRef
          || walk.proof === undefined || walk.proof.expectedCount !== album.itemCount
          || walk.completedOnUtcDay === undefined
          || Date.parse(state.utcDay) - Date.parse(walk.completedOnUtcDay) >= 7 * 86_400_000)
      ) {
        walk = { ...emptyAlbumWalk(), lastCompleteWalkAt: walk.lastCompleteWalkAt };
      }
      if (walk.done) {
        continue;
      }
      // A legacy tail has no inventory proof. Start that generation at HEAD.
      if (walk.proof === undefined) walk = { ...emptyAlbumWalk(), lastCompleteWalkAt: walk.lastCompleteWalkAt, proof: newVaultWalkProof(album) };
      exhausted = false;
      state = { ...state, vaultWalkAfterAlbumRef: album.albumRef };

      // REPEAT-REQUEST GUARD, spent before any egress. The identical `before`
      // twice in one walk is a loop's first visible step (WP-F1 spent a whole
      // day's cap on that shape on production), and there is nothing to learn
      // from issuing it.
      if (walk.lastRequestedBefore === walk.beforeRef) {
        await input.telemetry.addAnomaly({
          code: "fansly_catalog_vault_cursor_repeat",
          severity: "warn",
          message: "Fansly vault pagination did not advance; album walk stopped",
          details: { albumRef: album.albumRef, before: walk.beforeRef },
        });
        walk = { ...walk, done: true, completedAtLastItemRef: album.lastItemRef, completedOnUtcDay: state.utcDay };
        state = { ...state, vaultWalk: { ...state.vaultWalk, [album.albumRef]: walk } };
        await coverage(
          CAPTURE_COVERAGE_PLANES.catalogVaultMedia,
          "partial_provider_surface",
          "none",
          {
            scopeRef: album.albumRef,
            reasonCode: "repeat_request",
            expectedCount: album.itemCount,
            cursor: { beforeRef: walk.beforeRef, pages: walk.pages },
          },
        );
        await saveProgress();
        continue;
      }

      if (walk.pages >= VAULT_ALBUM_MAX_PAGES) {
        await input.telemetry.addAnomaly({
          code: "fansly_catalog_vault_walk_capped",
          severity: "warn",
          message: "Fansly vault album walk hit its page cap before exhausting the album",
          details: { albumRef: album.albumRef, pages: walk.pages, itemCount: album.itemCount },
        });
        walk = { ...walk, done: true, completedAtLastItemRef: album.lastItemRef, completedOnUtcDay: state.utcDay };
        state = { ...state, vaultWalk: { ...state.vaultWalk, [album.albumRef]: walk } };
        await coverage(
          CAPTURE_COVERAGE_PLANES.catalogVaultMedia,
          "partial_provider_surface",
          "none",
          {
            scopeRef: album.albumRef,
            reasonCode: "page_cap",
            expectedCount: album.itemCount,
            cursor: { beforeRef: walk.beforeRef, pages: walk.pages },
          },
        );
        await saveProgress();
        continue;
      }

      await assertOwnedPageSyncLease(app.db);
      const requestedBefore = walk.beforeRef;
      const response = await app.adapter.getVaultMediaPage(requestContext, {
        albumId: album.albumRef,
        // Present and EMPTY when unfiltered, exactly as the app sends it.
        mediaType: "",
        search: "",
        before: requestedBefore,
        after: VAULT_MEDIA_HEAD_CURSOR,
      });
      const persisted = await persist(FANSLY_CATALOG_OBSERVATION_KINDS.vaultMedia, {
        albumId: album.albumRef,
        mediaType: "",
        search: "",
        before: requestedBefore,
        after: VAULT_MEDIA_HEAD_CURSOR,
      }, response.raw);
      walkPages += 1;
      walk = {
        ...walk,
        lastRequestedBefore: requestedBefore,
        pages: walk.pages + 1,
      };

      const rows = vaultMediaRows(response.raw);
      walk.proof = observeVaultWalkPage(walk.proof!, album.albumRef, rows, persisted.observationId ?? null);
      if ((response.raw as { albumMedia: unknown[] }).albumMedia.length !== rows.length) walk.proof.valid = false;
      if (rows.length === 0) {
        const firstPage = requestedBefore === VAULT_MEDIA_HEAD_CURSOR && !walk.sawRows;
        const albumClaimsEmpty = album.itemCount === 0;
        if (firstPage && !albumClaimsEmpty) {
          // AN EMPTY FIRST PAGE ON A NON-EMPTY ALBUM IS NOT AN EXHAUSTED ALBUM.
          // It is a request the server did not honour, and calling it "no
          // media" would size WP-F4 against a zero that does not exist. THIS
          // ALBUM is parked — one anomaly, no loop (WP-F1's lesson) — like the
          // repeat and page-cap stops above: the recheck rule asks it again
          // when its head or count moves, or after seven days. No completion
          // is recorded; a previous proven walk's `lastCompleteWalkAt` stays.
          await input.telemetry.addAnomaly({
            code: "fansly_catalog_vault_empty_first_page",
            severity: "warn",
            message:
              "Fansly served an empty first vault page for a non-empty album; "
              + "album walk parked rather than recording an empty inventory",
            details: {
              albumRef: album.albumRef,
              itemCount: album.itemCount,
              before: requestedBefore,
            },
          });
          walk = { ...walk, done: true, completedAtLastItemRef: album.lastItemRef, completedOnUtcDay: state.utcDay };
          state = { ...state, vaultWalk: { ...state.vaultWalk, [album.albumRef]: walk } };
          await coverage(
            CAPTURE_COVERAGE_PLANES.catalogVaultMedia,
            "partial_provider_surface",
            "terminal_response",
            {
              scopeRef: album.albumRef,
              proofObservationId: persisted.observationId ?? null,
              reasonCode: "empty_first_page_on_non_empty_album",
              expectedCount: album.itemCount,
              observedUniqueCount: 0,
              cursor: { before: requestedBefore },
            },
          );
          await saveProgress();
          continue;
        }
        // THE END OF THE ALBUM. Either a non-empty page came before it, or the
        // platform itself says the album holds nothing — the empty response IS
        // the evidence, and it is journaled.
        const complete = vaultWalkIsComplete(walk.proof, album);
        if (complete) {
          const completedAt = new Date().toISOString();
          // Separate derived observation: the original HTTP body stays intact.
          await journal("vault_album_walk_completed", { albumId: album.albumRef }, {
            ...walk.proof, albumRef: album.albumRef, vaultKind: "creator",
            completedAt, pages: walk.pages,
          });
          walk = { ...walk, lastCompleteWalkAt: completedAt };
        }
        walk = { ...walk, done: true, completedAtLastItemRef: album.lastItemRef, completedOnUtcDay: state.utcDay };
        state = { ...state, vaultWalk: { ...state.vaultWalk, [album.albumRef]: walk } };
        await coverage(
          CAPTURE_COVERAGE_PLANES.catalogVaultMedia,
          complete ? "provider_exhausted" : "partial_provider_surface",
          "empty_window",
          {
            scopeRef: album.albumRef,
            proofObservationId: persisted.observationId ?? null,
            reasonCode: !complete ? "walk_inventory_mismatch" : albumClaimsEmpty ? "album_empty" : "walk_exhausted",
            expectedCount: album.itemCount,
            observedUniqueCount: walk.proof!.seenMediaRefs.length,
            cursor: { pages: walk.pages, lastItemRef: album.lastItemRef },
          },
        );
        await saveProgress();
        continue;
      }

      const cursor = nextVaultCursor(rows);
      if (cursor === null) {
        // Rows with no usable id: the walk cannot advance and must not pretend
        // it did. Stop this album, keep the bytes.
        await input.telemetry.addAnomaly({
          code: "fansly_catalog_vault_cursor_missing",
          severity: "warn",
          message: "Fansly vault page carried rows with no id; album walk stopped",
          details: { albumRef: album.albumRef, rows: rows.length },
        });
        walk = { ...walk, done: true, sawRows: true, completedAtLastItemRef: album.lastItemRef, completedOnUtcDay: state.utcDay };
        state = { ...state, vaultWalk: { ...state.vaultWalk, [album.albumRef]: walk } };
        await coverage(
          CAPTURE_COVERAGE_PLANES.catalogVaultMedia,
          "partial_provider_surface",
          "terminal_response",
          {
            scopeRef: album.albumRef,
            proofObservationId: persisted.observationId ?? null,
            reasonCode: "cursor_missing",
            expectedCount: album.itemCount,
          },
        );
        await saveProgress();
        continue;
      }

      walk = { ...walk, sawRows: true, beforeRef: cursor };
      state = { ...state, vaultWalk: { ...state.vaultWalk, [album.albumRef]: walk } };
      await coverage(
        CAPTURE_COVERAGE_PLANES.catalogVaultMedia,
        "in_progress",
        "none",
        {
          scopeRef: album.albumRef,
          reasonCode: "walking",
          expectedCount: album.itemCount,
          cursor: { beforeRef: cursor, pages: walk.pages },
        },
      );
      await saveProgress();
    }

    walkStatus = exhausted ? "exhausted" : "walking";
    if (exhausted !== state.vaultWalkExhausted) {
      state = { ...state, vaultWalkExhausted: exhausted };
    }
  }

  if (deferred !== null) {
    return await finish({ phase: "vault_walk", walkStatus });
  }

  // ── THE BATCH HYDRATIONS ───────────────────────────────────────────────────
  //
  // The walk names media OFFERS; `/account/media?ids=` returns their CARDS
  // (price, permissions, sale counters). 100 ids a call — the app's own batch
  // size, read out of its bundle rather than guessed.
  //
  // Both hydrations ride the same daily cap as everything above, so on a page
  // whose vault is still being crawled they simply do not run today. That is
  // the right order: membership is what M is measured from, and a card without
  // its membership row tells us nothing about inventory size.
  let hydratedMedia = 0;
  let hydratedBundles = 0;

  while (
    input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
  ) {
    if (!hasDayCapacity()) {
      deferred = "daily_call_budget";
      break;
    }
    const ids = await listUnhydratedVaultMediaRefs(app.db, {
      pageId,
      limit: ACCOUNT_MEDIA_BATCH_SIZE,
    });
    if (ids.length === 0) {
      break;
    }
    await assertOwnedPageSyncLease(app.db);
    const response = await app.adapter.getAccountMediaByIds(requestContext, {
      ids: ids.join(","),
    });
    await persist(
      FANSLY_CATALOG_OBSERVATION_KINDS.accountMediaBatch,
      { idCount: ids.length, firstId: ids[0] ?? null },
      response.raw,
    );
    hydratedMedia += ids.length;
    // ONE batch per dispatch. The queue is re-read from the projection, which
    // only moves once the canonicalizer and projector have run, so a second
    // batch in the same chunk would re-request the same ids.
    break;
  }

  if (deferred === null) {
    while (
      input.budget.hasRequestCapacity(1) && input.budget.hasWallClockCapacity()
    ) {
      if (!hasDayCapacity()) {
        deferred = "daily_call_budget";
        break;
      }
      const ids = await listUnhydratedVaultBundleRefs(app.db, {
        pageId,
        limit: ACCOUNT_MEDIA_BATCH_SIZE,
      });
      if (ids.length === 0) {
        break;
      }
      await assertOwnedPageSyncLease(app.db);
      const response = await app.adapter.getAccountMediaBundlesByIds(requestContext, {
        ids: ids.join(","),
      });
      await persist(
        FANSLY_CATALOG_OBSERVATION_KINDS.accountMediaBundleBatch,
        { idCount: ids.length, firstId: ids[0] ?? null },
        response.raw,
      );
      hydratedBundles += ids.length;
      break;
    }
  }

  if (hydratedMedia > 0 || hydratedBundles > 0) {
    await coverage(
      CAPTURE_COVERAGE_PLANES.catalogMediaHydration,
      "in_progress",
      "none",
      { reasonCode: "batch_hydration", cursor: { hydratedMedia, hydratedBundles } },
    );
  }

  return await finish({ phase: "hydration", walkStatus });

  /**
   * The one exit. Every return path measures M first, because M is this lane's
   * named output (A16 item 1) and a dispatch that captured nothing new still
   * has to report the current number — a stats block that goes blank when a
   * sweep is deferred reads like the inventory vanished.
   */
  async function finish(
    extra: { phase: string; walkStatus?: string },
  ): Promise<StreamChunkResult> {
    const uniqueMediaCount = await countPageUniqueCreatorMedia(app.db, pageId);
    const vaultMemberUniqueCount = await countCreatorVaultUniqueMembers(app.db, pageId);
    // Σ item_count. NON-UNIQUE by construction — the system albums are views
    // over the same media, so this DOUBLE-COUNTS and is labelled accordingly
    // everywhere it is shown.
    const albumMembershipSum = await sumCreatorVaultAlbumItemCounts(app.db, pageId);

    const stats: Record<string, unknown> = {
      phase: extra.phase,
      journaled,
      callsToday: state.callsToday,
      dailyCap,
      // ── M, and the number M is not ──
      uniqueMediaCount,
      vaultMemberUniqueCount,
      albumMembershipSum,
      vaultWalkStatus: extra.walkStatus ?? "not_started",
      ...(deferred === null ? {} : { deferred }),
    };

    if (deferred !== null) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        // Deferred at the cap: come back after the UTC roll.
        continuationRetryAt: nextFanslyUtcDayStart(now),
        stats,
      };
    }
    if (!input.budget.hasRequestCapacity(1) || !input.budget.hasWallClockCapacity()) {
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: input.budget.resolveYieldReason(1),
        // A jittered continuation, because burst shape is the ban-risk surface.
        continuationRetryAt: walkContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
    if (extra.walkStatus === "walking") {
      // More vault pages are owed and there is budget for them; hand the rest
      // of the day to the walk, spaced.
      await saveProgress();
      return {
        satisfied: false,
        yieldReason: null,
        continuationRetryAt: walkContinuationAt(now, continuationDelayMs),
        stats,
      };
    }
  await completeLane(input.syncRunId);
    return { satisfied: true, yieldReason: null, stats };
  }
}

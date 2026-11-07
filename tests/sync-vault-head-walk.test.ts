import { describe, expect, it, vi, beforeEach } from "vitest";

import type * as DbModule from "@agency_hub_core/db";
import type { Database, SyncWorkRow } from "@agency_hub_core/db";
import type * as LaneModule from "../apps/runtime/src/sync/fansly/lib/lane.ts";

import { emptyAlbumWalk, type VaultAlbumWalkState } from "../apps/runtime/src/sync/fansly/lib/catalog-rules.ts";
import { vaultHeadWalkPage, vaultRewalkMode, type VaultHeadBasis } from "../apps/runtime/src/sync/fansly/lib/vault-head-walk.ts";
import type { VaultWalkProof } from "../apps/runtime/src/sync/fansly/lib/vault-walk-proof.ts";
import type { ApplyInput, PlanContext } from "../apps/runtime/src/sync/engine/resource.ts";
import { catalogModule } from "../apps/runtime/src/sync/fansly/resources/catalog.ts";

// The vault walk's head walk (owner decision №6 «инкрементально ежедневно,
// полностью еженедельно», 2026-11-07): a moved album is read from its head
// down to the old head and checked against Fansly's count; anything that does
// not add up hands the album to the full walk at once, and the full walk stays
// due a week after the last one. Before it, a moved album was re-walked head to
// end every day (lora-1: ~330 requests and ~32k events a day for ~15 new media).

const db = vi.hoisted(() => ({
  albums: [] as Array<{ albumRef: string; itemCount: number | null; lastItemRef: string | null }>,
  walkCompleted: 0,
  coverage: [] as Array<{ scopeRef: string; status: string; proof: string; reasonCode?: string | null }>,
}));
vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  listCreatorVaultAlbumsForWalk: async () => db.albums,
  insertObservation: async () => {
    db.walkCompleted += 1;
    return { id: 1, inserted: true };
  },
}));
vi.mock("../apps/runtime/src/sync/fansly/lib/projection-lag.ts", () => ({ projectionBehind: async () => false }));
vi.mock("../apps/runtime/src/sync/fansly/lib/lane.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof LaneModule>()),
  writeFanslyLaneCoverage: async (input: { scopeRef: string; status: string; proof: string; reasonCode?: string | null }) => {
    db.coverage.push({ scopeRef: input.scopeRef, status: input.status, proof: input.proof, reasonCode: input.reasonCode ?? null });
    return { applied: true };
  },
}));

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const NOW = new Date("2026-11-08T03:00:00.000Z");
const TODAY = "2026-11-08";
const vault = catalogModule("vault");
const tx = { execute: async () => ({ rowCount: 0, rows: [] }) } as unknown as Database;

/** Media ids `${prefix}${n}` … `${prefix}1`, newest first. */
const refs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${n - i}`);

/** An album fully walked on `day`, its generation proven, `seen` as served. */
function fullyWalked(seen: string[], day: string, extra: Partial<VaultAlbumWalkState> = {}): VaultAlbumWalkState {
  return {
    ...emptyAlbumWalk(),
    done: true,
    sawRows: true,
    pages: 2,
    completedAtLastItemRef: seen[0]!,
    completedOnUtcDay: day,
    lastCompleteWalkAt: `${day}T02:10:00.000Z`,
    proof: {
      walkRef: "w1", startedAt: `${day}T02:00:00.000Z`, expectedCount: seen.length, headRef: seen[0]!,
      seenMediaRefs: seen, observationRefs: [11, 12], valid: true,
    },
    ...extra,
  };
}

function page(albumRef: string, mediaRefs: string[]) {
  return { albumMedia: mediaRefs.map((mediaId) => ({ id: `m-${mediaId}`, albumId: albumRef, mediaId })), media: [] };
}

function ctx(labels: string, pageLabel = "lora-1"): PlanContext {
  return {
    db: tx,
    pageId: 1,
    now: NOW,
    page: { pageLabel, registryOverrides: {} },
    settings: { read: async () => ({ fanslyVaultHeadWalkPages: labels }) },
  } as unknown as PlanContext;
}

async function step(cursor: unknown, labels: string, response: (request: { params: Record<string, unknown> }) => unknown) {
  const plan = await vault.plan({ cursor } as unknown as SyncWorkRow, ctx(labels));
  if (plan.kind !== "request") return { plan, applied: null };
  const applied = await vault.apply(tx, {
    pageId: 1,
    now: NOW,
    ownRef: "own",
    work: { cursor } as unknown as SyncWorkRow,
    attempt: { id: 900 },
    request: plan.request,
    response: response(plan.request as { params: Record<string, unknown> }),
    observation: { id: 500, receivedAt: NOW },
  } as unknown as ApplyInput);
  return { plan, applied };
}

beforeEach(() => {
  db.walkCompleted = 0;
  db.coverage = [];
});

describe("vault: how a moved album is walked again", () => {
  const seen = refs("k", 30);
  const basis: VaultHeadBasis = { count: 30, headMediaRefs: seen.slice(0, 20) };
  const on = { headWalkOn: true, utcDay: TODAY, fullEveryMs: WEEK };

  it("reads an album that only grew from its head when its last full walk proved it", () => {
    const walk = fullyWalked(seen, "2026-11-07");
    expect(vaultRewalkMode({ ...on, walk, album: { itemCount: 32 } })).toEqual({ mode: "head", basis, fullWalkOnUtcDay: "2026-11-07" });
    expect(vaultRewalkMode({ ...on, headWalkOn: false, walk, album: { itemCount: 32 } })).toEqual({ mode: "full" });
  });

  it("walks in full when the count did not grow, the inventory is unproven or the weekly walk is due", () => {
    const walk = fullyWalked(seen, "2026-11-07");
    expect(vaultRewalkMode({ ...on, walk, album: { itemCount: 30 } })).toEqual({ mode: "full" });
    expect(vaultRewalkMode({ ...on, walk, album: { itemCount: 29 } })).toEqual({ mode: "full" });
    expect(vaultRewalkMode({ ...on, walk, album: { itemCount: null } })).toEqual({ mode: "full" });
    // The stored proof is a later generation that did not complete.
    const mismatched = { ...walk, lastCompleteWalkAt: "2026-11-01T02:10:00.000Z" };
    expect(vaultRewalkMode({ ...on, walk: mismatched, album: { itemCount: 32 } })).toEqual({ mode: "full" });
    const short = { ...walk, proof: { ...walk.proof!, seenMediaRefs: seen.slice(1) } };
    expect(vaultRewalkMode({ ...on, walk: short, album: { itemCount: 32 } })).toEqual({ mode: "full" });
    expect(vaultRewalkMode({ ...on, walk: fullyWalked(seen, "2026-11-01"), album: { itemCount: 32 } })).toEqual({ mode: "full" });
  });

  it("keeps the weekly full walk due from the last full walk, not from the head walks after it", () => {
    const headClosed: VaultAlbumWalkState = {
      ...fullyWalked(seen, "2026-11-07"), mode: "head", basis, fullWalkOnUtcDay: "2026-11-01",
    };
    expect(vaultRewalkMode({ ...on, walk: headClosed, album: { itemCount: 32 } })).toEqual({ mode: "full" });
    expect(vaultRewalkMode({ ...on, walk: { ...headClosed, fullWalkOnUtcDay: "2026-11-02" }, album: { itemCount: 32 } }))
      .toEqual({ mode: "head", basis, fullWalkOnUtcDay: "2026-11-02" });
  });
});

describe("vault: one page of a head walk", () => {
  const basis: VaultHeadBasis = { count: 30, headMediaRefs: refs("k", 30).slice(0, 20) };
  const proof = (seenMediaRefs: string[], expectedCount = 32): VaultWalkProof => ({
    walkRef: "h", startedAt: NOW.toISOString(), expectedCount, headRef: "n2", seenMediaRefs, observationRefs: [1], valid: true,
  });
  const rows = (mediaRefs: string[]) => mediaRefs.map((mediaId) => ({ id: `m-${mediaId}`, albumId: "a1", mediaId }));
  const album = { itemCount: 32, lastItemRef: "n2" };
  const at = (mediaRefs: string[], before: string[] = [], expectedCount = 32) => vaultHeadWalkPage({
    basis, before: proof(before, expectedCount), after: proof([...before, ...mediaRefs], expectedCount), rows: rows(mediaRefs),
    next: `m-${mediaRefs.at(-1) ?? "none"}`, requestedBefore: before.length === 0 ? "0" : `m-${before.at(-1)}`, pages: 1, maxPages: 400,
    album: { ...album, itemCount: expectedCount },
  });

  it("stops at the old head and proves the album when the new rows add up to Fansly's count", () => {
    expect(at(["n2", "n1", "k30", "k29"])).toEqual({
      kind: "caught_up", newMembers: 2, basis: { count: 32, headMediaRefs: ["n2", "n1", ...basis.headMediaRefs.slice(0, 18)] },
    });
    // A known id further down (the old head itself was removed) still stops
    // the walk; the count then says a member went.
    expect(at(["n2", "n1", "k29"])).toEqual({ kind: "caught_up", newMembers: 2, basis: expect.objectContaining({ count: 32 }) });
    expect(at(["n2", "n1", "k29"], [], 31)).toEqual({ kind: "fallback", reason: "count_mismatch" });
  });

  it("goes on while the new rows still fit the growth, and counts them across pages", () => {
    const many = refs("n", 52).slice(0, 50);
    const grown = (n: number) => vaultHeadWalkPage({
      basis, before: proof([], 30 + n), after: proof(many, 30 + n), rows: rows(many),
      next: "m-n3", requestedBefore: "0", pages: 1, maxPages: 400, album: { itemCount: 30 + n, lastItemRef: "n2" },
    });
    expect(grown(52)).toEqual({ kind: "continue" });
    expect(grown(50)).toEqual({ kind: "continue" });
    expect(grown(49)).toEqual({ kind: "fallback", reason: "old_head_not_found" });
    const second = vaultHeadWalkPage({
      basis, before: proof(many, 82), after: proof([...many, "n2", "n1", "k30"], 82), rows: rows(["n2", "n1", "k30"]),
      next: "m-k30", requestedBefore: "m-n3", pages: 2, maxPages: 400, album: { itemCount: 82, lastItemRef: "n2" },
    });
    expect(second).toMatchObject({ kind: "caught_up", newMembers: 52, basis: { count: 82 } });
  });

  it("hands the album to a full walk when the old head is not met, the page is bad, or the album moved meanwhile", () => {
    expect(at(["n3", "n2", "n1"])).toEqual({ kind: "fallback", reason: "old_head_not_found" });
    expect(at([])).toEqual({ kind: "fallback", reason: "old_head_not_found" });
    expect(vaultHeadWalkPage({
      basis, before: proof([]), after: { ...proof(["n2", "n1", "k30"]), valid: false }, rows: rows(["n2", "n1", "k30"]),
      next: "m-k30", requestedBefore: "0", pages: 1, maxPages: 400, album,
    })).toEqual({ kind: "fallback", reason: "invalid_page" });
    expect(vaultHeadWalkPage({
      basis, before: proof([]), after: proof(["n2", "n1", "k30"]), rows: rows(["n2", "n1", "k30"]),
      next: "m-k30", requestedBefore: "0", pages: 1, maxPages: 400, album: { itemCount: 33, lastItemRef: "n3" },
    })).toEqual({ kind: "fallback", reason: "count_mismatch" });
  });
});

describe("vault: the walk on a page of fanslyVaultHeadWalkPages", () => {
  const known = refs("k", 30);
  const yesterday = { vaultWalk: { a1: fullyWalked(known, "2026-11-07") }, afterAlbumRef: "a1", last: null };

  it("reads a grown album with one request, proves it against the count, and marks nothing missing", async () => {
    db.albums = [{ albumRef: "a1", itemCount: 32, lastItemRef: "n2" }];
    const { plan, applied } = await step(yesterday, "lora-2, lora-1", () => page("a1", ["n2", "n1", ...known]));
    expect(plan).toMatchObject({
      kind: "request",
      request: { spec: "vault.media", params: { albumId: "a1", before: "0" }, step: { mode: "head", start: { mode: "head", basis: { count: 30 }, fullWalkOnUtcDay: "2026-11-07" } } },
    });
    const walk = (applied!.work.cursor as { vaultWalk: Record<string, VaultAlbumWalkState> }).vaultWalk.a1!;
    expect(walk).toMatchObject({ done: true, mode: "head", pages: 1, completedAtLastItemRef: "n2", completedOnUtcDay: TODAY, fullWalkOnUtcDay: "2026-11-07" });
    expect(walk.basis).toEqual({ count: 32, headMediaRefs: ["n2", "n1", ...known.slice(0, 18)] });
    expect(applied!.work.satisfiesRevision).toBe(true);
    expect(db.walkCompleted).toBe(0);
    expect(db.coverage).toEqual([{ scopeRef: "a1", status: "provider_exhausted", proof: "complete_count_matched", reasonCode: "head_walk_caught_up" }]);

    // Caught up, the album rests until it moves again.
    db.albums = [{ albumRef: "a1", itemCount: 32, lastItemRef: "n2" }];
    expect((await step(applied!.work.cursor, "lora-1", () => null)).plan).toMatchObject({ kind: "wait", reason: "not_due" });
  });

  it("walks the album in full at once when the count does not add up, before any other album", async () => {
    db.albums = [{ albumRef: "a0", itemCount: 3, lastItemRef: "z3" }, { albumRef: "a1", itemCount: 32, lastItemRef: "n2" }];
    const cursor = { ...yesterday, vaultWalk: { ...yesterday.vaultWalk, a0: fullyWalked(["z2", "z1"], "2026-11-07") }, afterAlbumRef: "a0" };
    // Two new above the old head, but one known member went: 30 + 2 ≠ 31.
    db.albums[1]!.itemCount = 31;
    const head = await step(cursor, "lora-1", () => page("a1", ["n2", "n1", ...known.slice(1)]));
    expect(head.plan).toMatchObject({ request: { params: { albumId: "a1" }, step: { mode: "head" } } });
    const handed = (head.applied!.work.cursor as { vaultWalk: Record<string, VaultAlbumWalkState> }).vaultWalk.a1!;
    expect(handed).toMatchObject({ done: false, fallbackFrom: "count_mismatch" });
    expect(handed.proof).toBeUndefined();
    expect(head.applied!.work.satisfiesRevision).toBe(false);

    // a0 moved too and sits after a1 in the rotation; the full walk of a1 goes first.
    const full = await step(head.applied!.work.cursor, "lora-1", () => page("a1", ["n2", "n1", ...known.slice(1)]));
    expect(full.plan).toMatchObject({ request: { params: { albumId: "a1", before: "0" }, step: { start: { fallbackFrom: "count_mismatch" } } } });
    expect((full.plan as { request: { step: Record<string, unknown> } }).request.step.mode).toBeUndefined();
    // The rotation goes on page by page (a0's head walk catches up); a1's
    // full walk ends on its empty page and proves the album, removals included.
    let cursorNow = full.applied!.work.cursor;
    const served: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = await step(cursorNow, "lora-1", ({ params }) => (
        params.albumId === "a0" ? page("a0", ["z3", "z2", "z1"]) : page("a1", [])
      ));
      if (next.applied === null) break;
      served.push(String((next.plan as { request: { params: Record<string, unknown> } }).request.params.albumId));
      cursorNow = next.applied.work.cursor;
    }
    expect(served).toEqual(["a0", "a1"]);
    expect(db.walkCompleted).toBe(1);
    const walks = (cursorNow as { vaultWalk: Record<string, VaultAlbumWalkState> }).vaultWalk;
    expect(walks.a1).toMatchObject({ done: true, fullWalkOnUtcDay: TODAY, completedOnUtcDay: TODAY });
    expect(walks.a0).toMatchObject({ done: true, mode: "head", basis: { count: 3 } });
  });

  it("walks in full as before on a page not in the list (the default, an empty list)", async () => {
    db.albums = [{ albumRef: "a1", itemCount: 32, lastItemRef: "n2" }];
    for (const labels of ["", "lora-2", "lora-10"]) {
      const { plan, applied } = await step(yesterday, labels, () => page("a1", ["n2", "n1", ...known]));
      expect(plan).toMatchObject({ request: { params: { before: "0" }, step: { start: { walkRef: expect.any(String) } } } });
      expect((plan as { request: { step: { start: Record<string, unknown>; mode?: string } } }).request.step.start.mode).toBeUndefined();
      expect((applied!.work.cursor as { vaultWalk: Record<string, VaultAlbumWalkState> }).vaultWalk.a1).toMatchObject({ done: false, beforeRef: `m-${known.at(-1)}` });
    }
  });

  it("still walks every album in full a week after its last full walk, moved or not", async () => {
    db.albums = [{ albumRef: "a1", itemCount: 32, lastItemRef: "n2" }];
    const headClosed: VaultAlbumWalkState = {
      ...fullyWalked(["n2", "n1", ...known], "2026-11-07"),
      mode: "head",
      basis: { count: 32, headMediaRefs: ["n2", "n1"] },
      fullWalkOnUtcDay: "2026-11-01",
    };
    const { plan } = await step({ vaultWalk: { a1: headClosed }, afterAlbumRef: "a1", last: null }, "lora-1", () => page("a1", ["n2"]));
    expect(plan).toMatchObject({ request: { params: { before: "0" }, step: { start: { walkRef: expect.any(String) } } } });
    expect((plan as { request: { step: { start: Record<string, unknown> } } }).request.step.start.mode).toBeUndefined();
  });
});

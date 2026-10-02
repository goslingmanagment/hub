import { describe, expect, it } from "vitest";

import type { MediaStatsRefreshCandidate } from "@agency_hub_core/db";

import { emptyAlbumWalk } from "../apps/runtime/src/services/sync/fansly-catalog.ts";
import { monthIndexOf } from "../apps/runtime/src/services/sync/fansly-stats.ts";
import { requestJsonOf, requestOfAttempt } from "../apps/runtime/src/sync/engine/commit.ts";
import { registryOverride, registryOverrideProblem } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { chooseVaultAlbum, servedCardIds, vaultCadence } from "../apps/runtime/src/sync/fansly/resources/catalog.ts";
import {
  estimateVisitWindows,
  MediaVisitDivergedError,
  mediaStatsOwnerTiers,
  mediaWindowOutcome,
  replayMediaVisit,
  runMediaVisit,
  startMediaVisit,
  tierEveryMs,
  type MediaStatsPageState,
  type MediaVisit,
  type MediaVisitRun,
  type MediaWindowRequest,
} from "../apps/runtime/src/sync/fansly/resources/media-stats.ts";
import { probeRequestOf } from "../apps/runtime/src/sync/fansly/resources/probe.ts";
import {
  advanceStatsBackfill,
  firstHourlyCaptureAt,
  foldStatsBackfill,
  nextHourlyCaptureAt,
  type StatsBackfillState,
} from "../apps/runtime/src/sync/fansly/resources/stats.ts";
import { allZeroBody, statsBody } from "./helpers/fansly-media-stats-fixtures.ts";

// The pure parts of the S2-09b resources (design §5.17–§5.19, §5.22): the
// media visit replayed window by window with the legacy lane's rules, the
// vault walk's album choice, the stats history walks, the hourly capture's
// spacing and the probe's request check.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = 7 * DAY;
const NO_OVERRIDES = { registryOverrides: {} };
const SUBJECT = "777000000000000001";
const UNPROVEN: MediaStatsPageState = { longTailWindowMode: "unproven", longTailWindowAnnounced: false, longTailProbeFailedDay: null };

function candidate(overrides: Partial<MediaStatsRefreshCandidate> & { ageDays: number }): MediaStatsRefreshCandidate {
  const { ageDays, ...rest } = overrides;
  return {
    subjectRef: SUBJECT,
    createdAtPlatform: new Date(NOW.getTime() - ageDays * DAY),
    firstSeenAt: new Date(NOW.getTime() - ageDays * DAY),
    publicationBasis: "platform",
    tier: ageDays <= 30 ? "fresh" : ageDays <= 90 ? "mid" : "long_tail",
    lastVisitedAt: null,
    dirtyReason: null,
    consecutiveFailures: 0,
    knownCount: null,
    backfillCursor: {},
    priorityBand: 1,
    keyset: "[]",
    ...rest,
  };
}

const DONE_CURSOR = {
  version: 1,
  nextBeforeMs: 0,
  emptyStreak: 2,
  done: true,
  floorAt: null,
  stopReason: "created_at_floor",
  floorBasis: "created_at",
  guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
};

type Answer = { body: unknown } | { fail: { httpStatus: number | null; retryAfter: boolean } };

/** Drive one visit to its end: each needed window answered by `respond`. */
function drive(visit: MediaVisit, respond: (window: MediaWindowRequest, index: number) => Answer) {
  const windows: MediaWindowRequest[] = [];
  let current = visit;
  for (;;) {
    const run: MediaVisitRun = runMediaVisit(current);
    if (run.kind !== "need") return { run, windows, visit: current };
    const answer = respond(run.window, windows.length);
    windows.push(run.window);
    const outcome = "fail" in answer
      ? { key: run.window.key, failed: answer.fail }
      : mediaWindowOutcome(run.window, { subjectRef: SUBJECT, response: answer.body, observationId: 100 + windows.length }).outcome;
    current = { ...current, outcomes: [...current.outcomes, outcome] };
  }
}

const served = (window: MediaWindowRequest, extra: Partial<Parameters<typeof statsBody>[0]> = {}): Answer => ({
  body: statsBody({ mediaOfferRef: SUBJECT, afterMs: window.afterMs, beforeMs: window.beforeMs, periodMs: window.periodMs, ...extra }),
});
const zeros = (window: MediaWindowRequest): Answer => ({
  body: allZeroBody({ mediaOfferRef: SUBJECT, afterMs: window.afterMs, beforeMs: window.beforeMs, periodMs: window.periodMs }),
});
const span = (window: MediaWindowRequest) => [(NOW.getTime() - window.afterMs) / DAY, (NOW.getTime() - window.beforeMs) / DAY];

const TIERS_OVERRIDE = [{ maxAgeDays: 14, everyMs: 12 * HOUR }, { maxAgeDays: 60, everyMs: 3 * DAY }, { maxAgeDays: null, everyMs: 14 * DAY }];
const overriding = (key: string, value: unknown) => ({ registryOverrides: { [key]: value } });

describe("media-stats: the owner's tiers (decision №6, D19)", () => {
  it("are the registry's: ≤ 30 d daily, 31–90 d weekly, older monthly", () => {
    const tiers = mediaStatsOwnerTiers(NO_OVERRIDES);
    expect(tiers).toEqual({ freshDays: 30, midDays: 90, freshEveryMs: DAY, midEveryMs: 7 * DAY, oldEveryMs: 30 * DAY });
    expect([tierEveryMs(tiers, "fresh"), tierEveryMs(tiers, "mid"), tierEveryMs(tiers, "long_tail")]).toEqual([DAY, 7 * DAY, 30 * DAY]);
  });

  it("a page's tiers override replaces them on that page, without a deploy; one that does not fit is no override", () => {
    expect(mediaStatsOwnerTiers(overriding("media-stats.walk", { tiers: TIERS_OVERRIDE }))).toEqual({
      freshDays: 14, midDays: 60, freshEveryMs: 12 * HOUR, midEveryMs: 3 * DAY, oldEveryMs: 14 * DAY,
    });
    const registry = mediaStatsOwnerTiers(NO_OVERRIDES);
    for (const tiers of [
      TIERS_OVERRIDE.slice(1),
      [TIERS_OVERRIDE[1], TIERS_OVERRIDE[0], TIERS_OVERRIDE[2]],
      [TIERS_OVERRIDE[0], TIERS_OVERRIDE[1], { maxAgeDays: 400, everyMs: DAY }],
      [TIERS_OVERRIDE[0], TIERS_OVERRIDE[1], { maxAgeDays: null, everyMs: 0 }],
    ]) {
      expect(mediaStatsOwnerTiers(overriding("media-stats.walk", { tiers }))).toEqual(registry);
    }
    // Another key's override, or a period, leaves them alone.
    expect(mediaStatsOwnerTiers(overriding("posts.engagement", { tiers: TIERS_OVERRIDE }))).toEqual(registry);
    expect(mediaStatsOwnerTiers(overriding("media-stats.walk", { everyMs: HOUR }))).toEqual(registry);
  });
});

describe("registry overrides: the shapes a page stores and which key takes which (design §4.2, owner decision №6)", () => {
  const spec = (key: string) => fanslyResourceSpec(key)!;

  it("reads back a period, the cadence periods, the tiers or a switch-off; anything else is no override", () => {
    expect(registryOverride(overriding("a.b", { everyMs: 5 }), "a.b")).toEqual({ everyMs: 5 });
    expect(registryOverride(overriding("a.b", { fullEveryMs: 7 }), "a.b")).toEqual({ fullEveryMs: 7 });
    expect(registryOverride(overriding("a.b", { everyMs: 5, fullEveryMs: 7 }), "a.b")).toEqual({ everyMs: 5, fullEveryMs: 7 });
    expect(registryOverride(overriding("a.b", { tiers: TIERS_OVERRIDE }), "a.b")).toEqual({ tiers: TIERS_OVERRIDE });
    expect(registryOverride(overriding("a.b", { enabled: false }), "a.b")).toEqual({ enabled: false });
    for (const bad of [{}, { everyMs: 0 }, { everyMs: 5, fullEveryMs: -1 }, { tiers: [] }, { tiers: [{ maxAgeDays: 3 }] }, { tiers: [{ maxAgeDays: "x", everyMs: 1 }] }, "5"]) {
      expect(registryOverride(overriding("a.b", bad), "a.b"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("takes each shape only where the module reads it back", () => {
    expect(registryOverrideProblem(spec("media-stats.walk"), { tiers: TIERS_OVERRIDE })).toBeNull();
    expect(registryOverrideProblem(spec("media-stats.walk"), { tiers: TIERS_OVERRIDE.slice(1) })).toMatch(/3 tiers expected/);
    expect(registryOverrideProblem(spec("media-stats.walk"), { everyMs: DAY })).toMatch(/not a poll/);
    expect(registryOverrideProblem(spec("catalog.vault"), { everyMs: 12 * HOUR, fullEveryMs: 3 * DAY })).toBeNull();
    expect(registryOverrideProblem(spec("catalog.vault"), { fullEveryMs: 3 * DAY })).toBeNull();
    expect(registryOverrideProblem(spec("catalog.vault"), { tiers: TIERS_OVERRIDE })).toMatch(/no age tiers/);
    expect(registryOverrideProblem(spec("catalog.fixed"), { everyMs: 12 * HOUR })).toBeNull();
    expect(registryOverrideProblem(spec("catalog.fixed"), { everyMs: 12 * HOUR, fullEveryMs: DAY })).toMatch(/full sweep/);
    // Code values, not the owner's: their modules do not read an override.
    expect(registryOverrideProblem(spec("posts.engagement"), { tiers: [{ maxAgeDays: 30, everyMs: DAY }, { maxAgeDays: 180, everyMs: DAY }, { maxAgeDays: null, everyMs: DAY }] }))
      .toMatch(/no age tiers/);
    expect(registryOverrideProblem(spec("fan-earnings.roster"), { everyMs: DAY })).toMatch(/not a poll/);
    for (const key of ["media-stats.walk", "catalog.vault", "catalog.fixed", "posts.engagement"]) {
      expect(registryOverrideProblem(spec(key), { enabled: false }), key).toBeNull();
    }
  });
});

describe("media-stats: one visit, one window a step", () => {
  it("a first visit walks back from today to the item's creation, and its opening window is the refresh", () => {
    const visit = startMediaVisit(candidate({ ageDays: 10 }), UNPROVEN, NOW);
    const { run, windows } = drive(visit, (window, index) => (index === 0 ? served(window) : zeros(window)));
    // [now − 31 d, now], then the window below it; the next would end before
    // creation − 31 d, so the walk closes there without a request.
    expect(windows.map(span)).toEqual([[31, 0], [61, 30]]);
    expect(windows.every((window) => window.mode === "backfill" && window.periodMs === DAY)).toBe(true);
    expect(run.kind).toBe("finished");
    if (run.kind !== "finished") return;
    expect(run.visited).toMatchObject({ knownCount: 3, clearDirty: true });
    expect(run.visited!.backfillCursor).toMatchObject({ done: true, floorBasis: "created_at", refreshedThroughMs: NOW.getTime() });
  });

  it("is deterministic: the same visit asks for the same windows, and a different recorded answer is refused", () => {
    const visit = startMediaVisit(candidate({ ageDays: 10 }), UNPROVEN, NOW);
    const first = runMediaVisit(visit);
    expect(runMediaVisit(visit)).toEqual(first);
    expect(first.kind).toBe("need");
    const forged: MediaVisit = { ...visit, outcomes: [{ key: "86400000:1:2", ok: { servedAfterMs: null, servedBeforeMs: null, empty: false, buckets: 1, observationId: 1 } }] };
    expect(() => runMediaVisit(forged)).toThrow(MediaVisitDivergedError);
    // What the walk sees: a visit that no longer replays (other visit rules
    // since it began) is abandoned, never thrown at the walk.
    expect(replayMediaVisit(forged)).toBeNull();
    expect(replayMediaVisit(visit)).toEqual(first);
  });

  it("begins in the form the journal stores, so the plan and the apply replay the same values", () => {
    const visit = startMediaVisit(candidate({ ageDays: 10, createdAtPlatform: new Date(Number.NaN) }), UNPROVEN, NOW);
    expect(visit).toEqual(JSON.parse(JSON.stringify(visit)));
    expect(visit.snapshot.createdAtPlatformMs).toBeNull();
    expect(runMediaVisit(JSON.parse(JSON.stringify(visit)) as MediaVisit)).toEqual(runMediaVisit(visit));
  });

  it("a visited mid item reads its 30-day refresh only; a late one reads the hole below it too", () => {
    const steady = startMediaVisit(candidate({ ageDays: 60, lastVisitedAt: new Date(NOW.getTime() - 10 * DAY), backfillCursor: DONE_CURSOR, priorityBand: 2 }), UNPROVEN, NOW);
    const onTime = drive(steady, (window) => served(window));
    expect(onTime.windows.map((window) => [...span(window), window.mode])).toEqual([[30, 0, "steady"]]);
    expect(onTime.run).toMatchObject({ kind: "finished", visited: { knownCount: 2, clearDirty: true } });

    const late = startMediaVisit(candidate({ ageDays: 80, lastVisitedAt: new Date(NOW.getTime() - 50 * DAY), backfillCursor: DONE_CURSOR, priorityBand: 2 }), UNPROVEN, NOW);
    const whole = drive(late, (window) => served(window));
    expect(whole.windows.map(span)).toEqual([[30, 0], [51, 30]]);
    expect(whole.run.kind === "finished" && whole.run.visited!.backfillCursor.refreshedThroughMs).toBe(NOW.getTime());

    // The route answers the hole with its default trailing window: the hole
    // stays open, named, and the item keeps its last refresh.
    const open = drive(late, (window, index) => (index === 1 ? served(window, { servedAfterMs: NOW.getTime() - 31 * DAY, servedBeforeMs: NOW.getTime() }) : served(window)));
    expect(open.run.kind).toBe("finished");
    if (open.run.kind !== "finished") return;
    expect(open.run.counters).toMatchObject({ "refresh_hole_open:window_not_honoured": 1 });
    expect(open.run.visited!.backfillCursor.refreshedThroughMs).toBe(NOW.getTime() - 50 * DAY);
  });

  it("a long-tail 90-day window answered narrower moves the page to three 31-day windows and reads the rest", () => {
    const visit = startMediaVisit(candidate({ ageDays: 400, lastVisitedAt: new Date(NOW.getTime() - 35 * DAY), backfillCursor: DONE_CURSOR }), UNPROVEN, NOW);
    const { run, windows } = drive(visit, (window, index) => (index === 0
      ? served(window, { servedAfterMs: NOW.getTime() - 31 * DAY, servedBeforeMs: NOW.getTime() })
      : served(window)));
    expect(windows.map(span)).toEqual([[90, 0], [62, 31], [93, 62]]);
    expect(windows[0]!.ninetyProbe).toBe(true);
    expect(run).toMatchObject({ kind: "finished", page: { longTailWindowMode: "split_31", longTailWindowAnnounced: true } });
    expect(run.counters).toMatchObject({ long_tail_window_split: 1 });

    const proven = drive(visit, (window) => served(window));
    expect(proven.windows.map(span)).toEqual([[90, 0]]);
    expect(proven.run).toMatchObject({ kind: "finished", page: { longTailWindowMode: "ninety" }, counters: { long_tail_window_proven: 1 } });
  });

  it("a 90-day window refused with an HTTP error falls back to one 31-day probe; a failed probe spends the day's", () => {
    const ninety: MediaStatsPageState = { longTailWindowMode: "ninety", longTailWindowAnnounced: true, longTailProbeFailedDay: null };
    const visit = startMediaVisit(candidate({ ageDays: 400, lastVisitedAt: new Date(NOW.getTime() - 35 * DAY), backfillCursor: DONE_CURSOR }), ninety, NOW);
    const refusal = { fail: { httpStatus: 500, retryAfter: false } };
    const fellBack = drive(visit, (window, index) => (index === 0 ? refusal : served(window)));
    expect(fellBack.windows.map(span)).toEqual([[90, 0], [31, 0], [62, 31], [93, 62]]);
    expect(fellBack.run).toMatchObject({ kind: "finished", page: { longTailWindowMode: "split_31" } });

    const probeFailed = drive(visit, (_window, index) => (index === 0 ? refusal : { fail: { httpStatus: 500, retryAfter: false } }));
    expect(probeFailed.windows).toHaveLength(2);
    expect(probeFailed.run).toMatchObject({ kind: "failed", progress: null, page: { longTailWindowMode: "ninety", longTailProbeFailedDay: "2026-10-02" } });
    // The day's probe is spent: the next refused window fails at once.
    const sameDay = startMediaVisit(candidate({ ageDays: 400, lastVisitedAt: new Date(NOW.getTime() - 35 * DAY), backfillCursor: DONE_CURSOR }), { ...ninety, longTailProbeFailedDay: "2026-10-02" }, NOW);
    expect(drive(sameDay, () => refusal).windows).toHaveLength(1);
    // A gateway status says nothing about the window: no probe.
    expect(drive(visit, () => ({ fail: { httpStatus: 503, retryAfter: false } })).windows).toHaveLength(1);
  });

  it("a dirty item whose walk resumes in the past reads its refresh first, then walks on below what it read", () => {
    const cursor = { version: 1, nextBeforeMs: NOW.getTime() - 20 * DAY, emptyStreak: 0, done: false, guard: { spanDays: 31, narrowed: false } };
    const visit = startMediaVisit(candidate({ ageDays: 80, lastVisitedAt: new Date(NOW.getTime() - 3 * DAY), dirtyReason: "purchase_notification", backfillCursor: cursor }), UNPROVEN, NOW);
    expect(visit.snapshot.dirty).toBe(true);
    const { run, windows } = drive(visit, (window) => served(window));
    expect(windows.map((window) => [...span(window), window.mode])).toEqual([
      [30, 0, "steady"],
      [60, 29, "backfill"],
      [90, 59, "backfill"],
      [120, 89, "backfill"],
    ]);
    expect(run).toMatchObject({ kind: "finished", visited: { clearDirty: true, backfillCursor: { done: true, floorBasis: "created_at" } } });
  });

  it("an unreadable answer or one about another item is a failure of this item; the accepted windows stay", () => {
    const visit = startMediaVisit(candidate({ ageDays: 10 }), UNPROVEN, NOW);
    const first = runMediaVisit(visit);
    if (first.kind !== "need") throw new Error("expected a window");
    expect(mediaWindowOutcome(first.window, { subjectRef: SUBJECT, response: { nope: true }, observationId: 1 })).toMatchObject({ refusal: "invalid_response" });
    const other = statsBody({ mediaOfferRef: "999", afterMs: first.window.afterMs, beforeMs: first.window.beforeMs, periodMs: DAY });
    expect(mediaWindowOutcome(first.window, { subjectRef: SUBJECT, response: other, observationId: 1 })).toMatchObject({ refusal: "subject_mismatch" });
    const { run } = drive(visit, (window, index) => (index === 0 ? served(window) : { body: { nope: true } }));
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    // The first window was accepted: the cursor moved below it, and it stays.
    expect(run.progress).toMatchObject({ nextBeforeMs: NOW.getTime() - 30 * DAY, done: false });
  });

  it("estimates a visit's windows for the shadow walk", () => {
    expect(estimateVisitWindows(candidate({ ageDays: 10 }), "unproven", NOW)).toBe(2);
    expect(estimateVisitWindows(candidate({ ageDays: 60 }), "unproven", NOW)).toBe(4);
    expect(estimateVisitWindows(candidate({ ageDays: 60, lastVisitedAt: new Date(NOW.getTime() - 8 * DAY), backfillCursor: DONE_CURSOR }), "unproven", NOW)).toBe(1);
    expect(estimateVisitWindows(candidate({ ageDays: 400, lastVisitedAt: new Date(NOW.getTime() - 35 * DAY), backfillCursor: DONE_CURSOR }), "split_31", NOW)).toBe(3);
    expect(estimateVisitWindows(candidate({ ageDays: 80, lastVisitedAt: new Date(NOW.getTime() - 50 * DAY), backfillCursor: DONE_CURSOR }), "unproven", NOW)).toBe(2);
  });
});

describe("the step a request carries is stored with the attempt and handed back", () => {
  it("round-trips through sync_attempts.request", () => {
    const step = { visit: { snapshot: { subjectRef: SUBJECT }, outcomes: [] } };
    const json = requestJsonOf({ spec: "polls", params: {}, step });
    expect(json.step).toEqual(step);
    expect(requestOfAttempt({ request: json, operation: "polls" })).toEqual({ spec: "polls", params: {}, step });
    expect("step" in requestJsonOf({ spec: "polls", params: {} })).toBe(false);
    expect("step" in requestOfAttempt({ request: { spec: "polls", params: {} }, operation: "polls" })).toBe(false);
  });
});

describe("catalog: the vault walk's album choice (legacy rotation)", () => {
  const album = (albumRef: string, itemCount = 3, lastItemRef: string | null = `${albumRef}-head`) => ({ albumRef, itemCount, lastItemRef });
  const walked = (albumRef: string, day: string, itemCount = 3) => ({
    ...emptyAlbumWalk(),
    done: true,
    completedAtLastItemRef: `${albumRef}-head`,
    completedOnUtcDay: day,
    lastCompleteWalkAt: `${day}T01:00:00.000Z`,
    proof: { walkRef: "w", startedAt: `${day}T00:00:00.000Z`, expectedCount: itemCount, headRef: `${albumRef}-head`, seenMediaRefs: [], observationRefs: [1], valid: true },
  });

  it("serves never-completed albums first, round robin after the last served", () => {
    const albums = [album("a1"), album("a2"), album("a3")];
    const choice = chooseVaultAlbum(albums, { vaultWalk: { a1: walked("a1", "2026-10-01") }, afterAlbumRef: "a2" }, "2026-10-02", WEEK);
    expect(choice).toMatchObject({ album: { albumRef: "a3" }, start: true, parked: [] });
    expect(choice!.walk.beforeRef).toBe("0");
    expect(chooseVaultAlbum(albums, { vaultWalk: { a1: walked("a1", "2026-10-01"), a3: walked("a3", "2026-10-01") }, afterAlbumRef: "a3" }, "2026-10-02", WEEK))
      .toMatchObject({ album: { albumRef: "a2" } });
  });

  it("re-walks an album as soon as the page's full-sweep override says (owner decision №6)", () => {
    const fresh = { a1: walked("a1", "2026-09-29") };
    expect(vaultCadence(NO_OVERRIDES)).toEqual({ everyMs: DAY, fullEveryMs: WEEK });
    const cadence = vaultCadence(overriding("catalog.vault", { fullEveryMs: 3 * DAY }));
    expect(cadence).toEqual({ everyMs: DAY, fullEveryMs: 3 * DAY });
    expect(chooseVaultAlbum([album("a1")], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-02", WEEK)).toBeNull();
    expect(chooseVaultAlbum([album("a1")], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-02", cadence.fullEveryMs)).toMatchObject({ start: true });
    expect(vaultCadence(overriding("catalog.vault", { everyMs: 12 * HOUR, fullEveryMs: 14 * DAY }))).toEqual({ everyMs: 12 * HOUR, fullEveryMs: 14 * DAY });
  });

  it("re-walks an album whose head or count moved, or whose walk is a week old; rests when every album is walked", () => {
    const fresh = { a1: walked("a1", "2026-10-01") };
    expect(chooseVaultAlbum([album("a1")], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-02", WEEK)).toBeNull();
    const moved = chooseVaultAlbum([album("a1", 3, "a1-newer")], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-02", WEEK);
    expect(moved).toMatchObject({ start: true, walk: { done: false, lastCompleteWalkAt: "2026-10-01T01:00:00.000Z" } });
    expect(chooseVaultAlbum([album("a1", 4)], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-02", WEEK)).not.toBeNull();
    expect(chooseVaultAlbum([album("a1")], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-08", WEEK)).not.toBeNull();
    expect(chooseVaultAlbum([album("a1")], { vaultWalk: fresh, afterAlbumRef: null }, "2026-10-07", WEEK)).toBeNull();
  });

  it("continues a walk under way at its cursor, and parks an imported one at a repeated cursor or the page cap", () => {
    const midway = { ...emptyAlbumWalk(), beforeRef: "m50", lastRequestedBefore: "0", sawRows: true, pages: 1, proof: walked("a1", "2026-10-01").proof };
    expect(chooseVaultAlbum([album("a1")], { vaultWalk: { a1: midway }, afterAlbumRef: null }, "2026-10-02", WEEK))
      .toMatchObject({ start: false, walk: { beforeRef: "m50" } });
    const stuck = { ...midway, lastRequestedBefore: "m50" };
    const capped = { ...midway, beforeRef: "m99", pages: 400 };
    const choice = chooseVaultAlbum([album("a1"), album("a2"), album("a3")], { vaultWalk: { a1: stuck, a2: capped }, afterAlbumRef: null }, "2026-10-02", WEEK);
    expect(choice).toMatchObject({ album: { albumRef: "a3" }, parked: [{ album: { albumRef: "a1" }, reason: "repeat_request" }, { album: { albumRef: "a2" }, reason: "page_cap" }] });
  });

  it("names the cards a batch answer served", () => {
    expect([...servedCardIds([{ id: "1" }, { id: "2" }, { nope: 1 }])]).toEqual(["1", "2"]);
    expect([...servedCardIds({ accountMedia: [{ id: "3" }] })]).toEqual(["3"]);
    expect(servedCardIds(null).size).toBe(0);
  });
});

describe("stats: the history walks, one request a step", () => {
  const created = new Date("2026-07-15T00:00:00.000Z");
  const fresh = (): StatsBackfillState => ({
    daily: {
      nextBeforeMs: NOW.getTime(), trailingCaptured: false, nextMonthIndex: null, lastMonthIndex: null, emptyStreak: 0,
      probeSpent: false, probeResumeMonthIndex: null, probeHitMonthIndex: null, done: false, floorAt: null,
      guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
    },
    hourlyDone: false,
    earnings: {
      nextBeforeMs: NOW.getTime(), walk: null, emptyStreak: 0, probeSpent: false, probeResumeBeforeMs: null,
      probeHitAfterMs: null, probeHitBeforeMs: null, done: false,
      guard: { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null },
    },
  });
  const monthBody = (afterMs: number, beforeMs: number, views: number) => ({
    dataset: { dateAfter: afterMs, dateBefore: beforeMs, datapoints: [{ timestamp: afterMs, stats: [{ type: 0, views }] }], profileDatapoints: [] },
  });

  it("reads the trailing window, then calendar months down to the account's creation, then the earnings windows", () => {
    let state = fresh();
    const lanes: string[] = [];
    let claims: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      const advanced = advanceStatsBackfill({ state, now: NOW, accountCreatedAt: created });
      claims = [...claims, ...advanced.claims.map((claim) => `${claim.plane}:${claim.reasonCode ?? claim.status}`)];
      if (advanced.next === null) break;
      const lane = advanced.next.lane;
      lanes.push(lane.lane === "daily_month" ? `month:${lane.monthIndex}` : lane.lane);
      if (lane.lane === "earnings") break;
      const p = advanced.next.request.params as { afterMs: number; beforeMs: number };
      const folded = foldStatsBackfill({
        state: advanced.state,
        lane,
        request: advanced.next.request,
        response: lane.lane === "daily_trailing" ? monthBody(p.afterMs, p.beforeMs, 5) : monthBody(Date.UTC(2026, (lane.monthIndex % 12), 1), Date.UTC(2026, (lane.monthIndex % 12) + 1, 1), 5),
        observationId: step + 1,
        now: NOW,
        accountCreatedAt: created,
      });
      state = folded.state;
      claims = [...claims, ...folded.claims.map((claim) => `${claim.plane}:${claim.reasonCode ?? claim.status}`)];
    }
    const thisMonth = monthIndexOf(NOW);
    expect(lanes).toEqual(["daily_trailing", `month:${thisMonth - 1}`, `month:${thisMonth - 2}`, `month:${thisMonth - 3}`, "earnings"]);
    expect(claims).toEqual([
      "stats_account_daily:in_progress",
      "stats_account_daily:in_progress",
      "stats_account_daily:in_progress",
      "stats_account_daily:in_progress",
      // June predates the July creation: the floor is claimed without a request.
      "stats_account_daily:account_creation_floor",
      "stats_account_hourly:hourly_trailing_window_only",
    ]);
  });

  it("without a creation date two empty months buy one probe a year back; an empty probe month ends on the streak", () => {
    let state: StatsBackfillState = { ...fresh(), daily: { ...fresh().daily, trailingCaptured: true, nextMonthIndex: monthIndexOf(NOW) - 1 } };
    const months: number[] = [];
    let ended: string | null = null;
    for (let step = 0; step < 6; step += 1) {
      const advanced = advanceStatsBackfill({ state, now: NOW, accountCreatedAt: null });
      if (advanced.next === null || advanced.next.lane.lane !== "daily_month") break;
      const lane = advanced.next.lane;
      months.push(lane.monthIndex);
      const folded = foldStatsBackfill({ state: advanced.state, lane, request: advanced.next.request, response: { dataset: null, aggregationData: null }, observationId: 1, now: NOW, accountCreatedAt: null });
      state = folded.state;
      ended = folded.claims.find((claim) => claim.reasonCode === "empty_window_streak")?.reasonCode ?? ended;
    }
    const last = monthIndexOf(NOW) - 1;
    expect(months).toEqual([last, last - 1, last - 1 - 12]);
    expect(ended).toBe("empty_window_streak");
    expect(state.daily).toMatchObject({ done: true, probeSpent: true });
  });

  it("a month answered with the default trailing window stops the walk; the trailing window refused halves once", () => {
    const state = { ...fresh(), daily: { ...fresh().daily, trailingCaptured: true, nextMonthIndex: monthIndexOf(NOW) - 3 } };
    const advanced = advanceStatsBackfill({ state, now: NOW, accountCreatedAt: null });
    const lane = advanced.next!.lane;
    const folded = foldStatsBackfill({
      state: advanced.state, lane, request: advanced.next!.request,
      response: monthBody(NOW.getTime() - 31 * DAY, NOW.getTime(), 4), observationId: 9, now: NOW, accountCreatedAt: null,
    });
    expect(folded.state.daily.done).toBe(true);
    expect(folded.claims[0]).toMatchObject({ reasonCode: "month_form_not_honoured", proofObservationId: 9 });

    const trailing = advanceStatsBackfill({ state: fresh(), now: NOW, accountCreatedAt: null });
    const refused = foldStatsBackfill({
      state: trailing.state, lane: trailing.next!.lane, request: trailing.next!.request,
      response: monthBody(NOW.getTime() + 2 * DAY, NOW.getTime() + 3 * DAY, 4), observationId: 3, now: NOW, accountCreatedAt: null,
    });
    expect(refused.state.daily).toMatchObject({ done: false, trailingCaptured: false, guard: { spanDays: 15, narrowed: true } });
  });
});

describe("stats: the hourly capture's spacing", () => {
  it("is the 22 h period ±10 %, never past the 23 h two windows need to meet", () => {
    expect(nextHourlyCaptureAt(NOW, 0, NO_OVERRIDES).getTime() - NOW.getTime()).toBe(Math.round(22 * HOUR * 0.9));
    expect(nextHourlyCaptureAt(NOW, 0.5, NO_OVERRIDES).getTime() - NOW.getTime()).toBe(22 * HOUR);
    expect(nextHourlyCaptureAt(NOW, 1, NO_OVERRIDES).getTime() - NOW.getTime()).toBe(23 * HOUR);
  });

  it("takes the page's period override, still never past 23 h", () => {
    expect(nextHourlyCaptureAt(NOW, 0.5, overriding("stats.hourly", { everyMs: 12 * HOUR })).getTime() - NOW.getTime()).toBe(12 * HOUR);
    expect(nextHourlyCaptureAt(NOW, 0.5, overriding("stats.hourly", { everyMs: 30 * HOUR })).getTime() - NOW.getTime()).toBe(23 * HOUR);
  });

  it("the first capture after the switch is due by legacy's last one (A15), never by the poll row's random phase", () => {
    const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
    expect(firstHourlyCaptureAt(ago(2), NOW).getTime()).toBe(NOW.getTime() + 20 * HOUR);
    // Already past the period (or never captured, or unreadable): at once.
    expect(firstHourlyCaptureAt(ago(23), NOW)).toEqual(NOW);
    expect(firstHourlyCaptureAt(null, NOW)).toEqual(NOW);
    expect(firstHourlyCaptureAt("not a date", NOW)).toEqual(NOW);
    // A last capture stamped ahead of this clock: never more than 23 h out.
    expect(firstHourlyCaptureAt(ago(-5), NOW).getTime()).toBe(NOW.getTime() + 23 * HOUR);
  });
});

describe("probe: the owner's request is checked before anything is written", () => {
  it("takes a wire route and its parameters, refusing an unknown route or a parameter no request may carry", () => {
    expect(probeRequestOf({ operation: "account.me", params: {} })).toEqual({ request: { spec: "account.me", params: {} } });
    expect(probeRequestOf({ operation: "media.offer_stats", params: { mediaOfferId: "1", beforeMs: 2, afterMs: 1, periodMs: DAY } }))
      .toMatchObject({ request: { spec: "media.offer_stats" } });
    expect(probeRequestOf({ operation: "account.nope", params: {} })).toEqual({ refused: "probe_operation_unknown" });
    expect(probeRequestOf({ operation: "media.offer_stats", params: { mediaOfferId: "1", beforeMs: -1, afterMs: 1, periodMs: DAY } }))
      .toEqual({ refused: "probe_params_invalid" });
    expect(probeRequestOf({ operation: "account.me", params: [] })).toEqual({ refused: "probe_params_not_an_object" });
  });
});

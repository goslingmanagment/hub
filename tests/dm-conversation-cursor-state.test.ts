// G3 (checkpoint cutover): the dm_conversations cursor codec across the
// version boundary, and the rollback simulation that says what production
// would do with a v2 state if the pre-G3 binary came back.

import { describe, expect, it } from "vitest";

import {
  emptyDmMessagesCursorState,
  isUnresumableLegacyDmConversationCursorState,
  parseDmConversationCursorState,
  parseDmConversationSweepState,
  parseDmMessagesCursorState,
  serializeDmConversationSweepState,
} from "../apps/runtime/src/services/sync/cursor-state.ts";

const V2_STATE = {
  version: 2,
  mode: "full_scan",
  generation: 7,
  offset: 200,
  observedCount: 200,
  pageCount: 2,
  providerTotalMode: "present",
  providerReportedTotal: 512,
  unchangedPageStreak: 1,
  fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
  lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
} as const;

function v1State(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: "full_scan",
    generation: 7,
    offset: 200,
    pageCount: 2,
    providerTotalMode: "present",
    providerReportedTotal: 512,
    unchangedPageStreak: 1,
    fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
    lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("dm_conversations cursor state (G3)", () => {
  it("round-trips a v2 state unchanged", () => {
    expect(parseDmConversationCursorState({ ...V2_STATE })).toEqual({ ...V2_STATE });
  });

  it("refuses a v2 state with no observed count", () => {
    const { observedCount: _observedCount, ...withoutCount } = V2_STATE;
    expect(parseDmConversationCursorState(withoutCount)).toBeNull();
    // …and it is NOT the legacy case: nothing loudly restarts a shape that
    // never shipped.
    expect(isUnresumableLegacyDmConversationCursorState(withoutCount)).toBe(false);
  });

  it("refuses a version it does not know", () => {
    expect(parseDmConversationCursorState({ ...V2_STATE, version: 3 })).toBeNull();
    expect(parseDmConversationCursorState({ ...V2_STATE, version: 0 })).toBeNull();
  });

  it("refuses a completed sweep state as a resumable cursor", () => {
    // The completed state carries no `mode` on purpose: refusing it here is
    // what makes the next chunk open a FRESH sweep under a higher generation.
    expect(parseDmConversationCursorState({
      version: 2,
      generation: 7,
      observedCount: 200,
      destructiveFinalization: true,
      lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
    })).toBeNull();
  });

  it("migrates a v1 state by adopting its id array's length as the observed count", () => {
    const migrated = parseDmConversationCursorState(v1State({
      snapshotConversationIds: Array.from({ length: 200 }, (_, index) => `group-${index}`),
    }));

    expect(migrated).toEqual({ ...V2_STATE });
    expect(migrated).not.toHaveProperty("snapshotConversationIds");
  });

  it("prefers the v1 array's length over a stored observedCount", () => {
    // They agree in every state the pre-G3 writer produced; if they ever did
    // not, the array is what that sweep actually decided with.
    const migrated = parseDmConversationCursorState(v1State({
      observedCount: 3,
      snapshotConversationIds: ["group-a", "group-b"],
    }));

    expect(migrated?.observedCount).toBe(2);
  });

  it("migrates a v1 state that has only the scalar count", () => {
    const migrated = parseDmConversationCursorState(v1State({ observedCount: 200 }));

    expect(migrated).toEqual({ ...V2_STATE });
    expect(isUnresumableLegacyDmConversationCursorState(v1State({ observedCount: 200 }))).toBe(false);
  });

  it("flags a v1 state with neither count representation as an unresumable legacy sweep", () => {
    const legacy = v1State();

    // It still parses — with a zero it has no right to — which is exactly why
    // the handler asks the question separately and restarts the sweep loudly.
    expect(parseDmConversationCursorState(legacy)?.observedCount).toBe(0);
    expect(isUnresumableLegacyDmConversationCursorState(legacy)).toBe(true);
  });

  it("does not flag a malformed v1 array as the legacy case", () => {
    // A corrupt array was a silent fresh sweep before G3 and still is: the
    // parser refuses it and the handler starts over without an anomaly.
    const corrupt = v1State({ snapshotConversationIds: ["group-a", 7] });

    expect(parseDmConversationCursorState(corrupt)).toBeNull();
    expect(isUnresumableLegacyDmConversationCursorState(corrupt)).toBe(false);
  });

  it("refuses a negative observed count", () => {
    expect(parseDmConversationCursorState({ ...V2_STATE, observedCount: -1 })).toBeNull();
  });
});

/**
 * The in-memory tagged union over the SAME two documents. The tag exists only
 * in memory: every assertion below that touches JSON is a `toEqual` against the
 * exact document the pre-union code wrote, because a rolled-back binary reads
 * that document with the parser copied further down this file.
 */
const COMPLETED_STATE = {
  version: 2,
  generation: 7,
  observedCount: 200,
  generationSetCount: 200,
  providerTotalMode: "present",
  providerReportedTotal: 512,
  destructiveFinalization: true,
  membershipCertified: true,
  lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
} as const;

describe("dm_conversations sweep state (tagged union)", () => {
  it("parses the in-progress document into the in_progress arm", () => {
    expect(parseDmConversationSweepState({ ...V2_STATE })).toEqual({
      kind: "in_progress",
      generation: 7,
      offset: 200,
      observedCount: 200,
      pageCount: 2,
      providerTotalMode: "present",
      providerReportedTotal: 512,
      unchangedPageStreak: 1,
      fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
      lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
    });
  });

  it("parses the completed document into the completed arm", () => {
    expect(parseDmConversationSweepState({ ...COMPLETED_STATE })).toEqual({
      kind: "completed",
      generation: 7,
      observedCount: 200,
      generationSetCount: 200,
      providerTotalMode: "present",
      providerReportedTotal: 512,
      destructiveFinalization: true,
      membershipCertified: true,
      erasureDelta: null,
      lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
    });
  });

  it("round-trips the in-progress document byte for byte", () => {
    const parsed = parseDmConversationSweepState({ ...V2_STATE });

    expect(parsed?.kind).toBe("in_progress");
    expect(serializeDmConversationSweepState(parsed!)).toEqual({ ...V2_STATE });
  });

  it("round-trips the completed document byte for byte", () => {
    const parsed = parseDmConversationSweepState({ ...COMPLETED_STATE });

    expect(parsed?.kind).toBe("completed");
    // No `erasureDelta` key: a null delta is ABSENT, not null, exactly as the
    // conditional spread in the pre-union literal produced.
    expect(serializeDmConversationSweepState(parsed!)).toEqual({ ...COMPLETED_STATE });
    expect(serializeDmConversationSweepState(parsed!)).not.toHaveProperty("erasureDelta");
  });

  it("round-trips a completed document that carries an erasure delta", () => {
    const withDelta = { ...COMPLETED_STATE, generationSetCount: 198, erasureDelta: 2 };
    const parsed = parseDmConversationSweepState(withDelta);

    expect(parsed).toMatchObject({ kind: "completed", erasureDelta: 2 });
    expect(serializeDmConversationSweepState(parsed!)).toEqual(withDelta);
  });

  it("serializes the mid-sweep telemetry rider and drops it again on parse", () => {
    const parsed = parseDmConversationSweepState({ ...V2_STATE });
    const document = serializeDmConversationSweepState(parsed!, { generationSetCount: 200 });

    expect(document).toEqual({ ...V2_STATE, generationSetCount: 200 });
    // `generationSetCount` is telemetry, not cursor state: a resume recomputes
    // it per page, so it must not survive the round trip.
    expect(serializeDmConversationSweepState(parseDmConversationSweepState(document)!))
      .toEqual({ ...V2_STATE });
  });

  it("never puts the in-memory tag in the persisted document", () => {
    for (const source of [{ ...V2_STATE }, { ...COMPLETED_STATE }]) {
      expect(serializeDmConversationSweepState(parseDmConversationSweepState(source)!))
        .not.toHaveProperty("kind");
    }
  });

  it("keeps the completed document free of the resumable cursor keys", () => {
    const document = serializeDmConversationSweepState(
      parseDmConversationSweepState({ ...COMPLETED_STATE })!,
    );

    // Their ABSENCE is the mechanism: the resumable parser refuses a document
    // with no `mode`, so the next chunk opens a fresh sweep.
    for (const key of ["mode", "offset", "pageCount", "fullSweepStartedAt", "unchangedPageStreak"]) {
      expect(document, key).not.toHaveProperty(key);
    }
    expect(parseDmConversationCursorState(document)).toBeNull();
  });

  it("keeps unchangedPageStreak in the persisted in-progress document", () => {
    // Nothing reads it back yet; it stays because dropping a key from a live
    // checkpoint is not a refactor, it is a migration.
    expect(serializeDmConversationSweepState(parseDmConversationSweepState({
      ...V2_STATE,
      unchangedPageStreak: 4,
    })!)).toMatchObject({ unchangedPageStreak: 4 });
  });

  it("migrates a v1 in-progress document into the in_progress arm", () => {
    const parsed = parseDmConversationSweepState(v1State({
      snapshotConversationIds: Array.from({ length: 200 }, (_, index) => `group-${index}`),
    }));

    expect(parsed).toMatchObject({ kind: "in_progress", observedCount: 200 });
    expect(serializeDmConversationSweepState(parsed!)).toEqual({ ...V2_STATE });
  });

  it.each([
    { name: "an unknown mode", value: { ...V2_STATE, mode: "incremental" } },
    { name: "an OFAPI cursor", value: { version: 1, mode: "ofapi", offset: 0, pageCount: 0 } },
    { name: "a mode on an otherwise completed document", value: { ...COMPLETED_STATE, mode: "done" } },
    { name: "an unknown version", value: { ...COMPLETED_STATE, version: 3 } },
    { name: "a completed document with no membership count", value: {
      version: 2,
      generation: 7,
      observedCount: 200,
      providerTotalMode: "present",
      providerReportedTotal: 512,
      destructiveFinalization: true,
      membershipCertified: true,
      lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
    } },
    { name: "a completed document with a non-boolean verdict", value: {
      ...COMPLETED_STATE,
      membershipCertified: "yes",
    } },
    { name: "a completed document with a garbage erasure delta", value: {
      ...COMPLETED_STATE,
      erasureDelta: "two",
    } },
    { name: "a completed document with an unknown total mode", value: {
      ...COMPLETED_STATE,
      providerTotalMode: "guessed",
    } },
    { name: "not an object at all", value: "full_scan" },
    { name: "null", value: null },
  ])("refuses $name", ({ value }) => {
    expect(parseDmConversationSweepState(value)).toBeNull();
  });
});

/**
 * ROLLBACK SIMULATION.
 *
 * `legacyParseDmConversationCursorState` below is a VERBATIM copy of
 * parseDmConversationCursorState (and the helpers it closes over) as it exists
 * on main @ 61f7c1dd — the binary production would roll back to if G3 were
 * reverted. The point of the copy is that it cannot drift with the file under
 * test: it pins what the OLD code does with the NEW state.
 */
function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asNumber(value);
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function asOptionalStringArray(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : null;
}

function legacyParseDmConversationCursorState(value: unknown) {
  const state = asRecord(value);
  if (!state || asNumber(state.version) !== 1 || state.mode !== "full_scan") {
    return null;
  }

  const generation = asNumber(state.generation);
  const offset = asNumber(state.offset);
  const pageCount = asNumber(state.pageCount);
  const providerReportedTotal = asNullableNumber(state.providerReportedTotal);
  const unchangedPageStreak = asNumber(state.unchangedPageStreak);
  const fullSweepStartedAt = asNullableString(state.fullSweepStartedAt);
  const lastFullSweepCompletedAt = asNullableString(state.lastFullSweepCompletedAt);
  const snapshotConversationIds = asOptionalStringArray(state.snapshotConversationIds);
  if (
    generation === null ||
    offset === null ||
    pageCount === null ||
    providerReportedTotal === undefined ||
    unchangedPageStreak === null ||
    !fullSweepStartedAt ||
    snapshotConversationIds === null
  ) {
    return null;
  }

  const providerTotalMode = state.providerTotalMode === "unobserved" ||
      state.providerTotalMode === "absent" || state.providerTotalMode === "present"
    ? state.providerTotalMode
    : providerReportedTotal !== null
      ? "present"
      : pageCount > 0
        ? "absent"
        : "unobserved";
  if (
    (providerTotalMode === "present" && providerReportedTotal === null) ||
    (providerTotalMode !== "present" && providerReportedTotal !== null) ||
    (providerTotalMode === "unobserved" && pageCount !== 0)
  ) {
    return null;
  }

  return {
    version: 1,
    mode: "full_scan",
    generation,
    offset,
    pageCount,
    providerTotalMode,
    providerReportedTotal,
    unchangedPageStreak,
    fullSweepStartedAt,
    lastFullSweepCompletedAt,
    ...(snapshotConversationIds ? { snapshotConversationIds } : {}),
  };
}

describe("dm_conversations cursor state — rollback to the pre-G3 parser", () => {
  it("is faithful to main: it still accepts the v1 shape", () => {
    // Guards the copy itself. If this fails, the fixture stopped modelling the
    // old binary and the assertions below prove nothing.
    expect(legacyParseDmConversationCursorState(v1State({
      snapshotConversationIds: ["group-a"],
    }))).toMatchObject({ version: 1, generation: 7, snapshotConversationIds: ["group-a"] });
  });

  it("refuses a v2 in-progress state, which sends the old binary down the fresh-sweep path", () => {
    // Not "resumes it wrong" and not "crashes": the old parser's version check
    // is exact, so a v2 state reads as no cursor at all. The pre-G3 handler
    // then rebuilds a state from the raw record — generation =
    // max(stored generation, row-side high-water) + 1, offset 0 — and re-walks
    // the sweep. Progress is lost; correctness is not, because the new
    // generation is above every stamp its finalization compares against.
    expect(legacyParseDmConversationCursorState({ ...V2_STATE })).toBeNull();
  });

  it("leaves the fields the old fresh-sweep path reads off the raw record intact", () => {
    // Those two reads are `asNumber(record.generation)` and
    // `asNullableString(record.lastFullSweepCompletedAt)` — v2 keeps both, so
    // the rolled-back sweep neither restarts its generation at 1 nor loses the
    // coverage timestamp.
    expect(asNumber(V2_STATE.generation)).toBe(7);
    expect(asNullableString(V2_STATE.lastFullSweepCompletedAt)).toBe("2026-03-09T00:00:00.000Z");
  });

  it("refuses a v2 completed state too, which is the same fresh sweep", () => {
    expect(legacyParseDmConversationCursorState({
      version: 2,
      generation: 7,
      observedCount: 200,
      lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
    })).toBeNull();
  });

  it("reads the union's OWN output exactly as it reads the pre-union documents", () => {
    // The point of the union is that it changed nothing on disk. Both
    // documents below came out of serializeDmConversationSweepState; the old
    // parser must still refuse them (fresh sweep) and must still find the two
    // fields the pre-G3 fresh-sweep path reads off the raw record.
    const inProgress = serializeDmConversationSweepState(
      parseDmConversationSweepState({ ...V2_STATE })!,
    );
    const completed = serializeDmConversationSweepState(
      parseDmConversationSweepState({
        version: 2,
        generation: 7,
        observedCount: 200,
        generationSetCount: 200,
        providerTotalMode: "present",
        providerReportedTotal: 512,
        destructiveFinalization: true,
        membershipCertified: true,
        lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
      })!,
    );

    for (const document of [inProgress, completed]) {
      expect(legacyParseDmConversationCursorState(document)).toBeNull();
      expect(asNumber(document.generation)).toBe(7);
      expect(typeof asNullableString(document.lastFullSweepCompletedAt)).toBe("string");
    }
  });
});

/**
 * Membership-rule parity: the row-side generation set reproduces the verdicts
 * the cumulative array used to produce. Both models below consume the SAME
 * page sequences; only their memory of "already seen" differs.
 */
type SweepPage = { ids: string[]; erasedBefore?: string[] };

function arrayModelVerdicts(pages: SweepPage[]) {
  const snapshot: string[] = [];
  return pages.map((page) => {
    const unique = new Set(page.ids);
    const overlap = [...unique].filter((id) => snapshot.includes(id));
    const duplicateIdsWithinPage = page.ids.length - unique.size;
    if (overlap.length > 0 || duplicateIdsWithinPage > 0) {
      return "restart" as const;
    }
    snapshot.push(...unique);
    return "applied" as const;
  });
}

function generationSetModelVerdicts(pages: SweepPage[]) {
  // The rows carrying this sweep's generation, i.e. what
  // listPageDmThreadIdsStampedWithGeneration reads inside the page
  // transaction. An erasure deletes rows out of it mid-sweep.
  const stamped = new Set<string>();
  return pages.map((page) => {
    for (const erased of page.erasedBefore ?? []) {
      stamped.delete(erased);
    }
    const unique = new Set(page.ids);
    const overlap = [...unique].filter((id) => stamped.has(id));
    const duplicateIdsWithinPage = page.ids.length - unique.size;
    if (overlap.length > 0 || duplicateIdsWithinPage > 0) {
      return "restart" as const;
    }
    for (const id of unique) {
      stamped.add(id);
    }
    return "applied" as const;
  });
}

describe("dm_conversations overlap verdict parity (array vs generation set)", () => {
  it.each([
    { name: "disjoint pages", pages: [{ ids: ["a", "b"] }, { ids: ["c"] }, { ids: ["d", "e"] }] },
    { name: "an id repeating on a later page", pages: [{ ids: ["a", "b"] }, { ids: ["b", "c"] }] },
    { name: "an id repeated inside one page", pages: [{ ids: ["a", "a"] }] },
    { name: "a repeat on the very first page after a resume", pages: [{ ids: ["a"] }, { ids: ["a"] }] },
    { name: "an empty terminal page", pages: [{ ids: ["a"] }, { ids: [] }] },
    { name: "a repeat several pages later", pages: [{ ids: ["a"] }, { ids: ["b"] }, { ids: ["c"] }, { ids: ["a"] }] },
  ])("agrees on $name", ({ pages }) => {
    expect(generationSetModelVerdicts(pages)).toEqual(arrayModelVerdicts(pages));
  });

  it("documents the one divergence: an erasure un-stamps a row mid-sweep", () => {
    // The array remembers an id whose row an erasure deleted, so it calls a
    // re-appearance an overlap and restarts the sweep. The generation set
    // cannot see a deleted row, so it applies the page and double-counts the
    // id — which the completion check then reads as a shortfall and hands to
    // the erasure tolerance. Fail-safe in both directions: no thread is hidden
    // on an uncertified count.
    const pages: SweepPage[] = [{ ids: ["a", "b"] }, { ids: ["a"], erasedBefore: ["a"] }];

    expect(arrayModelVerdicts(pages)).toEqual(["applied", "restart"]);
    expect(generationSetModelVerdicts(pages)).toEqual(["applied", "applied"]);
  });
});

describe("dm_messages cursor state: normalization debt", () => {
  const walking = {
    version: 1,
    currentConversationId: 777,
    currentPlatformConversationId: "group-1",
    currentBeforeMessageId: "m-2",
    currentMode: "backfill",
  } as const;

  it("round-trips the debt flag, so a multi-chunk walk remembers a skipped message", () => {
    const state = { ...walking, normalizationDebt: true };
    expect(parseDmMessagesCursorState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("keeps only an explicit true, and an older checkpoint parses without it", () => {
    for (const normalizationDebt of [false, "true", 1, null]) {
      expect(parseDmMessagesCursorState({ ...walking, normalizationDebt })).toEqual(walking);
    }
    expect(parseDmMessagesCursorState({ ...walking })).toEqual(walking);
  });

  it("is cleared by the empty state every completion and reset writes", () => {
    expect(emptyDmMessagesCursorState()).not.toHaveProperty("normalizationDebt");
  });
});

describe("dm_messages cursor head-read time", () => {
  const walking = {
    version: 1,
    currentConversationId: 777,
    currentPlatformConversationId: "group-1",
    currentBeforeMessageId: "m-2",
    currentMode: "incremental",
  } as const;

  it("round-trips the head-read time, so a multi-chunk walk certifies its head only as of that read", () => {
    const state = { ...walking, headReadAt: "2026-09-22T00:11:00.000Z" };
    expect(parseDmMessagesCursorState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("drops a missing or unparseable time, which preserves last_message_sync_at instead of stamping now", () => {
    for (const headReadAt of ["not-a-date", "", 1_770_000_000_000, null, true]) {
      expect(parseDmMessagesCursorState({ ...walking, headReadAt })).toEqual(walking);
    }
    expect(parseDmMessagesCursorState({ ...walking })).toEqual(walking);
  });

  it("is cleared by the empty state every completion and reset writes", () => {
    expect(emptyDmMessagesCursorState()).not.toHaveProperty("headReadAt");
  });
});

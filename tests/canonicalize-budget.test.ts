// The sweep's wall-clock budget and family rotation (defect 2026-08-22).
//
// The minutely `canonicalize.sweep` job walked EVERY family to exhaustion and
// then ran three OFAPI/DM reconciles in the same handler. Since WP-F0 (~30
// drafts per dm_messages observation) and the five WP-F1..F6 projection-only
// families a run stopped fitting in pg-boss's 900s handler expiration: the job
// was killed, restarted at once and killed again, the families at the END of
// the registry sat at parse_version 0 for a quarter of an hour, and the
// reconciles after the sweep never ran at all.
//
// These are the pins for the driver half of the fix. The clock is faked and the
// db is mocked, so they assert the CONTROL FLOW — where the budget may and may
// not cut, and which family the next run starts at — rather than any timing.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { listObservationsForReplay } from "@agency_hub_core/db";

const dbMocks = vi.hoisted(() => ({
  getCanonicalizeSweepCursor: vi.fn(),
  advanceCanonicalizeSweepCursor: vi.fn(),
  listPageNativeAccountRefs: vi.fn(async () => [] as unknown[]),
  listHistoricalOfapiBindings: vi.fn(async () => []),
  listObservationsForReplay: vi.fn(),
  markObservationParsed: vi.fn(),
  appendDomainEvents: vi.fn(),
  appendMixedDomainEvents: vi.fn(),
  appendProjectionOnlyDomainEvents: vi.fn(),
  assertDomainEventTargetMonthsAttached: vi.fn(),
  loadDomainEventPartitionCoverage: vi.fn(),
  DomainEventTargetMonthsUnattachedError: class extends Error {},
  // The read seam's value imports. Never reached here: every fake row carries
  // `payloadRef: null`, which the seam answers from the inline body without a
  // query in any mode.
  CapturePayloadCodecError: class extends Error {},
  canonicalizeCaptureJson: vi.fn(),
  capturePayloadRefFromColumns: vi.fn(),
  readEnvelopeCapturePayload: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

const {
  CANONICALIZE_SWEEP_QUEUE,
  DM_RECONCILE_SWEEP_QUEUE,
  ensureCanonicalizeQueues,
  ensureCanonicalizeSchedule,
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
} = await import("../apps/runtime/src/services/canonicalize-driver.ts");
const {
  canonicalizeFanslyStatsObservation,
  canParseFanslyStatsObservation,
  diagnoseFanslyStatsObservationRejection,
} = await import("../apps/runtime/src/services/canonicalize/fansly-stats.ts");

const START = new Date("2026-08-22T12:00:00.000Z");
type ReplayQuery = Parameters<typeof listObservationsForReplay>[1];

function appStub() {
  return {
    db: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never;
}

/** Move the faked wall clock forward — the only way work "costs" time here. */
function spend(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

function row(id: number, kind: string, payload: unknown = {}) {
  return {
    id,
    source: "pull",
    producer: "test",
    platform: "fansly",
    accountId: 3,
    nativeAccountRef: null,
    kind,
    payload,
    observedAt: null,
    receivedAt: START,
    parseVersion: 0,
    payloadRef: null,
  };
}

/**
 * A family with an ENDLESS backlog: every page comes back full, so the family
 * only ever stops on the page budget or on the wall-clock budget. `costMsPerRow`
 * is charged inside `canonicalize`, i.e. mid-page — which is exactly where the
 * budget must NOT be allowed to cut.
 */
function endlessFamily(lane: string, costMsPerRow = 0) {
  return {
    source: "pull" as const,
    lane,
    kinds: [`kind_${lane}`],
    version: 1,
    canonicalize: () => {
      if (costMsPerRow > 0) {
        spend(costMsPerRow);
      }
      return [];
    },
  };
}

/** Serve full pages forever, charging `costMsPerPage` per fetch. */
function serveEndlessPages(costMsPerPage: number) {
  let nextId = 1;
  dbMocks.listObservationsForReplay.mockImplementation(
    async (_db: unknown, query: ReplayQuery) => {
      if (costMsPerPage > 0) {
        spend(costMsPerPage);
      }
      const kind = query.kinds?.[0] ?? "kind_unknown";
      return Array.from({ length: query.limit ?? 200 }, () => ({
        ...row(nextId++, kind), parseVersion: query.atLeastParseVersion ?? 0,
      }));
    },
  );
}

/** Stateful selection follows BOTH version bounds and the real keyset order. */
function serveCorpus(
  pending: Array<ReturnType<typeof row>>,
  cost: (query: ReplayQuery, selected: Array<ReturnType<typeof row>>) => void = () => {},
) {
  const reads: Array<{ below: number; atLeast: number | undefined; ids: number[] }> = [];
  dbMocks.listObservationsForReplay.mockImplementation(async (_db, query: ReplayQuery) => {
    const selected = pending.filter(item => item.source === query.source
      && (query.kinds === undefined || query.kinds.includes(item.kind))
      && item.parseVersion < query.belowParseVersion
      && item.parseVersion >= (query.atLeastParseVersion ?? 0)
      && item.id > (query.afterId ?? 0))
      .sort((left, right) => left.id - right.id).slice(0, query.limit ?? 200);
    reads.push({ below: query.belowParseVersion, atLeast: query.atLeastParseVersion, ids: selected.map(item => item.id) });
    cost(query, selected);
    return selected;
  });
  dbMocks.markObservationParsed.mockImplementation(async (_db, input) => {
    const item = pending.find(candidate => candidate.id === input.observationId)!;
    item.parseVersion = Math.max(item.parseVersion, input.parseVersion);
  });
  return reads;
}

/** The kind each `listObservationsForReplay` call asked for, in call order. */
function scannedKinds(): string[] {
  return dbMocks.listObservationsForReplay.mock.calls
    .map((call) => (call[1] as { kinds?: readonly string[] }).kinds?.[0] ?? "?");
}

describe("canonicalization sweep wall-clock budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    for (const mock of Object.values(dbMocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        (mock as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    dbMocks.listPageNativeAccountRefs.mockResolvedValue([]);
    dbMocks.markObservationParsed.mockResolvedValue(undefined);
    const cursors = new Map<string, { key: string; afterId: number | null; revision: number }>();
    dbMocks.getCanonicalizeSweepCursor.mockImplementation(async (_db: unknown, key: string) => {
      const cursor = cursors.get(key) ?? { key, afterId: null, revision: 0 };
      cursors.set(key, cursor);
      return { ...cursor };
    });
    dbMocks.advanceCanonicalizeSweepCursor.mockImplementation(async (_db: unknown,
      cursor: { key: string; revision: number }, afterId: number | null) => {
      const next = { key: cursor.key, afterId, revision: cursor.revision + 1 };
      cursors.set(cursor.key, next);
      return next;
    });
    resetCanonicalizeSweepRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes new capture before versioned replay without spending another page", async () => {
    const pending = [
      { ...row(1, "kind_a"), parseVersion: 5 },
      { ...row(2, "kind_a"), parseVersion: 5 },
      row(3, "kind_a"),
    ];
    dbMocks.listObservationsForReplay.mockImplementation(async (_db, query) => pending
      .filter(item => item.parseVersion < query.belowParseVersion
        && item.parseVersion >= (query.atLeastParseVersion ?? 0) && item.id > (query.afterId ?? 0))
      .slice(0, query.limit));
    dbMocks.markObservationParsed.mockImplementation(async (_db, input) => {
      pending.find(item => item.id === input.observationId)!.parseVersion = input.parseVersion;
    });

    const result = await runCanonicalization(appStub(), {
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 2,
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
    });

    expect(dbMocks.markObservationParsed.mock.calls.map(call => call[1].observationId)).toEqual([3, 1]);
    expect(result).toMatchObject({ scanned: 2, stamped: 2, errored: 0 });
    expect(pending.map(item => item.parseVersion)).toEqual([6, 5, 6]);
  });

  it("gives replay the whole page allowance when no new capture is pending", async () => {
    let id = 0;
    dbMocks.listObservationsForReplay.mockImplementation(async (_db, query) => query.belowParseVersion === 1
      ? [] : Array.from({ length: query.limit }, () => ({
        ...row(++id, "kind_a"), parseVersion: query.atLeastParseVersion ?? 0,
      })));
    expect(await runCanonicalization(appStub(), {
      useSweepCursor: true, pageSize: 2, maxPagesPerFamily: 2,
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
    })).toMatchObject({ scanned: 4, stamped: 4 });
    expect(dbMocks.listObservationsForReplay.mock.calls.map(call => call[1].belowParseVersion)).toEqual([1, 6, 6]);
  });

  it("resumes capture after its half-time allowance using only the original deadline", async () => {
    const pending = Array.from({ length: 6 }, (_, index) => row(index + 1, "kind_a"));
    const reads = serveCorpus(pending, (_query, selected) => { if (selected.length > 0) spend(30); });
    expect(await runCanonicalization(appStub(), {
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 6, maxDurationMs: 100,
    })).toMatchObject({ scanned: 4, stamped: 4, truncatedByBudget: true, errored: 0 });
    // Two capture pages hit the 50ms reserved deadline; empty replay gives
    // its unused pages back. The fourth row overshoots the ORIGINAL 100ms.
    expect(reads.map(read => read.ids)).toEqual([[1], [2], [], [3], [4]]);
    expect(pending.map(item => item.parseVersion)).toEqual([6, 6, 6, 6, 0, 0]);
  });

  it("returns unused capture pages to replay when restart owes replay the first turn", async () => {
    const pending: Array<ReturnType<typeof row>> = [];
    const reads = serveCorpus(pending);
    const options = {
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 4,
    };
    await runCanonicalization(appStub(), options);
    const key = dbMocks.getCanonicalizeSweepCursor.mock.calls.find(call => call[1].startsWith("next-pass:"))![1];
    const cursor = await dbMocks.getCanonicalizeSweepCursor({}, key);
    await dbMocks.advanceCanonicalizeSweepCursor({}, cursor, 1);
    pending.push(...Array.from({ length: 5 }, (_, index) => ({ ...row(index + 1, "kind_a"), parseVersion: 5 })));
    reads.length = 0;
    resetCanonicalizeSweepRuntime();

    expect(await runCanonicalization(appStub(), options)).toMatchObject({ scanned: 4, stamped: 4, errored: 0 });
    expect(reads).toEqual([
      { below: 6, atLeast: 1, ids: [1] }, { below: 6, atLeast: 1, ids: [2] },
      { below: 1, atLeast: undefined, ids: [] },
      { below: 6, atLeast: 1, ids: [3] }, { below: 6, atLeast: 1, ids: [4] },
    ]);
    expect(pending.map(item => item.parseVersion)).toEqual([6, 6, 6, 6, 5]);
  });

  it.each([false, true])("preserves borrowed-page overshoot fairness (process restart: %s)", async restart => {
    const pending = [1, 2, 3, 4].map(id => row(id, "kind_a"));
    pending.push(row(5, "kind_b"));
    const reads = serveCorpus(pending, (_query, selected) => { if (selected.some(item => item.id === 3)) spend(120); });
    const options = {
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }, endlessFamily("b")],
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 4, maxDurationMs: 100,
    };
    expect(await runCanonicalization(appStub(), options)).toMatchObject({
      scanned: 3, stamped: 3, errored: 0, truncatedByBudget: true, skippedFamilies: ["pull:b"],
    });
    expect(reads.map(read => read.ids)).toEqual([[1], [2], [], [3]]);
    const key = dbMocks.getCanonicalizeSweepCursor.mock.calls.find(call => call[1].startsWith("next-pass:"))![1];
    expect(await dbMocks.getCanonicalizeSweepCursor({}, key)).toMatchObject({ afterId: 1 });

    dbMocks.listObservationsForReplay.mockClear();
    reads.length = 0;
    if (restart) resetCanonicalizeSweepRuntime();
    expect(await runCanonicalization(appStub(), options)).toMatchObject({ scanned: 2, stamped: 2, errored: 0 });
    // Rotation survives between live calls; after restart only the durable
    // per-family owed turn survives, as before this change.
    expect(scannedKinds()[0]).toBe(restart ? "kind_a" : "kind_b");
    const firstAQuery = dbMocks.listObservationsForReplay.mock.calls.find(call => call[1].kinds[0] === "kind_a")![1];
    expect(firstAQuery).toMatchObject({ belowParseVersion: 6, atLeastParseVersion: 1 });
    expect(pending.map(item => item.parseVersion)).toEqual([6, 6, 6, 6, 1]);
  });

  it("does not start the borrowed forced first page after its turn-marker write consumes the deadline", async () => {
    const pending = Array.from({ length: 4 }, (_, index) => row(index + 1, "kind_a"));
    const reads = serveCorpus(pending);
    const advance = dbMocks.advanceCanonicalizeSweepCursor.getMockImplementation()!;
    let turnWrites = 0;
    dbMocks.advanceCanonicalizeSweepCursor.mockImplementation(async (...args) => {
      if (args[1].key.startsWith("next-pass:") && ++turnWrites === 3) spend(100);
      return advance(...args);
    });
    expect(await runCanonicalization(appStub(), {
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 4, maxDurationMs: 100,
    })).toMatchObject({ scanned: 2, stamped: 2, truncatedByBudget: true, errored: 0 });
    expect(reads.map(read => read.ids)).toEqual([[1], [2], []]);
    expect(pending.map(item => item.parseVersion)).toEqual([6, 6, 0, 0]);
  });

  it("shares the wall-clock budget across capture and replay and keeps family rotation", async () => {
    serveEndlessPages(60);
    const options = {
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 3, maxDurationMs: 100,
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }, endlessFamily("b")],
    };
    expect(await runCanonicalization(appStub(), options)).toMatchObject({
      scanned: 2, stamped: 2, truncatedByBudget: true, skippedFamilies: ["pull:b"],
    });
    expect(dbMocks.listObservationsForReplay.mock.calls.map(call => call[1].belowParseVersion)).toEqual([1, 6]);
    dbMocks.listObservationsForReplay.mockClear();
    await runCanonicalization(appStub(), options);
    expect(scannedKinds()[0]).toBe("kind_b");
  });

  it("gives the other pass its turn after page overshoot and process restart", async () => {
    serveEndlessPages(120);
    const options = {
      useSweepCursor: true, pageSize: 1, maxPagesPerFamily: 4, maxDurationMs: 100,
      families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
    };
    for (let run = 0; run < 3; run += 1) {
      resetCanonicalizeSweepRuntime();
      expect(await runCanonicalization(appStub(), options)).toMatchObject({ scanned: 1, truncatedByBudget: true });
    }
    expect(dbMocks.listObservationsForReplay.mock.calls.map(call => call[1].belowParseVersion)).toEqual([1, 6, 1]);
  });

  it.each([{ useSweepCursor: false }, { useSweepCursor: true, dryRun: true }, { useSweepCursor: true, maxPagesPerFamily: 1 }])(
    "keeps CLI, dry-run and single-page runs on their original traversal (%j)", async options => {
      serveEndlessPages(0);
      await runCanonicalization(appStub(), {
        pageSize: 1, maxPagesPerFamily: 2, ...options,
        families: [{ ...endlessFamily("a"), version: 6, prioritizeUnparsed: true }],
      });
      expect(dbMocks.listObservationsForReplay.mock.calls.every(call => call[1].belowParseVersion === 6)).toBe(true);
      if (options.dryRun) expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
    },
  );

  it("separates persisted cursors by scope and parser version", async () => {
    serveEndlessPages(0);
    const family = endlessFamily("a");
    const base = { useSweepCursor: true, pageSize: 2, maxPagesPerFamily: 1, families: [family] };
    await runCanonicalization(appStub(), base);
    const firstKey = dbMocks.getCanonicalizeSweepCursor.mock.calls[0]![1];
    resetCanonicalizeSweepRuntime();
    await runCanonicalization(appStub(), base);
    expect(dbMocks.listObservationsForReplay.mock.calls[1]![1]).toMatchObject({ afterId: 2 });
    for (const changed of [{ accountId: 3 }, { from: START }, { belowParseVersion: 2 },
      { families: [{ ...family, version: 2 }] }, { kinds: ["kind_a", "kind_other"] }]) {
      await runCanonicalization(appStub(), { ...base, ...changed });
      expect(dbMocks.getCanonicalizeSweepCursor.mock.lastCall![1]).not.toBe(firstKey);
      expect(dbMocks.listObservationsForReplay.mock.lastCall![1]).toMatchObject({ afterId: null });
    }
  });

  it("stops between pages, names the families it never reached, and returns normally", async () => {
    serveEndlessPages(60);
    const result = await runCanonicalization(appStub(), {
      useSweepCursor: true,
      maxDurationMs: 100,
      pageSize: 2,
      maxPagesPerFamily: 10,
      families: [endlessFamily("a"), endlessFamily("b"), endlessFamily("c")],
    });

    // Page 0 ends at t=60 (budget alive), page 1 at t=120 — so the third page
    // is the one refused, and the two that ran are complete.
    expect(scannedKinds()).toEqual(["kind_a", "kind_a"]);
    expect(result).toMatchObject({
      truncatedByBudget: true,
      skippedFamilies: ["pull:b", "pull:c"],
      scanned: 4,
      stamped: 4,
      errored: 0,
    });
  });

  it("never cuts mid-row: every row of a fetched page still stamps", async () => {
    // The clock runs out INSIDE the first page (row 2 of 3). A row is the unit
    // of work that appends and stamps in one commit, so the budget must not be
    // read until the page is finished.
    serveEndlessPages(0);
    const result = await runCanonicalization(appStub(), {
      useSweepCursor: true,
      maxDurationMs: 100,
      pageSize: 3,
      maxPagesPerFamily: 10,
      families: [endlessFamily("a", 60), endlessFamily("b")],
    });

    expect(scannedKinds()).toEqual(["kind_a"]);
    expect(result).toMatchObject({
      truncatedByBudget: true,
      skippedFamilies: ["pull:b"],
      scanned: 3,
      stamped: 3,
    });
    expect(dbMocks.markObservationParsed).toHaveBeenCalledTimes(3);
    const stampedIds = (dbMocks.markObservationParsed.mock.calls as unknown as Array<
      [unknown, { observationId: number }]
    >).map(([, stamp]) => stamp.observationId);
    expect(stampedIds).toEqual([1, 2, 3]);
  });

  it("rotates: the next run starts at the family after the one that ran the budget out", async () => {
    serveEndlessPages(60);
    const families = [endlessFamily("a"), endlessFamily("b"), endlessFamily("c")];
    const options = {
      useSweepCursor: true,
      maxDurationMs: 100,
      pageSize: 2,
      maxPagesPerFamily: 10,
      families,
    };

    const first = await runCanonicalization(appStub(), options);
    expect(first.skippedFamilies).toEqual(["pull:b", "pull:c"]);

    vi.setSystemTime(START);
    dbMocks.listObservationsForReplay.mockClear();
    const second = await runCanonicalization(appStub(), options);
    // B heads this run (and runs the budget out in turn), so C is next.
    expect(scannedKinds()).toEqual(["kind_b", "kind_b"]);
    expect(second.skippedFamilies).toEqual(["pull:c", "pull:a"]);

    vi.setSystemTime(START);
    dbMocks.listObservationsForReplay.mockClear();
    const third = await runCanonicalization(appStub(), options);
    expect(scannedKinds()).toEqual(["kind_c", "kind_c"]);
    expect(third.skippedFamilies).toEqual(["pull:a", "pull:b"]);
  });

  it("resumes a truncated family's own scan where it stopped when its turn comes round", async () => {
    serveEndlessPages(60);
    const families = [endlessFamily("a"), endlessFamily("b")];
    const options = {
      useSweepCursor: true,
      maxDurationMs: 100,
      pageSize: 2,
      maxPagesPerFamily: 10,
      families,
    };

    await runCanonicalization(appStub(), options);
    // A stopped after ids 1-4; its sweep cursor must hold that continuation.
    const lastAfterIdOfA = (dbMocks.listObservationsForReplay.mock.calls.at(-1)![1] as {
      afterId: number | null;
    }).afterId;
    expect(lastAfterIdOfA).toBe(2);

    vi.setSystemTime(START);
    await runCanonicalization(appStub(), options); // B's turn
    vi.setSystemTime(START);
    dbMocks.listObservationsForReplay.mockClear();
    await runCanonicalization(appStub(), options); // back to A

    expect((dbMocks.listObservationsForReplay.mock.calls[0]![1] as { afterId: number | null }).afterId)
      .toBe(4);
  });

  it("a full pass clears the rotation and reports no truncation", async () => {
    // One page each, no cost: nothing is ever skipped, so the next run starts
    // at the registry head exactly as every run did before the budget existed.
    dbMocks.listObservationsForReplay.mockImplementation(async () => []);
    const families = [endlessFamily("a"), endlessFamily("b"), endlessFamily("c")];
    const options = {
      useSweepCursor: true,
      maxDurationMs: 100,
      pageSize: 2,
      maxPagesPerFamily: 10,
      families,
    };

    const result = await runCanonicalization(appStub(), options);
    expect(result).toMatchObject({ truncatedByBudget: false, skippedFamilies: [] });
    expect(scannedKinds()).toEqual(["kind_a", "kind_b", "kind_c"]);

    dbMocks.listObservationsForReplay.mockClear();
    await runCanonicalization(appStub(), options);
    expect(scannedKinds()).toEqual(["kind_a", "kind_b", "kind_c"]);
  });

  it("leaves budget-free runs (CLI, replay) undisturbed and in registry order", async () => {
    serveEndlessPages(60);
    const families = [endlessFamily("a"), endlessFamily("b"), endlessFamily("c")];

    // A truncated sweep first, so a rotation offset exists to be ignored.
    await runCanonicalization(appStub(), {
      useSweepCursor: true,
      maxDurationMs: 100,
      pageSize: 2,
      maxPagesPerFamily: 10,
      families,
    });

    vi.setSystemTime(START);
    dbMocks.listObservationsForReplay.mockClear();
    const cli = await runCanonicalization(appStub(), {
      pageSize: 2,
      maxPagesPerFamily: 1,
      families,
    });

    expect(scannedKinds()).toEqual(["kind_a", "kind_b", "kind_c"]);
    expect(cli).toMatchObject({ truncatedByBudget: false, skippedFamilies: [] });
  });

  it("returns bounded content-free diagnostics for shape-gate refusals", async () => {
    dbMocks.listObservationsForReplay
      .mockResolvedValueOnce([row(77, "posts")])
      .mockResolvedValueOnce([]);
    const diagnostics: string[] = [];
    const result = await runCanonicalization(appStub(), {
      families: [{
        source: "pull",
        lane: "posts",
        kinds: ["posts"],
        version: 6,
        canonicalize: () => [],
        canParse: () => false,
        parseRejection: () => ({ code: "like_count_invalid", itemIndex: 4 }),
      }],
      diagnostics: { record: (code) => void diagnostics.push(code) },
    });

    expect(result).toMatchObject({
      scanned: 1,
      skippedUnparseable: 1,
      stamped: 0,
      unparseableSamples: [{
        observationId: 77,
        family: "pull:posts",
        kind: "posts",
        reasonCode: "like_count_invalid",
        itemIndex: 4,
      }],
    });
    expect(diagnostics).toEqual([
      "canonicalize_rejected:posts:like_count_invalid",
    ]);
    expect(dbMocks.markObservationParsed).not.toHaveBeenCalled();
  });

  it("stamps an exact terminal-null account-stats row without minting events", async () => {
    dbMocks.listObservationsForReplay
      .mockResolvedValueOnce([row(88, "account_stats", {
        dataset: null,
        aggregationData: null,
      })])
      .mockResolvedValueOnce([]);

    const result = await runCanonicalization(appStub(), {
      families: [{
        source: "pull",
        lane: "stats",
        kinds: ["account_stats"],
        version: 2,
        canonicalize: canonicalizeFanslyStatsObservation,
        canParse: canParseFanslyStatsObservation,
        parseRejection: diagnoseFanslyStatsObservationRejection,
        projectionOnly: true,
      }],
    });

    expect(result).toMatchObject({
      scanned: 1,
      stamped: 1,
      appended: 0,
      skippedUnparseable: 0,
      unparseableSamples: [],
    });
    expect(dbMocks.markObservationParsed).toHaveBeenCalledWith(expect.anything(), {
      observationId: 88,
      receivedAt: START,
      parseVersion: 2,
    });
    expect(dbMocks.appendProjectionOnlyDomainEvents).not.toHaveBeenCalled();
  });
});

describe("canonicalize queue lifecycle", () => {
  it("creates and schedules the sweep AND the reconcile job it was split from", async () => {
    const created: Array<[string, unknown]> = [];
    const scheduled: Array<[string, string, unknown, unknown]> = [];
    const boss = {
      createQueue: async (name: string, options?: unknown) => {
        created.push([name, options]);
      },
      schedule: async (name: string, cron: string, data?: unknown, options?: unknown) => {
        scheduled.push([name, cron, data, options]);
      },
    };

    await ensureCanonicalizeQueues(boss as never);
    await ensureCanonicalizeSchedule(boss as never);

    expect(created.map(([name]) => name))
      .toEqual([CANONICALIZE_SWEEP_QUEUE, DM_RECONCILE_SWEEP_QUEUE]);
    for (const [, options] of created) {
      expect(options).toMatchObject({ policy: "exclusive" });
    }
    // Both minutely: a sweep that spends its whole tick inside one family must
    // not be able to hold the reconciles back.
    expect(scheduled).toEqual([
      [CANONICALIZE_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" }],
      [DM_RECONCILE_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" }],
    ]);
  });
});

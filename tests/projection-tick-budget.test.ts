// The projection tick's wall-clock budget and its rotation (defect 2026-08-22).
//
// `projections.message-archive.sweep` → `runProjectionTick` awaited EVERY
// registered projection to completion, in registry order, with no clock. After
// WP-F6's v6 drain appended ~11 000 `post.observed` events and the F1..F7
// families tens of thousands more, one tick ran 11+ minutes and hit pg-boss's
// 900s handler expiration: the job was killed mid-pass, the next tick started
// at the head, and it was killed again — so the projections at the END of the
// registry never ran at all. `page_payout_requests` was empty while 91
// `payout.observed` events sat in the ledger.
//
// These are the pins for the tick half of the fix (the canonicalize sweep's
// half is tests/canonicalize-budget.test.ts). The clock is faked and every
// projection is a stub, so they assert the CONTROL FLOW — where the budget may
// and may not cut, and which projection the next tick starts at — rather than
// any timing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry pulls in every projector module, which reach into the db layer.
// Nothing here calls them: the stubs below replace the registry's entries
// wholesale, as the rebuild-preflight block at the end patches one of them.
const dbMocks = vi.hoisted(() => ({
  listDetachedPartitionsHoldingAccount: vi.fn(),
  listEventAccounts: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

const {
  PROJECTION_REGISTRY,
  PROJECTION_TICK_BUDGET_MS,
  rebuildRegisteredProjection,
  resetProjectionTickRotation,
  runProjectionTick,
} = await import("../apps/runtime/src/services/projections/registry.ts");

type Projection = (typeof PROJECTION_REGISTRY)[number];

const START = new Date("2026-08-22T12:07:00.000Z");

/** Mutable per-projection cost, so one tick can be cheap and the next dear. */
const costMs = new Map<string, number>();
/** Names in the order their `run()` was entered, across the whole test. */
let ran: string[] = [];

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

function stub(name: string): Projection {
  return {
    name,
    eventTypes: [`${name}.observed`],
    tables: [`t_${name}`],
    stateClass: "fact_projection",
    rebuildKind: "none",
    label: `${name} projection sweep complete`,
    run: async () => {
      ran.push(name);
      spend(costMs.get(name) ?? 0);
      return { projected: 1 };
    },
    rebuild: null,
    didWork: () => false,
  };
}

/** Swap the whole registry for stubs; `restoreRegistry` puts it back. */
const registry = PROJECTION_REGISTRY as unknown as Projection[];
const realRegistry = [...registry];

function installStubs(names: readonly string[]) {
  registry.splice(0, registry.length, ...names.map((name) => stub(name)));
}

describe("projection tick wall-clock budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    ran = [];
    costMs.clear();
    dbMocks.listEventAccounts.mockReset();
    resetProjectionTickRotation();
    installStubs(["a", "b", "c"]);
  });

  afterEach(() => {
    registry.splice(0, registry.length, ...realRegistry);
    resetProjectionTickRotation();
    vi.useRealTimers();
  });

  it("stops between projections and names the ones it never reached", async () => {
    for (const name of ["a", "b", "c"]) costMs.set(name, 60);

    const result = await runProjectionTick(appStub(), { maxDurationMs: 50 });

    // A runs (the head always does — the deadline is taken at entry) and ends
    // at t=60, past the budget, so B's turn is the one refused.
    expect(ran).toEqual(["a"]);
    expect(result.truncatedByBudget).toBe(true);
    expect(result.skippedProjections).toEqual(["b", "c"]);
    // Truncation is not failure: what ran, ran whole and is reported.
    expect(result.outcomes.map((outcome) => outcome.name)).toEqual(["a"]);
    expect(result.outcomes[0]?.error).toBeNull();
  });

  it("never cuts inside a projection: a started run() completes", async () => {
    // B costs ten budgets on its own. It still runs to completion — a
    // projection pages its own ledger read and commits per page, so the tick
    // has no safe place to cut inside one.
    costMs.set("a", 40);
    costMs.set("b", 500);

    const result = await runProjectionTick(appStub(), { maxDurationMs: 50 });

    expect(ran).toEqual(["a", "b"]);
    expect(result.outcomes.map((outcome) => outcome.name)).toEqual(["a", "b"]);
    expect(result.skippedProjections).toEqual(["c"]);
  });

  it("rotates: the next tick starts at the projection after the one that ran the budget out", async () => {
    for (const name of ["a", "b", "c"]) costMs.set(name, 60);

    const first = await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(first.skippedProjections).toEqual(["b", "c"]);

    vi.setSystemTime(START);
    ran = [];
    const second = await runProjectionTick(appStub(), { maxDurationMs: 50 });
    // B heads this tick (and runs the budget out in turn), so C is next.
    expect(ran).toEqual(["b"]);
    expect(second.skippedProjections).toEqual(["c", "a"]);

    vi.setSystemTime(START);
    ran = [];
    const third = await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(ran).toEqual(["c"]);
    expect(third.skippedProjections).toEqual(["a", "b"]);

    // …and A, starved for two ticks by the head of the registry, is back.
    vi.setSystemTime(START);
    ran = [];
    await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(ran).toEqual(["a"]);
  });

  it("a full pass clears the rotation and reports no truncation", async () => {
    for (const name of ["a", "b", "c"]) costMs.set(name, 60);
    const truncated = await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(truncated.skippedProjections).toEqual(["b", "c"]);

    // Now the whole registry fits in the minute: the tick completes from B, and
    // the offset it leaves behind is none.
    vi.setSystemTime(START);
    ran = [];
    costMs.clear();
    const full = await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(ran).toEqual(["b", "c", "a"]);
    expect(full.truncatedByBudget).toBe(false);
    expect(full.skippedProjections).toEqual([]);

    vi.setSystemTime(START);
    ran = [];
    await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("leaves budget-free callers (CLI, diagnostics) in registry order", async () => {
    for (const name of ["a", "b", "c"]) costMs.set(name, 60);
    // A truncated tick first, so a rotation offset exists to be ignored.
    await runProjectionTick(appStub(), { maxDurationMs: 50 });

    vi.setSystemTime(START);
    ran = [];
    const unbudgeted = await runProjectionTick(appStub());

    expect(ran).toEqual(["a", "b", "c"]);
    expect(unbudgeted.truncatedByBudget).toBe(false);
    expect(unbudgeted.skippedProjections).toEqual([]);
    // …and an unbudgeted tick does not move the offset either: the next
    // budgeted tick still resumes at B, where the truncation left it.
    vi.setSystemTime(START);
    ran = [];
    await runProjectionTick(appStub(), { maxDurationMs: 50 });
    expect(ran).toEqual(["b"]);
  });

  describe("per-account isolation inside one projection (J8)", () => {
    /** B's run: the whole run and the listed accounts throw; the rest pass. */
    function poisonB(poisoned: (accountId: number | null | undefined) => boolean) {
      const calls: (number | null | undefined)[] = [];
      const index = registry.findIndex((projection) => projection.name === "b");
      registry[index] = {
        ...registry[index]!,
        run: async (_app, input) => {
          calls.push(input?.accountId);
          if (poisoned(input?.accountId)) {
            throw new Error(`poison fact on ${input?.accountId ?? "the whole run"}`);
          }
          return { projected: 1 };
        },
      };
      return calls;
    }

    it("a poison account parks only itself: every other account still runs, and the tick goes on", async () => {
      dbMocks.listEventAccounts.mockResolvedValue([1, 2, 3]);
      // The whole run reaches account 2 (in id order) and throws there.
      const calls = poisonB((accountId) => accountId === undefined || accountId === 2);
      const app = appStub() as unknown as {
        logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
      };

      const result = await runProjectionTick(app as never, { maxDurationMs: 50_000 });

      // A throw is not a truncation, and only B carries an error.
      expect(result.truncatedByBudget).toBe(false);
      expect(result.outcomes.map((outcome) => outcome.error !== null)).toEqual([false, true, false]);
      // No breaker at the first failure: account 3 runs after 2 fails with
      // exactly the whole run's error. Account 1 runs a second time.
      expect(calls).toEqual([undefined, 1, 2, 3]);
      expect(ran).toEqual(["a", "c"]);
      const outcomeB = result.outcomes.find((outcome) => outcome.name === "b")!;
      expect(outcomeB.error).toBeInstanceOf(Error);
      expect(outcomeB.failedAccounts).toEqual([2]);
      // One aggregated line per projection per tick.
      expect(app.logger.error).toHaveBeenCalledTimes(1);
      const [fields, message] = app.logger.error.mock.calls[0]!;
      expect(message).toBe("b projection sweep failed");
      expect(fields).toMatchObject({
        projection: "b",
        failedAccounts: [2],
        accountErrors: [{ accountId: 2, error: "poison fact on 2" }],
      });
    });

    it("every failing account is attempted and reported on one line", async () => {
      dbMocks.listEventAccounts.mockResolvedValue([1, 2, 3, 4]);
      const calls = poisonB((accountId) => accountId !== 1 && accountId !== 4);
      const app = appStub() as unknown as { logger: { error: ReturnType<typeof vi.fn> } };

      const result = await runProjectionTick(app as never, { maxDurationMs: 50_000 });

      expect(calls).toEqual([undefined, 1, 2, 3, 4]);
      expect(result.outcomes.find((outcome) => outcome.name === "b")!.failedAccounts).toEqual([2, 3]);
      expect(app.logger.error).toHaveBeenCalledTimes(1);
    });

    it("a whole-run error every account survives on its own is recovered, not a failure", async () => {
      dbMocks.listEventAccounts.mockResolvedValue([1, 2]);
      const calls = poisonB((accountId) => accountId === undefined);
      const app = appStub() as unknown as {
        logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
      };

      const result = await runProjectionTick(app as never, { maxDurationMs: 50_000 });

      expect(calls).toEqual([undefined, 1, 2]);
      const outcomeB = result.outcomes.find((outcome) => outcome.name === "b")!;
      expect(outcomeB.error).toBeNull();
      expect(outcomeB.result).toEqual({ recoveredAfterError: true, accounts: 2 });
      expect(outcomeB.failedAccounts).toBeUndefined();
      expect(app.logger.error).not.toHaveBeenCalled();
      expect(app.logger.warn).toHaveBeenCalledTimes(1);
    });

    it("an unreadable account list reports the whole-run error alone", async () => {
      dbMocks.listEventAccounts.mockRejectedValue(new Error("db down"));
      const calls = poisonB(() => true);
      const app = appStub() as unknown as { logger: { error: ReturnType<typeof vi.fn> } };

      const result = await runProjectionTick(app as never, { maxDurationMs: 50_000 });

      expect(calls).toEqual([undefined]);
      const outcomeB = result.outcomes.find((outcome) => outcome.name === "b")!;
      expect(outcomeB.error).toBeInstanceOf(Error);
      expect(outcomeB.failedAccounts).toBeUndefined();
      expect(ran).toEqual(["a", "c"]);
      expect(app.logger.error).toHaveBeenCalledTimes(1);
    });
  });

  it("budgets ten minutes, under pg-boss's 900s handler expiration", () => {
    expect(PROJECTION_TICK_BUDGET_MS).toBeLessThan(900_000);
  });
});

// §3.2c(i) — the READ-SIDE preflight, asserted for EVERY registered projection.
//
// Tiering exports and DETACHES `domain_events` monthlies older than ~6 months,
// and `listEventsSince` sees only ATTACHED partitions. A rebuild that ran anyway
// would truncate the projection, replay a truncated ledger, and call the result
// authoritative — silently. Before WP-F1(0) only `media_plane` and
// `message_archive` had the gate: `creator_posts` and `fan_earnings` would have
// replayed a truncated ledger without a word. The registry is what makes
// "every projection" checkable rather than a promise.
//
// A fresh-database checksum test does NOT discharge this (§9.1 says so): a
// fresh database has no detached partitions, so it can only ever prove the
// happy path.

describe("rebuild preflight", () => {
  const app = {
    db: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };

  beforeEach(() => {
    dbMocks.listDetachedPartitionsHoldingAccount.mockReset();
    dbMocks.listEventAccounts.mockReset();
    dbMocks.listEventAccounts.mockResolvedValue([7]);
  });

  it("refuses every rebuildable projection when a detached partition holds the account", async () => {
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([
      { schema: "public", name: "domain_events_2026_01", rows: 41_002 },
    ]);

    const rebuildable = PROJECTION_REGISTRY.filter(
      (projection) => projection.rebuild !== null,
    );
    expect(rebuildable.length).toBeGreaterThan(0);

    for (const projection of rebuildable) {
      await expect(
        rebuildRegisteredProjection(app, projection.name, { accountId: 7 }),
        projection.name,
      ).rejects.toThrow(
        // The message must name the projection, the partition, AND the recovery
        // — an operator who reads "refused" without "re-attach the month" will
        // reach for `create partition`, which orphans the facts the detached
        // table holds — and the recovery must forbid DROP.
        new RegExp(
          `${projection.name} rebuild REFUSED for account 7:.*domain_events_2026_01 \\(41002 rows\\).*re-attach the month \\(the 0077 ritual — DETACH/ATTACH only, never DROP\\)`,
          "s",
        ),
      );
    }
  });

  it("runs the census over every account in scope when no account is given", async () => {
    dbMocks.listEventAccounts.mockResolvedValue([11, 12, 13]);
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([]);
    const stats = PROJECTION_REGISTRY.find((projection) => projection.name === "fansly_stats");
    expect(stats).toBeDefined();
    // Stub the rebuild itself: the property under test is the preflight's
    // SCOPE, not what the replay produces.
    const rebuild = vi.fn(async () => ({ ok: true }));
    const patched = { ...stats!, rebuild };
    const index = PROJECTION_REGISTRY.indexOf(stats!);
    const registry = PROJECTION_REGISTRY as unknown as Array<typeof patched>;
    registry[index] = patched;
    try {
      await rebuildRegisteredProjection(app, "fansly_stats");
      expect(dbMocks.listDetachedPartitionsHoldingAccount).toHaveBeenCalledTimes(3);
      expect(rebuild).toHaveBeenCalledTimes(1);
    } finally {
      registry[index] = stats as never;
    }
  });

  it("refuses a projection that declares no repair path instead of pretending", async () => {
    dbMocks.listDetachedPartitionsHoldingAccount.mockResolvedValue([]);
    const unrebuildable = PROJECTION_REGISTRY.find(
      (projection) => projection.rebuildKind === "none",
    );
    expect(unrebuildable).toBeDefined();
    await expect(
      rebuildRegisteredProjection(app, unrebuildable!.name, { accountId: 7 }),
    ).rejects.toThrow(/declares rebuildKind "none"/);
  });

  it("rejects an unknown projection name with the list of known ones", async () => {
    await expect(rebuildRegisteredProjection(app, "not_a_projection")).rejects.toThrow(
      /Unknown projection: not_a_projection\. Known: /,
    );
  });
});

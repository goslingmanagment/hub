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
// wholesale, exactly as tests/rebuild-preflight.test.ts patches one of them.
const dbMocks = vi.hoisted(() => ({
  listDetachedPartitionsHoldingAccount: vi.fn(),
  listEventAccounts: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => dbMocks);

const {
  PROJECTION_REGISTRY,
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
});

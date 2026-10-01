import { describe, expect, it } from "vitest";

import {
  CYCLE,
  classBlocked,
  pick,
  WORK_CLASSES,
  type ClassWorkSource,
  type SchedulerPage,
  type WorkClass,
} from "../apps/runtime/src/sync/engine/scheduler.ts";

// The 10-slot cycle U R U R U R U R U P (plan §3, design §3.4): the shares
// under contention, the skipping of empty and blocked classes, the service
// gaps, and the pointer that survives a restart.

const NOW = new Date("2026-10-02T12:00:00.000Z");

type Work = { workClass: WorkClass; seq: number };

/** Classes with an endless (or counted) supply of runnable work. Records
 *  every question it was asked. */
class FakeClasses implements ClassWorkSource<Work> {
  readonly asked: WorkClass[] = [];
  #seq = 0;
  constructor(readonly supply: Partial<Record<WorkClass, number>>) {}
  async pickInClass(workClass: WorkClass): Promise<Work | null> {
    this.asked.push(workClass);
    const left = this.supply[workClass] ?? 0;
    if (left <= 0) return null;
    this.supply[workClass] = left - 1;
    this.#seq += 1;
    return { workClass, seq: this.#seq };
  }
}

function page(overrides: Partial<SchedulerPage> = {}): SchedulerPage {
  return { cyclePos: 0, pausedAll: false, pausedRequests: false, holdUntil: null, ...overrides };
}

/** Run `n` picks, storing the pointer after each one as the admission does. */
async function run(source: ClassWorkSource<Work>, n: number, state: SchedulerPage = page()) {
  const served: WorkClass[] = [];
  for (let i = 0; i < n; i += 1) {
    const picked = await pick(source, state, NOW);
    if (picked === null) break;
    expect(picked.slot).toBeGreaterThanOrEqual(0);
    expect(picked.slot).toBeLessThan(CYCLE.length);
    served.push(picked.workClass);
    state.cyclePos = picked.nextCyclePos;
  }
  return { served, state };
}

function shares(served: readonly WorkClass[]) {
  return Object.fromEntries(WORK_CLASSES.map((c) => [c, served.filter((s) => s === c).length]));
}

/** The longest run of picks between two picks of `workClass` (in slots served). */
function maxGap(served: readonly WorkClass[], workClass: WorkClass) {
  let last = -1;
  let gap = 0;
  served.forEach((c, i) => {
    if (c !== workClass) return;
    if (last >= 0) gap = Math.max(gap, i - last);
    last = i;
  });
  return gap;
}

const ENDLESS = Number.MAX_SAFE_INTEGER;

describe("sync scheduler: shares over 10 000 picks", () => {
  it("full contention: urgent 50 %, requests 40 %, planned 10 %", async () => {
    const { served } = await run(new FakeClasses({ urgent: ENDLESS, requests: ENDLESS, planned: ENDLESS }), 10_000);
    expect(shares(served)).toEqual({ urgent: 5_000, requests: 4_000, planned: 1_000 });
  });

  it("no urgent work: requests 80 %, planned 20 %", async () => {
    const { served } = await run(new FakeClasses({ requests: ENDLESS, planned: ENDLESS }), 10_000);
    expect(shares(served)).toEqual({ urgent: 0, requests: 8_000, planned: 2_000 });
  });

  it.each(WORK_CLASSES)("a single class (%s) gets every slot", async (only) => {
    const { served } = await run(new FakeClasses({ [only]: ENDLESS }), 10_000);
    expect(served).toHaveLength(10_000);
    expect(served.every((c) => c === only)).toBe(true);
  });

  it("no requests: urgent keeps its five slots per lap, planned its one", async () => {
    const { served } = await run(new FakeClasses({ urgent: ENDLESS, planned: ENDLESS }), 6_000);
    expect(shares(served)).toEqual({ urgent: 5_000, requests: 0, planned: 1_000 });
  });
});

describe("sync scheduler: service gaps", () => {
  it("under full contention the urgent class waits at most two slots, requests four, planned ten", async () => {
    const { served } = await run(new FakeClasses({ urgent: ENDLESS, requests: ENDLESS, planned: ENDLESS }), 10_000);
    expect(maxGap(served, "urgent")).toBe(2);
    expect(maxGap(served, "requests")).toBe(4);
    expect(maxGap(served, "planned")).toBe(10);
  });

  it("under endless requests without urgent work, planned is served at least every fifth slot", async () => {
    const { served } = await run(new FakeClasses({ requests: ENDLESS, planned: ENDLESS }), 10_000);
    expect(maxGap(served, "planned")).toBe(5);
  });

  it.each(Array.from({ length: CYCLE.length }, (_, pos) => pos))(
    "urgent work arriving at position %i is served within two picks under contention",
    async (cyclePos) => {
      const source = new FakeClasses({ requests: ENDLESS, planned: ENDLESS });
      const state = page({ cyclePos });
      source.supply.urgent = 1;
      const { served } = await run(source, 2, state);
      expect(served.slice(0, 2)).toContain("urgent");
    },
  );
});

describe("sync scheduler: empty and blocked classes", () => {
  it("an idle page returns null, asks each class once, and keeps the pointer", async () => {
    const source = new FakeClasses({});
    const state = page({ cyclePos: 3 });
    expect(await pick(source, state, NOW)).toBeNull();
    expect([...source.asked].sort()).toEqual(["planned", "requests", "urgent"]);
    expect(state.cyclePos).toBe(3);
  });

  it("an empty class is skipped without waiting and earns no credit", async () => {
    const source = new FakeClasses({ requests: 3, planned: ENDLESS });
    const { served } = await run(source, 12);
    // Three requests while they last, then planned only — no catch-up later.
    expect(served.filter((c) => c === "requests")).toHaveLength(3);
    source.supply.requests = ENDLESS;
    const after = await run(source, 10, page({ cyclePos: 0 }));
    expect(shares(after.served)).toEqual({ urgent: 0, requests: 8, planned: 2 });
  });

  it("a paused requests class is never asked; the other classes share its slots", async () => {
    const source = new FakeClasses({ urgent: ENDLESS, requests: ENDLESS, planned: ENDLESS });
    const { served } = await run(source, 1_000, page({ pausedRequests: true }));
    expect(source.asked).not.toContain("requests");
    expect(shares(served)).toEqual({ urgent: 834, requests: 0, planned: 166 });
  });

  it("a page hold or a page pause blocks every class: nothing is asked", async () => {
    for (const blocked of [page({ holdUntil: new Date(NOW.getTime() + 60_000) }), page({ pausedAll: true })]) {
      const source = new FakeClasses({ urgent: ENDLESS, requests: ENDLESS, planned: ENDLESS });
      expect(await pick(source, blocked, NOW)).toBeNull();
      expect(source.asked).toEqual([]);
    }
  });

  it("an expired hold blocks nothing", () => {
    const expired = page({ holdUntil: new Date(NOW.getTime() - 1) });
    for (const workClass of WORK_CLASSES) expect(classBlocked(expired, workClass, NOW)).toBe(false);
  });

  it("the slot of a pick is the position it was taken from", async () => {
    const source = new FakeClasses({ planned: 1 });
    const picked = await pick(source, page({ cyclePos: 4 }), NOW);
    expect(picked).toMatchObject({ workClass: "planned", slot: 9, nextCyclePos: 0 });
  });

  it("refuses a pointer outside the cycle", async () => {
    const source = new FakeClasses({ urgent: ENDLESS });
    for (const cyclePos of [-1, 10, 2.5, Number.NaN]) {
      await expect(pick(source, page({ cyclePos }), NOW)).rejects.toThrow(RangeError);
    }
  });
});

describe("sync scheduler: the pointer survives a restart", () => {
  it("a run interrupted at any pick continues exactly where an uninterrupted run would", async () => {
    const supply = { urgent: ENDLESS, requests: ENDLESS, planned: ENDLESS };
    const reference = await run(new FakeClasses({ ...supply }), 57);
    for (const cut of [1, 7, 10, 23, 56]) {
      const first = await run(new FakeClasses({ ...supply }), cut);
      // "Restart": a new process reads cycle_pos from the row and goes on.
      const stored = first.state.cyclePos;
      const second = await run(new FakeClasses({ ...supply }), 57 - cut, page({ cyclePos: stored }));
      expect([...first.served, ...second.served]).toEqual(reference.served);
    }
  });
});

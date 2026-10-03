import { describe, expect, it } from "vitest";

import {
  CYCLE,
  classBlocked,
  isPickWait,
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
    if (picked === null || isPickWait(picked)) break;
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

describe("sync scheduler: the short look-ahead (step 3b ruling 1)", () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  /** Each class's candidates open at the given offsets (ms from NOW; 0 =
   *  admissible now). Records every question with its instant. */
  class TimedClasses implements ClassWorkSource<Work> {
    readonly asked: Array<[WorkClass, number]> = [];
    constructor(readonly opens: Partial<Record<WorkClass, number[]>>) {}
    async pickInClass(workClass: WorkClass, now: Date, admissibleAt?: Date): Promise<Work | null> {
      const instant = (admissibleAt ?? now).getTime() - NOW.getTime();
      this.asked.push([workClass, instant]);
      const open = (this.opens[workClass] ?? []).filter((offset) => offset <= instant);
      return open.length === 0 ? null : { workClass, seq: open[0]! };
    }
  }

  it("the class whose turn it is waits for a candidate that opens within the look-ahead; nothing else is served", async () => {
    // Requests' turn (position 1): its `/message` opens in 1.2 s, a planned
    // read is admissible now — the slot waits for the request.
    const source = new TimedClasses({ requests: [1_200], planned: [0] });
    const state = page({ cyclePos: 1 });
    const picked = await pick(source, state, NOW, [at(500), at(1_200)]);
    expect(picked).toEqual({ waitUntil: at(1_200), workClass: "requests", slot: 1 });
    // Asked about now, at the last instant (something by then?), then from
    // the first instant on until one finds it; planned never.
    expect(source.asked).toEqual([["requests", 0], ["requests", 1_200], ["requests", 500]]);
    expect(state.cyclePos).toBe(1);
  });

  it("a candidate that opens later than the look-ahead holds nothing: the next class with work now is served", async () => {
    // The look-ahead's instants stop at 1.2 × S: an opening past that is not among them.
    const source = new TimedClasses({ requests: [4_000], planned: [0] });
    const picked = await pick(source, page({ cyclePos: 1 }), NOW, [at(2_000)]);
    expect(picked).toMatchObject({ workClass: "planned", slot: 9, nextCyclePos: 0 });
  });

  it("work admissible now is taken at once; an empty class looks ahead before the walk moves on", async () => {
    const now = new TimedClasses({ urgent: [0], requests: [100] });
    expect(await pick(now, page({ cyclePos: 0 }), NOW, [at(100)])).toMatchObject({ workClass: "urgent", slot: 0 });
    expect(now.asked).toEqual([["urgent", 0]]);
    // Urgent's turn, urgent empty: requests (next in the walk) waits for its candidate.
    const empty = new TimedClasses({ requests: [100], planned: [0] });
    expect(await pick(empty, page({ cyclePos: 0 }), NOW, [at(100)])).toEqual({ waitUntil: at(100), workClass: "requests", slot: 1 });
    expect(empty.asked).toEqual([["urgent", 0], ["urgent", 100], ["requests", 0], ["requests", 100]]);
    // A class with nothing by the last instant is asked once ahead, not at each.
    const later = new TimedClasses({ planned: [0] });
    expect(await pick(later, page({ cyclePos: 1 }), NOW, [at(100), at(200), at(300)])).toMatchObject({ workClass: "planned" });
    expect(later.asked).toEqual([["requests", 0], ["requests", 300], ["urgent", 0], ["urgent", 300], ["planned", 0]]);
  });

  it("a blocked class never looks ahead; instants not after now are ignored", async () => {
    const source = new TimedClasses({ requests: [100], planned: [0] });
    expect(await pick(source, page({ cyclePos: 1, pausedRequests: true }), NOW, [at(100)])).toMatchObject({ workClass: "planned" });
    expect(source.asked.some(([workClass]) => workClass === "requests")).toBe(false);
    const past = new TimedClasses({ requests: [0] });
    expect(await pick(past, page({ cyclePos: 1 }), NOW, [at(-100), at(0)])).toMatchObject({ workClass: "requests" });
    expect(past.asked).toEqual([["requests", 0]]);
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

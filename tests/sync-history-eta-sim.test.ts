import { describe, expect, it } from "vitest";

import type { SyncRouteSend, SyncRouteUse } from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";

import { ACTOR_IDLE_WAIT_MS } from "../apps/runtime/src/sync/engine/actor.ts";
import { createPacer, JITTER_MAX } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { Clock, Rng } from "../apps/runtime/src/sync/engine/ports.ts";
import {
  effectiveRatePerMin,
  EMPTY_ROUTE_STATE,
  lookaheadInstants,
  ROUTE_STATE_VERSION,
  routeExclusions,
  RouteClocks,
  type RouteKeySpec,
  type RouteState,
} from "../apps/runtime/src/sync/engine/route-policy.ts";
import { isPickWait, pick, type ClassWorkSource, type WorkClass } from "../apps/runtime/src/sync/engine/scheduler.ts";
import { FAMILY_BUDGETS, routeOfWireId, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import {
  budgetUseOf,
  ETA_MEAN_PAUSE_FACTOR,
  ETA_USE_WINDOW_MS,
  HISTORY_READ_ROUTE,
  requestsCapacity,
  type RequestsCapacity,
} from "../apps/runtime/src/sync/requests/eta.ts";

// The history ETA's rate against what the actor really serves (step 3b
// ruling 11, owner decision №24): the actor's slot loop — the real pacer on a
// simulated clock, the real 10-slot scheduler with its short look-ahead, the
// real route clocks over the journal of what was sent — at the production
// numbers (S = 2.5 s, the budget table as shipped). The ETA reads the last
// 15 minutes of that journal exactly as `pageEtaContext` reads
// `sync_attempts`, and its rate must hold the fact of the next hour within
// the control request's band, fact / forecast ∈ [0.8, 1.25] — on a quiet
// page, a busy one, a page whose `/message` runs at half after a 429, a page
// busy with other work, and a request filed while the page's planned
// backlog had every slot. The pause-only rate this replaces (S × 1.1, no
// budget) misses the quiet page's fact by a third.

const HOUR_MS = 3_600_000;
const S_MS = 2_500;
const BAND = { min: 0.8, max: 1.25 };

/** A seeded uniform [0, 1) (mulberry32). */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
}

class SimClock implements Clock {
  t = 0;
  readonly epoch = Date.parse("2026-10-03T00:00:00.000Z");
  monoNow(): number {
    return this.t;
  }
  wallNow(): Date {
    return new Date(this.epoch + this.t);
  }
  async sleep(ms: number): Promise<void> {
    if (ms > 0) this.t += ms;
  }
}

interface SimKey extends RouteKeySpec {
  key: string;
  workClass: WorkClass;
  operations: FanslyWireId[];
}

const HISTORY: SimKey = { key: "dm-messages.history", workClass: "requests", operations: ["messages.page"] };
const HEAD: SimKey = { key: "dm-messages.head", workClass: "urgent", operations: ["messages.page"] };
const MONEY: SimKey = { key: "transactions.head", workClass: "urgent", operations: ["transactions.page"] };
const NOTIFY: SimKey = { key: "notifications.head", workClass: "urgent", operations: ["notifications.page"] };
const LIST: SimKey = { key: "dm-conversations.head", workClass: "planned", operations: ["messaging.groups"] };
const MEDIA: SimKey = { key: "media-stats.walk", workClass: "planned", operations: ["media.offer_stats"] };
const STATS: SimKey = { key: "stats.account", workClass: "planned", operations: ["account.stats"] };
const POSTS: SimKey = { key: "posts.walk", workClass: "planned", operations: ["posts.timeline"] };

interface Arrival {
  key: SimKey;
  at: number;
}

interface Sent {
  at: number;
  route: FanslyRoute;
  workClass: WorkClass;
}

interface SimInput {
  seed: number;
  /** Keys that always have work (a saturated class) … */
  endless: SimKey[];
  /** … from this instant (default: the start). */
  endlessFrom?: ReadonlyMap<SimKey, number>;
  /** Keys whose work arrives at random, `perHour` on average. */
  arrivals?: Array<{ key: SimKey; perHour: number }>;
  state?: RouteState;
  endMs: number;
}

/** Poisson arrivals of `perHour` over [0, endMs). */
function poisson(rng: Rng, key: SimKey, perHour: number, endMs: number): Arrival[] {
  const out: Arrival[] = [];
  for (let at = 0; ;) {
    at += -Math.log(1 - rng.next()) * (HOUR_MS / perHour);
    if (at >= endMs) return out;
    out.push({ key, at: Math.floor(at) });
  }
}

/** The actor's slot loop over in-memory queues (`SyncActor.#lap` between
 *  `waitForSlot` and the send): the same pacer, scheduler and route clocks. */
async function simulate(input: SimInput): Promise<Sent[]> {
  const clock = new SimClock();
  const rng = seeded(input.seed);
  const state = input.state ?? EMPTY_ROUTE_STATE;
  const pending = (input.arrivals ?? []).flatMap((source) => poisson(rng, source.key, source.perHour, input.endMs)).sort((a, b) => a.at - b.at);
  const keys = [...new Set([...input.endless, ...pending.map((item) => item.key)])];
  const endlessAt = (key: SimKey, now: number) => now >= (input.endlessFrom?.get(key) ?? 0);
  const sent: Sent[] = [];
  const lastByRoute = new Map<FanslyRoute, number>();
  let cyclePos = 0;
  const pacer = createPacer({ clock, rng, pause: { readSettingMs: async () => S_MS }, ownership: { alive: () => true } });
  pacer.initTakeover(0);
  const signal = new AbortController().signal;

  while (clock.t < input.endMs) {
    const grant = await pacer.waitForSlot(signal);
    const now = clock.t;
    const sends: SyncRouteSend[] = [...lastByRoute].map(([route, at]) => ({ journal: "engine", operation: route, lastAt: new Date(clock.epoch + at) }));
    const clocks = new RouteClocks({ sends, state });
    const nowDate = clock.wallNow();
    const source: ClassWorkSource<{ key: SimKey; arrival: Arrival | null }> = {
      async pickInClass(workClass, _now, admissibleAt) {
        const closed = new Set(routeExclusions(keys, clocks, admissibleAt ?? nowDate));
        const queued = pending.find((item) => item.key.workClass === workClass && item.at <= now && !closed.has(item.key.key));
        if (queued !== undefined) return { key: queued.key, arrival: queued };
        const endless = input.endless.find((key) => key.workClass === workClass && endlessAt(key, now) && !closed.has(key.key));
        return endless === undefined ? null : { key: endless, arrival: null };
      },
    };
    const lookahead = lookaheadInstants(keys, clocks, nowDate, new Date(nowDate.getTime() + grant.settingMs * (1 + JITTER_MAX)));
    const picked = await pick(source, { cyclePos, pausedAll: false, pausedRequests: false, holdUntil: null }, nowDate, lookahead);
    const nextEvent = Math.min(
      pending.find((item) => item.at > now)?.at ?? Number.POSITIVE_INFINITY,
      ...input.endless.map((key) => input.endlessFrom?.get(key) ?? 0).filter((at) => at > now),
    );
    if (picked !== null && isPickWait(picked)) {
      clock.t = Math.min(picked.waitUntil.getTime() - clock.epoch, nextEvent);
      continue;
    }
    if (picked === null) {
      clock.t = Math.min(now + ACTOR_IDLE_WAIT_MS, nextEvent);
      continue;
    }
    const route = routeOfWireId(picked.work.key.operations[0]!);
    expect(clocks.admits(route, clock.wallNow())).toBe(true);
    const admission = pacer.arm(grant, sent.length + 1, clock.monoNow());
    expect(pacer.check(admission)).toBeNull();
    const sentAt = admission.sentMono!;
    clock.t += 300;
    pacer.complete(admission, { kind: "response", status: 200, headers: {}, bodyText: "{}", bodyBytes: 2, sendMark: "request_start" });
    lastByRoute.set(route, sentAt);
    cyclePos = picked.nextCyclePos;
    if (picked.work.arrival !== null) pending.splice(pending.indexOf(picked.work.arrival), 1);
    sent.push({ at: sentAt, route, workClass: picked.workClass });
  }
  return sent;
}

/** What `readRouteUse` returns for the window [fromMs, toMs) of the journal. */
function journalUse(sent: readonly Sent[], fromMs: number, toMs: number): SyncRouteUse[] {
  const counts = new Map<string, SyncRouteUse>();
  for (const send of sent) {
    if (send.at < fromMs || send.at >= toMs) continue;
    const id = `${send.workClass}|${send.route}`;
    const row = counts.get(id) ?? { class: send.workClass, operation: send.route, sends: 0 };
    row.sends += 1;
    counts.set(id, row);
  }
  return [...counts.values()];
}

/** The ETA's rate at `atMs` from the journal before it, and the history the
 *  actor served in the hour after it, reads a minute. */
async function forecastAndFact(input: SimInput & { atMs: number }): Promise<{ forecast: RequestsCapacity; fact: number }> {
  const sent = await simulate({ ...input, endMs: input.atMs + HOUR_MS });
  const state = input.state ?? EMPTY_ROUTE_STATE;
  const forecast = requestsCapacity({
    settingMs: S_MS,
    routePerMin: effectiveRatePerMin(HISTORY_READ_ROUTE, state),
    familyPerMin: FAMILY_BUDGETS.messaging.currentPerMin,
    use: budgetUseOf(journalUse(sent, input.atMs - ETA_USE_WINDOW_MS, input.atMs), ETA_USE_WINDOW_MS),
  });
  const fact = sent.filter((send) => send.workClass === "requests" && send.at >= input.atMs).length / 60;
  return { forecast, fact };
}

function expectWithinBand(result: { forecast: RequestsCapacity; fact: number }): void {
  const ratio = result.fact / result.forecast.perMin;
  expect(ratio, `fact ${result.fact.toFixed(2)}/min, forecast ${result.forecast.perMin.toFixed(2)}/min (${result.forecast.limitedBy})`)
    .toBeGreaterThanOrEqual(BAND.min);
  expect(ratio, `fact ${result.fact.toFixed(2)}/min, forecast ${result.forecast.perMin.toFixed(2)}/min (${result.forecast.limitedBy})`)
    .toBeLessThanOrEqual(BAND.max);
}

/** A busy page's other work (lora-1, an ordinary hour). */
const BUSY_ARRIVALS = [
  { key: HEAD, perHour: 90 },
  { key: MONEY, perHour: 60 },
  { key: LIST, perHour: 18 },
  { key: STATS, perHour: 30 },
];

describe("the history ETA's rate holds the actor's fact (step 3b ruling 11)", () => {
  it("a quiet page: the family's 15/min — where the pause alone promised ≈ 1 309 reads an hour", async () => {
    const result = await forecastAndFact({ seed: 1, endless: [HISTORY], atMs: 20 * 60_000, endMs: 0 });
    expect(result.forecast).toMatchObject({ perMin: 15, limitedBy: "family" });
    expectWithinBand(result);
    // The rate of S alone (S × 1.1 a read) is a third too fast for the fact.
    const pauseOnly = 60_000 / (S_MS * ETA_MEAN_PAUSE_FACTOR);
    expect(result.fact / pauseOnly).toBeLessThan(BAND.min);
  });

  it("a busy page: ≈ 800 reads an hour beside confirmations, money, the list, polls and the media walk (owner decision №24)", async () => {
    const result = await forecastAndFact({ seed: 2, endless: [HISTORY, MEDIA], arrivals: BUSY_ARRIVALS, atMs: 20 * 60_000, endMs: 0 });
    expect(result.forecast.limitedBy).toBe("family");
    // ≈ 108 confirmations and list reads an hour leave the family ≈ 13.2/min;
    // a 15-minute window of random arrivals measures them ± a quarter.
    expect(result.forecast.perMin * 60).toBeGreaterThanOrEqual(700);
    expect(result.forecast.perMin * 60).toBeLessThanOrEqual(870);
    expectWithinBand(result);
  });

  it("`/message` at half after a 429: the slowdown sets the rate", async () => {
    const state: RouteState = {
      version: ROUTE_STATE_VERSION,
      routes: {
        "messages.page": {
          holdUntil: null, ladderStep: 1, effectivePerMin: 7.5, policyVersion: null,
          last429AttemptId: 1, last429At: "2026-10-02T23:00:00.000Z", revision: 1,
        },
      },
    };
    const result = await forecastAndFact({ seed: 3, endless: [HISTORY, MEDIA], arrivals: BUSY_ARRIVALS, state, atMs: 20 * 60_000, endMs: 0 });
    expect(result.forecast.limitedBy).toBe("route");
    expectWithinBand(result);
  });

  it("a page busy with other work: the class's 4 turns of 10", async () => {
    const result = await forecastAndFact({
      seed: 4,
      endless: [HISTORY, MONEY, NOTIFY, MEDIA, STATS, POSTS],
      atMs: 20 * 60_000,
      endMs: 0,
    });
    expect(result.forecast.limitedBy).toBe("page");
    expect(result.forecast.slotShare).toBeCloseTo(0.4, 2);
    expectWithinBand(result);
  });

  it("a list walk had the messaging family to itself: beside the request it keeps its planned turn, 1 family send of 5", async () => {
    const atMs = 20 * 60_000;
    const result = await forecastAndFact({
      seed: 6,
      endless: [HISTORY, LIST],
      endlessFrom: new Map([[HISTORY, atMs]]),
      atMs,
      endMs: 0,
    });
    // The walk took the list's 12/min; the request gets 4 of the family's 5
    // turns (15 × 4/5), not the 3/min the walk left.
    expect(result.forecast).toMatchObject({ limitedBy: "family" });
    expect(result.forecast.perMin).toBeCloseTo(12, 1);
    expectWithinBand(result);
  });

  it("a request filed while a planned backlog had every slot: the backlog keeps 1 turn of 5, not what it took", async () => {
    const atMs = 20 * 60_000;
    const result = await forecastAndFact({
      seed: 5,
      endless: [HISTORY, MEDIA, STATS, POSTS],
      endlessFrom: new Map([[HISTORY, atMs]]),
      arrivals: [{ key: HEAD, perHour: 90 }],
      atMs,
      endMs: 0,
    });
    expect(result.forecast.limitedBy).toBe("family");
    expectWithinBand(result);
  });
});

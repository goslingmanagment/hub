import { describe, expect, it } from "vitest";

import type { SyncRouteSend } from "@agency_hub_core/db";
import type { FanslyWireId } from "@agency_hub_core/fansly";

import { ACTOR_IDLE_WAIT_MS } from "../apps/runtime/src/sync/engine/actor.ts";
import { createPacer, JITTER_MAX, type Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { Clock, Rng } from "../apps/runtime/src/sync/engine/ports.ts";
import {
  EMPTY_ROUTE_STATE,
  lookaheadInstants,
  routeExclusions,
  RouteClocks,
  type RouteKeySpec,
} from "../apps/runtime/src/sync/engine/route-policy.ts";
import { isPickWait, pick, type ClassWorkSource, type WorkClass } from "../apps/runtime/src/sync/engine/scheduler.ts";
import {
  FAMILY_BUDGETS,
  FANSLY_ROUTE_FAMILIES,
  FANSLY_ROUTE_FAMILY_IDS,
  familyOfRoute,
  intervalMsOf,
  routeBudget,
  routeOfWireId,
  type FanslyRoute,
} from "../apps/runtime/src/sync/fansly/routes.ts";

// The strict route admission under load (step 3b A1, owner decisions D1, D2,
// D4): the actor's slot loop — the real pacer on a simulated clock, the real
// 10-slot scheduler with its short look-ahead, the real route clocks and
// exclusions over the journal of what was sent — at the production numbers
// (S = 2.5 s, the budget table as shipped), hours at a time. Targets (A1):
// saturated history ≥ 800 reads/h with the messaging family at 15/min, media
// ≥ 200/h beside it, a single confirmation ≤ 10 s and a burst of four ≤ 25 s
// under that load (more is overload, D1), and every budget's §2b bound — at
// most ⌈W/T⌉ + 1 sends in any window W — with no pair of sends closer than S.
// The actor's own wiring of the same functions runs against a database in
// tests/sync-route-budgets.integration.test.ts.

const HOUR_MS = 3_600_000;

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

const HEAD: SimKey = { key: "dm-messages.head", workClass: "urgent", operations: ["messages.page"] };
const HISTORY: SimKey = { key: "dm-messages.history", workClass: "requests", operations: ["messages.page"] };
const MEDIA: SimKey = { key: "media-stats.walk", workClass: "planned", operations: ["media.offer_stats"] };
const LIST: SimKey = { key: "dm-conversations.head", workClass: "planned", operations: ["messaging.groups"] };
const FIND: SimKey = { key: "dm-conversations.find", workClass: "urgent", operations: ["messaging.groups", "group.detail"] };
const MONEY: SimKey = { key: "transactions.head", workClass: "urgent", operations: ["transactions.page"] };
const EARNINGS: SimKey = { key: "fan-earnings.roster", workClass: "planned", operations: ["earnings.stats_accounts", "earnings.monthly_accounts"] };
const POLLS: SimKey = { key: "stats.daily", workClass: "planned", operations: ["polls", "recapstats", "account.stats"] };

interface Item {
  key: SimKey;
  /** Simulated ms the item became due. */
  dueAt: number;
  /** The route its step plans (a multi-route key's choice). */
  plan: FanslyWireId;
}

interface Sent {
  at: number;
  route: FanslyRoute;
  key: string;
  workClass: WorkClass;
  latencyMs: number | null;
  settingMs: number;
}

interface SimInput {
  seed: number;
  hours: number;
  settingMs?: number;
  /** Endless work of these keys (a saturated class). */
  endless: SimKey[];
  /** Items that arrive (dueAt), each served once. */
  arrivals?: Item[];
  /** Response latency of each request, ms. */
  latencyMs?: (rng: Rng) => number;
  /** Restart the actor (a new pacer with its takeover floor) at these instants. */
  restarts?: number[];
  /** A multi-route key's planned route. */
  planOf?: (key: SimKey, rng: Rng) => FanslyWireId;
}

/** The actor's slot loop over in-memory queues: what `SyncActor.#lap` does
 *  between `waitForSlot` and the send, with the same scheduler and route
 *  functions. */
async function simulate(input: SimInput): Promise<{ sent: Sent[]; lookaheadWaits: number; deferrals: number; pending: Item[] }> {
  const clock = new SimClock();
  const rng = seeded(input.seed);
  const settingMs = input.settingMs ?? 2_500;
  const endMs = input.hours * HOUR_MS;
  const keys = [...new Map([...input.endless, ...(input.arrivals ?? []).map((item) => item.key)].map((key) => [key.key, key])).values()];
  const pending = [...(input.arrivals ?? [])].sort((a, b) => a.dueAt - b.dueAt);
  const restarts = [...(input.restarts ?? [])].sort((a, b) => a - b);
  const sent: Sent[] = [];
  const lastByRoute = new Map<FanslyRoute, number>();
  let cyclePos = 0;
  let lookaheadWaits = 0;
  let deferrals = 0;
  const deferredUntil = new Map<string, number>();
  const newPacer = (floorMs: number): Pacer => {
    const pacer = createPacer({ clock, rng, pause: { readSettingMs: async () => settingMs }, ownership: { alive: () => true } });
    pacer.initTakeover(floorMs);
    return pacer;
  };
  let pacer = newPacer(0);
  const latency = input.latencyMs ?? (() => 300);
  const signal = new AbortController().signal;

  while (clock.t < endMs) {
    if (restarts.length > 0 && clock.t >= restarts[0]!) {
      restarts.shift();
      // I5: the first send of the new owner waits 1.2 × S after the last one.
      const last = sent.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
      pacer = newPacer(Math.max(0, last + Math.ceil(1.2 * settingMs) - clock.t));
    }
    const grant = await pacer.waitForSlot(signal);
    const now = clock.t;
    const sends: SyncRouteSend[] = [...lastByRoute].map(([route, at]) => ({ journal: "engine", operation: route, lastAt: new Date(clock.epoch + at) }));
    const clocks = new RouteClocks({ sends, state: EMPTY_ROUTE_STATE });
    const nowDate = clock.wallNow();
    const due = (item: Item) => item.dueAt <= now && (deferredUntil.get(item.key.key + item.dueAt) ?? 0) <= now;
    const source: ClassWorkSource<Item> = {
      async pickInClass(workClass, _now, admissibleAt) {
        const closed = new Set(routeExclusions(keys, clocks, admissibleAt ?? nowDate));
        const queued = pending.find((item) => item.key.workClass === workClass && due(item) && !closed.has(item.key.key));
        if (queued !== undefined) return queued;
        const endless = input.endless.find((key) => key.workClass === workClass && !closed.has(key.key));
        return endless === undefined ? null : { key: endless, dueAt: now, plan: endless.operations[0]! };
      },
    };
    const lookahead = lookaheadInstants(keys, clocks, nowDate, new Date(nowDate.getTime() + grant.settingMs * (1 + JITTER_MAX)));
    const picked = await pick(source, { cyclePos, pausedAll: false, pausedRequests: false, holdUntil: null }, nowDate, lookahead);
    const nextArrival = pending.find((item) => item.dueAt > now)?.dueAt ?? Number.POSITIVE_INFINITY;
    if (picked !== null && isPickWait(picked)) {
      lookaheadWaits += 1;
      clock.t = Math.min(picked.waitUntil.getTime() - clock.epoch, nextArrival);
      continue;
    }
    if (picked === null) {
      clock.t = Math.min(now + ACTOR_IDLE_WAIT_MS, nextArrival);
      continue;
    }
    const item = picked.work;
    const plan = item.key.operations.length > 1 && input.planOf !== undefined ? input.planOf(item.key, rng) : item.plan;
    // The final check of the planned route.
    const route = routeOfWireId(plan);
    if (!clocks.admits(route, clock.wallNow())) {
      deferrals += 1;
      deferredUntil.set(item.key.key + item.dueAt, clocks.notBefore(route)!.getTime() - clock.epoch);
      continue;
    }
    const admission = pacer.arm(grant, sent.length + 1, clock.monoNow());
    expect(pacer.check(admission)).toBeNull();
    const sentAt = admission.sentMono!;
    clock.t += Math.max(1, latency(rng));
    pacer.complete(admission, { kind: "response", status: 200, headers: {}, bodyText: "{}", bodyBytes: 2, sendMark: "request_start" });
    lastByRoute.set(route, sentAt);
    cyclePos = picked.nextCyclePos;
    const index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
    sent.push({ at: sentAt, route, key: item.key.key, workClass: picked.workClass, latencyMs: index >= 0 ? sentAt - item.dueAt : null, settingMs });
  }
  return { sent, lookaheadWaits, deferrals, pending };
}

/** Every budget's strictness on the record: consecutive sends ≥ its interval
 *  apart, so any window W holds at most ⌈W/T⌉ + 1 of them (A1's §2b bound);
 *  and the page's pause between any two sends. */
function auditBudgets(sent: readonly Sent[]): void {
  const budgets: Array<{ name: string; routes: ReadonlySet<FanslyRoute>; intervalMs: number }> = [];
  for (const route of new Set(sent.map((send) => send.route))) {
    budgets.push({ name: route, routes: new Set([route]), intervalMs: intervalMsOf(routeBudget(route).currentPerMin) });
  }
  for (const family of FANSLY_ROUTE_FAMILY_IDS) {
    budgets.push({ name: `family:${family}`, routes: new Set(FANSLY_ROUTE_FAMILIES[family]), intervalMs: intervalMsOf(FAMILY_BUDGETS[family].currentPerMin) });
  }
  for (const budget of budgets) {
    const times = sent.filter((send) => budget.routes.has(send.route)).map((send) => send.at);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!, `${budget.name} gap ${i}`).toBeGreaterThanOrEqual(budget.intervalMs);
    }
    for (const windowMs of [budget.intervalMs, 60_000, 600_000, HOUR_MS]) {
      const bound = Math.ceil(windowMs / budget.intervalMs) + 1;
      let first = 0;
      for (let last = 0; last < times.length; last += 1) {
        while (times[last]! - times[first]! >= windowMs) first += 1;
        expect(last - first + 1, `${budget.name} in ${windowMs} ms`).toBeLessThanOrEqual(bound);
      }
    }
  }
  for (let i = 1; i < sent.length; i += 1) {
    expect(sent[i]!.at - sent[i - 1]!.at, `page gap ${i}`).toBeGreaterThanOrEqual(sent[i]!.settingMs);
  }
}

function perHour(sent: readonly Sent[], key: string, hours: number): number {
  return sent.filter((send) => send.key === key).length / hours;
}

describe("strict route budgets under saturated history (A1)", () => {
  it("history ≥ 800 reads/h at the messaging family's 15/min, media ≥ 200/h beside it (S = 2.5 s)", async () => {
    const hours = 3;
    const { sent, lookaheadWaits } = await simulate({ seed: 1, hours, endless: [HISTORY, MEDIA] });
    const history = perHour(sent, HISTORY.key, hours);
    const media = perHour(sent, MEDIA.key, hours);
    expect(history).toBeGreaterThanOrEqual(800);
    // Never above the family's 900/h, nor media above its 300/h.
    expect(history).toBeLessThanOrEqual(900);
    expect(media).toBeGreaterThanOrEqual(200);
    expect(media).toBeLessThanOrEqual(300);
    // The look-ahead is what keeps history above the greedy ≈ 655/h.
    expect(lookaheadWaits).toBeGreaterThan(0);
    auditBudgets(sent);
  });

  it("the same at the owner's 2.0 s pause", async () => {
    const hours = 2;
    const { sent } = await simulate({ seed: 2, hours, settingMs: 2_000, endless: [HISTORY, MEDIA] });
    expect(perHour(sent, HISTORY.key, hours)).toBeGreaterThanOrEqual(800);
    expect(perHour(sent, MEDIA.key, hours)).toBeGreaterThanOrEqual(200);
    auditBudgets(sent);
  });

  it("without the look-ahead's wait the history would lose its share: a greedy planned read pushes every /message a pause later", async () => {
    // The control: history alone runs at the family's full 15/min.
    const { sent } = await simulate({ seed: 3, hours: 1, endless: [HISTORY] });
    expect(perHour(sent, HISTORY.key, 1)).toBeGreaterThanOrEqual(880);
    auditBudgets(sent);
  });
});

describe("confirmations under history load (A1, D1)", () => {
  it("a single confirmation is sent ≤ 10 s after it is due (≈ 2.4 s typical: the family's 4 s and a pause)", async () => {
    const rng = seeded(11);
    const arrivals: Item[] = Array.from({ length: 80 }, (_, i) => ({
      key: HEAD,
      dueAt: 30_000 + i * 90_000 + Math.floor(rng.next() * 60_000),
      plan: "messages.page" as const,
    }));
    const { sent, pending } = await simulate({ seed: 12, hours: 2.1, endless: [HISTORY, MEDIA], arrivals });
    expect(pending).toEqual([]);
    const latencies = sent.filter((send) => send.key === HEAD.key).map((send) => send.latencyMs!);
    expect(latencies).toHaveLength(80);
    expect(Math.max(...latencies)).toBeLessThanOrEqual(10_000);
    expect(perHour(sent, HISTORY.key, 2.1)).toBeGreaterThanOrEqual(700);
    auditBudgets(sent);
  });

  it("a burst of four is confirmed ≤ 25 s after it is due on average, ≤ 30 s at any phase (more is overload, D1)", async () => {
    const rng = seeded(21);
    const bursts = 60;
    const arrivals: Item[] = [];
    for (let b = 0; b < bursts; b += 1) {
      const dueAt = 30_000 + b * 120_000 + Math.floor(rng.next() * 60_000);
      for (let k = 0; k < 4; k += 1) arrivals.push({ key: HEAD, dueAt, plan: "messages.page" });
    }
    const { sent, pending } = await simulate({ seed: 22, hours: 2.1, endless: [HISTORY, MEDIA], arrivals });
    expect(pending).toEqual([]);
    const heads = sent.filter((send) => send.key === HEAD.key);
    const lastOfBurst: number[] = [];
    for (let b = 0; b < bursts; b += 1) {
      const dueAt = arrivals[b * 4]!.dueAt;
      lastOfBurst.push(Math.max(...heads.filter((send) => send.at - send.latencyMs! === dueAt).map((send) => send.latencyMs!)));
    }
    expect(lastOfBurst).toHaveLength(bursts);
    // The burst's last confirmation alternates with history on the family's
    // 4 s: U R U R U R U ≈ 24 s after the first, which waits ≤ 4 s for the
    // family — ≈ 25 s on average, never past the confirmation SLO (30 s).
    expect(lastOfBurst.reduce((sum, ms) => sum + ms, 0) / bursts).toBeLessThanOrEqual(25_000);
    expect(Math.max(...lastOfBurst)).toBeLessThanOrEqual(30_000);
    auditBudgets(sent);
  });
});

describe("no budget is ever exceeded (property)", () => {
  it("random keys, routes, latencies, S and restarts: every budget's §2b bound and the pause hold", async () => {
    for (let seed = 100; seed < 106; seed += 1) {
      const rng = seeded(seed);
      const pool = [HEAD, FIND, MONEY, LIST, EARNINGS, POLLS];
      const arrivals: Item[] = Array.from({ length: 1_500 }, () => {
        const key = pool[Math.floor(rng.next() * pool.length)]!;
        return { key, dueAt: Math.floor(rng.next() * 2 * HOUR_MS), plan: key.operations[0]! };
      });
      const restarts = Array.from({ length: 6 }, () => Math.floor(rng.next() * 2 * HOUR_MS));
      const { sent, deferrals } = await simulate({
        seed,
        hours: 2,
        settingMs: 2_000 + Math.floor(rng.next() * 1_000),
        endless: [HISTORY, MEDIA],
        arrivals,
        restarts,
        latencyMs: (r) => 50 + r.next() * 1_500,
        // A multi-route key plans any of its routes: the final check catches
        // the one its budget keeps closed.
        planOf: (key, r) => key.operations[Math.floor(r.next() * key.operations.length)]!,
      });
      expect(sent.length).toBeGreaterThan(2_000);
      expect(deferrals).toBeGreaterThan(0);
      expect(new Set(sent.map((send) => familyOfRoute(send.route)))).toContain("earnings");
      auditBudgets(sent);
    }
  }, 120_000);
});

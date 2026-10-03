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
// under that load (more is overload, D1), a burst of new chats' `.find`s
// answered by one shared read of the list head ≤ 12 s (plan PR 1-3), and
// every budget's §2b bound — at most ⌈W/T⌉ + 1 sends in any window W — with
// no pair of sends closer than S. The actor's own wiring of the same
// functions runs against a database in tests/sync-route-budgets.integration.test.ts
// and, for `.find`'s shared read, tests/sync-resources-dm-list.integration.test.ts.

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
  /** A `.find` of a burst (`dm-conversations.find`): whether the list head
   *  shows its chat, and — once a head read did not — its detail next. */
  find?: { burst: number; onHead: boolean; detail: boolean };
}

/** How a `.find` closed: by its own list read, by the shared read of another
 *  (before the gate, no slot), or by its group detail. */
interface FindClosure {
  burst: number;
  onHead: boolean;
  dueAt: number;
  closedAt: number;
  how: "own_list" | "shared" | "detail";
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
  /** False: every `.find` reads the list head itself (the control). */
  shareListHead?: boolean;
}

/** The confirmation of a chat a `.find` found: urgent, due after its
 *  coalescing quiet window (5 s). */
const FOUND_CHAT_HEAD_QUIET_MS = 5_000;

/** The actor's slot loop over in-memory queues: what `SyncActor.#lap` does
 *  between `waitForSlot` and the send, with the same scheduler and route
 *  functions — and, for `.find`, its shared list-head read: before the gate,
 *  a find whose chat a list head read applied since it was due wrote closes
 *  with no slot; one a head read admitted since did not show reads its
 *  detail. */
async function simulate(input: SimInput): Promise<{ sent: Sent[]; lookaheadWaits: number; deferrals: number; pending: Item[]; finds: FindClosure[] }> {
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
  /** The applied list head reads: admitted (sent) and applied. */
  const listReads: Array<{ admittedAt: number; appliedAt: number }> = [];
  const finds: FindClosure[] = [];
  const closeFind = (item: Item, closedAt: number, how: FindClosure["how"]) => {
    finds.push({ burst: item.find!.burst, onHead: item.find!.onHead, dueAt: item.dueAt, closedAt, how });
    pending.splice(pending.indexOf(item), 1);
  };
  /** A found chat's message is read urgently (the read's apply asks it). */
  const confirm = (at: number) => {
    const head: Item = { key: HEAD, dueAt: at + FOUND_CHAT_HEAD_QUIET_MS, plan: "messages.page" };
    const index = pending.findIndex((item) => item.dueAt > head.dueAt);
    pending.splice(index < 0 ? pending.length : index, 0, head);
  };

  while (clock.t < endMs) {
    if (restarts.length > 0 && clock.t >= restarts[0]!) {
      restarts.shift();
      // I5: the first send of the new owner waits 1.2 × S after the last one.
      const last = sent.at(-1)?.at ?? Number.NEGATIVE_INFINITY;
      pacer = newPacer(Math.max(0, last + Math.ceil(1.2 * settingMs) - clock.t));
    }
    // Before the gate (ruling 9): a due `.find` whose chat a list head read
    // applied since it was due wrote is found; one a head read admitted since
    // did not show reads its detail next.
    const sharedFinds = input.shareListHead === false ? [] : pending.filter((candidate) => candidate.find !== undefined && candidate.dueAt <= clock.t);
    for (const item of sharedFinds) {
      const applied = listReads.filter((read) => read.appliedAt <= clock.t);
      if (item.find!.onHead && applied.some((read) => read.appliedAt >= item.dueAt)) closeFind(item, clock.t, "shared");
      else if (!item.find!.onHead && applied.some((read) => read.admittedAt >= item.dueAt)) item.find!.detail = true;
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
    const plan = item.find !== undefined
      ? (item.find.detail ? "group.detail" : "messaging.groups")
      : item.key.operations.length > 1 && input.planOf !== undefined ? input.planOf(item.key, rng) : item.plan;
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
    sent.push({ at: sentAt, route, key: item.key.key, workClass: picked.workClass, latencyMs: index >= 0 ? sentAt - item.dueAt : null, settingMs });
    if (item.find !== undefined) {
      if (plan === "group.detail") {
        closeFind(item, clock.t, "detail");
        confirm(clock.t);
        continue;
      }
      // The find's own read of the list head: applied now, it writes every
      // chat on the head, so it answers every find open by then — and asks
      // each found chat's read.
      listReads.push({ admittedAt: sentAt, appliedAt: clock.t });
      const found = input.shareListHead === false
        ? (item.find.onHead ? 1 : 0)
        : pending.filter((candidate) => candidate.find?.onHead === true && candidate.dueAt <= clock.t).length;
      for (let k = 0; k < found; k += 1) confirm(clock.t);
      if (item.find.onHead) closeFind(item, clock.t, "own_list");
      else item.find.detail = true;
      continue;
    }
    if (index >= 0) pending.splice(index, 1);
  }
  return { sent, lookaheadWaits, deferrals, pending, finds };
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

describe("a burst of new chats' .find shares one list head read (plan PR 1-3, A1)", () => {
  /** `bursts` bursts of `size` new chats each, their frames together; the
   *  first `hidden` of each are not on the list head. (A frame that comes
   *  after a list read wrote its chat is no `.find`: the router knows the
   *  chat then.) Bursts at least `size` × 10 s apart: the burst before has
   *  had its chats confirmed (each one `/message` read in the urgent turns of
   *  the family under history, ≈ 8 s) — confirmations still queued are
   *  urgent work ahead of the next burst (overload, D1). */
  function findBursts(seed: number, bursts: number, size: number, hidden = 0): Item[] {
    const rng = seeded(seed);
    const everyMs = Math.max(120_000, size * 10_000 + 60_000);
    const arrivals: Item[] = [];
    for (let b = 0; b < bursts; b += 1) {
      const dueAt = 30_000 + b * everyMs + Math.floor(rng.next() * 60_000);
      for (let k = 0; k < size; k += 1) {
        arrivals.push({ key: FIND, dueAt, plan: "messaging.groups", find: { burst: b, onHead: k >= hidden, detail: false } });
      }
    }
    return arrivals;
  }

  function byBurst(finds: readonly FindClosure[]): Map<number, FindClosure[]> {
    const bursts = new Map<number, FindClosure[]>();
    for (const find of finds) bursts.set(find.burst, [...(bursts.get(find.burst) ?? []), find]);
    return bursts;
  }

  /** The messaging family's sends an hour: saturated, whatever its keys. */
  function familyPerHour(sent: readonly Sent[], hours: number): number {
    return sent.filter((send) => familyOfRoute(send.route) === "messaging").length / hours;
  }

  for (const size of [2, 6, 14]) {
    it(`${size} chats on the head at once, under saturated history and media: every find ≤ 12 s, one list read a burst, no detail (S = 2.5 s)`, async () => {
      const bursts = size >= 14 ? 30 : 60;
      const hours = size >= 14 ? 2.8 : 2.1;
      const { sent, pending, finds } = await simulate({ seed: 30 + size, hours, endless: [HISTORY, MEDIA], arrivals: findBursts(31 + size, bursts, size) });
      expect(pending.filter((item) => item.find !== undefined)).toEqual([]);
      expect(finds).toHaveLength(bursts * size);
      for (const [burst, closed] of byBurst(finds)) {
        expect(Math.max(...closed.map((find) => find.closedAt - find.dueAt)), `burst ${burst}`).toBeLessThanOrEqual(12_000);
        // One find read the list; the rest of its burst closed with no slot.
        expect(closed.filter((find) => find.how === "own_list"), `burst ${burst}`).toHaveLength(1);
        expect(closed.filter((find) => find.how === "shared"), `burst ${burst}`).toHaveLength(size - 1);
      }
      const findSends = sent.filter((send) => send.key === FIND.key);
      expect(findSends.map((send) => send.route)).toEqual(Array.from({ length: bursts }, () => "messaging.groups"));
      // The found chats' confirmations went out too, history taking the rest
      // of the family's budget: the family stays saturated.
      expect(sent.filter((send) => send.key === HEAD.key)).toHaveLength(bursts * size);
      expect(familyPerHour(sent, hours)).toBeGreaterThanOrEqual(800);
      auditBudgets(sent);
    });
  }

  it("without the shared read a burst of six would miss the 12 s: one list read each, 5 s apart (the control)", async () => {
    const bursts = 30;
    const { finds } = await simulate({ seed: 36, hours: 1.1, endless: [HISTORY, MEDIA], arrivals: findBursts(37, bursts, 6), shareListHead: false });
    expect(finds.every((find) => find.how === "own_list")).toBe(true);
    for (const [burst, closed] of byBurst(finds)) {
      expect(Math.max(...closed.map((find) => find.closedAt - find.dueAt)), `burst ${burst}`).toBeGreaterThan(25_000);
    }
  });

  it("chats a head read did not show go to their detail, one each at the messaging family's pace (D1: overload past ≈ 2)", async () => {
    const bursts = 60;
    const { sent, pending, finds } = await simulate({ seed: 41, hours: 2.1, endless: [HISTORY, MEDIA], arrivals: findBursts(42, bursts, 6, 2) });
    expect(pending.filter((item) => item.find !== undefined)).toEqual([]);
    for (const [burst, closed] of byBurst(finds)) {
      const onHead = closed.filter((find) => find.onHead);
      const hidden = closed.filter((find) => !find.onHead);
      expect(Math.max(...onHead.map((find) => find.closedAt - find.dueAt)), `burst ${burst}`).toBeLessThanOrEqual(12_000);
      expect(hidden.map((find) => find.how), `burst ${burst}`).toEqual(["detail", "detail"]);
      // Each detail is one more read of the messaging family (4 s) in the
      // urgent class's turns, beside the found chats' confirmations: the
      // second ≈ 14 s after its chat was due on average, 22 s at worst.
      expect(Math.max(...hidden.map((find) => find.closedAt - find.dueAt)), `burst ${burst}`).toBeLessThanOrEqual(25_000);
    }
    const findSends = sent.filter((send) => send.key === FIND.key);
    expect(findSends.filter((send) => send.route === "messaging.groups")).toHaveLength(bursts);
    expect(findSends.filter((send) => send.route === "group.detail")).toHaveLength(2 * bursts);
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

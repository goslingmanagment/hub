// The criteria of plan §5, stage 2 ("Критерии на каждый сбой"), as checks a
// machine runs over a run's evidence:
//
//   the stand's journal  — what physically reached the stand's Fansly
//   the engine's grants  — every admission it gave, with its deadline
//   the capture          — what left the page container at the OS level
//   the stand's Postgres — what the engine committed
//
// Each check returns its violations (empty: it held) and is pure, so a unit
// test can show that it does fail on a violation (tests/page-browser-stand.test.ts),
// as the control scenarios show it on the stand.

import { atLeast, type Step } from "../../src/state/steps.ts";
import type { JournalEvent } from "../fansly/journal.ts";
import type { Grant } from "./engine.ts";
import type { OutcomeRow } from "./store.ts";

/** Plan §4.6 — on stage 1 the only writes that may go are the login's
 *  (spec §2.4); every other write is closed for now (owner decision №2). */
export const LOGIN_PATHS: readonly string[] = ["/api/v1/login", "/api/v1/login/twofa"];
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Forwarding between the operator's proxy (the sender) and the stand. */
export const ARRIVAL_SLACK_MS = 50;

/** The stand's pages by the address they come from at the SOCKS5. */
export type PagesByAddress = ReadonlyMap<string, string>;

/** What each admission was used for so far. A series keeps one over all its
 *  runs: an admission used in one run is not there again for the next —
 *  its window (15 s) outlasts a short run. */
export type GrantUse = Map<Grant, { preflight: number; main: number }>;

/** No API request and no socket reached Fansly without an admission in
 *  force — its own: the page's, for that address, inside its window. And one
 *  admission is one operation: one request and at most one preflight
 *  (owner decision №1), or one socket — a second arrival under it is a
 *  repeat, whatever came first. An arrival that is no page's (it did not come
 *  from a page's address) has no admission at all. */
export function unadmittedArrivals(events: readonly JournalEvent[], grants: readonly Grant[], pages: PagesByAddress, slackMs = ARRIVAL_SLACK_MS, used: GrantUse = new Map()): string[] {
  const violations: string[] = [];
  const inWindow = (grant: Grant, event: JournalEvent) => event.mono >= grant.grantedMono && event.mono <= grant.deadlineMono + slackMs;
  for (const event of events) {
    const api = event.type === "req" && event.role === "api";
    if (!api && event.type !== "ws.open") continue;
    const page = pages.get(String(event.from ?? ""));
    const what = api ? `${String(event.method)} ${String(event.host)}${String(event.path)}` : `a socket (${String(event.wsId)}, ${String(event.url)})`;
    if (page === undefined) {
      violations.push(`${what} arrived without any admission: it came from ${String(event.from ?? "?")}, which is no page of the stand`);
      continue;
    }
    const target = api ? `${String(event.host)}${String(event.path)}` : String(event.url);
    const own = grants.filter((grant) => grant.page === page && (api ? grant.kind === "hub" || grant.kind === "site" : grant.kind === "ws") && grant.target === target);
    if (own.length === 0) {
      violations.push(`${what} arrived without any admission of ${page} for it`);
      continue;
    }
    const live = own.filter((grant) => inWindow(grant, event));
    if (live.length === 0) {
      violations.push(`${what} arrived outside its admission window (ms after the deadline: ${own.map((grant) => Math.round(event.mono - grant.deadlineMono)).join(", ")})`);
      continue;
    }
    const method = String(event.method ?? "");
    const role = api && method === "OPTIONS" ? "preflight" : "main";
    const grant = live.find((candidate) => (!api || role === "preflight" || candidate.method === null || candidate.method === method) && (used.get(candidate)?.[role] ?? 0) === 0);
    if (!grant) {
      violations.push(`${what} arrived again under one admission: a repeat`);
      continue;
    }
    const count = used.get(grant) ?? { preflight: 0, main: 0 };
    count[role] += 1;
    used.set(grant, count);
  }
  return violations;
}

/** No write reached Fansly but the login's (plan §4.6; decision №2). */
export function closedWrites(events: readonly JournalEvent[]): string[] {
  return events
    .filter((event) => event.type === "req" && event.role === "api" && WRITES.has(String(event.method)) && !LOGIN_PATHS.includes(String(event.pathname)))
    .map((event) => `a closed write reached Fansly: ${String(event.method)} ${String(event.host)}${String(event.pathname)}`);
}

/** Spec §2.6: the authorization and the ping, nothing else, ever left in
 *  the site's socket. */
export function forbiddenSocketMessages(events: readonly JournalEvent[]): string[] {
  const violations: string[] = [];
  for (const event of events) {
    if (event.type !== "ws.in") continue;
    const text = String(event.text ?? "");
    if (event.binary === true) {
      violations.push(`a binary socket message reached Fansly (${String(event.bytes)} bytes)`);
      continue;
    }
    if (text === "p") continue;
    let authorization = false;
    try {
      const outer = JSON.parse(text) as { t?: unknown; d?: unknown };
      if (outer.t === 1 && typeof outer.d === "string") {
        const inner = JSON.parse(outer.d) as Record<string, unknown>;
        authorization = Object.keys(inner).sort().join(",") === "token,v" && typeof inner.token === "string" && inner.v === 3;
      }
    } catch {
      authorization = false;
    }
    if (!authorization) violations.push(`a forbidden socket message reached Fansly: ${text.slice(0, 80)}`);
  }
  return violations;
}

/** Nothing came to the stand's direct listener: the page container has no
 *  way there but past its proxy. */
export function directArrivals(events: readonly JournalEvent[]): string[] {
  return events.filter((event) => event.type === "direct.connect").map((event) => `a connection past the proxy reached the stand directly from ${String(event.from)}`);
}

export interface WaitingRequest {
  page: string;
  method: string;
  /** host + path + query, as the operator asked its admission for. */
  target: string;
}

/** No request of the browser that was waiting when the proxy failed went
 *  after it came back (plan §4.5): cancelled then, it stays cancelled —
 *  whatever admission it may be given afterwards. `waiting` is what waited
 *  right before the failure: asked an admission and not given one, or
 *  admitted and not ended. */
export function sentAfterRecovery(events: readonly JournalEvent[], waiting: readonly WaitingRequest[], pages: PagesByAddress, recoveredMono: number): string[] {
  return events
    .filter((event) => event.type === "req" && event.role === "api" && event.mono >= recoveredMono)
    .filter((event) => waiting.some((request) => request.page === pages.get(String(event.from ?? "")) && request.target === `${String(event.host)}${String(event.path)}`))
    .map((event) => `${String(event.method)} ${String(event.host)}${String(event.path)} waited when the proxy failed and went after it came back`);
}

export interface Resolution {
  attemptId: number;
  /** The committed outcome rows of the attempt (more than one: a duplicate). */
  outcomes: OutcomeRow[];
  /** What a recover said of it, if one was asked. */
  recovered: "outcome_resent" | "not_sent" | "unknown" | null;
  /** Its request reached the stand (by its rid). */
  arrived: boolean;
}

/** Every attempt the engine issued is resolved exactly once: one committed
 *  outcome, or a recover's answer; and "not sent" is said only of a request
 *  that never reached Fansly. */
export function exactlyOnce(resolutions: readonly Resolution[]): string[] {
  const violations: string[] = [];
  for (const resolution of resolutions) {
    const id = resolution.attemptId;
    if (resolution.outcomes.length > 1) violations.push(`attempt ${id}: committed ${resolution.outcomes.length} times`);
    if (resolution.outcomes.length === 0 && resolution.recovered === null) violations.push(`attempt ${id}: no outcome and no recover answer`);
    if (resolution.outcomes.length === 0 && resolution.recovered === "outcome_resent") violations.push(`attempt ${id}: recover said its outcome was resent, and none was committed`);
    const saidNotSent = resolution.recovered === "not_sent" || resolution.outcomes.some((outcome) => outcome.sent === false);
    if (saidNotSent && resolution.arrived) violations.push(`attempt ${id}: said not sent, and its request reached Fansly`);
  }
  return violations;
}

export interface BufferBounds {
  bufferId: string;
  /** The last number the engine had committed when the run began (0: none
   *  — a buffer that is new to the engine starts at 1). */
  start: number;
  /** The highest number the operator sent during the run, as the engine saw
   *  it on the wire — recorded apart from what was stored. */
  wireMax: number;
  /** The numbers in the stand's Postgres. */
  stored: readonly number[];
}

/** No event was deleted before the engine committed it: every number from
 *  the run's start bound to its end bound is stored — the head of a new
 *  buffer, the middle, and the tail the operator sent last. The bounds are
 *  recorded apart from the store (the position before the run; what came on
 *  the wire), so a tail that was acknowledged and never stored shows. */
export function eventsComplete(buffers: readonly BufferBounds[]): string[] {
  const violations: string[] = [];
  for (const { bufferId, start, wireMax, stored } of buffers) {
    const have = new Set(stored);
    const end = Math.max(wireMax, ...stored.filter((seq) => seq > start), start);
    let from: number | null = null;
    for (let seq = start + 1; seq <= end + 1; seq++) {
      const missing = seq <= end && !have.has(seq);
      if (missing && from === null) from = seq;
      if (!missing && from !== null) {
        violations.push(`buffer ${bufferId}: events ${from}…${seq - 1} were never committed${seq - 1 === end ? " (the tail the operator sent last)" : from === 1 ? " (the start of the buffer)" : ""}`);
        from = null;
      }
    }
  }
  return violations;
}

export interface SeenTransition {
  atMono: number;
  exitOpen: boolean;
  step: Step;
  stopReason: string | null;
  retryAtWall: number | null;
}

/** The exit was seen closed within `boundMs` of the fault (or the engine's
 *  connection to the operator dropped — the exit dies with the operator). */
export function exitClosedWithin(states: readonly SeenTransition[], linkDowns: readonly number[], faultMono: number, boundMs: number): string[] {
  const closed = states.find((state) => state.atMono >= faultMono && !state.exitOpen);
  const down = linkDowns.filter((at) => at >= faultMono);
  const at = Math.min(closed?.atMono ?? Infinity, ...down);
  if (at === Infinity) return [`the exit was never seen closed after the fault`];
  if (at - faultMono > boundMs) return [`the exit was seen closed ${Math.round(at - faultMono)} ms after the fault (bound ${boundMs} ms)`];
  return [];
}

/** The page came back up (exit open) after `fromMono` within `boundMs`. */
export function upWithin(states: readonly SeenTransition[], fromMono: number, boundMs: number, what: string): string[] {
  const up = states.find((state) => state.atMono >= fromMono && state.exitOpen && atLeast(state.step, "exit_open"));
  if (!up) return [`${what}: the page did not come back up`];
  if (up.atMono - fromMono > boundMs) return [`${what}: the page came back up ${Math.round(up.atMono - fromMono)} ms later (bound ${boundMs} ms)`];
  return [];
}

/** The page did not open its exit between `fromMono` and `toMono` — it
 *  stands until the engine starts it. */
export function stoodBetween(states: readonly SeenTransition[], fromMono: number, toMono: number, what: string): string[] {
  const opened = states.find((state) => state.atMono >= fromMono && state.atMono <= toMono && state.exitOpen);
  return opened ? [`${what}: the page opened its exit by itself ${Math.round(opened.atMono - fromMono)} ms after it should stand`] : [];
}

/** The stop the scenario causes was the one the operator named. */
export function stoppedFor(states: readonly SeenTransition[], fromMono: number, reasons: readonly string[], halted: boolean | null): string[] {
  const stop = states.find((state) => state.atMono >= fromMono && state.stopReason !== null);
  if (!stop) return [`no stop reason was seen (expected ${reasons.join(" or ")})`];
  const violations: string[] = [];
  if (!reasons.includes(stop.stopReason!)) violations.push(`the page stopped for ${stop.stopReason!}, expected ${reasons.join(" or ")}`);
  if (halted !== null && (stop.retryAtWall === null) !== halted) violations.push(halted ? `the stop (${stop.stopReason!}) was a failure with a retry, expected a halt` : `the stop (${stop.stopReason!}) was a halt, expected a failure with a retry`);
  return violations;
}

/** A gap of the reason was committed after `fromMono`. */
export function gapCommitted(gaps: ReadonlyArray<{ reason: string | null; committedMono: number }>, fromMono: number, reason: string): string[] {
  return gaps.some((gap) => gap.reason === reason && gap.committedMono >= fromMono) ? [] : [`no "${reason}" gap was committed after the fault`];
}

// ── evidence that a run met what it is about ──────────────────────────────
// A scenario that needs the site (PR 7) must show that the thing it tests
// happened in the run; without it the run proves nothing, and fails.

/** The browser has the page variant the run configured: its hello came from
 *  the page's address after `sinceMono`. */
export function variantLoaded(events: readonly JournalEvent[], pageAddress: string, variant: string, sinceMono: number): string[] {
  const hellos = events.filter((event) => event.type === "req" && event.role === "site" && event.pathname === "/stand/hello" && event.from === pageAddress && event.mono >= sinceMono);
  const last = hellos.at(-1);
  if (!last) return [`the site's page did not load after it was configured (no hello from ${pageAddress})`];
  const loaded = /[?&]variant=([^&]+)/.exec(String(last.path))?.[1] ?? "?";
  return loaded === variant ? [] : [`the browser runs page variant ${loaded}, the run configured ${variant}`];
}

/** The site did try a closed write, and the browser cancelled it: the
 *  page's own report of how its write ended. */
export function closedWriteAttempted(events: readonly JournalEvent[], pageAddress: string): string[] {
  const reports = events.filter((event) => event.type === "req" && event.role === "site" && event.pathname === "/stand/report" && event.from === pageAddress).map((event) => /[?&]what=([^&]+)/.exec(String(event.path))?.[1] ?? "");
  const violations: string[] = [];
  if (!reports.includes("write-failed")) violations.push("the site attempted no closed write in the run (no write-failed report): the run proves nothing about the closure");
  const done = reports.filter((what) => what === "write-done").length;
  if (done > 0) violations.push(`${done} closed write(s) got an answer: the page says they went through`);
  return violations;
}

/** An admission ran out while its connection was held: a CONNECT of the API
 *  host from the page began inside an admission's window and was let go
 *  only after its deadline. */
export function heldPastDeadline(events: readonly JournalEvent[], grants: readonly Grant[], page: string, pageAddress: string, apiHost: string): string[] {
  const holds = events.filter((event) => event.type === "socks.hold" && event.host === apiHost && event.from === pageAddress);
  const releases = new Map(events.filter((event) => event.type === "socks.release").map((event) => [Number(event.socksId), event.mono]));
  const found = holds.some((hold) => {
    const released = releases.get(Number(hold.socksId));
    return released !== undefined && grants.some((grant) => grant.page === page && grant.kind !== "ws" && hold.mono >= grant.grantedMono && hold.mono <= grant.deadlineMono && released > grant.deadlineMono);
  });
  return found ? [] : [`no admission of ${page} ran out while its CONNECT was held (${holds.length} held): the run proves nothing about the deadline`];
}

/** A request was in flight when the engine restarted: one of `rids` had
 *  reached Fansly before `restartMono`, and its answer was not written yet. */
export function inFlightAtRestart(events: readonly JournalEvent[], rids: readonly string[], restartMono: number): string[] {
  const arrived = events.filter((event) => event.type === "req" && event.role === "api" && event.method !== "OPTIONS" && typeof event.rid === "string" && rids.includes(event.rid) && event.mono < restartMono);
  const answered = new Map(events.filter((event) => event.type === "res").map((event) => [Number(event.req), event.mono]));
  const inFlight = arrived.filter((event) => (answered.get(event.seq) ?? Infinity) > restartMono);
  return inFlight.length > 0 ? [] : [`no request was in flight at the engine's restart (${arrived.length} of ${rids.length} had arrived, none still unanswered): the run proves nothing about recovery after a send`];
}

// ── the load test's thresholds (spec §4) ──────────────────────────────────
// A threshold holds only on a measured load: with nothing to measure it is
// "not measured" (null), never held.

export interface RatePhase {
  what: string;
  fromMono: number;
  toMono: number;
  /** Frames per minute each page must get in the phase. */
  perMinute: number;
}

export interface RateFinding {
  page: string;
  phase: string;
  perMinute: number;
  target: number;
}

/** Threshold 3: every page got its socket frames at the rate asked, in the
 *  background and in each burst — measured on what the stand pushed to that
 *  page, not on one frame somewhere. */
export function frameRates(pushed: ReadonlyArray<{ mono: number; page: string | undefined }>, pages: readonly string[], phases: readonly RatePhase[], tolerance = 0.95): { held: boolean | null; rates: RateFinding[]; why: string | null } {
  if (pushed.length === 0) return { held: null, rates: [], why: "no frame was pushed: no site socket was open (PR 7)" };
  const rates: RateFinding[] = [];
  for (const page of pages) {
    for (const phase of phases) {
      const minutes = (phase.toMono - phase.fromMono) / 60_000;
      if (minutes <= 0) continue;
      const count = pushed.filter((frame) => frame.page === page && frame.mono >= phase.fromMono && frame.mono < phase.toMono).length;
      rates.push({ page, phase: phase.what, perMinute: Math.round((count / minutes) * 10) / 10, target: phase.perMinute });
    }
  }
  const low = rates.filter((rate) => rate.perMinute < rate.target * tolerance);
  return { held: low.length === 0 && rates.length > 0, rates, why: low.length === 0 ? null : `below the asked rate: ${low.map((rate) => `${rate.page} ${rate.phase} ${rate.perMinute}/min of ${rate.target}`).join("; ")}` };
}

/** Threshold 7: events did pile up while the engine was away — on every
 *  page — and every one of them is stored afterwards, once. An outage in
 *  which nothing accumulated shows nothing about the offload. */
export function outageBacklog(pushedDuringOutage: ReadonlyMap<string, readonly number[]>, pages: readonly string[], stored: ReadonlySet<number>, duplicates: number): { held: boolean | null; why: string | null; backlog: Record<string, number>; lost: number } {
  const backlog = Object.fromEntries(pages.map((page) => [page, pushedDuringOutage.get(page)?.length ?? 0]));
  const empty = pages.filter((page) => backlog[page] === 0);
  const lost = pages.flatMap((page) => pushedDuringOutage.get(page) ?? []).filter((frame) => !stored.has(frame)).length;
  if (empty.length > 0) return { held: null, why: `nothing accumulated during the outage on ${empty.join(", ")}: the offload was not measured`, backlog, lost };
  if (lost > 0 || duplicates > 0) return { held: false, why: `${lost} event(s) of the outage were never stored, ${duplicates} stored more than once`, backlog, lost };
  return { held: true, why: null, backlog, lost };
}

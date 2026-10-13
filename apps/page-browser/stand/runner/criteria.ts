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

function samePlace(target: string | null, host: string, path: string): boolean {
  return target !== null && target === `${host}${path}`;
}

/** No API request and no socket reached Fansly without an admission in
 *  force — and one admission is one operation: one request and at most one
 *  preflight (owner decision №1). */
export function unadmittedArrivals(events: readonly JournalEvent[], grants: readonly Grant[], slackMs = ARRIVAL_SLACK_MS): string[] {
  const violations: string[] = [];
  const used = new Map<Grant, { preflight: number; main: number }>();
  for (const event of events) {
    if (event.type === "req" && event.role === "api") {
      const host = String(event.host);
      const path = String(event.path);
      const method = String(event.method);
      const what = `${method} ${host}${path}`;
      const own = grants.filter((grant) => (grant.kind === "hub" || grant.kind === "site") && samePlace(grant.target, host, path));
      if (own.length === 0) {
        violations.push(`${what} arrived without any admission`);
        continue;
      }
      const inWindow = own.filter((grant) => event.mono >= grant.grantedMono && event.mono <= grant.deadlineMono + slackMs);
      if (inWindow.length === 0) {
        violations.push(`${what} arrived outside its admission window (ms after the deadline: ${own.map((grant) => Math.round(event.mono - grant.deadlineMono)).join(", ")})`);
        continue;
      }
      const role = method === "OPTIONS" ? "preflight" : "main";
      const grant = inWindow.find((candidate) => (role === "preflight" || candidate.method === null || candidate.method === method) && (used.get(candidate)?.[role] ?? 0) === 0);
      if (!grant) {
        violations.push(`${what} arrived again under one admission: a repeat`);
        continue;
      }
      const count = used.get(grant) ?? { preflight: 0, main: 0 };
      count[role] += 1;
      used.set(grant, count);
    }
    if (event.type === "ws.open") {
      const inWindow = grants.filter((grant) => grant.kind === "ws" && event.mono >= grant.grantedMono && event.mono <= grant.deadlineMono + slackMs);
      if (inWindow.length === 0) violations.push(`a socket opened (${String(event.wsId)}) without an admission in force`);
    }
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

/** No request of the browser that was waiting when the proxy failed went
 *  after it came back (plan §4.5): a grant given before the fault is never
 *  used after the recovery. */
export function sentAfterRecovery(events: readonly JournalEvent[], grants: readonly Grant[], faultMono: number, recoveredMono: number): string[] {
  const before = grants.filter((grant) => grant.grantedMono < faultMono && (grant.kind === "site" || grant.kind === "hub"));
  return events
    .filter((event) => event.type === "req" && event.role === "api" && event.mono >= recoveredMono)
    .filter((event) => before.some((grant) => samePlace(grant.target, String(event.host), String(event.path))))
    .map((event) => `${String(event.method)} ${String(event.host)}${String(event.path)} was admitted before the proxy failed and went after it came back`);
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

/** The numbers each buffer gave the engine have no holes: no event was
 *  deleted before the engine committed it. */
export function contiguous(seqsByBuffer: ReadonlyMap<string, readonly number[]>): string[] {
  const violations: string[] = [];
  for (const [bufferId, seqs] of seqsByBuffer) {
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i]! !== seqs[i - 1]! + 1) violations.push(`buffer ${bufferId}: events ${seqs[i - 1]! + 1}…${seqs[i]! - 1} were never committed`);
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

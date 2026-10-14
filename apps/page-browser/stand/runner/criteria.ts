// The criteria of plan §5, stage 2 ("Критерии на каждый сбой"), as checks a
// machine runs over a run's evidence:
//
//   the stand's journal  — what physically reached the stand's Fansly,
//                          and what it made: the frames it sent, the
//                          requests it answered
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
import type { Planted } from "./verdict.ts";

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

/** The host a socket's address names (null: not an address). */
function socketHost(url: string | null): string | null {
  try {
    return new URL(url ?? "").host;
  } catch {
    return null;
  }
}

/** No API request and no socket reached Fansly without an admission in
 *  force — its own: the page's, for that address, inside its window. And one
 *  admission is one operation: one request and at most one preflight
 *  (owner decision №1), or one socket — a second arrival under it is a
 *  repeat, whatever came first. An arrival that is no page's (it did not come
 *  from a page's address) has no admission at all. A socket's admission is
 *  one socket of its host: the address `wsAdmit` names is a label — CDP's
 *  word on the oldest socket of the host still waiting, or the host alone
 *  when CDP has said nothing yet (src/rpc/protocol.ts, PR 10; ws/sockets.ts)
 *  — and the operator binds the socket to its admission at its handshake. */
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
    const own = grants.filter((grant) => grant.page === page && (api ? (grant.kind === "hub" || grant.kind === "site") && grant.target === target : grant.kind === "ws" && socketHost(grant.target) !== null && socketHost(grant.target) === socketHost(target)));
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
    .map((event) => `a closed write reached Fansly: ${String(event.method)} ${String(event.host)}${String(event.pathname)}${typeof event.rid === "string" ? ` (rid ${event.rid})` : ""}`);
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
  /** Where the page's engine stood when the run began: the last number any
   *  of its engines had committed or acknowledged (0: none — a buffer that
   *  is new to the engine starts at 1). Below it the operator had deleted
   *  everything before the run: what an earlier run lost, that run showed. */
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
 *  the wire), so a tail that was acknowledged and never stored shows. What
 *  never came on the wire has no number here: `madeAndKept` below is the
 *  other half of C7. */
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

// ── C7's other half: what Fansly made against what the engine keeps ───────
// The numbers above are the operator's own word: an event it never sent
// leaves no number to miss. The stand's Fansly keeps its own record of what
// it made — every frame it sent into a page's socket, by the frame's number,
// and every request it answered — and each of them must be kept by the
// engine, or lie inside a gap mark the engine committed: not just be absent.

/** The request id in a target or a query (`rid=…`). */
export function ridIn(target: string | null): string | null {
  return /(?:^|[?&])rid=([^&]+)/.exec(target ?? "")?.[1] ?? null;
}

export interface MadeFrame {
  page: string;
  wsId: string;
  /** The frame's own number, in its payload (`standFrame`). */
  frame: number;
  mono: number;
  wall: number;
}

export interface MadeAnswer {
  page: string;
  method: string;
  /** host + path + query. */
  target: string;
  status: number;
  mono: number;
  wall: number;
  /** The engine's attempt it was admitted as; null: none. */
  attemptId: number | null;
  /** What admitted it: Hub's own request, or the site's (whose answer is
   *  an event of the stream as well); null: no admission of the engine's. */
  kind: "hub" | "site" | null;
  /** Its request id (`rid` in its query). */
  rid: string | null;
}

export interface FanslyMade {
  frames: MadeFrame[];
  answers: MadeAnswer[];
}

/** What the stand's Fansly made for the stand's pages, from its journal:
 *  the frames it sent (`ws.out`) and the API requests it answered (`res`,
 *  preflights apart), each answer with the attempt the engine admitted that
 *  request as, and whether that was the site's admission or Hub's. */
export function fanslyMade(events: readonly JournalEvent[], grants: readonly Grant[], pages: PagesByAddress): FanslyMade {
  const requests = new Map(events.filter((event) => event.type === "req").map((event) => [event.seq, event]));
  const made: FanslyMade = { frames: [], answers: [] };
  for (const event of events) {
    const page = pages.get(String(event.from ?? ""));
    if (page === undefined) continue;
    if (event.type === "ws.out") made.frames.push({ page, wsId: String(event.wsId), frame: Number(event.frame), mono: event.mono, wall: event.wall });
    if (event.type !== "res" || event.role !== "api" || event.method === "OPTIONS") continue;
    const path = typeof event.path === "string" ? event.path : String(requests.get(Number(event.req))?.path ?? event.pathname);
    const target = `${String(event.host)}${path}`;
    const own = grants.filter((grant) => grant.page === page && grant.kind !== "ws" && grant.target === target && grant.attemptId > 0);
    const grant = own.filter((candidate) => candidate.grantedMono <= event.mono).sort((a, b) => b.grantedMono - a.grantedMono)[0] ?? own[0];
    made.answers.push({ page, method: String(event.method), target, status: Number(event.status), mono: event.mono, wall: event.wall, attemptId: grant?.attemptId ?? null, kind: grant?.kind === "site" ? "site" : grant?.kind === "hub" ? "hub" : null, rid: ridIn(target) });
  }
  return made;
}

/** A gap mark the engine committed (spec §6.1): the page's stream broke
 *  after `fromWall` — the last event saved before the break; null: nothing
 *  was saved before it, the boundary is unknown — and the mark was written
 *  at `atWall`. */
export interface StoredGap {
  page: string;
  reason: string | null;
  fromWall: number | null;
  atWall: number;
}

/** What the engine keeps, from the stand's Postgres. */
export interface Kept {
  /** The frame numbers stored as `ws.in` events, by page. */
  frames: ReadonlyMap<string, ReadonlySet<number>>;
  /** The attempts with a stored outcome, by page. */
  outcomes: ReadonlyMap<string, ReadonlySet<number>>;
  /** The request ids with a stored `site.response` event — complete, or
   *  marked incomplete (`complete: false`) — by page. */
  responses: ReadonlyMap<string, ReadonlySet<string>>;
  gaps: readonly StoredGap[];
}

/** Between Fansly writing a frame and the operator's clock on the event it
 *  saves: a gap's boundaries are the operator's, the frame's time is the
 *  stand's. */
export const GAP_SLACK_MS = 250;

/** Everything Fansly made is kept: each frame it sent is stored as its
 *  `ws.in` event (by the frame's number), each request it answered has its
 *  stored outcome — and a request the site's admission let go has, besides
 *  its outcome (`siteDone`), its answer as a `site.response` event of the
 *  stream (complete, or marked incomplete): the two travel apart, and
 *  either can be lost alone. The only exception is what a committed gap mark covers
 *  by time (the stream is known to be broken there, and the engine
 *  backfills it): those are counted as covered, never silently let go — and
 *  whatever is neither kept nor covered was deleted, or never recorded,
 *  before the engine had it. */
export function madeAndKept(made: FanslyMade, kept: Kept, slackMs = GAP_SLACK_MS): { violations: string[]; coveredByGap: { frames: number; answers: number } } {
  const covered = (page: string, wall: number) => kept.gaps.some((gap) => gap.page === page && (gap.fromWall === null || wall >= gap.fromWall - slackMs) && wall <= gap.atWall + slackMs);
  const coveredByGap = { frames: 0, answers: 0 };
  const violations: string[] = [];
  const lost = new Map<string, MadeFrame[]>();
  for (const frame of made.frames) {
    if (kept.frames.get(frame.page)?.has(frame.frame)) continue;
    if (covered(frame.page, frame.wall)) coveredByGap.frames += 1;
    else lost.set(`${frame.page} ${frame.wsId}`, [...(lost.get(`${frame.page} ${frame.wsId}`) ?? []), frame]);
  }
  for (const frames of lost.values()) {
    const { page, wsId } = frames[0]!;
    violations.push(`Fansly sent ${page} ${frames.length} frame(s) on ${wsId} that are not stored as ws.in events, and no gap mark covers when they were sent: ${frames.slice(0, 5).map((frame) => frame.frame).join(", ")}${frames.length > 5 ? ", …" : ""}`);
  }
  for (const answer of made.answers) {
    const missing: string[] = [];
    if (answer.attemptId === null || !kept.outcomes.get(answer.page)?.has(answer.attemptId)) missing.push(`no stored outcome (${answer.attemptId === null ? "it is no attempt of the engine's" : `attempt ${answer.attemptId}`})`);
    if (answer.kind === "site" && (answer.rid === null || !kept.responses.get(answer.page)?.has(answer.rid))) missing.push(`no stored site.response event (${answer.rid === null ? "it has no request id to find one by" : `rid ${answer.rid}`})`);
    if (missing.length === 0) continue;
    if (covered(answer.page, answer.wall)) coveredByGap.answers += 1;
    else violations.push(`${answer.method} ${answer.target} of ${answer.page} was answered by Fansly (${answer.status}) and has ${missing.join(" and ")}, and no gap mark covers when it was answered`);
  }
  return { violations, coveredByGap };
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

// ── an admission that runs out while its connection is being set up ──────
// Safety is C1's, in every run: nothing arrives after its admission's
// deadline, by the stand's own record. Whether a run of the expiry scenario
// proves anything is a separate question, answered from two sources that do
// not depend on each other: the operator's own journal says that one
// specific request was not sent because its admission's deadline passed
// before the send — not cancelled by the page, not failed with its tunnel —
// and the stand's SOCKS5 shows a CONNECT of that page's API host held across
// that deadline. The SOCKS5's word alone cannot say that the request was
// still waiting (a tunnel cut early does not cancel the operator's pending
// CONNECT, src/egress/proxy.ts), and the operator's alone cannot say it was
// waiting for its connection.

/** The operator's line in its `requests` journal (src/logs/journal.ts) at
 *  the end of a site request, as PR 7 writes it (src/intercept/site.ts,
 *  `#journalEnd`): the path, never the query — the request is named by its
 *  site request id and its attempt. */
export interface OperatorRequestLine {
  at: string;
  method?: string;
  host?: string;
  path?: string;
  admission?: string | null;
  decision?: string;
  result?: string;
}

/** The result of a site request whose admission's deadline passed before
 *  anything of it was sent: the send gate's expiry of its window, then the
 *  request's end with nothing sent (src/intercept/site.ts). A page's cancel
 *  ("the page cancelled the request …") or a failed tunnel ends with
 *  another result. */
export const DEADLINE_REFUSAL = "not sent: the admission's deadline passed before the send";

/** The operator's deadline refusal of one admitted site request, from its
 *  journal line; null: the line says something else. */
export function deadlineRefusal(line: OperatorRequestLine): { siteRequestId: string; attemptId: number; atWall: number } | null {
  if (line.decision !== "ended" || line.result !== DEADLINE_REFUSAL) return null;
  const named = /^site request (.+) \(attempt (\d+)\)$/.exec(line.admission ?? "");
  const atWall = Date.parse(line.at);
  return named && Number.isFinite(atWall) ? { siteRequestId: named[1]!, attemptId: Number(named[2]), atWall } : null;
}

/** A CONNECT the stand's SOCKS5 held: when the hold began, and when it
 *  ended — let go, or its connection closed, whichever came first (null:
 *  neither, by the journal's end). */
export interface HeldConnect {
  socksId: number;
  heldMono: number;
  endedMono: number | null;
}

/** The CONNECTs of `host` from the page held across `atMono`: begun at or
 *  before it, not ended before it. */
export function heldAcross(events: readonly JournalEvent[], pageAddress: string, host: string, atMono: number): HeldConnect[] {
  const ends = new Map<number, number>();
  for (const event of events) {
    if (event.type !== "socks.release" && event.type !== "socks.closed") continue;
    const socksId = Number(event.socksId);
    ends.set(socksId, Math.min(ends.get(socksId) ?? Infinity, event.mono));
  }
  return events
    .filter((event) => event.type === "socks.hold" && event.host === host && event.from === pageAddress)
    .map((hold) => ({ socksId: Number(hold.socksId), heldMono: hold.mono, endedMono: ends.get(Number(hold.socksId)) ?? null }))
    .filter((hold) => hold.heldMono <= atMono && (hold.endedMono ?? Infinity) > atMono);
}

/** One admitted request whose admission ran out while it waited for its
 *  connection. */
export interface ExpiredRequest {
  attemptId: number;
  rid: string;
  target: string;
  grantedMono: number;
  deadlineMono: number;
  /** When the operator journaled the refusal (wall clock). */
  refusedWall: number;
  holds: HeldConnect[];
}

/** The operator's refusal is written after the deadline (the gate's
 *  expiry, then the request's end); this much earlier is the two clocks. */
export const REFUSAL_SLACK_MS = 250;

/** The site requests of `page` to `host` whose admission ran out while they
 *  waited for their connection: the operator journaled the deadline refusal
 *  of that very request (by its attempt and site request id, at or after its
 *  deadline) and a CONNECT of the host from the page was held across that
 *  deadline. With none, the run proves nothing about the deadline, and says
 *  why. `toWall`: a moment of the runner's monotonic clock on the wall
 *  clock (one kernel for the stand: the operator's journal is in wall
 *  time). */
export function expiredUnderHold(events: readonly JournalEvent[], grants: readonly Grant[], operatorLines: readonly OperatorRequestLine[], page: string, pageAddress: string, host: string, toWall: (mono: number) => number): { expired: ExpiredRequest[]; violations: string[] } {
  const refusals = new Map(operatorLines.flatMap((line) => {
    const refusal = deadlineRefusal(line);
    return refusal === null ? [] : [[refusal.attemptId, refusal] as const];
  }));
  const ended = new Map(operatorLines.flatMap((line) => {
    const named = /\(attempt (\d+)\)$/.exec(line.admission ?? "");
    return line.decision === "ended" && named ? [[Number(named[1]), String(line.result ?? "")] as const] : [];
  }));
  const admitted = grants.filter((grant) => grant.page === page && grant.kind === "site" && grant.attemptId > 0 && grant.target !== null && grant.target.split("/")[0] === host);
  const why = { otherEnd: new Map<string, number>(), noLine: 0, early: 0, notHeld: 0, unnamed: 0 };
  const expired: ExpiredRequest[] = [];
  for (const grant of admitted) {
    const rid = ridIn(grant.target);
    const refusal = refusals.get(grant.attemptId);
    if (rid === null) why.unnamed += 1;
    else if (refusal === undefined || refusal.siteRequestId !== grant.ref) {
      const other = ended.get(grant.attemptId);
      if (other === undefined) why.noLine += 1;
      else why.otherEnd.set(other, (why.otherEnd.get(other) ?? 0) + 1);
    } else if (refusal.atWall < toWall(grant.deadlineMono) - REFUSAL_SLACK_MS) why.early += 1;
    else {
      const holds = heldAcross(events, pageAddress, host, grant.deadlineMono);
      if (holds.length === 0) why.notHeld += 1;
      else expired.push({ attemptId: grant.attemptId, rid, target: grant.target!, grantedMono: grant.grantedMono, deadlineMono: grant.deadlineMono, refusedWall: refusal.atWall, holds });
    }
  }
  if (expired.length > 0) return { expired, violations: [] };
  const others = [...why.otherEnd].map(([result, count]) => `${count} × "${result.slice(0, 80)}"`).join(", ");
  const seen = `${admitted.length} site request(s) of ${page} admitted to ${host}: ${why.noLine} with no end in the operator's journal, ${[...why.otherEnd.values()].reduce((a, b) => a + b, 0)} ended otherwise${others ? ` (${others})` : ""}, ${why.early} refused before their deadline, ${why.notHeld} refused with no CONNECT held across their deadline, ${why.unnamed} without a request id`;
  return { expired, violations: [`no site request of ${page} was refused by the operator for its deadline while a CONNECT was held across it (${seen}): the run proves nothing about the deadline`] };
}

/** Each of those requests never arrived — not late, not ever: its admission
 *  ran out unsent, and nothing may send it after. */
export function expiredArrivals(events: readonly JournalEvent[], expired: readonly ExpiredRequest[]): string[] {
  return expired.flatMap((request) =>
    events
      .filter((event) => event.type === "req" && event.role === "api" && event.rid === request.rid)
      .map((arrival) => `the request ${request.rid} (attempt ${request.attemptId}, ${String(arrival.method)}) arrived ${Math.round(arrival.mono - request.deadlineMono)} ms after its admission ran out — the operator had journaled it not sent for its deadline`),
  );
}

/** One late send the control showed: and the very words C1 says of it. */
export interface LateSend {
  rid: string;
  attemptId: number;
  lateMs: number;
  socksId: number;
  /** C1's violation of that arrival — its method, address and request id,
   *  and how far past its deadline it came. */
  violation: string;
}

/** A late send, as an operator that did not check the deadline makes it:
 *  an admitted request's id arrived after its (journaled) deadline over the
 *  very CONNECT that was held across that deadline — the arrival's SOCKS
 *  connection (`socksId`, journaled by the front with every request) is one
 *  of those holds — and C1 calls that arrival late. The control's evidence:
 *  without one, it showed nothing. A late arrival over another connection
 *  does not show it (it is a C1 violation in its own right all the same). */
export function lateUnderHold(events: readonly JournalEvent[], grants: readonly Grant[], page: string, pageAddress: string, host: string, pages: PagesByAddress): { late: LateSend[]; violations: string[] } {
  const late: LateSend[] = [];
  let elsewhere = 0;
  for (const grant of grants) {
    if (grant.page !== page || grant.kind === "ws" || grant.target === null || grant.target.split("/")[0] !== host) continue;
    const rid = ridIn(grant.target);
    if (rid === null) continue;
    const held = new Set(heldAcross(events, pageAddress, host, grant.deadlineMono).map((hold) => hold.socksId));
    if (held.size === 0) continue;
    for (const arrival of events) {
      if (arrival.type !== "req" || arrival.role !== "api" || arrival.rid !== rid || arrival.mono <= grant.deadlineMono + ARRIVAL_SLACK_MS) continue;
      const called = unadmittedArrivals([arrival], grants, pages).find((violation) => violation.includes("arrived outside its admission window"));
      if (called === undefined) continue;
      const socksId = arrival.socksId === null || arrival.socksId === undefined ? null : Number(arrival.socksId);
      if (socksId === null || !held.has(socksId)) {
        elsewhere += 1;
        continue;
      }
      late.push({ rid, attemptId: grant.attemptId, lateMs: Math.round(arrival.mono - grant.deadlineMono), socksId, violation: called });
    }
  }
  return { late, violations: late.length > 0 ? [] : [`no admitted request arrived after its deadline over the CONNECT held across that deadline, with C1 calling it late (${elsewhere} late over another connection): the control showed no late send`] };
}

/** A request was in flight when the engine restarted: one of `rids` had
 *  reached Fansly before `restartMono`, and its answer was not written yet. */
export function inFlightAtRestart(events: readonly JournalEvent[], rids: readonly string[], restartMono: number): string[] {
  const arrived = events.filter((event) => event.type === "req" && event.role === "api" && event.method !== "OPTIONS" && typeof event.rid === "string" && rids.includes(event.rid) && event.mono < restartMono);
  const answered = new Map(events.filter((event) => event.type === "res").map((event) => [Number(event.req), event.mono]));
  const inFlight = arrived.filter((event) => (answered.get(event.seq) ?? Infinity) > restartMono);
  return inFlight.length > 0 ? [] : [`no request was in flight at the engine's restart (${arrived.length} of ${rids.length} had arrived, none still unanswered): the run proves nothing about recovery after a send`];
}

// ── what a control planted (verdict.ts `Planted`) ────────────────────────
// Each control names the violations of its own planted event as exactly as
// it knows them; its run passes only with those and no other violation of
// the checks it trips.

function plant(check: string, phrase: string, subject: string[], min = 1, max: number | null = 1): Planted {
  return { check, phrase, subject, min, max };
}

/** control-leak: the read and the write sent from no page with request id
 *  `rid`, the socket from no page, its forbidden message (with `rid`). */
export function plantedLeak(rid: string): Planted[] {
  return [
    plant("C1", "arrived without any admission", [`GET apiv3.fansly.com/api/v1/account/me?rid=${rid} arrived without any admission: it came from `]),
    plant("C1", "arrived without any admission", [`POST apiv3.fansly.com/api/v1/message/ack?rid=${rid} arrived without any admission: it came from `]),
    plant("C1", "a socket (", ["wss://wsv3.fansly.com/?v=3) arrived without any admission: it came from ", "which is no page of the stand"]),
    plant("C2", "a closed write reached Fansly", [`POST apiv3.fansly.com/api/v1/message/ack (rid ${rid})`]),
    plant("C3", "a forbidden socket message reached Fansly", [rid]),
  ];
}

/** control-bypass: one connection from the page's address to the SOCKS5's
 *  address on 443 — its packets in the capture, one arrival at the direct
 *  listener. */
export function plantedBypass(pageAddress: string, socksIp: string): Planted[] {
  return [plant("C4", "traffic past the proxy", [`Out IP ${pageAddress}.`, `> ${socksIp}.443:`], 1, null), plant("C5", "a connection past the proxy reached the stand directly", [`directly from ${pageAddress}`])];
}

/** control-no-capture: the capture of the page (by its control address)
 *  stopped. */
export function plantedNoCapture(controlIp: string): Planted[] {
  return [plant("C4", "no live capture of the page covers the run", [`sentinel(s) to ${controlIp} are not in it`])];
}

/** control-double-open: the second socket the lever opened under one
 *  admission. */
export function plantedRepeat(wsId: string): Planted[] {
  return [plant("C1", "arrived again under one admission", [`a socket (${wsId}, `])];
}

/** control-duplicate: the naive engine's attempts, each committed twice at
 *  most (which of them got delivered again is the moment's). */
export function plantedDuplicates(attemptIds: readonly number[]): Planted[] {
  return attemptIds.map((attemptId) => plant("C6", "committed 2 times", [`attempt ${attemptId}: committed 2 times`], 0, 1));
}

/** control-hole: the events the ack-early engine acknowledged and lost — the
 *  tail, exactly those numbers. */
export function plantedTail(bufferId: string, lost: readonly number[]): Planted[] {
  if (lost.length === 0) return [];
  return [plant("C7", "were never committed (the tail", [`buffer ${bufferId}: events ${Math.min(...lost)}…${Math.max(...lost)} were never committed (the tail`])];
}

/** control-lost-frames: the frames pushed into the lever's socket, and the
 *  lever's site answer without its event. */
export function plantedLostFrames(page: string, wsId: string, pushed: number, rid: string): Planted[] {
  return [plant("C7", "not stored as ws.in events", [`Fansly sent ${page} ${pushed} frame(s) on ${wsId} that are not stored`]), plant("C7", "has no stored site.response event", [`(rid ${rid})`])];
}

/** The expiry's controls: each late send C1 called late, in C1's own
 *  words (its request, how far past its deadline). */
export function plantedLate(late: readonly LateSend[]): Planted[] {
  return late.map((send) => plant("C1", "arrived outside its admission window", [send.violation]));
}

/** control-loss-release: the read sent from the page's address right after
 *  the loss, with no admission. */
export function plantedRelease(page: string, rid: string): Planted[] {
  return [plant("C1", "arrived without any admission", [`GET apiv3.fansly.com/api/v1/account/me?rid=${rid} arrived without any admission of ${page} for it`])];
}

/** control-held-late: the lever's request Fansly answered, of which the
 *  engine keeps nothing. */
export function plantedUnkeptAnswer(page: string, rid: string): Planted[] {
  return [plant("C7", "was answered by Fansly", [`?rid=${rid} of ${page} was answered by Fansly`])];
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

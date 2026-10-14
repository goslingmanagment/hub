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

/** A CONNECT the stand's SOCKS5 held, by its own connection's life in the
 *  journal (fansly/socks.ts): when its hold began, when the hold let it go
 *  (null: never — it closed while held), when the connection closed and
 *  who closed it (null: still open), and `upstream`: the connection to the
 *  stand's Fansly it became (the address and port the front sees it come
 *  from; null: none was made). */
export interface HeldConnect {
  socksId: number;
  heldMono: number;
  releasedMono: number | null;
  closedMono: number | null;
  closedBy: string | null;
  upstream: string | null;
}

/** The held connection was alive over the deadline and the hold then let
 *  it go: held at or before the deadline, released after it, and closed —
 *  if at all — only after its release. A connection that closed while held
 *  (its client gave up, the stand cut it) was never a way for the request,
 *  whatever its timer would have said. */
export function heldOpenOver(hold: HeldConnect, deadlineMono: number): boolean {
  return hold.heldMono <= deadlineMono && hold.releasedMono !== null && hold.releasedMono > deadlineMono && (hold.closedMono === null || hold.closedMono >= hold.releasedMono);
}

/** One admitted request whose admission ran out over a held CONNECT. */
export interface ExpiredRequest {
  attemptId: number;
  rid: string;
  target: string;
  grantedMono: number;
  deadlineMono: number;
  /** Every CONNECT of its host the page had waiting at its deadline: the
   *  only connections it could go by. */
  holds: HeldConnect[];
}

/** The requests of `page` to `host` whose admission ran out over their own
 *  connection's CONNECT (plan §5, stage 2: "истечение срока допуска во время
 *  установления соединения"). One counts only when all of this is in the
 *  journal — tied to that request, not to the page's traffic at large:
 *
 *  - it was admitted after the run dropped the page's connections to the
 *    host (`stand.dropped`), and from its admission to its deadline the page
 *    had no connection to the host it could ride: none was open at any
 *    moment of that window (each `socks.connect` and `socks.closed` of the
 *    page counted);
 *  - its admission was not used: nothing with its request id arrived up to
 *    its deadline;
 *  - a CONNECT of the host from the page was being held at its deadline,
 *    its connection alive throughout: held at or before the deadline (in
 *    the admission's window or before it), let go after the deadline while
 *    still open, closed — if at all — only after that (`heldOpenOver`); and
 *    it has been let go for `settleMs` by now, so that what follows the
 *    hold had the time to show.
 *
 *  A request answered before the hold, or one that had a warm connection,
 *  is no evidence, however long another connection was held. With none
 *  found the run proves nothing about the deadline, and says why. */
export function expiredUnderHold(events: readonly JournalEvent[], grants: readonly Grant[], page: string, pageAddress: string, host: string, judgedMono: number, settleMs = 2000): { expired: ExpiredRequest[]; violations: string[] } {
  const own = (event: JournalEvent) => event.host === host && event.from === pageAddress;
  const dropped = events.filter((event) => event.type === "stand.dropped" && (event.host === null || event.host === undefined || event.host === host)).map((event) => event.mono);
  const connects = events.filter((event) => event.type === "socks.connect" && own(event));
  const closes = new Map(events.filter((event) => event.type === "socks.closed").map((event) => [Number(event.socksId), event]));
  const closedAt = new Map([...closes].map(([socksId, event]) => [socksId, event.mono]));
  const releasedAt = new Map(events.filter((event) => event.type === "socks.release").map((event) => [Number(event.socksId), event.mono]));
  const holds: HeldConnect[] = events
    .filter((event) => event.type === "socks.hold" && own(event))
    .map((hold) => {
      const socksId = Number(hold.socksId);
      const closed = closes.get(socksId);
      const upstream = connects.find((connect) => Number(connect.socksId) === socksId)?.upstream;
      return { socksId, heldMono: hold.mono, releasedMono: releasedAt.get(socksId) ?? null, closedMono: closed?.mono ?? null, closedBy: closed === undefined ? null : String(closed.by ?? "?"), upstream: typeof upstream === "string" && upstream !== "" ? upstream : null };
    });
  const arrivals = events.filter((event) => event.type === "req" && event.role === "api" && typeof event.rid === "string");
  const admitted = grants.filter((grant) => grant.page === page && grant.kind !== "ws" && grant.target !== null && grant.target.split("/")[0] === host);
  const why = { unnamed: 0, beforeTheDrop: 0, used: 0, warm: 0, notHeld: 0, closedWhileHeld: 0, justLetGo: 0 };
  const expired: ExpiredRequest[] = [];
  for (const grant of admitted) {
    const rid = ridIn(grant.target);
    if (rid === null) why.unnamed += 1;
    else if (!dropped.some((at) => at <= grant.grantedMono)) why.beforeTheDrop += 1;
    else if (arrivals.some((arrival) => arrival.rid === rid && arrival.mono <= grant.deadlineMono)) why.used += 1;
    else if (connects.some((connect) => connect.mono <= grant.deadlineMono && (closedAt.get(Number(connect.socksId)) ?? Infinity) > grant.grantedMono)) why.warm += 1;
    else {
      const over = holds.filter((hold) => heldOpenOver(hold, grant.deadlineMono));
      // Held over the deadline by its timer, but closed before the hold let
      // it go (or never let go): no way for the request — no evidence.
      const dead = holds.filter((hold) => hold.heldMono <= grant.deadlineMono && (hold.releasedMono ?? hold.closedMono ?? Infinity) > grant.deadlineMono && !heldOpenOver(hold, grant.deadlineMono));
      if (over.length === 0) {
        if (dead.length > 0) why.closedWhileHeld += 1;
        else why.notHeld += 1;
      } else if (over.some((hold) => hold.releasedMono! + settleMs > judgedMono)) why.justLetGo += 1;
      else expired.push({ attemptId: grant.attemptId, rid, target: grant.target!, grantedMono: grant.grantedMono, deadlineMono: grant.deadlineMono, holds: over });
    }
  }
  if (expired.length > 0) return { expired, violations: [] };
  const seen = `${admitted.length} admitted to ${host}: ${why.beforeTheDrop} before the page's connections were dropped${dropped.length === 0 ? " (they never were)" : ""}, ${why.used} arrived inside their window, ${why.warm} had a connection to ride, ${why.notHeld} with no CONNECT held over their deadline, ${why.closedWhileHeld} whose CONNECT held over the deadline closed before the hold let it go, ${why.justLetGo} whose hold was let go under ${settleMs} ms ago, ${why.unnamed} without a request id; ${holds.length} CONNECT(s) held, ${holds.filter((hold) => hold.releasedMono !== null).length} let go open`;
  return { expired, violations: [`no admitted request of ${page} ran out over its own held CONNECT (${seen}): the run proves nothing about the deadline`] };
}

export interface LateArrival {
  attemptId: number;
  rid: string;
  method: string;
  /** How long after its admission ran out it arrived. */
  lateMs: number;
  /** The connection it arrived on (the front's side of it). */
  peer: string;
  /** The held CONNECT that connection came through; null: another one. */
  held: HeldConnect | null;
}

/** None of those requests ever arrived: with its admission run out over its
 *  own connection, a request that still reaches Fansly was sent after its
 *  deadline — shown here by its own id, and by the connection it came on:
 *  the one whose CONNECT was held past its deadline (the front's `peer` is
 *  the SOCKS5's `upstream` of that CONNECT), or another. */
export function expiredArrivals(events: readonly JournalEvent[], expired: readonly ExpiredRequest[]): { late: LateArrival[]; violations: string[] } {
  const late: LateArrival[] = [];
  for (const request of expired) {
    for (const arrival of events) {
      if (arrival.type !== "req" || arrival.role !== "api" || arrival.rid !== request.rid) continue;
      const peer = String(arrival.peer ?? "");
      const held = request.holds.find((hold) => hold.upstream !== null && hold.upstream === peer && Number(arrival.socksId) === hold.socksId && hold.releasedMono !== null && arrival.mono >= hold.releasedMono) ?? null;
      late.push({ attemptId: request.attemptId, rid: request.rid, method: String(arrival.method ?? ""), lateMs: Math.round(arrival.mono - request.deadlineMono), peer, held });
    }
  }
  return {
    late,
    violations: late.map(
      (arrival) =>
        `the request ${arrival.rid} (attempt ${arrival.attemptId}, ${arrival.method}) arrived ${arrival.lateMs} ms after its admission ran out, ${arrival.held ? `on the connection whose CONNECT was held past it (SOCKS ${arrival.held.socksId} → ${arrival.held.upstream!})` : `on another connection (${arrival.peer || "?"})`}`,
    ),
  };
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

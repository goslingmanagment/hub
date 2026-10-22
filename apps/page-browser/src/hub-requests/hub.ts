// Hub's requests through the page's browser (plan §4.2; spec §6.1, §9;
// stage 1, §3–§5). The engine's `send` becomes one operation in the site's
// tab, under one admission:
//
//  1. `send` is checked: its id was never seen (the buffer's ledger, across
//     restarts: a repeated id does nothing twice), the page is up and at the
//     site, the live session is the one the engine expects (`session_mismatch`
//     otherwise), the address is the API's (kind api) or the CDN's (image,
//     video), the deadlines are ahead. The headers are built from the live
//     session (session.ts).
//  2. The step "issued" is written to the buffer, durably, and the request
//     starts in the isolated world (page.ts) from its placeholder address.
//  3. It stops in Fetch (cdp/paused.ts holds it). The live session is
//     compared again; the engine is asked (`check`, with the moment of the
//     pause and the live fingerprint) — its answer is an admission with an
//     absolute deadline on CLOCK_MONOTONIC, or a refusal: refused, gone
//     past its deadline, no answer — the request fails and never leaves.
//  4. Admitted: the step "released" is written, durably. The operation's
//     first request then waits for the page's quiet by the operator's own
//     sight (variant Б, plan-b Б2 and Б12): the admission's pause
//     (`checkResult.pauseMs`) since the last write to the API in any tunnel
//     (the proxy's bytes) and the last send of the site's own (CDP), and no
//     request of the site's own to the API in flight. The engine's grant
//     knows the site's sends only once they reached it; the proxy's bytes are
//     here first. A quiet that would come only past the deadline refuses the
//     request (`pace`, never sent). A site's 429 on the route, or 401 or 403
//     on any route, since shortly before `send` arrived refuses each release,
//     including the request after its preflight. When it is released goes
//     to the engine with its `sent`. Then, with the
//     deadline still ahead, the exit open and the same session, the gate
//     opens the request's window (egress/gate.ts; spec §9): its records go
//     up only before the deadline, a repeat of Chrome's own is held, a new
//     connection is refused past the window. Then Fetch.continueRequest with
//     the real address and `interceptResponse`. The deadline is the gate's
//     alone: nothing in the page cancels a request by its deadline (stage 1,
//     amendment 22; spec §8.2).
//  5. A CORS preflight is part of its request (owner decision №1): it is
//     released under the same admission, in a window of its own, its answer
//     handed on with Fetch.fulfillRequest (amendment 3); the request then
//     goes under the same admission, while the deadline is ahead.
//  6. The send: `sent` when the gate sees the first bytes (the sender's
//     word, amendment 20), with whether the connection was a new one; the
//     result's moment is the same — the gate's first bytes of its first
//     request, this process's clock — or none (`completion_fallback`). A
//     CDN request (no gate) is sent by the instant Chrome says it was
//     answered, on this process's clock. Chrome's own timing never crosses
//     the protocol: it runs on a clock of its own (Astra's review of PR 15,
//     round 5).
//  7. The response stops at its headers. A redirect is not followed: the
//     page gets it as final, the engine gets it with its Location
//     (amendment 16). A declared size over the limit (API 32 MiB, media
//     5 MiB) fails it before its body. Otherwise the body's stream is armed
//     (Network.streamResourceContent) before a byte reaches the page, and
//     the body is written to a file of the buffer as it comes, counted, and
//     cut by the tunnels when it passes the limit (amendment 25). It is
//     whole when the request ended with loadingFinished and every chunk was
//     there, as long as it said; only then is it kept (amendment 34).
//  8. Where the answer came from: the network, a cache revalidated by the
//     server (304), the site's service worker, or a cache nobody confirmed.
//  9. The outcome is decided before the command that ends the request
//     (amendment 19) and is final; it is stored in the buffer and sent only
//     once durable (the operator's `onCommitted`), with its body.
//
// The end of a request is Chrome's to report (amendment 23). Variant Б
// (plan-b §4.1.10): Hub is the site's guest, and nothing of Hub's stops the
// page or cuts the tunnels the site's own requests share.
// - A request past its deadline or its limit, or over its body limit, is
//   cancelled in the page (page.ts ABORT). With its answer in, the outcome is
//   a timeout (or an overflow) and it has ended: what is cancelled is only
//   its body.
// - A released request without its answer that the page cancelled (an F5, a
//   new document), that this process cancelled, or that has neither an
//   answer nor an end within its limit (21 s from the admission, counted
//   again from the send, amendment 32), may still be in Chrome's network
//   service: its outcome is sent at once (possibly sent, never retried), but
//   a cancel is not its end. The page's slot (egress/gate.ts) stays held
//   until Chrome reports a real end of it, or until Chrome is gone; past the
//   slot's bound the operator restarts Chrome in a quiet moment.
//
// What is not on the stand yet: media. The CDN hosts have no API window
// (spec §9: their tunnels serve the site's images too), but a media request
// holds Hub's same slot until its proven end. Its deadlines cancel it only
// in the page, and a record of it is not held. Its `sent`
// is CDP's word, and a released one counts as sent. Whether an Image and a
// video element ask as the site's own do, and a video in one request, the
// stand and the test account must show.

import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import type { PausedDecision, PausedRequest, Resolution } from "../cdp/paused.ts";
import type { BodyWriter } from "../buffer/bodies.ts";
import type { Appended, AttemptRecord, AttemptStep, OutcomeBody } from "../buffer/buffer.ts";
import type { ApiGate, GateEvent } from "../egress/gate.ts";
import type { HostClass } from "../egress/hosts.ts";
import type { AlarmKind, Check, CheckResult, ResponseSource, Result, Send, Sent } from "../rpc/protocol.ts";
import { errorMessage, makeLog, monoMs, urlForLogLine, wallMs, type Logger } from "../shared/util.ts";
import { ABORT, attemptOf, issuedUrl, ISSUE, PLACEHOLDER_SUFFIX, realUrl, RELEASE } from "./page.ts";
import { SESSION_HEADERS, SiteSession } from "./session.ts";

/** Plan §4.14 and spec §8.2: the body limits. */
export const API_BODY_LIMIT = 32 * 1024 * 1024;
export const MEDIA_BODY_LIMIT = 5 * 1024 * 1024;

export interface HubTimings {
  /** From the start in the page to its pause in Fetch. */
  pauseWaitMs: number;
  /** From the check to the engine's answer (and never past the send deadline). */
  checkWaitMs: number;
  /** An operation's limit (the engine's 20 s and 1 s): from its admission,
   *  again from its send. */
  opLimitMs: number;
  /** From a preflight's answer to its request's pause. */
  mainWaitMs: number;
  /** How far ahead the engine's request deadline may be. */
  maxRequestMs: number;
}

const DEFAULT_TIMINGS: HubTimings = { pauseWaitMs: 5000, checkWaitMs: 5000, opLimitMs: 21_000, mainWaitMs: 5000, maxRequestMs: 120_000 };

/** While a request of the site's own is in flight, the release looks again
 *  this often. */
export const QUIET_RECHECK_MS = 50;
/** A site's end just before send may commit a hold after the admission read. */
export const SITE_HOLD_MARGIN_MS = 2_000;

/** What the operator itself saw of the page's sends (plan-b Б12): the last
 *  write to the API by its proxy's bytes or a send of the site's own by CDP
 *  (CLOCK_MONOTONIC ms; null: none), and whether a request of the site's own
 *  to the API is in flight. */
export interface PageQuiet {
  lastSendMono: number | null;
  siteInFlight: boolean;
}

type Outcome = Result["outcome"];
type Role = "preflight" | "main";

/** The buffer as the Hub requests use it. */
export interface HubBuffer {
  markAttempt(attemptId: number, step: AttemptStep): Appended;
  putOutcome(outcome: Result, body?: OutcomeBody | null): Appended;
  attempt(attemptId: number): (AttemptRecord & { outcome: boolean }) | null;
  beginBody(): BodyWriter | null;
  removeBody(bodyId: string): void;
}

/** The site's tab, as the operator has it. */
export interface HubSite {
  /** Why no Hub request may start now, or null. */
  notReady(): string | null;
  /** The work tab's session. */
  tabSession(): string | null;
  /** The isolated world of the work tab's document (page.ts WORLD). */
  world(): Promise<number>;
}

/** The engine, as the RPC has it. */
export interface HubLink {
  up(): boolean;
  generation(): number;
  send(message: Check | Sent | Result): boolean;
}

export interface HubDeps {
  cdp: CdpPort;
  /** Resolves a held pause (cdp/paused.ts). */
  resolve: (request: PausedRequest, decision: Exclude<PausedDecision, { action: "hold" }>) => Promise<Resolution>;
  gate: ApiGate;
  classify: (host: string) => HostClass;
  exitOpen: () => boolean;
  buffer: HubBuffer;
  site: HubSite;
  link: HubLink;
  alarm: (kind: AlarmKind, detail: Record<string, string | number | boolean>) => void;
  /** The live session changed (state says it). */
  sessionChanged?: (fingerprint: string | null) => void;
  /** A whole answer of the engine's identity read (`account.me`, plan §4.1
   *  step 9): its session, when its first bytes passed the operator's own
   *  gate (`gateSentMono`, this process's CLOCK_MONOTONIC ms — never
   *  Chrome's timing; null: not known) and its body, sealed in the buffer —
   *  read before this returns, it goes with the outcome's resultAck. */
  identityAnswer?: (answer: { fingerprint: string; status: number; bodyId: string; bytes: number; gateSentMono: number | null }) => void;
  /** The page's sends as the operator saw them (plan-b Б12): an operation's
   *  first request is released only after its admission's pause since the
   *  last of them, with none of the site's in flight. Absent: no wait. */
  quiet?: () => PageQuiet;
  /** A site's end since this operator instant that would hold the route. */
  siteHold?: (route: string, sinceMono: number) => { status: number; route: string } | null;
  timings?: Partial<HubTimings>;
  /** CLOCK_MONOTONIC, ms. */
  now?: () => number;
  log?: Logger;
}

interface Physical {
  role: Role;
  networkId: string | null;
  /** The gate's window (API); null for media. */
  window: string | null;
  released: boolean;
  answered: boolean;
  ended: boolean;
  firstBytesMono: number | null;
  announced: boolean;
  /** A CDN request (no gate there): this process's clock when Chrome said
   *  it was answered — the latest instant it may have left. */
  answeredMono: number | null;
  status: number | null;
  headers: Array<{ name: string; value: string }>;
}

interface Capture {
  writer: BodyWriter;
  armed: boolean;
  decoded: number;
  encoded: number;
  broken: string | null;
}

interface Attempt {
  id: number;
  send: Send;
  /** When the engine's send arrived, on this process's clock. */
  receivedMono: number;
  generation: number;
  cls: "api" | "cdn";
  real: URL;
  limit: number;
  /** The session the headers were built with (= the engine's expected). */
  fingerprint: string;
  headers: Array<[string, string]>;
  navigations: number;
  stage: "issuing" | "issued" | "checking" | "admitted" | "released" | "done";
  /** The pause waiting for the engine's check. */
  waiting: PausedRequest | null;
  /** Pauses held and not resolved yet. */
  held: Set<PausedRequest>;
  deadline: number | null;
  /** The admission's pause (`checkResult.pauseMs`); null: the engine gave
   *  none — no quiet is waited for. */
  pauseMs: number | null;
  /** When the operation's first request began to wait for the quiet, and
   *  when it was released (this process's clock). */
  quietFromMono: number | null;
  releasedMono: number | null;
  recoveredNotSent: boolean;
  preflight: Physical | null;
  main: Physical | null;
  /** The network ids of the attempt's requests (the request, its preflight). */
  roles: Map<string, Role>;
  capture: Capture | null;
  world: number | null;
  timers: Set<NodeJS.Timeout>;
  limitTimer: NodeJS.Timeout | null;
  requestTimerArmed: boolean;
  sentReported: boolean;
  responseSeen: boolean;
  fromCache: boolean;
  fromServiceWorker: boolean;
  wireStatus: number | null;
  timedOut: boolean;
  expired: boolean;
  noResponse: boolean;
  /** A limit requires ABORT at the attempt's end, never RELEASE first. */
  abortInPage: string | null;
  /** This process cancelled it in the page (a limit): a cancel then is ours. */
  abortedByUs: boolean;
  done: boolean;
  ended: Promise<void>;
  end: () => void;
}

const WINDOW = /^hub:(\d+):(preflight|main)$/;
/** Remembered ids of Fetch pauses and network requests, at most. */
const REMEMBERED = 5000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value!);
}

export function isPreflight(request: Pick<PausedRequest, "method" | "headers">): boolean {
  return request.method === "OPTIONS" && Object.keys(request.headers).some((name) => name.toLowerCase() === "access-control-request-method");
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | null {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
}

/** A response's headers for the engine: lower-case names, repeats joined
 *  by ", " (as the Node transport has them), cookies left out. */
export function engineHeaders(headers: Array<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "set-cookie2") continue;
    out[lower] = lower in out ? `${out[lower]}, ${value}` : value;
  }
  return out;
}

/** When a physical request left, on this process's clock alone (Astra's
 *  review of PR 15, round 5): the gate's first bytes of it — or, for a CDN
 *  request (no gate there), when Chrome said it was answered, the latest it
 *  may have left (a pause never runs from before the true send). Chrome's
 *  own timing is another clock's and never crosses the protocol. Null:
 *  not known. */
function sendMoment(phys: Physical | null): number | null {
  if (phys === null) return null;
  return phys.firstBytesMono ?? phys.answeredMono;
}

export class HubRequests {
  readonly session: SiteSession;
  readonly #deps: HubDeps;
  readonly #timings: HubTimings;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #live = new Map<number, Attempt>();
  /** Fetch ids of released requests, by attempt: a redirect's hop is refused. */
  readonly #byFetch = new Map<string, number>();
  readonly #byNetwork = new Map<string, number>();
  /** The session each network request's events come on. */
  readonly #sessionOf = new Map<string, string>();
  /** API paths of network requests, for the header parity. */
  readonly #pathOf = new Map<string, { path: string; hub: boolean }>();
  /** Main-frame documents of each tab session. */
  readonly #navigations = new Map<string, number>();
  /** Released physical requests until Chrome reports their end, whatever
   *  became of their attempts: a cancel before the answer is no end
   *  (`#onFailed`). */
  readonly #releasedPhys = new Map<string, Physical>();
  #lastMediaSend: { mono: number; wall: number } | null = null;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#now = deps.now ?? monoMs;
    this.#log = deps.log ?? makeLog("hub");
    this.session = new SiteSession({
      onChange: (fingerprint) => deps.sessionChanged?.(fingerprint),
      onCheckMismatch: (path, header) => {
        this.#log("session.check_mismatch", { what: header, path });
        deps.alarm("header_mismatch", { what: header, path, detail: "the site computes it another way: Hub requests do not go" });
      },
      onHeaderMismatch: (path, hub, site) => {
        const detail = { what: "header names", path, hub: hub.join(","), site: site.join(",") };
        this.#log("session.header_mismatch", detail);
        // An alarm only (plan-b Б6): the session learns the path afresh from
        // the site's next request to it; Hub's requests, the page and the
        // site go on.
        deps.alarm("header_mismatch", detail);
      },
    });
    const cdp = deps.cdp;
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => this.#onExtraInfo(event));
    cdp.on("Network.responseReceived", (event) => this.#onResponseReceived(event));
    cdp.on("Network.responseReceivedExtraInfo", (event) => this.#onResponseExtraInfo(event));
    cdp.on("Network.dataReceived", (event) => this.#onData(event));
    cdp.on("Network.loadingFinished", (event) => this.#onFinished(event));
    cdp.on("Network.loadingFailed", (event) => this.#onFailed(event));
    cdp.on("Page.frameNavigated", (event) => this.#onNavigated(event));
  }

  /** Attempts in flight (tests, diagnostics). */
  get live(): number {
    return this.#live.size;
  }

  /** The last moment a media request was sent (the gate has the API's). */
  get lastMediaSend(): { mono: number; wall: number } | null {
    return this.#lastMediaSend;
  }

  // ── the engine ─────────────────────────────────────────────────────────

  /** The engine's `send` (also one of an earlier generation: refused). */
  onSend(send: Send): void {
    const receivedMono = this.#now();
    const id = send.attemptId;
    if (this.#live.has(id)) {
      this.#log("send.repeat", { attemptId: id, live: true });
      return;
    }
    const known = this.#deps.buffer.attempt(id);
    if (known !== null) {
      this.#log("send.repeat", { attemptId: id, issued: known.issued, released: known.released, outcome: known.outcome, acked: known.acked });
      // Taken before the operator restarted, and left without an outcome:
      // what is known of it, never a second request.
      if (!known.outcome && !known.acked && known.issued) {
        this.#store(id, send.sessionFingerprint, known.released ? { kind: "transport_error", sent: true, message: "the operator restarted while the request was in flight: its answer is lost" } : { kind: "transport_error", sent: false, message: "the operator restarted before the request was released" });
      }
      return;
    }
    const refuse = (outcome: Outcome) => {
      this.#log("send.refused", { attemptId: id, outcome: outcome.kind, why: outcome.kind === "aborted_before_send" ? outcome.refusal : outcome.kind === "response" ? "" : outcome.message });
      this.#store(id, send.sessionFingerprint, outcome);
    };
    const notSent = (message: string): Outcome => ({ kind: "transport_error", sent: false, message });
    if (send.ownerGeneration < this.#deps.link.generation()) return refuse({ kind: "aborted_before_send", refusal: "generation_stale" });
    let real: URL;
    try {
      real = new URL(send.url);
    } catch {
      return refuse(notSent("the URL does not parse"));
    }
    const cls = this.#deps.classify(real.hostname);
    const wanted = send.kind === "api" ? "api" : "cdn";
    if (real.protocol !== "https:" || real.username !== "" || real.password !== "" || (real.port !== "" && real.port !== "443") || cls !== wanted) {
      return refuse(notSent(`not a URL of the ${wanted === "api" ? "API" : "media CDN"} host for a ${send.kind} request`));
    }
    if (Object.keys(send.headers).some((name) => SESSION_HEADERS.has(name.toLowerCase()))) return refuse(notSent("the route's headers carry the session's own: they come from the live session"));
    const cap = send.kind === "api" ? API_BODY_LIMIT : MEDIA_BODY_LIMIT;
    const limit = Math.min(send.maxBodyBytes, cap);
    if (limit <= 0) return refuse(notSent("no body limit"));
    const now = this.#now();
    if (!(send.sendDeadlineMono > now)) return refuse({ kind: "aborted_before_send", refusal: "send_deadline_passed" });
    if (!(send.requestDeadlineMono >= send.sendDeadlineMono) || send.requestDeadlineMono - now > this.#timings.maxRequestMs) return refuse(notSent("the request deadline is not after the send deadline, or too far"));
    const notReady = this.#deps.site.notReady() ?? (this.#deps.exitOpen() ? null : "the exit is closed");
    if (notReady !== null) return refuse(notSent(`the page is not ready: ${notReady}`));
    const live = this.session.fingerprint;
    if (live === null) return refuse(notSent("no live session of the site yet"));
    if (live !== send.sessionFingerprint) return refuse({ kind: "aborted_before_send", refusal: "session_mismatch" });
    let headers: Array<[string, string]> = [];
    if (send.kind === "api") {
      const built = this.session.headersFor(real.pathname, send.headers);
      if (!built.ok) return refuse(notSent(built.why));
      if (built.fingerprint !== send.sessionFingerprint) return refuse({ kind: "aborted_before_send", refusal: "session_mismatch" });
      headers = built.headers;
    }
    const tab = this.#deps.site.tabSession();
    let end: () => void = () => undefined;
    const attempt: Attempt = {
      id,
      send,
      receivedMono,
      generation: send.ownerGeneration,
      cls: wanted,
      real,
      limit,
      fingerprint: send.sessionFingerprint,
      headers,
      navigations: tab === null ? 0 : (this.#navigations.get(tab) ?? 0),
      stage: "issuing",
      waiting: null,
      held: new Set(),
      deadline: null,
      pauseMs: null,
      quietFromMono: null,
      releasedMono: null,
      recoveredNotSent: false,
      preflight: null,
      main: null,
      roles: new Map(),
      capture: null,
      world: null,
      timers: new Set(),
      limitTimer: null,
      requestTimerArmed: false,
      sentReported: false,
      responseSeen: false,
      fromCache: false,
      fromServiceWorker: false,
      wireStatus: null,
      timedOut: false,
      expired: false,
      noResponse: false,
      abortInPage: null,
      abortedByUs: false,
      done: false,
      ended: new Promise<void>((resolve) => (end = resolve)),
      end: () => end(),
    };
    this.#live.set(id, attempt);
    this.#log("send", { attemptId: id, kind: send.kind, route: send.route, url: urlForLogLine(send.url) });
    void this.#issue(attempt);
  }

  /** The engine's answer to a check. */
  onCheckResult(result: CheckResult): void {
    const attempt = this.#live.get(result.attemptId);
    const waiting = attempt?.waiting ?? null;
    if (!attempt || attempt.done || attempt.stage !== "checking" || waiting === null) {
      this.#log("check.late", { attemptId: result.attemptId, admit: result.admit });
      return;
    }
    attempt.waiting = null;
    if (result.ownerGeneration !== attempt.generation) {
      this.#refuseAt(attempt, waiting, { kind: "aborted_before_send", refusal: "generation_stale" });
      return;
    }
    if (!result.admit) {
      this.#refuseAt(attempt, waiting, { kind: "aborted_before_send", refusal: result.reason });
      return;
    }
    if (attempt.recoveredNotSent) {
      // The engine's recover was told it never left, and closed it so.
      this.#refuseAt(attempt, waiting, { kind: "aborted_before_send", refusal: "lease_inactive" });
      return;
    }
    attempt.stage = "admitted";
    attempt.deadline = result.deadlineMono;
    attempt.pauseMs = result.pauseMs ?? null;
    void this.#admitted(attempt, waiting);
  }

  /** The engine link went down: no check is answered any more (plan
   *  §4.13: without the engine nothing new is admitted). */
  linkLost(): void {
    for (const attempt of [...this.#live.values()]) {
      if (attempt.stage === "checking" && attempt.waiting !== null) {
        const waiting = attempt.waiting;
        attempt.waiting = null;
        this.#refuseAt(attempt, waiting, { kind: "transport_error", sent: false, message: "the engine link was lost before the check's answer" });
      }
    }
  }

  /** A new owner of the page (plan §4.7): the earlier generations' requests
   *  not released yet are refused; the released ones end (their limit holds
   *  them to it). Settles once none of them is left. */
  async quiesce(generation: number): Promise<void> {
    const ending: Array<Promise<void>> = [];
    for (const attempt of [...this.#live.values()]) {
      if (attempt.generation >= generation) continue;
      if (attempt.stage === "released" || attempt.stage === "admitted") {
        ending.push(attempt.ended);
        continue;
      }
      this.#finish(attempt, { kind: "aborted_before_send", refusal: "generation_stale" });
    }
    await Promise.all(ending);
  }

  /** The engine's recover asks of an attempt without an outcome:
   *  `not_sent` only of a request that never left. */
  recoverState(attemptId: number): "not_sent" | "unknown" {
    const attempt = this.#live.get(attemptId);
    if (attempt) {
      if (attempt.stage === "admitted" || attempt.stage === "released") return "unknown";
      // From now on it is never released: the engine closes it as unsent.
      attempt.recoveredNotSent = true;
      return "not_sent";
    }
    const known = this.#deps.buffer.attempt(attemptId);
    if (known === null) return "unknown";
    return known.released ? "unknown" : "not_sent";
  }

  /** The page stops, or its browser goes (the exit is closed already):
   *  every attempt ends — released ones as sent when anything of them may
   *  have left. The session is forgotten with the browser. */
  endAll(reason: string, browserGone = true): void {
    for (const attempt of [...this.#live.values()]) {
      const released = attempt.stage === "released";
      this.#finish(attempt, { kind: "transport_error", sent: released && this.#sent(attempt), message: `the page stopped: ${reason}` });
    }
    if (browserGone) {
      this.session.reset();
      this.#navigations.clear();
      this.#byFetch.clear();
      this.#sessionOf.clear();
      this.#pathOf.clear();
    }
    // This can run before Chrome is gone. Keep released requests and their
    // ownership for later end events (both maps are bounded by remember).
    // The gate's browserGone, after Chrome's confirmed exit, frees its slot.
  }

  // ── the interception ───────────────────────────────────────────────────

  /** A paused request: Hub's (held, or failed), or null — not Hub's. */
  decide(request: PausedRequest): PausedDecision | null {
    if (request.stage === "response") {
      const id = request.networkId === null ? undefined : this.#byNetwork.get(request.networkId);
      const attempt = id === undefined ? undefined : this.#live.get(id);
      if (id === undefined) return null;
      if (!attempt || attempt.done) return { action: "fail", reason: "Aborted", why: `the response of Hub attempt ${id}, which ended` };
      attempt.held.add(request);
      queueMicrotask(() => void this.#onResponse(attempt, request));
      return { action: "hold" };
    }
    if (request.redirectedRequestId !== null && this.#byFetch.has(request.redirectedRequestId)) {
      return { action: "fail", reason: "BlockedByClient", why: "a redirect's next hop of a Hub request: never followed" };
    }
    let host = "";
    try {
      host = new URL(request.url).hostname;
    } catch {
      // not Hub's by its host
    }
    // Hub's requests start from the placeholder host (page.ts); the site's
    // own never reach it.
    if (!host.endsWith(PLACEHOLDER_SUFFIX)) return null;
    const id = attemptOf(request.urlFragment) ?? (request.networkId === null ? undefined : this.#byNetwork.get(request.networkId));
    const attempt = id === undefined ? undefined : this.#live.get(id);
    if (!attempt || attempt.done) return { action: "fail", reason: "Aborted", why: id === undefined ? "a Hub request of no attempt" : `Hub attempt ${id}, which ended` };
    remember(this.#byFetch, request.requestId, attempt.id);
    attempt.held.add(request);
    queueMicrotask(() => void this.#onPaused(attempt, request));
    return { action: "hold" };
  }

  /** What the journal says of a Hub request's pause (null: not Hub's). */
  describe(request: PausedRequest): string | null {
    let placeholder = false;
    try {
      placeholder = new URL(request.url).hostname.endsWith(PLACEHOLDER_SUFFIX);
    } catch {
      // not Hub's by its host
    }
    const id = (placeholder ? attemptOf(request.urlFragment) : null) ?? (request.networkId === null ? undefined : this.#byNetwork.get(request.networkId)) ?? this.#byFetch.get(request.requestId);
    if (id === undefined || id === null) return null;
    return `hub attempt ${id}${isPreflight(request) ? " (preflight)" : ""}`;
  }

  /** Whether a network request is one of Hub's own (variant Б: the site's
   *  observer leaves Hub's requests to this path). */
  ownsNetworkId(networkId: string): boolean {
    return this.#releasedPhys.has(networkId) || this.#byNetwork.has(networkId);
  }

  /** A request of the site's own to the API, as it stopped: the session is
   *  learned from it (session.ts). */
  noteSiteRequest(request: PausedRequest): void {
    this.session.note(request);
  }

  /** The gate's events of Hub windows. */
  onGateEvent(event: GateEvent): void {
    const match = event.window === null ? null : WINDOW.exec(event.window);
    if (!match) return;
    const attempt = this.#live.get(Number(match[1]));
    if (!attempt || attempt.done) return;
    const phys = match[2] === "preflight" ? attempt.preflight : attempt.main;
    switch (event.kind) {
      case "first_bytes": {
        const last = this.#deps.gate.lastSend;
        if (phys) phys.firstBytesMono = last?.mono ?? this.#now();
        this.#reportSent(attempt, last?.mono ?? this.#now(), last?.wall ?? wallMs(), event.detail.newTunnel !== true);
        this.#restartLimit(attempt);
        return;
      }
      case "announced":
        this.#restartLimit(attempt);
        return;
      case "expired":
        attempt.expired = true;
        return;
      case "no_response":
        attempt.noResponse = true;
        return;
      default:
        return;
    }
  }

  // ── the steps ──────────────────────────────────────────────────────────

  async #issue(attempt: Attempt): Promise<void> {
    const marked = this.#deps.buffer.markAttempt(attempt.id, "issued");
    if (!marked.ok) return this.#finish(attempt, { kind: "transport_error", sent: false, message: `the buffer takes no writes (${marked.reason})` });
    const durable = await marked.durable;
    if (attempt.done) return;
    if (!durable.ok) return this.#finish(attempt, { kind: "transport_error", sent: false, message: `the buffer takes no writes (${durable.reason})` });
    const tab = this.#deps.site.tabSession();
    if (tab === null || this.#navigated(attempt)) return this.#finish(attempt, { kind: "transport_error", sent: false, message: "the site's document changed before the request started" });
    this.#timer(attempt, Math.min(attempt.send.sendDeadlineMono - this.#now(), this.#timings.pauseWaitMs), () => {
      if (attempt.stage === "issuing" || attempt.stage === "issued") this.#finish(attempt, { kind: "transport_error", sent: false, message: "the request did not reach the interception in time" });
    });
    try {
      attempt.world = await this.#deps.site.world();
      if (attempt.done) return;
      const reply = await this.#deps.cdp.send<{ result?: { value?: unknown } }>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: ISSUE,
          executionContextId: attempt.world,
          arguments: [{ value: attempt.id }, { value: issuedUrl(attempt.real, attempt.id) }, { value: attempt.send.kind }, { value: attempt.headers }],
          returnByValue: true,
        },
        tab,
      );
      if (attempt.done) return;
      if (reply.result?.value !== true) return this.#finish(attempt, { kind: "transport_error", sent: false, message: "the page already has a request of this attempt" });
      if (attempt.stage === "issuing") attempt.stage = "issued";
    } catch (error) {
      // The pause may have come meanwhile: then it decides.
      if (attempt.stage === "issuing" || attempt.stage === "issued") this.#finish(attempt, { kind: "transport_error", sent: false, message: `the request could not start in the page: ${errorMessage(error)}` });
    }
  }

  async #onPaused(attempt: Attempt, request: PausedRequest): Promise<void> {
    const role: Role = isPreflight(request) ? "preflight" : "main";
    if (request.networkId !== null) this.#own(attempt, request.networkId, role);
    if (attempt.done) return this.#failHeld(attempt, request, "Aborted", "its attempt ended");
    if (attempt.stage === "issuing" || attempt.stage === "issued") {
      attempt.stage = "checking";
      const refusal = this.#refusalAtPause(attempt);
      if (refusal !== null) return this.#refuseAt(attempt, request, refusal);
      attempt.waiting = request;
      const pausedMono = this.#now();
      this.#deps.link.send({ type: "check", attemptId: attempt.id, pausedMono, liveSessionFingerprint: attempt.fingerprint });
      this.#timer(attempt, Math.min(attempt.send.sendDeadlineMono - pausedMono, this.#timings.checkWaitMs), () => {
        if (attempt.stage !== "checking" || attempt.waiting === null) return;
        const waiting = attempt.waiting;
        attempt.waiting = null;
        const past = this.#now() >= attempt.send.sendDeadlineMono;
        this.#refuseAt(attempt, waiting, past ? { kind: "aborted_before_send", refusal: "send_deadline_passed" } : { kind: "transport_error", sent: false, message: "no answer to the check in time" });
      });
      return;
    }
    if ((attempt.stage === "admitted" || attempt.stage === "released") && role === "main" && attempt.main === null && attempt.preflight !== null) {
      // The request after its preflight: the same admission, no new check.
      return this.#release(attempt, request, "main");
    }
    // One admission is one operation: a second preflight, a second request,
    // a request waiting while another one of it is asked about.
    this.#log("pause.extra", { attemptId: attempt.id, role, stage: attempt.stage });
    return this.#failHeld(attempt, request, "Aborted", "a second request of one Hub operation");
  }

  /** Why the paused request may not even be asked about, or null. */
  #refusalAtPause(attempt: Attempt): Outcome | null {
    if (this.#now() >= attempt.send.sendDeadlineMono) return { kind: "aborted_before_send", refusal: "send_deadline_passed" };
    if (attempt.recoveredNotSent) return { kind: "aborted_before_send", refusal: "lease_inactive" };
    if (attempt.generation < this.#deps.link.generation()) return { kind: "aborted_before_send", refusal: "generation_stale" };
    if (this.session.fingerprint !== attempt.fingerprint) return { kind: "aborted_before_send", refusal: "session_mismatch" };
    if (this.#navigated(attempt)) return { kind: "transport_error", sent: false, message: "the site's document changed while the request waited" };
    if (!this.#deps.link.up()) return { kind: "transport_error", sent: false, message: "no engine link to ask" };
    if (!this.#deps.exitOpen()) return { kind: "transport_error", sent: false, message: "the exit is closed" };
    const notReady = this.#deps.site.notReady();
    if (notReady !== null) return { kind: "transport_error", sent: false, message: `the page is not ready: ${notReady}` };
    return null;
  }

  async #admitted(attempt: Attempt, request: PausedRequest): Promise<void> {
    // Written before the release: recover never says `not_sent` of a
    // request that may have left.
    const marked = this.#deps.buffer.markAttempt(attempt.id, "released");
    if (!marked.ok) return this.#refuseAt(attempt, request, { kind: "transport_error", sent: false, message: `the buffer takes no writes (${marked.reason})` });
    const durable = await marked.durable;
    if (attempt.done) return this.#failHeld(attempt, request, "Aborted", "its attempt ended");
    if (!durable.ok) return this.#refuseAt(attempt, request, { kind: "transport_error", sent: false, message: `the buffer takes no writes (${durable.reason})` });
    const role: Role = isPreflight(request) ? "preflight" : "main";
    await this.#release(attempt, request, role);
  }

  /** One physical request of an admitted operation goes. */
  async #release(attempt: Attempt, request: PausedRequest, role: Role): Promise<void> {
    if (attempt.done) return this.#failHeld(attempt, request, "Aborted", "its attempt ended");
    const deadline = attempt.deadline;
    const now = this.#now();
    const notReady = this.#deps.site.notReady();
    let why: Outcome | null = null;
    if (deadline === null || !(deadline > now)) why = this.#sent(attempt) ? { kind: "transport_error", sent: true, message: "the admission expired between the preflight and the request" } : { kind: "aborted_before_send", refusal: "send_deadline_passed" };
    else if (attempt.generation < this.#deps.link.generation()) why = this.#sent(attempt) ? { kind: "transport_error", sent: true, message: "a new owner of the page came between the preflight and the request" } : { kind: "aborted_before_send", refusal: "generation_stale" };
    else if (!this.#deps.exitOpen()) why = { kind: "transport_error", sent: this.#sent(attempt), message: "the exit is closed" };
    else if (notReady !== null) why = { kind: "transport_error", sent: this.#sent(attempt), message: `the page is not ready: ${notReady}` };
    else if (this.session.fingerprint !== attempt.fingerprint) why = this.#sent(attempt) ? { kind: "transport_error", sent: true, message: "the session changed between the preflight and the request" } : { kind: "aborted_before_send", refusal: "session_mismatch" };
    else if (this.#navigated(attempt)) why = { kind: "transport_error", sent: this.#sent(attempt), message: "the site's document changed while the request waited" };
    if (why !== null) return this.#refuseAt(attempt, request, why);
    const hold = this.#deps.siteHold?.(attempt.send.route, attempt.receivedMono - SITE_HOLD_MARGIN_MS) ?? null;
    if (hold !== null) {
      const why = `the site's ${hold.status} on ${hold.route} holds the Hub request`;
      const released = attempt.preflight?.released === true || attempt.main?.released === true;
      const outcome: Outcome = released ? { kind: "transport_error", sent: this.#sent(attempt), message: why } : { kind: "aborted_before_send", refusal: "lease_inactive" };
      this.#log("release.held", { attemptId: attempt.id, route: attempt.send.route, status: hold.status, siteRoute: hold.route });
      return this.#refuseAt(attempt, request, outcome, why);
    }
    if (attempt.preflight === null && attempt.main === null) {
      // The operation's first request: the page's quiet first (plan-b Б12).
      const wait = this.#quietWait(attempt, deadline!, now);
      if (wait === "late") {
        this.#log("release.no_quiet", { attemptId: attempt.id, waitedMs: attempt.quietFromMono === null ? 0 : Math.round(now - attempt.quietFromMono) });
        return this.#refuseAt(attempt, request, { kind: "aborted_before_send", refusal: "pace" }, "no quiet of the page's sends before the admission's deadline");
      }
      if (wait > 0) {
        attempt.quietFromMono ??= now;
        await this.#sleep(attempt, wait);
        // Ended meanwhile: its end failed the pause it held.
        if (attempt.done) return;
        // Everything is asked again: time went by.
        return this.#release(attempt, request, role);
      }
    }
    const phys: Physical = {
      role,
      networkId: request.networkId,
      window: attempt.cls === "api" ? `hub:${attempt.id}:${role}` : null,
      released: false,
      answered: false,
      ended: false,
      firstBytesMono: null,
      announced: false,
      answeredMono: null,
      status: null,
      headers: [],
    };
    // Every Hub request takes the same slot; only API requests also open
    // a window for the API's records (spec §9).
    const opened = phys.window !== null
      ? this.#deps.gate.open(phys.window, deadline!, 0, request.networkId)
      : this.#deps.gate.takeSlot(`hub:${attempt.id}`, deadline!, request.networkId);
    if (!opened.ok) {
      // Another admitted request of the page unfinished (egress/gate.ts):
      // not released, not sent — the engine's not-sent outcome, as its
      // pacer's one place in flight says ("pace").
      const why = `the gate refused the request: ${opened.reason}`;
      const outcome: Outcome = this.#sent(attempt) ? { kind: "transport_error", sent: true, message: why } : { kind: "aborted_before_send", refusal: opened.inFlight !== undefined ? "pace" : "send_deadline_passed" };
      return this.#refuseAt(attempt, request, outcome, why);
    }
    if (role === "preflight") attempt.preflight = phys;
    else attempt.main = phys;
    phys.released = true;
    if (phys.networkId !== null) remember(this.#releasedPhys, phys.networkId, phys);
    attempt.stage = "released";
    if (attempt.limitTimer === null) this.#restartLimit(attempt);
    this.#armRequestDeadline(attempt);
    attempt.held.delete(request);
    if (attempt.releasedMono === null) {
      attempt.releasedMono = now;
      if (attempt.quietFromMono !== null) this.#log("release.quiet", { attemptId: attempt.id, waitedMs: Math.round(now - attempt.quietFromMono), pauseMs: attempt.pauseMs });
    }
    const resolution = await this.#resolve(request, { action: "continue", params: { url: realUrl(request.url, attempt.real.hostname), interceptResponse: true } });
    if (resolution === "refused" && !attempt.done) {
      // The pause was gone (the page dropped the request): it never left.
      phys.released = false;
      if (phys.networkId !== null) this.#releasedPhys.delete(phys.networkId);
      if (phys.window !== null) this.#deps.gate.close(phys.window);
      this.#finish(attempt, { kind: "transport_error", sent: this.#sent(attempt), message: "the request was gone before its release" });
    }
  }

  async #onResponse(attempt: Attempt, request: PausedRequest): Promise<void> {
    const role = request.networkId === null ? undefined : attempt.roles.get(request.networkId);
    const phys = role === "preflight" ? attempt.preflight : role === "main" ? attempt.main : null;
    if (phys?.window) this.#deps.gate.responding(phys.window);
    const response = request.response;
    if (attempt.done || phys === null || !phys.released || phys.ended || response === null) return this.#failHeld(attempt, request, "Aborted", "a response of a Hub request that ended");
    if (response.status === null) return this.#failHeld(attempt, request, "Failed", `a network error at the response stage: ${response.errorReason ?? "?"}`);
    phys.answered = true;
    phys.status = response.status;
    phys.headers = response.headers;
    attempt.held.delete(request);
    if (phys.role === "preflight") {
      // Handed on by fulfillRequest: Chrome 155 kills its network service
      // when a preflight's interception job is continued (amendment 3).
      await this.#resolve(request, { action: "fulfill", status: response.status, headers: response.headers, body: "", why: "a Hub request's preflight answer, handed on", ...(response.statusText ? { phrase: response.statusText } : {}) });
      return;
    }
    const status = response.status;
    const location = headerValue(response.headers, "location");
    if (status >= 300 && status < 400 && location !== null) {
      // Never followed (amendment 16): the page gets it as final, without
      // its Location; the engine gets it with it. Decided first (19).
      this.#respond(attempt, { empty: true });
      await this.#resolve(request, {
        action: "fulfill",
        status,
        headers: response.headers.filter((header) => header.name.toLowerCase() !== "location"),
        body: "",
        why: "a Hub request's redirect, answered as final",
        ...(response.statusText ? { phrase: response.statusText } : {}),
      });
      return;
    }
    const declared = headerValue(response.headers, "content-length");
    const length = declared !== null && /^\d+$/.test(declared.trim()) ? Number(declared.trim()) : null;
    if (length !== null && length > attempt.limit) {
      this.#overflow(attempt, `declared ${length} bytes`, false);
      await this.#resolve(request, { action: "fail", reason: "Aborted", why: "a Hub response over its limit, before its body" });
      return;
    }
    const writer = this.#deps.buffer.beginBody();
    if (writer === null) {
      this.#finish(attempt, { kind: "transport_error", sent: true, message: "the buffer cannot keep the body" });
      await this.#resolve(request, { action: "fail", reason: "Aborted", why: "the body could not be kept" });
      return;
    }
    const capture: Capture = { writer, armed: false, decoded: 0, encoded: 0, broken: null };
    attempt.capture = capture;
    try {
      if (phys.networkId === null) throw new Error("no network id");
      const session = this.#sessionOf.get(phys.networkId) ?? this.#deps.site.tabSession() ?? undefined;
      // Armed while the response still stops at its headers: not a byte of
      // the body has reached the page (plan §4.2, step 7).
      const armed = await this.#deps.cdp.send<{ bufferedData?: string }>("Network.streamResourceContent", { requestId: phys.networkId }, session);
      if (attempt.done) throw new Error("the attempt ended while its stream was armed");
      capture.armed = true;
      if (typeof armed.bufferedData === "string" && armed.bufferedData !== "") this.#append(attempt, Buffer.from(armed.bufferedData, "base64"), null, 0);
    } catch (error) {
      if (!attempt.done) this.#finish(attempt, { kind: "transport_error", sent: true, message: `the body's stream could not be armed: ${errorMessage(error)}` });
      await this.#resolve(request, { action: "fail", reason: "Aborted", why: "the body could not be captured" });
      return;
    }
    if (attempt.done) {
      await this.#resolve(request, { action: "fail", reason: "Aborted", why: "its attempt ended" });
      return;
    }
    await this.#resolve(request, { action: "continueResponse" });
  }

  // ── the network's events ───────────────────────────────────────────────

  #onWillBeSent(event: CdpEvent): void {
    const params = event.params as {
      requestId?: string;
      request?: { url?: string; urlFragment?: string; method?: string };
      initiator?: { type?: string; requestId?: string };
      redirectResponse?: { status?: number; headers?: Record<string, string> };
    };
    const networkId = params.requestId;
    if (typeof networkId !== "string") return;
    if (event.sessionId !== undefined) remember(this.#sessionOf, networkId, event.sessionId);
    let parsed: URL;
    try {
      parsed = new URL(String(params.request?.url ?? ""));
    } catch {
      return;
    }
    const { hostname: host, pathname: path } = parsed;
    const placeholder = host.endsWith(PLACEHOLDER_SUFFIX);
    const preflight = params.initiator?.type === "preflight";
    let id = placeholder ? attemptOf(String(params.request?.urlFragment ?? "")) : null;
    if (id === null && preflight && typeof params.initiator?.requestId === "string") id = this.#byNetwork.get(params.initiator.requestId) ?? null;
    const attempt = id === null ? undefined : this.#live.get(id);
    if (attempt && !attempt.done) this.#own(attempt, networkId, preflight ? "preflight" : "main");
    const realHost = placeholder ? host.slice(0, -PLACEHOLDER_SUFFIX.length) : host;
    // The parity compares requests, not their preflights.
    if (!preflight && this.#deps.classify(realHost) === "api") remember(this.#pathOf, networkId, { path: `${String(params.request?.method ?? "GET").toUpperCase()} ${path}`, hub: placeholder });
    if (params.redirectResponse && attempt && !attempt.done && attempt.roles.get(networkId) === "main") {
      // Chrome followed a redirect the response stage did not show: the
      // answer is the redirect, and its next hop is refused.
      const status = Number(params.redirectResponse.status ?? 0);
      if (attempt.main) {
        attempt.main.answered = true;
        attempt.main.status = status;
        attempt.main.headers = Object.entries(params.redirectResponse.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
      }
      this.#respond(attempt, { empty: true });
    }
  }

  #onExtraInfo(event: CdpEvent): void {
    const params = event.params as { requestId?: string; headers?: Record<string, unknown> };
    const networkId = params.requestId;
    if (typeof networkId !== "string") return;
    const sent = this.#pathOf.get(networkId);
    if (sent && params.headers) this.session.noteSent(sent.path, Object.keys(params.headers), sent.hub);
    const found = this.#physical(networkId);
    if (!found) return;
    const { attempt, phys } = found;
    phys.announced = true;
    if (phys.window !== null) this.#deps.gate.announced(phys.window);
    else this.#restartLimit(attempt);
  }

  #onResponseReceived(event: CdpEvent): void {
    const params = event.params as {
      requestId?: string;
      response?: { fromDiskCache?: boolean; fromServiceWorker?: boolean; fromPrefetchCache?: boolean; connectionReused?: boolean };
    };
    if (typeof params.requestId !== "string") return;
    const found = this.#physical(params.requestId);
    if (!found) return;
    const { attempt, phys } = found;
    if (phys.window !== null) this.#deps.gate.responding(phys.window);
    if (phys.role !== "main") return;
    attempt.responseSeen = true;
    attempt.fromCache = params.response?.fromDiskCache === true || params.response?.fromPrefetchCache === true;
    attempt.fromServiceWorker = params.response?.fromServiceWorker === true;
    if (attempt.cls === "cdn" && !attempt.fromCache && !attempt.fromServiceWorker) {
      // No gate on the CDN: answered now, so it left by now — this
      // process's clock, never Chrome's timing (another clock's).
      const mono = this.#now();
      const wall = wallMs();
      phys.answeredMono = mono;
      this.#lastMediaSend = { mono, wall };
      this.#reportSent(attempt, mono, wall, params.response?.connectionReused === true);
    }
  }

  #onResponseExtraInfo(event: CdpEvent): void {
    const params = event.params as { requestId?: string; statusCode?: number };
    if (typeof params.requestId !== "string") return;
    const found = this.#physical(params.requestId);
    if (found && found.phys.role === "main" && typeof params.statusCode === "number") found.attempt.wireStatus = params.statusCode;
  }

  #onData(event: CdpEvent): void {
    const params = event.params as { requestId?: string; dataLength?: number; encodedDataLength?: number; data?: string };
    if (typeof params.requestId !== "string") return;
    const found = this.#physical(params.requestId);
    if (!found || found.phys.role !== "main") return;
    const { attempt } = found;
    const capture = attempt.capture;
    if (attempt.done || capture === null) return;
    const announced = Number(params.dataLength ?? 0);
    if (params.data === undefined) {
      // Data that passed without the stream: a hole in the body.
      if (announced > 0) capture.broken ??= "a chunk came without its data";
      return;
    }
    this.#append(attempt, Buffer.from(params.data, "base64"), announced, Number(params.encodedDataLength ?? 0));
  }

  #onFinished(event: CdpEvent): void {
    const params = event.params as { requestId?: string; encodedDataLength?: number };
    if (typeof params.requestId !== "string") return;
    // Chrome's end of this very request, for the page's slot (gate.ts) —
    // whatever became of its attempt.
    this.#releasedPhys.delete(params.requestId);
    this.#deps.gate.requestEnded(params.requestId);
    const found = this.#physical(params.requestId);
    if (!found) return;
    const { attempt, phys } = found;
    phys.ended = true;
    if (phys.window !== null) this.#deps.gate.close(phys.window);
    if (attempt.done || !phys.released) return;
    if (phys.role === "preflight") {
      if (attempt.main === null) {
        this.#timer(attempt, this.#timings.mainWaitMs, () => {
          if (attempt.main === null && !attempt.done) this.#afterPreflight(attempt, "the request did not follow its preflight");
        });
      }
      return;
    }
    const capture = attempt.capture;
    if (capture === null || !capture.armed) return this.#finish(attempt, { kind: "transport_error", sent: true, message: "the response came without its body captured" });
    if (capture.broken !== null) return this.#finish(attempt, { kind: "transport_error", sent: true, message: `the body did not arrive whole: ${capture.broken}` });
    const encoded = typeof params.encodedDataLength === "number" ? params.encodedDataLength : capture.encoded;
    this.#respond(attempt, { empty: false, encoded });
  }

  #onFailed(event: CdpEvent): void {
    const params = event.params as { requestId?: string; errorText?: string; canceled?: boolean };
    if (typeof params.requestId !== "string") return;
    // A cancel before the answer is the page's word, not the network
    // service's: Chrome may still hold the request and write it later
    // (amendment 37). The page's slot stays held — only a real end, or
    // Chrome gone, frees it (plan-b §4.1.10).
    const released = this.#releasedPhys.get(params.requestId);
    const unproven = params.canceled === true && (released === undefined ? this.ownsNetworkId(params.requestId) : !released.answered);
    if (!unproven) {
      this.#releasedPhys.delete(params.requestId);
      this.#deps.gate.requestEnded(params.requestId);
    }
    const found = this.#physical(params.requestId);
    if (!found) return;
    const { attempt, phys } = found;
    phys.ended = true;
    if (phys.window !== null) this.#deps.gate.close(phys.window);
    if (attempt.done) return;
    const errorText = String(params.errorText ?? "");
    if (!phys.released) {
      // The request failed before its pause: Chrome's CORS check after the
      // preflight, or the page dropped it.
      if (phys.role === "main") return this.#afterPreflight(attempt, `the request failed before it was released: ${errorText}`);
      return this.#finish(attempt, { kind: "transport_error", sent: this.#sent(attempt), message: `the preflight failed before it was released: ${errorText}` });
    }
    if (phys.answered) {
      // The answer was in; its body was not.
      if (phys.role === "preflight") return;
      return this.#finish(attempt, attempt.timedOut ? { kind: "timeout", sent: true, message: "the body did not finish by the request's deadline" } : { kind: "transport_error", sent: true, message: `the body did not arrive whole: ${errorText}` });
    }
    const sent = this.#sent(attempt);
    if (params.canceled === true && !attempt.abortedByUs) {
      // The page's word (an F5, a new document): the request's end is
      // unknown, and the page's slot stays held (above). The page goes on.
      this.#finish(attempt, { kind: "transport_error", sent, message: "the page cancelled the request before its answer: its end is unknown" });
      return;
    }
    if (attempt.expired && !sent) return this.#finish(attempt, { kind: "aborted_before_send", refusal: "send_deadline_passed" });
    if (attempt.timedOut || attempt.noResponse) return this.#finish(attempt, { kind: "timeout", sent, message: attempt.noResponse ? "no answer 20 s after the send" : "no answer by the request's deadline" });
    return this.#finish(attempt, { kind: "transport_error", sent, message: errorText || "the request failed" });
  }

  #onNavigated(event: CdpEvent): void {
    const frame = (event.params as { frame?: { parentId?: string } }).frame;
    if (!frame || frame.parentId || event.sessionId === undefined) return;
    const count = (this.#navigations.get(event.sessionId) ?? 0) + 1;
    this.#navigations.set(event.sessionId, count);
    // The work tab's new document sends no fansly-session-id until its
    // socket is up: Hub's headers are learned from it anew (pilot 2).
    if (event.sessionId === this.#deps.site.tabSession()) this.session.newDocument();
    // Requests of the old document that still wait are failed now: released
    // later, Chrome would not send them, nor say they ended (amendment 30).
    for (const attempt of [...this.#live.values()]) {
      if (attempt.done || attempt.stage === "released" || attempt.stage === "admitted") continue;
      if (!this.#navigated(attempt)) continue;
      const waiting = attempt.waiting;
      attempt.waiting = null;
      if (waiting !== null) this.#refuseAt(attempt, waiting, { kind: "transport_error", sent: false, message: "the site's document changed while the request waited" });
      else this.#finish(attempt, { kind: "transport_error", sent: false, message: "the site's document changed before the request reached the interception" });
    }
  }

  // ── outcomes ───────────────────────────────────────────────────────────

  /** The main request's preflight was its last word: a non-2xx answer to
   *  the preflight is the operation's answer (owner decision №1). */
  #afterPreflight(attempt: Attempt, why: string): void {
    const preflight = attempt.preflight;
    if (preflight?.answered && preflight.status !== null && (preflight.status < 200 || preflight.status > 299)) {
      this.#respond(attempt, { empty: true, preflight: true });
      return;
    }
    this.#finish(attempt, { kind: "transport_error", sent: this.#sent(attempt), message: why });
  }

  #append(attempt: Attempt, data: Buffer, announced: number | null, encoded: number): void {
    const capture = attempt.capture;
    if (capture === null || attempt.done) return;
    if (announced !== null && data.length !== announced) capture.broken ??= `a chunk of ${data.length} bytes said ${announced}`;
    if (!capture.writer.write(data)) capture.broken ??= `the body could not be written: ${capture.writer.error ?? "?"}`;
    capture.decoded += data.length;
    capture.encoded += encoded;
    if (capture.decoded > attempt.limit) this.#overflow(attempt, `${capture.decoded} bytes received`, true);
  }

  /** Over the limit — declared (the response then fails before its body),
   *  or while it comes: decided, then the request is cancelled in the page
   *  (never by its tunnels: the site's share them). */
  #overflow(attempt: Attempt, what: string, abort: boolean): void {
    if (attempt.done) return;
    this.#log("body.over_limit", { attemptId: attempt.id, limit: attempt.limit, what });
    if (abort) attempt.abortInPage = "a Hub response over its body limit";
    if (attempt.send.kind === "api") this.#finish(attempt, { kind: "transport_error", sent: true, message: `the response body is over ${attempt.limit} bytes (${what})` });
    else this.#respond(attempt, { empty: true, overflow: true });
  }

  /** A response outcome: the body captured (sealed now), or an empty one
   *  (a redirect, an overflow, a preflight's answer). */
  #respond(attempt: Attempt, how: { empty: boolean; encoded?: number; overflow?: boolean; preflight?: boolean }): void {
    if (attempt.done) return;
    const phys = how.preflight ? attempt.preflight : attempt.main;
    const capture = attempt.capture;
    let writer: BodyWriter | null;
    if (how.empty) {
      capture?.writer.abandon();
      attempt.capture = null;
      writer = this.#deps.buffer.beginBody();
    } else {
      writer = capture?.writer ?? null;
      attempt.capture = null;
    }
    const sealed = writer?.seal() ?? null;
    if (sealed === null || phys === null || phys.status === null) {
      this.#finish(attempt, { kind: "transport_error", sent: true, message: "the response could not be kept" });
      return;
    }
    // Each physical request's moment is the gate's first bytes on this
    // process's clock (`sendMoment`): the request leaves only when the proxy
    // forwards it, and Chrome's own timing never crosses the protocol. The
    // operation's is its first request's.
    const moments = [sendMoment(attempt.preflight), sendMoment(attempt.main)].filter((mono): mono is number => mono !== null);
    const sentMono = moments.length > 0 ? Math.min(...moments) : null;
    if (!how.empty && !how.preflight && attempt.send.route === "account.me") {
      // When it went by this process's own clock alone: the gate's first
      // bytes (Chrome's timing is another clock's).
      const gate = [attempt.preflight?.firstBytesMono, attempt.main?.firstBytesMono].filter((mono): mono is number => typeof mono === "number");
      this.#deps.identityAnswer?.({ fingerprint: attempt.fingerprint, status: phys.status, bodyId: sealed.bodyId, bytes: sealed.bytes, gateSentMono: gate.length > 0 ? Math.min(...gate) : null });
    }
    const outcome: Outcome = {
      kind: "response",
      status: phys.status,
      headers: engineHeaders(phys.headers),
      body: { bodyId: sealed.bodyId, decodedBytes: sealed.bytes, sha256: sealed.sha256 },
      encodedBytes: how.empty ? 0 : (how.encoded ?? sealed.bytes),
      source: how.preflight ? "network" : this.#source(attempt),
      sentMono,
      sendMark: sentMono === null ? "completion_fallback" : "transport_reported",
      ...(how.overflow ? { bodyOverflow: true } : {}),
      ...(how.preflight ? { preflight: true } : {}),
    };
    this.#finish(attempt, outcome, { bodyId: sealed.bodyId, bytes: sealed.bytes });
  }

  /** Plan §4.2, step 8. */
  #source(attempt: Attempt): ResponseSource {
    if (attempt.fromServiceWorker) return "service_worker";
    if (attempt.wireStatus === 304) return "revalidated_304";
    if (attempt.fromCache || !attempt.responseSeen) return "cache_unconfirmed";
    return "network";
  }

  /** Refused at a pause: the outcome first, then the request fails (with
   *  every pause of the attempt still held, #finish). */
  /** `why`: the pause is failed with it, for the journal; else as the
   *  attempt's end fails what it holds. */
  #refuseAt(attempt: Attempt, request: PausedRequest, outcome: Outcome, why: string | null = null): void {
    if (why !== null) void this.#failHeld(attempt, request, "Failed", why);
    else attempt.held.add(request);
    this.#finish(attempt, outcome);
  }

  /** The paths' resolution of a pause, and the request's end for the page's
   *  slot (egress/gate.ts): an answer resolved at the response stage (a
   *  preflight handed on by fulfill has no other end) — once Chrome has
   *  answered the resolution, never as it is decided. Unanswered, or
   *  refused (Chrome no longer knows the pause), it says nothing: the
   *  request stays pending until Chrome's own end or the slot's bound. */
  async #resolve(request: PausedRequest, decision: Exclude<PausedDecision, { action: "hold" }>): Promise<Resolution> {
    const resolution = await this.#deps.resolve(request, decision);
    if (resolution === "answered" && request.stage === "response" && (decision.action === "fail" || decision.action === "fulfill")) this.#deps.gate.requestEnded(request.networkId);
    return resolution;
  }

  async #failHeld(attempt: Attempt, request: PausedRequest, reason: "Aborted" | "Failed", why: string): Promise<void> {
    attempt.held.delete(request);
    await this.#resolve(request, { action: "fail", reason, why });
  }

  /** The attempt's end: final, stored, and sent once durable (with its
   *  body) by the operator. */
  #finish(attempt: Attempt, outcome: Outcome, body: OutcomeBody | null = null): void {
    if (attempt.done) {
      if (body !== null) this.#deps.buffer.removeBody(body.bodyId);
      return;
    }
    attempt.done = true;
    attempt.stage = "done";
    for (const timer of attempt.timers) clearTimeout(timer);
    attempt.timers.clear();
    if (attempt.limitTimer) clearTimeout(attempt.limitTimer);
    attempt.limitTimer = null;
    for (const phys of [attempt.preflight, attempt.main]) if (phys?.window) this.#deps.gate.close(phys.window);
    // The slot is free once every request it released has its end (gate.ts).
    this.#deps.gate.operationEnded(`hub:${attempt.id}`);
    attempt.capture?.writer.abandon();
    attempt.capture = null;
    // A pause still held is failed: nothing of an ended attempt goes.
    for (const request of [...attempt.held]) void this.#failHeld(attempt, request, "Aborted", "its attempt ended");
    attempt.waiting = null;
    this.#live.delete(attempt.id);
    attempt.end();
    this.#log("result", {
      attemptId: attempt.id,
      kind: outcome.kind,
      status: outcome.kind === "response" ? outcome.status : null,
      sent: outcome.kind === "response" ? true : outcome.kind === "aborted_before_send" ? false : outcome.sent,
      why: outcome.kind === "aborted_before_send" ? outcome.refusal : outcome.kind === "response" ? (outcome.bodyOverflow ? "body over its limit" : null) : outcome.message,
      bodyBytes: body?.bytes ?? null,
    });
    this.#store(attempt.id, attempt.fingerprint, outcome, body);
    this.#releaseInPage(attempt);
  }

  /** Stored durably, then sent by the operator. A buffer that takes no
   *  writes: the engine still hears, from memory — never with a body. */
  #store(attemptId: number, fingerprint: string, outcome: Outcome, body: OutcomeBody | null = null): void {
    const result: Result = { type: "result", attemptId, sessionFingerprint: fingerprint, outcome };
    const buffer = this.#deps.buffer;
    buffer.markAttempt(attemptId, "received");
    const put = buffer.putOutcome(result, body);
    const unkept = (reason: string) => {
      if (body !== null) buffer.removeBody(body.bodyId);
      this.#log("result.unkept", { attemptId, reason });
      const told: Outcome = outcome.kind === "response" ? { kind: "transport_error", sent: true, message: `the operator could not keep the response (${reason})` } : outcome;
      this.#deps.link.send({ type: "result", attemptId, sessionFingerprint: fingerprint, outcome: told });
    };
    if (!put.ok) return unkept(put.reason);
    void put.durable.then((durable) => {
      if (!durable.ok) unkept(durable.reason);
    });
  }

  #releaseInPage(attempt: Attempt): void {
    if (attempt.abortInPage !== null) {
      void this.#abort(attempt, attempt.abortInPage);
      return;
    }
    const tab = this.#deps.site.tabSession();
    if (attempt.world === null || tab === null) return;
    this.#deps.cdp
      .send("Runtime.callFunctionOn", { functionDeclaration: RELEASE, executionContextId: attempt.world, arguments: [{ value: attempt.id }], returnByValue: true }, tab)
      .catch(() => undefined);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  #own(attempt: Attempt, networkId: string, role: Role): void {
    attempt.roles.set(networkId, role);
    remember(this.#byNetwork, networkId, attempt.id);
  }

  #physical(networkId: string): { attempt: Attempt; phys: Physical } | null {
    const id = this.#byNetwork.get(networkId);
    const attempt = id === undefined ? undefined : this.#live.get(id);
    if (!attempt) return null;
    const role = attempt.roles.get(networkId);
    const phys = role === "preflight" ? attempt.preflight : role === "main" ? attempt.main : null;
    if (phys !== null && phys.networkId === networkId) return { attempt, phys };
    if (role === undefined) return null;
    // A request of the attempt not released (yet): its failure still counts.
    const ghost: Physical = { role, networkId, window: null, released: false, answered: false, ended: false, firstBytesMono: null, announced: false, answeredMono: null, status: null, headers: [] };
    return { attempt, phys: ghost };
  }

  /** Did anything of the operation leave? A strict gate's word for the API.
   *  A passive gate (variant Б, plan-b §4.1.10) shares the site's
   *  connections and cannot say a released request did not leave: then, as
   *  for media (no gate), a released request counts as sent. */
  #sent(attempt: Attempt): boolean {
    if (attempt.cls === "cdn" || this.#deps.gate.passive) return attempt.preflight?.released === true || attempt.main?.released === true;
    return attempt.preflight?.firstBytesMono != null || attempt.main?.firstBytesMono != null;
  }

  #navigated(attempt: Attempt): boolean {
    const tab = this.#deps.site.tabSession();
    return tab === null || (this.#navigations.get(tab) ?? 0) !== attempt.navigations;
  }

  #reportSent(attempt: Attempt, sentMono: number, sentWall: number, connectionReused: boolean): void {
    if (attempt.sentReported) return;
    attempt.sentReported = true;
    this.#deps.link.send({ type: "sent", attemptId: attempt.id, sentMono, sentWall, connectionReused, ...(attempt.releasedMono === null ? {} : { releasedMono: attempt.releasedMono }) });
  }

  /** Plan-b Б2, Б12: how long the operation's first request still waits for
   *  the page's quiet — its admission's pause since the last send the
   *  operator saw (the proxy's write to the API, the site's own by CDP), and
   *  no request of the site's own in flight (looked at again every
   *  `QUIET_RECHECK_MS`) — 0: none; `late`: the quiet would come only at or
   *  past the admission's deadline. */
  #quietWait(attempt: Attempt, deadline: number, now: number): number | "late" {
    const pause = attempt.pauseMs;
    const seen = pause === null ? undefined : this.#deps.quiet?.();
    if (pause === null || seen === undefined) return 0;
    let readyAt = seen.lastSendMono === null ? now : seen.lastSendMono + pause;
    if (seen.siteInFlight) readyAt = Math.max(readyAt, now + QUIET_RECHECK_MS);
    if (readyAt <= now) return 0;
    return readyAt < deadline ? readyAt - now : "late";
  }

  /** A wait of the attempt's own: over at its end too. */
  #sleep(attempt: Attempt, ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#timer(attempt, ms, resolve);
      void attempt.ended.then(resolve);
    });
  }

  /** The operation's limit: from its admission, again from each send. */
  #restartLimit(attempt: Attempt): void {
    if (attempt.done) return;
    if (attempt.limitTimer) clearTimeout(attempt.limitTimer);
    attempt.limitTimer = setTimeout(() => this.#onLimit(attempt), this.#timings.opLimitMs);
  }

  /** The engine's request deadline (Node's REQUEST_TIMEOUT_MS; media 10 s):
   *  the request is cancelled in the page; an answer whose body still comes
   *  ends as a timeout now, a request without one when Chrome reports its
   *  end (its slot held: that cancel is no proof of an end). */
  #armRequestDeadline(attempt: Attempt): void {
    if (attempt.requestTimerArmed) return;
    attempt.requestTimerArmed = true;
    this.#timer(attempt, attempt.send.requestDeadlineMono - this.#now(), () => {
      if (attempt.done) return;
      attempt.timedOut = true;
      attempt.abortInPage = "a Hub request past its deadline";
      if (attempt.main?.answered) this.#finish(attempt, { kind: "timeout", sent: true, message: "the body did not finish by the request's deadline" });
      else void this.#abort(attempt, attempt.abortInPage);
    });
  }

  #onLimit(attempt: Attempt): void {
    attempt.limitTimer = null;
    if (attempt.done) return;
    if (attempt.main?.answered) {
      attempt.abortInPage = "a Hub response over its time limit";
      this.#finish(attempt, { kind: "timeout", sent: true, message: "the body did not finish within the request's limit" });
      return;
    }
    // No answer and no end: Chrome may still hold the request (amendment
    // 23). Its outcome now, possibly sent; the page's slot stays held until
    // Chrome reports a real end, or is gone (plan-b §4.1.10).
    attempt.abortInPage = "a Hub request without an answer or an end within its limit";
    this.#finish(attempt, { kind: "timeout", sent: this.#sent(attempt), message: "no answer and no end of the request within its limit: its end is unknown" });
  }

  /** Cancels the request in the page (page.ts ABORT): it ends there, never
   *  by its tunnels. The world may be gone with its document: then so is the
   *  request. */
  async #abort(attempt: Attempt, why: string): Promise<void> {
    if (attempt.abortedByUs) return;
    attempt.abortedByUs = true;
    const tab = this.#deps.site.tabSession();
    this.#log("request.abort", { attemptId: attempt.id, why });
    if (attempt.world === null || tab === null) return;
    try {
      await this.#deps.cdp.send("Runtime.callFunctionOn", { functionDeclaration: ABORT, executionContextId: attempt.world, arguments: [{ value: attempt.id }], returnByValue: true }, tab);
    } catch (error) {
      this.#log("request.abort_failed", { attemptId: attempt.id, error: errorMessage(error) });
    }
  }

  #timer(attempt: Attempt, ms: number, run: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      attempt.timers.delete(timer);
      run();
    }, Math.max(0, ms));
    attempt.timers.add(timer);
    return timer;
  }
}

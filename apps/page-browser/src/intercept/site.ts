// The site's own requests (plan §4.3, §4.6, §4.9, §4.13; spec §2, §3, §5,
// §6.1, §9; owner decisions №1, №2, №3, №10, №17). Every request of the
// site stops in Fetch at its request stage (cdp/paused.ts); after Hub's own
// and the self-test's (their paths decide those first), the map of
// operations decides (policy/operations.ts `decide`, in the operator's
// mode):
//
//  - pass: the page, its static files, Fansly's other hosts, the CDN's
//    pictures, third-party hosts the site loads — on at once, unpaced; the
//    journal has the host, path, size and time. Only while the page is up:
//    before its exit opens nothing goes (plan §4.1). A CORS preflight among
//    them goes on with its answer to stop at its headers, and is handed on
//    with Fetch.fulfillRequest — as every preflight under this interception
//    is (stage 1, amendment 3: continued, Chrome 155 may kill its network
//    service).
//  - refuse: what the map closes (closed rows, writes but the login, other
//    hosts the map closes, local and special-use addresses) — failed
//    (BlockedByClient) and journaled. The rules extension cancels these
//    first; this is the second layer (plan §4.6).
//  - admit: a request to the API — by the engine's admission only. It waits,
//    paused, for `siteAdmitResult`:
//      1. its id (a UUID) is written to the buffer, durably, before its
//         `siteAdmit` (spec §6.1): a buffer that refuses writes admits
//         nothing (plan §4.3). Refused at once, without asking: the exit
//         closed, the page not up or halted, the buffer refusing writes.
//         Without an engine link it waits, and is asked once one comes
//         (plan §4.9: a deploy of `sync` does not cancel the site's
//         requests until their wait is over); a link that changes asks
//         again what it had not answered (spec §6.2) — an answer counts
//         only on the connection it was asked on.
//      2. `siteAdmit` carries the method, host, path, query, resource
//         type, the map's route and operation, the session of the request
//         and its wait's absolute end on CLOCK_MONOTONIC: 60 s from the
//         pause (spec §3). Past it the request is failed (`Failed`), the
//         site sees a network error, the journal says why.
//      3. Refused: failed (`Failed`). Admitted: its attempt and "released"
//         are written durably, then — with the deadline ahead, the exit
//         open, the page up, the session and the document unchanged, the
//         generation current — the gate's window opens (egress/gate.ts;
//         spec §9: the request's records go up only before the deadline, a
//         repeat of Chrome's own is held) and the request goes on, its
//         answer stopping at its headers.
//  - preflight: a CORS preflight is part of its request (owner decision №1):
//    the admission is asked at the preflight's pause with its request's
//    method, and the request that follows goes under the same admission,
//    while its deadline is ahead. The preflight's answer is handed on with
//    Fetch.fulfillRequest (stage 1, amendment 3: Chrome 155 kills its
//    network service when a preflight's interception job is continued);
//    a non-2xx answer to it is its operation's answer. Chrome names the
//    request a preflight was made for (`initiator.requestId`), and tells of
//    that request's end even while only its preflight is paused or in
//    flight: a request the page aborts while it waits ends its operation at
//    once — its preflight, still paused in Chrome, is failed, never
//    released — and one aborted while its preflight is in flight ends with
//    the preflight's answer (the sender's word; Chrome 155 reports no other
//    end of a preflight handed on by fulfill).
//
// The answer of a route "with platform data" (the map's `platformData`) is
// kept, never held up: the body's stream (Network.streamResourceContent) is
// armed while the request still stands at its request stage — before its
// admission is asked — and confirmed before it goes on (stage 1, item 17;
// on Chrome 155 armed at the request stage, every byte is reported). Its
// chunks go to a file of the buffer as they come (bodies.ts), counted, and
// the body is whole when the request ended with loadingFinished and every
// chunk carried its data, as long as it said (plan §4.2, step 7) — or, for
// a body the page read as a stream (that ends in CDP as a cancel after the
// answer, stage 1, amendment 8), when an identity body has the length it
// declared, or the body is a whole JSON object or array. A body that is not
// whole is never kept as a fact: `site.response` with `complete: false` and
// no body is the mark the engine's intake turns into a hole seen in Hub and
// a backfill (PR 13). There is no size limit for keeping it: the site has
// the answer already; the buffer's caps hold the volume. A stream that
// could not be armed at the request stage (no session of the request known
// yet) is armed at the response stage, before a byte of the body reaches
// the page.
//
// The end of an admitted request is Chrome's to report, as Hub's (stage 1,
// amendments 23, 32, 36, 37): no answer and no end within 21 s from the
// admission — counted again from the send — or a released request the page
// cancelled before its answer stops the page (`request_unended`); an answer
// whose body still comes 20 s after the grant (spec §3) has its tunnels cut.
// A request of a document the site replaced is never released (amendment
// 41, documents.ts).
//
// `siteDone` — sent or not (the gate's word), when (Chrome's moment, never
// before the gate's first bytes), the status, `Retry-After`, the error and
// what became of the body — is stored with the `site.response` it names and
// the request's end in one commit, and goes to the engine once durable
// (buffer/replay.ts), until its `resultAck`. A buffer that refuses it: the
// engine hears from memory at once, the body `incomplete` when one was to be
// kept.
//
// Owner decision №2's closed rows act in both modes; the login operations
// pass only in the manual login (PR 15 switches the mode); a write outside
// them never leaves.

import { createHash, randomUUID } from "node:crypto";

import type { Appended, GroupItem, OutcomeBody, SiteRequestChange, StoredSiteRequest } from "../buffer/buffer.ts";
import type { BodyWriter, SealedBody } from "../buffer/bodies.ts";
import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import type { PausedDecision, PausedRequest, Resolution } from "../cdp/paused.ts";
import type { ApiGate, GateEvent } from "../egress/gate.ts";
import { engineHeaders, isPreflight } from "../hub-requests/hub.ts";
import { sessionFingerprint } from "../hub-requests/session.ts";
import { hostAndPath, type RequestLine } from "../logs/journal.ts";
import { classifyHost, decide as mapDecide, type MapDecision, type OperatorMode } from "../policy/operations.ts";
import type { BodyRef, ResponseSource, SiteAdmit, SiteAdmitResult, SiteDone } from "../rpc/protocol.ts";
import { errorMessage, makeLog, monoMs, wallMs, type Logger } from "../shared/util.ts";
import { Documents, type DocumentMark } from "./documents.ts";

export interface SiteTimings {
  /** The wait for the engine's admission (spec §3: 60 s). */
  admitWaitMs: number;
  /** An admitted request's limit (spec §3: 20 s from the grant): its
   *  tunnels are cut. */
  requestLimitMs: number;
  /** An operation's limit without an answer or an end: from its
   *  admission, again from its send (Hub's 21 s). */
  opLimitMs: number;
  /** From a preflight's answer to its request's pause. */
  mainWaitMs: number;
  /** How long the stream's arming waits for the request's session. */
  armWaitMs: number;
  /** Pauses between tries of a refused write; the last one repeats. */
  retryMs: number[];
}

const DEFAULT_TIMINGS: SiteTimings = { admitWaitMs: 60_000, requestLimitMs: 20_000, opLimitMs: 21_000, mainWaitMs: 5000, armWaitMs: 2000, retryMs: [1000, 2000, 5000, 15_000, 30_000] };

/** The session of a request that carries none (the login screens' reads):
 *  what its `site.response` names, the engine's fingerprint being a sha256. */
export const NO_SESSION = sessionFingerprint("", "");
const EMPTY_SHA256 = createHash("sha256").digest("hex");
/** A body the page read as a stream is checked by its shape up to this. */
const SHAPE_CHECK_MAX = 32 * 1024 * 1024;
const REMEMBERED = 5000;
const WINDOW = /^site:([0-9a-f-]{36}):(preflight|main)$/;

type Role = "preflight" | "main";

/** The buffer as the site's requests use it. */
export interface SiteBuffer {
  appendGroup(items: readonly GroupItem[]): Appended;
  changeSiteRequest(change: SiteRequestChange): Appended;
  siteRequests(): StoredSiteRequest[];
  beginBody(): BodyWriter | null;
  removeBody(bodyId: string): void;
  readBody(bodyId: string, part: number, partBytes: number): Buffer | null;
  /** Why it takes no writes now, or null. */
  refusal(): string | null;
}

/** The engine, as the RPC has it. */
export interface SiteLink {
  up(): boolean;
  /** Changes with the connection. */
  epoch(): number;
  generation(): number;
  send(message: SiteAdmit | SiteDone): boolean;
}

export interface SiteDeps {
  cdp: CdpPort;
  resolve: (request: PausedRequest, decision: Exclude<PausedDecision, { action: "hold" }>) => Promise<Resolution>;
  gate: ApiGate;
  /** Cuts every API tunnel (egress/proxy.ts). */
  cutApi: (reason: string) => number;
  buffer: SiteBuffer;
  link: SiteLink;
  /** Why the page takes none of the site's requests now (the exit closed,
   *  the page not up or halted), or null. */
  notUp: () => string | null;
  /** The live session (hub-requests/session.ts): learned from the site's
   *  own API requests as they stop. */
  session: { fingerprint(): string | null; note(request: PausedRequest): void };
  mode: () => OperatorMode;
  /** The page must stop: the exit is closed when this returns. */
  fault: (reason: "request_unended", note: string) => void;
  journal: (line: RequestLine) => void;
  timings?: Partial<SiteTimings>;
  /** CLOCK_MONOTONIC, ms. */
  now?: () => number;
  log?: Logger;
}

interface Physical {
  role: Role;
  networkId: string | null;
  window: string;
  released: boolean;
  answered: boolean;
  ended: boolean;
  firstBytesMono: number | null;
  timingMono: number | null;
  status: number | null;
  headers: Array<{ name: string; value: string }>;
}

interface Capture {
  writer: BodyWriter | null;
  /** Sealed early, to be read for its shape. */
  sealed: SealedBody | null;
  armed: boolean;
  /** The arming under way (at the request stage). */
  arming: Promise<void> | null;
  decoded: number;
  encoded: number;
  broken: string | null;
}

interface SiteOp {
  id: string;
  /** The request's method and URL (the preflight's request's). */
  key: string;
  method: string;
  url: URL;
  resourceType: string;
  route: string;
  operation: "read" | "login";
  platformData: boolean;
  rule: string;
  /** The session the admission was asked under (null: none known). */
  fingerprint: string | null;
  /** The session of the request itself (its headers). */
  ownFingerprint: string | null;
  pausedMono: number;
  waitDeadline: number;
  stage: "keeping" | "waiting" | "asked" | "admitted" | "released" | "done";
  askedEpoch: number | null;
  attemptId: number | null;
  generation: number;
  deadline: number | null;
  /** The pause that asked (the preflight's or the request's). */
  first: PausedRequest;
  firstRole: Role;
  document: DocumentMark;
  held: Set<PausedRequest>;
  preflight: Physical | null;
  main: Physical | null;
  roles: Map<string, Role>;
  capture: Capture | null;
  sentWall: number | null;
  connectionReused: boolean | null;
  responseSeen: boolean;
  fromCache: boolean;
  fromServiceWorker: boolean;
  wireStatus: number | null;
  recoveredNotSent: boolean;
  /** The request ended (the page aborted it, Chrome's CORS check failed
   *  it) while its preflight was in flight: the operation ends with the
   *  preflight's answer. */
  mainGone: string | null;
  expired: boolean;
  noResponse: boolean;
  timedOut: boolean;
  cutByUs: boolean;
  /** The row of its id is in the buffer (written before its siteAdmit). */
  kept: boolean;
  /** Its request paused after its preflight (it is being released). */
  mainPaused: boolean;
  /** The wait for its request after the preflight's answer is running. */
  mainWaited: boolean;
  timers: Set<NodeJS.Timeout>;
  limitTimer: NodeJS.Timeout | null;
  requestTimerArmed: boolean;
  done: boolean;
  ended: Promise<void>;
  end: () => void;
}

/** How an operation ended, before it is told. */
interface End {
  status: number | null;
  headers: Array<{ name: string; value: string }>;
  /** The answer was the preflight's (owner decision №1). */
  preflightAnswer: boolean;
  /** The body is whole (null: no body to keep). */
  whole: boolean | null;
  /** The answer has no body (a redirect answered as final): an empty one is
   *  kept, whole. */
  empty?: boolean;
  error: string | null;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value!);
}

function header(headers: Record<string, string> | Array<{ name: string; value: string }>, name: string): string | null {
  if (Array.isArray(headers)) return headers.find((entry) => entry.name.toLowerCase() === name)?.value ?? null;
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return null;
}

/** The session a request's own headers carry, or null. */
export function sessionOfHeaders(headers: Record<string, string>): string | null {
  const authorization = header(headers, "authorization");
  if (authorization === null || authorization === "") return null;
  return sessionFingerprint(authorization, header(headers, "fansly-client-id") ?? "");
}

/** The request's key: its method and URL without the fragment. */
function keyOf(method: string, url: string): string {
  return `${method.toUpperCase()} ${url.split("#", 1)[0]}`;
}

/** When a physical request left: Chrome's moment, never earlier than the
 *  gate's first bytes of it. */
function sendMoment(phys: Physical | null): number | null {
  if (phys === null) return null;
  const known = [phys.timingMono, phys.firstBytesMono].filter((mono): mono is number => mono !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

export class SiteRequests {
  readonly documents: Documents;
  readonly #deps: SiteDeps;
  #timings: SiteTimings;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #ops = new Map<string, SiteOp>();
  readonly #byNetwork = new Map<string, string>();
  /** Operations whose preflight went, waiting for their request, by key. */
  readonly #awaitingMain = new Map<string, string[]>();
  /** The session each network request's events come on (where its stream
   *  is armed). */
  readonly #sessionOf = new Map<string, string>();
  readonly #sessionWaiters = new Map<string, Array<() => void>>();
  /** Preflights that passed: their answers are handed on by fulfill. */
  readonly #passedPreflights = new Map<string, true>();
  /** Requests that passed, for the journal's line at their end. */
  readonly #passed = new Map<string, { line: Omit<RequestLine, "decision" | "result" | "admission">; startMono: number }>();
  /** Ids of operations that ended, for the late answers. */
  readonly #gone = new Map<string, string>();
  /** Writes refused, tried again. */
  readonly #retries = new Map<string, { make: () => GroupItem[]; tries: number; timer: NodeJS.Timeout | null }>();
  #closed = false;

  constructor(deps: SiteDeps) {
    this.#deps = deps;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#now = deps.now ?? monoMs;
    this.#log = deps.log ?? makeLog("site");
    this.documents = new Documents(deps.cdp);
    this.documents.onReplaced = () => this.#failReplaced();
    this.documents.onPreflight = (preflightId, requestId) => {
      // The request of an operation that began with this preflight: its end
      // is the operation's, whichever of the two Chrome told of first.
      const op = this.#opOf(preflightId);
      if (op !== null && !op.done && op.firstRole === "preflight" && op.roles.get(preflightId) === "preflight") this.#own(op, requestId, "main");
    };
    const cdp = deps.cdp;
    cdp.on("Network.requestWillBeSent", (event) => this.#onWillBeSent(event));
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => this.#onExtraInfo(event));
    cdp.on("Network.responseReceived", (event) => this.#onResponseReceived(event));
    cdp.on("Network.responseReceivedExtraInfo", (event) => this.#onResponseExtraInfo(event));
    cdp.on("Network.dataReceived", (event) => this.#onData(event));
    cdp.on("Network.loadingFinished", (event) => this.#onFinished(event));
    cdp.on("Network.loadingFailed", (event) => this.#onFailed(event));
  }

  /** Operations in flight (tests, diagnostics). */
  get live(): number {
    return this.#ops.size;
  }

  /** The wait for an admission (the engine's params, spec §8.2). */
  setTimings(admitWaitMs: number, requestLimitMs: number): void {
    this.#timings = { ...this.#timings, admitWaitMs: Math.min(120_000, Math.max(500, admitWaitMs)), requestLimitMs: Math.min(120_000, Math.max(1000, requestLimitMs)) };
  }

  // ── the interception ───────────────────────────────────────────────────

  /** A paused request of the site: what the map says of it, or held for
   *  the engine. At the response stage: one of this path's, or null. */
  decide(request: PausedRequest): PausedDecision | null {
    if (request.stage === "response") {
      if (request.networkId !== null && this.#passedPreflights.delete(request.networkId)) {
        const response = request.response;
        if (response === null || response.status === null) return { action: "fail", reason: "Failed", why: `a passed preflight's network error: ${response?.errorReason ?? "?"}` };
        return { action: "fulfill", status: response.status, headers: response.headers, body: "", why: "a passed request's preflight answer, handed on", ...(response.statusText ? { phrase: response.statusText } : {}) };
      }
      const op = this.#opOf(request.networkId);
      if (op === null) return null;
      if (op.done) return { action: "fail", reason: "Aborted", why: "the response of a site request that ended" };
      op.held.add(request);
      queueMicrotask(() => void this.#onResponse(op, request));
      return { action: "hold" };
    }
    const preflight = isPreflight(request);
    const method = preflight ? (header(request.headers, "access-control-request-method") ?? "").toUpperCase() : request.method;
    const verdict = mapDecide({ method, url: request.url, resourceType: request.resourceType }, this.#deps.mode());
    // The live session, from the site's own API requests as they stop
    // (hub-requests/session.ts) — a closed one's headers are the site's too.
    if (!preflight && this.#hostClass(request.url) === "api") this.#deps.session.note(request);
    switch (verdict.action) {
      case "pass":
        return this.#pass(request, verdict, preflight);
      case "refuse":
        return { action: "fail", reason: "BlockedByClient", why: `${verdict.why} (${verdict.rule})` };
      case "socket":
        return { action: "fail", reason: "BlockedByClient", why: "the socket host serves sockets only: each is admitted at the proxy" };
      case "preflight":
        return { action: "fail", reason: "BlockedByClient", why: "an OPTIONS that is no CORS preflight: nothing in the map opens it" };
      case "admit":
        break;
    }
    if (!preflight) {
      const waiting = this.#takeAwaiting(request.networkId, keyOf(request.method, request.url));
      if (waiting !== null) {
        waiting.held.add(request);
        if (request.networkId !== null) this.#own(waiting, request.networkId, "main");
        queueMicrotask(() => void this.#onMainPaused(waiting, request));
        return { action: "hold" };
      }
    }
    const notUp = this.#notAdmitting();
    if (notUp !== null) return { action: "fail", reason: "Failed", why: `no admission: ${notUp}` };
    // Its answer and its end are Chrome's to report by this id.
    if (request.networkId === null) return { action: "fail", reason: "Failed", why: "no admission: Chrome gave the request no network id to follow it by" };
    this.#begin(request, preflight ? "preflight" : "main", method, verdict);
    return { action: "hold" };
  }

  /** What the journal says of a site request's pause (null: not one of
   *  this path's operations). */
  describe(request: PausedRequest): string | null {
    const op = this.#opOf(request.networkId) ?? [...this.#ops.values()].find((entry) => entry.first === request) ?? null;
    if (op === null) return null;
    return `site request ${op.id}${op.attemptId === null ? "" : ` (attempt ${op.attemptId})`}${isPreflight(request) ? " (preflight)" : ""}`;
  }

  /** The gate's events of the site's windows. */
  onGateEvent(event: GateEvent): void {
    const match = event.window === null ? null : WINDOW.exec(event.window);
    if (!match) return;
    const op = this.#ops.get(match[1]!);
    if (!op || op.done) return;
    const phys = match[2] === "preflight" ? op.preflight : op.main;
    switch (event.kind) {
      case "first_bytes": {
        const last = this.#deps.gate.lastSend;
        if (phys) phys.firstBytesMono = last?.mono ?? this.#now();
        if (op.sentWall === null) {
          op.sentWall = last?.wall ?? wallMs();
          op.connectionReused = event.detail.newTunnel !== true;
        }
        this.#restartLimit(op);
        return;
      }
      case "announced":
        this.#restartLimit(op);
        return;
      case "expired":
        op.expired = true;
        return;
      case "no_response":
        op.noResponse = true;
        return;
      default:
        return;
    }
  }

  // ── the engine ─────────────────────────────────────────────────────────

  /** The engine's answer to a `siteAdmit`. */
  onAdmitResult(result: SiteAdmitResult): void {
    const op = this.#ops.get(result.siteRequestId);
    if (!op || op.done || op.stage !== "asked" || op.askedEpoch !== this.#deps.link.epoch()) {
      const gone = this.#gone.get(result.siteRequestId);
      const why = op ? (op.done ? "its request ended" : `its request is ${op.stage}${op.askedEpoch !== this.#deps.link.epoch() ? " on another connection" : ""}`) : gone !== undefined ? `its request had ended (${gone})` : "no site request waits for this admission";
      this.#log("admit.late", { siteRequestId: result.siteRequestId, admit: result.admit, why });
      // An admission given to nothing ends at once: the engine must not wait
      // for a request that is not there.
      if (result.admit && !(op && !op.done && op.attemptId === result.attemptId)) {
        const done = this.#siteDone(result.siteRequestId, result.attemptId, null, { status: null, headers: [], preflightAnswer: false, whole: null, error: `not used: ${why}` });
        this.#write(`late:${result.attemptId}`, () => [{ outcome: done }], done);
      }
      return;
    }
    if (!result.admit) {
      this.#log("admit.refused", { siteRequestId: op.id, reason: result.reason });
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `refused by the engine: ${result.reason}` });
      return;
    }
    op.attemptId = result.attemptId;
    op.generation = result.ownerGeneration;
    op.deadline = result.deadlineMono;
    op.stage = "admitted";
    const unusable = this.#unusable(op);
    if (unusable !== null) {
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `not used: ${unusable}` });
      return;
    }
    // Written before the release: an operator that starts again tells the
    // engine it may have gone.
    const kept = this.#deps.buffer.changeSiteRequest({ siteRequestId: op.id, released: { attemptId: result.attemptId } });
    if (!kept.ok) {
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `not used: the admission could not be kept (${kept.reason})` });
      return;
    }
    void kept.durable.then((durable) => {
      if (op.done || op.stage !== "admitted") return;
      if (!durable.ok) {
        this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `not used: the admission could not be kept (${durable.reason})` });
        return;
      }
      void this.#release(op, op.first, op.firstRole);
    });
  }

  /** The engine's link came up or went: what it had not answered is asked
   *  again on the new one (spec §6.2) — or waits for one. */
  linkChanged(up: boolean): void {
    const waiting = [...this.#ops.values()].filter((op) => !op.done && (op.stage === "asked" || op.stage === "waiting")).sort((a, b) => a.pausedMono - b.pausedMono);
    for (const op of waiting) {
      op.stage = "waiting";
      op.askedEpoch = null;
      if (up) this.#ask(op);
    }
  }

  /** A new owner of the page (plan §4.7): an earlier owner's admitted
   *  request not released yet never goes; the released ones end (their
   *  limits hold them to it). Settles once none of them is left. */
  async quiesce(generation: number): Promise<void> {
    const ending: Array<Promise<void>> = [];
    for (const op of [...this.#ops.values()]) {
      if (op.done || op.attemptId === null || op.generation >= generation) continue;
      if (op.stage === "released") ending.push(op.ended);
      else this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: "not used: a new owner of the page" });
    }
    await Promise.all(ending);
  }

  /** The engine's recover asks of an attempt: `not_sent` of an admission
   *  not released (from now on it never is), `unknown` of a released one;
   *  null: not a site request's. */
  recoverState(attemptId: number): "not_sent" | "unknown" | null {
    for (const op of this.#ops.values()) {
      if (op.attemptId !== attemptId || op.done) continue;
      if (op.stage === "released") return "unknown";
      op.recoveredNotSent = true;
      return "not_sent";
    }
    return null;
  }

  /** The page stops, or its browser goes (the exit is closed already):
   *  every request of the site ends — a released one as sent when anything
   *  of it may have left — and nothing waits any more. */
  endAll(reason: string, browserGone = true): void {
    for (const op of [...this.#ops.values()]) {
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `the page stopped: ${reason}` });
    }
    this.#awaitingMain.clear();
    if (browserGone) {
      this.documents.reset();
      this.#byNetwork.clear();
      this.#sessionOf.clear();
      this.#passed.clear();
      this.#passedPreflights.clear();
      for (const waiters of this.#sessionWaiters.values()) for (const wake of waiters) wake();
      this.#sessionWaiters.clear();
    }
  }

  /** The operator started, its holder's first delivery behind it: the
   *  site requests the previous operator left in the buffer end — an
   *  admitted one with `siteDone` (sent if it was released: nothing tells
   *  more), one never admitted quietly — each in one commit. */
  afterRestart(): void {
    for (const kept of this.#deps.buffer.siteRequests()) {
      if (this.#ops.has(kept.siteRequestId)) continue;
      const gone: GroupItem = { siteRequest: { siteRequestId: kept.siteRequestId, gone: true } };
      if (kept.attemptId === null) {
        this.#write(`restart:${kept.siteRequestId}`, () => [gone], null);
        continue;
      }
      const done: SiteDone = {
        type: "siteDone",
        siteRequestId: kept.siteRequestId,
        attemptId: kept.attemptId,
        sent: kept.released,
        sentMono: null,
        sentWall: null,
        connectionReused: null,
        status: null,
        retryAfter: null,
        error: { afterSendStart: kept.released, message: kept.released ? "the operator started again after its release: whether it went and its answer are not known" : "the operator started again before its release" },
        body: "not_platform_data",
      };
      this.#log("restart.ended", { siteRequestId: kept.siteRequestId, attemptId: kept.attemptId, released: kept.released });
      this.#write(`restart:${kept.siteRequestId}`, () => [{ outcome: done }, gone], done);
    }
  }

  /** The buffer has room again: refused writes go now. */
  retryNow(): void {
    for (const [key, retry] of this.#retries) {
      if (retry.timer) clearTimeout(retry.timer);
      retry.timer = null;
      this.#tryWrite(key);
    }
  }

  close(): void {
    this.#closed = true;
    for (const retry of this.#retries.values()) if (retry.timer) clearTimeout(retry.timer);
    this.#retries.clear();
  }

  // ── the steps ──────────────────────────────────────────────────────────

  #notAdmitting(): string | null {
    const notUp = this.#deps.notUp();
    if (notUp !== null) return notUp;
    const refusal = this.#deps.buffer.refusal();
    return refusal === null ? null : `the buffer takes no writes (${refusal})`;
  }

  #pass(request: PausedRequest, verdict: Extract<MapDecision, { action: "pass" }>, preflight: boolean): PausedDecision {
    const notUp = this.#deps.notUp();
    if (notUp !== null) return { action: "fail", reason: "BlockedByClient", why: `not now: ${notUp}` };
    if (request.networkId !== null) {
      const { host, path } = hostAndPath(request.url);
      remember(this.#passed, request.networkId, { line: { method: request.method, host, path, resourceType: request.resourceType }, startMono: this.#now() });
    }
    this.#log("pass", { rule: verdict.rule, preflight });
    if (preflight && request.networkId !== null) {
      remember(this.#passedPreflights, request.networkId, true);
      return { action: "continue", params: { interceptResponse: true } };
    }
    return { action: "continue" };
  }

  #hostClass(url: string): string {
    try {
      return classifyHost(new URL(url).hostname);
    } catch {
      return "denied";
    }
  }

  #begin(request: PausedRequest, role: Role, method: string, verdict: Extract<MapDecision, { action: "admit" }>): void {
    const id = randomUUID();
    const now = this.#now();
    let end: () => void = () => undefined;
    const url = new URL(request.url);
    const own = role === "main" ? sessionOfHeaders(request.headers) : null;
    const op: SiteOp = {
      id,
      key: keyOf(method, request.url),
      method: method.toUpperCase(),
      url,
      resourceType: request.resourceType,
      route: verdict.route,
      operation: verdict.operation,
      platformData: verdict.platformData && verdict.operation === "read",
      rule: verdict.rule,
      fingerprint: role === "main" ? own : this.#deps.session.fingerprint(),
      ownFingerprint: own,
      pausedMono: now,
      waitDeadline: now + this.#timings.admitWaitMs,
      stage: "keeping",
      askedEpoch: null,
      attemptId: null,
      generation: 0,
      deadline: null,
      first: request,
      firstRole: role,
      document: this.documents.mark(request),
      held: new Set([request]),
      preflight: null,
      main: null,
      roles: new Map(),
      capture: null,
      sentWall: null,
      connectionReused: null,
      responseSeen: false,
      fromCache: false,
      fromServiceWorker: false,
      wireStatus: null,
      recoveredNotSent: false,
      mainGone: null,
      expired: false,
      noResponse: false,
      timedOut: false,
      cutByUs: false,
      kept: false,
      mainPaused: false,
      mainWaited: false,
      timers: new Set(),
      limitTimer: null,
      requestTimerArmed: false,
      done: false,
      ended: new Promise<void>((resolve) => (end = resolve)),
      end: () => end(),
    };
    this.#ops.set(id, op);
    if (request.networkId !== null) this.#own(op, request.networkId, role);
    const requestId = role === "preflight" ? this.documents.requestOf(request.networkId) : null;
    if (requestId !== null) this.#own(op, requestId, "main");
    this.#log("pause", { siteRequestId: id, role, method: op.method, route: op.route, operation: op.operation });
    // The body's stream, armed now, before the admission is asked.
    if (role === "main" && op.platformData) op.capture = this.#arm(op, request);
    this.#timer(op, this.#timings.admitWaitMs, () => {
      if (op.stage === "keeping" || op.stage === "waiting" || op.stage === "asked") this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `no admission within ${this.#timings.admitWaitMs} ms` });
    });
    // Its id in the buffer, durably, before the engine is asked.
    const kept = this.#deps.buffer.changeSiteRequest({ siteRequestId: id, asked: true });
    if (!kept.ok) {
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `no admission: the buffer takes no writes (${kept.reason})` });
      return;
    }
    void kept.durable.then((durable) => {
      if (durable.ok) op.kept = true;
      if (op.done) {
        // It ended before its id was durable: the id goes now.
        if (durable.ok) this.#write(`gone:${op.id}`, () => [{ siteRequest: { siteRequestId: op.id, gone: true } }], null);
        return;
      }
      if (!durable.ok) {
        this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `no admission: the buffer takes no writes (${durable.reason})` });
        return;
      }
      if (op.stage === "keeping") {
        op.stage = "waiting";
        this.#ask(op);
      }
    });
  }

  #ask(op: SiteOp): void {
    const link = this.#deps.link;
    if (op.done || op.stage !== "waiting" || !link.up()) return;
    const notUp = this.#notAdmitting();
    if (notUp !== null) {
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `no admission: ${notUp}` });
      return;
    }
    const message: SiteAdmit = {
      type: "siteAdmit",
      siteRequestId: op.id,
      method: op.method,
      host: op.url.hostname,
      path: op.url.pathname,
      query: op.url.search,
      resourceType: op.resourceType,
      route: op.route,
      operation: op.operation,
      sessionFingerprint: op.fingerprint,
      pausedMono: op.pausedMono,
      waitDeadlineMono: op.waitDeadline,
    };
    if (!link.send(message)) return;
    op.stage = "asked";
    op.askedEpoch = link.epoch();
    this.#log("admit.asked", { siteRequestId: op.id, route: op.route });
  }

  /** Why an admitted operation may not go on, or null. */
  #unusable(op: SiteOp): string | null {
    if (op.deadline === null || !(op.deadline > this.#now())) return "the admission came expired";
    if (op.recoveredNotSent) return "the engine's recover closed it as not sent";
    if (op.generation < this.#deps.link.generation()) return "an earlier owner's admission";
    if (this.documents.replaced(op.document)) return "its document was replaced while it waited";
    return this.#notAdmitting();
  }

  async #onMainPaused(op: SiteOp, request: PausedRequest): Promise<void> {
    if (op.done) return this.#failHeld(op, request, "Aborted", "its operation ended");
    op.ownFingerprint = sessionOfHeaders(request.headers);
    if (op.platformData) op.capture = this.#arm(op, request);
    await op.capture?.arming;
    return this.#release(op, request, "main");
  }

  /** One physical request of an admitted operation goes. */
  async #release(op: SiteOp, request: PausedRequest, role: Role): Promise<void> {
    if (op.done) return this.#failHeld(op, request, "Aborted", "its operation ended");
    if (role === "main") await op.capture?.arming;
    if (op.done) return this.#failHeld(op, request, "Aborted", "its operation ended");
    const sent = this.#sent(op);
    let why = this.#unusable(op);
    if (why === null && role === "main" && op.fingerprint !== null && op.ownFingerprint !== null && op.ownFingerprint !== op.fingerprint) why = "the session changed between the admission and the request";
    if (why !== null) {
      op.held.add(request);
      return this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: sent ? `its request did not go: ${why}` : `not used: ${why}` });
    }
    const phys: Physical = { role, networkId: request.networkId, window: `site:${op.id}:${role}`, released: false, answered: false, ended: false, firstBytesMono: null, timingMono: null, status: null, headers: [] };
    // The window right before the release (spec §9).
    const opened = this.#deps.gate.open(phys.window, op.deadline!, request.bodyBytes);
    if (!opened.ok) {
      op.held.add(request);
      return this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: `the gate refused the request: ${opened.reason}` });
    }
    if (role === "preflight") op.preflight = phys;
    else op.main = phys;
    phys.released = true;
    op.stage = "released";
    if (role === "preflight") this.#await(op);
    if (op.limitTimer === null) this.#restartLimit(op);
    this.#armRequestDeadline(op);
    op.held.delete(request);
    this.#log("release", { siteRequestId: op.id, attemptId: op.attemptId, role });
    const resolution = await this.#deps.resolve(request, { action: "continue", params: { interceptResponse: true } });
    if (resolution === "refused" && !op.done) {
      // The pause was gone (the page dropped the request): it never left.
      phys.released = false;
      this.#deps.gate.close(phys.window);
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: "the request was gone before its release" });
    }
  }

  async #onResponse(op: SiteOp, request: PausedRequest): Promise<void> {
    const role = request.networkId === null ? undefined : op.roles.get(request.networkId);
    const phys = role === "preflight" ? op.preflight : role === "main" ? op.main : null;
    if (phys !== null) this.#deps.gate.responding(phys.window);
    const response = request.response;
    if (op.done || phys === null || !phys.released || phys.ended || response === null) return this.#failHeld(op, request, "Aborted", "a response of a site request that ended");
    if (response.status === null) return this.#failHeld(op, request, "Failed", `a network error at the response stage: ${response.errorReason ?? "?"}`);
    phys.answered = true;
    phys.status = response.status;
    phys.headers = response.headers;
    op.held.delete(request);
    const phrase = response.statusText ? { phrase: response.statusText } : {};
    if (phys.role === "preflight") {
      await this.#deps.resolve(request, { action: "fulfill", status: response.status, headers: response.headers, body: "", why: "a site request's preflight answer, handed on", ...phrase });
      if (op.done) return;
      // The preflight's end, by the sender's word (Chrome 155 tells no other
      // of one handed on so).
      phys.ended = true;
      this.#deps.gate.close(phys.window);
      if (op.mainGone !== null) return this.#afterPreflight(op, op.mainGone);
      this.#awaitMain(op);
      return;
    }
    const location = header(response.headers, "location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      // Never followed (stage 1, amendment 16): the page gets it as final,
      // without its Location; the answer is the redirect.
      op.capture?.writer?.abandon();
      if (op.capture) op.capture.writer = null;
      this.#finish(op, { status: response.status, headers: response.headers, preflightAnswer: false, whole: true, empty: true, error: null });
      await this.#deps.resolve(request, { action: "fulfill", status: response.status, headers: response.headers.filter((entry) => entry.name.toLowerCase() !== "location"), body: "", why: "a site request's redirect, answered as final", ...phrase });
      return;
    }
    const capture = op.capture;
    if (capture !== null && !capture.armed && capture.broken === null) {
      // Not armed at the request stage: now, before a byte of the body
      // reaches the page.
      await this.#armNow(op, capture, request.networkId);
      if (!capture.armed) capture.broken ??= "the body's stream could not be armed";
    }
    if (op.done) {
      await this.#deps.resolve(request, { action: "fail", reason: "Aborted", why: "its operation ended" });
      return;
    }
    await this.#deps.resolve(request, { action: "continueResponse" });
  }

  // ── the body's stream ──────────────────────────────────────────────────

  /** A capture for the request's body, its stream armed now (before the
   *  admission is asked): settles once armed, or not. */
  #arm(op: SiteOp, request: PausedRequest): Capture {
    const writer = this.#deps.buffer.beginBody();
    const capture: Capture = { writer, sealed: null, armed: false, arming: null, decoded: 0, encoded: 0, broken: writer === null ? "the buffer cannot keep a body" : null };
    if (writer === null) return capture;
    capture.arming = this.#armNow(op, capture, request.networkId, this.#timings.armWaitMs);
    return capture;
  }

  async #armNow(op: SiteOp, capture: Capture, networkId: string | null, waitMs = 0): Promise<void> {
    if (networkId === null || capture.writer === null) return;
    let session = this.#sessionOf.get(networkId);
    if (session === undefined && waitMs > 0) session = await this.#sessionOfSoon(networkId, waitMs);
    if (session === undefined || op.done) return;
    try {
      const armed = await this.#deps.cdp.send<{ bufferedData?: string }>("Network.streamResourceContent", { requestId: networkId }, session);
      if (op.done) return;
      capture.armed = true;
      if (typeof armed.bufferedData === "string" && armed.bufferedData !== "") this.#append(op, capture, Buffer.from(armed.bufferedData, "base64"), null, 0);
    } catch (error) {
      this.#log("body.arm_failed", { siteRequestId: op.id, error: errorMessage(error) });
    }
  }

  #sessionOfSoon(networkId: string, waitMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        resolve(this.#sessionOf.get(networkId));
      };
      timer = setTimeout(() => {
        const waiters = this.#sessionWaiters.get(networkId)?.filter((other) => other !== wake) ?? [];
        if (waiters.length === 0) this.#sessionWaiters.delete(networkId);
        else this.#sessionWaiters.set(networkId, waiters);
        resolve(undefined);
      }, waitMs);
      this.#sessionWaiters.set(networkId, [...(this.#sessionWaiters.get(networkId) ?? []), wake]);
    });
  }

  #append(op: SiteOp, capture: Capture, data: Buffer, announced: number | null, encoded: number): void {
    if (op.done || capture.writer === null) return;
    if (announced !== null && data.length !== announced) capture.broken ??= `a chunk of ${data.length} bytes said ${announced}`;
    if (!capture.writer.write(data)) capture.broken ??= `the body could not be written: ${capture.writer.error ?? "?"}`;
    capture.decoded += data.length;
    capture.encoded += encoded;
  }

  /** Is the body whole? `ended`: by loadingFinished, or by a cancel after
   *  the answer (a body the page read as a stream, stage 1, amendment 8). */
  #whole(op: SiteOp, ended: "finished" | "canceled"): boolean {
    const capture = op.capture;
    if (capture === null || capture.writer === null || !capture.armed || capture.broken !== null) return false;
    if (ended === "finished") return true;
    const headers = op.main?.headers ?? [];
    const encoding = (header(headers, "content-encoding") ?? "identity").trim().toLowerCase();
    const declared = header(headers, "content-length");
    if (encoding === "identity" && declared !== null && /^\d+$/.test(declared.trim())) return capture.decoded === Number(declared.trim());
    if (capture.decoded === 0 || capture.decoded > SHAPE_CHECK_MAX) return false;
    // A whole JSON object or array: no proper prefix of one is one.
    const text = this.#readWritten(capture);
    if (text === null) return false;
    const first = text.trimStart()[0];
    if (first !== "{" && first !== "[") return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  /** What was written of a body so far (sealed now: it is read whole). */
  #readWritten(capture: Capture): string | null {
    const writer = capture.writer;
    if (writer === null) return null;
    const sealed = writer.seal();
    capture.writer = null;
    if (sealed === null) return null;
    capture.sealed = sealed;
    const data = this.#deps.buffer.readBody(sealed.bodyId, 0, Math.max(1, sealed.bytes));
    return data === null ? null : data.toString("utf8");
  }

  // ── the network's events ───────────────────────────────────────────────

  #onWillBeSent(event: CdpEvent): void {
    const networkId = (event.params as { requestId?: unknown }).requestId;
    if (typeof networkId !== "string" || event.sessionId === undefined) return;
    remember(this.#sessionOf, networkId, event.sessionId);
    const waiters = this.#sessionWaiters.get(networkId);
    if (waiters) {
      this.#sessionWaiters.delete(networkId);
      for (const wake of waiters) wake();
    }
  }

  #onExtraInfo(event: CdpEvent): void {
    const found = this.#physical((event.params as { requestId?: unknown }).requestId);
    if (found?.phys.released) this.#deps.gate.announced(found.phys.window);
  }

  #onResponseReceived(event: CdpEvent): void {
    const params = event.params as {
      requestId?: unknown;
      response?: { timing?: { requestTime?: number; sendStart?: number }; fromDiskCache?: boolean; fromServiceWorker?: boolean; fromPrefetchCache?: boolean; connectionReused?: boolean };
    };
    const found = this.#physical(params.requestId);
    if (!found) return;
    const { op, phys } = found;
    const timing = params.response?.timing;
    if (timing && typeof timing.requestTime === "number" && typeof timing.sendStart === "number" && timing.sendStart >= 0) phys.timingMono = timing.requestTime * 1000 + timing.sendStart;
    if (phys.released) this.#deps.gate.responding(phys.window);
    if (phys.role !== "main") return;
    op.responseSeen = true;
    op.fromCache = params.response?.fromDiskCache === true || params.response?.fromPrefetchCache === true;
    op.fromServiceWorker = params.response?.fromServiceWorker === true;
    if (op.connectionReused === null && typeof params.response?.connectionReused === "boolean") op.connectionReused = params.response.connectionReused;
  }

  #onResponseExtraInfo(event: CdpEvent): void {
    const params = event.params as { requestId?: unknown; statusCode?: unknown };
    const found = this.#physical(params.requestId);
    if (found && found.phys.role === "main" && typeof params.statusCode === "number") found.op.wireStatus = params.statusCode;
  }

  #onData(event: CdpEvent): void {
    const params = event.params as { requestId?: unknown; dataLength?: number; encodedDataLength?: number; data?: string };
    const found = this.#physical(params.requestId);
    if (!found || found.phys.role !== "main") return;
    const { op } = found;
    const capture = op.capture;
    if (op.done || capture === null || capture.writer === null) return;
    const announced = Number(params.dataLength ?? 0);
    if (params.data === undefined) {
      // Data that passed without the stream: a hole in the body.
      if (announced > 0) capture.broken ??= "a chunk came without its data";
      return;
    }
    this.#append(op, capture, Buffer.from(params.data, "base64"), announced, Number(params.encodedDataLength ?? 0));
  }

  #onFinished(event: CdpEvent): void {
    const params = event.params as { requestId?: unknown; encodedDataLength?: unknown };
    if (typeof params.requestId === "string") this.#passedEnd(params.requestId, "finished", typeof params.encodedDataLength === "number" ? params.encodedDataLength : null);
    const found = this.#physical(params.requestId);
    if (!found) return;
    const { op, phys } = found;
    phys.ended = true;
    this.#deps.gate.close(phys.window);
    if (op.done || !phys.released) return;
    if (phys.role === "preflight") {
      this.#awaitMain(op);
      return;
    }
    this.#answered(op, op.capture === null ? null : this.#whole(op, "finished"));
  }

  #onFailed(event: CdpEvent): void {
    const params = event.params as { requestId?: unknown; errorText?: unknown; canceled?: unknown };
    if (typeof params.requestId === "string") this.#passedEnd(params.requestId, String(params.errorText ?? "failed"), null);
    const found = this.#physical(params.requestId);
    if (!found) return;
    const { op, phys } = found;
    phys.ended = true;
    this.#deps.gate.close(phys.window);
    if (op.done) return;
    const errorText = String(params.errorText ?? "");
    const canceled = params.canceled === true;
    if (!phys.released) {
      // Ended before its pause or release: the page aborted it, or Chrome's
      // CORS check after the preflight failed it.
      const why = `the request ended before it was released: ${errorText}`;
      if (phys.role === "main" && op.preflight !== null) {
        // Its preflight is in flight: the operation ends with its answer.
        if (!op.preflight.answered && !op.preflight.ended) {
          op.mainGone = why;
          return;
        }
        return this.#afterPreflight(op, why);
      }
      return this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: why });
    }
    if (phys.answered) {
      if (phys.role === "preflight") return;
      // The answer was in. A cancel after it is how a body read as a stream
      // ends (stage 1, amendment 8): whole if it proves so.
      if (canceled && !op.cutByUs) return this.#answered(op, op.capture === null ? null : this.#whole(op, "canceled"));
      return this.#answered(op, op.capture === null ? null : false, op.timedOut ? "the body did not finish within the request's limit" : `the body did not arrive whole: ${errorText}`);
    }
    const sent = this.#sent(op);
    if (canceled && !op.cutByUs) {
      // The page's word, not the sender's: Chrome may still hold the
      // request and write it in a later admission's window (amendment 37).
      // It dies with the browser: the page stops in the same turn.
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: "the page cancelled the request before its answer: the page stops" });
      this.#deps.fault("request_unended", `site request ${op.id}: the page cancelled a released request before its answer`);
      return;
    }
    if (op.expired && !sent) return this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: "not sent: the admission's deadline passed before the send" });
    const message = op.timedOut || op.noResponse ? (op.noResponse ? "no answer 20 s after the send" : "no answer within the request's limit") : errorText || "the request failed";
    return this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: message });
  }

  /** The journal's line at the end of a request that passed: its size and
   *  time (spec §2.1). */
  #passedEnd(networkId: string, how: string, bytes: number | null): void {
    const passed = this.#passed.get(networkId);
    if (passed === undefined) return;
    this.#passed.delete(networkId);
    this.#deps.journal({
      ...passed.line,
      admission: null,
      decision: "ended",
      result: how,
      bytes,
      durationMs: Math.round(this.#now() - passed.startMono),
    });
  }

  // ── outcomes ───────────────────────────────────────────────────────────

  /** The preflight was its operation's last word: a non-2xx answer to it
   *  is the operation's answer (owner decision №1). */
  #afterPreflight(op: SiteOp, why: string): void {
    const preflight = op.preflight;
    if (preflight?.answered && preflight.status !== null && (preflight.status < 200 || preflight.status > 299)) {
      this.#finish(op, { status: preflight.status, headers: preflight.headers, preflightAnswer: true, whole: null, error: null });
      return;
    }
    this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: why });
  }

  /** The request's answer came, and its end: `whole` of the body to keep
   *  (null: none to keep). */
  #answered(op: SiteOp, whole: boolean | null, why: string | null = null): void {
    const main = op.main;
    if (main === null || main.status === null) {
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: why ?? "the answer came without its status" });
      return;
    }
    if (why !== null) this.#log("body.not_whole", { siteRequestId: op.id, why });
    this.#finish(op, { status: main.status, headers: main.headers, preflightAnswer: false, whole, error: null });
  }

  /** Plan §4.2, step 8. */
  #source(op: SiteOp): ResponseSource {
    if (op.fromServiceWorker) return "service_worker";
    if (op.wireStatus === 304) return "revalidated_304";
    if (op.fromCache || !op.responseSeen) return "cache_unconfirmed";
    return "network";
  }

  #siteDone(siteRequestId: string, attemptId: number, op: SiteOp | null, end: End, body: SiteDone["body"] = "not_platform_data"): SiteDone {
    const sent = op === null ? false : this.#sent(op);
    const moments = op === null ? [] : [sendMoment(op.preflight), sendMoment(op.main)].filter((mono): mono is number => mono !== null);
    const sentMono = sent && moments.length > 0 ? Math.min(...moments) : null;
    return {
      type: "siteDone",
      siteRequestId,
      attemptId,
      sent,
      sentMono,
      sentWall: sent ? (op?.sentWall ?? null) : null,
      connectionReused: sent ? (op?.connectionReused ?? null) : null,
      status: end.status,
      retryAfter: end.status === null ? null : header(end.headers, "retry-after"),
      error: end.error === null ? null : { afterSendStart: sent, message: end.error },
      body,
    };
  }

  /** The operation's end: final, kept, and told once durable. */
  #finish(op: SiteOp, end: End): void {
    if (op.done) return;
    op.done = true;
    const stage = op.stage;
    op.stage = "done";
    for (const timer of op.timers) clearTimeout(timer);
    op.timers.clear();
    if (op.limitTimer) clearTimeout(op.limitTimer);
    op.limitTimer = null;
    for (const phys of [op.preflight, op.main]) if (phys) this.#deps.gate.close(phys.window);
    // A pause still held is failed: nothing of an ended operation goes.
    const failReason = end.error !== null && stage !== "released" ? "Failed" : "Aborted";
    for (const request of [...op.held]) void this.#failHeld(op, request, failReason, end.error ?? "its operation ended");
    this.#ops.delete(op.id);
    this.#dropAwaiting(op);
    remember(this.#gone, op.id, end.error ?? "it ended");
    op.end();
    // The body: whole and sealed, a mark, or none to keep.
    const capture = op.capture;
    let body: OutcomeBody | null = null;
    let ref: BodyRef = { bodyId: randomUUID(), decodedBytes: 0, sha256: EMPTY_SHA256 };
    const keep = op.platformData && end.status !== null && !end.preflightAnswer && op.attemptId !== null;
    let whole = keep && end.whole === true;
    if (keep && whole) {
      let sealed = end.empty ? null : (capture?.sealed ?? null);
      if (sealed === null && !end.empty && capture?.writer) {
        sealed = capture.writer.seal();
        capture.writer = null;
      }
      if (end.empty) sealed = this.#emptyBody();
      if (sealed) {
        body = { bodyId: sealed.bodyId, bytes: sealed.bytes };
        ref = { bodyId: sealed.bodyId, decodedBytes: sealed.bytes, sha256: sealed.sha256 };
      } else whole = false;
    }
    if (capture?.writer) capture.writer.abandon();
    if (capture?.sealed && body === null) this.#deps.buffer.removeBody(capture.sealed.bodyId);
    this.#log("end", { siteRequestId: op.id, attemptId: op.attemptId, status: end.status, sent: this.#sent(op), body: keep ? (whole ? "buffered" : "incomplete") : "none", error: end.error });
    this.#journalEnd(op, end, keep ? (whole ? "buffered" : "incomplete") : null);
    const gone: GroupItem = { siteRequest: { siteRequestId: op.id, gone: true } };
    if (op.attemptId === null) {
      // Never admitted: nothing to tell the engine (it drops what waits).
      if (op.kept) this.#write(`gone:${op.id}`, () => [gone], null);
      return;
    }
    const done = this.#siteDone(op.id, op.attemptId, op, end, keep ? (whole ? "buffered" : "incomplete") : "not_platform_data");
    const items: GroupItem[] = [];
    if (keep) {
      const fingerprint = op.ownFingerprint ?? NO_SESSION;
      items.push({
        event: {
          kind: "site.response",
          siteRequestId: op.id,
          attemptId: op.attemptId,
          route: op.route,
          method: op.method,
          path: op.url.pathname,
          query: op.url.search,
          status: end.status!,
          headers: engineHeaders(end.headers),
          body: ref,
          complete: whole,
          // A redirect ends here before Chrome tells of its response: the
          // gate's word that the request went up makes it the network's.
          source: end.empty ? (this.#sent(op) ? "network" : "cache_unconfirmed") : this.#source(op),
          sessionFingerprint: fingerprint,
        },
        ...(body ? { body } : {}),
      });
    }
    items.push({ outcome: done }, gone);
    const appended = this.#deps.buffer.appendGroup(items);
    const unkept = (reason: string) => {
      if (body !== null) this.#deps.buffer.removeBody(body.bodyId);
      this.#log("end.unkept", { siteRequestId: op.id, attemptId: op.attemptId, reason });
      // The engine hears from memory at once. What is written later, once
      // the buffer takes writes: the end, and — the body gone with the
      // refusal — the answer as a mark, never as a fact.
      const told: SiteDone = keep ? { ...done, body: "incomplete" } : done;
      this.#deps.link.send(told);
      const first = items[0];
      const mark: GroupItem[] = keep && first !== undefined && "event" in first ? [{ event: { ...first.event, body: { bodyId: randomUUID(), decodedBytes: 0, sha256: EMPTY_SHA256 }, complete: false } as typeof first.event }] : [];
      this.#retryLater(`end:${op.id}`, () => [...mark, { outcome: told }, gone]);
    };
    if (!appended.ok) return unkept(appended.reason);
    void appended.durable.then((durable) => {
      if (!durable.ok) unkept(durable.reason);
    });
  }

  #emptyBody(): { bodyId: string; bytes: number; sha256: string } | null {
    const writer = this.#deps.buffer.beginBody();
    return writer?.seal() ?? null;
  }

  #journalEnd(op: SiteOp, end: End, body: string | null): void {
    const { host, path } = hostAndPath(op.url.href);
    this.#deps.journal({
      method: op.method,
      host,
      path,
      resourceType: op.resourceType,
      admission: op.attemptId === null ? `site request ${op.id}, not admitted` : `site request ${op.id} (attempt ${op.attemptId})`,
      decision: "ended",
      result: end.error ?? `${end.status ?? "?"}${end.preflightAnswer ? " (its preflight's)" : ""}${body === null ? "" : `, body ${body}`}`,
      status: end.status,
      bytes: op.capture?.encoded ?? null,
      durationMs: Math.round(this.#now() - op.pausedMono),
    });
  }

  async #failHeld(op: SiteOp, request: PausedRequest, reason: "Aborted" | "Failed", why: string): Promise<void> {
    op.held.delete(request);
    await this.#deps.resolve(request, { action: "fail", reason, why });
  }

  /** Requests of replaced documents that wait are failed now: released
   *  later, Chrome would neither send them nor say they ended. */
  #failReplaced(): void {
    for (const op of [...this.#ops.values()]) {
      if (op.done || op.stage === "released" || !this.documents.replaced(op.document)) continue;
      this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: "not used: its document was replaced while it waited" });
    }
  }

  /** A write refused or failed is tried again with a growing pause, and at
   *  once when the buffer has room. `tell`: a siteDone the engine hears
   *  from memory if the first try is refused. */
  #write(key: string, make: () => GroupItem[], tell: SiteDone | null): void {
    const appended = this.#deps.buffer.appendGroup(make());
    if (appended.ok) {
      void appended.durable.then((durable) => {
        if (!durable.ok) this.#retryLater(key, make);
      });
      return;
    }
    if (tell !== null) this.#deps.link.send(tell);
    this.#retryLater(key, make);
  }

  #retryLater(key: string, make: () => GroupItem[]): void {
    if (this.#closed) return;
    const retry = this.#retries.get(key) ?? { make, tries: 0, timer: null };
    this.#retries.set(key, retry);
    if (retry.timer) return;
    const ladder = this.#timings.retryMs;
    retry.timer = setTimeout(() => {
      retry.timer = null;
      this.#tryWrite(key);
    }, ladder[Math.min(retry.tries, ladder.length - 1)] ?? 1000);
    retry.tries += 1;
  }

  #tryWrite(key: string): void {
    const retry = this.#retries.get(key);
    if (!retry || this.#closed) return;
    const appended = this.#deps.buffer.appendGroup(retry.make());
    if (!appended.ok) return this.#retryLater(key, retry.make);
    this.#retries.delete(key);
    void appended.durable.then((durable) => {
      if (!durable.ok) this.#retryLater(key, retry.make);
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  #own(op: SiteOp, networkId: string, role: Role): void {
    op.roles.set(networkId, role);
    remember(this.#byNetwork, networkId, op.id);
  }

  #opOf(networkId: string | null): SiteOp | null {
    if (networkId === null) return null;
    const id = this.#byNetwork.get(networkId);
    return id === undefined ? null : (this.#ops.get(id) ?? null);
  }

  #physical(networkId: unknown): { op: SiteOp; phys: Physical } | null {
    if (typeof networkId !== "string") return null;
    const op = this.#opOf(networkId);
    if (op === null) return null;
    const role = op.roles.get(networkId);
    const phys = role === "preflight" ? op.preflight : role === "main" ? op.main : null;
    if (phys !== null && phys.networkId === networkId) return { op, phys };
    if (role === undefined) return null;
    // A request of the operation not released (yet): its failure counts.
    return { op, phys: { role, networkId, window: `site:${op.id}:${role}`, released: false, answered: false, ended: false, firstBytesMono: null, timingMono: null, status: null, headers: [] } };
  }

  /** Did anything of the operation leave? The gate's word. */
  #sent(op: SiteOp): boolean {
    return op.preflight?.firstBytesMono != null || op.main?.firstBytesMono != null;
  }

  /** Its preflight went: its request goes under the same admission. */
  #await(op: SiteOp): void {
    this.#awaitingMain.set(op.key, [...(this.#awaitingMain.get(op.key) ?? []), op.id]);
  }

  /** The preflight was answered: its request follows soon, or never. */
  #awaitMain(op: SiteOp): void {
    if (op.done || op.main !== null || op.mainWaited) return;
    op.mainWaited = true;
    this.#timer(op, this.#timings.mainWaitMs, () => {
      if (op.main === null && !op.done && !op.mainPaused) this.#afterPreflight(op, "the request did not follow its preflight");
    });
  }

  /** The operation whose preflight went and whose request this is: by the
   *  id Chrome named at the preflight, else by its method and URL. */
  #takeAwaiting(networkId: string | null, key: string): SiteOp | null {
    const linked = this.#opOf(networkId);
    if (linked !== null && !linked.done && linked.firstRole === "preflight" && linked.main === null && linked.stage === "released" && !linked.mainPaused) {
      this.#dropAwaiting(linked);
      linked.mainPaused = true;
      return linked;
    }
    // Chrome named another operation's request, or none: never a guess
    // across operations.
    if (linked !== null) return null;
    const ids = this.#awaitingMain.get(key);
    if (!ids) return null;
    while (ids.length > 0) {
      const op = this.#ops.get(ids.shift()!);
      if (op && !op.done && op.main === null && op.stage === "released" && !op.mainPaused) {
        if (ids.length === 0) this.#awaitingMain.delete(key);
        op.mainPaused = true;
        return op;
      }
    }
    this.#awaitingMain.delete(key);
    return null;
  }

  #dropAwaiting(op: SiteOp): void {
    const ids = this.#awaitingMain.get(op.key);
    if (!ids) return;
    const left = ids.filter((id) => id !== op.id);
    if (left.length === 0) this.#awaitingMain.delete(op.key);
    else this.#awaitingMain.set(op.key, left);
  }

  /** The operation's limit: from its admission, again from each send. */
  #restartLimit(op: SiteOp): void {
    if (op.done) return;
    if (op.limitTimer) clearTimeout(op.limitTimer);
    op.limitTimer = setTimeout(() => this.#onLimit(op), this.#timings.opLimitMs);
  }

  /** Spec §3: an admitted request holds the one place in flight for 20 s;
   *  then its tunnels are cut — an answer whose body still comes ends with
   *  its body not whole; a request without one, when Chrome reports it. */
  #armRequestDeadline(op: SiteOp): void {
    if (op.requestTimerArmed) return;
    op.requestTimerArmed = true;
    this.#timer(op, this.#timings.requestLimitMs, () => {
      if (op.done) return;
      op.timedOut = true;
      op.cutByUs = true;
      this.#deps.cutApi("a site request past its limit");
      if (op.main?.answered) this.#answered(op, op.capture === null ? null : false, "the body did not finish within the request's limit");
    });
  }

  #onLimit(op: SiteOp): void {
    op.limitTimer = null;
    if (op.done) return;
    if (op.main?.answered) {
      op.cutByUs = true;
      this.#deps.cutApi("a site answer over its time limit");
      this.#answered(op, op.capture === null ? null : false, "the body did not finish within the operation's limit");
      return;
    }
    // No answer and no end: Chrome may still hold the request (amendment
    // 23). Decided first; the page stops in the same turn.
    this.#finish(op, { status: null, headers: [], preflightAnswer: false, whole: null, error: "no answer and no end of the request within its limit: the page stops" });
    this.#deps.fault("request_unended", `site request ${op.id}: no answer and no end within ${this.#timings.opLimitMs} ms`);
  }

  #timer(op: SiteOp, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      op.timers.delete(timer);
      run();
    }, Math.max(0, ms));
    op.timers.add(timer);
  }
}

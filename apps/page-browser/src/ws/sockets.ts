// The site's socket under the engine's admission (plan §3.2 «Кадры сокета»,
// §4.3, §4.4, §4.9; spec §2.3, §2.6, §6.1, §9; mandatory condition №3).
//
// The site opens its socket itself (wss://wsv3.fansly.com/?v=3); Hub's own
// socket for the page is off. What the operator does around it:
//
// Admission (stage 1, amendment 8). CDP does not intercept a socket's
// connection, and a socket could ride an open HTTP/2 connection, so the
// admission is at the proxy: every CONNECT to the socket host is one socket
// (any other request to that host is failed in the interception), and it
// waits there — before a single byte goes to Fansly — for the engine:
//  1. `wsAdmit` with a new connection id, the address and context CDP shows
//     for the oldest socket of the host waiting to connect, the live session
//     and the wait's end (`siteAdmitWaitMs`, 60 s). Nothing is asked when no
//     admission may be given: no engine heard for 5 s (plan §4.9 — what is
//     open stays open), the exit closed, the page not up, the buffer taking
//     no writes — or no live session of the site yet: the socket gate could
//     not let its authorization go (egress/socket-gate.ts), and a socket
//     before the login is of no use to Hub. The CONNECT is refused then.
//  2. `wsAdmitResult`: refused — the CONNECT is refused; admitted — with the
//     deadline still ahead, the tunnel opens and its handshake request may go
//     only before the deadline (egress/proxy.ts; spec §9). An answer counts
//     only on the engine connection it was asked on: a link that changes or
//     goes refuses every socket still waiting. An admission that finds its
//     CONNECT gone (Chrome dropped it, the wait ended) is closed at once with
//     `wsDone`, `sent: false`: the engine never waits for a socket that is
//     not there (stage 1, FINDINGS 27).
//  3. One admitted socket at a time is tied to its CDP socket: the proxy
//     knows the tunnel, CDP the socket, and nothing inside TLS tells which
//     is which. The engine admits one at a time (one `ws.connect` in
//     flight); the operator holds to it too — an admission while another
//     admitted socket is not tied yet is closed unused — so the socket that
//     sends its handshake (Network.webSocketWillSendHandshakeRequest) is the
//     admitted one.
//  4. `wsDone` — the handshake's outcome under the admission's attempt id:
//     sent or not (the proxy saw the request go up), when, the status (101
//     open; 401/403 stop the page for auth, 429 holds `ws.upgrade` — the
//     engine's rules), or the error. It is kept in the buffer until the
//     engine's resultAck and sent once durable (buffer/replay.ts). A tunnel
//     that ends after its request waits a moment for CDP's word on the
//     status: the proxy's end and CDP's answer travel apart.
//
// Frames (plan §4.4), from CDP's Network.webSocket* — not from the page's
// JS — into the buffer, in the order CDP gives them; each is durable before
// anything depends on it, and nothing of them is logged:
//  - `ws.open` at the 101: the connection id, the attempt id, the session's
//    fingerprint;
//  - `ws.in` — every incoming text frame as it is (Fansly's socket speaks
//    text; a binary frame is counted, not kept);
//  - `ws.close` when CDP says the socket closed — or when the browser goes
//    under it (CDP may never say): every connection that opened is closed.
//  - `gap` where frames may be missing (spec §6.1 reasons): `operator_start`
//    at every start of the operator, from the last event saved;
//    `chrome_restart` when a new Chrome starts after one that had a
//    connection; `ws_reconnect` before a connection that opens after another
//    one of the same Chrome closed — from that one's last event. A buffer
//    that fills up writes its own (`buffer_full`, `disk_full`).
//
// Each of those events is acknowledged to the CDP holder only once what it
// wrote is durable (the client's `holdAcks`): an operator that dies before
// gets it again from the holder. Every event carries the holder's message
// it was made of (`origin`, buffer.ts): one delivered again is not written
// twice. Its row is still there to be recognised: the acknowledgement is
// written to the holder in the turn its commit is heard, and the row goes
// only with the engine's ack of it, which no turn before that can bring. Its ws.open and ws.close also open and close the socket's row in
// the buffer, so a restarted operator finds the connection of a frame
// delivered again (it knows no admission of the previous one), and closes
// in the stream — before its `operator_start` gap — the connections the
// previous Chrome left open (`afterRestart`: that Chrome is gone).
//
// Outgoing messages, three layers:
//  1. the guard in the page (inpage/ws-guard.js) lets only spec §2.6's go
//     and reports the first other one: it never left, and the page stops
//     (`unknown_ws_message`, an alarm, the exit closed);
//  2. the socket gate in the proxy (egress/socket-gate.ts) — outside the
//     page's JavaScript, for a context the guard did not go into: every
//     record after the handshake must be one of spec §2.6's messages or
//     Chrome's own control frames by its size (the authorization's from the
//     live token, once); anything else is held, the tunnel cut, the page
//     killed, an alarm;
//  3. CDP's word on what did leave (Network.webSocketFrameSent) goes to the
//     journal as a shape — kind, opcode, size — and a message there that
//     should not have left (one of a size the gate could not tell apart)
//     means both were passed by: the same alarm, the page killed.

import { randomUUID } from "node:crypto";

import type { AppendOptions, Appended, EventBody, GapReason } from "../buffer/buffer.ts";
import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import type { SocketTicket, SocketTunnelEvent } from "../egress/proxy.ts";
import type { SocketLine } from "../logs/journal.ts";
import type { AlarmKind, WsAdmit, WsAdmitResult, WsDone } from "../rpc/protocol.ts";
import { makeLog, monoMs, urlForLogLine, wallMs, type Logger } from "../shared/util.ts";
import { messageKind, shapeFields, shapeOf, type GuardReport } from "./guard.ts";
import type { GuardTarget } from "./install.ts";

export interface SocketTimings {
  /** How long a socket's CONNECT waits for the engine (spec §8.2: 60 s). */
  admitWaitMs: number;
  /** After a tunnel that sent its request ends, how long CDP has to say
   *  how the handshake went. */
  handshakeGraceMs: number;
}

const DEFAULT_TIMINGS: SocketTimings = { admitWaitMs: 60_000, handshakeGraceMs: 2000 };

/** The buffer as the socket uses it. */
export interface SocketBuffer {
  append(event: EventBody, at?: { mono: number; wall: number }, options?: AppendOptions): Appended;
  markGap(reason: GapReason, from?: { seq: number | null; wall: number | null }): Appended;
  putOutcome(outcome: WsDone): Appended;
  /** A socket's connection open in the stream (committed), if any. */
  socketOf(key: string): { connectionId: string; attemptId: number } | null;
  openSockets(): Array<{ key: string; connectionId: string; attemptId: number }>;
  /** Everything accepted so far committed. */
  flush(): Promise<void>;
}

/** The events of the site's socket: their acknowledgement to the holder is
 *  this path's (`holdAcks`). */
const SOCKET_EVENTS = [
  "Network.webSocketCreated",
  "Network.webSocketWillSendHandshakeRequest",
  "Network.webSocketHandshakeResponseReceived",
  "Network.webSocketFrameReceived",
  "Network.webSocketFrameSent",
  "Network.webSocketFrameError",
  "Network.webSocketClosed",
] as const;

/** The engine, as the RPC has it. */
export interface SocketLink {
  send(message: WsAdmit | WsDone): boolean;
}

export type SocketStop = "unknown_ws_message" | "ws_guard_failed";

export interface SocketDeps {
  cdp: CdpPort;
  buffer: SocketBuffer;
  link: SocketLink;
  /** Why no socket may be admitted now, or null (operator.admissionsOpen). */
  notAdmitting: () => string | null;
  /** The live session of the site (hub-requests/session.ts). */
  sessionFingerprint: () => string | null;
  /** The bytes of the socket's authorization with the live token (the
   *  socket gate's rule); null: no live session. */
  authorizationBytes: () => number | null;
  /** A target's type by its session ("page", "iframe", "worker"...). */
  targetType: (sessionId: string | null) => string | null;
  /** Cuts one socket's tunnel (egress/proxy.ts). */
  cutTunnel: (connectionId: string, reason: string) => boolean;
  journal: (line: SocketLine) => void;
  alarm: (kind: AlarmKind, detail: Record<string, string | number | boolean>) => void;
  /** The page must stop: the exit is closed when this returns. */
  stop: (reason: SocketStop, note: string, how: "stop" | "kill") => void;
  timings?: Partial<SocketTimings>;
  /** CLOCK_MONOTONIC, ms (deadlines). */
  now?: () => number;
  log?: Logger;
}

/** A place in the stream: an event's number once durable, its wall time. */
interface Mark {
  seq: number | null;
  wall: number;
}

interface Admission {
  id: string;
  host: string;
  stage: "asking" | "admitted" | "done";
  askedMono: number;
  resolve: (deadline: number | null) => void;
  waitTimer: NodeJS.Timeout | null;
  generation: number;
  attemptId: number | null;
  /** The handshake request went up (the proxy's word). */
  handshake: { mono: number; wall: number } | null;
  /** The tunnel ended (the proxy's word): why. */
  tunnelEnded: string | null;
  graceTimer: NodeJS.Timeout | null;
  socket: CdpSocket | null;
  status: number | null;
  /** The live session when it was asked (there is always one then). */
  fingerprint: string;
  /** The extensions the server's answer negotiated (CDP's word), if any. */
  extensions: string | null;
}

/** A socket as CDP shows it. */
interface CdpSocket {
  key: string;
  url: string;
  host: string;
  context: WsAdmit["context"];
  createdMono: number;
  /** The admission asking for this socket's CONNECT (a guess: the url and
   *  context of `wsAdmit`). */
  guessedBy: string | null;
  admission: Admission | null;
  open: boolean;
  /** Its handshake went with no admission to tie it to: its frames cannot
   *  be kept. */
  lost: boolean;
}

/** Sockets and admissions remembered at most (a site that leaks them). */
const MAX_SOCKETS = 1000;
const MAX_GONE = 1000;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The extensions a handshake's answer negotiated (its header's value, cut
 *  short: a name and its parameters, nothing secret), or null. */
function extensionsOf(headers: unknown): string | null {
  if (headers === null || typeof headers !== "object") return null;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() === "sec-websocket-extensions" && typeof value === "string" && value !== "") return value.slice(0, 80);
  }
  return null;
}

function contextOf(type: string | null): WsAdmit["context"] {
  if (type === "iframe") return "frame";
  if (type === "worker" || type === "shared_worker" || type === "service_worker") return "worker";
  return "page";
}

export class SiteSockets {
  readonly #deps: SocketDeps;
  readonly #log: Logger;
  readonly #now: () => number;
  #timings: SocketTimings;
  /** Admissions asked or given and not answered with `wsDone` yet. */
  readonly #admissions = new Map<string, Admission>();
  /** Admissions that ended: why, and the attempt of one that was admitted.
   *  A late answer to one that never was is closed under its id; a repeated
   *  answer to one that was does nothing twice. */
  readonly #gone = new Map<string, { why: string; attemptId: number | null }>();
  readonly #sockets = new Map<string, CdpSocket>();
  /** The last event of the socket's stream (ws.open, ws.in, ws.close). */
  #last: Mark | null = null;
  /** A connection closed and no gap written since: from its last event. */
  #uncovered: Mark | null = null;
  /** A connection opened since the last gap mark. */
  #openedSinceGap = false;
  /** The operator's start (closes and its gap) is still to be written: the
   *  buffer was not open. */
  #startPending = false;
  #lastHandshake: { mono: number; wall: number } | null = null;
  #binaryFrames = 0;

  constructor(deps: SocketDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? makeLog("ws");
    this.#now = deps.now ?? monoMs;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    const cdp = deps.cdp;
    const handlers: Record<(typeof SOCKET_EVENTS)[number], (event: CdpEvent) => Promise<unknown> | null> = {
      "Network.webSocketCreated": (event) => this.#onCreated(event),
      "Network.webSocketWillSendHandshakeRequest": (event) => this.#onWillSendHandshake(event),
      "Network.webSocketHandshakeResponseReceived": (event) => this.#onHandshakeResponse(event),
      "Network.webSocketFrameReceived": (event) => this.#onFrameReceived(event),
      "Network.webSocketFrameSent": (event) => this.#onFrameSent(event),
      "Network.webSocketFrameError": (event) => this.#onFrameError(event),
      "Network.webSocketClosed": (event) => this.#onClosed(event),
    };
    for (const method of SOCKET_EVENTS) {
      cdp.holdAcks(method);
      cdp.on(method, (event) => this.#take(event, handlers[method]));
    }
  }

  /** One event of the socket: acknowledged to the holder once what it wrote
   *  is durable (or could not be written — the buffer's own gap covers it),
   *  at once when it wrote nothing. */
  #take(event: CdpEvent, handle: (event: CdpEvent) => Promise<unknown> | null): void {
    let durable: Promise<unknown> | null = null;
    try {
      durable = handle(event);
    } finally {
      const cdp = this.#deps.cdp;
      if (durable === null) cdp.ack(event.seq);
      else
        void durable.then(
          () => cdp.ack(event.seq, true),
          () => cdp.ack(event.seq, true),
        );
    }
  }

  /** The engine's wait for a socket's admission (its params). */
  setAdmitWait(ms: number): void {
    this.#timings = { ...this.#timings, admitWaitMs: Math.min(120_000, Math.max(500, ms)) };
  }

  /** The last handshake request that went up: a send of the page, for the
   *  takeover pause (`quiesced`). */
  get lastHandshake(): { mono: number; wall: number } | null {
    return this.#lastHandshake;
  }

  /** Connections open now (tests, diagnostics). */
  get openConnections(): number {
    return [...this.#sockets.values()].filter((socket) => socket.open).length;
  }

  /** Admissions waiting for the engine or for their handshake's outcome. */
  get pending(): number {
    return this.#admissions.size;
  }

  // ── the proxy's side ───────────────────────────────────────────────────

  /** A CONNECT to the socket host: its admission, or why it is refused. */
  admit(host: string, port: number): SocketTicket | string {
    const fingerprint = this.#deps.sessionFingerprint();
    const refused = this.#deps.notAdmitting() ?? (fingerprint === null || this.#deps.authorizationBytes() === null ? "no session of the site yet: its socket could not authorize" : null);
    if (refused !== null) {
      this.#log("admit.refused", { host, why: refused });
      this.#deps.journal({ connectionId: null, event: "refused", detail: `no admission asked: ${refused}` });
      return refused;
    }
    const id = randomUUID();
    const now = this.#now();
    const socket = this.#waitingSocket(host);
    let resolve: (deadline: number | null) => void = () => undefined;
    const granted = new Promise<number | null>((done) => (resolve = done));
    const admission: Admission = {
      id,
      host,
      stage: "asking",
      askedMono: now,
      resolve,
      waitTimer: null,
      generation: 0,
      attemptId: null,
      handshake: null,
      tunnelEnded: null,
      graceTimer: null,
      socket: null,
      status: null,
      fingerprint: fingerprint!,
      extensions: null,
    };
    if (socket !== null) socket.guessedBy = id;
    this.#admissions.set(id, admission);
    const wait = this.#timings.admitWaitMs;
    admission.waitTimer = setTimeout(() => this.#endAsk(admission, "the wait for the engine's admission is over"), wait);
    const url = socket?.url ?? `wss://${host}${port === 443 ? "" : `:${port}`}/`;
    const context = socket?.context ?? "page";
    this.#deps.link.send({ type: "wsAdmit", connectionId: id, url, context, sessionFingerprint: admission.fingerprint, requestedMono: now, waitDeadlineMono: now + wait });
    this.#log("admit.asked", { connectionId: id, url: urlForLogLine(url), context });
    this.#deps.journal({ connectionId: id, event: "asked", context, detail: urlForLogLine(url) });
    return { id, granted, event: (event) => this.#onTunnel(admission, event), rules: () => ({ authorizationBytes: this.#deps.authorizationBytes() }) };
  }

  // ── the engine ─────────────────────────────────────────────────────────

  /** The engine's answer to `wsAdmit`. */
  onAdmitResult(result: WsAdmitResult): void {
    const admission = this.#admissions.get(result.connectionId);
    if (!admission || admission.stage !== "asking") {
      const gone = this.#gone.get(result.connectionId);
      if (admission || (gone && gone.attemptId !== null)) {
        this.#log("admit.repeat", { connectionId: result.connectionId, admit: result.admit });
        return;
      }
      const why = gone?.why ?? "no socket waits for this admission";
      this.#log("admit.late", { connectionId: result.connectionId, admit: result.admit, why });
      // An admission given to nothing ends at once: the engine must not wait
      // for a socket that is not there.
      if (result.admit) this.#store({ type: "wsDone", connectionId: result.connectionId, attemptId: result.attemptId, sent: false, sentMono: null, status: null, error: `not used: ${why}` });
      return;
    }
    if (admission.waitTimer) clearTimeout(admission.waitTimer);
    admission.waitTimer = null;
    if (!result.admit) {
      this.#endAsk(admission, `refused by the engine: ${result.reason}`);
      return;
    }
    admission.generation = result.ownerGeneration;
    admission.attemptId = result.attemptId;
    admission.stage = "admitted";
    const now = this.#now();
    const unusable = !(result.deadlineMono > now)
      ? "the admission came expired"
      : (this.#deps.notAdmitting() ?? (this.#untiedOther(admission) ? "another admitted socket is not tied to its CDP socket yet" : null));
    if (unusable !== null) {
      this.#done(admission, { sent: false, status: null, error: `not used: ${unusable}` });
      admission.resolve(null);
      return;
    }
    this.#log("admit.admitted", { connectionId: admission.id, attemptId: result.attemptId, deadlineInMs: Math.round(result.deadlineMono - now) });
    this.#deps.journal({ connectionId: admission.id, event: "admitted", attemptId: result.attemptId });
    admission.resolve(result.deadlineMono);
  }

  /** The engine's link came up or went: no answer to an earlier ask counts
   *  any more — the sockets still waiting are refused. What is open stays
   *  open (plan §4.9). */
  linkChanged(): void {
    for (const admission of [...this.#admissions.values()]) {
      if (admission.stage === "asking") this.#endAsk(admission, "the engine's link changed before its answer");
    }
  }

  /** A new owner of the page (plan §4.7): an earlier owner's admitted socket
   *  whose request has not gone up never goes — the takeover pause counts
   *  from the last send. */
  quiesce(generation: number): void {
    for (const admission of [...this.#admissions.values()]) {
      if (admission.stage !== "admitted" || admission.generation >= generation || admission.handshake !== null) continue;
      this.#done(admission, { sent: false, status: null, error: "a new owner of the page" });
      this.#deps.cutTunnel(admission.id, "cut: a new owner of the page");
    }
  }

  /** The engine's recover asks of an attempt without an outcome: a socket's
   *  admission whose request never went up is not used any more and is
   *  `not_sent`; one that went is `unknown`. Null: not a socket's attempt. */
  recoverState(attemptId: number): "not_sent" | "unknown" | null {
    for (const admission of this.#admissions.values()) {
      if (admission.attemptId !== attemptId || admission.stage !== "admitted") continue;
      if (admission.handshake !== null) return "unknown";
      // Closed as never sent by the engine: no wsDone of it follows.
      this.#finishQuietly(admission, "the engine's recover closed it as not sent");
      this.#deps.cutTunnel(admission.id, "cut: the engine's recover closed its admission");
      return "not_sent";
    }
    return null;
  }

  // ── the page's lifetime ────────────────────────────────────────────────

  /** The operator started and had what the holder kept from before it (its
   *  replay; operator.ts): the connections the previous Chrome left open in
   *  the stream are closed there — that Chrome is gone — and the stream may
   *  have missed anything since its last saved event (plan §4.4, step 6). */
  async afterRestart(): Promise<void> {
    const buffer = this.#deps.buffer;
    await buffer.flush();
    const open = new Set([...this.#sockets.values()].filter((socket) => socket.open).map((socket) => socket.key));
    for (const left of buffer.openSockets()) {
      if (open.has(left.key)) continue;
      this.#append({ kind: "ws.close", connectionId: left.connectionId, code: null, reason: null }, null, { socket: { key: left.key, open: null } });
      this.#log("socket.closed", { connectionId: left.connectionId, why: "the previous operator's Chrome is gone" });
    }
    const marked = buffer.markGap("operator_start");
    // A buffer that cannot be opened yet gets it all once it opens; a full
    // one writes its own gap when there is room.
    this.#startPending = !marked.ok && marked.reason === "buffer_unavailable";
    this.#uncovered = null;
    this.#openedSinceGap = false;
  }

  /** The buffer opened after all (operator.ts #onBufferOpened). */
  bufferOpened(): void {
    if (this.#startPending) void this.afterRestart();
  }

  /** A new Chrome starts: a connection of the previous one is gone. */
  chromeStarting(): void {
    if (!this.#openedSinceGap && this.#uncovered === null) return;
    const from = this.#last;
    this.#deps.buffer.markGap("chrome_restart", from === null ? undefined : { seq: from.seq, wall: from.wall });
    this.#uncovered = null;
    this.#openedSinceGap = false;
  }

  /** The page stops or its browser goes (the exit is closed already): what
   *  waits is refused, every admission still open ends, and every open
   *  connection is closed in the stream — CDP may never say so. */
  endAll(reason: string): void {
    for (const admission of [...this.#admissions.values()]) {
      if (admission.stage === "asking") this.#endAsk(admission, `the page stopped: ${reason}`);
      else if (admission.stage === "admitted") this.#done(admission, { sent: admission.handshake !== null, status: admission.status, error: `the page stopped: ${reason}` });
    }
    for (const socket of this.#sockets.values()) {
      if (!socket.open || socket.admission === null) continue;
      socket.open = false;
      this.#close(socket.key, socket.admission.id, `the page stopped: ${reason}`, null);
    }
    this.#sockets.clear();
  }

  // ── the guard's word ───────────────────────────────────────────────────

  /** A report of the guard in the page (ws/install.ts). */
  onGuardReport(report: GuardReport, target: GuardTarget): void {
    const where = urlForLogLine(report.where);
    switch (report.k) {
      case "installed":
        return;
      case "blocked_send": {
        // It never left; the page stops before anything else can go.
        const shape = shapeFields(report.shape);
        this.#log("guard.blocked_send", { ...shape, context: target.type, where });
        this.#deps.journal({ connectionId: null, event: "blocked", shape, context: target.type, detail: where });
        this.#deps.stop("unknown_ws_message", `the page tried to send an unknown socket message (${target.type}); it was not sent`, "stop");
        this.#deps.alarm("unknown_ws_message", { ...shape, context: target.type, where, left: false });
        return;
      }
      case "guard_failed":
        this.#log("guard.failed", { why: report.why, context: target.type, where });
        this.#deps.stop("ws_guard_failed", `the socket guard could not guard a ${target.type}: ${report.why}`, "kill");
        return;
    }
  }

  // ── the tunnel ─────────────────────────────────────────────────────────

  #onTunnel(admission: Admission, event: SocketTunnelEvent): void {
    switch (event.kind) {
      case "open":
        return;
      case "handshake_sent":
        admission.handshake = { mono: event.mono, wall: event.wall };
        if (this.#lastHandshake === null || event.mono > this.#lastHandshake.mono) this.#lastHandshake = { mono: event.mono, wall: event.wall };
        return;
      case "refused": {
        // The socket gate held a record: it never left, the tunnel is cut.
        // Something in the page sent what the guard should have stopped
        // (it did not go into that context): the page is not trusted.
        const context = admission.socket?.context ?? "unknown";
        const detail: Record<string, string | number | boolean> = { at: "proxy", recordBytes: event.recordBytes, why: event.why, context, left: false };
        if (admission.extensions !== null) detail.extensions = admission.extensions;
        this.#log("record.held", { connectionId: admission.id, ...detail });
        this.#deps.journal({ connectionId: admission.id, event: "blocked", context, detail: `the socket gate held a record of ${event.recordBytes} bytes: ${event.why}` });
        this.#deps.stop("unknown_ws_message", `the socket gate held a record the page wrote (${event.why}); it was not sent`, "kill");
        this.#deps.alarm("unknown_ws_message", detail);
        return;
      }
      case "ended":
        admission.tunnelEnded = event.result;
        if (admission.stage === "asking") {
          this.#endAsk(admission, `the connection went before its admission (${event.result})`);
          return;
        }
        if (admission.stage !== "admitted") return;
        if (!event.handshakeSent) {
          this.#done(admission, { sent: false, status: null, error: `the tunnel ended before the handshake request (${event.result})` });
          return;
        }
        // CDP's word on the handshake may still be on its way.
        admission.graceTimer = setTimeout(() => {
          admission.graceTimer = null;
          this.#done(admission, { sent: true, status: admission.status, error: `the tunnel ended before the handshake's answer (${event.result})` });
        }, this.#timings.handshakeGraceMs);
        return;
    }
  }

  // ── CDP ────────────────────────────────────────────────────────────────
  //
  // Each handler returns the durability of what it wrote (the holder hears
  // of the event only then), or null when it wrote nothing.

  #key(event: CdpEvent): string | null {
    const requestId = (event.params as { requestId?: unknown }).requestId;
    return typeof requestId === "string" ? `${event.sessionId ?? ""}|${requestId}` : null;
  }

  /** The Chrome message an event of the stream is made of: its socket and
   *  the holder's number of the message (the same when it is delivered
   *  again). */
  #origin(event: CdpEvent, key: string): string {
    return `${key}#${event.seq}`;
  }

  /** When Chrome saw it (Network.MonotonicTime is CLOCK_MONOTONIC, as the
   *  operator's clock), else now: a message delivered again keeps its time. */
  #at(event: CdpEvent): { mono: number; wall: number } {
    const now = monoMs();
    const seen = Number((event.params as { timestamp?: unknown }).timestamp) * 1000;
    const mono = Number.isFinite(seen) && seen <= now + 1000 && seen >= now - 3_600_000 ? seen : now;
    return { mono, wall: Math.round(wallMs() - (now - mono)) };
  }

  #onCreated(event: CdpEvent): null {
    // A previous instance's: its Chrome is killed.
    if (event.replayed) return null;
    const key = this.#key(event);
    const url = String((event.params as { url?: unknown }).url ?? "");
    if (key === null || this.#sockets.has(key)) return null;
    this.#sockets.set(key, {
      key,
      url,
      host: hostOf(url),
      context: contextOf(this.#deps.targetType(event.sessionId ?? null)),
      createdMono: monoMs(),
      guessedBy: null,
      admission: null,
      open: false,
      lost: false,
    });
    if (this.#sockets.size > MAX_SOCKETS) {
      const oldest = [...this.#sockets.values()].find((socket) => !socket.open);
      if (oldest) this.#sockets.delete(oldest.key);
    }
    return null;
  }

  /** The socket this operator knows of the event (not for a message of a
   *  previous instance's). */
  #socket(event: CdpEvent): CdpSocket | null {
    const key = this.#key(event);
    return key === null ? null : (this.#sockets.get(key) ?? null);
  }

  /** The oldest socket of `host` still to connect, for `wsAdmit`. */
  #waitingSocket(host: string): CdpSocket | null {
    for (const socket of this.#sockets.values()) {
      if (socket.host === host && socket.admission === null && !socket.open && !socket.lost && (socket.guessedBy === null || !this.#admissions.has(socket.guessedBy))) return socket;
    }
    return null;
  }

  /** Another admitted socket is not tied to its CDP socket yet. */
  #untiedOther(admission: Admission): boolean {
    for (const other of this.#admissions.values()) if (other !== admission && other.stage === "admitted" && other.socket === null) return true;
    return false;
  }

  #onWillSendHandshake(event: CdpEvent): null {
    if (event.replayed) return null;
    const key = this.#key(event);
    if (key === null) return null;
    let socket = this.#sockets.get(key);
    if (!socket) {
      // Its creation was not seen (the operator came later): taken as is.
      this.#onCreated(event);
      socket = this.#sockets.get(key);
      if (!socket) return null;
    }
    if (socket.admission !== null || socket.lost) return null;
    const host = socket.host;
    const untied = [...this.#admissions.values()].filter((admission) => admission.stage === "admitted" && admission.socket === null && (host === "" || admission.host === host));
    const admission = untied[0];
    if (!admission) {
      // A handshake through no admitted tunnel the operator knows of (its
      // tunnel already ended): nothing it receives can be tied to an
      // admission. Its frames are not kept; a gap covers them.
      socket.lost = true;
      this.#log("socket.untied", { url: urlForLogLine(socket.url), context: socket.context });
      this.#deps.journal({ connectionId: null, event: "failed", context: socket.context, detail: "a handshake with no admitted socket to tie it to" });
      this.#uncovered ??= this.#last ?? { seq: null, wall: wallMs() };
      return null;
    }
    if (untied.length > 1) this.#log("socket.tie_ambiguous", { admissions: untied.length, chosen: admission.id });
    socket.admission = admission;
    admission.socket = socket;
    return null;
  }

  #onHandshakeResponse(event: CdpEvent): Promise<unknown> | null {
    const socket = event.replayed ? null : this.#socket(event);
    if (!socket) return null;
    const response = (event.params as { response?: { status?: unknown; headers?: unknown } }).response;
    const status = Number(response?.status);
    const admission = socket.admission;
    if (admission === null) {
      if (socket.lost && status === 101) this.#log("socket.untied_open", { url: urlForLogLine(socket.url) });
      return null;
    }
    admission.status = Number.isInteger(status) ? status : null;
    admission.extensions = extensionsOf(response?.headers);
    if (status !== 101) {
      this.#done(admission, { sent: true, status: admission.status, error: `the handshake was answered ${String(admission.status)}` });
      return null;
    }
    if (admission.attemptId === null) return null;
    // The stream's break since the previous connection closed goes first.
    const uncovered = this.#uncovered;
    if (uncovered !== null) {
      this.#deps.buffer.markGap("ws_reconnect", { seq: uncovered.seq, wall: uncovered.wall });
      this.#uncovered = null;
    }
    socket.open = true;
    this.#openedSinceGap = true;
    const durable = this.#append(
      { kind: "ws.open", connectionId: admission.id, attemptId: admission.attemptId, sessionFingerprint: this.#deps.sessionFingerprint() ?? admission.fingerprint },
      this.#at(event),
      { origin: this.#origin(event, socket.key), socket: { key: socket.key, open: { connectionId: admission.id, attemptId: admission.attemptId } } },
    );
    this.#done(admission, { sent: true, status: 101, error: null });
    return durable;
  }

  /** The connection of an event's socket: this operator's, or — for a
   *  message the holder kept from before it, or a socket it did not see
   *  open — the one the stream has open (the buffer's socket row). */
  #connectionOf(event: CdpEvent): { key: string; connectionId: string; socket: CdpSocket | null } | null {
    const key = this.#key(event);
    if (key === null) return null;
    const socket = this.#sockets.get(key) ?? null;
    if (socket !== null && socket.open && socket.admission !== null) return { key, connectionId: socket.admission.id, socket };
    if (socket !== null && !event.replayed) return null;
    const stored = this.#deps.buffer.socketOf(key);
    return stored === null ? null : { key, connectionId: stored.connectionId, socket: null };
  }

  #onFrameReceived(event: CdpEvent): Promise<unknown> | null {
    const connection = this.#connectionOf(event);
    if (connection === null) return null;
    const response = (event.params as { response?: { opcode?: unknown; payloadData?: unknown } }).response;
    if (response?.opcode !== 1 || typeof response.payloadData !== "string") {
      // Not text: Fansly's socket sends none; counted, its content not kept.
      this.#binaryFrames += 1;
      if (this.#binaryFrames === 1 || this.#binaryFrames % 100 === 0) this.#log("frame.not_text", { connectionId: connection.connectionId, opcode: Number(response?.opcode), count: this.#binaryFrames });
      return null;
    }
    return this.#append({ kind: "ws.in", connectionId: connection.connectionId, frame: response.payloadData }, this.#at(event), { origin: this.#origin(event, connection.key) });
  }

  #onFrameSent(event: CdpEvent): null {
    if (event.replayed) return null;
    const socket = this.#socket(event);
    const response = (event.params as { response?: { opcode?: unknown; payloadData?: unknown } }).response;
    const opcode = Number(response?.opcode);
    const payload = typeof response?.payloadData === "string" ? response.payloadData : "";
    const connectionId = socket?.admission?.id ?? null;
    if (opcode !== 1 && opcode !== 2) {
      this.#deps.journal({ connectionId, event: "out", message: { kind: "other", opcode, bytes: payload.length } });
      return null;
    }
    const kind = opcode === 2 ? "binary" : messageKind(payload);
    this.#deps.journal({ connectionId, event: "out", message: { kind, opcode, bytes: opcode === 1 ? Buffer.byteLength(payload) : Math.floor((payload.length * 3) / 4) } });
    if (kind === "ping" || kind === "auth") return null;
    // It left: the guard in the page and the socket gate were both passed
    // by (a message of a size the gate cannot tell apart). The page cannot
    // be trusted any more.
    const shape = opcode === 1 ? shapeFields(shapeOf(payload)) : { form: "binary" };
    this.#log("frame.sent_unknown", { connectionId, ...shape });
    this.#deps.stop("unknown_ws_message", "an unknown socket message left the page past the guard", "kill");
    this.#deps.alarm("unknown_ws_message", { ...shape, context: socket?.context ?? "unknown", left: true });
    return null;
  }

  #onFrameError(event: CdpEvent): null {
    const socket = event.replayed ? null : this.#socket(event);
    const admission = socket?.admission ?? null;
    const message = String((event.params as { errorMessage?: unknown }).errorMessage ?? "").slice(0, 160);
    if (admission === null || admission.stage !== "admitted") return null;
    const status = Number(/response code: (\d{3})/.exec(message)?.[1] ?? NaN);
    this.#done(admission, { sent: admission.handshake !== null, status: Number.isInteger(status) ? status : admission.status, error: message || "the handshake failed" });
    return null;
  }

  #onClosed(event: CdpEvent): Promise<unknown> | null {
    const connection = this.#connectionOf(event);
    const socket = this.#socket(event);
    if (socket !== null) this.#sockets.delete(socket.key);
    if (connection !== null) {
      if (connection.socket !== null) connection.socket.open = false;
      return this.#close(connection.key, connection.connectionId, "closed", this.#at(event), this.#origin(event, connection.key));
    }
    const admission = socket?.admission ?? null;
    if (admission !== null && admission.stage === "admitted") this.#done(admission, { sent: admission.handshake !== null, status: admission.status, error: "the socket closed before its handshake's answer" });
    return null;
  }

  // ── the stream ─────────────────────────────────────────────────────────

  /** An event into the buffer; its durability, or null when it was not
   *  taken (the buffer stops the page itself, and its own gap follows once
   *  there is room). */
  #append(body: EventBody, at: { mono: number; wall: number } | null, options: AppendOptions): Promise<unknown> | null {
    const stamp = at ?? { mono: monoMs(), wall: wallMs() };
    const appended = this.#deps.buffer.append(body, stamp, options);
    if (!appended.ok) {
      this.#log("event.unkept", { kind: body.kind, reason: appended.reason });
      return null;
    }
    const mark: Mark = { seq: null, wall: stamp.wall };
    this.#last = mark;
    return appended.durable.then((durable) => {
      if (durable.ok) mark.seq = durable.seq;
      else this.#log("event.unkept", { kind: body.kind, reason: durable.reason });
    });
  }

  /** A connection's end in the stream (its socket's row goes with it); what
   *  comes after it until the next connection opens may be missing. */
  #close(key: string, connectionId: string, why: string, at: { mono: number; wall: number } | null, origin?: string): Promise<unknown> | null {
    const durable = this.#append({ kind: "ws.close", connectionId, code: null, reason: null }, at, { socket: { key, open: null }, ...(origin === undefined ? {} : { origin }) });
    this.#uncovered = this.#last;
    this.#log("socket.closed", { connectionId, why });
    this.#deps.journal({ connectionId, event: "closed", detail: why });
    return durable;
  }

  // ── admissions ─────────────────────────────────────────────────────────

  /** A socket's CONNECT that waited is refused: no attempt of it exists. */
  #endAsk(admission: Admission, why: string): void {
    if (admission.stage !== "asking") return;
    admission.stage = "done";
    if (admission.waitTimer) clearTimeout(admission.waitTimer);
    admission.waitTimer = null;
    this.#forget(admission, why);
    if (admission.socket === null) this.#releaseGuess(admission);
    this.#log("admit.ended", { connectionId: admission.id, why });
    this.#deps.journal({ connectionId: admission.id, event: "refused", detail: why });
    admission.resolve(null);
  }

  /** The handshake's outcome: final, kept, and sent once durable. */
  #done(admission: Admission, outcome: { sent: boolean; status: number | null; error: string | null }): void {
    if (admission.stage === "done" || admission.attemptId === null) return;
    this.#finishQuietly(admission, outcome.error ?? "answered");
    const done: WsDone = {
      type: "wsDone",
      connectionId: admission.id,
      attemptId: admission.attemptId,
      sent: outcome.sent,
      sentMono: outcome.sent ? (admission.handshake?.mono ?? null) : null,
      status: outcome.status,
      error: outcome.error,
    };
    this.#log("admit.done", { connectionId: admission.id, attemptId: admission.attemptId, sent: done.sent, status: done.status, error: done.error });
    if (outcome.status !== 101) this.#deps.journal({ connectionId: admission.id, event: "failed", attemptId: admission.attemptId, status: outcome.status, ...(outcome.error ? { detail: outcome.error } : {}) });
    else this.#deps.journal({ connectionId: admission.id, event: "open", attemptId: admission.attemptId, status: 101 });
    this.#store(done);
  }

  #finishQuietly(admission: Admission, why: string): void {
    admission.stage = "done";
    if (admission.waitTimer) clearTimeout(admission.waitTimer);
    if (admission.graceTimer) clearTimeout(admission.graceTimer);
    admission.waitTimer = null;
    admission.graceTimer = null;
    this.#forget(admission, why);
  }

  #forget(admission: Admission, why: string): void {
    this.#admissions.delete(admission.id);
    this.#gone.set(admission.id, { why, attemptId: admission.attemptId });
    if (this.#gone.size > MAX_GONE) this.#gone.delete(this.#gone.keys().next().value!);
  }

  #releaseGuess(admission: Admission): void {
    for (const socket of this.#sockets.values()) if (socket.guessedBy === admission.id) socket.guessedBy = null;
  }

  /** Kept until the engine's resultAck; a buffer that takes no writes: the
   *  engine still hears, from memory. */
  #store(done: WsDone): void {
    const put = this.#deps.buffer.putOutcome(done);
    const unkept = (reason: string) => {
      this.#log("done.unkept", { connectionId: done.connectionId, attemptId: done.attemptId, reason });
      this.#deps.link.send(done);
    };
    if (!put.ok) return unkept(put.reason);
    void put.durable.then((durable) => {
      if (!durable.ok) unkept(durable.reason);
    });
  }
}

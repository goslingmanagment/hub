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
// waits there — before a single byte goes to Fansly — for the engine.
//
// One socket at a time, for its whole life. A CONNECT is taken up only when
// the one before it is accounted for; until then it waits (its wait counts
// from its CONNECT). The one before is accounted for when:
//  - its CONNECT never got a tunnel (refused, expired, gone), or its tunnel
//    ended with no handshake request on it (the proxy's word): no socket
//    could have spoken through it;
//  - or its socket's life in CDP is over — closed, or its handshake failed
//    — and what ends it in the stream is durable;
//  - or Chrome went (endAll) — its sockets with it.
// So only one tunnel at a time can carry a handshake, and the CDP socket
// whose handshake (webSocketWillSendHandshakeRequest) shows while the
// current admission's tunnel is open is that admission's: bound for good,
// with no guess and no clock. A socket that is not accounted for in time —
// a handshake on the tunnel CDP does not show (`bindWaitMs`), a tunnel that
// ended with CDP silent on its socket (`accountWaitMs`), a second handshake
// while the current socket is bound, the handshake of a socket CDP did not
// show being created while a tunnel waits — fails closed: the tunnel is
// cut, the page stops (`ws_unaccounted`: the exit closed, Chrome goes and
// the page starts again; operator.ts), and nothing is admitted until a new
// Chrome starts. Normal behaviour of the site — one socket, CDP's events
// soon after the network's — never comes to it. What CDP says of a socket
// that is not bound (one whose CONNECT was refused, one of a Chrome before)
// is dropped and counted: nothing of it can be kept.
//
//  1. `wsAdmit` with a new connection id, the address and context CDP shows
//     for the oldest socket of the host waiting to connect (a label only),
//     the live session and the wait's end (`siteAdmitWaitMs`, 60 s from the
//     CONNECT). Nothing is asked when no admission may be given: no engine
//     heard for 5 s (plan §4.9 — what is open stays open), the exit closed,
//     the page not up, the buffer taking no writes — or no live session of
//     the site yet: the socket gate could not let its authorization go
//     (egress/socket-gate.ts), and a socket before the login is of no use to
//     Hub. The CONNECT is refused then.
//  2. `wsAdmitResult`: refused — the CONNECT is refused; admitted — the
//     admission is written to the buffer first (an operator that starts
//     again ends it: below), then, with the deadline still ahead, the tunnel
//     opens and its handshake request may go only before the deadline
//     (egress/proxy.ts; spec §9). An answer counts only on the engine
//     connection it was asked on: a link that changes or goes refuses every
//     socket still asked. An admission that finds its CONNECT gone (Chrome
//     dropped it, the wait ended) is closed at once with `wsDone`, `sent:
//     false`: the engine never waits for a socket that is not there (stage
//     1, FINDINGS 27).
//  3. `wsDone` — the handshake's outcome under the admission's attempt id:
//     sent or not (the proxy saw the request go up), when, the status (101
//     open; 401/403 stop the page for auth, 429 holds `ws.upgrade` — the
//     engine's rules), or the error. It is kept in the buffer until the
//     engine's resultAck and sent once durable (buffer/replay.ts). A tunnel
//     that ends after its request waits for CDP's word on the status (the
//     proxy's end and CDP's answer travel apart) — up to `accountWaitMs`. An
//     admission that ends without opening has its tunnel cut.
//
// Frames (plan §4.4), from CDP's Network.webSocket* — not from the page's
// JS — into the buffer, in the order CDP gives them; each is durable before
// anything depends on it, and nothing of them is logged:
//  - `ws.open` at the 101, with its outcome (and the reconnect's gap) in
//    the same commit: the connection id, the attempt id, the session's
//    fingerprint;
//  - `ws.in` — every incoming text frame as it is (Fansly's socket speaks
//    text; a binary frame is counted, not kept);
//  - `ws.close` — exactly one a connection, the last of it, after its
//    ws.open: when CDP says the socket closed, or when the browser goes under
//    it (CDP may never say). A connection's closing is known at once, in
//    memory: what CDP still says of it afterwards is dropped and counted.
//  - `gap` where frames may be missing (spec §6.1 reasons), from the last
//    event of the socket saved before the break: `operator_start` at every
//    start of the operator (from the last event saved before it);
//    `chrome_restart` when the browser goes under an open connection —
//    before the closes written for it, in their commit, from the last event
//    saved before them (what CDP still had of it is dropped); `ws_reconnect`
//    before a connection that opens after another one closed or one that
//    was not kept. A buffer that fills up writes its own (`buffer_full`,
//    `disk_full`).
//
// Writes that matter — a connection's ws.open with its outcome, its
// ws.close, the outcome of one that never opened (each with its kept row),
// the start's gap and what it ends, the browser's gap and its closes — are
// groups written in one commit (buffer.ts appendGroup), one write a key.
// Refused or failed, a group is tried again with a growing pause (1 s …
// 30 s), whatever Chrome does or the socket's state is, and at once when
// the buffer has room; its boundaries (a gap's "from") are the ones it was
// made with. A close goes only after its open is durable. What a write ends
// is ended only once it is durable: until then nothing else ends it. An
// outcome refused is told to the engine from memory at once (and kept
// later).
//
// Restarts. The CDP holder delivers again, to an operator that starts
// again, every message the previous one had not acknowledged. Nothing of the
// socket is rebuilt from them: that operator kills the previous one's Chrome
// (it does not know its targets), so every socket of it is gone, and what was
// not durable before the crash is what the `operator_start` gap is for — the
// engine finds the gap and backfills it (plan §4.4). So:
//  - an event of the socket is acknowledged to the holder only once what it
//    wrote is durable (the client's `holdAcks`); one that wrote nothing, at
//    once;
//  - one delivered again (from before this operator) is acknowledged without
//    writing anything, and counted;
//  - each admitted connection is kept in the buffer (schema.ts v3) before its
//    CONNECT goes on, opened with its ws.open, gone with its ws.close or its
//    outcome. After the holder's first delivery, this operator writes, in
//    one commit, the `operator_start` gap from the last event saved before
//    it, then the end of every connection kept from before: ws.close for one
//    that opened, `wsDone` for one that did not — the handshake's fate
//    unknown (`fate: "unknown"`, `sent` false: nothing proves it went). The
//    gap's boundary is kept in a file (`startBoundary`) until that commit is
//    durable: an operator that dies before keeps the first boundary.
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

import type { Appended, ConnectionChange, Durable, EventBody, GroupItem, StoredConnection } from "../buffer/buffer.ts";
import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import type { SocketTicket, SocketTunnelEvent } from "../egress/proxy.ts";
import type { SocketLine } from "../logs/journal.ts";
import type { AlarmKind, WsAdmit, WsAdmitResult, WsDone } from "../rpc/protocol.ts";
import { errorMessage, makeLog, monoMs, urlForLogLine, wallMs, type Logger } from "../shared/util.ts";
import { messageKind, shapeFields, shapeOf, type GuardReport } from "./guard.ts";
import type { GuardTarget } from "./install.ts";

export interface SocketTimings {
  /** How long a socket's CONNECT waits — for the one before it, then for
   *  the engine (spec §8.2: 60 s). */
  admitWaitMs: number;
  /** After its handshake request went up on the tunnel, how long CDP has to
   *  show that socket's handshake. */
  bindWaitMs: number;
  /** After a tunnel that carried a handshake ended, how long CDP has to say
   *  how its socket ended. */
  accountWaitMs: number;
  /** The pauses between tries of a refused or failed write; the last one
   *  repeats. */
  retryMs: number[];
}

const DEFAULT_TIMINGS: SocketTimings = { admitWaitMs: 60_000, bindWaitMs: 15_000, accountWaitMs: 15_000, retryMs: [1000, 2000, 5000, 15_000, 30_000] };

/** The buffer as the socket uses it. */
export interface SocketBuffer {
  append(event: EventBody, at?: { mono: number; wall: number }): Appended;
  appendGroup(items: readonly GroupItem[]): Appended;
  changeConnection(change: ConnectionChange): Appended;
  /** Every connection kept (committed). */
  connections(): StoredConnection[];
  /** The buffer's id (its seq numbers are its own). */
  readonly id: string;
  /** Why it takes no writes now, or null. */
  refusal(): string | null;
  /** Everything accepted so far committed. */
  flush(): Promise<void>;
  readonly lastSeq: number;
  readonly lastWall: number | null;
}

/** Where the start's gap boundary is kept until its commit is durable. */
export interface BoundaryStore {
  load(): Boundary | null;
  save(boundary: Boundary): void;
  clear(): void;
}

/** The last event of a buffer before a start. */
export interface Boundary {
  bufferId: string;
  seq: number | null;
  wall: number | null;
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

export type SocketStop = "unknown_ws_message" | "ws_guard_failed" | "ws_unaccounted";

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
  /** A target's type by its session ("page", "iframe", "worker"...); null:
   *  not a target of this Chrome. */
  targetType: (sessionId: string | null) => string | null;
  /** Is this the site socket's host (the CONNECTs the proxy admits here)?
   *  A socket CDP shows to another host is none of this path's. */
  socketHost?: (host: string) => boolean;
  /** Cuts one socket's tunnel (egress/proxy.ts). */
  cutTunnel: (connectionId: string, reason: string) => boolean;
  journal: (line: SocketLine) => void;
  alarm: (kind: AlarmKind, detail: Record<string, string | number | boolean>) => void;
  /** The page must stop: the exit is closed when this returns. */
  stop: (reason: SocketStop, note: string, how: "stop" | "kill") => void;
  /** Where the start's gap boundary waits for its commit (a file). */
  startBoundary?: BoundaryStore;
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
  port: number;
  /** queued: its CONNECT waits for the one before; asking: for the engine;
   *  admitted: its tunnel may open; done: answered (its outcome given, or
   *  refused). Its socket may live on after `done` (open). */
  stage: "queued" | "asking" | "admitted" | "done";
  /** Its CONNECT came (CLOCK_MONOTONIC): its wait counts from here. */
  connectMono: number;
  resolve: (deadline: number | null) => void;
  waitTimer: NodeJS.Timeout | null;
  generation: number;
  attemptId: number | null;
  /** The proxy opened its tunnel (Chrome got the 200). */
  tunnelOpened: boolean;
  /** The handshake request went up (the proxy's word). */
  handshake: { mono: number; wall: number } | null;
  /** Its tunnel ended (the proxy's word): why. */
  tunnelEnded: string | null;
  /** Its CDP socket, bound at its handshake. */
  socket: CdpSocket | null;
  /** CDP's word must come in time (bindWaitMs, accountWaitMs). */
  accountTimer: NodeJS.Timeout | null;
  status: number | null;
  /** The live session when it was asked (there is always one then). */
  fingerprint: string;
  /** The extensions the server's answer negotiated (CDP's word), if any. */
  extensions: string | null;
}

/** A socket as CDP shows it to this operator. */
interface CdpSocket {
  key: string;
  url: string;
  host: string;
  context: WsAdmit["context"];
  /** The admission asking for its CONNECT, by `wsAdmit`'s label only. */
  guessedBy: string | null;
  /** Its admission, bound at its handshake, for good. */
  admission: Admission | null;
  /** new → handshaking (bound) → open (its 101 kept) → ended; answered: its
   *  handshake was answered and nothing is kept of it, its end awaited;
   *  ended: its life in CDP is over (closed, or its handshake failed). */
  state: "new" | "handshaking" | "open" | "answered" | "ended";
}

/** What a handler wrote: acknowledged to the holder once durable; null —
 *  nothing (or nothing that could be taken now), acknowledged at once. */
type Taken = { durable: Promise<unknown> } | null;

/** A write that matters: tried until durable. */
interface Write {
  key: string;
  /** The group as it is now; "later": not now (the buffer cannot be
   *  read). */
  build: () => GroupItem[] | "later";
  /** It is durable. */
  done: (durable: Durable) => void;
  /** Told to the engine from memory when the group was refused. */
  tell: WsDone | null;
  told: boolean;
  queued: boolean;
  /** The buffer took its last try (its commit is on its way). */
  accepted: boolean;
  /** Settles when it is durable. */
  written: Promise<void>;
  markWritten: () => void;
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

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
}

type Outcome = { sent: boolean; status: number | null; error: string | null };

export class SiteSockets {
  readonly #deps: SocketDeps;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #socketHost: (host: string) => boolean;
  #timings: SocketTimings;
  /** The admission whose socket is not accounted for yet: one at a time. */
  #current: Admission | null = null;
  /** CONNECTs waiting for it, oldest first. */
  readonly #queue: Admission[] = [];
  /** Admissions asked or given and not answered with `wsDone` yet. */
  readonly #admissions = new Map<string, Admission>();
  /** Admissions that ended: why, and the attempt of one that was admitted.
   *  A late answer to one that never was is closed under its id; a repeated
   *  answer to one that was does nothing twice. */
  readonly #gone = new Map<string, { why: string; attemptId: number | null }>();
  /** CDP's sockets of this Chrome. */
  readonly #sockets = new Map<string, CdpSocket>();
  /** Connections open now (their ws.open written or on its way), by id. */
  readonly #open = new Map<string, CdpSocket>();
  /** Connections whose end is durable in the stream. */
  readonly #ended = new Map<string, true>();
  /** Connections a write not durable yet ends: its key. */
  readonly #ending = new Map<string, string>();
  /** Writes not durable yet, by key; the refused ones wait in the queue. */
  readonly #writes = new Map<string, Write>();
  readonly #retry: Write[] = [];
  #retryTimer: NodeJS.Timeout | null = null;
  #retryStep = 0;
  #chromeGaps = 0;
  /** A socket could not be accounted for, or Chrome went: nothing is
   *  admitted until a new Chrome starts. Why. */
  #closedUntilChrome: string | null = null;
  /** The last event of the socket's stream (ws.open, ws.in, ws.close). */
  #last: Mark | null = null;
  /** The last event of the socket's stream that is durable. */
  #saved: { seq: number | null; wall: number | null } = { seq: null, wall: null };
  /** Settles once every write of the socket's stream accepted so far has
   *  settled (durable or not). */
  #settled: Promise<unknown> = Promise.resolve();
  /** A connection closed, or one was not kept, and no gap written since:
   *  from its last event. */
  #uncovered: Mark | null = null;
  #lastHandshake: { mono: number; wall: number } | null = null;
  #binaryFrames = 0;
  /** Events dropped: delivered again from before this operator, or of no
   *  socket bound here (one closed, refused, of another Chrome). */
  #replayed = 0;
  #dropped = 0;

  constructor(deps: SocketDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? makeLog("ws");
    this.#now = deps.now ?? monoMs;
    this.#socketHost = deps.socketHost ?? (() => true);
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    const cdp = deps.cdp;
    const handlers: Record<(typeof SOCKET_EVENTS)[number], (event: CdpEvent) => Taken> = {
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

  /** One event of the socket and its acknowledgement to the holder: once
   *  what it wrote is durable (or could not be written — the buffer's own
   *  gap covers it), at once when it wrote nothing. One delivered again
   *  from before this operator is not looked at. */
  #take(event: CdpEvent, handle: (event: CdpEvent) => Taken): void {
    let taken: Taken = null;
    try {
      if (event.replayed) {
        this.#replayed += 1;
        if (this.#replayed === 1 || this.#replayed % 100 === 0) this.#log("event.replayed_dropped", { method: event.method, count: this.#replayed });
      } else {
        taken = handle(event);
      }
    } finally {
      const cdp = this.#deps.cdp;
      if (taken === null) cdp.ack(event.seq);
      else
        void taken.durable.then(
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
    return this.#open.size;
  }

  /** CONNECTs waiting, and admissions waiting for the engine or for their
   *  handshake's outcome. */
  get pending(): number {
    return this.#admissions.size + this.#queue.length;
  }

  /** Is a socket's life not accounted for yet (tests, diagnostics)? */
  get busy(): boolean {
    return this.#current !== null;
  }

  /** Writes not durable yet (tests, diagnostics). */
  get unwritten(): number {
    return this.#writes.size;
  }

  // ── the proxy's side ───────────────────────────────────────────────────

  /** Why no CONNECT may be taken up now, or null. */
  #refusal(): string | null {
    if (this.#closedUntilChrome !== null) return `nothing is admitted until Chrome starts again (${this.#closedUntilChrome})`;
    const refused = this.#deps.notAdmitting();
    if (refused !== null) return refused;
    if (this.#deps.sessionFingerprint() === null || this.#deps.authorizationBytes() === null) return "no session of the site yet: its socket could not authorize";
    return null;
  }

  /** A CONNECT to the socket host: its admission (it waits for the socket
   *  before it, then for the engine), or why it is refused at once. */
  admit(host: string, port: number): SocketTicket | string {
    const refused = this.#refusal();
    if (refused !== null) {
      this.#log("admit.refused", { host, why: refused });
      this.#deps.journal({ connectionId: null, event: "refused", detail: `no admission asked: ${refused}` });
      return refused;
    }
    const id = randomUUID();
    let resolve: (deadline: number | null) => void = () => undefined;
    const granted = new Promise<number | null>((done) => (resolve = done));
    const admission: Admission = {
      id,
      host,
      port,
      stage: "queued",
      connectMono: this.#now(),
      resolve,
      waitTimer: null,
      generation: 0,
      attemptId: null,
      tunnelOpened: false,
      handshake: null,
      tunnelEnded: null,
      socket: null,
      accountTimer: null,
      status: null,
      fingerprint: this.#deps.sessionFingerprint() ?? "",
      extensions: null,
    };
    admission.waitTimer = setTimeout(() => this.#endAsk(admission, "the wait for the engine's admission is over"), this.#timings.admitWaitMs);
    this.#queue.push(admission);
    if (this.#current !== null) this.#log("admit.waits", { connectionId: id, for: this.#current.id });
    this.#next();
    return { id, granted, event: (event) => this.#onTunnel(admission, event), rules: () => ({ authorizationBytes: this.#deps.authorizationBytes() }) };
  }

  /** The next CONNECT is taken up once no socket's life is unaccounted for:
   *  `wsAdmit` goes, or it is refused. */
  #next(): void {
    while (this.#current === null && this.#queue.length > 0) {
      const admission = this.#queue.shift()!;
      if (admission.stage !== "queued") continue;
      this.#current = admission;
      this.#ask(admission);
    }
  }

  #ask(admission: Admission): void {
    const refused = this.#refusal();
    const fingerprint = this.#deps.sessionFingerprint();
    if (refused !== null || fingerprint === null) {
      this.#endAsk(admission, refused ?? "no session of the site yet");
      return;
    }
    admission.stage = "asking";
    admission.fingerprint = fingerprint;
    this.#admissions.set(admission.id, admission);
    const socket = this.#waitingSocket(admission.host);
    if (socket !== null) socket.guessedBy = admission.id;
    const now = this.#now();
    const url = socket?.url ?? `wss://${admission.host}${admission.port === 443 ? "" : `:${admission.port}`}/`;
    const context = socket?.context ?? "page";
    this.#deps.link.send({ type: "wsAdmit", connectionId: admission.id, url, context, sessionFingerprint: fingerprint, requestedMono: now, waitDeadlineMono: admission.connectMono + this.#timings.admitWaitMs });
    this.#log("admit.asked", { connectionId: admission.id, url: urlForLogLine(url), context });
    this.#deps.journal({ connectionId: admission.id, event: "asked", context, detail: urlForLogLine(url) });
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
      if (result.admit) {
        const done: WsDone = { type: "wsDone", connectionId: result.connectionId, attemptId: result.attemptId, sent: false, sentMono: null, status: null, error: `not used: ${why}` };
        this.#write(`late:${result.attemptId}`, () => [{ outcome: done }], () => undefined, done);
      }
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
    const unusable = !(result.deadlineMono > now) ? "the admission came expired" : this.#refusal();
    if (unusable !== null) {
      this.#done(admission, { sent: false, status: null, error: `not used: ${unusable}` });
      return;
    }
    // Kept before the CONNECT goes on: an operator that starts again after
    // a crash ends it in the stream.
    const kept = this.#deps.buffer.changeConnection({ connectionId: admission.id, admitted: { attemptId: result.attemptId } });
    if (!kept.ok) {
      this.#done(admission, { sent: false, status: null, error: `not used: the admission could not be kept (${kept.reason})` });
      return;
    }
    this.#log("admit.admitted", { connectionId: admission.id, attemptId: result.attemptId, deadlineInMs: Math.round(result.deadlineMono - now) });
    this.#deps.journal({ connectionId: admission.id, event: "admitted", attemptId: result.attemptId });
    void kept.durable.then((durable) => {
      if (admission.stage !== "admitted") return;
      if (!durable.ok) {
        this.#done(admission, { sent: false, status: null, error: `not used: the admission could not be kept (${durable.reason})` });
        return;
      }
      admission.resolve(result.deadlineMono);
    });
  }

  /** The engine's link came up or went: no answer to an earlier ask counts
   *  any more — the sockets asked for are refused (those still waiting for
   *  their turn are asked on the new link). What is open stays open (plan
   *  §4.9). */
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
      this.#end(admission.id, [{ connection: { connectionId: admission.id, gone: true } }], null, () => this.#settle(admission));
      this.#deps.cutTunnel(admission.id, "cut: the engine's recover closed its admission");
      this.#settle(admission);
      return "not_sent";
    }
    return null;
  }

  // ── the page's lifetime ────────────────────────────────────────────────

  /** The operator started, and the holder's first delivery is behind it
   *  (operator.ts): in one commit, the `operator_start` gap from the last
   *  event saved before this operator, then the end of every connection
   *  kept from before — the previous operator's Chrome is gone with it. */
  async afterRestart(): Promise<void> {
    const buffer = this.#deps.buffer;
    await buffer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const store = this.#deps.startBoundary;
    let boundary: Boundary | null = null;
    let swept: { items: GroupItem[]; ids: string[] } = { items: [], ids: [] };
    try {
      boundary = store?.load() ?? null;
    } catch (error) {
      this.#log("boundary.unreadable", { error: errorMessage(error) });
    }
    this.#write(
      "start",
      () => {
        // The buffer's last event before this operator: known once the
        // buffer is open (nothing is written while it cannot be).
        if (buffer.refusal() === "buffer_unavailable") return "later";
        if (boundary === null || boundary.bufferId !== buffer.id) {
          boundary = buffer.lastSeq === 0 ? { bufferId: buffer.id, seq: null, wall: null } : { bufferId: buffer.id, seq: buffer.lastSeq, wall: buffer.lastWall };
          try {
            store?.save(boundary);
          } catch (error) {
            this.#log("boundary.unsaved", { error: errorMessage(error) });
          }
        }
        swept = this.#sweep();
        return [{ gap: "operator_start", from: { seq: boundary.seq, wall: boundary.wall } }, ...swept.items];
      },
      () => {
        for (const id of swept.ids) remember(this.#ended, id, true, MAX_GONE);
        this.#log("start.written", { ended: swept.ids.length });
        try {
          store?.clear();
        } catch (error) {
          this.#log("boundary.uncleared", { error: errorMessage(error) });
        }
      },
      null,
    );
  }

  /** The buffer opened, or has room again: what waits is written now. */
  bufferOpened(): void {
    this.retryNow();
  }

  /** A new Chrome starts: whatever is left of the one before goes with it,
   *  and sockets are admitted again. */
  async chromeStarting(): Promise<void> {
    this.#chromeGone("the previous Chrome is gone");
    this.#closedUntilChrome = null;
  }

  /** The page stops or its browser goes (the exit is closed already): what
   *  waits is refused, every admission still open ends, and every open
   *  connection gets its one terminal close — CDP may never say so, and
   *  whatever it still says of them is dropped. Nothing is admitted until
   *  a new Chrome starts. */
  endAll(reason: string): void {
    this.#chromeGone(`the page stopped: ${reason}`);
    this.#closedUntilChrome ??= `the page stopped: ${reason}`;
  }

  /** Chrome goes (or nothing of it is listened to any more): CONNECTs that
   *  wait are refused, admissions end, each open connection gets its one
   *  close — after the browser's gap from the last event saved before, in
   *  one commit — and its sockets are forgotten: whatever CDP still says of
   *  them is dropped. Every socket is accounted for by Chrome's going. */
  #chromeGone(why: string): void {
    for (const admission of this.#queue.splice(0)) this.#endAsk(admission, why);
    for (const admission of [...this.#admissions.values()]) {
      if (admission.stage === "asking") this.#endAsk(admission, why);
      else if (admission.stage === "admitted") this.#done(admission, { sent: admission.handshake !== null, status: admission.status, error: why });
    }
    const open = [...this.#open.values()];
    if (open.length > 0) this.#closeAll(open, why);
    for (const socket of this.#sockets.values()) socket.state = "ended";
    this.#sockets.clear();
    const current = this.#current;
    if (current !== null) this.#account(current, "its Chrome went");
  }

  /** The end of every connection the buffer keeps from before this
   *  operator (none of its own: those it ends itself, each by its own
   *  write): ws.close for one that opened, `wsDone` with the handshake's
   *  fate unknown for one that did not. Ended once the start's commit is
   *  durable. */
  #sweep(): { items: GroupItem[]; ids: string[] } {
    const items: GroupItem[] = [];
    const ids: string[] = [];
    const why = "the operator started again: the previous Chrome is gone";
    for (const kept of this.#deps.buffer.connections()) {
      const id = kept.connectionId;
      if (this.#ended.has(id) || this.#admissions.has(id) || this.#open.has(id) || this.#ending.has(id) || this.#writes.has(`open:${id}`)) continue;
      ids.push(id);
      if (kept.opened) {
        items.push({ event: { kind: "ws.close", connectionId: id, code: null, reason: null }, connection: { connectionId: id, gone: true } });
      } else {
        items.push(
          { outcome: { type: "wsDone", connectionId: id, attemptId: kept.attemptId, sent: false, sentMono: null, status: null, error: `the handshake's fate is unknown: ${why}`, fate: "unknown" } },
          { connection: { connectionId: id, gone: true } },
        );
      }
    }
    return { items, ids };
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
        admission.tunnelOpened = true;
        // Its admission ended while its connection was made: it carries
        // nothing.
        if (admission.stage !== "admitted") this.#deps.cutTunnel(admission.id, "cut: its admission ended before its tunnel opened");
        return;
      case "handshake_sent":
        admission.handshake = { mono: event.mono, wall: event.wall };
        if (this.#lastHandshake === null || event.mono > this.#lastHandshake.mono) this.#lastHandshake = { mono: event.mono, wall: event.wall };
        // CDP must show this socket's handshake soon.
        if (admission.socket === null) this.#await(admission, this.#timings.bindWaitMs, "its tunnel carried a handshake CDP did not show");
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
        if (admission.stage === "queued" || admission.stage === "asking") {
          this.#endAsk(admission, `the connection went before its admission (${event.result})`);
          return;
        }
        if (admission.stage === "admitted" && !event.handshakeSent) {
          this.#done(admission, { sent: false, status: null, error: `the tunnel ended before the handshake request (${event.result})` });
          return;
        }
        if (this.#current === admission && event.handshakeSent && admission.socket?.state !== "ended") {
          // CDP's word on the socket — its answer, its end — may still be on
          // its way: the proxy's end and CDP's travel apart.
          this.#await(admission, this.#timings.accountWaitMs, "its tunnel ended and CDP did not say how its socket ended");
        }
        this.#settle(admission);
        return;
    }
  }

  // ── CDP ────────────────────────────────────────────────────────────────
  //
  // Only live events of this operator's Chrome come here (#take); each
  // handler returns the durability of what it wrote, or null.

  #key(event: CdpEvent): string | null {
    const requestId = (event.params as { requestId?: unknown }).requestId;
    return typeof requestId === "string" ? `${event.sessionId ?? ""}|${requestId}` : null;
  }

  /** When Chrome saw it (Network.MonotonicTime, on the operator's clock),
   *  else now — an event's stamp. */
  #at(event: CdpEvent): { mono: number; wall: number } {
    const now = monoMs();
    const seen = Number((event.params as { timestamp?: unknown }).timestamp) * 1000;
    const mono = Number.isFinite(seen) && seen > 0 && seen <= now + 1000 && seen >= now - 3_600_000 ? seen : now;
    return { mono, wall: Math.round(wallMs() - (now - mono)) };
  }

  /** The socket an event is of — one of this Chrome to the socket host — or
   *  why the event is none of this path's: "other" (another host, another
   *  Chrome), "unknown" (CDP did not show it being created). */
  #socket(event: CdpEvent): CdpSocket | "other" | "unknown" {
    if (this.#deps.targetType(event.sessionId ?? null) === null) return "other";
    const key = this.#key(event);
    if (key === null) return "other";
    const socket = this.#sockets.get(key);
    if (socket === undefined) return "unknown";
    return this.#socketHost(socket.host) ? socket : "other";
  }

  /** Something of a socket no connection is kept for (one ended, one never
   *  bound, one of another Chrome): dropped, counted. */
  #drop(what: string): null {
    this.#dropped += 1;
    if (this.#dropped === 1 || this.#dropped % 100 === 0) this.#log("event.dropped", { what, count: this.#dropped });
    return null;
  }

  #onCreated(event: CdpEvent): Taken {
    if (this.#deps.targetType(event.sessionId ?? null) === null) return this.#drop("a socket of no target of this Chrome");
    const key = this.#key(event);
    if (key === null || this.#sockets.has(key)) return null;
    const url = String((event.params as { url?: unknown }).url ?? "");
    const socket: CdpSocket = { key, url, host: hostOf(url), context: contextOf(this.#deps.targetType(event.sessionId ?? null)), guessedBy: null, admission: null, state: "new" };
    remember(this.#sockets, key, socket, MAX_SOCKETS);
    return null;
  }

  /** The oldest socket of `host` still to connect, for `wsAdmit`'s label
   *  (a label only: nothing is bound by it). */
  #waitingSocket(host: string): CdpSocket | null {
    for (const socket of this.#sockets.values()) {
      if (socket.host === host && socket.state === "new" && (socket.guessedBy === null || !this.#admissions.has(socket.guessedBy))) return socket;
    }
    return null;
  }

  /** The current admission whose tunnel is open and whose socket is not
   *  bound yet: the one a handshake can be of. */
  #waitingForHandshake(): Admission | null {
    const current = this.#current;
    // After a socket that was not accounted for, nothing is bound until
    // Chrome starts again.
    if (this.#closedUntilChrome !== null) return null;
    return current !== null && current.tunnelOpened && current.socket === null ? current : null;
  }

  /** A handshake: only the current admission's tunnel can carry one, so
   *  the socket is that admission's. */
  #onWillSendHandshake(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    const waiting = this.#waitingForHandshake();
    if (socket === "other") return null;
    if (socket === "unknown") {
      // Its host is not known: it could be the one the tunnel carries.
      if (waiting !== null) this.#failClosed(waiting, "a handshake of a socket CDP did not show being created, while a tunnel waits for one");
      return this.#drop("a handshake of a socket CDP did not show being created");
    }
    if (socket.state !== "new") return this.#drop("a second handshake of a socket");
    if (waiting === null) {
      const current = this.#current;
      // A tunnel carries one socket: a second handshake while the current
      // one is bound cannot be told apart from it.
      if (current !== null && current.tunnelOpened && current.socket !== null && current.tunnelEnded === null) {
        this.#failClosed(current, "a second socket's handshake while the current one is bound");
        return null;
      }
      // No tunnel is open for it: a socket whose CONNECT was refused, or one
      // whose tunnel is gone — nothing of it can be kept.
      socket.state = "ended";
      return this.#drop("a handshake no tunnel is open for");
    }
    socket.admission = waiting;
    socket.state = "handshaking";
    waiting.socket = socket;
    this.#stopAwaiting(waiting);
    // Its tunnel ended already: CDP must say how it went.
    if (waiting.tunnelEnded !== null) this.#await(waiting, this.#timings.accountWaitMs, "its tunnel ended and CDP did not say how its socket ended");
    this.#log("socket.bound", { connectionId: waiting.id, context: socket.context });
    return null;
  }

  #onHandshakeResponse(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (typeof socket === "string") return this.#drop("a handshake's answer of a socket not bound");
    const admission = socket.admission;
    if (admission === null || socket.state !== "handshaking") return this.#drop("a handshake's answer of a socket not bound");
    const response = (event.params as { response?: { status?: unknown; headers?: unknown } }).response;
    const status = Number(response?.status);
    const known = Number.isInteger(status) ? status : null;
    admission.status = known;
    admission.extensions = extensionsOf(response?.headers);
    if (known !== 101) {
      // Its handshake failed: the socket's life is over.
      socket.state = "ended";
      this.#done(admission, { sent: true, status: known, error: `the handshake was answered ${String(known)}` });
      this.#settle(admission);
      return null;
    }
    if (admission.stage !== "admitted" || admission.tunnelEnded !== null) {
      // Its tunnel is gone (or its admission ended): the answer only tells
      // how its handshake went; what it carried is not kept.
      socket.state = "answered";
      this.#uncovered ??= this.#last ?? { seq: null, wall: wallMs() };
      this.#done(admission, { sent: true, status: null, error: "the tunnel ended with the handshake's answer 101: not kept" });
      this.#settle(admission);
      return null;
    }
    const done = this.#finish(admission, { sent: true, status: 101, error: null });
    if (done === null) return null;
    const at = this.#at(event);
    // The open, its outcome and the reconnect's gap: one commit, tried until
    // durable whatever becomes of the socket meanwhile.
    const uncovered = this.#uncovered;
    const opened: GroupItem[] = [
      { event: { kind: "ws.open", connectionId: admission.id, attemptId: done.attemptId, sessionFingerprint: this.#deps.sessionFingerprint() ?? admission.fingerprint }, at, connection: { connectionId: admission.id, opened: true } },
      { outcome: done },
    ];
    // The gap's "from" is the mark it was made with — its number as known
    // at each try (the close before it may become durable meanwhile).
    const items = (): GroupItem[] => (uncovered === null ? opened : [{ gap: "ws_reconnect", from: { seq: uncovered.seq, wall: uncovered.wall } }, ...opened]);
    socket.state = "open";
    this.#open.set(admission.id, socket);
    this.#uncovered = null;
    const mark: Mark = { seq: null, wall: at.wall };
    this.#last = mark;
    const durable = this.#write(
      `open:${admission.id}`,
      items,
      (written) => {
        this.#saved_(written, mark);
        this.#settle(admission);
      },
      done,
    );
    if (durable !== null) this.#settled = Promise.all([this.#settled, durable]);
    return durable === null ? null : { durable };
  }

  #onFrameReceived(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (typeof socket === "string" || socket.admission === null) return this.#drop("a frame of a socket not bound");
    if (socket.state !== "open") {
      if (socket.state === "answered") this.#uncovered ??= this.#last ?? { seq: null, wall: wallMs() };
      return this.#drop("a frame of a socket not kept");
    }
    const response = (event.params as { response?: { opcode?: unknown; payloadData?: unknown } }).response;
    if (response?.opcode !== 1 || typeof response.payloadData !== "string") {
      // Not text: Fansly's socket sends none; counted, its content not kept.
      this.#binaryFrames += 1;
      if (this.#binaryFrames === 1 || this.#binaryFrames % 100 === 0) this.#log("frame.not_text", { connectionId: socket.admission.id, opcode: Number(response?.opcode), count: this.#binaryFrames });
      return null;
    }
    const at = this.#at(event);
    const appended = this.#deps.buffer.append({ kind: "ws.in", connectionId: socket.admission.id, frame: response.payloadData }, at);
    if (!appended.ok) {
      // The buffer stops the page itself, and its own gap follows.
      this.#log("event.unkept", { kind: "ws.in", reason: appended.reason });
      return null;
    }
    const mark: Mark = { seq: null, wall: at.wall };
    this.#last = mark;
    const durable = appended.durable.then((written) => {
      this.#saved_(written, mark);
      if (!written.ok) this.#log("event.unkept", { kind: "ws.in", reason: written.reason });
    });
    this.#settled = Promise.all([this.#settled, durable]);
    return { durable };
  }

  #onFrameSent(event: CdpEvent): Taken {
    // Every socket's, whatever its host or state: what left is checked.
    const key = this.#key(event);
    const socket = key === null ? null : (this.#sockets.get(key) ?? null);
    const response = (event.params as { response?: { opcode?: unknown; payloadData?: unknown } }).response;
    const opcode = Number(response?.opcode);
    const payload = typeof response?.payloadData === "string" ? response.payloadData : "";
    const connectionId = socket?.state === "open" ? (socket.admission?.id ?? null) : null;
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

  #onFrameError(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (typeof socket === "string") return null;
    if (socket.state === "new" || socket.admission === null) {
      // Not bound: one whose CONNECT was refused (or waited in vain). Its
      // life is over; nothing of it was kept.
      socket.state = "ended";
      return null;
    }
    if (socket.state !== "handshaking") return null;
    // Its handshake failed: the socket's life is over.
    const message = String((event.params as { errorMessage?: unknown }).errorMessage ?? "").slice(0, 160);
    const code = Number(/response code: (\d{3})/.exec(message)?.[1] ?? NaN);
    const admission = socket.admission;
    socket.state = "ended";
    this.#done(admission, { sent: admission.handshake !== null, status: Number.isInteger(code) ? code : admission.status, error: message || "the handshake failed" });
    this.#settle(admission);
    return null;
  }

  #onClosed(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (typeof socket === "string") return this.#drop("a close of a socket not bound");
    const admission = socket.admission;
    switch (socket.state) {
      case "open":
        return this.#close(socket, "closed", this.#at(event));
      case "handshaking":
        socket.state = "ended";
        this.#done(admission!, { sent: admission!.handshake !== null, status: admission!.status, error: "the socket closed before its handshake's answer" });
        this.#settle(admission!);
        return null;
      case "answered":
        socket.state = "ended";
        this.#settle(admission!);
        return null;
      case "new":
        socket.state = "ended";
        return null;
      case "ended":
        return this.#drop("a close after the socket's end");
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /** A durable event of the socket's stream: the last one saved. */
  #saved_(written: Durable, mark: Mark): void {
    if (!written.ok || written.seq === null) return;
    mark.seq = written.seq;
    if (this.#saved.seq === null || written.seq > this.#saved.seq) this.#saved = { seq: written.seq, wall: mark.wall };
  }

  /** A connection's one terminal close (its kept row goes in the same
   *  commit), after its open: closing at once in memory — nothing more of
   *  it is written — ended once durable. */
  #close(socket: CdpSocket, why: string, at: { mono: number; wall: number } | null): Taken {
    socket.state = "ended";
    const admission = socket.admission!;
    const connectionId = admission.id;
    this.#open.delete(connectionId);
    const stamp = at ?? { mono: monoMs(), wall: wallMs() };
    // The connection's last event; what may be missing from it on until the
    // next connection opens. Its number once the close is durable.
    const mark: Mark = { seq: null, wall: stamp.wall };
    this.#last = mark;
    this.#uncovered = mark;
    this.#log("socket.closed", { connectionId, why });
    this.#deps.journal({ connectionId, event: "closed", detail: why });
    const durable = this.#end(
      connectionId,
      [{ event: { kind: "ws.close", connectionId, code: null, reason: null }, at: stamp, connection: { connectionId, gone: true } }],
      null,
      (written) => {
        this.#saved_(written, mark);
        this.#settle(admission);
      },
      this.#openWaits(connectionId),
    );
    if (durable !== null) this.#settled = Promise.all([this.#settled, durable]);
    return durable === null ? null : { durable };
  }

  /** A connection's open that the buffer did not take yet (it waits for a
   *  retry): what follows it waits for it to be durable. One the buffer
   *  took goes before whatever is taken after it. */
  #openWaits(connectionId: string): Promise<void> | undefined {
    const opening = this.#writes.get(`open:${connectionId}`);
    return opening !== undefined && !opening.accepted ? opening.written : undefined;
  }

  /** The browser goes under open connections: their closes, after the
   *  browser's gap — from the last event of the socket saved before them,
   *  once every write before them has settled — in one commit, after their
   *  opens. */
  #closeAll(sockets: CdpSocket[], why: string): void {
    const stamp = { mono: monoMs(), wall: wallMs() };
    const mark: Mark = { seq: null, wall: stamp.wall };
    const ids: string[] = [];
    const before: Array<Promise<unknown>> = [this.#settled];
    for (const socket of sockets) {
      const connectionId = socket.admission!.id;
      socket.state = "ended";
      this.#open.delete(connectionId);
      if (this.#ended.has(connectionId) || this.#ending.has(connectionId)) continue;
      ids.push(connectionId);
      const opening = this.#writes.get(`open:${connectionId}`);
      if (opening) before.push(opening.written);
      this.#log("socket.closed", { connectionId, why });
      this.#deps.journal({ connectionId, event: "closed", detail: why });
    }
    if (ids.length === 0) return;
    this.#last = mark;
    this.#uncovered = mark;
    let from: { seq: number | null; wall: number | null } | null = null;
    const key = `chrome:${++this.#chromeGaps}`;
    for (const id of ids) this.#ending.set(id, key);
    this.#write(
      key,
      () => {
        // Taken when the first try goes: every write before the closes has
        // settled by then, and nothing of these connections comes after.
        from ??= { ...this.#saved };
        return [{ gap: "chrome_restart", from }, ...ids.map((connectionId): GroupItem => ({ event: { kind: "ws.close", connectionId, code: null, reason: null }, at: stamp, connection: { connectionId, gone: true } }))];
      },
      (written) => {
        for (const id of ids) {
          this.#ending.delete(id);
          remember(this.#ended, id, true, MAX_GONE);
        }
        this.#saved_(written, mark);
      },
      null,
      Promise.all(before),
    );
  }

  /** The write that ends a connection: one per connection. */
  #end(connectionId: string, items: GroupItem[], tell: WsDone | null, then?: (durable: Durable) => void, after?: Promise<unknown>): Promise<unknown> | null {
    if (this.#ended.has(connectionId) || this.#ending.has(connectionId)) return null;
    const key = `end:${connectionId}`;
    this.#ending.set(connectionId, key);
    return this.#write(
      key,
      () => items,
      (durable) => {
        this.#ending.delete(connectionId);
        remember(this.#ended, connectionId, true, MAX_GONE);
        then?.(durable);
      },
      tell,
      after,
    );
  }

  /** A write that matters: a group in one commit, tried again until it is
   *  durable (#later); only then is what it stands for done. One a key.
   *  `after`: its first try waits for it. */
  #write(key: string, build: Write["build"], done: Write["done"], tell: WsDone | null, after?: Promise<unknown>): Promise<unknown> | null {
    if (this.#writes.has(key)) return null;
    let markWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => (markWritten = resolve));
    const write: Write = { key, build, done, tell, told: false, queued: false, accepted: false, written, markWritten };
    this.#writes.set(key, write);
    if (after === undefined) return this.#attempt(write);
    return after.then(
      () => this.#attempt(write),
      () => this.#attempt(write),
    );
  }

  #attempt(write: Write): Promise<unknown> | null {
    let items: GroupItem[] | "later";
    try {
      items = write.build();
    } catch (error) {
      this.#log("write.unbuilt", { key: write.key, error: errorMessage(error) });
      items = "later";
    }
    if (items === "later") {
      this.#later(write, "the buffer is not open");
      return null;
    }
    const appended = this.#deps.buffer.appendGroup(items);
    if (!appended.ok) {
      this.#later(write, appended.reason);
      return null;
    }
    write.accepted = true;
    return appended.durable.then((durable) => {
      if (!durable.ok) {
        this.#later(write, durable.reason);
        return;
      }
      this.#writes.delete(write.key);
      this.#retryStep = 0;
      write.markWritten();
      write.done(durable);
    });
  }

  /** Refused or failed: tried again after a growing pause (and when the
   *  buffer has room); an outcome is told to the engine from memory now. */
  #later(write: Write, reason: string): void {
    write.accepted = false;
    if (write.tell !== null && !write.told) {
      write.told = true;
      this.#deps.link.send(write.tell);
    }
    this.#log("write.later", { key: write.key, reason });
    if (!write.queued) {
      write.queued = true;
      this.#retry.push(write);
    }
    if (this.#retryTimer !== null) return;
    const ladder = this.#timings.retryMs;
    const delay = ladder[Math.min(this.#retryStep, ladder.length - 1)] ?? 30_000;
    this.#retryStep += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.retryNow();
    }, delay);
    this.#retryTimer.unref();
  }

  /** The writes waiting go now (the buffer has room, or opened, or their
   *  pause is over). */
  retryNow(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    for (const write of this.#retry.splice(0)) {
      write.queued = false;
      void this.#attempt(write);
    }
  }

  /** Stops the timers (the operator stops). */
  close(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    for (const admission of [this.#current, ...this.#queue, ...this.#admissions.values()]) {
      if (admission === null) continue;
      if (admission.waitTimer) clearTimeout(admission.waitTimer);
      if (admission.accountTimer) clearTimeout(admission.accountTimer);
      admission.waitTimer = admission.accountTimer = null;
    }
  }

  // ── admissions, and accounting for their sockets ───────────────────────

  /** A socket's CONNECT that waited is refused: no attempt of it exists. */
  #endAsk(admission: Admission, why: string): void {
    if (admission.stage !== "queued" && admission.stage !== "asking") return;
    const asked = admission.stage === "asking";
    admission.stage = "done";
    if (admission.waitTimer) clearTimeout(admission.waitTimer);
    admission.waitTimer = null;
    const queued = this.#queue.indexOf(admission);
    if (queued >= 0) this.#queue.splice(queued, 1);
    this.#forget(admission, why);
    this.#releaseGuess(admission);
    this.#log("admit.ended", { connectionId: admission.id, why, asked });
    this.#deps.journal({ connectionId: admission.id, event: "refused", detail: why });
    admission.resolve(null);
    this.#settle(admission);
  }

  /** The handshake's outcome: final. Unless it opened (its ws.open carries
   *  it), it ends the connection — kept with its row's end, in one commit —
   *  and its tunnel is cut: no tunnel lives without its socket open. */
  #done(admission: Admission, outcome: Outcome): void {
    const done = this.#finish(admission, outcome);
    if (done === null) return;
    if (admission.tunnelOpened && admission.tunnelEnded === null) this.#deps.cutTunnel(admission.id, `cut: ${outcome.error ?? "its admission ended"}`);
    this.#end(
      admission.id,
      [{ outcome: done }, { connection: { connectionId: admission.id, gone: true } }],
      done,
      () => this.#settle(admission),
    );
    this.#settle(admission);
  }

  /** The admission is answered (in memory at once); its outcome. */
  #finish(admission: Admission, outcome: Outcome): WsDone | null {
    if (admission.stage === "done" || admission.attemptId === null) return null;
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
    return done;
  }

  #finishQuietly(admission: Admission, why: string): void {
    admission.stage = "done";
    if (admission.waitTimer) clearTimeout(admission.waitTimer);
    admission.waitTimer = null;
    this.#forget(admission, why);
    this.#releaseGuess(admission);
    // A CONNECT still waiting for it is refused (a no-op once it went on).
    admission.resolve(null);
  }

  #forget(admission: Admission, why: string): void {
    this.#admissions.delete(admission.id);
    remember(this.#gone, admission.id, { why, attemptId: admission.attemptId }, MAX_GONE);
  }

  #releaseGuess(admission: Admission): void {
    for (const socket of this.#sockets.values()) if (socket.guessedBy === admission.id) socket.guessedBy = null;
  }

  /** CDP's word on the current admission's socket must come within `ms`:
   *  else the socket is not accounted for. */
  #await(admission: Admission, ms: number, why: string): void {
    if (this.#current !== admission) return;
    this.#stopAwaiting(admission);
    admission.accountTimer = setTimeout(() => {
      admission.accountTimer = null;
      // CDP said what it had to (what waits now is the buffer's): accounted
      // for once its writes are durable.
      if (this.#current !== admission || this.#cdpDone(admission)) return;
      this.#failClosed(admission, why);
    }, ms);
  }

  #stopAwaiting(admission: Admission): void {
    if (admission.accountTimer) clearTimeout(admission.accountTimer);
    admission.accountTimer = null;
  }

  /** Is the current admission's socket accounted for? Then the next CONNECT
   *  is taken up. */
  #settle(admission: Admission): void {
    if (this.#current !== admission || admission.stage !== "done") return;
    if (this.#ending.has(admission.id) || this.#writes.has(`open:${admission.id}`)) return;
    if (!this.#cdpDone(admission)) return;
    this.#account(admission, this.#quiet(admission) ? "no socket spoke through its tunnel" : "its socket ended");
  }

  /** No tunnel, or none that carried a handshake: no socket spoke through
   *  it. */
  #quiet(admission: Admission): boolean {
    return !admission.tunnelOpened || (admission.tunnelEnded !== null && admission.handshake === null);
  }

  /** Nothing more is owed by CDP of this admission's socket: none spoke
   *  through its tunnel, or the one bound to it ended. */
  #cdpDone(admission: Admission): boolean {
    return this.#quiet(admission) || admission.socket?.state === "ended";
  }

  #account(admission: Admission, how: string): void {
    if (this.#current !== admission) return;
    this.#stopAwaiting(admission);
    this.#current = null;
    this.#log("socket.accounted", { connectionId: admission.id, how });
    this.#next();
  }

  /** A socket that cannot be accounted for: its tunnel is cut, its
   *  admission ends unopened, and the page stops — Chrome goes (whatever it
   *  still holds of that socket with it) and the page starts again; nothing
   *  is admitted until then. */
  #failClosed(admission: Admission, why: string): void {
    if (this.#closedUntilChrome !== null) return;
    this.#closedUntilChrome = why;
    // What its socket carried is not in the stream: the next connection's
    // gap covers it.
    this.#uncovered ??= this.#last ?? { seq: null, wall: wallMs() };
    this.#log("socket.unaccounted", { connectionId: admission.id, why });
    this.#deps.journal({ connectionId: admission.id, event: "failed", detail: `not accounted for: ${why}` });
    this.#deps.cutTunnel(admission.id, `cut: ${why}`);
    if (admission.stage === "admitted") this.#done(admission, { sent: admission.handshake !== null, status: null, error: `not accounted for: ${why}` });
    for (const waiting of [...this.#queue]) this.#endAsk(waiting, `a socket before it was not accounted for: ${why}`);
    this.#deps.stop("ws_unaccounted", `a socket could not be accounted for: ${why}`, "kill");
  }
}

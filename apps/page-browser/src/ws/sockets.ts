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
//  2. `wsAdmitResult`: refused — the CONNECT is refused; admitted — the
//     admission is written to the buffer first (an operator that starts
//     again ends it: below), then, with the deadline still ahead, the tunnel opens
//     and its handshake request may go only before the deadline
//     (egress/proxy.ts; spec §9). An answer counts
//     only on the engine connection it was asked on: a link that changes or
//     goes refuses every socket still waiting. An admission that finds its
//     CONNECT gone (Chrome dropped it, the wait ended) is closed at once with
//     `wsDone`, `sent: false`: the engine never waits for a socket that is
//     not there (stage 1, FINDINGS 27).
//  3. A CDP socket is tied to an admission only by what the shared clock
//     proves: Chrome's timestamps (Network.MonotonicTime — base TimeTicks,
//     CLOCK_MONOTONIC, the operator's clock: plan §4.2, step 5) against the
//     proxy's moments of each socket's tunnel. A tunnel carries one
//     handshake at most. The one that carried a socket's handshake was open
//     (its CONNECT accepted) before Chrome stamped that handshake
//     (webSocketWillSendHandshakeRequest), and its request went up before
//     Chrome stamped the answer (…HandshakeResponseReceived, or the error or
//     close that came instead). At the answer, the tunnels that fit and are
//     not spent on another socket are its carriers:
//      - one, its admission waiting and its tunnel open: bound for good —
//        the handshake's outcome, and at a 101 the connection;
//      - one whose tunnel ended: its outcome only (never an open); one whose
//        admission is over: nothing — the socket is not kept;
//      - none: the socket is not kept (a gap covers it);
//      - more: fail closed — each is spent, its tunnel cut, its admission
//        ended as not opened; the socket is not kept.
//     A carrier is spent on the socket it is tied to, bound or not: never
//     anyone's again. What CDP says later of a socket not kept, or closed,
//     is dropped and counted. An admission that ends without opening has
//     its tunnel cut, and one whose request went up but whose socket CDP
//     does not tie within `bindWaitMs` ends so too. One socket is admitted
//     at a time — the engine's rule (one `ws.connect` in flight), held here
//     as well: an admission while another admitted socket is not bound, or
//     another tunnel's handshake is not tied to CDP's word yet, is closed
//     unused. So more than one carrier is a fault; Chrome's stamps are the
//     renderer's and late only by its delay, which the tie allows up to
//     CARRIER_HORIZON_MS.
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
//  - `ws.open` at the 101, with its outcome (and the reconnect's gap) in
//    the same commit: the connection id, the attempt id, the session's
//    fingerprint;
//  - `ws.in` — every incoming text frame as it is (Fansly's socket speaks
//    text; a binary frame is counted, not kept);
//  - `ws.close` — exactly one a connection, the last of it: when CDP says
//    the socket closed, or when the browser goes under it (CDP may never
//    say). A connection's closing is known at once, in memory: what CDP
//    still says of it afterwards is dropped and counted — the gap after the
//    close covers it.
//  - `gap` where frames may be missing (spec §6.1 reasons): `operator_start`
//    at every start of the operator, from the last event saved before it;
//    `chrome_restart` when a new Chrome starts after one that had a
//    connection; `ws_reconnect` before a connection that opens after another
//    one closed — from that one's last event. A buffer that fills up writes
//    its own (`buffer_full`, `disk_full`).
//
// Writes that end something — a connection's ws.close, the outcome of one
// that never opened (each with the end of its kept row), the start's gap and
// what it ends, a Chrome's restart gap — are groups written in one commit
// (buffer.ts appendGroup), one write a key. Refused or failed, a group is
// tried again with a growing pause (1 s … 30 s), whatever Chrome does, and
// at once when the buffer has room; its boundaries (a gap's "from") are the
// ones it was made with. What it ends is ended only once it is durable:
// until then the start leaves it to its write, and nothing ends it twice.
// An outcome refused is told to the engine from memory at once (and kept
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
  /** How long a socket's CONNECT waits for the engine (spec §8.2: 60 s). */
  admitWaitMs: number;
  /** After a tunnel that sent its request ends, how long CDP has to say
   *  how the handshake went. */
  handshakeGraceMs: number;
  /** After its handshake request went up, how long an admission waits for
   *  CDP's word to tie its socket before its tunnel is cut. */
  bindWaitMs: number;
  /** The pauses between tries of a refused or failed write; the last one
   *  repeats. */
  retryMs: number[];
}

const DEFAULT_TIMINGS: SocketTimings = { admitWaitMs: 60_000, handshakeGraceMs: 2000, bindWaitMs: 15_000, retryMs: [1000, 2000, 5000, 15_000, 30_000] };

/** How much later than the tunnel's request Chrome's renderer may stamp the
 *  handshake and still be tied to it: a tunnel whose request went up longer
 *  before is no carrier (a renderer that late hangs). */
const CARRIER_HORIZON_MS = 30_000;

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
  stage: "asking" | "admitted" | "done";
  askedMono: number;
  resolve: (deadline: number | null) => void;
  waitTimer: NodeJS.Timeout | null;
  generation: number;
  attemptId: number | null;
  /** Its tunnel, once the proxy opened it. */
  tunnel: Tunnel | null;
  /** The handshake request went up (the proxy's word). */
  handshake: { mono: number; wall: number } | null;
  /** Its tunnel ended (the proxy's word): why. */
  tunnelEnded: string | null;
  graceTimer: NodeJS.Timeout | null;
  bindTimer: NodeJS.Timeout | null;
  socket: CdpSocket | null;
  status: number | null;
  /** The live session when it was asked (there is always one then). */
  fingerprint: string;
  /** The extensions the server's answer negotiated (CDP's word), if any. */
  extensions: string | null;
}

/** A socket's tunnel as the proxy told of it (CLOCK_MONOTONIC moments). */
interface Tunnel {
  admission: Admission;
  /** Its CONNECT accepted (the 200 written). */
  openMono: number;
  /** Its handshake request went up. */
  handshakeMono: number | null;
  endedMono: number | null;
  /** Tied to a CDP socket (bound or not), or spent by an ambiguity. */
  spent: boolean;
}

/** A socket as CDP shows it to this operator. */
interface CdpSocket {
  key: string;
  url: string;
  host: string;
  context: WsAdmit["context"];
  /** The admission asking for this socket's CONNECT (a guess for the url and
   *  context `wsAdmit` names — a label, never a binding). */
  guessedBy: string | null;
  /** When Chrome stamped its handshake (CLOCK_MONOTONIC). */
  handshakeAt: number | null;
  /** Its admission, bound at the handshake's answer, for good. */
  admission: Admission | null;
  /** new → handshaking → open (101) → closed (its one terminal close; or an
   *  answer that opened nothing); lost: no admission was proven its —
   *  nothing of it is kept. */
  state: "new" | "handshaking" | "open" | "closed" | "lost";
}

/** What a handler wrote: acknowledged to the holder once durable; null —
 *  nothing (or nothing that could be taken now), acknowledged at once. */
type Taken = { durable: Promise<unknown> } | null;

/** A write that ends something: tried until durable. */
interface Write {
  key: string;
  /** The group as it is now; "later": not now (the buffer cannot be
   *  read); null: nothing left to write. */
  build: () => GroupItem[] | "later" | null;
  /** It is durable. */
  done: (durable: Durable) => void;
  /** Told to the engine from memory when the group was refused. */
  tell: WsDone | null;
  told: boolean;
  queued: boolean;
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
  /** The proxy's socket tunnels of this Chrome, by admission id, while they
   *  may still be a carrier. */
  readonly #tunnels = new Map<string, Tunnel>();
  /** Connections open now (their ws.open written), by id. */
  readonly #open = new Map<string, CdpSocket>();
  /** Connections whose end is durable in the stream. */
  readonly #ended = new Map<string, true>();
  /** Writes not durable yet, by key; the refused ones wait in the queue. */
  readonly #writes = new Map<string, Write>();
  readonly #queue: Write[] = [];
  #retryTimer: NodeJS.Timeout | null = null;
  #retryStep = 0;
  #chromeStarts = 0;
  /** The last event of the socket's stream (ws.open, ws.in, ws.close). */
  #last: Mark | null = null;
  /** A connection closed and no gap written since: from its last event. */
  #uncovered: Mark | null = null;
  /** A connection opened since the last gap mark. */
  #openedSinceGap = false;
  #lastHandshake: { mono: number; wall: number } | null = null;
  #binaryFrames = 0;
  /** Events dropped: delivered again from before this operator, or of no
   *  socket it has open (one closed, lost, or never seen). */
  #replayed = 0;
  #dropped = 0;

  constructor(deps: SocketDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? makeLog("ws");
    this.#now = deps.now ?? monoMs;
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

  /** Admissions waiting for the engine or for their handshake's outcome. */
  get pending(): number {
    return this.#admissions.size;
  }

  /** Writes not durable yet (tests, diagnostics). */
  get unwritten(): number {
    return this.#writes.size;
  }

  // ── the proxy's side ───────────────────────────────────────────────────

  /** A CONNECT to the socket host: its admission, or why it is refused. */
  admit(host: string, port: number): SocketTicket | string {
    const fingerprint = this.#deps.sessionFingerprint();
    const refused = this.#deps.notAdmitting() ?? (fingerprint === null || this.#deps.authorizationBytes() === null ? "no session of the site yet: its socket could not authorize" : null);
    if (refused !== null || fingerprint === null) {
      const why = refused ?? "no session of the site yet";
      this.#log("admit.refused", { host, why });
      this.#deps.journal({ connectionId: null, event: "refused", detail: `no admission asked: ${why}` });
      return why;
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
      tunnel: null,
      handshake: null,
      tunnelEnded: null,
      graceTimer: null,
      bindTimer: null,
      socket: null,
      status: null,
      fingerprint,
      extensions: null,
    };
    if (socket !== null) socket.guessedBy = id;
    this.#admissions.set(id, admission);
    const wait = this.#timings.admitWaitMs;
    admission.waitTimer = setTimeout(() => this.#endAsk(admission, "the wait for the engine's admission is over"), wait);
    const url = socket?.url ?? `wss://${host}${port === 443 ? "" : `:${port}`}/`;
    const context = socket?.context ?? "page";
    this.#deps.link.send({ type: "wsAdmit", connectionId: id, url, context, sessionFingerprint: fingerprint, requestedMono: now, waitDeadlineMono: now + wait });
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
    const unusable = !(result.deadlineMono > now)
      ? "the admission came expired"
      : (this.#deps.notAdmitting() ?? this.#unboundOther(admission));
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
      this.#end(admission.id, [{ connection: { connectionId: admission.id, gone: true } }], null);
      this.#deps.cutTunnel(admission.id, "cut: the engine's recover closed its admission");
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
    await this.#committed();
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
    this.#uncovered = null;
    this.#openedSinceGap = false;
  }

  /** Everything accepted so far committed, and what follows from that run
   *  (the numbers of the events in their marks): the commit's callbacks are
   *  promise jobs, all done before the next turn. */
  async #committed(): Promise<void> {
    await this.#deps.buffer.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** The buffer opened, or has room again: what waits is written now. */
  bufferOpened(): void {
    this.retryNow();
  }

  /** A new Chrome starts: a connection of the previous one is gone (each
   *  open one closed now, if it was not) — its gap from the last event of
   *  the socket, tried until durable. */
  async chromeStarting(): Promise<void> {
    this.#chromeGone("the previous Chrome is gone");
    await this.#committed();
    // From the last event of the socket — kept as it is when the gap is
    // written, whenever that is (its number once durable).
    const from: Mark | null = this.#openedSinceGap || this.#uncovered !== null ? (this.#last ?? { seq: null, wall: wallMs() }) : null;
    this.#uncovered = null;
    this.#openedSinceGap = false;
    const key = `chrome:${++this.#chromeStarts}`;
    if (from === null) return;
    this.#write(key, () => [{ gap: "chrome_restart", from: { seq: from.seq, wall: from.wall } }], () => undefined, null);
  }

  /** The page stops or its browser goes (the exit is closed already): what
   *  waits is refused, every admission still open ends, and every open
   *  connection gets its one terminal close — CDP may never say so, and
   *  whatever it still says of them is dropped. */
  endAll(reason: string): void {
    for (const admission of [...this.#admissions.values()]) {
      if (admission.stage === "asking") this.#endAsk(admission, `the page stopped: ${reason}`);
      else if (admission.stage === "admitted") this.#done(admission, { sent: admission.handshake !== null, status: admission.status, error: `the page stopped: ${reason}` });
    }
    this.#chromeGone(`the page stopped: ${reason}`);
  }

  /** The sockets of this Chrome are gone (or nothing of them is listened to
   *  any more): each open connection gets its one close; whatever CDP says
   *  of any of them later is dropped, and their tunnels carry nothing new. */
  #chromeGone(why: string): void {
    for (const socket of [...this.#open.values()]) this.#close(socket, why, null);
    for (const socket of this.#sockets.values()) if (socket.state !== "lost") socket.state = "closed";
    this.#sockets.clear();
    this.#tunnels.clear();
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
      if (this.#ended.has(id) || this.#admissions.has(id) || this.#open.has(id) || this.#writes.has(`end:${id}`)) continue;
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
    const tunnel = admission.tunnel;
    switch (event.kind) {
      case "open": {
        if (tunnel !== null) return;
        const opened: Tunnel = { admission, openMono: monoMs(), handshakeMono: null, endedMono: null, spent: false };
        admission.tunnel = opened;
        // Its admission ended while its connection was made: it carries
        // nothing.
        if (admission.stage !== "admitted") {
          this.#deps.cutTunnel(admission.id, "cut: its admission ended before its tunnel opened");
          return;
        }
        remember(this.#tunnels, admission.id, opened, MAX_SOCKETS);
        return;
      }
      case "handshake_sent":
        admission.handshake = { mono: event.mono, wall: event.wall };
        if (tunnel !== null) tunnel.handshakeMono = event.mono;
        if (this.#lastHandshake === null || event.mono > this.#lastHandshake.mono) this.#lastHandshake = { mono: event.mono, wall: event.wall };
        if (admission.stage === "admitted" && admission.socket === null && admission.bindTimer === null) {
          // CDP's word must tie its socket soon, or it ends unused.
          admission.bindTimer = setTimeout(() => {
            admission.bindTimer = null;
            if (admission.stage === "admitted" && admission.socket === null) this.#done(admission, { sent: true, status: null, error: "no socket of CDP's was proven to be its" });
          }, this.#timings.bindWaitMs);
        }
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
        if (tunnel !== null) {
          tunnel.endedMono = monoMs();
          // No request went up on it: it carried no handshake.
          if (tunnel.handshakeMono === null) this.#tunnels.delete(admission.id);
        }
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

  /** Why an admission given now could not be used: another admitted socket
   *  is not bound yet, or another tunnel's handshake is not tied to CDP's
   *  word yet — one at a time, so that a socket's carrier is never in
   *  doubt. Null: it may be used. */
  #unboundOther(admission: Admission): string | null {
    for (const other of this.#admissions.values()) {
      if (other !== admission && other.stage === "admitted" && other.socket === null) return "another admitted socket is not tied to its CDP socket yet";
    }
    this.#prune(monoMs());
    for (const tunnel of this.#tunnels.values()) {
      if (tunnel.admission !== admission && !tunnel.spent && tunnel.handshakeMono !== null) return "another socket's handshake is not tied to CDP's word yet";
    }
    return null;
  }

  /** Tunnels that can carry nothing any more: one spent, one that ended
   *  past the horizon. */
  #prune(now: number): void {
    for (const [id, tunnel] of [...this.#tunnels]) {
      if (tunnel.spent || (tunnel.endedMono !== null && (tunnel.handshakeMono === null || tunnel.handshakeMono < now - CARRIER_HORIZON_MS))) this.#tunnels.delete(id);
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

  /** Chrome's moment of an event (Network.MonotonicTime, seconds, on the
   *  operator's clock), or null when it gives none. */
  #seen(event: CdpEvent): number | null {
    const seen = Number((event.params as { timestamp?: unknown }).timestamp) * 1000;
    return Number.isFinite(seen) && seen > 0 ? seen : null;
  }

  /** When Chrome saw it, else now — for an event's stamp. */
  #at(event: CdpEvent): { mono: number; wall: number } {
    const now = monoMs();
    const seen = this.#seen(event);
    const mono = seen !== null && seen <= now + 1000 && seen >= now - 3_600_000 ? seen : now;
    return { mono, wall: Math.round(wallMs() - (now - mono)) };
  }

  #socket(event: CdpEvent): CdpSocket | null {
    const key = this.#key(event);
    return key === null ? null : (this.#sockets.get(key) ?? null);
  }

  #newSocket(event: CdpEvent, key: string, url: string): CdpSocket {
    const socket: CdpSocket = { key, url, host: hostOf(url), context: contextOf(this.#deps.targetType(event.sessionId ?? null)), guessedBy: null, handshakeAt: null, admission: null, state: "new" };
    remember(this.#sockets, key, socket, MAX_SOCKETS);
    return socket;
  }

  /** Something of a socket this operator has no open connection for (one
   *  closed — after its one close — or not kept, or never seen): dropped,
   *  counted; the gap after it covers it. */
  #drop(what: string): null {
    this.#dropped += 1;
    if (this.#dropped === 1 || this.#dropped % 100 === 0) this.#log("event.dropped", { what, count: this.#dropped });
    return null;
  }

  #onCreated(event: CdpEvent): Taken {
    const key = this.#key(event);
    if (key === null || this.#sockets.has(key)) return null;
    this.#newSocket(event, key, String((event.params as { url?: unknown }).url ?? ""));
    return null;
  }

  /** The oldest socket of `host` still to connect, for `wsAdmit`'s label
   *  (a label only: nothing is tied by it). */
  #waitingSocket(host: string): CdpSocket | null {
    for (const socket of this.#sockets.values()) {
      if (socket.host === host && socket.state === "new" && (socket.guessedBy === null || !this.#admissions.has(socket.guessedBy))) return socket;
    }
    return null;
  }

  #onWillSendHandshake(event: CdpEvent): Taken {
    const key = this.#key(event);
    if (key === null) return null;
    const socket = this.#sockets.get(key) ?? this.#newSocket(event, key, "");
    if (socket.state !== "new") return this.#drop("a second handshake");
    const sent = this.#seen(event);
    if (sent === null) {
      this.#lose(socket, "its handshake came with no moment to tie it by");
      return null;
    }
    socket.handshakeAt = sent;
    socket.state = "handshaking";
    return null;
  }

  /** The admission whose tunnel carried a handshaking socket's handshake,
   *  by the clock: tunnels open before Chrome stamped the handshake, their
   *  request up by `until` (Chrome's stamp of how it ended), not spent. The
   *  one there is, spent on this socket; null: none (or more than one —
   *  those fail closed). */
  #carrier(socket: CdpSocket, until: number): Admission | null {
    const sent = socket.handshakeAt;
    if (sent === null) return null;
    this.#prune(monoMs());
    const carriers = [...this.#tunnels.values()].filter(
      (tunnel) =>
        !tunnel.spent &&
        tunnel.openMono < sent &&
        tunnel.handshakeMono !== null &&
        tunnel.handshakeMono <= until &&
        tunnel.handshakeMono >= sent - CARRIER_HORIZON_MS &&
        (socket.host === "" || tunnel.admission.host === socket.host),
    );
    for (const tunnel of carriers) tunnel.spent = true;
    if (carriers.length === 1) return carriers[0]!.admission;
    if (carriers.length > 1) {
      this.#log("socket.ambiguous", { url: urlForLogLine(socket.url), context: socket.context, carriers: carriers.length });
      for (const tunnel of carriers) this.#done(tunnel.admission, { sent: true, status: null, error: "its handshake could not be told apart from another socket's" });
    }
    return null;
  }

  /** No admission is proven a socket's: nothing of it is kept; a gap
   *  covers whatever it carries. */
  #lose(socket: CdpSocket, why: string): void {
    socket.state = "lost";
    this.#log("socket.lost", { url: urlForLogLine(socket.url), context: socket.context, why });
    this.#deps.journal({ connectionId: null, event: "failed", context: socket.context, detail: `a socket with no admission proven its: ${why}` });
    this.#uncovered ??= this.#last ?? { seq: null, wall: wallMs() };
  }

  #onHandshakeResponse(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (socket === null || socket.state === "lost") return this.#drop("a handshake's answer");
    if (socket.state === "new") {
      this.#lose(socket, "its answer came with no handshake to tie it by");
      return null;
    }
    if (socket.state !== "handshaking") return this.#drop("a handshake's answer");
    const response = (event.params as { response?: { status?: unknown; headers?: unknown } }).response;
    const status = Number(response?.status);
    const known = Number.isInteger(status) ? status : null;
    const at = this.#at(event);
    const admission = this.#carrier(socket, this.#seen(event) ?? monoMs());
    if (admission === null || admission.stage !== "admitted") {
      this.#lose(socket, admission === null ? "no one tunnel the clock allows carried its handshake" : "its admission is over");
      return null;
    }
    admission.status = known;
    admission.extensions = extensionsOf(response?.headers);
    if (admission.tunnelEnded !== null) {
      // Its tunnel is gone: the answer only tells how its handshake went.
      if (known === 101) this.#lose(socket, "its tunnel ended");
      else socket.state = "closed";
      this.#done(admission, { sent: true, status: known === 101 ? null : known, error: `the tunnel ended with the handshake's answer ${String(known)}` });
      return null;
    }
    // Bound for good.
    socket.admission = admission;
    admission.socket = socket;
    if (admission.bindTimer) clearTimeout(admission.bindTimer);
    admission.bindTimer = null;
    if (known !== 101) {
      socket.state = "closed";
      this.#done(admission, { sent: true, status: known, error: `the handshake was answered ${String(known)}` });
      return null;
    }
    const done = this.#finish(admission, { sent: true, status: 101, error: null });
    if (done === null) return null;
    // The open, its outcome and the reconnect's gap: one commit.
    const items: GroupItem[] = [];
    const uncovered = this.#uncovered;
    if (uncovered !== null) items.push({ gap: "ws_reconnect", from: { seq: uncovered.seq, wall: uncovered.wall } });
    items.push({ event: { kind: "ws.open", connectionId: admission.id, attemptId: done.attemptId, sessionFingerprint: this.#deps.sessionFingerprint() ?? admission.fingerprint }, at, connection: { connectionId: admission.id, opened: true } });
    items.push({ outcome: done });
    const appended = this.#deps.buffer.appendGroup(items);
    if (!appended.ok) {
      this.#notKept(socket, done, appended.reason);
      return null;
    }
    socket.state = "open";
    this.#open.set(admission.id, socket);
    this.#uncovered = null;
    this.#openedSinceGap = true;
    const mark: Mark = { seq: null, wall: at.wall };
    this.#last = mark;
    return {
      durable: appended.durable.then((durable) => {
        if (durable.ok) mark.seq = durable.seq;
        else if (socket.state === "open") this.#notKept(socket, done, durable.reason);
      }),
    };
  }

  /** A 101 whose open the buffer did not take: the connection is not in the
   *  stream, nor is anything of it; its tunnel is cut, and it ends answered
   *  and not kept. */
  #notKept(socket: CdpSocket, done: WsDone, reason: string): void {
    socket.state = "closed";
    this.#open.delete(done.connectionId);
    this.#uncovered ??= this.#last ?? { seq: null, wall: wallMs() };
    this.#deps.cutTunnel(done.connectionId, "cut: its open could not be kept");
    const outcome: WsDone = { ...done, error: `answered 101, not kept: the buffer took no writes (${reason})` };
    this.#end(done.connectionId, [{ outcome }, { connection: { connectionId: done.connectionId, gone: true } }], outcome);
  }

  #onFrameReceived(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (socket === null || socket.state !== "open" || socket.admission === null) return this.#drop("a frame");
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
    return {
      durable: appended.durable.then((durable) => {
        if (durable.ok) mark.seq = durable.seq;
        else this.#log("event.unkept", { kind: "ws.in", reason: durable.reason });
      }),
    };
  }

  #onFrameSent(event: CdpEvent): Taken {
    const socket = this.#socket(event);
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

  /** A socket whose handshake ended without an answer (an error, a close):
   *  its admission, if the clock proves one, ends with it. */
  #endedBeforeAnswer(socket: CdpSocket, event: CdpEvent, status: number | null, error: string): void {
    const admission = this.#carrier(socket, this.#seen(event) ?? monoMs());
    socket.state = "closed";
    if (admission === null || admission.stage !== "admitted") return;
    this.#done(admission, { sent: true, status: status ?? admission.status, error });
  }

  #onFrameError(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (socket === null || socket.state !== "handshaking") return null;
    const message = String((event.params as { errorMessage?: unknown }).errorMessage ?? "").slice(0, 160);
    const status = Number(/response code: (\d{3})/.exec(message)?.[1] ?? NaN);
    this.#endedBeforeAnswer(socket, event, Number.isInteger(status) ? status : null, message || "the handshake failed");
    return null;
  }

  #onClosed(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (socket === null) return this.#drop("a close");
    switch (socket.state) {
      case "open":
        return this.#close(socket, "closed", this.#at(event));
      case "handshaking":
        this.#endedBeforeAnswer(socket, event, null, "the socket closed before its handshake's answer");
        return null;
      case "new":
        socket.state = "closed";
        return null;
      case "lost":
      case "closed":
        return this.#drop("a close");
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /** A connection's one terminal close (its kept row goes in the same
   *  commit): closing at once in memory — nothing more of it is written —
   *  ended once durable. */
  #close(socket: CdpSocket, why: string, at: { mono: number; wall: number } | null): Taken {
    socket.state = "closed";
    const connectionId = socket.admission!.id;
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
        if (written.ok) mark.seq = written.seq;
      },
    );
    return durable === null ? null : { durable };
  }

  /** The write that ends a connection: one per connection. */
  #end(connectionId: string, items: GroupItem[], tell: WsDone | null, then?: (durable: Durable) => void): Promise<unknown> | null {
    if (this.#ended.has(connectionId)) return null;
    return this.#write(
      `end:${connectionId}`,
      () => items,
      (durable) => {
        remember(this.#ended, connectionId, true, MAX_GONE);
        then?.(durable);
      },
      tell,
    );
  }

  /** A write that matters: a group in one commit, tried again until it is
   *  durable (#later); only then is what it stands for done. One a key. */
  #write(key: string, build: Write["build"], done: Write["done"], tell: WsDone | null): Promise<unknown> | null {
    if (this.#writes.has(key)) return null;
    const write: Write = { key, build, done, tell, told: false, queued: false };
    this.#writes.set(key, write);
    return this.#attempt(write);
  }

  #attempt(write: Write): Promise<unknown> | null {
    let items: GroupItem[] | "later" | null;
    try {
      items = write.build();
    } catch (error) {
      this.#log("write.unbuilt", { key: write.key, error: errorMessage(error) });
      items = "later";
    }
    if (items === null) {
      this.#writes.delete(write.key);
      write.done({ ok: true, seq: null });
      return null;
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
    return appended.durable.then((durable) => {
      if (!durable.ok) {
        this.#later(write, durable.reason);
        return;
      }
      this.#writes.delete(write.key);
      this.#retryStep = 0;
      write.done(durable);
    });
  }

  /** Refused or failed: tried again after a growing pause (and when the
   *  buffer has room); an outcome is told to the engine from memory now. */
  #later(write: Write, reason: string): void {
    if (write.tell !== null && !write.told) {
      write.told = true;
      this.#deps.link.send(write.tell);
    }
    this.#log("write.later", { key: write.key, reason });
    if (!write.queued) {
      write.queued = true;
      this.#queue.push(write);
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
    for (const write of this.#queue.splice(0)) {
      write.queued = false;
      void this.#attempt(write);
    }
  }

  /** Stops the pauses (the operator stops). */
  close(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  // ── admissions ─────────────────────────────────────────────────────────

  /** A socket's CONNECT that waited is refused: no attempt of it exists. */
  #endAsk(admission: Admission, why: string): void {
    if (admission.stage !== "asking") return;
    admission.stage = "done";
    if (admission.waitTimer) clearTimeout(admission.waitTimer);
    admission.waitTimer = null;
    this.#forget(admission, why);
    this.#releaseGuess(admission);
    this.#log("admit.ended", { connectionId: admission.id, why });
    this.#deps.journal({ connectionId: admission.id, event: "refused", detail: why });
    admission.resolve(null);
  }

  /** The handshake's outcome: final. Unless it opened (its ws.open carries
   *  it), it ends the connection: kept with its row's end, in one commit. */
  #done(admission: Admission, outcome: { sent: boolean; status: number | null; error: string | null }): void {
    const done = this.#finish(admission, outcome);
    if (done === null) return;
    // No tunnel lives without its socket bound and open.
    if (admission.tunnel !== null && admission.tunnelEnded === null) this.#deps.cutTunnel(admission.id, `cut: ${outcome.error ?? "its admission ended"}`);
    this.#end(admission.id, [{ outcome: done }, { connection: { connectionId: admission.id, gone: true } }], done);
  }

  /** The admission is answered (in memory at once); its outcome. */
  #finish(admission: Admission, outcome: { sent: boolean; status: number | null; error: string | null }): WsDone | null {
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
    if (admission.graceTimer) clearTimeout(admission.graceTimer);
    if (admission.bindTimer) clearTimeout(admission.bindTimer);
    admission.waitTimer = null;
    admission.graceTimer = null;
    admission.bindTimer = null;
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
}

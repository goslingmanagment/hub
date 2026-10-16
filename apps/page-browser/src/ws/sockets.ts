// The site's socket, observed — never admitted, never refused (variant Б,
// plan-b-browser-host §4.1.9; Б-2d; plan §3.2 «Кадры сокета», §4.4; spec
// §2.6, §6.1; mandatory condition №3).
//
// The site opens its socket itself (wss://wsv3.fansly.com/?v=3), as any
// browser does: its CONNECT goes through the proxy at once and nothing waits
// for the engine. What the operator does around it:
//
// The handshake is a send of the site's (route `ws.upgrade`): the proxy's
// word that its request went up gives its moment; CDP's announcement of
// the handshake claims it and tells the engine `siteSent`, under the
// connection's id (the observer's outbox, intercept/observe.ts). Its own
// answer, failure or close tells `siteEnded`. A write no socket claims in
// 2 s is told under the tunnel's id, then ended with its status unknown. So
// the engine counts every write in the page's pause before
// its own requests and holds `ws.upgrade` on the site's 401/429. The
// connection CDP shows keeps its own status, even when handshakes overlap.
//
// Frames (plan §4.4), from CDP's Network.webSocket* — not from the page's
// JS — into the buffer, in the order CDP gives them; each is durable before
// anything depends on it, and nothing of them is logged. Each socket CDP
// shows to the socket host is one connection, with an id of its own:
//  - `ws.open` at the 101, under the site's live session (its fingerprint):
//    the connection kept in the buffer (schema.ts v3, attempt 0 — no
//    admission is behind it) in the same commit. A socket that opens while no
//    session is known yet is opened in the stream once one is, after a gap
//    over what it carried meanwhile;
//  - `ws.in` — every incoming text frame as it is (Fansly's socket speaks
//    text; a binary frame is counted, not kept);
//  - `ws.close` — exactly one a connection, the last of it, after its
//    ws.open: when CDP says the socket closed, its target goes, or the browser
//    goes under it (CDP may never say). A connection's closing is known at
//    once, in memory: what CDP still says of it afterwards is dropped and counted.
//  - `gap` where frames may be missing (spec §6.1 reasons), from the last
//    event of the socket saved before the break — never the moment a late
//    word of CDP is taken: with no event before, the boundary is unknown
//    (`fromSeq`/`fromWall` null): `operator_start` at every
//    start of the operator (from the last event saved before it);
//    `chrome_restart` when the browser goes under an open connection, or
//    under a socket whose end CDP had not shown (its 101 and frames may be
//    on their way) — before the closes written for it, in their commit,
//    from the last event saved before them (what CDP still had of it is
//    dropped); `ws_reconnect`
//    before a connection that opens after another one closed or one that
//    was not kept. A buffer that fills up writes its own (`buffer_full`,
//    `disk_full`).
//
// Writes that matter — a connection's ws.open, its ws.close, the start's gap
// and what it ends, the browser's gap and its closes — are groups written in
// one commit (buffer.ts appendGroup), one write a key. Refused or failed, a
// group is tried again with a growing pause (1 s … 30 s), whatever Chrome
// does or the socket's state is, and at once when the buffer has room; its
// boundaries (a gap's "from") are the ones it was made with. A close goes
// only after its open is durable. What a write ends is ended only once it is
// durable: until then nothing else ends it.
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
//  - each connection is kept in the buffer from its ws.open to its ws.close.
//    After the holder's first delivery, this operator writes, in one commit,
//    the `operator_start` gap from the last event saved before it, then the
//    end of every connection kept from before: ws.close for one that opened;
//    for one an older operator's admission kept that never opened, `wsDone`
//    with the handshake's fate unknown (`fate: "unknown"`, `sent` false:
//    nothing proves it went). The gap's boundary is kept in a file
//    (`startBoundary`) until that commit is durable: an operator that dies
//    before keeps the first boundary.
//
// Outgoing messages, three layers:
//  1. the guard in the page (inpage/ws-guard.js) lets only spec §2.6's go
//     and reports the first other one: it never left, and the page stops
//     (`unknown_ws_message`, an alarm, the exit closed);
//  2. the socket gate in the proxy (egress/socket-gate.ts) — outside the
//     page's JavaScript, for a context the guard did not go into: every
//     record after the handshake must be one of spec §2.6's messages or
//     Chrome's own control frames by its size (the authorization's from the
//     site's `session_active_session`, once). A record before the
//     authorization of no size the gate knows is held — it may be the
//     authorization under a token not observed yet — and the site's session
//     is read again; past the hold only that tunnel is cut, with an alarm
//     (the site's socket connects again). Anything else the gate does not
//     let up never goes: the tunnel is cut, the exit closed, the page stops,
//     an alarm — and Chrome is not started again for it;
//  3. CDP's word on what did leave (Network.webSocketFrameSent) goes to the
//     journal as a shape — kind, opcode, size — and a message there that
//     should not have left (one of a size the gate could not tell apart)
//     means both were passed by: the same alarm, the page killed.

import { randomUUID } from "node:crypto";

import type { Appended, ConnectionChange, Durable, EventBody, GroupItem, StoredConnection } from "../buffer/buffer.ts";
import type { CdpEvent, CdpPort } from "../cdp/client.ts";
import type { SocketTicket, SocketTunnelEvent } from "../egress/proxy.ts";
import type { SocketLine } from "../logs/journal.ts";
import type { AlarmKind } from "../rpc/protocol.ts";
import { errorMessage, makeLog, monoMs, urlForLogLine, wallMs, type Logger } from "../shared/util.ts";
import { messageKind, shapeFields, shapeOf, type GuardReport } from "./guard.ts";
import type { GuardTarget } from "./install.ts";
import { chromeToOperator, readChromeClock, tightestOf, type ChromeClockReading } from "../cdp/chrome-clock.ts";

export interface SocketTimings {
  /** The pauses between tries of a refused or failed write; the last one
   *  repeats. */
  retryMs: number[];
}

const DEFAULT_TIMINGS: SocketTimings = { retryMs: [1000, 2000, 5000, 15_000, 30_000] };

/** The attempt a connection is kept under: none — no admission is behind
 *  an observed socket (the engine reads no attempt of a `ws.open`). */
export const OBSERVED_SOCKET_ATTEMPT = 0;

// Chrome's clock on the operator's (Astra's review of PR 15, rounds 5–7): a
// socket event's moment is Chrome's own timestamp (Network.MonotonicTime),
// which a delivery delay does not move; it is mapped by an active
// calibration of each CDP session (`cdp/chrome-clock.ts`: at most its round
// trip early, never late) — never by what a delivery took. A calibration is
// the tightest of CALIBRATION_READINGS readings; it is taken again every
// CALIBRATION_EVERY_MS (the new one replaces the old, so the two clocks'
// drift — none expected: on Linux both are CLOCK_MONOTONIC — is followed,
// not accumulated) and anew for a new session (a new target, a new CDP
// connection) or a new Chrome. A session is calibrated with its first event,
// and its events wait for that first calibration — at most
// CALIBRATION_WAIT_MS, every socket event after them waiting behind them (the
// stream keeps CDP's order); the holder keeps them unacknowledged meanwhile.
// A slow reading still gives a lower bound: kept when the session has no
// clock, then tried again for a tight one. One stamped without any reading
// (failed, or past the wait) is stamped at the latest of its socket's last
// calibrated event and Chrome's start — every event of this Chrome comes
// after that start. The stamp itself proves a boundary before a loss, in
// memory and in the buffer alike.

export { CALIBRATION_MAX_MS } from "../cdp/chrome-clock.ts";
/** A session's calibration is taken again this often (the tightest kept). */
export const CALIBRATION_EVERY_MS = 10 * 60_000;
/** Readings one calibration takes (the tightest bound of them kept). */
const CALIBRATION_READINGS = 3;
/** A calibration refused or failed is tried again after these (the last
 *  repeats). */
const CALIBRATION_RETRY_MS = [250, 1_000, 5_000, 30_000];
/** How long socket events wait for their session's first calibration. */
export const CALIBRATION_WAIT_MS = 6_000;
/** How long a proxy write waits for a socket CDP shows. */
export const SOCKET_PAIR_WAIT_MS = 2_000;

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

/** The engine's word of the site's handshakes (intercept/observe.ts). */
export interface SocketObservations {
  sent(handshake: { id: string; url: URL; sentMono: number }): void;
  ended(end: { id: string; status: number | null; error: string | null }): void;
}

export type SocketStop = "unknown_ws_message" | "ws_guard_failed";

export interface SocketDeps {
  cdp: CdpPort;
  buffer: SocketBuffer;
  /** `siteSent`/`siteEnded` of each handshake, to the engine. */
  observe: SocketObservations;
  /** The live session of the site (hub-requests/session.ts): a connection
   *  opens in the stream under it. */
  sessionFingerprint: () => string | null;
  /** The bytes of the socket's authorization with the site's live token
   *  (the socket gate's rule); null: none known. */
  authorizationBytes: () => number | null;
  /** The socket gate holds a record for the authorization's size: the
   *  site's session is to be read again (its `session_active_session`). */
  refreshAuthorization?: () => void;
  /** A target's type by its session ("page", "iframe", "worker"...); null:
   *  not a target of this Chrome. */
  targetType: (sessionId: string | null) => string | null;
  /** Is this the site socket's host? A socket CDP shows to another host is
   *  none of this path's. */
  socketHost?: (host: string) => boolean;
  journal: (line: SocketLine) => void;
  alarm: (kind: AlarmKind, detail: Record<string, string | number | boolean>) => void;
  /** The page must stop: the exit is closed when this returns. */
  stop: (reason: SocketStop, note: string, how: "stop" | "kill") => void;
  /** Where the start's gap boundary waits for its commit (a file). */
  startBoundary?: BoundaryStore;
  timings?: Partial<SocketTimings>;
  log?: Logger;
}

/** A place in the stream: an event's number once durable, its wall time. */
interface Mark {
  seq: number | null;
  wall: number | null;
}

/** An event's moment, proven no later than when Chrome saw it. */
interface Stamp {
  mono: number;
  wall: number;
}

/** A tunnel's handshake write, not yet claimed by a socket CDP showed. */
interface HandshakeMoment {
  id: string;
  host: string;
  mono: number;
  timer: NodeJS.Timeout;
}

/** A gap's boundary when no moment saved before the loss is known: left
 *  unknown (spec §6.1), never "now". */
function unknownBoundary(): Mark {
  return { seq: null, wall: null };
}

/** A socket as CDP shows it to this operator: one connection. */
interface CdpSocket {
  key: string;
  sessionId: string | null;
  /** The connection's id in the stream and the socket journal. */
  id: string;
  url: string;
  context: "page" | "frame" | "worker";
  /** new → handshaking (CDP announced its request) → open (its 101) or answered
   *  (another status: its end awaited) → ended (its life in CDP is over). */
  state: "new" | "handshaking" | "open" | "answered" | "ended";
  /** CDP told its answer already: a later error must not end another send. */
  answerSeen: boolean;
  /** Its observation needs no calibration: followed at CDP's take, while
   *  the stream's events may still wait for their stamps. */
  sendState: "new" | "waiting" | "sent" | "ended";
  /** Open: its ws.open is written (or on its way); false — no live session
   *  was known at its 101: opened in the stream once one is. */
  kept: boolean;
  /** Its 101's stamp while no live session is known: opening later moves
   *  no boundary later. */
  openStamp: Stamp | null;
  /** The latest calibrated moment of its events (operator mono). */
  provenMono: number | null;
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
  queued: boolean;
  /** The buffer took its last try (its commit is on its way). */
  accepted: boolean;
  /** Settles when it is durable. */
  written: Promise<void>;
  markWritten: () => void;
}

/** Sockets remembered at most (a site that leaks them). */
const MAX_SOCKETS = 1000;
const MAX_GONE = 1000;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function contextOf(type: string | null): CdpSocket["context"] {
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
  readonly #socketHost: (host: string) => boolean;
  readonly #timings: SocketTimings;
  /** CDP's sockets of this Chrome to the socket host, oldest first: only
   *  ended ones ever make room for new ones. */
  readonly #sockets = new Map<string, CdpSocket>();
  /** Proxy writes no socket claimed yet, oldest first; each waits at most
   *  SOCKET_PAIR_WAIT_MS. */
  readonly #moments = new Map<string, HandshakeMoment>();
  /** Sockets whose handshake CDP announced before a proxy write, oldest
   *  announcement first. */
  readonly #handshakes = new Map<string, CdpSocket>();
  /** CDP's sockets of this Chrome to other hosts: known only to be none of
   *  this path's (bounded on their own). */
  readonly #others = new Map<string, true>();
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
  /** Every event of this Chrome comes after its start. */
  #chromeStarted = { mono: monoMs(), wall: wallMs() };
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
  /** Each CDP session's calibration of Chrome's clock. */
  readonly #clocks = new Map<string, ChromeClockReading>();
  /** The sessions a calibration runs for, and those Performance was
   *  enabled in. */
  readonly #calibrating = new Set<string>();
  readonly #performanceOn = new Set<string>();
  /** A session's calibrations refused in a row, and the next try's timer. */
  readonly #clockTries = new Map<string, number>();
  readonly #clockTimers = new Map<string, NodeJS.Timeout>();
  /** Changes when every calibration goes (a new Chrome, a new CDP link):
   *  one under way from before is dropped. */
  #clockEpoch = 0;
  /** Socket events waiting for a session's first calibration, and what
   *  follows them (a target's end too), in CDP's order. */
  readonly #waiting: Array<{ event: CdpEvent; handle: (event: CdpEvent) => Taken } | { run: () => void }> = [];
  /** A target may detach while its event waits behind another calibration. */
  readonly #targetTypes = new WeakMap<CdpEvent, string | null>();
  #waitTimer: NodeJS.Timeout | null = null;
  #binaryFrames = 0;
  /** Events dropped: delivered again from before this operator, or of no
   *  socket kept here (one ended, one of another Chrome, one not kept). */
  #replayed = 0;
  #dropped = 0;

  constructor(deps: SocketDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? makeLog("ws");
    this.#socketHost = deps.socketHost ?? (() => true);
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    const cdp = deps.cdp;
    const handlers: Record<(typeof SOCKET_EVENTS)[number], (event: CdpEvent) => Taken> = {
      "Network.webSocketCreated": () => null,
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
    cdp.on("Target.detachedFromTarget", (event) => this.#onDetached(event));
  }

  /** One event of the socket and its acknowledgement to the holder: once
   *  what it wrote is durable (or could not be written — the buffer's own
   *  gap covers it), at once when it wrote nothing. One delivered again
   *  from before this operator is not looked at. One of a session whose
   *  first calibration is under way waits for it, and so does every one
   *  after it. */
  #take(event: CdpEvent, handle: (event: CdpEvent) => Taken): void {
    this.#targetTypes.set(event, this.#deps.targetType(event.sessionId ?? null));
    if (!event.replayed) {
      // Pair at the take, before a calibration can hold the stream behind
      // it: a write waits only 2 s, a clock reading may take 5 s.
      if (event.method === "Network.webSocketCreated") this.#onCreated(event);
      this.#observeHandshake(event, monoMs());
    }
    if (!event.replayed && event.sessionId !== undefined) this.#ensureClock(event.sessionId);
    if (!event.replayed && (this.#waiting.length > 0 || this.#awaitsClock(event))) {
      this.#waiting.push({ event, handle });
      if (this.#waitTimer === null) {
        this.#waitTimer = setTimeout(() => this.#drain(true), CALIBRATION_WAIT_MS);
        this.#waitTimer.unref();
      }
      return;
    }
    this.#handle(event, handle);
  }

  /** Its session's first calibration is under way. */
  #awaitsClock(event: CdpEvent): boolean {
    const session = event.sessionId;
    return session !== undefined && !this.#clocks.has(session) && this.#calibrating.has(session) && !this.#clockTries.has(session);
  }

  /** The events that waited go, in order, up to one still waiting for its
   *  session's calibration; `expired`: the wait is over — all go. */
  #drain(expired = false): void {
    if (expired) {
      if (this.#waitTimer !== null) clearTimeout(this.#waitTimer);
      this.#waitTimer = null;
    }
    while (this.#waiting.length > 0) {
      const head = this.#waiting[0]!;
      if ("run" in head) {
        this.#waiting.shift();
        head.run();
        continue;
      }
      if (!expired && this.#awaitsClock(head.event)) break;
      this.#waiting.shift();
      this.#handle(head.event, head.handle);
    }
    if (this.#waiting.length === 0 && this.#waitTimer !== null) {
      clearTimeout(this.#waitTimer);
      this.#waitTimer = null;
    } else if (this.#waiting.length > 0 && this.#waitTimer === null) {
      this.#waitTimer = setTimeout(() => this.#drain(true), CALIBRATION_WAIT_MS);
      this.#waitTimer.unref();
    }
  }

  #handle(event: CdpEvent, handle: (event: CdpEvent) => Taken): void {
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

  /** The last handshake request that went up: a send of the page, for the
   *  takeover pause (`quiesced`). */
  get lastHandshake(): { mono: number; wall: number } | null {
    return this.#lastHandshake;
  }

  /** Connections open now (tests, diagnostics). */
  get openConnections(): number {
    return this.#open.size;
  }

  /** Writes not durable yet (tests, diagnostics). */
  get unwritten(): number {
    return this.#writes.size;
  }

  // ── the proxy's side ───────────────────────────────────────────────────

  /** A CONNECT to the socket host: it goes on at once (variant Б). Its
   *  records are decided by the socket gate under this ticket. */
  openTunnel(host: string, port: number): SocketTicket {
    const id = randomUUID();
    this.#log("tunnel.opened", { tunnelId: id, host, port });
    let sent = false;
    return {
      id,
      event: (event) => {
        if (event.kind === "handshake_sent") {
          if (sent) return;
          sent = true;
          this.#handshakeSent(id, host, event);
        } else this.#onTunnel(id, event);
      },
      rules: () => ({ authorizationBytes: this.#deps.authorizationBytes() }),
    };
  }

  #onTunnel(tunnelId: string, event: Exclude<SocketTunnelEvent, { kind: "handshake_sent" }>): void {
    switch (event.kind) {
      case "open":
      case "ended":
        return;
      case "holding":
        // It may be the authorization under a token not observed yet: the
        // site's session is read again (the gate decides again as it comes).
        this.#log("record.waits", { tunnelId, recordBytes: event.recordBytes, why: event.why });
        try {
          this.#deps.refreshAuthorization?.();
        } catch (error) {
          this.#log("authorization.refresh_failed", { error: errorMessage(error) });
        }
        return;
      case "refused": {
        const detail: Record<string, string | number | boolean> = { at: "proxy", recordBytes: event.recordBytes, why: event.why, left: false };
        if (event.late) {
          // Not proven forbidden: the authorization's size did not come in
          // time. That tunnel alone is cut; the site connects again.
          this.#log("record.refused_late", { tunnelId, ...detail });
          this.#deps.journal({ connectionId: null, event: "blocked", detail: `the socket gate held a record of ${event.recordBytes} bytes past its hold, the tunnel cut: ${event.why}` });
          this.#deps.alarm("unknown_ws_message", { ...detail, scope: "tunnel" });
          return;
        }
        // The socket gate did not let a record up: it never left, the
        // tunnel is cut. Something in the page sent what the guard should
        // have stopped (it did not go into that context): the page is not
        // trusted.
        this.#log("record.held", { tunnelId, ...detail });
        this.#deps.journal({ connectionId: null, event: "blocked", detail: `the socket gate held a record of ${event.recordBytes} bytes: ${event.why}` });
        this.#deps.stop("unknown_ws_message", `the socket gate held a record the page wrote (${event.why}); it was not sent`, "kill");
        this.#deps.alarm("unknown_ws_message", detail);
        return;
      }
    }
  }

  /** Chrome writes just after announcing its handshake. Announcements and
   *  writes may arrive in either order: one waiting socket takes the next
   *  write, else it waits for an announcement. Concurrent handshakes may
   *  swap moments; the set is still every write, so the page's pace holds.
   *  Their answers never swap: each socket ends its own send. */
  #handshakeSent(id: string, host: string, event: Extract<SocketTunnelEvent, { kind: "handshake_sent" }>): void {
    if (this.#lastHandshake === null || event.mono > this.#lastHandshake.mono) this.#lastHandshake = { mono: event.mono, wall: event.wall };
    const waiting = this.#handshakes.values().next().value;
    if (waiting !== undefined) {
      this.#sentObserved(waiting, event.mono);
      return;
    }
    const moment: HandshakeMoment = {
      id, host, mono: event.mono,
      timer: setTimeout(() => this.#unshown(moment), Math.max(0, Math.ceil(event.mono + SOCKET_PAIR_WAIT_MS - monoMs()))),
    };
    moment.timer.unref();
    this.#moments.set(id, moment);
  }

  /** CDP did not show the socket that wrote this: its write still counts. */
  #unshown(moment: HandshakeMoment): void {
    if (!this.#moments.delete(moment.id)) return;
    clearTimeout(moment.timer);
    this.#deps.observe.sent({ id: moment.id, url: new URL(`wss://${moment.host}/`), sentMono: moment.mono });
    this.#deps.observe.ended({ id: moment.id, status: null, error: "a socket CDP did not show" });
  }

  /** Its send, once, under its CDP connection's id, at a proxy write. */
  #sentObserved(socket: CdpSocket, mono: number): void {
    this.#handshakes.delete(socket.id);
    socket.sendState = "sent";
    this.#deps.observe.sent({ id: socket.id, url: new URL(socket.url), sentMono: mono });
  }

  /** Its own answer, failure or close ends its send, once. One still
   *  waiting failed before a write: nothing is reported. */
  #endObserved(socket: CdpSocket, status: number | null, error: string | null): void {
    this.#handshakes.delete(socket.id);
    const sent = socket.sendState === "sent";
    socket.sendState = "ended";
    if (sent) this.#deps.observe.ended({ id: socket.id, status, error });
  }

  /** Handshake observations use CDP's take only to pair a write, never as
   *  its moment. Frames keep their order while waiting for calibration. */
  #observeHandshake(event: CdpEvent, take: number): void {
    const socket = this.#socket(event);
    if (typeof socket === "string" || socket.sendState === "ended") return;
    switch (event.method) {
      case "Network.webSocketWillSendHandshakeRequest": {
        if (socket.sendState !== "new") return;
        let latest: HandshakeMoment | null = null;
        for (const moment of this.#moments.values()) {
          if (moment.mono < take - SOCKET_PAIR_WAIT_MS) this.#unshown(moment);
          else if (moment.mono <= take && (latest === null || moment.mono >= latest.mono)) latest = moment;
        }
        if (latest !== null) {
          this.#moments.delete(latest.id);
          clearTimeout(latest.timer);
          this.#sentObserved(socket, latest.mono);
        } else {
          socket.sendState = "waiting";
          this.#handshakes.set(socket.id, socket);
        }
        return;
      }
      case "Network.webSocketHandshakeResponseReceived": {
        if (socket.sendState === "waiting") {
          // Its answer passed the proxy after its write: the latest write
          // seen is no earlier than its own, even if another socket took it.
          this.#sentObserved(socket, this.#lastHandshake?.mono ?? take);
        }
        const status = Number((event.params as { response?: { status?: unknown } }).response?.status);
        this.#endObserved(socket, Number.isInteger(status) ? status : null, null);
        return;
      }
      case "Network.webSocketFrameError": {
        const message = String((event.params as { errorMessage?: unknown }).errorMessage ?? "").slice(0, 160);
        const code = Number(/response code: (\d{3})/.exec(message)?.[1] ?? NaN);
        this.#endObserved(socket, Number.isInteger(code) ? code : null, message || "the handshake failed");
        return;
      }
      case "Network.webSocketClosed":
        this.#endObserved(socket, null, "the socket closed before its handshake's answer");
    }
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
    );
  }

  /** The buffer opened, or has room again: what waits is written now. */
  bufferOpened(): void {
    this.retryNow();
  }

  /** A new Chrome starts: whatever is left of the one before goes with it. */
  async chromeStarting(): Promise<void> {
    this.#chromeGone("the previous Chrome is gone");
    this.#chromeStarted = { mono: monoMs(), wall: wallMs() };
  }

  /** The page stops or its browser goes (the exit is closed already): every
   *  open connection gets its one terminal close — CDP may never say so, and
   *  whatever it still says of them is dropped. */
  endAll(reason: string): void {
    this.#chromeGone(`the page stopped: ${reason}`);
  }

  /** The site's live session became known: a socket that opened before it
   *  opens in the stream at its 101's stamp, after a gap over what it
   *  carried meanwhile. */
  sessionKnown(): void {
    if (this.#deps.sessionFingerprint() === null) return;
    for (const socket of this.#sockets.values()) {
      if (socket.state === "open" && !socket.kept && socket.openStamp !== null) this.#keep(socket, socket.openStamp);
    }
  }

  /** Its target went: after every socket event already taken, end each
   *  socket of that session and forget it. The holder acknowledges the
   *  detach itself; the queued end acknowledges nothing. */
  #onDetached(event: CdpEvent): void {
    if (event.replayed) return;
    const sessionId = event.params.sessionId;
    if (typeof sessionId !== "string") return;
    const end = () => {
      for (const [key, socket] of this.#sockets) {
        if (socket.sessionId !== sessionId) continue;
        this.#endObserved(socket, null, "its target went");
        if (socket.state === "open" && socket.kept) this.#close(socket, "its target went", { mono: monoMs(), wall: wallMs() });
        else socket.state = "ended";
        this.#sockets.delete(key);
      }
    };
    if (this.#waiting.length > 0) this.#waiting.push({ run: end });
    else end();
  }

  /** Chrome goes (or nothing of it is listened to any more): each open
   *  connection gets its one close — after the browser's gap from the last
   *  event saved before, in one commit — and its sockets are forgotten:
   *  whatever CDP still says of them is dropped. */
  #chromeGone(why: string): void {
    // A new Chrome's sessions are new: their clocks are taken anew.
    this.clocksInvalidated(why);
    for (const moment of this.#moments.values()) this.#unshown(moment);
    for (const socket of this.#sockets.values()) this.#endObserved(socket, null, why);
    this.#handshakes.clear();
    // A socket that may have spoken and whose frames are not in the stream:
    // what it carried is lost with Chrome (its 101 and frames may still be
    // on their way).
    let lost = false;
    for (const socket of this.#sockets.values()) {
      if (socket.state === "handshaking" || (socket.state === "open" && !socket.kept)) lost = true;
    }
    const open = [...this.#open.values()];
    if (open.length > 0 || lost) this.#closeAll(open, why, lost);
    for (const socket of this.#sockets.values()) socket.state = "ended";
    this.#sockets.clear();
    this.#others.clear();
  }

  /** The end of every connection the buffer keeps from before this
   *  operator (none of its own: those it ends itself, each by its own
   *  write): ws.close for one that opened; for one an older operator's
   *  admission kept that never opened, `wsDone` with the handshake's fate
   *  unknown. Ended once the start's commit is durable. */
  #sweep(): { items: GroupItem[]; ids: string[] } {
    const items: GroupItem[] = [];
    const ids: string[] = [];
    const why = "the operator started again: the previous Chrome is gone";
    for (const kept of this.#deps.buffer.connections()) {
      const id = kept.connectionId;
      if (this.#ended.has(id) || this.#open.has(id) || this.#ending.has(id) || this.#writes.has(`open:${id}`)) continue;
      ids.push(id);
      if (kept.opened) {
        items.push({ event: { kind: "ws.close", connectionId: id, code: null, reason: null }, connection: { connectionId: id, gone: true } });
      } else if (kept.attemptId === OBSERVED_SOCKET_ATTEMPT) {
        // Never written so (an observed connection is kept opened): no
        // attempt is owed an end.
        items.push({ connection: { connectionId: id, gone: true } });
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

  // ── CDP ────────────────────────────────────────────────────────────────
  //
  // Only live events of this operator's Chrome come here (#take); each
  // handler returns the durability of what it wrote, or null.

  #key(event: CdpEvent): string | null {
    const requestId = (event.params as { requestId?: unknown }).requestId;
    return typeof requestId === "string" ? `${event.sessionId ?? ""}|${requestId}` : null;
  }

  /** The target when the event was taken, even if it detached while waiting. */
  #targetType(event: CdpEvent): string | null {
    return this.#targetTypes.get(event) ?? null;
  }

  /** An event's stamp, on this process's clock: its timestamp mapped by its
   *  session's calibration (at most the calibration's spread early, never
   *  late) — or, with no clock, the latest of its socket's last calibrated
   *  event and Chrome's start: both are proven before this event. */
  #at(event: CdpEvent, socket: CdpSocket | null): Stamp {
    const take = monoMs();
    const wall = wallMs();
    const stamp = (mono: number): Stamp => ({ mono, wall: Math.round(wall - (take - mono)) });
    const seen = Number((event.params as { timestamp?: unknown }).timestamp) * 1000;
    const clock = event.sessionId === undefined ? undefined : this.#clocks.get(event.sessionId);
    if (clock !== undefined && Number.isFinite(seen) && seen > 0) {
      const mono = chromeToOperator(seen / 1000, clock, take);
      if (socket !== null && (socket.provenMono === null || mono > socket.provenMono)) socket.provenMono = mono;
      return stamp(mono);
    }
    const mono = Math.max(socket?.provenMono ?? this.#chromeStarted.mono, this.#chromeStarted.mono);
    return { mono, wall: Math.round(this.#chromeStarted.wall + (mono - this.#chromeStarted.mono)) };
  }

  // ── Chrome's clock (rounds 5–7 of Astra's review of PR 15) ─────────────

  /** The calibration of `sessionId`, if one was taken (tests, the log). */
  clockOf(sessionId: string): { spread: number } | null {
    const clock = this.#clocks.get(sessionId);
    return clock === undefined ? null : { spread: clock.spread };
  }

  /** Every calibration goes: a new CDP link (its sessions may be new), a new
   *  Chrome. They are taken again with the next events. */
  clocksInvalidated(why: string): void {
    this.#clockEpoch += 1;
    this.#clocks.clear();
    this.#calibrating.clear();
    this.#performanceOn.clear();
    for (const timer of this.#clockTimers.values()) clearTimeout(timer);
    this.#clockTimers.clear();
    this.#clockTries.clear();
    this.#log("clock.invalidated", { why });
    // No calibration is under way any more: what waited goes now.
    this.#drain();
  }

  /** A calibration of `sessionId` is taken when it has none, or an old one. */
  #ensureClock(sessionId: string): void {
    if (this.#calibrating.has(sessionId) || this.#clockTimers.has(sessionId)) return;
    const clock = this.#clocks.get(sessionId);
    if (clock !== undefined && monoMs() - clock.takenMono < CALIBRATION_EVERY_MS) return;
    void this.#calibrate(sessionId);
  }

  async #calibrate(sessionId: string): Promise<void> {
    const epoch = this.#clockEpoch;
    const cdp = this.#deps.cdp;
    this.#calibrating.add(sessionId);
    let why: string | null = null;
    try {
      const readings: ChromeClockReading[] = [];
      for (let index = 0; index < CALIBRATION_READINGS; index += 1) {
        const reading = await readChromeClock(cdp, sessionId, { enable: !this.#performanceOn.has(sessionId) });
        if (epoch !== this.#clockEpoch) return;
        this.#performanceOn.add(sessionId);
        // A slow round trip: the link is loaded — the rest wait for a retry.
        if ("refused" in reading) {
          why = reading.refused;
          if (reading.reading !== undefined && !this.#clocks.has(sessionId)) this.#clocks.set(sessionId, reading.reading);
          break;
        }
        readings.push(reading);
      }
      const clock = tightestOf(readings);
      if (clock !== null) {
        // The new one replaces the old (one refused keeps the old).
        why = null;
        this.#clocks.set(sessionId, clock);
        this.#clockTries.delete(sessionId);
        this.#log("clock.calibrated", { sessionId, readings: readings.length, spreadMs: Math.round(clock.spread * 1000) / 1000 });
      }
    } catch (error) {
      if (epoch !== this.#clockEpoch) return;
      why = errorMessage(error);
    } finally {
      if (epoch === this.#clockEpoch) this.#calibrating.delete(sessionId);
    }
    if (why !== null && epoch === this.#clockEpoch) this.#clockTries.set(sessionId, (this.#clockTries.get(sessionId) ?? 0) + 1);
    // Calibrated, or refused (its events are stamped by what is proven):
    // what waited for it goes.
    if (epoch === this.#clockEpoch) this.#drain();
    if (why === null || epoch !== this.#clockEpoch) return;
    // Tried again: its events meanwhile are stamped by what is proven.
    const tries = this.#clockTries.get(sessionId)!;
    const wait = CALIBRATION_RETRY_MS[Math.min(tries - 1, CALIBRATION_RETRY_MS.length - 1)]!;
    this.#log("clock.refused", { sessionId, why, tries, retryMs: wait });
    const timer = setTimeout(() => {
      this.#clockTimers.delete(sessionId);
      if (epoch === this.#clockEpoch) void this.#calibrate(sessionId);
    }, wait);
    timer.unref();
    this.#clockTimers.set(sessionId, timer);
  }

  /** The socket an event is of — one of this Chrome to the socket host — or
   *  why the event is none of this path's: "other" (another host, another
   *  Chrome), "unknown" (CDP did not show it being created). */
  #socket(event: CdpEvent): CdpSocket | "other" | "unknown" {
    if (this.#targetType(event) === null) return "other";
    const key = this.#key(event);
    if (key === null || this.#others.has(key)) return "other";
    return this.#sockets.get(key) ?? "unknown";
  }

  /** Something of a socket no connection is kept for (one ended, one never
   *  seen created, one of another Chrome): dropped, counted. */
  #drop(what: string): null {
    this.#dropped += 1;
    if (this.#dropped === 1 || this.#dropped % 100 === 0) this.#log("event.dropped", { what, count: this.#dropped });
    return null;
  }

  #socketLog(event: CdpEvent, socket: CdpSocket, happened: string): void {
    this.#log("socket.cdp", { requestId: String((event.params as { requestId?: string }).requestId ?? ""), sessionId: event.sessionId ?? null, connectionId: socket.id, event: happened });
  }

  #onCreated(event: CdpEvent): Taken {
    const type = this.#targetType(event);
    if (type === null) return this.#drop("a socket of no target of this Chrome");
    const key = this.#key(event);
    if (key === null || this.#sockets.has(key) || this.#others.has(key)) return null;
    const url = String((event.params as { url?: unknown }).url ?? "");
    if (!this.#socketHost(hostOf(url))) {
      remember(this.#others, key, true, MAX_SOCKETS);
      return this.#drop("a socket to another host");
    }
    if (this.#sockets.size >= MAX_SOCKETS && !this.#forgetOneEnded()) {
      // Every one kept is alive: this one is not followed (its frames, if
      // it opens, are under the next connection's gap).
      this.#uncovered ??= this.#last ?? unknownBoundary();
      this.#log("socket.not_followed", { why: `more than ${MAX_SOCKETS} sockets of the host alive at once` });
      return this.#drop("a socket past the bound of those followed");
    }
    const socket: CdpSocket = { key, sessionId: event.sessionId ?? null, id: randomUUID(), url, context: contextOf(type), state: "new", answerSeen: false, sendState: "new", kept: false, openStamp: null, provenMono: null };
    this.#sockets.set(key, socket);
    this.#socketLog(event, socket, "created");
    return null;
  }

  /** Makes room: the oldest socket whose life is over is forgotten (what
   *  CDP says of it later is dropped as of no socket kept). False: none. */
  #forgetOneEnded(): boolean {
    for (const [key, socket] of this.#sockets) {
      if (socket.state !== "ended") continue;
      this.#sockets.delete(key);
      return true;
    }
    return false;
  }

  /** Chrome is about to write the handshake; only the proxy proves its send. */
  #onWillSendHandshake(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (socket === "other") return null;
    if (socket === "unknown") return this.#drop("a handshake of a socket CDP did not show being created");
    this.#socketLog(event, socket, "handshake");
    if (socket.state !== "new") return this.#drop("a second handshake of one socket");
    socket.state = "handshaking";
    return null;
  }

  #onHandshakeResponse(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (typeof socket === "string") return this.#drop("a handshake's answer of a socket not followed");
    if (socket.answerSeen) return this.#drop("a second answer of one socket");
    const response = (event.params as { response?: { status?: unknown } }).response;
    const status = Number(response?.status);
    const known = Number.isInteger(status) ? status : null;
    socket.answerSeen = true;
    // A close ended its CDP life: a late answer cannot open it again.
    if (socket.state === "ended") return null;
    if (known !== 101) {
      // Its handshake failed: its end is Chrome's word on it (the error, the
      // close) that follows.
      socket.state = "answered";
      this.#deps.journal({ connectionId: socket.id, event: "failed", status: known, detail: `the handshake was answered ${String(known)}` });
      return null;
    }
    socket.state = "open";
    this.#deps.journal({ connectionId: socket.id, event: "open", status: 101, context: socket.context });
    return this.#keep(socket, this.#at(event, socket));
  }

  /** An open connection into the stream: its ws.open under the live
   *  session, kept in the buffer, after the reconnect's gap — one commit,
   *  tried until durable whatever becomes of the socket meanwhile. With no
   *  live session known it waits (`sessionKnown`): what it carries until
   *  then is under that gap. */
  #keep(socket: CdpSocket, at: Stamp): Taken {
    const fingerprint = this.#deps.sessionFingerprint();
    if (fingerprint === null) {
      socket.openStamp = at;
      this.#uncovered ??= this.#last ?? unknownBoundary();
      this.#log("socket.unkept", { connectionId: socket.id, why: "no live session of the site known yet" });
      this.#deps.journal({ connectionId: socket.id, event: "unkept", detail: "no live session of the site known yet: opened in the stream once one is" });
      return null;
    }
    socket.kept = true;
    socket.openStamp = null;
    const id = socket.id;
    const opened: GroupItem[] = [
      { connection: { connectionId: id, admitted: { attemptId: OBSERVED_SOCKET_ATTEMPT } } },
      { event: { kind: "ws.open", connectionId: id, attemptId: OBSERVED_SOCKET_ATTEMPT, sessionFingerprint: fingerprint }, at, connection: { connectionId: id, opened: true } },
    ];
    // The gap's "from" is the mark it was made with — its number as known
    // at each try (the close before it may become durable meanwhile).
    const uncovered = this.#uncovered;
    const items = (): GroupItem[] => (uncovered === null ? opened : [{ gap: "ws_reconnect", from: { seq: uncovered.seq, wall: uncovered.wall } }, ...opened]);
    this.#open.set(id, socket);
    this.#uncovered = null;
    const mark: Mark = { seq: null, wall: at.wall };
    this.#last = mark;
    const durable = this.#write(`open:${id}`, items, (written) => this.#saved_(written, mark));
    if (durable !== null) this.#settled = Promise.all([this.#settled, durable]);
    return durable === null ? null : { durable };
  }

  #onFrameReceived(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (socket === "other") return null;
    if (socket === "unknown") return this.#drop("a frame of a socket CDP did not show being created");
    if (socket.state !== "open" || !socket.kept) return this.#drop("a frame of a socket not kept");
    const response = (event.params as { response?: { opcode?: unknown; payloadData?: unknown } }).response;
    if (response?.opcode !== 1 || typeof response.payloadData !== "string") {
      // Not text: Fansly's socket sends none; counted, its content not kept.
      this.#binaryFrames += 1;
      if (this.#binaryFrames === 1 || this.#binaryFrames % 100 === 0) this.#log("frame.not_text", { connectionId: socket.id, opcode: Number(response?.opcode), count: this.#binaryFrames });
      return null;
    }
    const at = this.#at(event, socket);
    const appended = this.#deps.buffer.append({ kind: "ws.in", connectionId: socket.id, frame: response.payloadData }, at);
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
    const connectionId = socket?.state === "open" && socket.kept ? socket.id : null;
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
    this.#socketLog(event, socket, "frame_error");
    if (socket.state === "open") return null;
    // Its handshake failed: the socket's life is over.
    const message = String((event.params as { errorMessage?: unknown }).errorMessage ?? "").slice(0, 160);
    const code = Number(/response code: (\d{3})/.exec(message)?.[1] ?? NaN);
    if (!socket.answerSeen && Number.isInteger(code)) {
      socket.answerSeen = true;
    }
    if (socket.state !== "handshaking") {
      socket.state = "ended";
      return null;
    }
    socket.state = "ended";
    this.#deps.journal({ connectionId: socket.id, event: "failed", status: Number.isInteger(code) ? code : null, detail: message || "the handshake failed" });
    return null;
  }

  #onClosed(event: CdpEvent): Taken {
    const socket = this.#socket(event);
    if (typeof socket === "string") return this.#drop("a close of a socket not followed");
    this.#socketLog(event, socket, "closed");
    switch (socket.state) {
      case "open":
        if (socket.kept) return this.#close(socket, "closed", this.#at(event, socket));
        socket.state = "ended";
        this.#deps.journal({ connectionId: socket.id, event: "closed", detail: "closed, never kept" });
        return null;
      case "handshaking":
        socket.state = "ended";
        this.#deps.journal({ connectionId: socket.id, event: "failed", status: null, detail: "the socket closed before its handshake's answer" });
        return null;
      case "answered":
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
  #close(socket: CdpSocket, why: string, at: Stamp): Taken {
    socket.state = "ended";
    const connectionId = socket.id;
    this.#open.delete(connectionId);
    const stamp = at;
    // What may be missing until the next connection opens: from the last
    // event of the socket before this close — a moment saved before the
    // loss, not the close's (CDP may tell it late; a close of ours is now).
    this.#uncovered ??= this.#last ?? unknownBoundary();
    // The connection's last event: its number once the close is durable —
    // and, as a boundary, the moment of the last event received before it
    // (the open or a frame): a close moves no boundary later (Astra's
    // review of PR 15, round 6).
    const previousWall = this.#last?.wall ?? this.#chromeStarted.wall;
    const mark: Mark = { seq: null, wall: Math.min(stamp.wall, previousWall) };
    this.#last = mark;
    this.#log("socket.closed", { connectionId, why });
    this.#deps.journal({ connectionId, event: "closed", detail: why });
    const durable = this.#end(
      connectionId,
      [{ event: { kind: "ws.close", connectionId, code: null, reason: null }, at: stamp, connection: { connectionId, gone: true } }],
      (written) => this.#saved_(written, mark),
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

  /** The browser goes under open connections, or under a socket that may
   *  have spoken: the browser's gap — from the last event of the socket
   *  saved before, once every write before it has settled — then the closes
   *  of the open ones, in one commit, after their opens. */
  #closeAll(sockets: CdpSocket[], why: string, lost: boolean): void {
    const stamp = { mono: monoMs(), wall: wallMs() };
    const mark: Mark = { seq: null, wall: this.#last?.wall ?? null };
    const ids: string[] = [];
    const before: Array<Promise<unknown>> = [this.#settled];
    for (const socket of sockets) {
      const connectionId = socket.id;
      socket.state = "ended";
      this.#open.delete(connectionId);
      if (this.#ended.has(connectionId) || this.#ending.has(connectionId)) continue;
      ids.push(connectionId);
      const opening = this.#writes.get(`open:${connectionId}`);
      if (opening) before.push(opening.written);
      this.#log("socket.closed", { connectionId, why });
      this.#deps.journal({ connectionId, event: "closed", detail: why });
    }
    if (ids.length === 0 && !lost) return;
    // The browser's gap from the last event saved before — taken when the
    // first try goes: every write before the closes has settled by then,
    // and nothing of these connections comes after. What may be missing
    // until the next connection opens is from the same moment (unknown
    // until then — never the time of these closes).
    const from = unknownBoundary();
    let taken = false;
    this.#uncovered ??= from;
    this.#last = mark;
    const key = `chrome:${++this.#chromeGaps}`;
    for (const id of ids) this.#ending.set(id, key);
    this.#write(
      key,
      () => {
        if (!taken) {
          taken = true;
          from.seq = this.#saved.seq;
          from.wall = this.#saved.wall;
        }
        return [{ gap: "chrome_restart", from: { seq: from.seq, wall: from.wall } }, ...ids.map((connectionId): GroupItem => ({ event: { kind: "ws.close", connectionId, code: null, reason: null }, at: stamp, connection: { connectionId, gone: true } }))];
      },
      (written) => {
        for (const id of ids) {
          this.#ending.delete(id);
          remember(this.#ended, id, true, MAX_GONE);
        }
        this.#saved_(written, mark);
      },
      Promise.all(before),
    );
  }

  /** The write that ends a connection: one per connection. */
  #end(connectionId: string, items: GroupItem[], then?: (durable: Durable) => void, after?: Promise<unknown>): Promise<unknown> | null {
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
      after,
    );
  }

  /** A write that matters: a group in one commit, tried again until it is
   *  durable (#later); only then is what it stands for done. One a key.
   *  `after`: its first try waits for it. */
  #write(key: string, build: Write["build"], done: Write["done"], after?: Promise<unknown>): Promise<unknown> | null {
    if (this.#writes.has(key)) return null;
    let markWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => (markWritten = resolve));
    const write: Write = { key, build, done, queued: false, accepted: false, written, markWritten };
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
   *  buffer has room). */
  #later(write: Write, reason: string): void {
    write.accepted = false;
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
    for (const moment of this.#moments.values()) clearTimeout(moment.timer);
    this.#moments.clear();
    this.#handshakes.clear();
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (this.#waitTimer !== null) clearTimeout(this.#waitTimer);
    this.#waitTimer = null;
    for (const timer of this.#clockTimers.values()) clearTimeout(timer);
    this.#clockTimers.clear();
    this.#clockEpoch += 1;
  }
}

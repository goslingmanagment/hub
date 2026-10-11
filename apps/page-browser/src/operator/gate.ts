// PROTOTYPE CANDIDATE — the API send gate (plan §4.1 "рубеж отправки", §4.2
// step 4, owner decisions №10 and №16).
//
// The proxy cannot see requests inside TLS. But on the API host only one
// admitted request is in flight, and every other request waits in Chrome's
// Fetch interception. So the gate decides on every TLS record Chrome writes
// into an API tunnel (5-byte header: type, version, length). The decision is
// made at the header and holds for the whole record; a tunnel that holds a
// record holds everything after it (a TLS stream is never reordered and
// nothing is dropped from it).
//
//   A control record — the size of an HTTP/2 control frame: PING and its
//   ACK, WINDOW_UPDATE, RST_STREAM, SETTINGS ACK, GOAWAY without debug data
//   (≤ 17 bytes of frame; a TLS 1.3 record of ≤ 39 bytes) — goes up in every
//   phase. No request fits in one: Chrome's smallest request HEADERS, every
//   field HPACK-indexed, is 16+ fields, 25+ bytes of frame. Chrome writes a
//   PING before a request on a connection it read nothing from for 10 s
//   (SpdySession::MaybeSendPrefacePing); that PING does not use the window.
//
//   Any other ("big") record goes up only as the request of an open window,
//   and a window has a budget of big records: Chrome writes one frame per
//   socket write (SpdySession::DoWrite), and BoringSSL makes each write a
//   record of its own. A request is its HEADERS record plus, with a body,
//   one DATA record per 16 375 bytes (kMaxSpdyFrameChunkSize). A connection
//   opened in the window (one at most) adds its own records: the TLS 1.3
//   Finished and the HTTP/2 preface with SETTINGS (TLS 1.2: the preface;
//   records that are not application data — ClientHello, ChangeCipherSpec —
//   are not counted). Chrome 155 sends no TLS early data
//   (kEnableTLS13EarlyData is off by default).
//
//   closed      no request is out: big records are held.
//   open        a request was released. Its first big record on a warm
//               connection (or the connection opened for it) makes that
//               tunnel the window's; the budget goes up it and the window
//               holds from the end of its last record. A request Chrome
//               released without us at that moment is a record of its own
//               and stays. A body of unknown length has no budget: the window
//               then holds once Chrome has announced the send
//               (requestWillBeSentExtraInfo) and the line went quiet for
//               QUIET_MS — the one case that rests on CDP. At the deadline,
//               with nothing sent, every API tunnel is cut: the request never
//               leaves.
//   holding     the request is out: big records are held. This is what stops
//               Chrome's own repeats — after REFUSED_STREAM it repeats on the
//               same connection and CDP does not report it (stand finding). A
//               repeat on a new connection (after GOAWAY, a reset, a 408) meets
//               the refusal of new tunnels. No response headers in 20 s → the
//               API tunnels are cut.
//   responding  the response headers arrived. Big records stay held: one now
//               would be a request Chrome released without us (a CDP loss
//               while the body is still coming — stand finding).
//
// A big record still held when the next window opens was never admitted: its
// tunnel is cut, never flushed. What is left open: a request Chrome releases
// without us in the very moment a window opens can take its place (the
// admitted request is then held and fails); and a body of unknown length.

import { monoMs } from "../shared/util.ts";

/** After Chrome's announcement, a window without a budget stops once it
 *  carried bytes and stayed quiet this long. Shorter than a round trip to
 *  the API (a repeat cannot come sooner). */
const QUIET_MS = Number(process.env.PB_GATE_QUIET_MS ?? "5");
/** Plan §4.14: a request's limit (REQUEST_TIMEOUT_MS of the engine). */
const NO_RESPONSE_MS = 20_000;
/** Chrome's largest DATA frame payload (kMaxSpdyFrameChunkSize). */
const DATA_FRAME_MAX = 16 * 1024 - 9;

export type GatePhase = "closed" | "open" | "holding" | "responding";
export type RecordVerdict = "up" | "hold";

export interface GateEvent {
  kind: string;
  window: string | null;
  detail: Record<string, unknown>;
}

interface Window {
  id: string;
  deadline: number;
  /** Big records of the request itself (HEADERS and DATA); Infinity = a body
   *  of unknown length. */
  requestRecords: number;
  /** The tunnel opened in this window. */
  newTunnel: number | null;
  /** The tunnel the request goes up. */
  tunnel: number | null;
  /** The new connection negotiated TLS 1.3 (null: not known, counted as 1.3). */
  tls13: boolean | null;
  /** Big records that went up the window's tunnel. */
  used: number;
  announced: boolean;
  openedAt: number;
  firstChunkAt: number | null;
  lastChunkAt: number;
  bytes: number;
}

export class ApiGate {
  enabled = process.env.PB_GATE !== "0";
  /** Stand: off = no budget, every window closes on the announcement and
   *  quiet (the earlier candidate). */
  burstClose = process.env.PB_GATE_BURST !== "0";
  onEvent: (event: GateEvent) => void = () => undefined;
  /** Cut every API tunnel; returns how many. */
  cut: (reason: string) => number = () => 0;
  /** Cut the API tunnels that hold bytes; returns how many. */
  cutHeld: (reason: string) => number = () => 0;

  #phase: GatePhase = "closed";
  #window: Window | null = null;
  #deadlineTimer: NodeJS.Timeout | null = null;
  #holdTimer: NodeJS.Timeout | null = null;
  #noResponseTimer: NodeJS.Timeout | null = null;

  get state(): { phase: GatePhase; window: string | null; deadline: number } {
    return { phase: this.#phase, window: this.#window?.id ?? null, deadline: this.#window?.deadline ?? 0 };
  }

  /** A record starts on API tunnel `tunnel` (nothing held before it there).
   *  `big`: larger than a control frame; `appData`: TLS application data
   *  (type 23); `tls13`: what the tunnel's server chose. */
  record(tunnel: number, big: boolean, appData: boolean, tls13: boolean | null): RecordVerdict {
    if (!this.enabled) return "up";
    const w = this.#window;
    if (this.#phase !== "open" || w === null || monoMs() >= w.deadline) return big ? "hold" : "up";
    if (w.tunnel === tunnel) {
      // The handshake of the window's own connection.
      if (!appData) return "up";
      if (w.newTunnel === tunnel) w.tls13 = tls13;
      // A body's DATA frame can be as small as a control frame (a 2-byte
      // body: a 33-byte record): once the request's HEADERS is out, every
      // record of a request with a body counts (stand: retry-post). Before
      // it, and after a bodiless one, small records are control frames.
      const counting = big || (w.used > this.#setupRecords(w) && w.requestRecords > 1);
      if (!counting) return "up";
      if (w.used >= this.#budget(w)) return big ? "hold" : "up";
      w.used += 1;
      return "up";
    }
    if (!big) return "up";
    if (w.tunnel !== null || !appData) return "hold";
    // The request's first record: the tunnel is the window's.
    w.tunnel = tunnel;
    w.used = 1;
    return "up";
  }

  /** A record that went up `tunnel` ended. */
  recordDone(tunnel: number): void {
    const w = this.#window;
    if (this.#phase !== "open" || w === null || w.tunnel !== tunnel || w.used < this.#budget(w)) return;
    this.#hold("budget");
  }

  /** May Chrome open a new tunnel to the API now? Only for the request just
   *  released, before it went up anywhere, once per window. */
  admitsTunnel(): boolean {
    if (!this.enabled) return true;
    const w = this.#window;
    return this.#phase === "open" && w !== null && !w.announced && w.newTunnel === null && w.tunnel === null && monoMs() < w.deadline;
  }

  /** A tunnel was accepted inside the window: the request goes up it. */
  noteTunnel(tunnel: number): void {
    const w = this.#window;
    if (!w || this.#phase !== "open") return;
    w.newTunnel = tunnel;
    w.tunnel = tunnel;
    if (w.announced && w.requestRecords === Infinity) this.#watchQuiet();
  }

  /** Bytes went up `tunnel`. */
  noteChunk(tunnel: number, bytes: number): void {
    const w = this.#window;
    if (!w || w.tunnel !== tunnel || this.#phase !== "open") return;
    const now = monoMs();
    w.bytes += bytes;
    w.lastChunkAt = now;
    if (w.firstChunkAt === null) {
      w.firstChunkAt = now;
      this.onEvent({ kind: "first_bytes", window: w.id, detail: { afterOpenMs: round(now - w.openedAt), bytes, newTunnel: w.newTunnel !== null } });
    }
    if (w.announced && w.requestRecords === Infinity) this.#watchQuiet();
  }

  /** A physical request is about to be released (Fetch.continueRequest
   *  follows). `bodyBytes`: its body (0 = none, null = unknown length). */
  open(id: string, deadlineMono: number, bodyBytes: number | null): void {
    this.#clearTimers();
    // Whatever a tunnel still holds was never admitted.
    const cut = this.enabled ? this.cutHeld("gate: bytes held from before this window") : 0;
    if (cut > 0) this.onEvent({ kind: "unadmitted_cut", window: id, detail: { cut, phase: this.#phase } });
    const now = monoMs();
    this.#window = {
      id,
      deadline: deadlineMono,
      requestRecords: !this.burstClose || bodyBytes === null ? Infinity : 1 + Math.ceil(bodyBytes / DATA_FRAME_MAX),
      newTunnel: null,
      tunnel: null,
      tls13: null,
      used: 0,
      announced: false,
      openedAt: now,
      firstChunkAt: null,
      lastChunkAt: 0,
      bytes: 0,
    };
    this.#phase = "open";
    this.#deadlineTimer = setTimeout(() => this.#onDeadline(id), Math.max(0, deadlineMono - now));
  }

  /** Chrome announced the request's headers (requestWillBeSentExtraInfo).
   *  The announcement is made before the bytes are written and may reach us
   *  before them. */
  announced(id: string): void {
    const w = this.#window;
    if (!w || w.id !== id || w.announced) return;
    w.announced = true;
    if (!this.enabled) return;
    this.#noResponseTimer = setTimeout(() => {
      this.#noResponseTimer = null;
      if (this.#window?.id !== id || this.#phase === "responding" || this.#phase === "closed") return;
      const cut = this.cut("gate: no response 20 s after the send");
      this.onEvent({ kind: "no_response", window: id, detail: { cut, bytes: w.bytes } });
    }, NO_RESPONSE_MS);
    if (this.#phase === "open" && w.requestRecords === Infinity) this.#watchQuiet();
  }

  /** The response headers arrived. */
  responding(id: string): void {
    if (this.#window?.id !== id || this.#phase === "closed" || this.#phase === "responding") return;
    this.#clearTimers();
    this.#phase = "responding";
  }

  /** The request finished (or its operation was closed). */
  close(id: string): void {
    if (this.#window?.id !== id) return;
    this.#clearTimers();
    this.#phase = "closed";
    this.#window = null;
  }

  /** The exit closed or control was lost: nothing forwards any more. */
  reset(): void {
    this.#clearTimers();
    this.#phase = "closed";
    this.#window = null;
  }

  /** A big record was held (for the journal: what was stopped and when). */
  noteHeld(tunnel: number, length: number): void {
    this.onEvent({ kind: "held", window: this.#window?.id ?? null, detail: { tunnel, length, phase: this.#phase } });
  }

  /** Big records the window's tunnel may carry. */
  #budget(w: Window): number {
    return this.#setupRecords(w) + w.requestRecords;
  }

  /** Big records of the window's own new connection before the request. */
  #setupRecords(w: Window): number {
    if (w.newTunnel === null) return 0;
    return w.tls13 === false ? 1 : 2;
  }

  #hold(why: string): void {
    this.#clearHoldTimer();
    const w = this.#window;
    if (!w || this.#phase !== "open") return;
    this.#phase = "holding";
    if (process.env.PB_DEBUG_NET === "1") this.onEvent({ kind: "hold", window: w.id, detail: { why, bytes: w.bytes, announced: w.announced } });
  }

  /** Hold once the window carried bytes and the line stayed quiet. */
  #watchQuiet(): void {
    this.#clearHoldTimer();
    const w = this.#window;
    if (!w || this.#phase !== "open" || w.bytes === 0) return;
    const wait = Math.max(0, QUIET_MS - (monoMs() - w.lastChunkAt));
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      const current = this.#window;
      if (current !== w || this.#phase !== "open") return;
      if (monoMs() - w.lastChunkAt + 0.5 >= QUIET_MS) this.#hold("quiet");
      else this.#watchQuiet();
    }, wait);
  }

  #onDeadline(id: string): void {
    this.#deadlineTimer = null;
    const w = this.#window;
    if (!this.enabled || !w || w.id !== id || this.#phase !== "open") return;
    // Out already? A record of the request itself went up.
    const sent = w.used > this.#setupRecords(w);
    if (sent) {
      this.#hold("deadline");
      return;
    }
    // Nothing of the request may leave from now on. Every API tunnel goes:
    // one may still be finishing the handshake the request would follow.
    const cut = this.cut("gate: admission expired before send");
    this.#clearTimers();
    this.#phase = "closed";
    this.#window = null;
    this.onEvent({ kind: "expired", window: id, detail: { cut, bytes: w.bytes, announced: w.announced, newTunnel: w.newTunnel !== null } });
  }

  #clearHoldTimer(): void {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
  }

  #clearTimers(): void {
    this.#clearHoldTimer();
    if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
    if (this.#noResponseTimer) clearTimeout(this.#noResponseTimer);
    this.#deadlineTimer = null;
    this.#noResponseTimer = null;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** The largest record that carries only a control frame (≤ 17 bytes): TLS
 *  1.3 adds 22 bytes (header, content type, AEAD tag); TLS 1.2 with AES-GCM
 *  29 (explicit nonce). A request's HEADERS is at least 47 (1.3) or 54 (1.2). */
export function controlRecordLimit(tls13: boolean | null): number {
  return tls13 === false ? 46 : 39;
}

/** The TLS version the server chose, from its ServerHello (the first record
 *  it sends): true = 1.3, false = older, null = not a ServerHello,
 *  undefined = more bytes needed. */
export function serverHelloIsTls13(bytes: Buffer): boolean | null | undefined {
  if (bytes.length < 5) return undefined;
  if (bytes[0] !== 0x16) return null;
  const recordEnd = 5 + bytes.readUInt16BE(3);
  if (bytes.length < recordEnd) return recordEnd > 5 + 16_384 + 256 ? null : undefined;
  let p = 5;
  if (bytes[p] !== 0x02) return null;
  p += 4; // handshake type, length
  p += 2 + 32; // legacy_version, random
  if (p >= recordEnd) return null;
  p += 1 + bytes[p]!; // legacy_session_id
  p += 2 + 1; // cipher_suite, legacy_compression_method
  if (p + 2 > recordEnd) return false; // no extensions: TLS 1.2 or older
  const extEnd = Math.min(recordEnd, p + 2 + bytes.readUInt16BE(p));
  p += 2;
  while (p + 4 <= extEnd) {
    const type = bytes.readUInt16BE(p);
    const length = bytes.readUInt16BE(p + 2);
    if (type === 0x002b && length === 2 && p + 6 <= extEnd) return bytes.readUInt16BE(p + 4) === 0x0304;
    p += 4 + length;
  }
  return false;
}

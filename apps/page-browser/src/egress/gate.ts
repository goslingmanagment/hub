// The send gate ("ворота", spec §9; stage 1, §3.1) — the barrier that keeps
// a request without a live admission from leaving even when CDP is lost
// (mandatory conditions №1 and №2, owner decisions №10, №16, №1б).
//
// The proxy cannot see requests inside TLS. But to the API host only one
// admitted request is in flight, and every other request waits in Chrome's
// Fetch interception. And Chrome writes each HTTP/2 frame with a socket
// write of its own (SpdySession::DoWrite), which BoringSSL makes a TLS record
// of its own. So the gate decides on every TLS record Chrome writes into an
// API tunnel, at its 5-byte header (type, version, length); the decision
// holds for the whole record. A tunnel that holds a record holds everything
// after it — a TLS stream is never reordered, nothing is dropped from it —
// until the tunnel is cut.
//
// - A control record — the size of an HTTP/2 control frame (PING and its
//   ACK, WINDOW_UPDATE, RST_STREAM, SETTINGS ACK; ≤ 17 bytes of frame): up
//   to 39 bytes in TLS 1.3, 46 in TLS 1.2 — always goes up. No request fits
//   in one: the shortest request HEADERS is 47 bytes and more.
// - Any other record goes up only inside the window of the request the
//   operator has just released, within the window's budget: the request's
//   HEADERS and one DATA record of its body; a connection opened in the
//   window (one at most) adds its TLS 1.3 Finished and the HTTP/2 preface.
//   A body over 16 375 bytes (one HTTP/2 frame in Chrome) or of unknown
//   length is never released: the gate could not count it.
// - Past its budget the window holds: Chrome's own repeat on the same
//   connection (after REFUSED_STREAM), or a request Chrome let go by itself
//   when CDP was lost, is an extra record and is held. A repeat on a new
//   connection (GOAWAY, a reset, a 408) meets the refusal of new tunnels.
// - Once the server sent anything on the window's tunnel after the request
//   began, nothing big goes there any more: Chrome repeats a request only
//   after the server refused it.
// - At the admission's deadline, with nothing of the request sent, every API
//   tunnel is cut: the request never leaves late. No answer 20 s after the
//   send (from the later of the first bytes and Chrome's announcement): the
//   API tunnels are cut.
// - A big record still held when the next window opens was never admitted:
//   its tunnel is cut, never flushed.
// - A connection opened in a window that its request never went up is cut
//   when the window closes: Chrome finishes such a connection later, and it
//   would take the next window's one new connection — or pass for that
//   window's request (stage 1, amendment 21).
// - One admitted operation of the page at a time, kept here and not only
//   taken from the engine (the owner's rule: one managed request in flight
//   per page). The page's slot is the operation's from its first release
//   until its path has ended it and every request it released has its end
//   confirmed: Chrome's loadingFinished or loadingFailed for that very
//   request, or its answer resolved at the response stage with Chrome's
//   answer to that resolution (a preflight handed on by fulfill has no other
//   end in Chrome 155; decided is not done: an unanswered or refused
//   resolution keeps it pending) — or until Chrome is gone (`browserGone`). Nothing else frees it: not a window's close, a
//   preflight's end while its request is still to come, a sibling's cancel,
//   the operation's own end, the exit's close, a reset. Another operation's
//   window is refused while it is owned: Chrome may still hold a released
//   request unwritten and write it into the next window's new connection,
//   where it would pass for that window's request (two overlapping
//   admissions on stand t9 let a Hub preflight go 3.8 s and a site
//   preflight 13.7 s past their deadlines). Refused, the request is not
//   released: the path ends it not sent (fail closed). The slot's bound —
//   its admission's deadline and the operation's limit (`slotLimitMs`) —
//   passing with an end still unknown is a fault (`onUnended`): the exit
//   closes and Chrome goes, never the slot just cleared. A preflight and its
//   request are one operation (owner decision №1).
//
// What stays open (spec §9, owner decisions №10 and №1б): a request Chrome
// releases by itself in the very moment a window opens can take the window's
// place; a login body split by the server's bytes may leave in part.

import { monoMs } from "../shared/util.ts";

/** Chrome's largest DATA frame payload (kMaxSpdyFrameChunkSize). */
export const MAX_BODY_BYTES = 16 * 1024 - 9;
/** Plan §4.14: no answer this long after the send cuts the API tunnels. */
export const NO_RESPONSE_MS = 20_000;

/** The largest record that carries only a control frame (≤ 17 bytes):
 *  TLS 1.3 adds 22 bytes (header, content type, AEAD tag), TLS 1.2 with
 *  AES-GCM 29 (explicit nonce). */
export function controlRecordLimit(tls13: boolean | null): number {
  return tls13 === false ? 46 : 39;
}

/** Big DATA records of a body: every full frame, and the last one unless it
 *  carries 8 bytes or less — that one fits a control record (31 bytes of
 *  overhead in TLS 1.3, 38 in TLS 1.2, against limits that leave 8). */
export function bigDataRecords(bodyBytes: number): number {
  if (bodyBytes <= 0) return 0;
  const frames = Math.ceil(bodyBytes / MAX_BODY_BYTES);
  const last = bodyBytes - (frames - 1) * MAX_BODY_BYTES;
  return last <= 8 ? frames - 1 : frames;
}

export type GatePhase = "closed" | "open" | "holding" | "responding";
export type RecordVerdict = "up" | "hold";

export interface GateEvent {
  kind: "first_bytes" | "held" | "unadmitted_cut" | "no_response" | "expired" | "announced" | "unused_cut" | "in_flight_refused";
  window: string | null;
  detail: Record<string, string | number | boolean | null>;
}

interface Window {
  id: string;
  deadline: number;
  /** Big records of the request itself: HEADERS and its body's DATA. */
  requestRecords: number;
  /** The tunnel opened in this window. */
  newTunnel: number | null;
  /** The tunnel the request goes up. */
  tunnel: number | null;
  /** What the window's new connection negotiated (null: not known yet). */
  tls13: boolean | null;
  /** Big records that went up the window's tunnel. */
  used: number;
  /** The server sent bytes on the window's tunnel after the request began. */
  serverSpoke: boolean;
  announced: boolean;
  sentAt: number | null;
}

/** The operation a window is of: a preflight's and its request's are one
 *  (`hub:<attempt>:preflight` and `hub:<attempt>:main`, the site's alike). */
export function operationOf(windowId: string): string {
  return windowId.replace(/:(?:preflight|main)$/, "");
}

/** The open's refusal while the page's slot is another operation's. */
export const IN_FLIGHT_REFUSAL = "another admitted request of the page is unfinished: one at a time";

/** The slot's bound past its admission's deadline: the operation's limit
 *  (21 s, hub-requests/hub.ts and intercept/site.ts `opLimitMs`) and a
 *  second for the path's own limit to act first. */
export const SLOT_LIMIT_MS = 22_000;

/** The page's slot: the operation that owns it, what of it was released and
 *  has no confirmed end, whether its path ended it. */
interface Slot {
  operation: string;
  pending: Set<string>;
  ended: boolean;
  boundMono: number;
  timer: NodeJS.Timeout | null;
}

export interface GateOptions {
  /** CLOCK_MONOTONIC ms (tests use their own clock). */
  now?: () => number;
  noResponseMs?: number;
  slotLimitMs?: number;
}

export class ApiGate {
  /** Cut every API tunnel; returns how many. */
  cut: (reason: string) => number = () => 0;
  /** Cut the API tunnels that hold bytes; returns how many. */
  cutHeld: (reason: string) => number = () => 0;
  /** Cut one API tunnel; returns whether it was there. */
  cutTunnel: (tunnel: number, reason: string) => boolean = () => false;
  onEvent: (event: GateEvent) => void = () => undefined;
  /** The slot's bound passed with an end unknown: the caller closes the exit
   *  and lets Chrome go (the slot stays the operation's until then). */
  onUnended: (operation: string, pending: string[]) => void = () => undefined;

  readonly #now: () => number;
  readonly #noResponseMs: number;
  readonly #slotLimitMs: number;
  #phase: GatePhase = "closed";
  #window: Window | null = null;
  #deadlineTimer: NodeJS.Timeout | null = null;
  #noResponseTimer: NodeJS.Timeout | null = null;
  #lastSend: { mono: number; wall: number } | null = null;
  #slot: Slot | null = null;

  constructor(options: GateOptions = {}) {
    this.#now = options.now ?? monoMs;
    this.#noResponseMs = options.noResponseMs ?? NO_RESPONSE_MS;
    this.#slotLimitMs = options.slotLimitMs ?? SLOT_LIMIT_MS;
  }

  get state(): { phase: GatePhase; window: string | null; deadline: number | null } {
    return { phase: this.#phase, window: this.#window?.id ?? null, deadline: this.#window?.deadline ?? null };
  }

  /** The last moment a request's first record went up (for `quiesced`). */
  get lastSend(): { mono: number; wall: number } | null {
    return this.#lastSend;
  }

  /** A physical request is about to be released (Fetch.continueRequest
   *  follows): its window, until `deadlineMono`. `bodyBytes`: its body
   *  (0 = none, null = of unknown length). Refused — the request must then
   *  not be released — for a body the gate cannot count or a deadline gone. */
  open(id: string, deadlineMono: number, bodyBytes: number | null, request: string | null = null): { ok: true } | { ok: false; reason: string; inFlight?: string } {
    if (bodyBytes === null) return { ok: false, reason: "a body of unknown length" };
    if (bodyBytes > MAX_BODY_BYTES) return { ok: false, reason: `a body of ${bodyBytes} bytes, over ${MAX_BODY_BYTES}` };
    const now = this.#now();
    if (!(deadlineMono > now)) return { ok: false, reason: "the admission's deadline has passed" };
    const operation = operationOf(id);
    const owned = this.#slot;
    if (owned !== null && owned.operation !== operation) {
      // Nothing is changed: the slot stays its owner's.
      this.onEvent({ kind: "in_flight_refused", window: id, detail: { owner: owned.operation, pending: owned.pending.size, ended: owned.ended, phase: this.#phase } });
      return { ok: false, reason: `${IN_FLIGHT_REFUSAL} (${owned.operation})`, inFlight: owned.operation };
    }
    this.#take(operation, deadlineMono, request ?? `window ${id}`);
    this.#clearTimers();
    // Whatever a tunnel still holds was never admitted.
    const cut = this.cutHeld("gate: bytes held from before this window");
    if (cut > 0) this.onEvent({ kind: "unadmitted_cut", window: id, detail: { cut, phase: this.#phase } });
    this.#window = {
      id,
      deadline: deadlineMono,
      requestRecords: 1 + bigDataRecords(bodyBytes),
      newTunnel: null,
      tunnel: null,
      tls13: null,
      used: 0,
      serverSpoke: false,
      announced: false,
      sentAt: null,
    };
    this.#phase = "open";
    this.#deadlineTimer = setTimeout(() => this.#onDeadline(id), Math.max(0, deadlineMono - now));
    return { ok: true };
  }

  /** A record starts on API tunnel `tunnel` (nothing is held before it
   *  there). `big`: larger than a control record; `appData`: TLS application
   *  data (type 23); `tls13`: what the tunnel's server chose. */
  record(tunnel: number, big: boolean, appData: boolean, tls13: boolean | null): RecordVerdict {
    const w = this.#window;
    if (this.#phase !== "open" || w === null || this.#now() >= w.deadline) return big ? "hold" : "up";
    if (w.tunnel === tunnel) {
      // The handshake of the window's own new connection.
      if (!appData) return "up";
      if (w.newTunnel === tunnel) w.tls13 = tls13;
      if (!big) return "up";
      if (w.serverSpoke) return "hold";
      if (w.used >= this.#budget(w)) return "hold";
      w.used += 1;
      if (w.used === this.#setupRecords(w) + 1) this.#sent(w);
      return "up";
    }
    if (!big) return "up";
    if (w.tunnel !== null || !appData) return "hold";
    // The request's first record on a warm connection: the tunnel is the
    // window's.
    w.tunnel = tunnel;
    w.used = 1;
    this.#sent(w);
    return "up";
  }

  /** The server's bytes arrived on API tunnel `tunnel` (before they reach
   *  Chrome). */
  noteServerBytes(tunnel: number): void {
    const w = this.#window;
    if (this.#phase === "open" && w !== null && w.tunnel === tunnel && w.used > this.#setupRecords(w)) w.serverSpoke = true;
  }

  /** A record that went up `tunnel` ended. */
  recordDone(tunnel: number): void {
    const w = this.#window;
    if (this.#phase !== "open" || w === null || w.tunnel !== tunnel || w.used < this.#budget(w)) return;
    this.#phase = "holding";
  }

  /** May Chrome open a new tunnel to the API now? Only for the request just
   *  released, before it went up anywhere, once per window. */
  admitsTunnel(): boolean {
    const w = this.#window;
    return this.#phase === "open" && w !== null && !w.announced && w.newTunnel === null && w.tunnel === null && this.#now() < w.deadline;
  }

  /** A tunnel was accepted inside the window: the request goes up it. */
  noteTunnel(tunnel: number): void {
    const w = this.#window;
    if (w === null || this.#phase !== "open") return;
    w.newTunnel = tunnel;
    w.tunnel = tunnel;
  }

  /** Chrome announced the request's headers (requestWillBeSentExtraInfo):
   *  the no-answer limit starts again from here when it comes later than
   *  the first bytes (stage 1, amendment 32). */
  announced(id: string): void {
    const w = this.#window;
    if (!w || w.id !== id || w.announced) return;
    w.announced = true;
    this.onEvent({ kind: "announced", window: id, detail: {} });
    if (this.#phase === "open" || this.#phase === "holding") this.#armNoResponse(w);
  }

  /** The response headers arrived. */
  responding(id: string): void {
    if (this.#window?.id !== id || this.#phase === "closed" || this.#phase === "responding") return;
    this.#clearTimers();
    this.#phase = "responding";
  }

  /** The window's request finished, or its operation was closed: the window
   *  closes (the page's slot is apart: `requestEnded`, `operationEnded`). */
  close(id: string): void {
    const w = this.#window;
    if (w?.id !== id) return;
    this.#clearTimers();
    this.#phase = "closed";
    this.#window = null;
    if (w.newTunnel !== null && w.used <= this.#setupRecords(w) && this.cutTunnel(w.newTunnel, "gate: a connection its window's request never went up")) {
      this.onEvent({ kind: "unused_cut", window: id, detail: { tunnel: w.newTunnel } });
    }
  }

  // ── the page's slot ────────────────────────────────────────────────────

  /** The operation that owns the page's slot, if any. */
  get slotOwner(): string | null {
    return this.#slot?.operation ?? null;
  }

  /** Released requests of the owner without a confirmed end (tests). */
  get slotPending(): string[] {
    return [...(this.#slot?.pending ?? [])];
  }

  /** A request released under the slot has its end confirmed: Chrome's
   *  loadingFinished or loadingFailed for it, or its answer resolved at the
   *  response stage and that resolution answered by Chrome. */
  requestEnded(request: string | null): void {
    const slot = this.#slot;
    if (slot === null || request === null || !slot.pending.delete(request)) return;
    this.#freeIfDone();
  }

  /** The operation's path ended it (its outcome decided): the slot is free
   *  once every request it released has its end confirmed. */
  operationEnded(operation: string): void {
    const slot = this.#slot;
    if (slot === null || slot.operation !== operation) return;
    slot.ended = true;
    this.#freeIfDone();
  }

  /** Chrome is gone (killed, stopped, crashed and reaped): whatever it held
   *  is gone with it. */
  browserGone(): void {
    if (this.#slot?.timer) clearTimeout(this.#slot.timer);
    this.#slot = null;
  }

  #take(operation: string, deadlineMono: number, request: string): void {
    let slot = this.#slot;
    if (slot === null) {
      slot = { operation, pending: new Set(), ended: false, boundMono: deadlineMono + this.#slotLimitMs, timer: null };
      this.#slot = slot;
      const owned = slot;
      owned.timer = setTimeout(() => this.#onBound(owned), Math.max(0, owned.boundMono - this.#now()));
    }
    slot.pending.add(request);
  }

  #freeIfDone(): void {
    const slot = this.#slot;
    if (slot === null || !slot.ended || slot.pending.size > 0) return;
    if (slot.timer) clearTimeout(slot.timer);
    this.#slot = null;
  }

  #onBound(slot: Slot): void {
    slot.timer = null;
    if (this.#slot !== slot) return;
    // Not cleared: it stays the operation's until Chrome is gone.
    this.onUnended(slot.operation, [...slot.pending]);
  }

  /** The exit closed or control was lost: no window any more. The page's
   *  slot stays its owner's (`browserGone` frees it, or every end). */
  reset(): void {
    this.#clearTimers();
    this.#phase = "closed";
    this.#window = null;
  }

  /** A big record was held (for the journal: what was stopped, when). */
  noteHeld(tunnel: number, length: number): void {
    this.onEvent({ kind: "held", window: this.#window?.id ?? null, detail: { tunnel, length, phase: this.#phase } });
  }

  #sent(w: Window): void {
    w.sentAt = this.#now();
    this.#lastSend = { mono: w.sentAt, wall: Date.now() };
    this.onEvent({ kind: "first_bytes", window: w.id, detail: { newTunnel: w.newTunnel !== null } });
    this.#armNoResponse(w);
  }

  #armNoResponse(w: Window): void {
    if (this.#noResponseTimer) clearTimeout(this.#noResponseTimer);
    const id = w.id;
    this.#noResponseTimer = setTimeout(() => {
      this.#noResponseTimer = null;
      if (this.#window?.id !== id || this.#phase === "responding" || this.#phase === "closed") return;
      const cut = this.cut("gate: no answer 20 s after the send");
      this.onEvent({ kind: "no_response", window: id, detail: { cut } });
    }, this.#noResponseMs);
  }

  /** Big records the window's tunnel may carry. */
  #budget(w: Window): number {
    return this.#setupRecords(w) + w.requestRecords;
  }

  /** Big records of the window's own new connection before the request:
   *  TLS 1.3 Finished and the HTTP/2 preface; TLS 1.2 only the preface (its
   *  Finished is not application data). */
  #setupRecords(w: Window): number {
    if (w.newTunnel === null) return 0;
    return w.tls13 === false ? 1 : 2;
  }

  #onDeadline(id: string): void {
    this.#deadlineTimer = null;
    const w = this.#window;
    if (!w || w.id !== id || this.#phase !== "open") return;
    if (w.used > this.#setupRecords(w)) {
      // Out already: the window only stops carrying anything new.
      this.#phase = "holding";
      return;
    }
    // Nothing of the request may leave from now on. Every API tunnel goes:
    // one may still be finishing the handshake the request would follow.
    const cut = this.cut("gate: the admission expired before the send");
    this.#clearTimers();
    this.#phase = "closed";
    this.#window = null;
    this.onEvent({ kind: "expired", window: id, detail: { cut, announced: w.announced, newTunnel: w.newTunnel !== null } });
  }

  #clearTimers(): void {
    if (this.#deadlineTimer) clearTimeout(this.#deadlineTimer);
    if (this.#noResponseTimer) clearTimeout(this.#noResponseTimer);
    this.#deadlineTimer = null;
    this.#noResponseTimer = null;
  }
}

/** The TLS version the server chose, from its ServerHello: true = 1.3,
 *  false = older, null = not a well-formed ServerHello (the tunnel is then
 *  cut: the record counts depend on the version), undefined = more bytes
 *  needed. The ServerHello may be split over several handshake records (RFC
 *  8446 §5.1): their payloads are joined until the whole message is there. */
export function serverHelloIsTls13(bytes: Buffer): boolean | null | undefined {
  const hello = readServerHello(bytes);
  return hello === null || hello === undefined ? hello : hello.tls13;
}

/** The ServerHello's version and cipher suite (the socket gate measures
 *  records by both); null and undefined as in serverHelloIsTls13. */
export function readServerHello(bytes: Buffer): { tls13: boolean; cipherSuite: number } | null | undefined {
  const parts: Buffer[] = [];
  let p = 0;
  let joined = 0;
  for (;;) {
    if (bytes.length < p + 5) break;
    if (bytes[p] !== 0x16) {
      if (parts.length === 0) return null;
      break;
    }
    const length = bytes.readUInt16BE(p + 3);
    if (length === 0 || length > 16_384 + 256) return null;
    if (bytes.length < p + 5 + length) break;
    parts.push(bytes.subarray(p + 5, p + 5 + length));
    joined += length;
    p += 5 + length;
    if (joined >= 4) {
      const head = Buffer.concat(parts);
      if (head[0] !== 0x02) return null;
      const messageLength = head.readUIntBE(1, 3);
      if (messageLength > 65_536) return null;
      if (head.length >= 4 + messageLength) return parseServerHello(head.subarray(4, 4 + messageLength));
    }
  }
  return bytes.length > 70_000 ? null : undefined;
}

function parseServerHello(body: Buffer): { tls13: boolean; cipherSuite: number } | null {
  let p = 2 + 32; // legacy_version, random
  if (body.length < p + 1) return null;
  p += 1 + body[p]!; // legacy_session_id
  if (p + 3 > body.length) return null;
  const cipherSuite = body.readUInt16BE(p);
  p += 2 + 1; // cipher_suite, legacy_compression_method
  if (p === body.length) return { tls13: false, cipherSuite }; // no extensions: TLS 1.2 or older
  if (p + 2 > body.length) return null;
  const extEnd = p + 2 + body.readUInt16BE(p);
  if (extEnd > body.length) return null;
  p += 2;
  while (p + 4 <= extEnd) {
    const type = body.readUInt16BE(p);
    const length = body.readUInt16BE(p + 2);
    if (p + 4 + length > extEnd) return null;
    if (type === 0x002b) return length === 2 ? { tls13: body.readUInt16BE(p + 4) === 0x0304, cipherSuite } : null;
    p += 4 + length;
  }
  return { tls13: false, cipherSuite };
}

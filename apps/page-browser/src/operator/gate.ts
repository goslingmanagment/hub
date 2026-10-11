// PROTOTYPE CANDIDATE — the API send gate (plan §4.1 "рубеж отправки", §4.2
// step 4, owner decisions №10 and №16).
//
// The proxy cannot see requests inside TLS. But on the API host only one
// admitted request is in flight, and every other request waits in Chrome's
// Fetch interception. So what Chrome writes into API tunnels is forwarded
// only inside the window of the physical request that was just released, and
// a new tunnel to the API is accepted only at the start of such a window.
//
//   closed      nothing is released: bytes are held, new tunnels refused.
//   open        a request was released: bytes are forwarded until the
//               admission's deadline (CLOCK_MONOTONIC). A request without a
//               body on a warm connection is one TLS record — Chrome writes
//               its HEADERS frame in one go — so the window forwards exactly
//               one record and holds what follows (a request Chrome released
//               without us at that moment is a record of its own). Otherwise
//               (a new connection in this window, a body) it stops when
//               Chrome has announced the send (requestWillBeSentExtraInfo)
//               and the line went quiet for QUIET_MS. At the deadline, with
//               nothing sent, every API tunnel is cut: the request never
//               leaves.
//   holding     the request is out: bytes are held (a record that is half
//               through is finished first). This is what stops Chrome's own
//               repeats — after REFUSED_STREAM it repeats in the same
//               connection, CDP does not report it (stand finding), and the
//               repeat's bytes stay here. A repeat on a new connection (after
//               GOAWAY, a reset, a 408) meets the refusal of new tunnels,
//               which starts at Chrome's announcement. No response headers
//               in 20 s → the API tunnels are cut.
//   responding  the response headers arrived (no repeat can follow): the
//               held bytes (flow control, acks) and the rest are forwarded.
//
// Bytes held while closed are the housekeeping of idle connections — or
// requests Chrome released without us (a CDP detach); on a CDP loss the
// operator cuts every tunnel, so those never leave. What is left open: a CDP
// loss inside a window that is still forwarding (stand: loss-open-window).

import { monoMs } from "../shared/util.ts";

/** Fallback of the one-record rule: a record still incomplete this long
 *  after the window's first chunk closes the window anyway. */
const BURST_MS = Number(process.env.PB_GATE_BURST_MS ?? "2");
/** After Chrome's announcement, a window that is not a single burst stops
 *  forwarding once it carried bytes and stayed quiet this long. Shorter than
 *  a round trip to the API (a repeat cannot come sooner). */
const QUIET_MS = Number(process.env.PB_GATE_QUIET_MS ?? "5");
/** Plan §4.14: a request's limit (REQUEST_TIMEOUT_MS of the engine). */
const NO_RESPONSE_MS = 20_000;

export type GatePhase = "closed" | "open" | "holding" | "responding";

export interface GateEvent {
  kind: string;
  window: string | null;
  detail: Record<string, unknown>;
}

interface Window {
  id: string;
  deadline: number;
  /** No body: one burst on a warm connection. */
  bodiless: boolean;
  /** A tunnel was opened in this window (its handshake comes in bursts). */
  newTunnel: boolean;
  announced: boolean;
  openedAt: number;
  firstChunkAt: number | null;
  lastChunkAt: number;
  bytes: number;
}

export class ApiGate {
  enabled = process.env.PB_GATE !== "0";
  /** Stand: off = the window closes only on Chrome's announcement. */
  burstClose = process.env.PB_GATE_BURST !== "0";
  onEvent: (event: GateEvent) => void = () => undefined;
  /** Cut every API tunnel; returns how many. */
  cut: (reason: string) => number = () => 0;
  /** Forward what API tunnels hold (the phase now forwards). */
  flush: () => void = () => undefined;

  #phase: GatePhase = "closed";
  #window: Window | null = null;
  #deadlineTimer: NodeJS.Timeout | null = null;
  #holdTimer: NodeJS.Timeout | null = null;
  #noResponseTimer: NodeJS.Timeout | null = null;

  get state(): { phase: GatePhase; window: string | null; deadline: number } {
    return { phase: this.#phase, window: this.#window?.id ?? null, deadline: this.#window?.deadline ?? 0 };
  }

  /** May bytes go up an API tunnel now? */
  forwards(): boolean {
    if (!this.enabled) return true;
    if (this.#phase === "responding") return true;
    return this.#phase === "open" && this.#window !== null && monoMs() < this.#window.deadline;
  }

  /** The window forwards one record only (a request without a body on a
   *  warm connection) and has not forwarded it yet. */
  get wantsOneRecord(): boolean {
    const w = this.#window;
    return this.enabled && this.#phase === "open" && w !== null && this.#singleBurst(w) && w.firstChunkAt === null;
  }

  /** The window's one record went up: hold from here on. */
  recordDone(): void {
    if (this.#phase === "open") this.#hold("record");
  }

  /** May Chrome open a new tunnel to the API now? Only for the request just
   *  released and not yet announced. */
  admitsTunnel(): boolean {
    if (!this.enabled) return true;
    const w = this.#window;
    return this.#phase === "open" && w !== null && !w.announced && monoMs() < w.deadline;
  }

  /** A tunnel was accepted inside the window. */
  noteTunnel(): void {
    const w = this.#window;
    if (!w || this.#phase !== "open") return;
    w.newTunnel = true;
    // Its handshake is several bursts: the burst rule no longer applies.
    this.#clearHoldTimer();
    if (w.announced) this.#watchQuiet();
  }

  /** Bytes Chrome wrote after the window opened went up. */
  noteChunk(bytes: number): void {
    const w = this.#window;
    if (!w || !(this.#phase === "open" || this.#phase === "responding")) return;
    const now = monoMs();
    w.bytes += bytes;
    w.lastChunkAt = now;
    if (this.#phase !== "open") return;
    if (w.firstChunkAt === null) {
      w.firstChunkAt = now;
      this.onEvent({ kind: "first_bytes", window: w.id, detail: { afterOpenMs: round(now - w.openedAt), bytes } });
      if (this.#singleBurst(w)) {
        this.#holdTimer = setTimeout(() => this.#hold("burst"), BURST_MS);
        return;
      }
    }
    if (w.announced && !this.#singleBurst(w)) this.#watchQuiet();
  }

  /** A physical request was released (Fetch.continueRequest follows). */
  open(id: string, deadlineMono: number, bodiless: boolean): void {
    this.#clearTimers();
    const now = monoMs();
    this.#window = { id, deadline: deadlineMono, bodiless, newTunnel: false, announced: false, openedAt: now, firstChunkAt: null, lastChunkAt: 0, bytes: 0 };
    this.#phase = "open";
    // Housekeeping held while closed goes first; it does not start the burst.
    this.flush();
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
    if (this.#phase === "open" && !this.#singleBurst(w)) this.#watchQuiet();
  }

  /** The response headers arrived. */
  responding(id: string): void {
    if (this.#window?.id !== id || this.#phase === "closed" || this.#phase === "responding") return;
    this.#clearTimers();
    this.#phase = "responding";
    this.flush();
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

  #singleBurst(w: Window): boolean {
    return this.burstClose && w.bodiless && !w.newTunnel;
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
    // Out already? A single burst that carried bytes, or an announced send
    // that carried bytes after it began.
    const sent = (this.#singleBurst(w) && w.firstChunkAt !== null) || (w.announced && w.bytes > 0 && !w.newTunnel);
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
    this.onEvent({ kind: "expired", window: id, detail: { cut, bytes: w.bytes, announced: w.announced, newTunnel: w.newTunnel } });
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

/** Follows the TLS records of one direction of a tunnel (5-byte header:
 *  type, version, length). The gate never stops forwarding in the middle of
 *  a record: a request's frame split over two TCP segments stays whole. */
export class RecordTracker {
  #header = Buffer.alloc(5);
  #headerFill = 0;
  #remaining = 0;

  /** In the middle of a record (or of its header)? */
  get midRecord(): boolean {
    return this.#headerFill > 0 || this.#remaining > 0;
  }

  /** Account for bytes that went up. */
  advance(bytes: Buffer): void {
    this.#walk(bytes, false);
  }

  /** Leading bytes of `bytes` that make up exactly one whole record from
   *  the current position (finishing the one in progress counts); -1 when
   *  the chunk ends before that record does. */
  oneRecord(bytes: Buffer): number {
    if (this.midRecord) {
      const end = this.prefixToBoundary(bytes);
      return this.#atBoundaryAfter(bytes, end) ? end : -1;
    }
    if (bytes.length < 5) return -1;
    const end = 5 + bytes.readUInt16BE(3);
    return end <= bytes.length ? end : -1;
  }

  #atBoundaryAfter(bytes: Buffer, offset: number): boolean {
    // prefixToBoundary returns the chunk's length when the record does not
    // end inside it: tell the two apart by walking a copy.
    const copy = new RecordTracker();
    copy.#headerFill = this.#headerFill;
    copy.#remaining = this.#remaining;
    copy.#header = Buffer.from(this.#header);
    copy.advance(bytes.subarray(0, offset));
    return !copy.midRecord;
  }

  /** How many leading bytes of `bytes` finish the record in progress. */
  prefixToBoundary(bytes: Buffer): number {
    if (!this.midRecord) return 0;
    return this.#walk(bytes, true);
  }

  #walk(bytes: Buffer, stopAtBoundary: boolean): number {
    let headerFill = this.#headerFill;
    let remaining = this.#remaining;
    const header = stopAtBoundary ? Buffer.from(this.#header) : this.#header;
    let offset = 0;
    while (offset < bytes.length) {
      if (remaining === 0) {
        const take = Math.min(5 - headerFill, bytes.length - offset);
        bytes.copy(header, headerFill, offset, offset + take);
        headerFill += take;
        offset += take;
        if (headerFill < 5) break;
        remaining = header.readUInt16BE(3);
        headerFill = 0;
      } else {
        const take = Math.min(remaining, bytes.length - offset);
        remaining -= take;
        offset += take;
      }
      if (stopAtBoundary && remaining === 0 && headerFill === 0) return offset;
    }
    if (!stopAtBoundary) {
      this.#headerFill = headerFill;
      this.#remaining = remaining;
    }
    return offset;
  }
}

import {
  businessFanslyWsFrame, classifyFanslyWsFrame, FANSLY_WS_MAX_FRAME_BYTES,
} from "@agency_hub_core/shared";

export interface FanslyReceiverSocket extends EventTarget { send(data: string): void }
export type FanslyWsStopReason = "disabled" | "ownership_lost" | "generation_changed" | "guard_unavailable"
  | "transport_error" | "closed" | "auth_timeout" | "pong_timeout" | "auth_refused" | "provider_error"
  | "invalid_frame" | "overflow" | "capture_unavailable";
const QUEUE_MAX_FRAMES = 128;
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;

/** Stops that lose the right to write (page ownership, credential generation,
 * the guard) or the ability to (capture failing). Every other stop is
 * graceful: the socket stops being read and frames it already delivered are
 * still captured. */
const DROP_ON_STOP: ReadonlySet<FanslyWsStopReason> = new Set([
  "ownership_lost", "generation_changed", "guard_unavailable", "capture_unavailable",
]);

export function drainsOnStop(reason: FanslyWsStopReason) {
  return !DROP_ON_STOP.has(reason);
}

/** Receiver deadlines. Production always uses the defaults below; the override
 * exists only so integration tests can run the real socket on scaled time. */
export interface FanslyWsConnectionTiming {
  /** Auth deadline; only a session frame clears it. */
  authTimeoutMs: number;
  /** Watchdog and guard interval. */
  checkMs: number;
  /** A guard that has not returned for this long stops the attempt. */
  guardStaleMs: number;
  pingMs: number;
  /** Missing pong deadline, checked every `checkMs`. */
  pongTimeoutMs: number;
  /** A graceful stop captures already received frames for at most this long
   * (a full 128-frame queue takes a few seconds); the rest stays uncaptured. */
  drainMs: number;
}
export const FANSLY_WS_CONNECTION_TIMING: Readonly<FanslyWsConnectionTiming> = Object.freeze({
  authTimeoutMs: 10_000, checkMs: 5_000, guardStaleMs: 15_000, pingMs: 20_000, pongTimeoutMs: 30_000,
  drainMs: 20_000,
});

/** One connection, one serial durable writer, bounded memory. Only protocol
 * controls are interpreted before capture. Business decoding and the live
 * overlay happen after the capture commit, outside this receiver. */
export function receiveFanslyConnection(input: {
  open: () => { socket: FanslyReceiverSocket; stop(): void };
  token: string;
  signal: AbortSignal;
  capture: (frame: string, ordinal: number, receivedAt: Date) => Promise<number>;
  guard: (verified: boolean) => Promise<void>;
  onStable?: () => void;
  /** Called once, when the socket stops being read (before any drain). */
  onIntakeStopped?: (at: Date) => void;
  timing?: FanslyWsConnectionTiming;
}): Promise<FanslyWsStopReason> {
  const timing = input.timing ?? FANSLY_WS_CONNECTION_TIMING;
  return new Promise((resolve) => {
    const queue: { frame: string; ordinal: number; receivedAt: Date; bytes: number }[] = [];
    let queuedBytes = 0;
    let ordinal = 0;
    /** Set once intake stops; the first reason is the attempt's reason. */
    let closing: FanslyWsStopReason | null = null;
    let finished = false;
    let draining = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let verified = false;
    let verifiedAt: number | null = null;
    let stable = false;
    let opened = false;
    let lastPong = Date.now();
    let lastGuard = Date.now();
    let guarding = false;
    let transport: ReturnType<typeof input.open> | undefined;
    const authTimer = setTimeout(() => stop("auth_timeout"), timing.authTimeoutMs);
    const timer = setInterval(() => {
      // Independent watchdog: a stuck DB read does not block socket shutdown.
      if (Date.now() - lastGuard > timing.guardStaleMs) { stop("guard_unavailable"); return; }
      if (opened && Date.now() - lastPong > timing.pongTimeoutMs) { stop("pong_timeout"); return; }
      if (!stable && verifiedAt !== null && Date.now() - verifiedAt >= 60_000) {
        stable = true; input.onStable?.();
      }
      if (!guarding) {
        guarding = true;
        void input.guard(verified).then(() => { if (closing === null) lastGuard = Date.now(); })
          .catch(() => stop("guard_unavailable")).finally(() => { guarding = false; });
      }
    }, timing.checkMs);
    const pingTimer = setInterval(() => {
      if (!opened || closing !== null) return;
      try { transport!.socket.send("p"); } catch { stop("transport_error"); }
    }, timing.pingMs);
    const abort = () => stop(isStopReason(input.signal.reason) ? input.signal.reason : "disabled");

    function stop(reason: FanslyWsStopReason) {
      if (closing !== null) {
        // Losing the right to write ends a drain already in progress.
        if (!drainsOnStop(reason)) finish();
        return;
      }
      closing = reason;
      clearTimeout(authTimer); clearInterval(timer); clearInterval(pingTimer);
      transport?.stop();
      input.onIntakeStopped?.(new Date());
      if (!drainsOnStop(reason) || (queue.length === 0 && !draining)) { finish(); return; }
      // Frames the socket already delivered are durable work, not noise: capture
      // them (in order, through the same fenced writer) within the drain bound.
      drainTimer = setTimeout(finish, timing.drainMs);
      void drain();
    }

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(drainTimer);
      input.signal.removeEventListener("abort", abort);
      // Frames still queued here (no time left, or the right to write is gone)
      // are uncertain, not reported as committed. Each attempt's durable
      // connection record already carries an open gap.
      queue.length = 0;
      queuedBytes = 0;
      resolve(closing!);
    }

    async function drain() {
      if (draining || finished) return;
      draining = true;
      try {
        while (!finished && queue.length > 0) {
          const item = queue[0]!;
          await input.capture(item.frame, item.ordinal, item.receivedAt);
          // Durable acceptance; decoding and the overlay follow the commit.
          if (finished) return;
          if (!stable) { stable = true; input.onStable?.(); }
          queue.shift(); queuedBytes -= item.bytes;
        }
      } catch {
        if (closing === null) stop("capture_unavailable"); else finish();
        return;
      } finally { draining = false; }
      if (closing !== null) finish();
    }

    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) { abort(); return; }
    try { transport = input.open(); } catch { stop("transport_error"); return; }
    transport.socket.addEventListener("open", () => {
      if (closing !== null) return;
      opened = true; lastPong = Date.now();
      try { transport!.socket.send(JSON.stringify({ t: 1, d: JSON.stringify({ token: input.token, v: 3 }) })); }
      catch { stop("transport_error"); }
    });
    transport.socket.addEventListener("message", (event) => {
      if (closing !== null) return;
      const frame: unknown = (event as MessageEvent).data;
      ordinal++;
      if (typeof frame !== "string") { stop("invalid_frame"); return; }
      const bytes = Buffer.byteLength(frame);
      if (bytes > FANSLY_WS_MAX_FRAME_BYTES) { stop("overflow"); return; }
      const kind = classifyFanslyWsFrame(frame);
      if (kind === "session") { verified = true; verifiedAt ??= Date.now(); clearTimeout(authTimer); return; }
      if (kind === "pong") { lastPong = Date.now(); return; }
      if (kind !== "business") { stop(kind === "invalid" ? "invalid_frame" : kind); return; }
      if (!verified) { stop("invalid_frame"); return; }
      if (queue.length >= QUEUE_MAX_FRAMES || queuedBytes + bytes > QUEUE_MAX_BYTES) { stop("overflow"); return; }
      let business: string;
      try { business = businessFanslyWsFrame(frame); } catch { stop("invalid_frame"); return; }
      queue.push({ frame: business, ordinal, receivedAt: new Date(), bytes }); queuedBytes += bytes;
      void drain();
    });
    transport.socket.addEventListener("error", () => stop("transport_error"));
    transport.socket.addEventListener("close", () => stop("closed"));
  });
}

function isStopReason(reason: unknown): reason is FanslyWsStopReason {
  return reason === "disabled" || reason === "ownership_lost" || reason === "generation_changed"
    || reason === "guard_unavailable";
}

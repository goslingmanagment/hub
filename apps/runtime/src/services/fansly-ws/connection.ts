import {
  businessFanslyWsFrame, classifyFanslyWsFrame, decodeFanslyWsCapture, FANSLY_WS_MAX_FRAME_BYTES,
  type FanslyWsDecodeNode,
} from "@agency_hub_core/shared";

export interface FanslyReceiverSocket extends EventTarget { send(data: string): void }
export type FanslyWsStopReason = "disabled" | "ownership_lost" | "generation_changed" | "guard_unavailable"
  | "transport_error" | "closed" | "auth_timeout" | "pong_timeout" | "auth_refused" | "provider_error"
  | "invalid_frame" | "overflow" | "capture_unavailable";
const QUEUE_MAX_FRAMES = 128;
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;

/** One connection, one serial durable writer, bounded memory. Only protocol
 * controls are interpreted before capture. No route, hint or business writer. */
export function receiveFanslyConnection(input: {
  open: () => { socket: FanslyReceiverSocket; stop(): void };
  token: string;
  signal: AbortSignal;
  capture: (frame: string, ordinal: number, receivedAt: Date) => Promise<number>;
  decode?: (frame: string) => FanslyWsDecodeNode[];
  settle: (observationId: number, nodes: FanslyWsDecodeNode[]) => Promise<void>;
  guard: (verified: boolean) => Promise<void>;
  onStable?: () => void;
}): Promise<FanslyWsStopReason> {
  return new Promise((resolve) => {
    const queue: { frame: string; ordinal: number; receivedAt: Date; bytes: number }[] = [];
    let queuedBytes = 0;
    let ordinal = 0;
    let stopped = false;
    let draining = false;
    let verified = false;
    let verifiedAt: number | null = null;
    let stable = false;
    let opened = false;
    let lastPong = Date.now();
    let lastGuard = Date.now();
    let guarding = false;
    let transport: ReturnType<typeof input.open> | undefined;
    const authTimer = setTimeout(() => stop("auth_timeout"), 10_000);
    const timer = setInterval(() => {
      // Independent watchdog: a stuck DB read does not block socket shutdown.
      if (Date.now() - lastGuard > 15_000) { stop("guard_unavailable"); return; }
      if (opened && Date.now() - lastPong > 30_000) { stop("pong_timeout"); return; }
      if (!stable && verifiedAt !== null && Date.now() - verifiedAt >= 60_000) {
        stable = true; input.onStable?.();
      }
      if (!guarding) {
        guarding = true;
        void input.guard(verified).then(() => { if (!stopped) lastGuard = Date.now(); })
          .catch(() => stop("guard_unavailable")).finally(() => { guarding = false; });
      }
    }, 5_000);
    const pingTimer = setInterval(() => {
      if (!opened || stopped) return;
      try { transport!.socket.send("p"); } catch { stop("transport_error"); }
    }, 20_000);
    const abort = () => stop(isStopReason(input.signal.reason) ? input.signal.reason : "disabled");

    function stop(reason: FanslyWsStopReason) {
      if (stopped) return;
      stopped = true;
      clearTimeout(authTimer); clearInterval(timer); clearInterval(pingTimer);
      input.signal.removeEventListener("abort", abort);
      transport?.stop();
      // Pending/in-flight frames are uncertain, not reported as committed.
      // Each attempt's durable connection record already carries an open gap.
      queue.length = 0;
      queuedBytes = 0;
      resolve(reason);
    }

    async function drain() {
      if (draining || stopped) return;
      draining = true;
      try {
        while (!stopped && queue.length > 0) {
          const item = queue[0]!;
          const id = await input.capture(item.frame, item.ordinal, item.receivedAt);
          // Durable acceptance precedes business decode, including unknowns.
          if (stopped) return;
          if (!stable) { stable = true; input.onStable?.(); }
          try { await input.settle(id, (input.decode ?? decodeFanslyWsCapture)(item.frame)); }
          catch { /* Raw + pending receipt survive; replay can settle offline. */ }
          if (stopped) return;
          queue.shift(); queuedBytes -= item.bytes;
        }
      } catch { stop("capture_unavailable"); }
      finally { draining = false; }
    }

    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) { abort(); return; }
    try { transport = input.open(); } catch { stop("transport_error"); return; }
    transport.socket.addEventListener("open", () => {
      if (stopped) return;
      opened = true; lastPong = Date.now();
      try { transport!.socket.send(JSON.stringify({ t: 1, d: JSON.stringify({ token: input.token, v: 3 }) })); }
      catch { stop("transport_error"); }
    });
    transport.socket.addEventListener("message", (event) => {
      if (stopped) return;
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

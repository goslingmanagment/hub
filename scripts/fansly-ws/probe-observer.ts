import { diagnoseFrame, MAX_FRAME_BYTES } from "./diagnostic.ts";

export const MAX_PROBE_DURATION_MS = 120_000;
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 30_000;
const MAX_RECORDS = 1_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export interface ProbeSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

type StopReason = "deadline" | "aborted" | "connect_error" | "transport_error"
  | "closed" | "auth_timeout" | "pong_timeout" | "provider_error"
  | "invalid_frame" | "frame_limit" | "report_limit";

type FrameReceipt = {
  receivedAt: string;
  diagnostic: ReturnType<typeof diagnoseFrame>;
};

export interface ProbeObservation {
  startedAt: string;
  finishedAt: string;
  stopReason: StopReason;
  sessionFrameSeen: boolean;
  closeCode: number | null;
  framesReceived: number;
  framesRetained: number;
  records: FrameReceipt[];
}

/** One connection, no retry and no business writes. Limits below apply after
 * message delivery; run the process in a separate memory-limited container.
 * A session frame is evidence of its shape, not account binding or coverage. */
export function observeFanslyProbe(input: {
  connect: () => ProbeSocket;
  token: string;
  key: Buffer;
  durationMs: number;
  signal: AbortSignal;
}): Promise<ProbeObservation> {
  if (!Number.isInteger(input.durationMs) || input.durationMs < 1
    || input.durationMs > MAX_PROBE_DURATION_MS || input.key.length !== 32
    || !input.token.trim()) {
    throw new Error("invalid_probe_input");
  }

  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    const records: FrameReceipt[] = [];
    let socket: ProbeSocket | null = null;
    let finished = false;
    let sessionFrameSeen = false;
    let framesReceived = 0;
    let reportBytes = 0;
    let openedAt: number | null = null;
    let lastPongAt: number | null = null;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const authTimer = setTimeout(() => finish("auth_timeout"), AUTH_TIMEOUT_MS);
    const deadlineTimer = setTimeout(() => finish("deadline"), input.durationMs);

    function finish(stopReason: StopReason, closeCode: number | null = null) {
      if (finished) return;
      finished = true;
      clearInterval(pingTimer);
      clearTimeout(authTimer);
      clearTimeout(deadlineTimer);
      input.signal.removeEventListener("abort", abort);
      // Keep error handlers attached until the isolated process exits. Upgraded
      // sockets may outlive dispatcher destruction and emit late close/error.
      try { socket?.close(); } catch { /* The caller owns transport cleanup. */ }
      resolve({
        startedAt, finishedAt: new Date().toISOString(), stopReason,
        sessionFrameSeen, closeCode, framesReceived,
        framesRetained: records.length, records,
      });
    }

    function abort() { finish("aborted"); }

    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) { finish("aborted"); return; }
    try { socket = input.connect(); }
    catch { finish("connect_error"); return; }

    socket.addEventListener("open", () => {
      if (finished) return;
      openedAt = Date.now();
      lastPongAt = openedAt;
      try {
        socket!.send(JSON.stringify({
          t: 1, d: JSON.stringify({ token: input.token, v: 3 }),
        }));
      } catch { finish("transport_error"); return; }
      pingTimer = setInterval(() => {
        if (finished) return;
        if (Date.now() - (lastPongAt ?? openedAt!) > PONG_TIMEOUT_MS) {
          finish("pong_timeout");
          return;
        }
        try { socket!.send("p"); }
        catch { finish("transport_error"); }
      }, PING_INTERVAL_MS);
    }, { once: true });

    socket.addEventListener("message", (event) => {
      if (finished) return;
      framesReceived++;
      const data: unknown = (event as MessageEvent).data;
      if (typeof data !== "string") { finish("invalid_frame"); return; }
      if (Buffer.byteLength(data) > MAX_FRAME_BYTES) { finish("frame_limit"); return; }
      const diagnostic = diagnoseFrame(data, input.key);
      const receipt = { receivedAt: new Date().toISOString(), diagnostic };
      const bytes = Buffer.byteLength(JSON.stringify(receipt));
      if (records.length >= MAX_RECORDS || reportBytes + bytes > MAX_REPORT_BYTES) {
        finish("report_limit");
        return;
      }
      records.push(receipt);
      reportBytes += bytes;
      if (diagnostic.rejected || diagnostic.truncated
        || diagnostic.nodes.some((node) => node.reason === "invalid_payload"
          || node.reason === "invalid_wrapper")) {
        finish("invalid_frame");
        return;
      }
      if (diagnostic.nodes.some((node) => node.kind === "error")) {
        finish("provider_error");
        return;
      }
      if (openedAt !== null && diagnostic.nodes[0]?.kind === "session_verified_frame") {
        sessionFrameSeen = true;
        clearTimeout(authTimer);
      }
      if (diagnostic.nodes[0]?.kind === "pong") lastPongAt = Date.now();
    });
    socket.addEventListener("error", () => finish("transport_error"));
    socket.addEventListener("close", (event) => {
      const code: unknown = (event as Event & { code?: unknown }).code;
      finish("closed", typeof code === "number" && Number.isInteger(code) ? code : null);
    });
  });
}

import { diagnoseFrame, MAX_FRAME_BYTES } from "./diagnostic.ts";

export const MAX_CONNECTION_DURATION_MS = 6 * 60 * 60 * 1_000;
const AUTH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 30_000;

export interface ProbeSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export type StopReason = "deadline" | "aborted" | "connect_error" | "transport_error"
  | "closed" | "auth_timeout" | "pong_timeout" | "provider_error"
  | "invalid_frame" | "frame_limit" | "report_limit" | "output_error";

export type FrameReceipt = {
  receivedAt: string;
  diagnostic: ReturnType<typeof diagnoseFrame>;
};

export interface ConnectionObservation {
  startedAt: string;
  finishedAt: string;
  stopReason: StopReason;
  sessionFrameSeen: boolean;
  closeCode: number | null;
  framesReceived: number;
  framesRetained: number;
  openedAt: string | null;
  sessionFrameAt: string | null;
  sessionObservedMs: number;
}

/** One connection, no retry and no business writes. Limits below apply after
 * message delivery; run the process in a separate memory-limited container.
 * A session frame is evidence of its shape, not account binding or coverage. */
export function observeFanslyConnection(input: {
  connect: () => ProbeSocket;
  token: string;
  key: Buffer;
  durationMs: number;
  signal: AbortSignal;
  durationFrom: "start" | "session_frame";
  maxRecords: number;
  maxReportBytes: number;
  retain: (receipt: FrameReceipt) => void;
}): Promise<ConnectionObservation> {
  if (!Number.isInteger(input.durationMs) || input.durationMs < 1
    || input.durationMs > MAX_CONNECTION_DURATION_MS || input.key.length !== 32
    || !input.token.trim() || !Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1
    || !Number.isSafeInteger(input.maxReportBytes) || input.maxReportBytes < 1) {
    throw new Error("invalid_probe_input");
  }

  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    let framesRetained = 0;
    let openedAt: string | null = null;
    let sessionFrameAt: string | null = null;
    let sessionStartedMs: number | null = null;
    let socket: ProbeSocket | null = null;
    let finished = false;
    let sessionFrameSeen = false;
    let framesReceived = 0;
    let reportBytes = 0;
    let openedMs: number | null = null;
    let lastPongAt: number | null = null;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const authTimer = setTimeout(() => finish("auth_timeout"), AUTH_TIMEOUT_MS);
    let deadlineTimer = input.durationFrom === "start"
      ? armDeadline(performance.now() + input.durationMs) : undefined;

    function armDeadline(at: number): ReturnType<typeof setTimeout> {
      return setTimeout(() => {
        // Timer precision must not turn 6h minus a fraction of a millisecond
        // into a failed observation, or count it as a full six hours.
        if (performance.now() < at) deadlineTimer = armDeadline(at);
        else finish("deadline");
      }, Math.max(1, at - performance.now()));
    }

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
        framesRetained, openedAt, sessionFrameAt,
        sessionObservedMs: sessionStartedMs === null ? 0 : performance.now() - sessionStartedMs,
      });
    }

    function abort() { finish("aborted"); }

    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) { finish("aborted"); return; }
    try { socket = input.connect(); }
    catch { finish("connect_error"); return; }

    socket.addEventListener("open", () => {
      if (finished) return;
      openedAt = new Date().toISOString();
      openedMs = performance.now();
      lastPongAt = openedMs;
      try {
        socket!.send(JSON.stringify({
          t: 1, d: JSON.stringify({ token: input.token, v: 3 }),
        }));
      } catch { finish("transport_error"); return; }
      pingTimer = setInterval(() => {
        if (finished) return;
        if (performance.now() - (lastPongAt ?? openedMs!) > PONG_TIMEOUT_MS) {
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
      if (framesRetained >= input.maxRecords || reportBytes + bytes > input.maxReportBytes) {
        finish("report_limit");
        return;
      }
      try { input.retain(receipt); }
      catch { finish("output_error"); return; }
      framesRetained++;
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
      if (openedMs !== null && !sessionFrameSeen && diagnostic.nodes[0]?.kind === "session_verified_frame") {
        sessionFrameSeen = true;
        sessionFrameAt = receipt.receivedAt;
        sessionStartedMs = performance.now();
        clearTimeout(authTimer);
        if (input.durationFrom === "session_frame") {
          deadlineTimer = armDeadline(sessionStartedMs + input.durationMs);
        }
      }
      if (diagnostic.nodes[0]?.kind === "pong") lastPongAt = performance.now();
    });
    socket.addEventListener("error", () => finish("transport_error"));
    socket.addEventListener("close", (event) => {
      const code: unknown = (event as Event & { code?: unknown }).code;
      finish("closed", typeof code === "number" && Number.isInteger(code) ? code : null);
    });
  });
}

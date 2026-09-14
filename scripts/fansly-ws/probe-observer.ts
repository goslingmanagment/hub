import { observeFanslyConnection, type FrameReceipt } from "./connection-observer.ts";

export type { ProbeSocket } from "./connection-observer.ts";
export const MAX_PROBE_DURATION_MS = 120_000;
export type ProbeObservation = Awaited<ReturnType<typeof observeFanslyProbe>>;

/** Preserve the original short-probe contract, including its in-memory limits. */
export function observeFanslyProbe(input: {
  connect: Parameters<typeof observeFanslyConnection>[0]["connect"];
  token: string;
  key: Buffer;
  durationMs: number;
  signal: AbortSignal;
  transportDiagnostics?: NonNullable<Parameters<typeof observeFanslyConnection>[0]["transportDiagnostics"]>;
}) {
  if (!Number.isInteger(input.durationMs) || input.durationMs < 1
    || input.durationMs > MAX_PROBE_DURATION_MS || input.key.length !== 32
    || !input.token.trim()) {
    throw new Error("invalid_probe_input");
  }
  const records: FrameReceipt[] = [];
  return observeFanslyConnection({
    ...input, durationFrom: "start", maxRecords: 1_000,
    maxReportBytes: 8 * 1024 * 1024, retain: (receipt) => records.push(receipt),
  }).then((result) => {
    const { startedAt, finishedAt, stopReason, sessionFrameSeen, closeCode,
      framesReceived, framesRetained, openedAt, failurePhase, transportErrorCode, httpStatus } = result;
    return { startedAt, finishedAt, stopReason, sessionFrameSeen, closeCode,
      framesReceived, framesRetained, openedAt, failurePhase, transportErrorCode, httpStatus, records };
  });
}

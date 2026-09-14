import { randomUUID } from "node:crypto";

import { observeFanslyConnection, MAX_CONNECTION_DURATION_MS, type ProbeSocket } from "./connection-observer.ts";
import { correlationKeyFingerprint } from "./correlation-key.ts";
import { createContinuityReceipts } from "./continuity-receipts.ts";
import { checkProbeGeneration, watchProbeGeneration } from "./generation-watch.ts";

export const CONTINUITY_PHASES = {
  continuous: { durationMs: MAX_CONNECTION_DURATION_MS, records: 18_000, bytes: 56 * 1024 * 1024 },
  after_short_gap: { durationMs: 120_000, records: 1_000, bytes: 4 * 1024 * 1024 },
  after_long_gap: { durationMs: 120_000, records: 1_000, bytes: 4 * 1024 * 1024 },
} as const;
export type ContinuityPhase = keyof typeof CONTINUITY_PHASES;

export function parseContinuityArgs(args: string[]) {
  if (![8, 10].includes(args.length) || args[0] !== "--page" || args[1] !== "lilly-1"
    || args[2] !== "--phase" || !Object.hasOwn(CONTINUITY_PHASES, args[3] ?? "")
    || args[4] !== "--correlation-key-file" || !args[5] || args[5].startsWith("-")
    || /[\r\n\0]/.test(args[5]) || args[6] !== "--binding-receipt-file"
    || !args[7] || args[7].startsWith("-") || /[\r\n\0]/.test(args[7])) {
    throw new Error("invalid_continuity_arguments");
  }
  const phase = args[3] as ContinuityPhase;
  const expectedGeneration = args[9];
  if ((phase !== "continuous" && args.length !== 10)
    || (args.length === 10 && (args[8] !== "--expected-generation" || !/^[a-f0-9]{64}$/.test(expectedGeneration ?? "")))) {
    throw new Error("invalid_continuity_generation");
  }
  return { pageLabel: "lilly-1" as const, phase, correlationKeyFile: args[5],
    bindingReceiptFile: args[7], expectedGeneration };
}

/** One connection only. The host owns planned gaps and confirms container removal.
 * t=1 starts the duration clock; it remains a frame marker, not verified binding. */
export async function observeFanslyContinuity(input: {
  phase: ContinuityPhase;
  generation: string;
  expectedGeneration?: string | undefined;
  token: string;
  key: Buffer;
  connect: () => ProbeSocket;
  transportDiagnostics?: NonNullable<Parameters<typeof observeFanslyConnection>[0]["transportDiagnostics"]>;
  readGeneration: () => Promise<string>;
  controller: AbortController;
  writeLine: (line: string) => void;
  bindingPreflight?: { receiptSha256: string; credentialRouteGeneration: string; verifiedAt: string };
}) {
  const limits = CONTINUITY_PHASES[input.phase];
  const output = createContinuityReceipts(input.writeLine, limits);
  const connectionId = randomUUID();
  output.write({
    kind: "started", schemaVersion: 1, evidenceKind: "w0_continuity_observation",
    pageLabel: "lilly-1", phase: input.phase, connectionId,
    credentialRouteGeneration: input.generation,
    ...(input.bindingPreflight === undefined ? {} : { bindingPreflight: input.bindingPreflight }),
    correlationKeyFingerprint: correlationKeyFingerprint(input.key),
    accountBinding: "unverified", presence: "unverified", fanOut: "unverified",
    recovery: "external_evidence_required", readerLatencyMeasured: false, restRequests: 0,
  });
  if (input.expectedGeneration !== undefined && input.generation !== input.expectedGeneration) {
    output.write({ kind: "finished", collectionCompleted: false, reason: "generation_changed_before_connect" }, true);
    return false;
  }

  const stopWatching = watchProbeGeneration({
    read: input.readGeneration, expected: input.generation, controller: input.controller,
    retain: (receipt) => output.write(receipt),
  });
  try {
    const observation = await observeFanslyConnection({
      ...input, durationMs: limits.durationMs, durationFrom: "session_frame",
      maxRecords: limits.records, maxReportBytes: limits.bytes,
      retain: (receipt) => output.write({ kind: "frame", connectionId, ...receipt }),
      signal: input.controller.signal,
    });
    await stopWatching();
    const finalGeneration = input.controller.signal.aborted ? null
      : await checkProbeGeneration(input.readGeneration, input.generation);
    const collectionCompleted = observation.stopReason === "deadline" && observation.sessionFrameSeen
      && observation.sessionObservedMs >= limits.durationMs && finalGeneration?.state === "unchanged"
      && !input.controller.signal.aborted;
    output.write({ kind: "finished", collectionCompleted, observation, finalGeneration }, true);
    return collectionCompleted;
  } finally { await stopWatching(); }
}

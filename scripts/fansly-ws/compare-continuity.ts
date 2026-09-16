import { createHash } from "node:crypto";
import { CONTINUITY_PHASES, type ContinuityPhase } from "./continuity.ts";
import { observationWindow, timestamp } from "./compare-records.ts";
import { compareDiagnosticReports } from "./compare.ts";
import { record } from "./diagnostic-fields.ts";
import { readPrivateLines } from "./private-lines.ts";

const MAX_WINDOW_RECORDS = 10_000;
const MAX_WINDOW_BYTES = 32 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function identity(input: unknown) {
  const first = record(input);
  if (first?.kind !== "started" || first.schemaVersion !== 1
    || first.evidenceKind !== "w0_continuity_observation" || first.pageLabel !== "lilly-1"
    || typeof first.phase !== "string" || !Object.hasOwn(CONTINUITY_PHASES, first.phase)
    || typeof first.connectionId !== "string" || !UUID.test(first.connectionId)
    || typeof first.credentialRouteGeneration !== "string" || !HEX.test(first.credentialRouteGeneration)
    || typeof first.correlationKeyFingerprint !== "string" || !HEX.test(first.correlationKeyFingerprint)) {
    throw new Error("invalid_continuity_identity");
  }
  return {
    phase: first.phase as ContinuityPhase, connectionId: first.connectionId,
    credentialRouteGeneration: first.credentialRouteGeneration,
    correlationKeyFingerprint: first.correlationKeyFingerprint,
  };
}

/** Validate the whole phase; retain only a bounded declared comparison window.
 * This reads metadata only and never connects, decrypts credentials or accepts W0. */
export async function compareContinuityObservation(browser: unknown, path: string, windows: unknown) {
  const supplied = record(windows);
  const browserWindow = observationWindow(supplied?.left);
  const receiverWindow = observationWindow(supplied?.right);
  const from = Math.max(timestamp(browserWindow.from), timestamp(receiverWindow.from));
  const to = Math.min(timestamp(browserWindow.to), timestamp(receiverWindow.to));
  if (from >= to) throw new Error("observation_windows_do_not_overlap");
  const hash = createHash("sha256");
  let start: ReturnType<typeof identity> | null = null;
  let terminal: Record<string, unknown> | null = null;
  let records = 0;
  let bytes = 0;
  let frames = 0;
  let generationChecks = 0;
  let elapsed = -1;
  let windowBytes = 0;
  const selected: unknown[] = [];

  for await (const line of readPrivateLines(path, CONTINUITY_PHASES.continuous.bytes, 1024 * 1024)) {
    const item = record(JSON.parse(line.toString("utf8")) as unknown);
    records++;
    bytes += line.length;
    hash.update(line);
    if (!item || terminal || item.ordinal !== records || typeof item.elapsedMs !== "number"
      || !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0 || item.elapsedMs < elapsed) {
      throw new Error("invalid_continuity_sequence");
    }
    timestamp(item.recordedAt);
    elapsed = item.elapsedMs;
    if (records === 1) start = identity(item);
    if (!start) throw new Error("missing_continuity_identity");
    const limits = CONTINUITY_PHASES[start.phase];
    if (records > limits.records || bytes > limits.bytes) throw new Error("continuity_output_limit");
    if (records === 1) continue;
    if (item.kind === "frame") {
      if (item.connectionId !== start.connectionId) throw new Error("mixed_continuity_connections");
      const receivedAt = timestamp(item.receivedAt);
      frames++;
      if (receivedAt >= from && receivedAt < to) {
        windowBytes += line.length;
        if (selected.length >= MAX_WINDOW_RECORDS || windowBytes > MAX_WINDOW_BYTES) {
          throw new Error("comparison_window_limit");
        }
        selected.push({ receivedAt: item.receivedAt, diagnostic: item.diagnostic });
      }
    } else if (item.kind === "generation_check") {
      if (item.state !== "unchanged") throw new Error("generation_not_confirmed");
      timestamp(item.startedAt);
      timestamp(item.finishedAt);
      generationChecks++;
    } else if (item.kind === "finished") terminal = item;
    else throw new Error("unknown_continuity_record");
  }

  const observation = record(terminal?.observation);
  if (!start || !observation || terminal?.collectionCompleted !== true
    || observation.stopReason !== "deadline" || observation.sessionFrameSeen !== true
    || typeof observation.sessionObservedMs !== "number" || !Number.isFinite(observation.sessionObservedMs)
    || observation.sessionObservedMs < CONTINUITY_PHASES[start.phase].durationMs
    || observation.sessionObservedMs > elapsed
    || observation.framesReceived !== frames || observation.framesRetained !== frames
    || record(terminal.finalGeneration)?.state !== "unchanged") {
    throw new Error("incomplete_continuity_observation");
  }
  const actualWindow = observationWindow({ from: observation.startedAt, to: observation.finishedAt });
  const finalGeneration = record(terminal.finalGeneration)!;
  timestamp(finalGeneration.startedAt);
  timestamp(finalGeneration.finishedAt);
  if (timestamp(receiverWindow.from) < timestamp(actualWindow.from)
    || timestamp(receiverWindow.to) > timestamp(actualWindow.to)) {
    throw new Error("window_outside_continuity_observation");
  }
  // Reuse the reference comparison only; preserve the native long-stream kind
  // and validation result separately instead of claiming this was a short probe.
  const comparison = compareDiagnosticReports(browser, {
    schemaVersion: 1, evidenceKind: "offline_diagnostic",
    correlationKeyFingerprint: start.correlationKeyFingerprint, records: selected,
  }, { left: browserWindow, right: receiverWindow });
  return {
    ...comparison,
    rightEvidence: {
      evidenceKind: "w0_continuity_observation", ...start,
      sha256: hash.digest("hex"), bytes, records, frames, generationChecks,
      selectedFrames: selected.length, framesOutsideComparisonWindow: frames - selected.length,
      observationWindow: actualWindow, collectionReceiptValidated: true,
      sessionObservedMs: observation.sessionObservedMs,
      hostOutputSync: "unverified", cleanup: "unverified", plannedGaps: "unverified",
      clockAlignment: "unverified",
    },
  };
}

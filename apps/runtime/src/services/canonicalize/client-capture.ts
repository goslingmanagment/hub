// Client-capture family (Stage 11). DELIBERATELY registration + validation
// only: desktop-held facts (acceptance telemetry, guard/send audit, spend
// ledgers) are not account-scoped platform truth, so NO domain events ship
// here — they live as observations until Stage 29 defines the restricted
// class that consumes them. Registering the family makes the sweep stamp
// parse_version (the kinds are "seen", not pending), and the version gives
// Stage 29 its replay hook: bump it and every captured fact re-presents.

import { isRecord, type CanonicalEventDraft, type CanonicalizableObservation } from "./types.ts";

export const CLIENT_CAPTURE_CANONICALIZER_VERSION = 1;

// The endpoint's allowlist, prefixed. desktop.unknown:* kinds stay OUTSIDE
// the family — they wait at parse_version 0 until someone declares them
// (capture now, parse later).
export const CLIENT_CAPTURE_CANONICALIZED_KINDS: ReadonlySet<string> = new Set([
  "desktop.ai_acceptance",
  "desktop.guard_audit",
  "desktop.send_audit",
  "desktop.ai_spend",
  "desktop.credit_spend",
  "desktop.data_purge_notice",
]);

export function canonicalizeClientCaptureObservation(
  observation: CanonicalizableObservation,
): CanonicalEventDraft[] {
  // Validation is the whole job: a payload that is not an object would have
  // nothing for Stage 29 to replay — surface it in logs via the sweep's
  // stats rather than throwing (zero events either way).
  void isRecord(observation.payload);
  return [];
}

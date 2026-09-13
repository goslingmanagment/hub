import { collectReferences, observationWindow, timestamp } from "./compare-records.ts";
import { record } from "./diagnostic-fields.ts";

/** Compare a declared overlap only; capture completeness and receiver
 * independence require external evidence and are never inferred here. */
export function compareDiagnosticReports(left: unknown, right: unknown, windows: unknown) {
  const supplied = record(windows);
  const leftWindow = observationWindow(supplied?.left);
  const rightWindow = observationWindow(supplied?.right);
  const window = {
    from: new Date(Math.max(timestamp(leftWindow.from), timestamp(rightWindow.from))).toISOString(),
    to: new Date(Math.min(timestamp(leftWindow.to), timestamp(rightWindow.to))).toISOString(),
  };
  if (timestamp(window.from) >= timestamp(window.to)) throw new Error("observation_windows_do_not_overlap");
  const a = collectReferences(left, window, leftWindow);
  const b = collectReferences(right, window, rightWindow);
  if (a.fingerprint !== b.fingerprint) throw new Error("different_correlation_keys");

  const matches = [];
  let leftOnlyReferences = 0;
  let rightOnlyReferences = 0;
  for (const [key, reference] of a.references) {
    const other = b.references.get(key);
    if (!other) { leftOnlyReferences++; continue; }
    matches.push({
      serviceId: reference.serviceId, eventType: reference.eventType,
      field: reference.field, pseudonym: reference.pseudonym,
      leftOccurrences: reference.count, rightOccurrences: other.count,
      ambiguousOccurrences: reference.count > 1 || other.count > 1,
    });
  }
  for (const key of b.references.keys()) if (!a.references.has(key)) rightOnlyReferences++;
  const hasIncompleteInput = [a.counts, b.counts].some((counts) =>
    counts.interrupted || counts.missingReceipts + counts.excluded + counts.invalid
      + counts.partial + counts.unknownNodes + counts.unmatchableServices > 0);
  return {
    schemaVersion: 1,
    evidenceKind: "received_reference_comparison",
    correlationKeyFingerprint: a.fingerprint,
    comparisonWindow: window,
    windowSource: "operator_supplied",
    comparisonState: matches.length > 0 ? "candidate_entity_correspondence" : "inconclusive",
    incompleteInput: hasIncompleteInput,
    captureCompleteness: "unverified",
    receiverIndependence: "unverified",
    sameSession: "unverified",
    eventIdentity: "unverified",
    payloadEquality: "unverified",
    accountBinding: "unverified",
    fanOut: "unverified",
    readerLatencyMeasured: false,
    left: a.counts,
    right: b.counts,
    matchingReferences: matches.length,
    ambiguousReferences: matches.filter((match) => match.ambiguousOccurrences).length,
    leftOnlyReferences,
    rightOnlyReferences,
    matches,
  };
}

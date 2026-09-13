import { code, record } from "./diagnostic-fields.ts";

const REFERENCE_FIELDS = new Set([
  "message.id", "messageAckEvent.messageId", "like.messageId",
  "transaction.id", "notification.id", "post.id",
]);
const MAX_RECORDS = 10_000;
const MAX_REFERENCES = 20_000;

export type ObservationWindow = { from: string; to: string };
export type ReferenceOccurrence = {
  serviceId: number;
  eventType: number;
  field: string;
  pseudonym: string;
  count: number;
};

export function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("invalid_comparison_time");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("invalid_comparison_time");
  }
  return parsed;
}

export function observationWindow(value: unknown): ObservationWindow {
  const input = record(value);
  if (!input || timestamp(input.from) >= timestamp(input.to)) {
    throw new Error("invalid_observation_window");
  }
  return { from: input.from as string, to: input.to as string };
}

/** References identify entities, not event occurrences or payload versions. */
export function collectReferences(value: unknown, window: ObservationWindow, ownWindow: ObservationWindow) {
  const report = record(value);
  const fingerprint = report?.correlationKeyFingerprint;
  if (report?.schemaVersion !== 1 || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("incompatible_diagnostic_report");
  }
  let records: unknown;
  let missingReceipts = 0;
  let interrupted = false;
  if (report.evidenceKind === "offline_diagnostic") records = report.records;
  else if (report.evidenceKind === "live_socket_probe") {
    const observation = record(report.observation);
    if (!observation || timestamp(ownWindow.from) < timestamp(observation.startedAt)
      || timestamp(ownWindow.to) > timestamp(observation.finishedAt)) {
      throw new Error("window_outside_probe_observation");
    }
    records = observation.records;
    const received = observation.framesReceived;
    const retained = observation.framesRetained;
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(retained)
      || (retained as number) < 0 || (received as number) < (retained as number)
      || !Array.isArray(records) || retained !== records.length) {
      throw new Error("inconsistent_probe_receipts");
    }
    missingReceipts = (received as number) - (retained as number);
    interrupted = observation.stopReason !== "deadline";
  } else throw new Error("incompatible_diagnostic_report");
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error("comparison_record_limit");

  const references = new Map<string, ReferenceOccurrence>();
  const counts = {
    records: records.length, missingReceipts, interrupted,
    inWindow: 0, outsideWindow: 0, excluded: 0,
    invalid: 0, partial: 0, unknownNodes: 0, unmatchableServices: 0, referenceOccurrences: 0,
  };
  const from = timestamp(window.from);
  const to = timestamp(window.to);
  for (const input of records) {
    const receipt = record(input);
    if (!receipt) { counts.invalid++; continue; }
    if (Object.hasOwn(receipt, "excluded")) { counts.excluded++; continue; }
    let receivedAt: number;
    try { receivedAt = timestamp(receipt.receivedAt); }
    catch { counts.invalid++; continue; }
    if (receivedAt < from || receivedAt >= to) { counts.outsideWindow++; continue; }
    counts.inWindow++;
    const diagnostic = record(receipt.diagnostic);
    if (!diagnostic || !Array.isArray(diagnostic.nodes)) { counts.invalid++; continue; }
    if (diagnostic.nodes.length > 256) throw new Error("comparison_node_limit");
    if (diagnostic.truncated !== false || diagnostic.rejected !== null) { counts.partial++; continue; }
    for (const inputNode of diagnostic.nodes) {
      const node = record(inputNode);
      if (!node || Object.hasOwn(node, "reason")) { counts.unknownNodes++; continue; }
      if (node.kind === "session_verified_frame" || node.kind === "pong" || node.kind === "batch") continue;
      const serviceId = code(node.serviceId);
      const eventType = code(node.eventType);
      if (node.kind !== "service" || serviceId === null || eventType === null) {
        counts.unknownNodes++;
        continue;
      }
      const eventReferences = record(node.event)?.references;
      if (!Array.isArray(eventReferences) || eventReferences.length > 8) {
        counts.invalid++;
        continue;
      }
      let matchable = false;
      const seenInNode = new Set<string>();
      for (const item of eventReferences) {
        const reference = record(item);
        if (typeof reference?.field !== "string" || !REFERENCE_FIELDS.has(reference.field)
          || typeof reference.pseudonym !== "string" || !/^[a-f0-9]{64}$/.test(reference.pseudonym)) continue;
        const key = `${serviceId}:${eventType}:${reference.field}:${reference.pseudonym}`;
        if (seenInNode.has(key)) continue;
        seenInNode.add(key);
        matchable = true;
        if (++counts.referenceOccurrences > MAX_REFERENCES) throw new Error("comparison_reference_limit");
        const previous = references.get(key);
        references.set(key, {
          serviceId, eventType, field: reference.field, pseudonym: reference.pseudonym,
          count: (previous?.count ?? 0) + 1,
        });
      }
      if (!matchable) counts.unmatchableServices++;
    }
  }
  return { fingerprint, counts, references };
}

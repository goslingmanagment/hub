import {
  timestampMicros, type EarningsAuditScope, type EarningsProjection, type ExpectedEarnings,
} from "./earnings-audit-types.ts";

export function projectorCaughtUp(scope: EarningsAuditScope) {
  return scope.projectionHighSeq !== null
    && BigInt(scope.projectionHighSeq) >= BigInt(scope.eventHighSeq);
}

export function compareEarnings(
  scope: EarningsAuditScope, actual: EarningsProjection, expected: ExpectedEarnings | undefined,
): { outcome: string; differences: string[]; legacy: boolean } {
  const legacy = actual.sourceObservationId === "0";
  const result = (outcome: string, differences: string[] = []) => ({ outcome, differences, legacy });
  if (actual.fan === null) return result("identity_unavailable");
  const event = actual.event;
  const observation = actual.observation;
  if (!event || !observation) return result("source_unavailable");
  if (event.id !== actual.sourceEventId || event.fan !== actual.fan
    || event.window !== actual.window || event.observationId !== observation.id
    || (!legacy && actual.sourceObservationId !== event.observationId)
    || event.grossMills === null || !Number.isSafeInteger(event.grossMills)
    || String(event.grossMills) !== actual.grossMills
    || (event.netMills === null ? actual.netMills !== null
      : !Number.isSafeInteger(event.netMills) || String(event.netMills) !== actual.netMills)) {
    return result("source_mismatch");
  }
  const received = timestampMicros(observation.receivedAt);
  if (received < timestampMicros(scope.from) || received >= timestampMicros(scope.to)
    || BigInt(observation.id) > BigInt(scope.upperObservationId)) {
    return result("outside_cohort");
  }
  if (!expected) return result("extra");
  const differences: string[] = [];
  if (actual.grossMills !== expected.grossMills) differences.push("grossMills");
  if (actual.netMills !== expected.netMills) differences.push("netMills");
  if (actual.currency !== "USD") differences.push("currency");
  if (timestampMicros(actual.observedAt) !== timestampMicros(expected.observedAt)) {
    differences.push("observedAt");
  }
  if (event.observationId !== expected.observationId) differences.push("sourceObservationId");
  if (differences.length === 0) return result("matched");
  return result(projectorCaughtUp(scope) ? "mismatch" : "projection_pending", differences);
}

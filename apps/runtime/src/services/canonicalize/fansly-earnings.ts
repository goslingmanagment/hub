import { createHash } from "node:crypto";

import {
  asNumber,
  asString,
  isRecord,
  type CanonicalEventDraft,
  type CanonicalizableObservation,
  type CanonicalParseResult,
} from "./types.ts";

// These kinds previously belonged to sync-pull v6. Only their parse debt rises.
export const FANSLY_EARNINGS_CANONICALIZER_VERSION = 7;
export const FANSLY_EARNINGS_KINDS = new Set([
  "fan_earnings_stats",
  "fan_earnings_monthly",
]);

interface EarningsAggregate {
  grossMills: number;
  netMills: number;
  breakdown: Array<{ type: number | null; grossMills: number; netMills: number }>;
}

/** Both earnings kinds: rows aggregate per (fan, window); window = 'lifetime'
 *  for the stats snapshot, 'YYYY-MM' for monthly rows. Amounts are MILLS. */
export function parseFanslyEarningsObservation(
  observation: CanonicalizableObservation,
): CanonicalParseResult {
  if (observation.platform !== "fansly" || !FANSLY_EARNINGS_KINDS.has(observation.kind)) {
    return { events: [], rejection: { code: "unsupported_earnings_shape" } };
  }
  const monthly = observation.kind === "fan_earnings_monthly";
  const rows = Array.isArray(observation.payload) ? observation.payload : null;
  if (!rows) {
    return { events: [], rejection: { code: "unsupported_earnings_shape" } };
  }

  const perKey = new Map<string, { fan: string; window: string; aggregate: EarningsAggregate }>();
  const poisonedKeys = new Set<string>();
  let rejection: { code: string } | null = null;
  for (const row of rows) {
    if (!isRecord(row)) {
      rejection ??= { code: "invalid_earnings_row" };
      continue;
    }
    const fan = asString(row.correlationAccountId);
    if (!fan) {
      rejection ??= { code: "missing_earnings_fan" };
      continue;
    }
    let window = "lifetime";
    if (monthly) {
      const year = asNumber(row.year);
      const month = asNumber(row.month);
      if (
        year === null ||
        month === null ||
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        year < 2000 ||
        year > 2200 ||
        month < 1 ||
        month > 12
      ) {
        rejection ??= { code: "invalid_earnings_window" };
        continue;
      }
      window = `${year}-${String(month).padStart(2, "0")}`;
    }
    // A missing amount is provider-contract drift, not a real zero. The raw
    // observation remains durable for replay after a parser repair, but it
    // must not mint a plausible-looking zero snapshot into the money plane.
    const gross = asNumber(row.totalGross);
    const net = asNumber(row.totalNet);
    const key = `${fan}:${window}`;
    if (poisonedKeys.has(key)) {
      continue;
    }
    if (
      gross === null ||
      net === null ||
      !Number.isSafeInteger(gross) ||
      !Number.isSafeInteger(net)
    ) {
      // One malformed breakdown row invalidates the whole fan/window. Keeping
      // the other rows would mint a plausible but understated money snapshot.
      rejection ??= { code: "invalid_earnings_money" };
      poisonedKeys.add(key);
      continue;
    }
    const entry = perKey.get(key) ?? {
      fan,
      window,
      aggregate: { grossMills: 0, netMills: 0, breakdown: [] },
    };
    const nextGrossMills = entry.aggregate.grossMills + gross;
    const nextNetMills = entry.aggregate.netMills + net;
    if (
      !Number.isSafeInteger(nextGrossMills) ||
      !Number.isSafeInteger(nextNetMills)
    ) {
      rejection ??= { code: "invalid_earnings_money" };
      poisonedKeys.add(key);
      continue;
    }
    entry.aggregate.grossMills = nextGrossMills;
    entry.aggregate.netMills = nextNetMills;
    entry.aggregate.breakdown.push({
      type: asNumber(row.type),
      grossMills: gross,
      netMills: net,
    });
    perKey.set(key, entry);
  }

  const events: CanonicalEventDraft[] = [];
  for (const [key, { fan, window, aggregate }] of perKey) {
    if (poisonedKeys.has(key)) {
      continue;
    }
    aggregate.breakdown.sort((left, right) =>
      (left.type ?? -1) - (right.type ?? -1)
      || left.grossMills - right.grossMills
      || left.netMills - right.netMills);
    const contentFingerprint = createHash("sha256")
      .update(JSON.stringify(aggregate)).digest("hex");
    events.push({
      type: "fan.earnings_observed",
      occurredAt: observation.observedAt ?? observation.receivedAt,
      fanIdentityRef: fan,
      data: {
        window,
        grossMills: aggregate.grossMills,
        netMills: aggregate.netMills,
        breakdown: aggregate.breakdown,
        contentFingerprint,
      },
      schemaVersion: 2,
      // A later observation of identical content must apply again (A → B → A).
      // Retrying this observation still claims exactly the same event key.
      dedupKey: `fan_earnings:v2:${observation.id}:${fan}:${window}`,
    });
  }
  return { events, rejection };
}

export function canonicalizeFanslyEarningsObservation(observation: CanonicalizableObservation) {
  return parseFanslyEarningsObservation(observation).events;
}

export function canParseFanslyEarningsObservation(observation: CanonicalizableObservation) {
  return parseFanslyEarningsObservation(observation).rejection === null;
}

export function diagnoseFanslyEarningsRejection(observation: CanonicalizableObservation) {
  return parseFanslyEarningsObservation(observation).rejection;
}

// Kernel Stage 27 (Q6 / Proposal 1): the single money codec. Platform money
// is MILLS (bigint, 1/1000 USD — decision #15, Fansly-native); AI cost is
// MICRO-USD (integer column, JS number). The 1000× footgun class dies by
// construction: every constructor names its SOURCE unit, there is no
// bare-number path, and the two units never mix without an explicit,
// direction-honest converter. Brands are compile-time only — zero runtime
// or stored-value change.

/** Platform money: thousandths of a USD. */
export type Mills = bigint & { readonly __unit?: "mills" };
/** AI-plane money: millionths of a USD (integer column, number in JS). */
export type MicroUsd = number & { readonly __unit?: "microUsd" };

/** DB drivers hand mills back as bigint, number, or numeric-string. */
export type MillsLike = bigint | number | string;

const COMMISSION_RATE_SCALE = 10_000n;

// ─── Source-named constructors (no bare-number path) ─────────────────────

/**
 * A value that is ALREADY mills — a DB column read (bigint / numeric-string)
 * or a mills-native platform integer (Fansly amounts are mills on the wire).
 * Numbers are truncated, strings parsed as integers — byte-identical to the
 * deleted `toMills`. (The spec sketched `millsFromDbBigint(bigint)`; pg
 * returns numeric columns as strings and adapters hand numbers, so ONE
 * honest already-mills constructor beats three near-duplicates.)
 */
export function millsFromInteger(value: MillsLike): Mills {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }
  return BigInt(value);
}

/**
 * Dollars (number or decimal string) → mills. Inherits `dollarsToMills`'s
 * parsing semantics byte-for-byte (fixed 3-place truncation of the fraction).
 */
export function millsFromDollars(value: number | string): Mills {
  const normalized = typeof value === "number"
    ? value.toFixed(3)
    : value.trim();

  const match = normalized.match(/^(-)?(\d+)(?:\.(\d+))?$/);
  if (!match) {
    throw new Error(`Invalid dollar amount "${value}"`);
  }

  const sign = match[1] ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);

  return sign * ((whole * 1000n) + BigInt(fraction));
}

/** Whole cents → mills (the `total_tip_amount_cents` bridge: ×10 exactly). */
export function millsFromCents(value: number | bigint): Mills {
  const cents = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  return cents * 10n;
}

/** Dollars → micro-USD (AI plane). Rounded to the nearest integer micro-USD. */
export function microUsdFromDollars(value: number): MicroUsd {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid dollar amount "${value}"`);
  }
  return Math.round(value * 1_000_000) as MicroUsd;
}

/** An integer micro-USD value as stored (int column, number in JS). */
export function microUsdFromDbInt(value: number): MicroUsd {
  return Math.trunc(value) as MicroUsd;
}

// ─── Unit converters (the ONLY sanctioned mixing points) ─────────────────

/** Mills → micro-USD. Exact (×1000). */
export function millsToMicroUsd(value: Mills): MicroUsd {
  return Number(millsFromInteger(value) * 1000n) as MicroUsd;
}

/** Micro-USD → mills. LOSSY (truncates toward zero below the mill). */
export function microUsdToMills(value: MicroUsd): Mills {
  return BigInt(Math.trunc(value / 1000));
}

/**
 * Micro-USD → a display string for the AI plane (Decision 349: the chatter's
 * own spend in `/account`). The AI ledger's unit is micro-USD, so the cabinet
 * must not divide by 1_000_000 by hand — it asks here, exactly as the platform
 * plane asks `formatUsdFromMills`. Sub-cent amounts round DOWN to `< $0.01`
 * rather than to `$0.00`, so a person who spent something never reads zero;
 * `approximate` prefixes the house `~` used by the owner's usage report.
 */
export function formatUsdFromMicroUsd(
  value: number,
  options: { approximate?: boolean } = {},
): string {
  const micro = microUsdFromDbInt(value);
  const prefix = options.approximate ? "~" : "";
  if (micro <= 0) return "$0";
  if (micro < 10_000) return `${prefix}< $0.01`;
  return prefix + new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(micro / 1_000_000);
}

// ─── Display / aggregation over mills (names preserved) ──────────────────

export function millsToDecimalString(value: MillsLike): string {
  const mills = millsFromInteger(value);
  const sign = mills < 0n ? "-" : "";
  const absolute = mills < 0n ? -mills : mills;
  const whole = absolute / 1000n;
  const remainder = absolute % 1000n;

  return `${sign}${whole}.${remainder.toString().padStart(3, "0")}`;
}

export function formatUsdFromMills(value: MillsLike): string {
  const mills = millsFromInteger(value);
  const cents = Number(mills / 10n) / 100;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents);
}

export function millsToNumber(value: MillsLike): number {
  return Number(millsFromInteger(value));
}

/** Mills → float dollars (wire fields that carry dollars, e.g. snapshot prices). */
export function millsToDollarsNumber(value: MillsLike): number {
  return Number(millsFromInteger(value)) / 1000;
}

/** Mills → whole dollars, rounded (telegram digest lines). */
export function millsToRoundedDollars(value: MillsLike): number {
  return Math.round(Number(millsFromInteger(value)) / 1000);
}

export function sumMills(values: Iterable<MillsLike>): Mills {
  let total = 0n;
  for (const value of values) {
    total += millsFromInteger(value);
  }
  return total;
}

/**
 * Legacy name for the dollars constructor — same function, kept because the
 * name is honest (its ~80 call sites predate the codec). New code should
 * prefer `millsFromDollars`.
 */
export const dollarsToMills = millsFromDollars;

// ─── Commission math (typed over mills) ───────────────────────────────────

function commissionRateToScaledInt(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid commission rate "${value}"`);
  }

  const normalized = value.toFixed(4);
  const match = normalized.match(/^(\d+)\.(\d{4})$/);
  if (!match) {
    throw new Error(`Invalid commission rate "${value}"`);
  }

  return (BigInt(match[1] ?? "0") * COMMISSION_RATE_SCALE) + BigInt(match[2] ?? "0");
}

function roundDiv(value: bigint, divisor: bigint) {
  if (value === 0n) {
    return 0n;
  }

  const sign = value < 0n ? -1n : 1n;
  const absolute = value < 0n ? -value : value;
  return sign * ((absolute + (divisor / 2n)) / divisor);
}

export function calculateNetMillsFromGross(
  grossMills: MillsLike,
  commissionRate: number,
): Mills {
  const gross = millsFromInteger(grossMills);
  const commissionRateScaled = commissionRateToScaledInt(commissionRate);
  if (commissionRateScaled === 0n) {
    return gross;
  }

  // OnlyFans rounds the platform fee to whole cents before subtracting it.
  const commissionFeeCents = roundDiv(gross * commissionRateScaled, COMMISSION_RATE_SCALE * 10n);
  return gross - (commissionFeeCents * 10n);
}

export function calculateGrossMillsFromNet(
  netMills: MillsLike,
  commissionRate: number,
): Mills {
  const net = millsFromInteger(netMills);
  const commissionRateScaled = commissionRateToScaledInt(commissionRate);
  if (commissionRateScaled === 0n) {
    return net;
  }

  const creatorShareScaled = COMMISSION_RATE_SCALE - commissionRateScaled;
  if (creatorShareScaled <= 0n) {
    throw new Error(`Invalid commission rate "${commissionRate}"`);
  }

  return roundDiv(net * COMMISSION_RATE_SCALE, creatorShareScaled);
}

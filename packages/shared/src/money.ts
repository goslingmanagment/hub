export type MoneyLike = bigint | number | string;
const COMMISSION_RATE_SCALE = 10_000n;

export function toMills(value: MoneyLike): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  return BigInt(value);
}

export function millsToDecimalString(value: MoneyLike): string {
  const mills = toMills(value);
  const sign = mills < 0n ? "-" : "";
  const absolute = mills < 0n ? -mills : mills;
  const whole = absolute / 1000n;
  const remainder = absolute % 1000n;

  return `${sign}${whole}.${remainder.toString().padStart(3, "0")}`;
}

export function formatUsdFromMills(value: MoneyLike): string {
  const mills = toMills(value);
  const centsRounded = Number((mills + (mills >= 0n ? 5n : -5n)) / 10n) / 100;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(centsRounded);
}

export function millsToNumber(value: MoneyLike): number {
  return Number(toMills(value));
}

export function sumMills(values: Iterable<MoneyLike>): bigint {
  let total = 0n;
  for (const value of values) {
    total += toMills(value);
  }
  return total;
}

export function dollarsToMills(value: number | string): bigint {
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
  grossMills: MoneyLike,
  commissionRate: number,
) {
  const gross = toMills(grossMills);
  const commissionRateScaled = commissionRateToScaledInt(commissionRate);
  const retainedRateScaled = COMMISSION_RATE_SCALE - commissionRateScaled;

  return roundDiv(gross * retainedRateScaled, COMMISSION_RATE_SCALE);
}

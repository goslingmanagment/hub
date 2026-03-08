export type MoneyLike = bigint | number | string;

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

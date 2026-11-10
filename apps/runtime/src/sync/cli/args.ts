import { InvalidArgumentError } from "commander";

// Argument parsers and the JSON printer the `sync` sub-command files share.
// `../cli.ts` and `public-lookup.ts` keep their own `json`: the first prints
// an indefinite date as "infinity", the second has no bigint replacer.

/** Pretty JSON with every bigint as its decimal string. */
export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

export function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

export function nonNegativeInt(value: string): number {
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`expected a non-negative integer, got "${value}"`);
  }
  return parsed;
}

export function isoDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new InvalidArgumentError(`expected an ISO date, got "${value}"`);
  return parsed;
}

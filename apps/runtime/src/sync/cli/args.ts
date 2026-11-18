import { hostname } from "node:os";

import { InvalidArgumentError } from "commander";

// Argument parsers, the JSON printer, the CLI's audit actor and the context
// opener the `sync` command files share. `../cli.ts` and `public-lookup.ts`
// keep their own `json`: the first prints an indefinite date as "infinity",
// the second has no bigint replacer.

/** The default `--since` of the commands that read the DM chains' journal. */
export const DEFAULT_CHAIN_JOURNAL_SINCE = "2026-07-05T00:00:00Z";

/** Who acts from the CLI, as the audit rows name it. */
export function cliActor(): string {
  return `cli@${hostname()} pid ${process.pid}`;
}

/** Open a sync context, run `body` in it, close it whatever happens. */
export async function withSyncContext<C, T>(
  deps: { openContext(): Promise<C & { close(): Promise<void> }> },
  body: (ctx: C) => Promise<T>,
): Promise<T> {
  const ctx = await deps.openContext();
  try {
    return await body(ctx);
  } finally {
    await ctx.close();
  }
}

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

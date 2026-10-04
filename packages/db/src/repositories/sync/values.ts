import { sql, type SQL } from "drizzle-orm";

// Value plumbing shared by the Fansly Sync Engine repositories (sync_pages,
// sync_work, sync_attempts). Not on the package barrel.

/** The latest instant a JS Date can hold: a timestamptz `'infinity'` (an
 *  auth or identity hold, lifted only by a new credentials generation). */
export const SYNC_INDEFINITE_UNTIL_MS = 8.64e15;

/** node-postgres parses a timestamptz `'infinity'` as the NUMBER Infinity. */
export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (value === Number.POSITIVE_INFINITY || value === "infinity") return new Date(SYNC_INDEFINITE_UNTIL_MS);
  if (value === Number.NEGATIVE_INFINITY || value === "-infinity") return new Date(-SYNC_INDEFINITE_UNTIL_MS);
  return new Date(value);
}

export function toRequiredDate(value: Date | string | number): Date {
  return toDate(value) as Date;
}

export function toNumber(value: number | string | bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function toBigInt(value: number | string | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(value);
}

/** A generation (bigint) as a typed parameter; the driver gets its decimal text. */
export function generationParam(generation: bigint): SQL {
  return sql`${generation.toString()}::bigint`;
}

/** One jsonb parameter, serialized exactly once. */
export function jsonParam(value: unknown): SQL {
  return sql`${JSON.stringify(value ?? null)}::jsonb`;
}

/** A jsonb parameter of a nullable column: null/undefined is SQL NULL, never
 *  the JSON value `null`. */
export function nullableJsonParam(value: unknown): SQL {
  return value === null || value === undefined ? sql`null::jsonb` : jsonParam(value);
}

/** A text[] parameter bound as ONE array value (never expanded to a list). */
export function textArrayParam(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

/** A timestamptz parameter; null stays null. */
export function timestampParam(value: Date | null | undefined): SQL {
  return sql`${value ?? null}::timestamptz`;
}

/** A hold's end as a timestamptz parameter: the JS stand-in of `'infinity'`
 *  (and the word itself) is `'infinity'`; null stays null. */
export function untilParam(value: Date | "infinity" | null | undefined): SQL {
  if (value === null || value === undefined) return sql`null::timestamptz`;
  if (value === "infinity" || value.getTime() >= SYNC_INDEFINITE_UNTIL_MS) return sql`'infinity'::timestamptz`;
  return sql`${value}::timestamptz`;
}

/** `$now` of a pick: the caller's instant, or the database clock. */
export function nowParam(value: Date | null | undefined): SQL {
  return sql`coalesce(${value ?? null}::timestamptz, clock_timestamp())`;
}

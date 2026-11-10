// Readers of served JSON values shared by the Fansly resources, their rules
// and cursors. Look-alikes with another meaning stay in their files under
// their own names (a `text` that keeps "", a `count` that accepts decimal
// strings, a string list that is null for a non-array).

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object, or `{}` for anything else (null, an array, a scalar). */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The object, or null for anything else (null, an array, a scalar). */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A JSON number that is a safe integer ≥ 0; a decimal string is not one. */
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A JSON number that is a safe integer; a decimal string is not one. */
export function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

/** A non-empty string, or null. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The non-empty strings of an array; `[]` for anything else. */
export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** A string `Date.parse` reads, kept as served. */
export function iso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** The UTC day (`YYYY-MM-DD`) of an epoch-ms instant. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

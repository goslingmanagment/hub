// Canonicalizer seam (kernel Stage 8). Every canonicalizer is a PURE function
// observation → CanonicalEventDraft[] — total over its declared kinds: an
// unknown or unparseable payload yields zero events and the observation stays
// at its current parse_version (capture now, parse later, replay).

export interface CanonicalizableObservation {
  id: number;
  source: string;
  producer: string;
  platform: string | null;
  accountId: number | null;
  kind: string;
  payload: unknown;
  observedAt: Date | null;
  receivedAt: Date;
}

export interface CanonicalEventDraft {
  type: string;
  occurredAt: Date;
  /** Platform-native fan id — never fans.id. */
  fanIdentityRef?: string | null;
  conversationRef?: string | null;
  messageRef?: string | null;
  transactionRef?: string | null;
  data: Record<string, unknown>;
  schemaVersion: number;
  dedupKey: string;
}

/** Optional per-run context (page -> native account ref map etc.); families
 *  that don't need it simply ignore the argument. */
export interface CanonicalizeRunContext {
  nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
}

export type Canonicalizer = (
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
) => CanonicalEventDraft[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Provider timestamps are untrusted; unparseable → fallback (receipt time). */
export function asDate(value: unknown, fallback: Date): Date {
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

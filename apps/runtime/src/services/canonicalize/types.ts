// Canonicalizer seam (kernel Stage 8). Every canonicalizer is a PURE function
// observation → CanonicalEventDraft[] — total over its declared kinds: an
// unknown or unparseable payload yields zero events. Whether the driver then
// stamps parse_version is the FAMILY's call, not the function's: a shape gate
// (`canParse`/`parse` rejection) leaves the row unstamped for a future parser;
// anything else is stamped — and a family may name a zero-event row a terminal
// quarantine (`quarantine`), which records why before the stamp. The body stays
// journaled either way (capture now, parse later, replay on a version bump).

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
  postRef?: string | null;
  data: Record<string, unknown>;
  schemaVersion: number;
  dedupKey: string;
}

/** Optional per-run context (page -> native account ref map etc.); families
 *  that don't need it simply ignore the argument. */
export interface CanonicalizeRunContext {
  nativeAccountRefByAccountId: ReadonlyMap<number, string | null>;
  /** Original governed acceptance boundary, scoped to this observation only. */
  acceptedPostRefs?: ReadonlySet<string>;
  /**
   * Counts-only sink for parser diagnostics. A canonicalizer that REFUSES a
   * value (rather than guessing one) drops a fact on the floor; with no
   * counter a systematic decode failure looks exactly like a clean run that
   * happened to yield fewer rows. Codes are fixed strings — never payload
   * content.
   */
  diagnostics?: { record: (code: string) => void };
}

export type Canonicalizer = (
  observation: CanonicalizableObservation,
  context?: CanonicalizeRunContext,
) => CanonicalEventDraft[];

/**
 * A TERMINAL zero-event outcome (H2, INC-001): the payload is readable, and it
 * can never yield a safe event — e.g. a PPV notification with no chat ref,
 * whose only fan-looking id is the creator's. Distinct from a rejection, which
 * leaves the row unstamped for a future parser: a quarantined row IS stamped
 * (an unstamped one would hold the backlog-age gauge up forever) and gets an
 * explicit `observation_parse_quarantine` row plus a counter instead of
 * silently vanishing into "stamped with zero events". Fixed codes only.
 */
export interface CanonicalQuarantine {
  code: string;
}

/** Fixed-code refusal details; never provider payload content. */
export interface CanonicalParseRejection {
  code: string;
  itemIndex?: number;
}

export interface CanonicalParseResult {
  events: CanonicalEventDraft[];
  /** Non-null refuses the WHOLE observation, even if some drafts were valid. */
  rejection: CanonicalParseRejection | null;
}

/** Context-free shape validation and draft construction in one pure pass. */
export type CanonicalParser = (
  observation: CanonicalizableObservation,
) => CanonicalParseResult;

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

/** Fansly numeric timestamps arrive in epoch SECONDS below ~2001-09 in ms
 * terms (< 1e12) and in MILLISECONDS above — the same heuristic the
 * hot-table path has always used (normalizeFanslyTimestamp). Strings and
 * anything unparseable fall back like asDate. */
export function asFanslyTimestamp(value: unknown, fallback: Date): Date {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= 1_000_000_000_000 ? value : value * 1000;
    const parsed = new Date(ms);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    return fallback;
  }
  return asDate(value, fallback);
}

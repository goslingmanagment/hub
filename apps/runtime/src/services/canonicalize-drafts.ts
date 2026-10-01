// The pure half of canonicalization: one observation → the drafts it yields.
//
// Two callers share it and nothing else. The minutely driver
// (canonicalize-driver.ts `runFamily`) keeps its own reads, transactions and
// stamps around it, exactly as before this file existed; the Fansly Sync
// Engine's apply transaction (sync/engine/canonicalize.ts) runs the same drafts
// through an in-transaction append. Whatever decides WHICH events an
// observation yields lives here, so the two can never disagree about it —
// `tests/canonicalize-drafts-parity.test.ts` pins that the driver appends
// exactly these drafts for a fixture of every family.
//
// No I/O, no clock reads beyond the `now` it is handed: the only context a
// family needs from the database (the accepted post refs of the OnlyFans post
// family) is read by the caller after the shape gate and passed in.

import type { CanonicalizerFamily } from "./canonicalize/index.ts";
import type {
  CanonicalizableObservation,
  CanonicalEventDraft,
  CanonicalizeRunContext,
  CanonicalParseRejection,
  CanonicalParseResult,
  CanonicalQuarantine,
} from "./canonicalize/types.ts";

/** W8.2 (A13 remainder, decision #133): the plausibility window for
 * occurred_at at canonicalize time. Provider timestamps are untrusted input —
 * a garbage year (1970 epoch-zero, 20326 fat-finger) used to aim the insert
 * at a partition that may not exist (ExecFindPartition 23514 → the
 * observation retries every sweep, forever). Real platform facts start 2024;
 * the future edge allows provider clock skew, nothing more. */
export const OCCURRED_AT_CLAMP_MIN = new Date("2024-01-01T00:00:00Z");
export const OCCURRED_AT_CLAMP_FUTURE_MONTHS = 2;

export function occurredAtClampMax(now: Date): Date {
  const max = new Date(now.getTime());
  max.setUTCMonth(max.getUTCMonth() + OCCURRED_AT_CLAMP_FUTURE_MONTHS);
  return max;
}

/** Out-of-window occurred_at falls back to the observation's receipt time —
 * NEVER a guessed boundary date — and the raw provider value is preserved
 * verbatim in event data (occurredAtRaw) so a later repair campaign (the
 * 1970-repair precedent) can re-date honestly. Dedup keys are built by the
 * canonicalizers BEFORE this clamp, so replays stay key-stable. */
export function clampDraftOccurredAt(
  draft: CanonicalEventDraft,
  receivedAt: Date,
  now: Date,
): CanonicalEventDraft {
  const time = draft.occurredAt.getTime();
  if (
    !Number.isNaN(time)
    && time >= OCCURRED_AT_CLAMP_MIN.getTime()
    && time <= occurredAtClampMax(now).getTime()
  ) {
    return draft;
  }
  return {
    ...draft,
    occurredAt: receivedAt,
    data: {
      ...draft.data,
      occurredAtClamped: true,
      occurredAtRaw: Number.isNaN(time) ? null : draft.occurredAt.toISOString(),
    },
  };
}

/**
 * The shape gate's verdict. An accepted verdict of a `parse` family carries
 * its one-pass result, so the drafts below are those very events and the
 * family is not run twice.
 */
export type CanonicalShapeVerdict =
  | { accepted: true; parsed: CanonicalParseResult | undefined }
  | { accepted: false; rejection: CanonicalParseRejection };

export type AcceptedCanonicalShape = Extract<CanonicalShapeVerdict, { accepted: true }>;

/**
 * Shape gate BEFORE anything else: a payload the family cannot read must not
 * be stamped consumed — stamping it would delete it from every future replay
 * just as surely as a DROP would. A `parse` family validates and builds in one
 * pass; a `canParse` family is asked, and `parseRejection` names why (or
 * `unclassified`).
 */
export function gateCanonicalObservation(
  family: CanonicalizerFamily,
  observation: CanonicalizableObservation,
): CanonicalShapeVerdict {
  const parsed = family.parse?.(observation);
  if (parsed !== undefined) {
    return parsed.rejection === null
      ? { accepted: true, parsed }
      : { accepted: false, rejection: parsed.rejection };
  }
  if (family.canParse !== undefined && !family.canParse(observation)) {
    return {
      accepted: false,
      rejection: family.parseRejection?.(observation) ?? { code: "unclassified" },
    };
  }
  return { accepted: true, parsed: undefined };
}

export interface CanonicalDraftContext extends CanonicalizeRunContext {
  /** The run's instant: the upper edge of the occurred_at window. */
  now: Date;
}

export interface CanonicalDrafts {
  kind: "accepted";
  /** In canonicalizer order, each clamped into the occurred_at window. */
  drafts: CanonicalEventDraft[];
  /** Non-null only for an accepted observation that yielded no draft and
   *  that its family names a TERMINAL quarantine (H2, INC-001). */
  quarantine: CanonicalQuarantine | null;
}

export type CanonicalDraftsOutcome =
  | CanonicalDrafts
  | { kind: "rejected"; rejection: CanonicalParseRejection };

/**
 * The drafts one observation yields: shape gate → drafts → occurred_at clamp,
 * plus the family's quarantine verdict for an empty accepted row. Pass the
 * verdict when the caller already gated the row (the driver reads the
 * accepted post refs between the two); otherwise the gate runs here.
 */
export function buildCanonicalDrafts(
  family: CanonicalizerFamily,
  observation: CanonicalizableObservation,
  context: CanonicalDraftContext,
  verdict: AcceptedCanonicalShape,
): CanonicalDrafts;
export function buildCanonicalDrafts(
  family: CanonicalizerFamily,
  observation: CanonicalizableObservation,
  context: CanonicalDraftContext,
  verdict?: CanonicalShapeVerdict,
): CanonicalDraftsOutcome;
export function buildCanonicalDrafts(
  family: CanonicalizerFamily,
  observation: CanonicalizableObservation,
  context: CanonicalDraftContext,
  verdict: CanonicalShapeVerdict = gateCanonicalObservation(family, observation),
): CanonicalDraftsOutcome {
  if (!verdict.accepted) {
    return { kind: "rejected", rejection: verdict.rejection };
  }
  const { now, ...runContext } = context;
  const drafts = (verdict.parsed?.events ?? family.canonicalize(observation, runContext))
    .map((draft) => clampDraftOccurredAt(draft, observation.receivedAt, now));
  const quarantine = drafts.length === 0 ? family.quarantine?.(observation) ?? null : null;
  return { kind: "accepted", drafts, quarantine };
}

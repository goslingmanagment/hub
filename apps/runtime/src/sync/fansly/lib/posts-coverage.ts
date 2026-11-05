import type { CaptureCoverageProof, CaptureCoverageStatus } from "@agency_hub_core/db";
import { CAPTURE_COVERAGE_HEAD_TOLERANCE_MS, CAPTURE_COVERAGE_PLANES } from "@agency_hub_core/shared";

import type { OutcomeClass } from "../../engine/errors.ts";

// The `posts` plane of `capture_coverage` (ContentOps entry E7): one row per
// page, scope ''. Its claim: every post the page published from the end of
// its timeline up to `newestCapturedAt` — the admission of the head page of
// the latest walk the claim rests on — is captured.
//
// - A full walk (`posts.backfill`, or a refresh that ran out of timeline)
//   ends on an empty page: the floor, `provider_exhausted` / `empty_window`,
//   that page's observation as the proof, `oldestCapturedAt` the oldest post
//   it saw.
// - Each refresh round keeps the claim while its lower bound (14 days before
//   its first admission) reaches the head the claim already holds: the head
//   moves to the round's own.
// - A round that does not reach it (no round for longer than its lookback) is
//   a gap: `window_captured` / `head_gap`, the floor forgotten, a backfill
//   asked for. No floor yet: `window_captured` / `floor_unproven`, the same.
// - A walk's step that fails keeps the floor and the head (the chain, in the
//   row's cursor) and says why the claim is not current: `auth_blocked` for a
//   dead session, `contract_drift` for an answer the contract refuses, and
//   `window_captured` / `head_stale` once the head is older than the plane's
//   tolerance. The next round that connects restores the claim.

export const POSTS_COVERAGE_PLANE = CAPTURE_COVERAGE_PLANES.posts;
/** How old the head of a current claim may be (`nextProbeAt` = head + this). */
export const POSTS_HEAD_TOLERANCE_MS = CAPTURE_COVERAGE_HEAD_TOLERANCE_MS[POSTS_COVERAGE_PLANE]!;

/** The proof chain the claim rests on, kept in the row's cursor. */
export interface PostsCoverageChain {
  /** The empty page that ended a full walk; null: never proven, or a gap broke the chain. */
  floor: { observationId: number; oldestAt: string | null; provenAt: string } | null;
  /** ISO: every post published by this instant is captured (with `floor`). */
  headAt: string | null;
}

export interface PostsWalkSummary {
  end: "timeline_exhausted" | "cutoff_reached";
  /** ISO lower publication bound of a bounded walk; null: the full walk. */
  cutoffAt: string | null;
  /** ISO: the admission of the walk's head page. */
  headReadAt: string;
  /** ISO: the publication of the oldest post the walk saw. */
  oldestPublishedAt: string | null;
  /** The journaled answer the walk ended on (the empty page of a full walk). */
  endObservationId: number;
}

export interface PostsCoverageClaim {
  status: CaptureCoverageStatus;
  proof: CaptureCoverageProof;
  proofObservationId: number | null;
  oldestCapturedAt: Date | null;
  newestCapturedAt: Date;
  reasonCode: string;
  nextProbeAt: Date | null;
  chain: PostsCoverageChain;
  /** A full walk is needed to prove the floor again. */
  needsBackfill: boolean;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function instant(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function parsePostsCoverageChain(cursor: unknown): PostsCoverageChain {
  const record = recordOf(cursor);
  const floor = recordOf(record.floor);
  const observationId = floor.observationId;
  const provenAt = instant(floor.provenAt);
  return {
    floor: typeof observationId === "number" && Number.isSafeInteger(observationId) && observationId > 0 && provenAt !== null
      ? { observationId, oldestAt: instant(floor.oldestAt), provenAt }
      : null,
    headAt: instant(record.headAt),
  };
}

function later(left: string | null, right: string): string {
  return left !== null && Date.parse(left) > Date.parse(right) ? left : right;
}

function proven(chain: PostsCoverageChain & { floor: NonNullable<PostsCoverageChain["floor"]>; headAt: string }): PostsCoverageClaim {
  return {
    status: "provider_exhausted",
    proof: "empty_window",
    proofObservationId: chain.floor.observationId,
    oldestCapturedAt: chain.floor.oldestAt === null ? null : new Date(chain.floor.oldestAt),
    newestCapturedAt: new Date(chain.headAt),
    reasonCode: "timeline_exhausted",
    nextProbeAt: new Date(Date.parse(chain.headAt) + POSTS_HEAD_TOLERANCE_MS),
    chain,
    needsBackfill: false,
  };
}

/** The claim a completed walk leaves, given the chain the row held. */
export function postsCoverageAfterWalk(walk: PostsWalkSummary, held: PostsCoverageChain, now: Date): PostsCoverageClaim {
  if (walk.end === "timeline_exhausted") {
    // The whole timeline was read: a fresh floor. A head the held chain
    // already proved later stays (both claims hold, the union is one).
    return proven({
      floor: { observationId: walk.endObservationId, oldestAt: walk.oldestPublishedAt, provenAt: now.toISOString() },
      headAt: later(held.floor === null ? null : held.headAt, walk.headReadAt),
    });
  }
  if (held.floor !== null && held.headAt !== null && walk.cutoffAt !== null && Date.parse(walk.cutoffAt) <= Date.parse(held.headAt)) {
    return proven({ floor: held.floor, headAt: later(held.headAt, walk.headReadAt) });
  }
  return {
    status: "window_captured",
    proof: "none",
    proofObservationId: null,
    oldestCapturedAt: walk.cutoffAt === null ? null : new Date(walk.cutoffAt),
    newestCapturedAt: new Date(walk.headReadAt),
    reasonCode: held.floor === null ? "floor_unproven" : "head_gap",
    nextProbeAt: null,
    chain: { floor: null, headAt: null },
    needsBackfill: true,
  };
}

/** What a failed step of a walk makes of a current claim; null: it stands. */
export function postsCoverageAfterFailure(input: {
  errorClass: OutcomeClass;
  status: CaptureCoverageStatus;
  newestCapturedAt: Date | null;
  now: Date;
}): { status: CaptureCoverageStatus; reasonCode: string } | null {
  if (input.status !== "provider_exhausted" || input.errorClass === "ok" || input.errorClass === "not_sent") return null;
  if (input.errorClass === "auth") return { status: "auth_blocked", reasonCode: "session_refused" };
  if (input.errorClass === "contract") return { status: "contract_drift", reasonCode: "timeline_contract" };
  const head = input.newestCapturedAt?.getTime() ?? null;
  return head === null || input.now.getTime() - head > POSTS_HEAD_TOLERANCE_MS
    ? { status: "window_captured", reasonCode: "head_stale" }
    : null;
}

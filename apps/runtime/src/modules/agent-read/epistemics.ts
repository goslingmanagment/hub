import {
  AGENT_PLANE_NAMES,
  requiredPlanesForClaimFields,
  type AgentBlocker,
  type AgentCapture,
  type AgentCaptureBasis,
  type AgentCaptureCeiling,
  type AgentCaptureFloor,
  type AgentConclusion,
  type AgentFieldState,
  type AgentGap,
  type AgentPlane,
  type AgentPlaneReason,
  type AgentProof,
  type AgentScopeNarrowing,
  type AgentSourceError,
} from "@agency_hub_core/contracts";
import type { PlaneReadWitness } from "@agency_hub_core/db";

/**
 * The Agent Read Plane's epistemics: the ONLY place in the runtime that decides
 * whether an absence is provable.
 *
 * WHY ONE FUNCTION (and why a test greps for the literal `absenceProvable` and
 * expects exactly one runtime file): the field is the single thing an agent is
 * permitted to read as "this did not happen". Every handler that computed it for
 * itself would eventually compute it slightly differently, and a slightly wrong
 * `true` is worse than no field at all — it is the 5791 failure repeated with
 * more authority. Ramp mode, cursor traversal and claim validity therefore enter
 * through the SIGNATURE rather than through a bypass; when a new condition
 * appears, extend the input, never write the literal somewhere else.
 *
 * THE CONDITIONS (spec §5.4, appendix §17.0.10) — all of them, simultaneously:
 *   delivery exhausted and no next cursor; the window's lower bound at or after a
 *   NON-NULL capture floor and its upper bound at or before the ceiling; `gaps`
 *   empty; `basis === "cryptographic_proof"`; the proof unrevoked, classified
 *   `continuous_history`, and its frozen head equal to the current head; zero
 *   parse debt and zero rejected rows; the serving high-water satisfied;
 *   `sourceErrors` empty; no page excluded by the key grant;
 *   `gapDetection === "verified"`; every REQUIRED plane of the claim in state
 *   `read`; every declared claim field observable in scope; a claim declared at
 *   all; the plane in `full` mode; and no cursor consumed on the way here.
 *
 * STRUCTURAL CONSEQUENCES, all intended:
 *   - Fansly can never answer `true`: it has no proof lane, so `basis` is never
 *     `cryptographic_proof`.
 *   - A money claim can never answer `true` today: there is no proof lane for the
 *     class at all, and the blocker says so by name (`no_proof_lane_for_claim`)
 *     rather than blaming five unread message planes.
 *   - Search can never answer `true`: two of its planes are `not_indexed`.
 */

/** The three ramp positions of `agentReadPlaneMode`. */
export type AgentPlaneMode = "off" | "read_only" | "full";

/** How a plane that the operation did NOT read must explain itself. */
export interface PlaneNotReadReason {
  readonly plane: string;
  readonly state: "not_read" | "not_indexed";
  readonly reason: AgentPlaneReason;
}

export interface AgentEvidenceInput {
  /** Live, per-request. `read_only` pins the conclusion false with `read_only_mode`. */
  readonly planeMode: AgentPlaneMode;
  /** The claim the CALLER declared, or null when it declared none. */
  readonly claimFields: readonly string[] | null;
  /**
   * The planes this operation reads for this claim. Everything outside the set
   * is `not_applicable("not_a_source_for_this_claim")` and cannot affect the
   * conclusion; everything inside it that was not read forces `false`.
   */
  readonly operationPlanes: readonly string[];
  /**
   * What the REPOSITORY layer actually read. These are branded and can only be
   * minted inside `packages/db`, so a handler cannot claim a read it did not
   * perform.
   */
  readonly planeReads: readonly PlaneReadWitness[];
  /** In-set planes with no witness, each with its reason. */
  readonly planesNotRead: readonly PlaneNotReadReason[];
  readonly delivery: { readonly snapshotExhausted: boolean; readonly nextCursor: string | null };
  /** True when THIS response resumed from a cursor (R-008). */
  readonly cursorConsumed: boolean;
  /** True for operations that can page at all (they carry the caveat). */
  readonly cursorCapable: boolean;
  readonly requestWindow: { readonly from: string; readonly to: string } | null;
  readonly gaps: readonly AgentGap[];
  readonly gapDetection: "head_only" | "verified";
  readonly scopeFieldStates: Readonly<Record<string, AgentFieldState>>;
  readonly sourceErrors: readonly AgentSourceError[];
  readonly scopeNarrowing: AgentScopeNarrowing;
  readonly observedRowFloor: string | null;
  /**
   * The aggregate capture bound of the operation's scope. `store_derived` MUST
   * carry `{at: null, kind: "unknown"}`: the oldest returned row is not a floor,
   * and treating it as one is the forbidden inference.
   */
  readonly captureFloor: AgentCaptureFloor;
  readonly captureCeiling: AgentCaptureCeiling;
  readonly basis: AgentCaptureBasis;
  readonly proof: AgentProof | null;
  readonly parseDebt: number;
  readonly rejected: number;
  readonly servingHighWaterSatisfied: boolean;
  /**
   * False when the claim's class has no proof lane in existence (money today).
   * Reported as `no_proof_lane_for_claim` instead of a pile of plane blockers.
   */
  readonly hasProofLaneForClaim: boolean;
}

export interface AgentEvidence {
  readonly capture: AgentCapture;
  readonly conclusion: AgentConclusion;
  /** Delivery caveats derived from the same facts (see `mutable_sort_key`). */
  readonly deliveryCaveats: Array<"mutable_sort_key">;
}

const FIELD_STATES_SUFFICIENT_FOR_ABSENCE = new Set(["present", "observed_empty"]);

/**
 * Builds `capture.planes[]`: every declared plane name, exactly once.
 *
 * The anti-omission law is literal — a plane that is silently absent from the
 * array is forbidden, so this function enumerates the registry rather than the
 * operation's own list. Planes outside the operation's set are
 * `not_applicable("not_a_source_for_this_claim")`, which cannot affect a
 * conclusion; that split is what stopped a money question from being refused
 * because five MESSAGE planes were unread.
 */
function buildPlanes(input: AgentEvidenceInput): AgentPlane[] {
  const witnessByPlane = new Map(input.planeReads.map((witness) => [witness.plane, witness]));
  const notReadByPlane = new Map(input.planesNotRead.map((entry) => [entry.plane, entry]));
  const inSet = new Set(input.operationPlanes);

  return AGENT_PLANE_NAMES.map((plane): AgentPlane => {
    const witness = witnessByPlane.get(plane);
    if (witness) {
      return {
        plane,
        state: "read",
        basis: witness.basis,
        captureFloor: witness.captureFloor,
        captureCeiling: witness.captureCeiling,
        proof: witness.proof,
        parseDebt: witness.parseDebt,
        rejected: witness.rejected,
        servingHighWaterSatisfied: witness.servingHighWaterSatisfied,
      };
    }
    if (!inSet.has(plane)) {
      return { plane, state: "not_applicable", reason: "not_a_source_for_this_claim" };
    }
    const declared = notReadByPlane.get(plane);
    return {
      plane,
      state: declared?.state ?? "not_read",
      reason: declared?.reason ?? "not_queried_by_this_operation",
    };
  });
}

/**
 * THE conclusion. Nothing else in the runtime writes this field.
 *
 * Blockers are collected in a stable order and de-duplicated; `absenceProvable`
 * is then defined as "no blockers", which is the invariant every response schema
 * re-checks (`absenceProvable iff blockers is empty`).
 */
export function concludeEnvelope(input: AgentEvidenceInput, planes: readonly AgentPlane[]): AgentConclusion {
  const blockers: AgentBlocker[] = [];
  const add = (blocker: AgentBlocker) => {
    if (!blockers.includes(blocker)) {
      blockers.push(blocker);
    }
  };

  // --- the ramp and the traversal (both enter through the signature) ---
  if (input.planeMode !== "full") {
    add("read_only_mode");
  }
  if (input.cursorConsumed) {
    // A mutable sort key means a keyset traversal can skip a row that moved
    // between pages. Within ONE request the read is snapshot-consistent and a
    // caveat suffices; across pages it does not, and no caveat can cure it.
    add("mutable_sort_key_traversal");
  }

  // --- the claim ---
  const claimFields = input.claimFields;
  if (claimFields === null || claimFields.length === 0) {
    add("claim_not_declared");
  } else if (requiredPlanesForClaimFields(claimFields) === null) {
    // Fail-closed: a field with no class has no authoritative store, so there is
    // nothing that could have been read to justify asserting its absence.
    add("claim_field_unobservable");
  }

  // --- delivery ---
  if (!input.delivery.snapshotExhausted || input.delivery.nextCursor !== null) {
    add("delivery_not_exhausted");
  }

  // --- capture basis and proof ---
  if (!input.hasProofLaneForClaim) {
    add("no_proof_lane_for_claim");
  }
  if (input.basis === "none") {
    add("capture_basis_none");
  } else if (input.basis === "store_derived") {
    add("capture_basis_store_derived");
  }
  if (input.basis === "cryptographic_proof") {
    const proof = input.proof;
    if (!proof) {
      add("proof_missing");
    } else {
      if (proof.revokedAt !== null) {
        add("proof_revoked");
      }
      if (proof.classification !== "continuous_history") {
        // `explicit_open_debt` is an ADMISSION of a hole; an earlier formulation
        // let it satisfy the condition.
        add("proof_classification_not_continuous");
      }
      if (!proof.frozenHeadMatchesCurrentHead) {
        add("proof_head_stale");
      }
    }
  } else {
    add("proof_missing");
  }

  // --- the window against the capture bounds ---
  const floorAt = input.captureFloor.at;
  if (floorAt === null) {
    add("capture_floor_unknown");
  }
  const ceilingAt = input.captureCeiling.at;
  if (ceilingAt === null) {
    add("capture_ceiling_unknown");
  }
  const window = input.requestWindow;
  if (window !== null) {
    if (floorAt !== null && Date.parse(window.from) < Date.parse(floorAt)) {
      add("window_before_capture_floor");
    }
    if (ceilingAt !== null && Date.parse(window.to) > Date.parse(ceilingAt)) {
      add("window_after_capture_ceiling");
    }
  }

  // --- holes ---
  if (input.gaps.length > 0) {
    add("gaps_present");
  }
  if (input.gapDetection !== "verified") {
    // A lane that stalled for three days mid-window leaves no row anywhere, so an
    // empty `gaps` proves nothing while detection is head-only.
    add("gap_detection_head_only");
  }
  if (input.parseDebt !== 0) {
    add("parse_debt_nonzero");
  }
  if (input.rejected !== 0) {
    add("rejected_nonzero");
  }
  if (!input.servingHighWaterSatisfied) {
    add("serving_high_water_unsatisfied");
  }
  if (input.sourceErrors.length > 0) {
    // Invariant 5: a failed source is a row excluded from the counts, and a
    // response missing a source cannot prove anything absent.
    add("source_errors_present");
  }
  if (input.scopeNarrowing.keyGrantExcludedPages > 0) {
    add("key_grant_narrowed_scope");
  }

  // --- the planes of the claim ---
  const requiredPlanes = claimFields === null
    ? null
    : requiredPlanesForClaimFields(claimFields);
  const stateByPlane = new Map<string, string>(planes.map((plane) => [plane.plane, plane.state]));
  const planesToCheck = requiredPlanes ?? [];
  for (const plane of planesToCheck) {
    // A required plane the operation does not read at all is still a blocker: it
    // was needed for THIS claim and no row proves anything without it.
    const state = stateByPlane.get(plane);
    if (state === "not_indexed") {
      add("plane_not_indexed");
    } else if (state !== "read") {
      add("plane_not_read");
    }
  }

  // --- per-field observability, computed BEFORE rows were fetched ---
  for (const field of claimFields ?? []) {
    const fieldState = input.scopeFieldStates[field];
    if (!fieldState || !FIELD_STATES_SUFFICIENT_FOR_ABSENCE.has(fieldState.state)) {
      add("field_state_insufficient");
    }
  }

  return { absenceProvable: blockers.length === 0, blockers };
}

/**
 * Reads the verdict off a built evidence block.
 *
 * Exists so that no other runtime file has to mention the field by name: the
 * one-writer pin is TEXTUAL, and a read is one careless edit away from becoming
 * a write. Callers that need the boolean (per-scope `windowCovered` on the
 * coverage probe) go through here.
 */
export function evidenceProvesAbsence(evidence: AgentEvidence): boolean {
  return evidence.conclusion.absenceProvable;
}

/**
 * One call per response: build `capture`, conclude, and derive the delivery
 * caveats from the same facts so the three can never disagree.
 */
export function buildAgentEvidence(input: AgentEvidenceInput): AgentEvidence {
  const planes = buildPlanes(input);
  const capture: AgentCapture = {
    planes,
    gapDetection: input.gapDetection,
    observedRowFloor: input.observedRowFloor,
    gaps: [...input.gaps],
    sourceErrors: [...input.sourceErrors],
    scopeNarrowing: input.scopeNarrowing,
    scopeFieldStates: { ...input.scopeFieldStates },
  };
  const conclusion = concludeEnvelope(input, planes);
  // The caveat is the single-request counterpart of the traversal blocker: it
  // says the sort key can move, without claiming anything was skipped.
  const deliveryCaveats: Array<"mutable_sort_key"> =
    input.cursorCapable && !input.cursorConsumed ? ["mutable_sort_key"] : [];
  return { capture, conclusion, deliveryCaveats };
}

import {
  AGENT_PLANE_NAMES,
  requiredPlanesForClaimFields,
  type AgentBlocker,
  type AgentCapture,
  type AgentCaptureFloor,
  type AgentConclusion,
  type AgentFieldState,
  type AgentGap,
  type AgentPlane,
  type AgentPlaneReason,
  type AgentScopeNarrowing,
  type AgentSourceError,
} from "@agency_hub_core/contracts";
import type { PlaneReadWitness } from "@agency_hub_core/db";

/**
 * The Agent Read Plane's epistemics: the ONLY place in the runtime that decides
 * why an answer is narrower than the question that was asked.
 *
 * WHAT THIS FILE NO LONGER DOES (owner ruling 2026-08-01). It used to compute
 * `conclusion.absenceProvable` — one boolean an agent could read as "this did not
 * happen". The certification it demanded was unreachable on every real route:
 * nothing in this system performs a verified gap sweep, the gap-detection mode was
 * hardcoded to the value that forces `false`, and the coverage-proof reads feeding
 * it were the slowest queries in the slice. A field that is structurally always
 * `false` teaches an agent nothing and costs a fortune to compute, so it was
 * removed rather than propped up.
 *
 * WHAT SURVIVES IS THE PART THAT ANSWERS THE ORIGINAL QUESTION. `captureFloor`
 * reports when this store's record of a scope BEGINS, and a window starting
 * earlier produces a `before_capture_floor` gap plus the
 * `window_before_capture_floor` blocker. That is the difference between "no
 * messages in January" and "we hold nothing from before February" — and the
 * absence of that distinction is what sent the owner a false "no trace of this
 * person".
 *
 * The single-writer discipline stays: `blockers` is assembled here and nowhere
 * else (a textual test pins that no other runtime file names a blocker value), and
 * every new condition enters through the SIGNATURE rather than through a bypass.
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
  /** Live, per-request. `read_only` adds the ramp blocker. */
  readonly planeMode: AgentPlaneMode;
  /** The claim the CALLER declared, or null when it declared none. */
  readonly claimFields: readonly string[] | null;
  /**
   * The planes this operation consults for this claim. Everything outside the set
   * is `not_applicable("not_a_source_for_this_claim")`; everything inside it that
   * produced no witness is reported with its reason.
   */
  readonly operationPlanes: readonly string[];
  /**
   * What the REPOSITORY layer actually read. Branded, and mintable only inside
   * `packages/db`, so a handler cannot claim a read it did not perform.
   */
  readonly planeReads: readonly PlaneReadWitness[];
  /** In-set planes with no witness, each with its reason. */
  readonly planesNotRead: readonly PlaneNotReadReason[];
  readonly delivery: { readonly snapshotExhausted: boolean; readonly nextCursor: string | null };
  /** True when THIS response resumed from a cursor (R-008). */
  readonly cursorConsumed: boolean;
  /** True for operations that can page at all (they carry the caveat). */
  readonly cursorCapable: boolean;
  /** True when the traversal froze a real monotonic bound. False earns the
   *  `no_frozen_snapshot` caveat instead of an unearned `snapshotExhausted`. */
  readonly frozenSnapshot: boolean;
  readonly requestWindow: { readonly from: string; readonly to: string } | null;
  readonly gaps: readonly AgentGap[];
  readonly scopeFieldStates: Readonly<Record<string, AgentFieldState>>;
  readonly sourceErrors: readonly AgentSourceError[];
  readonly scopeNarrowing: AgentScopeNarrowing;
  readonly observedRowFloor: string | null;
  /** When this store's record of the scope begins, or `unknown`. */
  readonly captureFloor: AgentCaptureFloor;
}

export interface AgentEvidence {
  readonly capture: AgentCapture;
  readonly conclusion: AgentConclusion;
  /** Delivery caveats derived from the same facts. */
  readonly deliveryCaveats: Array<"mutable_sort_key" | "no_frozen_snapshot">;
}

const FIELD_STATES_SUFFICIENT = new Set(["present", "observed_empty"]);

/**
 * Builds `capture.planes[]`: every declared plane name, exactly once.
 *
 * The anti-omission law is literal — a plane silently absent from the array is
 * forbidden — so this enumerates the REGISTRY rather than the operation's own
 * list. A plane outside the operation's set is `not_applicable`, which is a
 * different statement from `not_read` and must stay distinguishable.
 */
function buildPlanes(input: AgentEvidenceInput): AgentPlane[] {
  const witnessByPlane = new Map(input.planeReads.map((witness) => [witness.plane, witness]));
  const notReadByPlane = new Map(input.planesNotRead.map((entry) => [entry.plane, entry]));
  const inSet = new Set(input.operationPlanes);

  return AGENT_PLANE_NAMES.map((plane): AgentPlane => {
    const witness = witnessByPlane.get(plane);
    if (witness) {
      return { plane, state: "read", captureFloor: witness.captureFloor };
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
 * THE blockers. Nothing else in the runtime writes one.
 *
 * Collected in a stable order and de-duplicated, so two responses to the same
 * situation are byte-identical.
 */
export function concludeEnvelope(
  input: AgentEvidenceInput,
  planes: readonly AgentPlane[],
): AgentConclusion {
  const blockers: AgentBlocker[] = [];
  const add = (blocker: AgentBlocker) => {
    if (!blockers.includes(blocker)) {
      blockers.push(blocker);
    }
  };

  if (input.planeMode !== "full") {
    add("read_only_mode");
  }
  if (input.cursorConsumed) {
    // A mutable sort key means a keyset traversal can skip a row that moved
    // between pages. Within ONE request the read is snapshot-consistent; across
    // pages it is not, and no caveat can cure that.
    add("mutable_sort_key_traversal");
  }

  const claimFields = input.claimFields;
  if (claimFields === null || claimFields.length === 0) {
    add("claim_not_declared");
  } else if (requiredPlanesForClaimFields(claimFields) === null) {
    // Fail-closed: a field with no class has no authoritative store, so nothing
    // could have been read that would speak for it.
    add("claim_field_unobservable");
  }

  if (!input.delivery.snapshotExhausted || input.delivery.nextCursor !== null) {
    add("delivery_not_exhausted");
  }

  const floorAt = input.captureFloor.at;
  if (floorAt === null) {
    add("capture_floor_unknown");
  }
  const window = input.requestWindow;
  if (window !== null && floorAt !== null && Date.parse(window.from) < Date.parse(floorAt)) {
    // The blocker that answers the original question.
    add("window_before_capture_floor");
  }

  if (input.gaps.length > 0) {
    add("gaps_present");
  }
  if (input.sourceErrors.length > 0) {
    // A failed source is a row excluded from the counts, and a response missing a
    // source describes less than it appears to.
    add("source_errors_present");
  }
  if (input.scopeNarrowing.keyGrantExcludedPages > 0) {
    add("key_grant_narrowed_scope");
  }

  const requiredPlanes = claimFields === null ? null : requiredPlanesForClaimFields(claimFields);
  const stateByPlane = new Map<string, string>(planes.map((plane) => [plane.plane, plane.state]));
  for (const plane of requiredPlanes ?? []) {
    const state = stateByPlane.get(plane);
    if (state === "not_indexed") {
      add("plane_not_indexed");
    } else if (state !== "read") {
      add("plane_not_read");
    }
  }

  for (const field of claimFields ?? []) {
    const fieldState = input.scopeFieldStates[field];
    if (!fieldState || !FIELD_STATES_SUFFICIENT.has(fieldState.state)) {
      add("field_state_insufficient");
    }
  }

  return { blockers };
}

/** Reads the "nothing limits this answer" verdict off a built evidence block.
 *  Exists so no other runtime file has to name a blocker. */
export function evidenceIsUnrestricted(evidence: AgentEvidence): boolean {
  return evidence.conclusion.blockers.length === 0;
}

/**
 * One call per response: build `capture`, list the blockers, and derive the
 * delivery caveats from the same facts so the three can never disagree.
 */
export function buildAgentEvidence(input: AgentEvidenceInput): AgentEvidence {
  const planes = buildPlanes(input);
  const capture: AgentCapture = {
    planes,
    observedRowFloor: input.observedRowFloor,
    gaps: [...input.gaps],
    sourceErrors: [...input.sourceErrors],
    scopeNarrowing: input.scopeNarrowing,
    scopeFieldStates: { ...input.scopeFieldStates },
  };
  const conclusion = concludeEnvelope(input, planes);
  const deliveryCaveats: Array<"mutable_sort_key" | "no_frozen_snapshot"> = [];
  if (input.cursorCapable && !input.cursorConsumed) {
    deliveryCaveats.push("mutable_sort_key");
  }
  if (input.cursorCapable && !input.frozenSnapshot) {
    deliveryCaveats.push("no_frozen_snapshot");
  }
  return { capture, conclusion, deliveryCaveats };
}

/**
 * The `before_capture_floor` gap: the window (or part of it) predates anything
 * this store holds for the scope.
 *
 * Naming the remedy is what turns "nothing found" into "nothing was ever captured
 * this far back, and here is how to change that" — and the remedy is only
 * `admissible` when hydration could in fact run.
 */
export function gapBeforeCaptureFloor(input: {
  plane: string;
  floorAt: string | null;
  windowFrom: string | null;
  hydrationAdmissible: boolean;
}): AgentGap[] {
  if (input.windowFrom === null || input.floorAt === null) {
    return [];
  }
  if (Date.parse(input.windowFrom) >= Date.parse(input.floorAt)) {
    return [];
  }
  return [{
    kind: "before_capture_floor",
    from: null,
    to: input.floorAt,
    plane: input.plane as AgentGap["plane"],
    remedy: {
      kind: "hydration_request",
      costClass: "vendor_paid_low",
      admissible: input.hydrationAdmissible,
      reason: input.hydrationAdmissible ? null : "hydration_mode_off",
    },
  }];
}

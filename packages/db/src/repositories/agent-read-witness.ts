/**
 * The branded proof that a repository actually read a capture plane.
 *
 * WHY A BRAND: `capture.planes[].state = "read"` is an input to
 * `absenceProvable`. If a handler could assemble that record itself, "I read the
 * archive" would become a claim rather than a fact, and the whole epistemic
 * apparatus would rest on handler discipline. So the record carries a private
 * symbol that only THIS module can attach, `mintPlaneReadWitness` is not
 * re-exported from the package barrel, and the runtime therefore receives
 * witnesses exclusively from repository return values.
 *
 * The runtime imports the TYPE (`PlaneReadWitness`) and nothing else.
 */

declare const planeReadWitnessBrand: unique symbol;

export interface PlaneReadWitness {
  readonly [planeReadWitnessBrand]: true;
  /** A plane name from the contracts registry. */
  readonly plane: string;
  readonly basis: "cryptographic_proof" | "store_derived" | "none";
  readonly captureFloor: {
    readonly at: string | null;
    readonly kind: "proof_oldest_message" | "unknown";
  };
  readonly captureCeiling: {
    readonly at: string | null;
    readonly kind: "last_successful_pull" | "proof_frozen_head" | "no_lane";
    readonly laneCadenceSeconds: number | null;
    readonly breakerOpen: boolean;
  };
  readonly proof: PlaneReadProof | null;
  readonly parseDebt: number;
  readonly rejected: number;
  readonly servingHighWaterSatisfied: boolean;
}

export interface PlaneReadProof {
  readonly classification: "continuous_history" | "verified_unavailable" | "explicit_open_debt";
  readonly source: "pagination_exhausted" | "export_artifact" | "harvest_import";
  readonly frozenHeadRef: string;
  readonly currentHeadRef: string | null;
  readonly frozenHeadMatchesCurrentHead: boolean;
  readonly oldestMessageRef: string | null;
  readonly targetHash: string;
  readonly pageChainHash: string;
  readonly proofObservationRef: number | null;
  readonly sourceAccountSeq: number | null;
  readonly revokedAt: string | null;
}

export type PlaneReadWitnessInput = Omit<PlaneReadWitness, typeof planeReadWitnessBrand>;

/**
 * Mints a witness. INTERNAL to `packages/db` on purpose — the barrel exports the
 * type only. A repository calls this after the read it describes has returned.
 */
export function mintPlaneReadWitness(input: PlaneReadWitnessInput): PlaneReadWitness {
  return input as PlaneReadWitness;
}

/**
 * The default witness for a plane read WITHOUT a cryptographic proof: everything
 * this system serves from Fansly, and OnlyFans threads with no coverage row.
 *
 * `captureFloor` is pinned to `{at: null, kind: "unknown"}` and there is no way
 * to pass another value: the oldest row a query returned is NOT a capture floor,
 * and a store-derived "complete" flag is set merely on intersecting an
 * already-stored message. This is why `absenceProvable` is structurally false on
 * Fansly, which is the honest answer rather than a degradation.
 */
export function storeDerivedWitness(input: {
  plane: string;
  ceilingAt: string | null;
  ceilingKind?: "last_successful_pull" | "no_lane";
  laneCadenceSeconds?: number | null;
  breakerOpen?: boolean;
  parseDebt?: number;
  rejected?: number;
  servingHighWaterSatisfied?: boolean;
}): PlaneReadWitness {
  return mintPlaneReadWitness({
    plane: input.plane,
    basis: "store_derived",
    captureFloor: { at: null, kind: "unknown" },
    captureCeiling: {
      at: input.ceilingAt,
      kind: input.ceilingKind ?? (input.ceilingAt === null ? "no_lane" : "last_successful_pull"),
      laneCadenceSeconds: input.laneCadenceSeconds ?? null,
      breakerOpen: input.breakerOpen ?? false,
    },
    proof: null,
    parseDebt: input.parseDebt ?? 0,
    rejected: input.rejected ?? 0,
    servingHighWaterSatisfied: input.servingHighWaterSatisfied ?? true,
  });
}

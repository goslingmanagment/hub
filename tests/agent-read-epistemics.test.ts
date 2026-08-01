import { describe, expect, it } from "vitest";

import {
  AGENT_PLANE_NAMES,
  agentCaptureSchema,
  agentConclusionSchema,
} from "@agency_hub_core/contracts";
import type { PlaneReadWitness } from "@agency_hub_core/db";

import {
  buildAgentEvidence,
  computeScopeFieldStates,
  hasProofLaneForClaim,
  operationPlanesFor,
  type AgentEvidenceInput,
} from "../apps/runtime/src/modules/agent-read/index.ts";

// The epistemic invariants of the Agent Read Plane. Each one exists because the
// design document names a way the answer could lie, and each is the mechanism
// that makes that lie inexpressible rather than merely discouraged.

/**
 * Witnesses are branded and mintable only inside `packages/db`. Tests are outside
 * it, so they cast — which is exactly the point: production code CANNOT do this,
 * because the constructor is not exported from the barrel.
 */
function witness(input: Partial<PlaneReadWitness> & { plane: string }): PlaneReadWitness {
  return {
    basis: "store_derived",
    captureFloor: { at: null, kind: "unknown" },
    captureCeiling: { at: null, kind: "no_lane", laneCadenceSeconds: null, breakerOpen: false },
    proof: null,
    parseDebt: 0,
    rejected: 0,
    servingHighWaterSatisfied: true,
    ...input,
  } as unknown as PlaneReadWitness;
}

const MESSAGE_PLANES = [
  "message_archive",
  "dm_message_archive",
  "page_dm_messages",
  "page_dm_threads",
  "observations",
  "sync_raw_payloads",
];

/** An OnlyFans transcript read with a valid, unrevoked, continuous-history proof
 *  covering the requested window. This is the ONLY shape that can answer true. */
function onlyFansProvableInput(overrides: Partial<AgentEvidenceInput> = {}): AgentEvidenceInput {
  const proof = {
    classification: "continuous_history" as const,
    source: "pagination_exhausted" as const,
    frozenHeadRef: "head-1",
    currentHeadRef: "head-1",
    frozenHeadMatchesCurrentHead: true,
    oldestMessageRef: "m-1",
    targetHash: "a".repeat(64),
    pageChainHash: "b".repeat(64),
    proofObservationRef: 7,
    sourceAccountSeq: 12,
    revokedAt: null,
  };
  return {
    planeMode: "full",
    claimFields: ["textPlain"],
    operationPlanes: MESSAGE_PLANES,
    planeReads: [
      witness({
        plane: "message_archive",
        basis: "cryptographic_proof",
        captureFloor: { at: "2026-01-01T00:00:00.000Z", kind: "proof_oldest_message" },
        captureCeiling: {
          at: "2026-03-01T00:00:00.000Z",
          kind: "proof_frozen_head",
          laneCadenceSeconds: null,
          breakerOpen: false,
        },
        proof,
      }),
      witness({ plane: "dm_message_archive" }),
      witness({ plane: "page_dm_messages" }),
      witness({ plane: "page_dm_threads" }),
      witness({ plane: "observations" }),
      witness({ plane: "sync_raw_payloads" }),
    ],
    planesNotRead: [],
    delivery: { snapshotExhausted: true, nextCursor: null },
    cursorConsumed: false,
    cursorCapable: true,
    requestWindow: { from: "2026-01-08T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z" },
    gaps: [],
    // Only a verified gap sweep may certify; head-only detection is the default
    // and forces false everywhere else.
    gapDetection: "verified",
    scopeFieldStates: computeScopeFieldStates({
      fields: ["textPlain"],
      platforms: ["onlyfans"],
    }),
    sourceErrors: [],
    scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 3 },
    observedRowFloor: null,
    captureFloor: { at: "2026-01-01T00:00:00.000Z", kind: "proof_oldest_message" },
    captureCeiling: {
      at: "2026-03-01T00:00:00.000Z",
      kind: "proof_frozen_head",
      laneCadenceSeconds: null,
      breakerOpen: false,
    },
    basis: "cryptographic_proof",
    proof,
    parseDebt: 0,
    rejected: 0,
    servingHighWaterSatisfied: true,
    hasProofLaneForClaim: true,
    ...overrides,
  };
}

describe("agent read plane: the conclusion", () => {
  it("golden true case: OnlyFans, proof, fully-read window", () => {
    const evidence = buildAgentEvidence(onlyFansProvableInput());
    expect(evidence.conclusion.blockers).toEqual([]);
    expect(agentConclusionSchema.parse(evidence.conclusion).absenceProvable).toBe(true);
  });

  it("the schema invariant holds: provable iff there are no blockers", () => {
    const cases: AgentEvidenceInput[] = [
      onlyFansProvableInput(),
      onlyFansProvableInput({ planeMode: "read_only" }),
      onlyFansProvableInput({ claimFields: null }),
      onlyFansProvableInput({ sourceErrors: [{ source: "page_dm_messages", code: "statement_timeout", excludedFromCounts: true }] }),
    ];
    for (const input of cases) {
      const { conclusion } = buildAgentEvidence(input);
      const parsed = agentConclusionSchema.parse(conclusion);
      expect(parsed.absenceProvable).toBe(parsed.blockers.length === 0);
    }
  });

  it("invariant 5: a non-empty sourceErrors makes absence unprovable", () => {
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({
      sourceErrors: [
        { source: "page_dm_messages", code: "statement_timeout", excludedFromCounts: true },
      ],
    }));
    expect(conclusion.blockers).toContain("source_errors_present");
  });

  it("invariants 8 and 9: no Fansly response can ever prove an absence", () => {
    // Structural, not conditional: `ofapi_message_coverage` is OnlyFans-only by
    // schema, so a Fansly read has no path to `cryptographic_proof`.
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({
      planeReads: [witness({ plane: "message_archive", basis: "store_derived" })],
      planesNotRead: [
        { plane: "dm_message_archive", state: "not_read", reason: "onlyfans_only" },
      ],
      basis: "store_derived",
      proof: null,
      captureFloor: { at: null, kind: "unknown" },
      scopeFieldStates: computeScopeFieldStates({
        fields: ["textPlain"],
        platforms: ["fansly"],
      }),
    }));
    expect(conclusion.blockers).toContain("capture_basis_store_derived");
    expect(conclusion.blockers).toContain("capture_floor_unknown");
    expect(conclusion.blockers).toContain("plane_not_read");
    expect(conclusion.blockers.length).toBeGreaterThan(0);
  });

  it("the regression case: a window before the capture floor names the floor", () => {
    // Asked about 08-20 January for a thread first captured in February. The
    // answer is empty AND says why, with the floor named. Never a bare list.
    const { conclusion, capture } = buildAgentEvidence(onlyFansProvableInput({
      requestWindow: { from: "2026-01-08T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z" },
      captureFloor: { at: "2026-02-21T00:00:00.000Z", kind: "proof_oldest_message" },
      gaps: [{
        kind: "before_capture_floor",
        from: null,
        to: "2026-02-21T00:00:00.000Z",
        plane: "message_archive",
        remedy: {
          kind: "hydration_request",
          costClass: "vendor_paid_low",
          admissible: true,
          reason: null,
        },
      }],
    }));
    expect(conclusion.blockers).toContain("window_before_capture_floor");
    expect(conclusion.blockers).toContain("gaps_present");
    expect(capture.gaps[0]?.to).toBe("2026-02-21T00:00:00.000Z");
  });

  it("head-only gap detection forces the conclusion false", () => {
    // A lane that stalled three days mid-window leaves no row in any named table,
    // so an empty `gaps` proves nothing while detection is head-only.
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({ gapDetection: "head_only" }));
    expect(conclusion.blockers).toEqual(["gap_detection_head_only"]);
  });

  it("read_only ramp pins the conclusion false with the reviewed blocker name", () => {
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({ planeMode: "read_only" }));
    expect(conclusion.blockers).toEqual(["read_only_mode"]);
  });

  it("R-008: a consumed cursor blocks; a single request only caveats", () => {
    const consumed = buildAgentEvidence(onlyFansProvableInput({
      cursorConsumed: true,
      // A resumable traversal is not exhausted either; isolate the traversal
      // blocker by keeping delivery complete.
    }));
    expect(consumed.conclusion.blockers).toEqual(["mutable_sort_key_traversal"]);
    expect(consumed.deliveryCaveats).toEqual([]);

    const single = buildAgentEvidence(onlyFansProvableInput());
    expect(single.deliveryCaveats).toEqual(["mutable_sort_key"]);
    expect(single.conclusion.blockers).toEqual([]);
  });

  it("an undeclared claim is not an error, it is a refusal of the right to conclude", () => {
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({ claimFields: null }));
    expect(conclusion.blockers).toContain("claim_not_declared");
  });

  it("a claim field with no class fails closed", () => {
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({
      claimFields: ["textPlain", "notARealField"],
    }));
    expect(conclusion.blockers).toContain("claim_field_unobservable");
  });

  it("a revoked or open-debt proof does not certify", () => {
    const base = onlyFansProvableInput();
    const revoked = buildAgentEvidence({
      ...base,
      proof: { ...base.proof!, revokedAt: "2026-04-01T00:00:00.000Z" },
    });
    expect(revoked.conclusion.blockers).toContain("proof_revoked");

    const openDebt = buildAgentEvidence({
      ...base,
      proof: { ...base.proof!, classification: "explicit_open_debt" },
    });
    // An admission of a hole once satisfied the old formulation.
    expect(openDebt.conclusion.blockers).toContain("proof_classification_not_continuous");

    const stale = buildAgentEvidence({
      ...base,
      proof: { ...base.proof!, frozenHeadMatchesCurrentHead: false },
    });
    expect(stale.conclusion.blockers).toContain("proof_head_stale");
  });

  it("a narrowed grant blocks: an invisible page could hold the answer", () => {
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({
      scopeNarrowing: { keyGrantExcludedPages: 3, totalPagesForQuery: 11 },
    }));
    expect(conclusion.blockers).toContain("key_grant_narrowed_scope");
  });

  it("money has no proof lane at all, and says so by name", () => {
    // A MONEY operation that read the money planes properly: the only thing
    // missing is a proof lane, which does not exist for this class at all.
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({
      claimFields: ["grossMills"],
      operationPlanes: ["transactions", "fan_spend_daily", "fan_spend_lifetime"],
      planeReads: [
        witness({ plane: "transactions" }),
        witness({ plane: "fan_spend_daily" }),
        witness({ plane: "fan_spend_lifetime" }),
      ],
      planesNotRead: [],
      hasProofLaneForClaim: false,
      scopeFieldStates: computeScopeFieldStates({
        fields: ["grossMills"],
        platforms: ["onlyfans"],
      }),
    }));
    expect(conclusion.blockers).toContain("no_proof_lane_for_claim");
    // NOT "five message planes were unread": that was the wrong diagnosis, and it
    // made the ONE plane that answered the original question unable to conclude.
    expect(conclusion.blockers).not.toContain("plane_not_read");
  });
});

describe("agent read plane: capture.planes", () => {
  it("enumerates the whole registry, exactly once each, and validates", () => {
    const { capture } = buildAgentEvidence(onlyFansProvableInput());
    expect(capture.planes).toHaveLength(AGENT_PLANE_NAMES.length);
    expect(capture.planes.map((plane) => plane.plane).sort())
      .toEqual([...AGENT_PLANE_NAMES].sort());
    expect(agentCaptureSchema.safeParse(capture).success).toBe(true);
  });

  it("a plane outside the operation's set is not_applicable and cannot block", () => {
    const { capture } = buildAgentEvidence(onlyFansProvableInput());
    const outside = capture.planes.find((plane) => plane.plane === "transactions");
    expect(outside).toEqual({
      plane: "transactions",
      state: "not_applicable",
      reason: "not_a_source_for_this_claim",
    });
  });

  it("an unread plane can never carry a capture floor", () => {
    // The union shape makes "not read, but here is its floor" inexpressible, and
    // a fabricated floor is how an unread plane starts certifying absences.
    const { capture } = buildAgentEvidence(onlyFansProvableInput({
      planeReads: [],
      planesNotRead: MESSAGE_PLANES.map((plane) => ({
        plane,
        state: "not_read" as const,
        reason: "not_queried_by_this_operation" as const,
      })),
    }));
    for (const plane of capture.planes) {
      if (plane.state !== "read") {
        expect(plane).not.toHaveProperty("captureFloor");
      }
    }
  });
});

describe("agent read plane: scopeFieldStates are computed before any row", () => {
  it("Fansly cannot observe a message price, and says captured_unparsed for media", () => {
    const states = computeScopeFieldStates({
      fields: ["priceMills", "mediaMetadata", "textPlain"],
      platforms: ["fansly"],
    });
    expect(states.priceMills?.state).toBe("not_captured");
    // NOT "structurally absent": the raw page IS journaled, it is simply unparsed,
    // and an agent told "absent" stops investigating where the data is.
    expect(states.mediaMetadata?.state).toBe("captured_unparsed");
    expect(states.textPlain?.state).toBe("present");
  });

  it("a mixed-platform scope takes the WEAKER state", () => {
    const states = computeScopeFieldStates({
      fields: ["priceMills"],
      platforms: ["fansly", "onlyfans"],
    });
    expect(states.priceMills?.state).toBe("not_captured");
  });

  it("a missing capability yields unknown with its real reason, never a silent zero", () => {
    const states = computeScopeFieldStates({
      fields: ["grossMills"],
      platforms: ["onlyfans"],
      ungrantedFields: ["grossMills"],
    });
    expect(states.grossMills).toEqual({
      state: "unknown",
      remedy: { kind: "none", reason: "capability_not_granted" },
    });
  });

  it("an insufficient field state blocks the conclusion", () => {
    const { conclusion } = buildAgentEvidence(onlyFansProvableInput({
      claimFields: ["priceMills"],
      scopeFieldStates: computeScopeFieldStates({
        fields: ["priceMills"],
        platforms: ["fansly"],
      }),
    }));
    expect(conclusion.blockers).toContain("field_state_insufficient");
  });
});

describe("agent read plane: plane sets and proof lanes", () => {
  it("the operation's set is widened by the claim, never narrowed", () => {
    const planes = operationPlanesFor(["message_archive"], ["textPlain"]);
    expect(planes).toContain("message_archive");
    // dm_message_archive is REQUIRED for a message claim, so it must appear in
    // the set as not_read rather than being intersected away with its blocker.
    expect(planes).toContain("dm_message_archive");
  });

  it("only an all-OnlyFans message claim has a proof lane", () => {
    expect(hasProofLaneForClaim(["textPlain"], ["onlyfans"])).toBe(true);
    expect(hasProofLaneForClaim(["textPlain"], ["fansly"])).toBe(false);
    expect(hasProofLaneForClaim(["textPlain"], ["fansly", "onlyfans"])).toBe(false);
    expect(hasProofLaneForClaim(["grossMills"], ["onlyfans"])).toBe(false);
    expect(hasProofLaneForClaim(null, ["onlyfans"])).toBe(false);
  });
});

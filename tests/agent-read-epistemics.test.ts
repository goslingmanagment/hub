import { describe, expect, it } from "vitest";

import { AGENT_PLANE_NAMES, agentCaptureSchema } from "@agency_hub_core/contracts";
import type { PlaneReadWitness } from "@agency_hub_core/db";

import {
  buildAgentEvidence,
  computeScopeFieldStates,
  gapBeforeCaptureFloor,
  operationPlanesFor,
  type AgentEvidenceInput,
} from "../apps/runtime/src/modules/agent-read/index.ts";

// The epistemic invariants of the Agent Read Plane, AFTER the absence-proof
// machinery was removed (owner ruling 2026-08-01).
//
// What is asserted here is what survives, and what the plane is actually for: the
// capture FLOOR, the `before_capture_floor` gap, honest plane states, and a
// blockers list that names every way an answer is narrower than its question.
// There is no `absenceProvable` to test, because there is no longer a route on
// which it could ever have been true.

/**
 * Witnesses are branded and mintable only inside `packages/db`. Tests are outside
 * it, so they cast — which is the point: production code CANNOT do this, because
 * the barrel exports the type and nothing else.
 */
function witness(plane: string, floorAt?: string): PlaneReadWitness {
  return {
    plane,
    captureFloor: floorAt === undefined
      ? { at: null, kind: "unknown" }
      : { at: floorAt, kind: "oldest_stored_row" },
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

/** A fully-read message scope with nothing limiting the answer. */
function unrestrictedInput(overrides: Partial<AgentEvidenceInput> = {}): AgentEvidenceInput {
  return {
    planeMode: "full",
    claimFields: ["textPlain"],
    operationPlanes: MESSAGE_PLANES,
    planeReads: [
      witness("message_archive", "2026-01-01T00:00:00.000Z"),
      witness("dm_message_archive"),
      witness("page_dm_messages"),
      witness("page_dm_threads"),
      witness("observations"),
      witness("sync_raw_payloads"),
    ],
    planesNotRead: [],
    delivery: { snapshotExhausted: true, nextCursor: null },
    cursorConsumed: false,
    cursorCapable: true,
    frozenSnapshot: true,
    requestWindow: { from: "2026-01-08T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z" },
    gaps: [],
    scopeFieldStates: computeScopeFieldStates({
      fields: ["textPlain"],
      platforms: ["onlyfans"],
    }),
    sourceErrors: [],
    scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 3 },
    observedRowFloor: null,
    captureFloor: { at: "2026-01-01T00:00:00.000Z", kind: "oldest_stored_row" },
    ...overrides,
  };
}

describe("agent read plane: the blockers", () => {
  it("an unrestricted answer lists none", () => {
    expect(buildAgentEvidence(unrestrictedInput()).conclusion.blockers).toEqual([]);
  });

  it("THE regression case: a window earlier than the floor names the floor", () => {
    // Asked about 08-20 January for a thread whose archive begins on 21 February.
    // The answer is empty AND says why, with the floor named and a remedy given.
    // This is the entire reason the envelope exists.
    const floorAt = "2026-02-21T00:00:00.000Z";
    const gaps = gapBeforeCaptureFloor({
      plane: "message_archive",
      floorAt,
      windowFrom: "2026-01-08T00:00:00.000Z",
      hydration: { admissible: true, reason: null },
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      kind: "before_capture_floor",
      to: floorAt,
      remedy: { kind: "hydration_request", admissible: true },
    });

    const { conclusion, capture } = buildAgentEvidence(unrestrictedInput({
      captureFloor: { at: floorAt, kind: "oldest_stored_row" },
      gaps,
    }));
    expect(conclusion.blockers).toContain("window_before_capture_floor");
    expect(conclusion.blockers).toContain("gaps_present");
    expect(capture.gaps[0]?.to).toBe(floorAt);
  });

  it("a window at or after the floor produces no gap", () => {
    expect(gapBeforeCaptureFloor({
      plane: "message_archive",
      floorAt: "2026-01-01T00:00:00.000Z",
      windowFrom: "2026-01-08T00:00:00.000Z",
      hydration: { admissible: true, reason: null },
    })).toEqual([]);
  });

  it("an unknown floor is a blocker, not a silent pass", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({
      captureFloor: { at: null, kind: "unknown" },
    }));
    expect(conclusion.blockers).toContain("capture_floor_unknown");
  });

  it("a remedy is NOT admissible when hydration cannot run", () => {
    const gaps = gapBeforeCaptureFloor({
      plane: "message_archive",
      floorAt: "2026-02-21T00:00:00.000Z",
      windowFrom: "2026-01-08T00:00:00.000Z",
      hydration: { admissible: false, reason: "hydration_mode_off" },
    });
    expect(gaps[0]?.remedy).toMatchObject({
      admissible: false,
      reason: "hydration_mode_off",
    });
  });

  it("an inadmissible remedy keeps the CALLER's reason", () => {
    // The mode is OPEN and the key simply may not file a request. Collapsing that
    // into `hydration_mode_off` told the operator to open a mode already open.
    const gaps = gapBeforeCaptureFloor({
      plane: "message_archive",
      floorAt: "2026-02-21T00:00:00.000Z",
      windowFrom: "2026-01-08T00:00:00.000Z",
      hydration: { admissible: false, reason: "capability_not_granted" },
    });
    expect(gaps[0]?.remedy).toMatchObject({
      admissible: false,
      reason: "capability_not_granted",
    });
  });

  it("a failed source narrows the answer and says so", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({
      sourceErrors: [
        { source: "page_dm_messages", code: "statement_timeout", excludedFromCounts: true },
      ],
    }));
    expect(conclusion.blockers).toContain("source_errors_present");
  });

  it("read_only ramp uses the reviewed blocker name", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({ planeMode: "read_only" }));
    expect(conclusion.blockers).toEqual(["read_only_mode"]);
  });

  it("R-008: a consumed cursor blocks; a single request only caveats", () => {
    const consumed = buildAgentEvidence(unrestrictedInput({ cursorConsumed: true }));
    expect(consumed.conclusion.blockers).toEqual(["mutable_sort_key_traversal"]);
    expect(consumed.deliveryCaveats).toEqual([]);

    const single = buildAgentEvidence(unrestrictedInput());
    expect(single.deliveryCaveats).toEqual(["mutable_sort_key"]);
    expect(single.conclusion.blockers).toEqual([]);
  });

  it("a traversal with no frozen bound says so instead of implying one", () => {
    const { deliveryCaveats } = buildAgentEvidence(unrestrictedInput({ frozenSnapshot: false }));
    expect(deliveryCaveats).toContain("no_frozen_snapshot");
  });

  it("an undeclared claim is a refusal of the right to conclude, not an error", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({ claimFields: null }));
    expect(conclusion.blockers).toContain("claim_not_declared");
  });

  it("a claim field with no class fails closed", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({
      claimFields: ["textPlain", "notARealField"],
    }));
    expect(conclusion.blockers).toContain("claim_field_unobservable");
  });

  it("a narrowed grant blocks: an invisible page could hold the answer", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({
      scopeNarrowing: { keyGrantExcludedPages: 3, totalPagesForQuery: 11 },
    }));
    expect(conclusion.blockers).toContain("key_grant_narrowed_scope");
  });

  it("an unread REQUIRED plane blocks; an unread evidentiary one does not", () => {
    const required = buildAgentEvidence(unrestrictedInput({
      planeReads: [witness("message_archive", "2026-01-01T00:00:00.000Z")],
      planesNotRead: [
        { plane: "dm_message_archive", state: "not_read", reason: "onlyfans_only" },
      ],
    }));
    expect(required.conclusion.blockers).toContain("plane_not_read");

    const evidentiary = buildAgentEvidence(unrestrictedInput({
      planeReads: [
        witness("message_archive", "2026-01-01T00:00:00.000Z"),
        witness("dm_message_archive"),
      ],
      planesNotRead: [
        { plane: "observations", state: "not_read", reason: "not_queried_by_this_operation" },
        { plane: "sync_raw_payloads", state: "not_read", reason: "not_queried_by_this_operation" },
      ],
    }));
    expect(evidentiary.conclusion.blockers).not.toContain("plane_not_read");
  });

  it("an unindexed plane is distinguishable from an unread one", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({
      planeReads: [witness("message_archive", "2026-01-01T00:00:00.000Z")],
      planesNotRead: [
        { plane: "dm_message_archive", state: "not_indexed", reason: "not_indexed_for_text_search" },
      ],
    }));
    expect(conclusion.blockers).toContain("plane_not_indexed");
    expect(conclusion.blockers).not.toContain("plane_not_read");
  });
});

describe("agent read plane: capture.planes", () => {
  it("enumerates the whole registry, exactly once each, and validates", () => {
    const { capture } = buildAgentEvidence(unrestrictedInput());
    expect(capture.planes).toHaveLength(AGENT_PLANE_NAMES.length);
    expect(capture.planes.map((plane) => plane.plane).sort())
      .toEqual([...AGENT_PLANE_NAMES].sort());
    expect(agentCaptureSchema.safeParse(capture).success).toBe(true);
  });

  it("a plane outside the operation's set is not_applicable, not not_read", () => {
    const { capture } = buildAgentEvidence(unrestrictedInput());
    expect(capture.planes.find((plane) => plane.plane === "transactions")).toEqual({
      plane: "transactions",
      state: "not_applicable",
      reason: "not_a_source_for_this_claim",
    });
  });

  it("an unread plane can never carry a capture floor", () => {
    // The union shape makes "not read, but here is its floor" inexpressible, and a
    // fabricated floor is how an unread plane starts making claims.
    const { capture } = buildAgentEvidence(unrestrictedInput({
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

  it("a read plane reports the floor its OWN read established", () => {
    const { capture } = buildAgentEvidence(unrestrictedInput());
    expect(capture.planes.find((plane) => plane.plane === "message_archive")).toMatchObject({
      state: "read",
      captureFloor: { at: "2026-01-01T00:00:00.000Z", kind: "oldest_stored_row" },
    });
    // A plane whose read established nothing says `unknown` rather than borrowing
    // a sibling's floor.
    expect(capture.planes.find((plane) => plane.plane === "page_dm_messages")).toMatchObject({
      state: "read",
      captureFloor: { at: null, kind: "unknown" },
    });
  });
});

describe("agent read plane: scopeFieldStates are computed before any row", () => {
  it("Fansly cannot observe a message price, and calls media captured_unparsed", () => {
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

  it("an insufficient field state blocks", () => {
    const { conclusion } = buildAgentEvidence(unrestrictedInput({
      claimFields: ["priceMills"],
      scopeFieldStates: computeScopeFieldStates({
        fields: ["priceMills"],
        platforms: ["fansly"],
      }),
    }));
    expect(conclusion.blockers).toContain("field_state_insufficient");
  });

  it("refunds: Fansly never captured the lane; OF captured it into a store this plane cannot read", () => {
    // The original incident's money half: "no refund rows" читалось как "возврата
    // не было". Neither platform's capture can support that conclusion.
    expect(computeScopeFieldStates({ fields: ["refundState"], platforms: ["fansly"] }).refundState)
      .toEqual({
        state: "not_captured",
        remedy: { kind: "none", reason: "capture_lane_unimplemented" },
      });
    expect(computeScopeFieldStates({ fields: ["refundState"], platforms: ["onlyfans"] }).refundState)
      .toEqual({
        state: "captured_unparsed",
        remedy: { kind: "none", reason: "projection_missing" },
      });
    expect(
      computeScopeFieldStates({ fields: ["refundState"], platforms: ["fansly", "onlyfans"] })
        .refundState?.state,
    ).toBe("not_captured");
  });

  it("a 'no refunds happened' conclusion is blocked on BOTH platforms", () => {
    for (const platform of ["fansly", "onlyfans"] as const) {
      const { conclusion } = buildAgentEvidence(unrestrictedInput({
        claimFields: ["refundState"],
        scopeFieldStates: computeScopeFieldStates({
          fields: ["refundState"],
          platforms: [platform],
        }),
      }));
      expect(conclusion.blockers).toContain("field_state_insufficient");
    }
  });
});

describe("agent read plane: plane sets", () => {
  it("the operation's set is widened by the claim, never narrowed", () => {
    const planes = operationPlanesFor(["message_archive"], ["textPlain"]);
    expect(planes).toContain("message_archive");
    // dm_message_archive is REQUIRED for a message claim, so it must appear in the
    // set as not_read rather than being intersected away with its blocker.
    expect(planes).toContain("dm_message_archive");
  });
});

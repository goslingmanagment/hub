import {
  buildFanslyWireTarget,
  fanslyWireSpec,
  isFanslyApiWireId,
  isFanslyWireId,
  type FanslyWireId,
} from "@agency_hub_core/fansly";

import type { ApplyInput, ApplyResult, RequestPlan, ResourceModule, ShadowResult, StepPlan } from "../../engine/resource.ts";

// `probe.manual` (design §5.22): the owner's one-off read of any wire route,
// `pnpm cli sync probe --page <label> --operation <wire id> --params '<json>'`.
// One admitted request through the page's pacer like every other — never a
// side door — journaled under the route's kind (a body the contract refuses
// under `<kind>:failed`, by the capture), the outcome in the work's result.
// It replaces the legacy endpoint and replay probes (senders #14, #15). In
// shadow it is simulated like any step: nothing is sent.

export interface ProbeParams {
  operation: FanslyWireId;
  params: Record<string, unknown>;
  /** Who asked (the CLI's actor line). */
  requestedBy: string | null;
}

/** The probe a work row asks for, or why it cannot be sent as it stands. */
export function probeRequestOf(params: unknown): { request: RequestPlan } | { refused: string } {
  const record = typeof params === "object" && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const operation = record.operation;
  if (!isFanslyWireId(operation)) return { refused: "probe_operation_unknown" };
  // A CDN hop or the socket's Upgrade is no API read: it needs a work's
  // secret or the page's socket owner.
  if (!isFanslyApiWireId(operation)) return { refused: "probe_operation_not_api" };
  const wireParams = record.params === undefined ? {} : record.params;
  if (typeof wireParams !== "object" || wireParams === null || Array.isArray(wireParams)) return { refused: "probe_params_not_an_object" };
  try {
    // The same target the send would build: a parameter no request may carry
    // is refused here, before anything is admitted.
    buildFanslyWireTarget(operation, wireParams as never);
  } catch {
    return { refused: "probe_params_invalid" };
  }
  return { request: { spec: operation, params: wireParams as never } };
}

export const probeManualModule: ResourceModule = {
  async plan(work): Promise<StepPlan> {
    const probe = probeRequestOf(work.params);
    return "refused" in probe ? { kind: "quarantine", reason: probe.refused } : { kind: "request", request: probe.request };
  },

  async apply(_tx, input: ApplyInput): Promise<ApplyResult> {
    const result = {
      operation: input.request.spec,
      kind: fanslyWireSpec(input.request.spec).kind,
      observationId: input.observation.id,
      receivedAt: input.observation.receivedAt.toISOString(),
      at: input.now.toISOString(),
    };
    return { work: { satisfiesRevision: true, close: "done", closeReason: "probed", result }, followups: [], counters: { probes: 1 } };
  },

  async shadow(_work, request, ctx): Promise<ShadowResult> {
    return {
      work: {
        satisfiesRevision: true,
        close: "done",
        closeReason: "shadow",
        result: { operation: request.spec, shadow: true, at: ctx.now.toISOString() },
      },
      followups: [],
    };
  },
};

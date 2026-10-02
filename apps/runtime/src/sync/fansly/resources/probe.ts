import { countDmLiveMessagesOfChat, markObservationParsed, NEVER_CANONICALIZED_PARSE_VERSION } from "@agency_hub_core/db";
import {
  buildFanslyWireTarget,
  fanslyWireSpec,
  isFanslyApiWireId,
  isFanslyWireId,
  type FanslyMessagesPage,
  type FanslyWireId,
} from "@agency_hub_core/fansly";

import { normalizeFanslyTimestamp } from "../../../services/sync/shared.ts";
import type { OutcomeDecision } from "../../engine/errors.ts";
import type {
  ApplyInput,
  ApplyResult,
  OutcomeStep,
  RequestPlan,
  ResourceModule,
  ShadowResult,
  StepPlan,
} from "../../engine/resource.ts";

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

// ── probe.excluded-chat (step 3, owner decision №8) ─────────────────────────
//
// `probe.excluded-chat` (step-3 design S3-06): does the API serve a chat the
// legacy engine excluded from message sync? One head read of the chat
// (`/message?groupId=<chat>&limit=25`, no `before`) per work, live only, at
// the planned class's ordinary admissions (I1); the subject is the chat.
//
// - 2xx: the answer is journaled (capture before parse) and the apply only
//   stamps its observation `NEVER_CANONICALIZED_PARSE_VERSION`, so neither
//   the inline canonicalization nor the minutely sweep — at this or any later
//   version of the DM family — ever turns a probe into events or archive rows:
//   an excluded chat gets no partial DM state. (A stamp at the family's own
//   version would not hold: its next version bump replays every DM
//   observation below the new version.) The work closes with what the page
//   showed (`served: true`).
// - 403 (`subjectScopedAuthStatuses`: the chat may be forbidden while the
//   session is fine) and the client statuses the entry declares terminal, a
//   `success: false` envelope or a body the contract refuses: the chat's own
//   answer — the work closes `served: false`, with no breaker, no resource
//   hold, no quarantine, no alert. 401 and 429 stay page-wide (plan §9).

/** The registry key of the decision-№8 probe. */
export const EXCLUDED_CHAT_PROBE_KEY = "probe.excluded-chat";

/** What the owner's probe of an excluded chat carries (`sync_work.params`). */
export interface ExcludedChatProbeParams {
  /** The exclusion reason the chat was sampled for. */
  reason: string;
  requestedBy: string | null;
}

/** A closed probe's answer (`sync_work.result`). */
export type ExcludedChatProbeResult =
  | {
    served: true;
    /** Messages on the head page (at most 25). */
    messages: number;
    newestCreatedAt: string | null;
    oldestCreatedAt: string | null;
    /** Ids of the page the socket overlay showed first. */
    liveIdsSeen: number;
    observationId: number;
    receivedAt: string;
  }
  | {
    served: false;
    httpStatus: number | null;
    errorClass: "subject_terminal" | "envelope_unsuccessful" | "contract";
  };

function headRead(groupId: string): RequestPlan<"messages.page"> {
  return { spec: "messages.page", params: { groupId, before: null } };
}

function createdAtIso(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const at = normalizeFanslyTimestamp(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The probe's own account of the outcomes that are the chat's answer. */
export function excludedChatProbeOutcome(decision: OutcomeDecision, step: OutcomeStep): OutcomeDecision {
  switch (decision.errorClass) {
    case "subject_terminal":
    case "envelope_unsuccessful":
    case "contract": {
      const result: ExcludedChatProbeResult = { served: false, httpStatus: step.httpStatus, errorClass: decision.errorClass };
      return {
        ...decision,
        subjectBreaker: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null, terminal: true },
        resourceHold: { action: "keep" },
        quarantineAttempt: false,
        alerts: [],
        work: { action: "close", closeReason: `not_served:${step.httpStatus ?? decision.errorClass}`, result },
      };
    }
    default:
      return decision;
  }
}

export const probeExcludedChatModule: ResourceModule = {
  async plan(work, ctx): Promise<StepPlan> {
    // Live only (the registry's `liveOnly`): a shadow page never probes.
    if (ctx.shadow) return { kind: "done", reason: "shadow" };
    if (work.subject.length === 0) return { kind: "quarantine", reason: "probe_without_chat" };
    return { kind: "request", request: headRead(work.subject) };
  },

  async apply(tx, input: ApplyInput): Promise<ApplyResult> {
    const page = input.parsed as FanslyMessagesPage;
    // Journaled, never canonicalized: no events, no archive rows, no partial
    // DM state for an excluded chat. The stamp is above every family version,
    // present and future, so neither the sweep nor a version bump's replay
    // ever selects the row.
    await markObservationParsed(tx, {
      observationId: input.observation.id,
      receivedAt: input.observation.receivedAt,
      parseVersion: NEVER_CANONICALIZED_PARSE_VERSION,
    });
    const times = page.messages.map((message) => createdAtIso(message.createdAt as unknown)).filter((at): at is string => at !== null).sort();
    const ids = page.messages.flatMap((message) => (typeof message.id === "string" && message.id.length > 0 ? [message.id] : []));
    const result: ExcludedChatProbeResult = {
      served: true,
      messages: page.messages.length,
      newestCreatedAt: times.at(-1) ?? null,
      oldestCreatedAt: times[0] ?? null,
      liveIdsSeen: await countDmLiveMessagesOfChat(tx, { pageId: input.pageId, platformConversationId: input.work.subject, messageIds: ids }),
      observationId: input.observation.id,
      receivedAt: input.observation.receivedAt.toISOString(),
    };
    return {
      work: { satisfiesRevision: true, close: "done", closeReason: "served", result },
      followups: [],
      canonicalized: true,
      counters: { excluded_chat_served: 1 },
    };
  },

  outcome: excludedChatProbeOutcome,

  async shadow(_work, _request, ctx): Promise<ShadowResult> {
    return { work: { satisfiesRevision: true, close: "done", closeReason: "shadow", result: { shadow: true, at: ctx.now.toISOString() } }, followups: [] };
  },
};

import type { AgentHistoryItem, AgentHistoryRequest, AgentSyncPageStatus, AgentSyncWork } from "@agency_hub_core/contracts";
import type { HistoryInputKind } from "@agency_hub_core/db";
import { isIndefinite } from "@agency_hub_core/shared";

import type { PageStatus } from "../engine/status.ts";
import type { WorkWhy } from "../inspect.ts";
import type { HistoryItemView, HistoryRequestView } from "./history.ts";

// History requests on the wire (design §7.4): one shape for the agent plane
// (`routes-agent.ts`) and the owner routes (`routes-sync.ts`), so an agent and
// the owner read the same request the same way. The views already carry ISO
// instants; what changes here is what the wire leaves out (page ids, the
// estimate frozen at submit) and the input kind, which goes back out in the
// vocabulary a caller files it in (`fan`, `conversation`, `chat_url`).

const WIRE_INPUT_KIND: Readonly<Record<HistoryInputKind, AgentHistoryItem["input"]["kind"]>> = {
  fan_platform_user_id: "fan",
  conversation_ref: "conversation",
  chat_url: "chat_url",
};

export function toHistoryRequestWire(view: HistoryRequestView): AgentHistoryRequest {
  return {
    ref: view.ref,
    pageLabel: view.pageLabel,
    state: view.state,
    depth: view.depth,
    requesterKind: view.requesterKind,
    createdAt: view.createdAt,
    doneAt: view.doneAt,
    cancelledAt: view.cancelledAt,
    counts: view.counts,
    reads: view.reads,
    eta: view.eta,
    queuePosition: view.queuePosition,
    waitingReason: view.waitingReason,
    waitingUntil: view.waitingUntil,
  };
}

export function toHistoryItemWire(view: HistoryItemView): AgentHistoryItem {
  return {
    ordinal: view.ordinal,
    input: { kind: WIRE_INPUT_KIND[view.input.kind], ref: view.input.ref },
    fanPlatformUserId: view.fanPlatformUserId,
    conversationRef: view.conversationRef,
    state: view.state,
    refusal: view.refusal,
    excludedReason: view.excludedReason,
    probeAt: view.probeAt,
    waitingReason: view.waitingReason,
    waitingUntil: view.waitingUntil,
    loadedMessages: view.loadedMessages,
    oldestLoadedAt: view.oldestLoadedAt,
    readsSpent: view.readsSpent,
    historyState: view.historyState,
    historyProof: view.historyProof,
    anchorMessageRef: view.anchorMessageRef,
    satisfiedAt: view.satisfiedAt,
    satisfiedBy: view.satisfiedBy,
    estimate: view.estimate,
  };
}

// The engine's page status and "why waiting" on the wire (design §3.9, §7.4):
// one shape for the agent plane (`agentSyncStatus`, `agentSyncWhy`) and the
// owner routes (`syncPages`, `syncPageWork`, `syncPageWorkGet`). The status is
// assembled with ISO instants already; a work row's dates become ISO here, and
// what a finished step left (`result`) stays off the wire — it is the owner
// CLI's (`pnpm cli sync why`), never an agent's.

/** An instant on the wire; an indefinite one (an auth or identity hold only
 *  new credentials lift) has no instant: null. */
function isoOrNull(value: Date | null): string | null {
  return value === null || isIndefinite(value) ? null : value.toISOString();
}

export function toSyncPageStatusWire(status: PageStatus): AgentSyncPageStatus {
  return {
    pageLabel: status.pageLabel,
    mode: status.mode,
    owner: { ...status.owner },
    pause: { ...status.pause },
    sendsLastHour: { ...status.sendsLastHour, byResource: { ...status.sendsLastHour.byResource } },
    queue: {
      urgent: { runnable: status.queue.urgent.runnable, waitingByReason: { ...status.queue.urgent.waitingByReason } },
      requests: { runnable: status.queue.requests.runnable, waitingByReason: { ...status.queue.requests.waitingByReason } },
      planned: { runnable: status.queue.planned.runnable, waitingByReason: { ...status.queue.planned.waitingByReason } },
    },
    holds: {
      page: status.holds.page === null ? null : { ...status.holds.page },
      resources: status.holds.resources.map((hold) => ({ ...hold })),
    },
    breakers: { ...status.breakers },
    quarantined: status.quarantined,
    requests: status.requests.map((request) => ({ ...request })),
    ws: status.ws === null ? null : { ...status.ws },
    shadow: status.shadow === null ? null : { ...status.shadow },
  };
}

export function toSyncWorkWire(why: WorkWhy): AgentSyncWork {
  const { work, waiting } = why;
  return {
    id: work.id,
    resource: work.resource,
    subject: work.subject,
    shadow: work.shadow,
    kind: work.kind,
    class: work.class,
    state: work.state,
    waitingReason: waiting?.reason ?? null,
    waitingUntil: isoOrNull(waiting?.until ?? null),
    dueAt: work.dueAt.toISOString(),
    demandRevision: work.demandRevision,
    appliedRevision: work.appliedRevision,
    failureCount: work.failureCount,
    breakerUntil: isoOrNull(work.breakerUntil),
    blockedByVendorAt: isoOrNull(work.blockedByVendorAt),
    lastAttempt: work.lastAttempt === null
      ? null
      : {
        admittedAt: work.lastAttempt.admittedAt.toISOString(),
        sentAt: isoOrNull(work.lastAttempt.sentAt),
        outcome: work.lastAttempt.outcome,
        httpStatus: work.lastAttempt.httpStatus,
      },
    closedAt: isoOrNull(work.closedAt),
    closeReason: work.closeReason,
  };
}

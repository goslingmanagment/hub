import type { AgentHistoryItem, AgentHistoryRequest } from "@agency_hub_core/contracts";
import type { HistoryInputKind } from "@agency_hub_core/db";

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

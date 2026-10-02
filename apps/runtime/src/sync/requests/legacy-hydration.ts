import { createHash } from "node:crypto";

import type { AgentHydrationLastError, AgentHydrationRequestRecord, AgentHydrationState } from "@agency_hub_core/db";

import type { HistoryDepthInput, HistoryItemView, HistoryRequestDocument, HistoryRequester } from "./history.ts";

// The legacy hydration route on the Fansly Sync Engine (design S2 §7.5, step 3
// §3.5 items 7 H and 10): a Fansly hydration request — one chat, backfilled
// before a boundary — is a one-fan history request with depth
// `before_boundary`. The switch converts the open ones of a page (phase H);
// on a live page the wrapper files every new one. The conversion is
// idempotent by a name-based uuid of the legacy row's ref, and the legacy row
// reads as the history request's state, with the meaning the step-1
// hydration repairs gave the legacy states (`completed` = read to an empty
// page, the whole history).

/** The namespace of the uuids a legacy hydration ref is filed under (fixed:
 *  the same ref always names the same history request). */
export const LEGACY_HYDRATION_UUID_NAMESPACE = "6f0c3a52-9d1e-5b7a-8c44-2e1f0b6a9d35";

/** RFC 4122 §4.3 name-based uuid (version 5, SHA-1). */
export function uuidV5(name: string, namespace: string = LEGACY_HYDRATION_UUID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`Not a uuid namespace: ${namespace}`);
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The history request's idempotency key for a legacy hydration row. */
export function historyKeyOfLegacyHydration(requestRef: string): string {
  return uuidV5(`agent-hydration:${requestRef}`);
}

/** The depth a legacy row asked for: exactly one boundary is set (0117
 *  `agent_hydration_requests_target_bound_check`). */
export function depthOfLegacyHydration(
  row: Pick<AgentHydrationRequestRecord, "targetBeforeAt" | "targetBeforeMessageRef">,
): HistoryDepthInput {
  return row.targetBeforeMessageRef !== null
    ? { kind: "before_boundary", messageRef: row.targetBeforeMessageRef }
    : { kind: "before_boundary", at: row.targetBeforeAt };
}

/** The history request a legacy row becomes (`requester` says who files it). */
export function historyIntakeOfLegacyHydration(
  row: Pick<AgentHydrationRequestRecord, "pageId" | "conversationRef" | "requestRef" | "targetBeforeAt" | "targetBeforeMessageRef">,
  requester: HistoryRequester,
  reason: string,
) {
  return {
    pageId: row.pageId,
    requester,
    fans: [{ kind: "conversation" as const, conversationRef: row.conversationRef }],
    depth: depthOfLegacyHydration(row),
    reason,
    idempotencyKey: historyKeyOfLegacyHydration(row.requestRef),
  };
}

/**
 * What a wrapper row reads as (S2 §7.5): the history request's single fan in
 * the legacy vocabulary. `queued|loading` ⇒ `dispatching`; `ready` by an
 * empty page (or already satisfied on a complete thread) ⇒ `completed`, by a
 * boundary ⇒ `partially_completed`; refused ⇒ `failed`/`vendor_unavailable`;
 * `blocked` ⇒ `failed`/`quarantined` (the vendor keeps refusing the chat: do
 * not refile); cancelled ⇒ `expired`.
 */
export function mirrorLegacyHydrationState(
  document: HistoryRequestDocument,
  thread: { historyState: string | null } | null = null,
): { state: AgentHydrationState; lastError: AgentHydrationLastError } {
  if (document.request.state === "cancelled") return { state: "expired", lastError: "none" };
  const item: HistoryItemView | undefined = document.items[0];
  if (item === undefined) return { state: "dispatching", lastError: "none" };
  switch (item.state) {
    case "queued":
    case "loading":
      return { state: "dispatching", lastError: "none" };
    case "ready": {
      const complete = item.historyState === "complete" || thread?.historyState === "complete";
      if (item.satisfiedBy === "empty_page" || (item.satisfiedBy === "already_satisfied" && complete)) {
        return { state: "completed", lastError: "none" };
      }
      return { state: "partially_completed", lastError: "none" };
    }
    case "refused":
      return { state: "failed", lastError: "vendor_unavailable" };
    case "blocked":
      return { state: "failed", lastError: "quarantined" };
    case "cancelled":
      return { state: "expired", lastError: "none" };
  }
}

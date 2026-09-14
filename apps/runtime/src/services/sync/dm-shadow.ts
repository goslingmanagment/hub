import type { FanslyDmReaderHeadReceipt } from "@agency_hub_core/db";

import type { ConversationHeadDiffReason } from "./fansly-dm-head-diff.ts";
import type { DmShadowState } from "./dm-shadow-state.ts";

export type DmShadowConversation = {
  reasons: readonly ConversationHeadDiffReason[];
  listMessageId: string | null;
  embeddedMessageId: string | null;
  // Raw provider timestamp, before any repair or fallback to stored material.
  timestampMs: number | null;
  previousTimestampMs: number | null;
  previousMessageId: string | null;
  materialConfirmed: boolean | null;
  readerHead?: FanslyDmReaderHeadReceipt | null;
  discoveryToCaptureMs: number | null;
  historyPending: boolean;
  lastHistorySyncAtMs: number | null;
};

function validTimestamp(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function hasValidMarker(conversation: DmShadowConversation) {
  return Boolean(conversation.listMessageId) &&
    conversation.listMessageId === conversation.embeddedMessageId &&
    validTimestamp(conversation.timestampMs);
}

const REASON_COUNTERS = {
  missing_row: "newHeadsBelowStop",
  last_message_id: "changedHeadsBelowStop",
  unread_count: "unreadChangesBelowStop",
  last_unread_message_id: "unreadChangesBelowStop",
  conversation_flags: "flagsChangesBelowStop",
  visibility: "visibilityChangesBelowStop",
  unresolved_identity: "unresolvedIdentityChangesBelowStop",
  message_sync_excluded_reason: "exclusionReasonChangesBelowStop",
  subscription_tier_id: "subscriptionTierChangesBelowStop",
  last_message_at: "headTimestampChangesBelowStop",
  last_message_sender_id: "headSenderChangesBelowStop",
} as const satisfies Record<ConversationHeadDiffReason, keyof DmShadowState>;

function countDiscrepancies(state: DmShadowState, item: DmShadowConversation) {
  // Two unread reasons still count one changed conversation in that category.
  const counters = new Set(item.reasons.map((reason) => REASON_COUNTERS[reason]));
  for (const counter of counters) {
    const value = state[counter];
    if (value !== null) state[counter] = value + 1;
  }
  if (item.reasons.length > 0) state.stateChangesBelowStop += 1;
  if (item.previousMessageId !== null && (
    item.listMessageId === null ||
    (validTimestamp(item.timestampMs) && validTimestamp(item.previousTimestampMs) &&
      item.timestampMs < item.previousTimestampMs)
  )) {
    // A discrepancy category, not a claim that a provider-side deletion happened.
    state.headRollbacksBelowStop += 1;
  }
  if (item.listMessageId !== null && item.materialConfirmed === false) {
    state.missingHotHeadsBelowStop += 1;
  }
}

/** Candidate stop only. The caller still fetches, applies and finalizes its
 * full sweep. A page that establishes the stop is included in its cost. */
export function advanceDmShadow(state: DmShadowState, page: {
  observedAtMs: number;
  responseBytes: number;
  conversations: readonly DmShadowConversation[];
}): DmShadowState {
  const next = { ...state };
  const belowStop = state.stopPage !== null;
  next.pageCount += 1;
  next.maxObservationGapMs = Math.max(
    next.maxObservationGapMs,
    Math.max(0, page.observedAtMs - next.lastObservedAtMs),
  );
  next.lastObservedAtMs = page.observedAtMs;
  let unchanged = page.conversations.length > 0;
  let behindBoundary = state.boundaryMs !== null;

  for (const item of page.conversations) {
    if (item.materialConfirmed === true && item.discoveryToCaptureMs !== null &&
      item.discoveryToCaptureMs >= 0) {
      next.materialLagSamples += 1;
      next.maxDiscoveryToCaptureMs = Math.max(next.maxDiscoveryToCaptureMs, item.discoveryToCaptureMs);
    }
    if (item.materialConfirmed === null) next.unknownMaterialChecks += 1;
    if (item.listMessageId !== null) {
      const reader = item.readerHead;
      if (reader?.state == null) {
        if (next.unknownReaderHeadChecks !== null) next.unknownReaderHeadChecks += 1;
      } else {
        if (next.readerHeadsChecked !== null) next.readerHeadsChecked += 1;
        if (belowStop) {
          const counters = {
            materialized: "readerMaterializedHeadsBelowStop", missing: "readerMissingHeadsBelowStop",
            deleted: "readerDeletedHeadsBelowStop", content_pending: "readerPendingHeadsBelowStop",
          } as const;
          const counter = counters[reader.state];
          if (next[counter] !== null) next[counter] += 1;
          if (reader.state === "materialized" && !reader.liveHotCopy &&
            next.readerArchiveOnlyHeadsBelowStop !== null) next.readerArchiveOnlyHeadsBelowStop += 1;
        }
      }
    }
    const markerValid = hasValidMarker(item);
    if (!markerValid) {
      next.invalidMarkers += 1;
      if (belowStop) next.invalidMarkersBelowStop += 1;
    }
    unchanged &&= item.reasons.length === 0 && markerValid;
    // Strictly below: timestamp ties never establish the boundary.
    behindBoundary &&= markerValid && validTimestamp(item.timestampMs) &&
      state.boundaryMs !== null && item.timestampMs < state.boundaryMs - state.overlapMs;
    if (validTimestamp(item.timestampMs)) {
      if (next.previousTimestampMs === item.timestampMs) next.timestampTies += 1;
      next.previousTimestampMs = item.timestampMs;
      if (item.materialConfirmed === false) {
        next.maxUnconfirmedHeadAgeMs = Math.max(
          next.maxUnconfirmedHeadAgeMs,
          Math.max(0, page.observedAtMs - item.timestampMs),
        );
      }
    }
    if (item.historyPending) {
      next.pendingHistoryCount += 1;
      // Last sync time cannot tell when unfinished history first became due.
      next.unknownHistoryAgeCount += 1;
      if (item.lastHistorySyncAtMs !== null) {
        next.maxHistorySyncAgeMs = Math.max(
          next.maxHistorySyncAgeMs,
          Math.max(0, page.observedAtMs - item.lastHistorySyncAtMs),
        );
      }
    }
    if (belowStop) countDiscrepancies(next, item);
  }

  if (belowStop) {
    next.pagesBelowStop += 1;
    next.bytesBelowStop += page.responseBytes;
    next.conversationsBelowStop += page.conversations.length;
  } else {
    next.unchangedStreak = unchanged && behindBoundary ? next.unchangedStreak + 1 : 0;
    if (next.unchangedStreak >= state.depth) next.stopPage = next.pageCount;
  }
  return next;
}

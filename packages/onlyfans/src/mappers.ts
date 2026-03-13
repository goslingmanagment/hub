import type { TransactionState, TransactionType } from "@agency_hub_core/shared";

export const ONLYMONSTER_MAPPER_VERSION = "onlymonster-phase3-v1";

export function mapOnlyMonsterTransactionType(rawType: string): TransactionType {
  switch (rawType) {
    case "Tip from":
      return "tip";
    case "Payment for message":
      return "message_purchase";
    case "Subscription":
    case "Recurring subscription":
      return "subscription";
    case "Post purchase":
      return "post_purchase";
    case "Live stream":
      return "stream_tip";
    default:
      return "other";
  }
}

export function mapOnlyMonsterTransactionState(rawStatus: string): TransactionState {
  switch (rawStatus) {
    case "loading":
    case "done":
    case "undo":
      return "posted";
    case "pending return":
      return "pending";
    default:
      return "unknown";
  }
}

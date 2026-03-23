import type { TransactionState, TransactionType } from "@agency_hub_core/shared";

export const FANSLY_MAPPER_VERSION = "fansly-phase1-v5";

const FANSLY_SUBSCRIPTION_TRANSACTION_TYPES = [15000, 15001, 6515];
const FANSLY_TIP_TRANSACTION_TYPES = [7001, 7101, 20001];
const FANSLY_MESSAGE_PURCHASE_TRANSACTION_TYPES = [2010, 2016, 2110, 2116];
const FANSLY_POST_PURCHASE_TRANSACTION_TYPES = [32001, 32101];
const FANSLY_STREAM_TIP_TRANSACTION_TYPES = [45001, 45101];
const FANSLY_OTHER_TRANSACTION_TYPES = [42001, 14001, 6002, 6101, 18001, 18002, 24101, 58000];
const KNOWN_FANSLY_TRANSACTION_TYPES = new Set([
  ...FANSLY_SUBSCRIPTION_TRANSACTION_TYPES,
  ...FANSLY_TIP_TRANSACTION_TYPES,
  ...FANSLY_MESSAGE_PURCHASE_TRANSACTION_TYPES,
  ...FANSLY_POST_PURCHASE_TRANSACTION_TYPES,
  ...FANSLY_STREAM_TIP_TRANSACTION_TYPES,
  ...FANSLY_OTHER_TRANSACTION_TYPES,
  16013,
]);

export function isKnownFanslyTransactionType(rawType: number) {
  return KNOWN_FANSLY_TRANSACTION_TYPES.has(rawType);
}

export function mapFanslyTransactionType(rawType: number): TransactionType {
  if (FANSLY_SUBSCRIPTION_TRANSACTION_TYPES.includes(rawType)) {
    return "subscription";
  }

  if (FANSLY_TIP_TRANSACTION_TYPES.includes(rawType)) {
    return "tip";
  }

  if (FANSLY_MESSAGE_PURCHASE_TRANSACTION_TYPES.includes(rawType)) {
    return "message_purchase";
  }

  if (FANSLY_POST_PURCHASE_TRANSACTION_TYPES.includes(rawType)) {
    return "post_purchase";
  }

  if (FANSLY_STREAM_TIP_TRANSACTION_TYPES.includes(rawType)) {
    return "stream_tip";
  }

  if (rawType === 16013) {
    return "payout_reversal";
  }

  if (FANSLY_OTHER_TRANSACTION_TYPES.includes(rawType)) {
    return "other";
  }

  return "other";
}

export function mapFanslyTransactionState(rawStatus: number): TransactionState {
  if (rawStatus === 1) {
    return "pending";
  }
  if (rawStatus === 2) {
    return "posted";
  }
  return "unknown";
}

export function mapFanslySubscriptionStatus(rawStatus: number): string {
  if (rawStatus === 3 || rawStatus === 4) {
    return "active";
  }
  if (rawStatus === 1 || rawStatus === 2 || rawStatus === 10) {
    return "pending";
  }
  if (rawStatus === 5) {
    return "expired";
  }
  if (rawStatus === 6) {
    return "error";
  }
  return "unknown";
}

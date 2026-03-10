import type { TransactionState, TransactionType } from "@fansly-connect/shared";

export const FANSLY_MAPPER_VERSION = "fansly-phase1-v4";

export function mapFanslyTransactionType(rawType: number): TransactionType {
  if ([15000, 15001, 6515].includes(rawType)) {
    return "subscription";
  }

  if ([7001, 7101].includes(rawType)) {
    return "tip";
  }

  if ([2010, 2016, 2110, 2116].includes(rawType)) {
    return "message_purchase";
  }

  if ([32001, 32101].includes(rawType)) {
    return "post_purchase";
  }

  if ([45001, 45101].includes(rawType)) {
    return "stream_tip";
  }

  if (rawType === 16013) {
    return "payout_reversal";
  }

  if ([42001, 14001, 6002, 6101, 18001, 18002, 24101, 58000].includes(rawType)) {
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

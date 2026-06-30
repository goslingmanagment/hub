import type { TransactionState, TransactionType } from "@agency_hub_core/shared";

import type {
  OfapiSpendProjectionCategory,
  OfapiSpendProjectionStatus,
} from "./ofapi-spend-projection-contract.ts";

type IngestibleOfapiSpendStatus = Exclude<OfapiSpendProjectionStatus, "estimated">;

export function mapOfapiSpendCategoryToTransactionType(
  category: OfapiSpendProjectionCategory,
  status: IngestibleOfapiSpendStatus,
): TransactionType {
  if (status === "reversed") {
    return "refund";
  }

  switch (category) {
    case "message":
      return "message_purchase";
    case "tip":
      return "tip";
    case "subscription":
      return "subscription";
    case "post":
      return "post_purchase";
    case "stream":
      return "stream_tip";
    case "other":
      return "other";
  }
}

export function mapOfapiSpendStatusToTransactionState(
  status: IngestibleOfapiSpendStatus,
): TransactionState {
  return status === "pending" ? "pending" : "posted";
}

export function normalizeOfapiSpendAmountMills(
  status: IngestibleOfapiSpendStatus,
  amountMills: bigint,
) {
  return status === "reversed" && amountMills > 0n ? -amountMills : amountMills;
}

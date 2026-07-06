import { describe, expect, it } from "vitest";

import {
  mapFanslyTransactionState,
  mapFanslyTransactionType,
} from "@agency_hub_core/fansly";
import {
  getTransactionClassification,
  transactionTypesByReportingBucket,
} from "@agency_hub_core/shared";

describe("Fansly transaction mapping", () => {
  it("maps known types into the Phase 1 taxonomy", () => {
    expect(mapFanslyTransactionType(15001)).toBe("subscription");
    expect(mapFanslyTransactionType(7101)).toBe("tip");
    expect(mapFanslyTransactionType(20001)).toBe("tip");
    expect(mapFanslyTransactionType(2110)).toBe("message_purchase");
    expect(mapFanslyTransactionType(2016)).toBe("message_purchase");
    expect(mapFanslyTransactionType(2116)).toBe("message_purchase");
    expect(mapFanslyTransactionType(32001)).toBe("post_purchase");
    expect(mapFanslyTransactionType(32101)).toBe("post_purchase");
    expect(mapFanslyTransactionType(45001)).toBe("stream_tip");
    expect(mapFanslyTransactionType(16013)).toBe("payout_reversal");
    expect(mapFanslyTransactionType(42001)).toBe("other");
    expect(mapFanslyTransactionType(14001)).toBe("other");
    expect(mapFanslyTransactionType(999999)).toBe("other");
  });

  it("keeps 2016 and 2116 on message_purchase in Part 1", () => {
    expect(mapFanslyTransactionType(2016)).toBe("message_purchase");
    expect(mapFanslyTransactionType(2116)).toBe("message_purchase");
  });

  it("tracks pending and posted statuses", () => {
    expect(mapFanslyTransactionState(1)).toBe("pending");
    expect(mapFanslyTransactionState(2)).toBe("posted");
    expect(mapFanslyTransactionState(999)).toBe("unknown");
  });

  it("classifies canonical transaction types for reporting and spender analytics", () => {
    expect(transactionTypesByReportingBucket.revenue).toEqual([
      "subscription",
      "tip",
      "message_purchase",
      "post_purchase",
      "stream_tip",
    ]);
    expect(transactionTypesByReportingBucket.adjustment).toEqual([
      "chargeback",
      "refund",
    ]);
    expect(transactionTypesByReportingBucket.unclassified).toEqual([
      "other",
    ]);
    expect(transactionTypesByReportingBucket.excluded).toEqual([
      "payout_reversal",
    ]);

    expect(getTransactionClassification("chargeback")).toEqual({
      bucket: "adjustment",
      affectsSpenderAnalytics: true,
    });
    expect(getTransactionClassification("refund")).toEqual({
      bucket: "adjustment",
      affectsSpenderAnalytics: true,
    });
    expect(getTransactionClassification("other")).toEqual({
      bucket: "unclassified",
      affectsSpenderAnalytics: true,
    });
    expect(getTransactionClassification("payout_reversal")).toEqual({
      bucket: "excluded",
      affectsSpenderAnalytics: false,
    });
  });
});

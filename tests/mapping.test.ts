import { describe, expect, it } from "vitest";

import {
  mapFanslyTransactionState,
  mapFanslyTransactionType,
} from "@fansly-connect/fansly";

describe("Fansly transaction mapping", () => {
  it("maps known types into the Phase 1 taxonomy", () => {
    expect(mapFanslyTransactionType(15001)).toBe("subscription");
    expect(mapFanslyTransactionType(7101)).toBe("tip");
    expect(mapFanslyTransactionType(2110)).toBe("message_purchase");
    expect(mapFanslyTransactionType(32001)).toBe("message_purchase");
    expect(mapFanslyTransactionType(32101)).toBe("message_purchase");
    expect(mapFanslyTransactionType(45001)).toBe("stream_tip");
    expect(mapFanslyTransactionType(16013)).toBe("payout_reversal");
    expect(mapFanslyTransactionType(42001)).toBe("other");
    expect(mapFanslyTransactionType(14001)).toBe("other");
    expect(mapFanslyTransactionType(999999)).toBe("other");
  });

  it("never maps Fansly data to post_purchase in Phase 1", () => {
    const knownTypes = [15001, 7101, 2110, 2116, 32001, 32101, 45001, 42001, 14001];
    expect(knownTypes.some((rawType) => mapFanslyTransactionType(rawType) === "post_purchase")).toBe(false);
  });

  it("tracks pending and posted statuses", () => {
    expect(mapFanslyTransactionState(1)).toBe("pending");
    expect(mapFanslyTransactionState(2)).toBe("posted");
    expect(mapFanslyTransactionState(999)).toBe("unknown");
  });
});

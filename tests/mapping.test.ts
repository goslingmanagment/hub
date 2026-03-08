import { describe, expect, it } from "vitest";

import {
  mapFanslyTransactionState,
  mapFanslyTransactionType,
} from "@fansly-connect/fansly";
import {
  mapOnlyMonsterTransactionState,
  mapOnlyMonsterTransactionType,
} from "../packages/onlyfans/src/index.ts";

describe("Fansly transaction mapping", () => {
  it("maps known types into the Phase 1 taxonomy", () => {
    expect(mapFanslyTransactionType(15001)).toBe("subscription");
    expect(mapFanslyTransactionType(7101)).toBe("tip");
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

  it("maps OnlyMonster strings into the shared taxonomy", () => {
    expect(mapOnlyMonsterTransactionType("Tip from")).toBe("tip");
    expect(mapOnlyMonsterTransactionType("Payment for message")).toBe("message_purchase");
    expect(mapOnlyMonsterTransactionType("Subscription")).toBe("subscription");
    expect(mapOnlyMonsterTransactionType("Recurring subscription")).toBe("subscription");
    expect(mapOnlyMonsterTransactionType("Post purchase")).toBe("post_purchase");
    expect(mapOnlyMonsterTransactionType("Live stream")).toBe("stream_tip");
    expect(mapOnlyMonsterTransactionType("mystery")).toBe("other");
  });

  it("maps OnlyMonster statuses into transaction states", () => {
    expect(mapOnlyMonsterTransactionState("loading")).toBe("posted");
    expect(mapOnlyMonsterTransactionState("done")).toBe("posted");
    expect(mapOnlyMonsterTransactionState("undo")).toBe("posted");
    expect(mapOnlyMonsterTransactionState("pending return")).toBe("pending");
    expect(mapOnlyMonsterTransactionState("mystery")).toBe("unknown");
  });
});

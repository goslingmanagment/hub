import { describe, expect, it } from "vitest";

import { parseStrictOfapiMessagePage } from "../apps/runtime/src/services/ofapi-capture-contract.ts";

function item(id: string, createdAt: string) {
  return { id, createdAt, isSentByMe: false };
}

describe("strict OFAPI message-page contract", () => {
  it("accepts a descending boundary-linked page", () => {
    expect(parseStrictOfapiMessagePage({
      data: [
        item("100", "2026-07-16T12:00:00.000Z"),
        item("99", "2026-07-16T11:59:00.000Z"),
      ],
      _pagination: { next_page: "next" },
    }, {
      requiredBoundaryCursor: "100",
      boundaryIsDuplicate: false,
    })).toMatchObject({ accepted: true, nextCursor: "99" });
  });

  it.each([
    {
      reason: "message_order_invalid",
      data: [
        item("99", "2026-07-16T11:59:00.000Z"),
        item("101", "2026-07-16T12:01:00.000Z"),
      ],
    },
    {
      reason: "message_id_duplicate",
      data: [
        item("99", "2026-07-16T11:59:00.000Z"),
        item("99", "2026-07-16T11:58:00.000Z"),
      ],
    },
  ])("rejects a page that cannot prove its edge: $reason", ({ data, reason }) => {
    expect(parseStrictOfapiMessagePage({
      data,
      _pagination: { next_page: null },
    }, {
      requiredBoundaryCursor: "99",
      boundaryIsDuplicate: true,
    })).toMatchObject({ accepted: false, reason });
  });
});

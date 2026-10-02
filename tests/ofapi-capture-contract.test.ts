import { describe, expect, it } from "vitest";

import {
  parseStrictOfapiMessagePage,
  parseOfapiMessageMaterial,
  validateOfapiInteractiveResponseShape,
} from "../apps/runtime/src/services/ofapi-capture-contract.ts";

function item(id: string, createdAt: string) {
  return { id, createdAt, isSentByMe: false };
}

describe("strict OFAPI message-page contract", () => {
  it("stores ascending interactive facts without granting a history certificate", () => {
    const data = [
      item("100", "2026-07-16T11:50:44Z"),
      item("101", "2026-07-16T11:53:52Z"),
      item("102", "2026-07-16T11:54:40Z"),
    ];
    // Material is independent of direction and pagination evidence; the exact
    // same page remains invalid as a backward history-completeness proof.
    expect(parseOfapiMessageMaterial({ data })).toEqual({ accepted: true, items: data });
    expect(parseStrictOfapiMessagePage({ data, _pagination: { next_page: null } }, {
      requiredBoundaryCursor: "100", boundaryIsDuplicate: false,
    })).toMatchObject({ accepted: false, reason: "message_order_invalid" });
    expect(parseOfapiMessageMaterial({ data: [...data, data[0]] }))
      .toMatchObject({ accepted: false, reason: "message_id_duplicate" });
    expect(parseOfapiMessageMaterial({ data: [...data, { id: "103" }] }))
      .toMatchObject({ accepted: false, reason: "message_item_invalid" });
  });
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
    })).toMatchObject({
      accepted: true,
      boundarySemantics: "inclusive",
      nextCursor: "99",
    });
  });

  it("accepts the production-observed exclusive cursor without inventing a gap", () => {
    expect(parseStrictOfapiMessagePage({
      data: [
        item("99", "2026-07-16T11:59:00.000Z"),
        item("98", "2026-07-16T11:58:00.000Z"),
      ],
      _pagination: { next_page: "next" },
    }, {
      requiredBoundaryCursor: "100",
      boundaryIsDuplicate: false,
    })).toMatchObject({
      accepted: true,
      boundarySemantics: "exclusive",
      boundaryDuplicateCount: 0,
      nextCursor: "98",
    });
  });

  it("rejects an exclusive page containing an item newer than its boundary", () => {
    expect(parseStrictOfapiMessagePage({
      data: [item("101", "2026-07-16T12:01:00.000Z")],
      _pagination: { next_page: null },
    }, {
      requiredBoundaryCursor: "100",
      boundaryIsDuplicate: false,
    })).toMatchObject({
      accepted: false,
      reason: "exclusive_boundary_order_invalid",
    });
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

describe("interactive OFAPI response envelopes", () => {
  it("accepts a welcome-template object and rejects missing or foreign envelopes", () => {
    const operation = "ofapi_gateway_welcome_message";
    expect(validateOfapiInteractiveResponseShape(operation, { data: { id: "123", isActive: false, text: "hi" } })).toBe(true);
    for (const body of [null, {}, { data: null }, { data: [] }, { data: {} }, { data: { success: true } }]) {
      expect(validateOfapiInteractiveResponseShape(operation, body)).toBe(false);
    }
  });
  const arrayListOperations = [
    "ofapi_gateway_chats",
    "ofapi_gateway_chat_messages",
  ];
  const wrappedListOperations = [
    "ofapi_gateway_chat_media",
    "ofapi_gateway_user_list_users",
    "ofapi_gateway_vault_media",
    "ofapi_gateway_vault_lists",
  ];
  const dualListOperations = [
    "ofapi_gateway_transactions",
    "ofapi_gateway_fans_all",
    "ofapi_gateway_fans_active",
    "ofapi_gateway_user_lists",
  ];

  it.each(arrayListOperations)("accepts only the array list envelope for %s", (operation) => {
    expect(validateOfapiInteractiveResponseShape(operation, { data: [] })).toBe(true);
    expect(validateOfapiInteractiveResponseShape(operation, {
      data: { list: [], hasMore: false },
    })).toBe(false);
  });

  it.each(wrappedListOperations)("accepts only the wrapped list envelope for %s", (operation) => {
    expect(validateOfapiInteractiveResponseShape(operation, { data: [] })).toBe(false);
    expect(validateOfapiInteractiveResponseShape(operation, {
      data: { list: [], hasMore: false },
    })).toBe(true);
  });

  it.each(dualListOperations)("accepts both established list envelopes for %s", (operation) => {
    expect(validateOfapiInteractiveResponseShape(operation, { data: [] })).toBe(true);
    expect(validateOfapiInteractiveResponseShape(operation, {
      data: { list: [], hasMore: false },
    })).toBe(true);
  });

  it.each([
    "ofapi_gateway_chat_message",
    "ofapi_gateway_user",
    "ofapi_gateway_vault_media_item",
  ])("accepts an id-bearing single-item envelope for %s", (operation) => {
    expect(validateOfapiInteractiveResponseShape(operation, { data: { id: 42 } })).toBe(true);
    expect(validateOfapiInteractiveResponseShape(operation, { data: { id: "42" } })).toBe(true);
    expect(validateOfapiInteractiveResponseShape(operation, { data: {} })).toBe(false);
    expect(validateOfapiInteractiveResponseShape(operation, { data: { list: [] } })).toBe(false);
  });

  it("accepts only an id-bearing user map for the mass-user surface", () => {
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_users_list", {
      data: {},
    })).toBe(true);
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_users_list", {
      data: { "42": { id: 42 }, "43": { id: "43" } },
    })).toBe(true);
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_users_list", {
      data: { list: [] },
    })).toBe(false);
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_users_list", {
      data: { "42": {} },
    })).toBe(false);
  });

  it("accepts a nonempty bare upload status without pinning vendor state vocabulary", () => {
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_upload_status", {
      status: "processing",
    })).toBe(true);
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_upload_status", {
      status: "future_additive_state",
    })).toBe(true);
    expect(validateOfapiInteractiveResponseShape("ofapi_gateway_upload_status", {
      status: 42,
    })).toBe(false);
  });

  it.each([
    ...arrayListOperations,
    ...wrappedListOperations,
    ...dualListOperations,
    "ofapi_gateway_chat_message",
    "ofapi_gateway_user",
    "ofapi_gateway_vault_media_item",
    "ofapi_gateway_users_list",
    "ofapi_gateway_upload_status",
  ])("rejects missing and null envelopes for the registered operation %s", (operation) => {
    expect(validateOfapiInteractiveResponseShape(operation, {})).toBe(false);
    expect(validateOfapiInteractiveResponseShape(operation, { data: null })).toBe(false);
  });

  it("fails closed for an operation without a registered response family", () => {
    expect(validateOfapiInteractiveResponseShape("future_interactive_operation", {})).toBe(false);
  });
});

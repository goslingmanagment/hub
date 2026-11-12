import { describe, expect, it } from "vitest";

import type { CustomLookalikeRow, CustomOrderRow } from "@agency_hub_core/db";

import { orderFindings, unrecordedFindings } from "../apps/runtime/src/services/custom-orders/checks.ts";

// Заказ кастома, the checks that had nobody to wait for: a sale that looks like a custom went to no one when
// its chatter has no «записывает кастомы» (and nobody has it yet), and an order «записан» or «отказ модели»
// waited for no one at all. Every name and number is made up.

const NOW = new Date("2026-11-12T12:00:00Z");
const HOUR = 3_600_000;
const LEAD = { userId: 900 } as const;

function order(id: number, fields: Partial<CustomOrderRow>): CustomOrderRow {
  return {
    id, pageId: 1, pageLabel: "lora-1", platform: "fansly", modelName: "Lora", fanId: 7, fanRef: "7400000001", fanUsername: "fan_one",
    fanDisplayName: null, buyer: null, fanErasedAt: null, conversationRef: null, card: { task: "Заказ" }, deadlineOn: null, state: "recorded",
    stateAt: NOW, stateNote: null, stateRef: null, givenMessageRef: null, givenAt: null, acceptedByUserId: 11, acceptedBy: "alice",
    acceptedByName: "Alice", origin: "agent", contentopsRef: null, sourceText: null, partsDone: [], personFields: [], version: 1, openRevisions: 0,
    createdAt: NOW, updatedAt: NOW, paidGrossMills: 0, paidNetMills: 0, payments: 0, firstPaidAt: null, telegramRefs: [], ...fields,
  };
}

function sale(transactionId: number, ledByUserIds: number[]): CustomLookalikeRow {
  return {
    transactionId, pageId: 1, pageLabel: "lora-1", platform: "fansly", fanId: 7, fanRef: "7400000001", fanUsername: "fan_one", fanDisplayName: null,
    kind: "tip_note", detail: "for the custom", grossMills: 50_000, at: new Date(NOW.getTime() - 30 * HOUR), ledByUserIds,
  };
}

describe("custom checks: every finding waits for someone", () => {
  it("gives a sale that looks like a custom to the lead when its chatter does not record customs, to the chatter when they do", () => {
    const findings = unrecordedFindings({ sales: [sale(501, [11]), sale(502, [12, 11]), sale(503, [])], recorders: new Set([12]), lead: LEAD });
    expect(findings.map((finding) => [finding.key, finding.owner])).toEqual([
      ["custom.unrecorded:501", LEAD],
      ["custom.unrecorded:502", { userId: 12 }],
      ["custom.unrecorded:503", LEAD],
    ]);
  });

  it("puts an order left «записан» or «отказ модели» before the lead, deadline or not", () => {
    const orders = [
      order(101, { state: "recorded", stateAt: new Date(NOW.getTime() - 25 * HOUR) }),
      order(102, { state: "recorded", stateAt: new Date(NOW.getTime() - 2 * HOUR) }),
      order(103, { state: "refused", stateAt: new Date(NOW.getTime() - 13 * HOUR), stateNote: "не снимаю такое" }),
      order(104, { state: "refused", stateAt: new Date(NOW.getTime() - 1 * HOUR) }),
    ];
    const findings = orderFindings({ orders, now: NOW, lead: LEAD, recorders: new Set(), onShift: new Map() })["custom.not_at_model"];
    expect(findings.map((finding) => [finding.key, finding.owner])).toEqual([
      ["custom.not_at_model:K-101", LEAD],
      ["custom.not_at_model:K-103", LEAD],
    ]);
    expect(findings[1]!.title).toContain("отказ");
  });
});

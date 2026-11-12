import { describe, expect, it } from "vitest";

import { CUSTOM_ORDER_STATES } from "@agency_hub_core/contracts";

import { extensionStateOf, extensionStepOf } from "../apps/runtime/src/services/custom-orders/rules.ts";

// The released extension knows four states. An order at the model, shot or in
// revision whose payment is written in the card (no sale linked) once read
// «ждёт оплаты N дней» there: only a recorded order no sale pays waits for its
// payment. Beside the four states the wire carries the order's real step.

describe("a custom order on the extension's wire", () => {
  it("waits for its payment only while it is recorded and no sale pays it", () => {
    const unpaid = Object.fromEntries(CUSTOM_ORDER_STATES.map((state) => [state, extensionStateOf({ state, payments: 0 })]));
    expect(unpaid).toEqual({
      recorded: "ordered",
      paid: "paid",
      at_model: "paid",
      partly: "paid",
      shot: "paid",
      revision: "paid",
      refused: "cancelled",
      given: "delivered",
      closed: "delivered",
      cancelled: "cancelled",
    });
    expect(extensionStateOf({ state: "recorded", payments: 1 })).toBe("paid");
  });

  it("names the order's step in the board's words, since when, and its code", () => {
    const stateAt = new Date("2026-11-10T12:00:00.000Z");
    expect(extensionStepOf({ id: 123, state: "at_model", stateAt })).toEqual({ code: "K-123", stepLabel: "У модели", stepAt: "2026-11-10T12:00:00.000Z" });
    expect(extensionStepOf({ id: 7, state: "shot", stateAt }).stepLabel).toBe("Снят");
  });
});

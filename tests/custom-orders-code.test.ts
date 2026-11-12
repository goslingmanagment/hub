import { describe, expect, it } from "vitest";

import { customOrderCode, customOrderCodeSchema, findCustomOrderCode, parseCustomOrderCode } from "@agency_hub_core/contracts";

import { parseCardText } from "../apps/runtime/src/services/custom-orders/rules.ts";

// Заказ кастома, the code as people type it (final review, round 2): on a Russian keyboard «К-123» is the Cyrillic
// letter, and a card whose title carried it was read as a card with no code — a second order for the same custom.

const CYRILLIC = "К-123";

describe("a custom order's code in text", () => {
  it("reads the Latin and the Cyrillic letter alike, in the card's title and as a typed code, and prints the Latin one", () => {
    expect(CYRILLIC).not.toBe("K-123");
    for (const title of ["K-123", CYRILLIC, "к-123", "k-123", "K - 123", "К123", `(${CYRILLIC})`, `№ ${CYRILLIC}`]) {
      expect(parseCardText(`📦 Описание заказа ${title}\nДата: 12.11.2026\n🎥 Описание задания: 1. В белом`).code, title).toBe(123);
    }
    // What the agent's and the board's doors take as an order's code (`hub custom list --code`, the order's address).
    for (const typed of ["K-123", CYRILLIC, "к-123", "#K-123", "К123"]) {
      expect(parseCustomOrderCode(typed), typed).toBe(123);
      expect(customOrderCodeSchema.safeParse(typed).success, typed).toBe(true);
    }
    expect(customOrderCode(123)).toBe("K-123");
  });

  it("takes no code out of words that only hold the letter", () => {
    for (const title of ["", "для Kate", "к 5 фото", "пак-5", "rock-12", "K-0", "K-"]) {
      expect(parseCardText(`📦 Описание заказа ${title}\n🎥 Описание задания: x`).code, title).toBeNull();
    }
    expect(findCustomOrderCode("заказ K-1234567890123456789")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { sameSaleOf } from "../apps/runtime/src/services/sale-decisions-door.ts";

// What a decision may replace and answer through the agent's door (final review, round 2): only what is about the very
// sale; with no sale named, the same page and fan. Money: a decision that replaced another sale's left that sale
// undecided and its reports as they were. Synthetic ids.

const sale = { transactionId: 501, fan: { fanRef: "7700000042", name: "Fan", username: "fan_login" } };
const was = (transactionId: number | null, pageId: number | null, fanRef?: string) => ({ transactionId, pageId, ledgerRef: fanRef === undefined ? null : { pageLabel: "page-a", fanRef } });

describe("what a decision «со слов» may replace and answer", () => {
  it("takes one that names a sale only for that very sale", () => {
    expect(sameSaleOf({ sale, pageId: 1, fanRef: null }, was(501, 1))).toBe(true);
    expect(sameSaleOf({ sale, pageId: 1, fanRef: null }, was(502, 1))).toBe(false);
    // Words alone never stand for a sale that is named.
    expect(sameSaleOf({ sale: null, pageId: 1, fanRef: "7700000042" }, was(501, 1, "7700000042"))).toBe(false);
  });

  it("takes one that names no sale for the same page and the same fan", () => {
    expect(sameSaleOf({ sale: null, pageId: 1, fanRef: "Fan_Login" }, was(null, 1, "fan_login"))).toBe(true);
    expect(sameSaleOf({ sale: null, pageId: 1, fanRef: "other" }, was(null, 1, "fan_login"))).toBe(false);
    expect(sameSaleOf({ sale: null, pageId: 2, fanRef: "fan_login" }, was(null, 1, "fan_login"))).toBe(false);
    // Neither names a fan: the page's own (money outside the platform recorded with no fan).
    expect(sameSaleOf({ sale: null, pageId: 1, fanRef: null }, was(null, 1))).toBe(true);
    expect(sameSaleOf({ sale: null, pageId: 1, fanRef: "fan_login" }, was(null, 1))).toBe(false);
    // One that names no page is nobody's.
    expect(sameSaleOf({ sale: null, pageId: 1, fanRef: "fan_login" }, was(null, null, "fan_login"))).toBe(false);
  });

  it("knows the fan of a named sale by his id, his login and «u» with his id", () => {
    for (const ref of ["7700000042", "FAN_LOGIN", "u7700000042"]) {
      expect(sameSaleOf({ sale, pageId: 1, fanRef: null }, was(null, 1, ref)), ref).toBe(true);
    }
    expect(sameSaleOf({ sale, pageId: 1, fanRef: null }, was(null, 1, "someone_else"))).toBe(false);
    expect(sameSaleOf({ sale, pageId: 1, fanRef: null }, was(null, 1))).toBe(false);
    expect(sameSaleOf({ sale, pageId: 2, fanRef: null }, was(null, 1, "7700000042"))).toBe(false);
  });
});

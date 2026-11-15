import { describe, expect, it } from "vitest";

import { potOfferDecision } from "../apps/runtime/src/services/sale-claims.ts";

// A sale its holder gave to the pot (the board's «в общак»): the owner's three answers are the existing decisions — no
// kind, outcome or source the decisions' feed does not know — and the person's word follows each.
describe("the owner's answers to a sale given to the pot", () => {
  it("«В общак»: the page's pot, the word kept", () => {
    expect(potOfferDecision("pot", 7)).toEqual({ kind: "pot", shares: [], pot: "obshak", outcome: "said", word: "pot" });
  });

  it("«Вернуть»: the whole sale to the person, the word withdrawn", () => {
    expect(potOfferDecision("return", 7)).toEqual({ kind: "split", shares: [{ userId: 7, percent: 100 }], pot: null, outcome: "first", word: null });
  });

  it("«Никому»: nobody's, the word «ничья»", () => {
    expect(potOfferDecision("nobody", 7)).toEqual({ kind: "nobody", shares: [], pot: null, outcome: "nobody", word: "not_mine" });
  });
});

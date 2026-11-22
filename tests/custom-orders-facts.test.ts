import { describe, expect, it } from "vitest";

import { customOrderFactsOf, type CustomFactsInput, type CustomFactValue } from "@agency_hub_core/contracts";

// An order is four facts (customs facts spec §4), derived from its state and its money at read time: whether the fan's
// money arrived, whether the model has the card, whether she delivered everything, whether the fan has every file.
// «Paid» is never «yes» while the price is unknown, a reversed sale is a conflict, the owner's word settles it; «given»
// is «yes» only once the order is given. One table of states and money against the four values; every sum is made up.

const NONE: CustomFactsInput = { state: "recorded", priceMills: null, payments: 0, paidGrossMills: 0, paymentReversed: false, paidWord: null, sentAt: null };

type Four = [paid: CustomFactValue, atModel: CustomFactValue, shot: CustomFactValue, given: CustomFactValue];

const CASES: ReadonlyArray<[string, Partial<CustomFactsInput>, Four]> = [
  ["recorded, nothing pays it", {}, ["wait", "no", "no", "no"]],
  ["recorded, a sale and no price", { payments: 1, paidGrossMills: 50_000 }, ["part", "wait", "no", "no"]],
  ["recorded, the price not reached", { priceMills: 150_000, payments: 1, paidGrossMills: 100_000 }, ["part", "wait", "no", "no"]],
  ["recorded, the price reached by two sales", { priceMills: 150_000, payments: 2, paidGrossMills: 150_000 }, ["yes", "wait", "no", "no"]],
  ["«paid» by an import, no sale linked", { state: "paid" }, ["wait", "no", "no", "no"]],
  ["checked, paid over the price", { state: "checked", priceMills: 100_000, payments: 1, paidGrossMills: 120_000 }, ["yes", "wait", "no", "no"]],
  ["recorded, the owner's word: a gift", { paidWord: { kind: "gift" } }, ["yes", "wait", "no", "no"]],
  ["at the model, nothing pays it", { state: "at_model" }, ["no", "yes", "wait", "no"]],
  ["at the model, part of the money", { state: "at_model", priceMills: 200_000, payments: 1, paidGrossMills: 100_000 }, ["part", "yes", "wait", "no"]],
  ["partly delivered, paid", { state: "partly", priceMills: 100_000, payments: 1, paidGrossMills: 100_000 }, ["yes", "yes", "part", "no"]],
  ["in revision, its sale reversed", { state: "revision", priceMills: 100_000, payments: 1, paidGrossMills: 100_000, paymentReversed: true }, ["conflict", "yes", "wait", "no"]],
  ["given, its only sale retired beside its reversal", { state: "given", priceMills: 100_000, paymentReversed: true }, ["conflict", "yes", "yes", "yes"]],
  ["reversed, the owner's word: paid outside",{ state: "revision", payments: 1, paidGrossMills: 100_000, paymentReversed: true, paidWord: { kind: "off_platform" } }, ["yes", "yes", "wait", "no"]],
  ["refused by the model", { state: "refused", priceMills: 100_000, payments: 1, paidGrossMills: 100_000 }, ["yes", "yes", "conflict", "no"]],
  ["shot, nothing sent", { state: "shot", priceMills: 100_000, payments: 1, paidGrossMills: 100_000 }, ["yes", "yes", "yes", "wait"]],
  ["shot, sent and not opened", { state: "shot", priceMills: 100_000, payments: 1, paidGrossMills: 100_000, sentAt: "2026-11-20T10:00:00.000Z" }, ["yes", "yes", "yes", "part"]],
  ["shot, paid after it is ready, nothing yet", { state: "shot" }, ["no", "yes", "yes", "wait"]],
  ["given", { state: "given", priceMills: 100_000, payments: 1, paidGrossMills: 100_000 }, ["yes", "yes", "yes", "yes"]],
  ["given, the price never named", { state: "given", payments: 1, paidGrossMills: 100_000 }, ["part", "yes", "yes", "yes"]],
  ["closed", { state: "closed", priceMills: 100_000, payments: 1, paidGrossMills: 100_000 }, ["yes", "yes", "yes", "yes"]],
  ["cancelled (its sales released)", { state: "cancelled", priceMills: 100_000 }, ["no", "no", "no", "no"]],
];

describe("the four facts of a custom order", () => {
  it("follow its state and its money", () => {
    const got = CASES.map(([label, input]) => {
      const facts = customOrderFactsOf({ ...NONE, ...input });
      return [label, [facts.paid.value, facts.atModel.value, facts.shot.value, facts.given.value]];
    });
    expect(got).toEqual(CASES.map(([label, , four]) => [label, four]));
  });
});

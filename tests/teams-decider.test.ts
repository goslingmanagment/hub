import { describe, expect, it } from "vitest";

import type { SaleClaimRow, TeamFacts } from "@agency_hub_core/db";

import { disputeDeciderOf } from "../apps/runtime/src/services/sale-claims.ts";
import { deciderOf, teamsOfPerson } from "../apps/runtime/src/services/teams.ts";

// Who decides (products package T): `deciderOf` is the one rule the board's texts, the dispute's matter and the right
// to decide read. Pure over the team facts.

const at = new Date("2026-11-15T10:00:00Z");
function facts(roles: Array<{ personId: number; modelId: number; kind: "lead" | "customs" | "view" }>): TeamFacts {
  return {
    pages: [{ pageId: 11, modelId: 1, test: false }, { pageId: 21, modelId: 2, test: false }],
    models: [{ modelId: 1, slug: "alfa", name: "Alfa", test: false }, { modelId: 2, slug: "bravo", name: "Bravo", test: false }],
    working: [{ personId: 100, pageId: 11 }, { personId: 101, pageId: 11 }, { personId: 102, pageId: 11 }, { personId: 200, pageId: 21 }],
    roles: roles.map((role, index) => ({ id: index + 1, grantedByUserId: null, grantedAt: at, ...role })),
    logins: [{ userId: 1000, personId: 100 }, { userId: 1010, personId: 101 }, { userId: 1011, personId: 101 }, { userId: 1020, personId: 102 }, { userId: 2000, personId: 200 }],
    people: [{ personId: 100, name: "Марта", test: false, role: "chatter" }, { personId: 101, name: "Олег", test: false, role: "chatter" }, { personId: 102, name: "Аня", test: false, role: "chatter" }, { personId: 200, name: "Боря", test: false, role: "chatter" }],
  };
}

const lead = facts([{ personId: 100, modelId: 1, kind: "lead" }]);

describe("deciderOf", () => {
  it("a dispute of a team with a lead is the lead's, by their newest login", () => {
    expect(deciderOf(lead, 1, "dispute", [101, 102])).toEqual({ kind: "team_lead", personId: 100, userId: 1000, name: "Марта" });
  });
  it("a lead who is a side does not decide: the owner does", () => {
    expect(deciderOf(lead, 1, "dispute", [100, 101])).toEqual({ kind: "owner" });
  });
  it("a team with no lead: the owner; another team's lead never decides it", () => {
    expect(deciderOf(lead, 2, "dispute", [200])).toEqual({ kind: "owner" });
    expect(deciderOf(facts([]), 1, "dispute", [])).toEqual({ kind: "owner" });
  });
  it("the pot and «мимо площадки» are the owner's even with a lead", () => {
    expect(deciderOf(lead, 1, "pot")).toEqual({ kind: "owner" });
    expect(deciderOf(lead, 1, "off_platform")).toEqual({ kind: "owner" });
  });
  it("customs: the model's customs lead first, then the team lead", () => {
    const both = facts([{ personId: 100, modelId: 1, kind: "lead" }, { personId: 101, modelId: 1, kind: "customs" }]);
    expect(deciderOf(both, 1, "customs")).toMatchObject({ kind: "team_lead", personId: 101, userId: 1011 });
    expect(deciderOf(lead, 1, "customs")).toMatchObject({ kind: "team_lead", personId: 100 });
  });
  it("a chatter who leads stays in their team; «видит» adds a team, leads nothing", () => {
    const viewing = facts([{ personId: 100, modelId: 1, kind: "lead" }, { personId: 200, modelId: 1, kind: "view" }]);
    expect(teamsOfPerson(viewing, 100)).toMatchObject({ mine: [1], lead: [1] });
    expect(teamsOfPerson(viewing, 200)).toMatchObject({ mine: [2], view: [1], lead: [] });
  });
});

describe("a dispute's addressee", () => {
  const claim = (over: Partial<SaleClaimRow>) => ({
    id: 1, transactionId: 5, pageId: 11, kind: "claim", claimantUserId: 1010, sideUserId: 1020, ...over,
  }) as unknown as SaleClaimRow;
  it("two chatters of a led team: the lead", () => {
    expect(disputeDeciderOf(lead, [claim({})], 11)).toMatchObject({ kind: "team_lead", userId: 1000 });
  });
  it("the lead is a side: the owner", () => {
    expect(disputeDeciderOf(lead, [claim({ sideUserId: 1000 })], 11)).toEqual({ kind: "owner" });
  });
  it("no colleague to ask (the pot's, nobody's) and the ledger's questions: the owner", () => {
    expect(disputeDeciderOf(lead, [claim({ sideUserId: null })], 11)).toEqual({ kind: "owner" });
    expect(disputeDeciderOf(lead, [claim({ kind: "imported" })], 11)).toEqual({ kind: "owner" });
  });
  it("a page of a team with no lead: the owner", () => {
    expect(disputeDeciderOf(lead, [claim({ pageId: 21, claimantUserId: 2000, sideUserId: 1010 })], 21)).toEqual({ kind: "owner" });
  });
});

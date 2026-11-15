import { describe, expect, it } from "vitest";

import { mayTakeStep, type CustomViewer } from "@agency_hub_core/contracts";
import type { TeamFacts } from "@agency_hub_core/db";

import { customStepLeader, ledPhasesOf, phaseLeader, type CustomLeader } from "../apps/runtime/src/services/custom-orders/leaders.ts";

/**
 * Who leads each step of a custom order (products plan §4.5, package C3): the check — the team lead, else the customs
 * lead, else the owner; the shooting — the content manager, else the customs lead, else the owner; the giving — the
 * chatter who took it. And the rights follow it: someone who does not lead a step is refused it. Made-up people.
 */

// Model 1 (pages 11, 12): a team lead (person 1), a customs lead (person 2), a content manager (person 3).
// Model 2 (page 21): only a customs lead (person 2). Model 3 (page 31): nobody. Model 4 (page 41): a team lead only.
const FACTS: TeamFacts = {
  pages: [
    { pageId: 11, modelId: 1, test: false }, { pageId: 12, modelId: 1, test: false },
    { pageId: 21, modelId: 2, test: false }, { pageId: 31, modelId: 3, test: false }, { pageId: 41, modelId: 4, test: false },
  ],
  models: [1, 2, 3, 4].map((modelId) => ({ modelId, slug: `m${modelId}`, name: `M${modelId}`, test: false })),
  working: [{ personId: 3, pageId: 11 }, { personId: 4, pageId: 11 }, { personId: 4, pageId: 21 }],
  roles: [
    { id: 1, personId: 1, modelId: 1, kind: "lead", grantedByUserId: null, grantedAt: new Date(0) },
    { id: 2, personId: 2, modelId: 1, kind: "customs", grantedByUserId: null, grantedAt: new Date(0) },
    { id: 3, personId: 2, modelId: 2, kind: "customs", grantedByUserId: null, grantedAt: new Date(0) },
    { id: 4, personId: 1, modelId: 4, kind: "lead", grantedByUserId: null, grantedAt: new Date(0) },
  ],
  logins: [
    { userId: 101, personId: 1, role: "chatter" },
    { userId: 102, personId: 2, role: "chatter" },
    { userId: 103, personId: 3, role: "content_manager" },
    { userId: 104, personId: 4, role: "chatter" },
  ],
  people: [1, 2, 3, 4].map((personId) => ({ personId, name: `P${personId}`, test: false, role: "chatter" })),
};

const who = (leader: CustomLeader) => (leader.kind === "owner" ? "owner" : leader.userId);

describe("who leads each step of a custom order", () => {
  it("the check: the team lead, else the customs lead, else the owner", () => {
    expect(who(phaseLeader(FACTS, 12, "check", null))).toBe(101);
    expect(who(phaseLeader(FACTS, 21, "check", null))).toBe(102);
    expect(who(phaseLeader(FACTS, 31, "check", null))).toBe("owner");
  });

  it("the shooting: the content manager, else the customs lead, else the owner (never the team lead)", () => {
    expect(who(phaseLeader(FACTS, 12, "shoot", null))).toBe(103);
    expect(who(phaseLeader(FACTS, 21, "shoot", null))).toBe(102);
    expect(who(phaseLeader(FACTS, 31, "shoot", null))).toBe("owner");
    expect(who(phaseLeader(FACTS, 41, "shoot", null))).toBe("owner");
  });

  it("an order of no known page: the person right's holder, else the owner", () => {
    const fallback: CustomLeader = { kind: "person", personId: 2, userId: 102, name: "P2" };
    expect(who(phaseLeader(FACTS, null, "shoot", fallback))).toBe(102);
    expect(who(phaseLeader(FACTS, null, "check", null))).toBe("owner");
  });

  it("the step by state, with its product; the giving is the chatter's who took it, else the check's", () => {
    const step = (state: "recorded" | "checked" | "shot" | "closed", acceptedByUserId: number | null) =>
      customStepLeader(FACTS, { pageId: 11, state, acceptedByUserId }, null);
    expect(step("recorded", 104)).toMatchObject({ phase: "check", product: "workboard", leader: { userId: 101 } });
    expect(step("checked", 104)).toMatchObject({ phase: "shoot", product: "contentops", leader: { userId: 103 } });
    expect(step("shot", 104)).toMatchObject({ phase: "give", product: "workboard", leader: { userId: 104, name: "P4" } });
    expect(step("shot", null)).toMatchObject({ phase: "give", leader: { userId: 101 } });
    expect(step("closed", 104)).toBeNull();
  });

  it("a record of a person with no living login leads nothing", () => {
    const facts = { ...FACTS, logins: FACTS.logins.filter((login) => login.personId !== 1) };
    expect(who(phaseLeader(facts, 11, "check", null))).toBe(102);
  });
});

describe("the rights of each step follow its leader", () => {
  const viewer = (userId: number, role: CustomViewer["role"] = "chatter"): CustomViewer => ({
    userId, role, pageIds: [11, 12, 21, 31, 41], lead: false, leads: ledPhasesOf(FACTS, userId, false),
  });
  const order = (state: "recorded" | "checked" | "at_model" | "shot" | "given", pageId = 11) => ({ pageId, state, acceptedByUserId: 104 });

  it("«Проверен» is the check's leader's: the customs lead is refused it where a team lead is", () => {
    expect(mayTakeStep(viewer(101), order("recorded"), "checked")).toBe(true);
    expect(mayTakeStep(viewer(102), order("recorded"), "checked")).toBe(false);
    expect(mayTakeStep(viewer(102), order("recorded", 21), "checked")).toBe(true);
    expect(mayTakeStep(viewer(104), order("recorded"), "checked")).toBe(false);
  });

  it("the shooting's steps are the shooting leader's: not the team lead's, not the chatter's", () => {
    for (const step of ["at_model"] as const) {
      expect(mayTakeStep(viewer(103), order("checked"), step)).toBe(true);
      expect(mayTakeStep(viewer(101), order("checked"), step)).toBe(false);
      expect(mayTakeStep(viewer(102), order("checked"), step)).toBe(false);
      expect(mayTakeStep(viewer(104), order("checked"), step)).toBe(false);
    }
    for (const step of ["shot", "partly", "refused"] as const) {
      expect(mayTakeStep(viewer(103), order("at_model"), step)).toBe(true);
      expect(mayTakeStep(viewer(101), order("at_model"), step)).toBe(false);
    }
    expect(mayTakeStep(viewer(103), order("shot"), "revision")).toBe(true);
    expect(mayTakeStep(viewer(104), order("shot"), "revision")).toBe(false);
    // A fan's complaint after «отдан»: the check's leader too.
    expect(mayTakeStep(viewer(101), order("given"), "revision")).toBe(true);
    // Where no content manager is, the customs lead takes them.
    expect(mayTakeStep(viewer(102), order("checked", 21), "at_model")).toBe(true);
  });

  it("«Отдан» is any chatter's who sees it; the owner takes every step; nobody's model is the owner's", () => {
    expect(mayTakeStep(viewer(104), order("shot"), "given")).toBe(true);
    expect(mayTakeStep(viewer(1, "owner"), order("at_model", 31), "shot")).toBe(true);
    expect(mayTakeStep(viewer(102), order("at_model", 31), "shot")).toBe(false);
  });
});

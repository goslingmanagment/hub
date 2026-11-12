import { describe, expect, it } from "vitest";

import {
  CUSTOM_ORDER_CHECK_KINDS,
  MATTER_CHECK_KINDS,
  MATTER_INFO_KINDS,
  MATTER_MIRROR_KINDS,
  MATTER_PERSON_START_KINDS,
  MATTER_SERVER_KINDS,
  REPORT_POST_MATTER_KINDS,
  SALE_CLAIM_MATTER_KINDS,
  SHIFT_REPORT_MATTER_KINDS,
  WAITING_GROUPS,
  waitingGroupOf,
} from "@agency_hub_core/contracts";

import { buildWaitingGroups, type MatterKindState } from "../apps/runtime/src/services/matters.ts";

// «Ждут вас» is grouped in one place (contracts waiting-groups.ts): the list's groups and the console Home's chips.
// Every kind a package's list declares has a group of its own — never «Другие дела», which would hide it on one side —
// and the Home's chips count exactly what the list shows.

const PACKAGE_KINDS: Readonly<Record<string, readonly string[]>> = {
  "mirror (D)": MATTER_MIRROR_KINDS,
  "system state (P)": MATTER_SERVER_KINDS,
  "shift report (F)": SHIFT_REPORT_MATTER_KINDS,
  "newcomer (J)": MATTER_PERSON_START_KINDS,
  "checks (K)": MATTER_CHECK_KINDS,
  "posts to fix (K)": REPORT_POST_MATTER_KINDS,
  "custom checks (I)": CUSTOM_ORDER_CHECK_KINDS,
  "claims (G)": SALE_CLAIM_MATTER_KINDS,
};

describe("«Ждут вас»: one table of groups", () => {
  it("gives every kind of every package's list a group, «Для сведения» only to what informs", () => {
    const ungrouped = Object.entries(PACKAGE_KINDS).flatMap(([pkg, kinds]) => kinds.filter((kind) => waitingGroupOf(kind) === "other").map((kind) => `${pkg}: ${kind}`));
    expect(ungrouped, "a kind of a package's list falls in «Другие дела»: give it a group in contracts/src/waiting-groups.ts").toEqual([]);
    const info = Object.values(PACKAGE_KINDS).flat().filter((kind) => waitingGroupOf(kind) === "info");
    expect(info.sort()).toEqual([...MATTER_INFO_KINDS].sort());
    // ContentOps' findings are an agent's kinds by prefix.
    expect(waitingGroupOf("contentops.custom_copy")).toBe("content");
    expect(WAITING_GROUPS.map((group) => group.id)).toContain(waitingGroupOf("an.agent_kind"));
  });

  it("counts the Home's chips as the list does: one per matter, the custom orders in «Кастомы», nothing for what informs", () => {
    const known: MatterKindState = { checked: true, applicable: true, capped: false };
    const matters = [
      { id: 1, kind: "sale.dispute", pageIds: [], evidence: {} },
      { id: 2, kind: "ledger.sale_question", pageIds: [], evidence: {} },
      { id: 3, kind: "custom.overdue_owner", pageIds: [], evidence: {} },
      { id: 4, kind: "routine.empty", pageIds: [], evidence: {} },
      { id: 5, kind: "extension.critical", pageIds: [], evidence: { total: 7 } },
      { id: 6, kind: "an.agent_kind", pageIds: [], evidence: {} },
    ];
    const groups = buildWaitingGroups({ matters, kindState: () => known, trackedKinds: [], customOrders: 4 });
    expect(groups.map((group) => [group.id, group.count])).toEqual([["questions", 2], ["customs", 5], ["system", 2], ["other", 1]]);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(matters.length + 4);
    expect(groups.every((group) => group.to === `/workboard/decisions#${group.id}`)).toBe(true);

    // A source of a group that did not answer: the group shows, «not checked», even with nothing in it.
    const failed = buildWaitingGroups({
      matters: [], kindState: (kind) => (kind === "incident.open" ? { ...known, checked: false } : known), trackedKinds: ["incident.open", "people.no_pay_terms"],
    });
    expect(failed).toEqual([{ id: "system", title: "Сбор, сбои и рутины", count: 0, checked: false, tone: "warn", to: "/workboard/decisions#system" }]);
  });

  it("gives a group the worst tone of its matters: broken over unknown over none; not checked is at least unknown", () => {
    const known: MatterKindState = { checked: true, applicable: true, capped: false };
    const tones = (matters: Array<{ id: number; kind: string }>, kindState: (kind: string) => MatterKindState = () => known) =>
      Object.fromEntries(buildWaitingGroups({ matters: matters.map((one) => ({ ...one, pageIds: [], evidence: {} })), kindState, trackedKinds: [] })
        .map((group) => [group.id, group.tone]));
    // Collection and failures: a stale routine's line alone is no alarm; a failure in it makes the group red.
    expect(tones([{ id: 1, kind: "routine.empty" }])).toEqual({ system: null });
    expect(tones([{ id: 1, kind: "routine.empty" }, { id: 2, kind: "incident.open" }])).toEqual({ system: "bad" });
    // Publications: an unknown outcome beside a draft makes it orange; a held send is orange; a red ledger check red.
    expect(tones([{ id: 1, kind: "publication.draft" }, { id: 2, kind: "publication.unknown" }, { id: 3, kind: "send.held" }, { id: 4, kind: "ledger.check" }]))
      .toEqual({ publications: "warn", held: "warn", ledger: "bad" });
    // A group whose source did not answer is at least orange, a red one stays red.
    const notChecked = (kind: string): MatterKindState => (kind === "ledger.sale_question" || kind === "incident.open" ? { ...known, checked: false } : known);
    expect(tones([{ id: 1, kind: "ledger.sale_question" }, { id: 2, kind: "incident.open" }], notChecked)).toEqual({ questions: "warn", system: "bad" });
  });
});

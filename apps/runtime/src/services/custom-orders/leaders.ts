import { customPhaseOf, customPhaseProduct, type CustomOrderState, type CustomPhase } from "@agency_hub_core/contracts";
import type { MatterOwner, TeamFacts } from "@agency_hub_core/db";

import { loginOfPerson, modelOfPageId, pagesOfModels } from "../teams.ts";

/**
 * Who leads each step of a custom order (products plan 2026-11-13 §4.5, package C3) — THE rule, over T's team records
 * (`team_roles`: `lead`, `customs`) and the content managers' models; every door, the checks' matters, the board's
 * «у кого сейчас» and the rights of each step read it from here:
 *
 *   check  (recorded, paid → «Проверен»)                    the model's team lead; else its customs lead; else the owner
 *   shoot  (Проверен → at the model, delivered, revision,  the model's content manager; else its customs lead; else
 *           refusal, shot)                                   the owner
 *   give   (shot → «Отдан»)                                  the chatter who took the order; else the check's leader
 *
 * An order of no known page: the person right «ведёт кастомы» (`fallback`), else the owner. A record of a person with
 * no living login leads nothing (nobody could act on it). A content manager is a person whose living login is
 * `content_manager`; their models are those of their working pages (as their page scope, auth.ts).
 */

export type CustomLeader =
  | { kind: "owner" }
  | { kind: "person"; personId: number | null; userId: number; name: string };

const OWNER: CustomLeader = { kind: "owner" };

function holder(facts: TeamFacts, modelId: number, kind: "lead" | "customs"): CustomLeader | null {
  for (const role of facts.roles) {
    if (role.modelId !== modelId || role.kind !== kind) continue;
    const userId = loginOfPerson(facts, role.personId);
    if (userId === null) continue;
    return { kind: "person", personId: role.personId, userId, name: nameOf(facts, role.personId) };
  }
  return null;
}

function nameOf(facts: TeamFacts, personId: number): string {
  return facts.people.find((person) => person.personId === personId)?.name ?? "";
}

/** The content managers of a model: people with a living `content_manager` login working on its pages. */
export function contentManagersOf(facts: TeamFacts, modelId: number): CustomLeader[] {
  const pages = new Set(pagesOfModels(facts, [modelId]));
  const people = [...new Set(facts.working.filter((row) => pages.has(row.pageId)).map((row) => row.personId))].sort((a, b) => a - b);
  const out: CustomLeader[] = [];
  for (const personId of people) {
    const login = facts.logins.filter((one) => one.personId === personId && one.role === "content_manager").map((one) => one.userId);
    if (login.length === 0) continue;
    out.push({ kind: "person", personId, userId: Math.max(...login), name: nameOf(facts, personId) });
  }
  return out;
}

/** The leader of a phase of a page's order. `fallback` — the person right's holder, for an order of no known page. */
export function phaseLeader(facts: TeamFacts, pageId: number | null, phase: "check" | "shoot", fallback: CustomLeader | null): CustomLeader {
  const modelId = modelOfPageId(facts, pageId);
  if (modelId === null) return fallback ?? OWNER;
  if (phase === "check") return holder(facts, modelId, "lead") ?? holder(facts, modelId, "customs") ?? OWNER;
  return contentManagersOf(facts, modelId)[0] ?? holder(facts, modelId, "customs") ?? OWNER;
}

export interface CustomLeaderOrder {
  pageId: number | null;
  state: CustomOrderState;
  acceptedByUserId: number | null;
  acceptedByName?: string | null;
  acceptedBy?: string | null;
}

/** Who leads the order's current step and where it is done; null — an ended order. */
export function customStepLeader(
  facts: TeamFacts,
  order: CustomLeaderOrder,
  fallback: CustomLeader | null,
): { phase: CustomPhase; leader: CustomLeader; product: "workboard" | "contentops" } | null {
  const phase = customPhaseOf(order.state);
  if (phase === null) return null;
  const product = customPhaseProduct(phase);
  if (phase === "give") {
    if (order.acceptedByUserId !== null) {
      const personId = facts.logins.find((login) => login.userId === order.acceptedByUserId)?.personId ?? null;
      const name = personId !== null ? nameOf(facts, personId) : order.acceptedByName ?? order.acceptedBy ?? "";
      return { phase, product, leader: { kind: "person", personId, userId: order.acceptedByUserId, name: name || (order.acceptedBy ?? "") } };
    }
    return { phase, product, leader: phaseLeader(facts, order.pageId, "check", fallback) };
  }
  return { phase, product, leader: phaseLeader(facts, order.pageId, phase, fallback) };
}

/** The matter's owner of a leader. */
export function leaderOwner(leader: CustomLeader): MatterOwner {
  return leader.kind === "owner" ? { role: "owner" } : { userId: leader.userId };
}

/**
 * The pages whose orders' check and shooting a login leads, for the viewer's rights (`CustomViewer.leads`): every page
 * of the realm's models where the phase's leader is this login.
 */
export function ledPhasesOf(facts: TeamFacts, userId: number, test: boolean): { check: number[]; shoot: number[] } {
  const check: number[] = [];
  const shoot: number[] = [];
  for (const model of facts.models) {
    if (model.test !== test) continue;
    const pages = pagesOfModels(facts, [model.modelId]);
    const first = pages[0];
    if (first === undefined) continue;
    const mine = (leader: CustomLeader) => leader.kind === "person" && leader.userId === userId;
    if (mine(phaseLeader(facts, first, "check", null))) check.push(...pages);
    if (mine(phaseLeader(facts, first, "shoot", null))) shoot.push(...pages);
  }
  return { check, shoot };
}

/**
 * The board's header «Ведёт кастомы» (package C3): per model of the given pages — `"all"`, every model of the realm —
 * who leads its check and its shooting by the rule above. Only models of the viewer's realm: a test account never
 * reads a live person's name here, nor a live one a test person's.
 */
export function boardLeads(
  facts: TeamFacts,
  pages: "all" | readonly number[],
  test: boolean,
): Array<{ model: string; check: string | null; shoot: string | null }> {
  const wanted = pages === "all" ? null : new Set(pages);
  const name = (leader: CustomLeader) => (leader.kind === "owner" ? null : leader.name || null);
  return facts.models
    .filter((model) => model.test === test)
    .flatMap((model) => {
      const own = pagesOfModels(facts, [model.modelId]);
      const first = own.find((pageId) => wanted === null || wanted.has(pageId));
      if (first === undefined) return [];
      return [{ model: model.name, check: name(phaseLeader(facts, first, "check", null)), shoot: name(phaseLeader(facts, first, "shoot", null)) }];
    })
    .sort((left, right) => left.model.localeCompare(right.model));
}

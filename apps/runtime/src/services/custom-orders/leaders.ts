import { customPhaseOf, customPhaseProduct, type CustomOrderState, type CustomPhase } from "@agency_hub_core/contracts";
import type { MatterOwner, TeamFacts } from "@agency_hub_core/db";

import { loginOfPerson, modelOfPageId, pagesOfModels } from "../teams.ts";

/**
 * Who leads each step of a custom order (products plan 2026-11-13 §4.5, package C3) — THE rule, over T's team records
 * (`team_roles`: `lead`, `customs`) and the content managers' models; every door, the checks' matters, the board's
 * «у кого сейчас» and the rights of each step read it from here:
 *
 *   check  (recorded, paid → «Проверен»)                    the model's team lead; else its customs lead; else the owner
 *   shoot  (Проверен → at the model, delivered, revision,  BY THE ORDER'S PAGE: the content managers working on that
 *           refusal, shot)                                   page; none — the model's other content managers; none —
 *                                                            its customs lead; else the owner. Any of the first tier
 *                                                            takes the step; the one named «у кого сейчас» is the
 *                                                            first of them (the lowest person id: stable)
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
    // A content manager who has signed in (an invited one not yet: the step stays with whoever had it).
    const login = facts.logins.filter((one) => one.personId === personId && one.role === "content_manager" && one.signedIn !== false).map((one) => one.userId);
    if (login.length === 0) continue;
    out.push({ kind: "person", personId, userId: Math.max(...login), name: nameOf(facts, personId) });
  }
  return out;
}

/** The content managers working on one page (a content manager is assigned to working pages: plan §11 item 13). */
export function contentManagersOfPage(facts: TeamFacts, pageId: number): CustomLeader[] {
  const people = new Set(facts.working.filter((row) => row.pageId === pageId).map((row) => row.personId));
  const modelId = modelOfPageId(facts, pageId);
  return modelId === null ? [] : contentManagersOf(facts, modelId).filter((leader) => leader.kind === "person" && leader.personId !== null && people.has(leader.personId));
}

/**
 * Everyone who leads the shooting of a page's order — the first tier that has anyone: the page's content managers, the
 * model's other content managers, its customs lead, the owner. Any of them takes the step.
 */
export function shootLeaders(facts: TeamFacts, pageId: number | null, fallback: CustomLeader | null): CustomLeader[] {
  const modelId = modelOfPageId(facts, pageId);
  if (modelId === null || pageId === null) return [fallback ?? OWNER];
  const onPage = contentManagersOfPage(facts, pageId);
  if (onPage.length > 0) return onPage;
  const ofModel = contentManagersOf(facts, modelId);
  if (ofModel.length > 0) return ofModel;
  return [holder(facts, modelId, "customs") ?? OWNER];
}

/**
 * The leader of a phase of a page's order — for the shooting the first of `shootLeaders` (the one «у кого сейчас»
 * names). `fallback` — the person right's holder, for an order of no known page.
 */
export function phaseLeader(facts: TeamFacts, pageId: number | null, phase: "check" | "shoot", fallback: CustomLeader | null): CustomLeader {
  if (phase === "shoot") return shootLeaders(facts, pageId, fallback)[0]!;
  const modelId = modelOfPageId(facts, pageId);
  if (modelId === null) return fallback ?? OWNER;
  return holder(facts, modelId, "lead") ?? holder(facts, modelId, "customs") ?? OWNER;
}

/** Whether a login leads a phase of a page's order: for the shooting, any of `shootLeaders`. */
export function leadsPhaseOf(facts: TeamFacts, pageId: number | null, phase: "check" | "shoot", userId: number, fallback: CustomLeader | null): boolean {
  const leaders = phase === "shoot" ? shootLeaders(facts, pageId, fallback) : [phaseLeader(facts, pageId, phase, fallback)];
  return leaders.some((leader) => leader.kind === "person" && leader.userId === userId);
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
 * The pages whose orders' check and shooting a login leads, for the viewer's rights (`CustomViewer.leads`) and the
 * shooting's list: every page of the realm where the login is among the phase's leaders — the check per model, the
 * shooting per page.
 */
export function ledPhasesOf(facts: TeamFacts, userId: number, test: boolean): { check: number[]; shoot: number[] } {
  const check: number[] = [];
  const shoot: number[] = [];
  for (const page of facts.pages) {
    if (page.test !== test) continue;
    if (leadsPhaseOf(facts, page.pageId, "check", userId, null)) check.push(page.pageId);
    if (leadsPhaseOf(facts, page.pageId, "shoot", userId, null)) shoot.push(page.pageId);
  }
  return { check: check.sort((a, b) => a - b), shoot: shoot.sort((a, b) => a - b) };
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
      const own = pagesOfModels(facts, [model.modelId]).filter((pageId) => wanted === null || wanted.has(pageId));
      const first = own[0];
      if (first === undefined) return [];
      return [{ model: model.name, check: name(phaseLeader(facts, first, "check", null)), shoot: shootByPage(facts, own) }];
    })
    .sort((left, right) => left.model.localeCompare(right.model));
}

/**
 * The shooting's leaders of a model's pages in one line: one name when every page has the same; else by page —
 * «Аня (lora-1), Вера (lora-2)». Null — the owner of every page.
 */
function shootByPage(facts: TeamFacts, pageIds: readonly number[]): string | null {
  const byName = new Map<string, number[]>();
  for (const pageId of pageIds) {
    const leader = phaseLeader(facts, pageId, "shoot", null);
    const key = leader.kind === "owner" ? "" : leader.name;
    byName.set(key, [...(byName.get(key) ?? []), pageId]);
  }
  if (byName.size === 1) {
    const [only] = [...byName.keys()];
    return only === "" || only === undefined ? null : only;
  }
  const label = (pageId: number) => facts.pages.find((page) => page.pageId === pageId)?.label ?? String(pageId);
  return [...byName].map(([leader, ids]) => `${leader === "" ? "владелец" : leader} (${ids.map(label).join(", ")})`).join(", ");
}

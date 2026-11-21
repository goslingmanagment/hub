import { parseCustomOrderCode, type AgentCustomOrder } from "@agency_hub_core/contracts";
import {
  findCustomOrder,
  listAgentCustomOrders,
  listCustomOrderMessagesOf,
  listUsersWithPersonRight,
  type CustomOrderRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import type { HumanAuthPrincipal } from "../auth.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { pagesOfModels, personOfLogin, teamFactsFor, teamsOfPerson } from "../teams.ts";
import {
  agentOrderBase, applyCustomStep, cardTextOf, customLeaderContext, messageWire, notAllowed, orderMessagesOf,
  type CustomActor, type CustomLeaderContext, type CustomStep,
} from "./index.ts";
import { leadsPhaseOf, ledPhasesOf } from "./leaders.ts";
import { STEP_FROM } from "./rules.ts";

/**
 * The shooting side of custom orders AS THE SIGNED-IN PERSON (products plan §2.4, §4.5, package C3): ContentOps
 * «Съёмка» reads and moves orders through the person's door (services/person-door.ts) with the person's own principal,
 * never with its live agent key, so the test realm's wall and the person's pages hold.
 *
 * Whose orders a person reads here (`shootingScope`), of their realm only:
 *   the owner                 every page of his realm (the live owner also the orders of no known page);
 *   a content manager         the pages whose shooting she leads by the rule (leaders.ts `shootLeaders`): her working
 *                             pages, and a page of her model no content manager works on — never another content
 *                             manager's page (her plan and publications are her pages' too, plan §11 item 13);
 *   anyone else               the pages of the models whose customs they lead (`team_roles` kind `customs`); a holder
 *                             of the person right «ведёт кастомы» also the live orders of no known page.
 * A step is taken by the step's leader by the one rule (leaders.ts), or the owner; the history names the person and the
 * door `contentops`.
 */

type PersonApp = Pick<AppContext, "db">;

export interface ShootingScope {
  pageIds: number[];
  /** The orders of no known page (always the live agency's). */
  unknownPage: boolean;
  test: boolean;
}

export async function shootingScope(app: PersonApp, person: HumanAuthPrincipal): Promise<ShootingScope> {
  const facts = await teamFactsFor(app, person);
  const test = person.sandbox?.test === true;
  const realm = new Set(facts.pages.filter((page) => page.test === test).map((page) => page.pageId));
  const role = person.user.role;
  if (role === "owner") return { pageIds: [...realm], unknownPage: !test, test };
  if (role === "content_manager") {
    const assigned = new Set(person.assignedPageIds);
    const led = ledPhasesOf(facts, person.user.id, test).shoot.filter((id) => realm.has(id) && assigned.has(id));
    return { pageIds: led, unknownPage: false, test };
  }
  const teams = teamsOfPerson(facts, personOfLogin(facts, person.user.id));
  const right = (await listUsersWithPersonRight(app.db, "customs_lead")).some((lead) => lead.userId === person.user.id);
  const pageIds = pagesOfModels(facts, teams.customs).filter((id) => realm.has(id));
  // A chatter or a team lead who leads no customs has no shooting: «Съёмка» is not theirs at all.
  if (pageIds.length === 0 && !(right && !test)) throw new ForbiddenError("«Съёмка» открыта тому, кто ведёт кастомы");
  return { pageIds, unknownPage: right && !test, test };
}

function inScope(scope: ShootingScope, order: { pageId: number | null }): boolean {
  return order.pageId === null ? scope.unknownPage : scope.pageIds.includes(order.pageId);
}

function wireOf(order: CustomOrderRow, messages: AgentCustomOrder["messages"], now: Date, leaders: CustomLeaderContext): AgentCustomOrder {
  return { ...agentOrderBase(order, now, leaders), cardText: cardTextOf(order), sourceText: order.sourceText, messages };
}

/**
 * The person's open orders — the agent read's list and shape (`agentCustomOrdersResponseSchema`), cut by the person's
 * scope; `modelSlug` — one model of it (another one is 404, as a page outside the scope).
 */
export async function personCustomOrders(app: PersonApp, person: HumanAuthPrincipal, query: { modelSlug?: string | undefined }, now: Date = new Date()) {
  const scope = await shootingScope(app, person);
  let pageIds = scope.pageIds;
  let unknownPage = scope.unknownPage;
  if (query.modelSlug !== undefined) {
    const facts = await teamFactsFor(app, person);
    const model = facts.models.find((one) => one.slug.toLowerCase() === query.modelSlug!.toLowerCase() && one.test === scope.test);
    const own = model === undefined ? [] : pagesOfModels(facts, [model.modelId]).filter((id) => scope.pageIds.includes(id));
    if (own.length === 0) throw new NotFoundError(`Model "${query.modelSlug}" was not found`);
    pageIds = own;
    unknownPage = false;
  }
  const rows = (await listAgentCustomOrders(app.db, { pageIds, open: true, limit: 500 }))
    .filter((order) => (order.pageId === null ? unknownPage : pageIds.includes(order.pageId)));
  const [messages, leaders] = await Promise.all([listCustomOrderMessagesOf(app.db, rows.map((order) => order.id)), customLeaderContext(app, person)]);
  return { orders: rows.map((order) => wireOf(order, (messages.get(order.id) ?? []).map(messageWire), now, leaders)), serverNow: now.toISOString() };
}

export type ShootingStepName = "at_model" | "partly" | "shot" | "revision" | "refused";

export interface ShootingStepBody {
  step: ShootingStepName;
  deadlineOn?: string | undefined;
  note?: string | undefined;
  part?: "video" | "photos" | undefined;
}

/**
 * A step of the shooting side by a person: theirs when they lead the shooting of the order's model by the one rule
 * (leaders.ts) — a fan's complaint after «отдан» also by the check's leader — or they are the owner (of the order's
 * realm: the caller checked it). «Передать модели» may set the deadline first. Answers whether anything changed.
 */
export async function takeShootingStep(
  app: PersonApp,
  order: CustomOrderRow,
  person: { userId: number; owner: boolean },
  body: ShootingStepBody,
  actor: CustomActor,
  now: Date = new Date(),
): Promise<boolean> {
  const context = await customLeaderContext(app);
  // Any of the step's leaders takes it (several content managers of the order's page: plan §11 item 13).
  const mine = (phase: "check" | "shoot") => leadsPhaseOf(context.facts, order.pageId, phase, person.userId, context.fallback);
  const leads = person.owner || mine("shoot") || (body.step === "revision" && order.state === "given" && mine("check"));
  if (!leads) throw notAllowed("This step of the order is not the person's: the shooting's leader takes it");
  let changed = false;
  if (body.step === "at_model" && body.deadlineOn !== undefined && body.deadlineOn !== order.deadlineOn) {
    changed = await applyCustomStep(app, { orderId: order.id, step: { action: "deadline", deadlineOn: body.deadlineOn, by: "person" }, actor, viewer: null, now, byPerson: true });
  }
  if (body.step === "refused" && (body.note === undefined || body.note.trim() === "")) throw notAllowed("A refusal names its reason");
  const step: CustomStep = body.step === "at_model" ? { action: "at_model" }
    : body.step === "partly" ? { action: "partly", note: body.note }
    : body.step === "shot" ? { action: "shot" }
    : body.step === "refused" ? { action: "refused", reason: body.note! }
    : { action: "revision", note: body.note, part: body.part };
  const current = (await findCustomOrder(app.db, order.id))!;
  if (!STEP_FROM[step.action].includes(current.state)) throw notAllowed(`An order «${current.state}» takes no step «${step.action}»`);
  return (await applyCustomStep(app, { orderId: order.id, step, actor, viewer: null, now, byPerson: true })) || changed;
}

/** The step through the person's door: the order must be in the person's scope (else 404); the history names them. */
export async function personCustomOrderStep(
  app: PersonApp,
  person: HumanAuthPrincipal,
  body: ShootingStepBody & { code: string },
  now: Date = new Date(),
) {
  const id = parseCustomOrderCode(body.code);
  const order = id === null ? null : await findCustomOrder(app.db, id);
  const scope = await shootingScope(app, person);
  if (order === null || !inScope(scope, order)) throw new NotFoundError("The custom order was not found");
  const changed = await takeShootingStep(app, order, { userId: person.user.id, owner: person.user.role === "owner" }, body, { door: "contentops", userId: person.user.id }, now);
  const after = (await findCustomOrder(app.db, order.id))!;
  const leaders = await customLeaderContext(app);
  return { order: wireOf(after, await orderMessagesOf(app.db, after.id), now, leaders), outcome: changed ? "changed" as const : "unchanged" as const, event: null };
}

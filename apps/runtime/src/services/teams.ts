import { loadTeamFacts, type TeamFacts, type TeamRoleKind } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ForbiddenError } from "./errors.ts";
import type { AuthPrincipal, HumanAuthPrincipal } from "./auth.ts";
import { ownerPageScope } from "./sandbox/realm.ts";

/**
 * Teams (products plan 2026-11-13 §1 idea 4, §4.2): ONE place answers «whose teams does this person see and lead».
 *
 * - A team is a MODEL. A person is in the teams of the models of their working pages in the registry
 *   (`person_working_pages`), never of the pages their login was granted.
 * - The records (`team_roles`, 0415): `lead` «ведёт команду», `customs` «ведёт кастомы», `view` «видит команду».
 *   Authority comes from them, never from the login's role alone: a login `team_lead` with no `lead` record leads
 *   nothing, a chatter with one leads that team and stays a chatter.
 * - Every team read takes its pages from `teamPagesFor`: the owner every page of their realm (as before, `undefined`
 *   while no test page exists), anyone else the pages of the models of their teams PLUS the pages their login was
 *   granted (working on a page stays by the grant: the team only adds).
 * - Who decides a matter of a model is `deciderOf`: the lead of that model's team, the owner when it has none, the
 *   owner when the lead is a side; the pot, «мимо площадки» and money are always the owner's.
 */

export interface ViewerTeams {
  /** The person behind the login; null — a login of nobody. */
  personId: number | null;
  /** Models of the person's working pages. */
  mine: number[];
  /** Models the person was given «видит команду» of. */
  view: number[];
  /** Models whose team the person leads. */
  lead: number[];
  /** Models whose customs the person leads. */
  customs: number[];
}

type TeamsApp = Pick<AppContext, "db">;

const factsCache = new WeakMap<object, Promise<TeamFacts>>();

/** The facts, read once per principal object (one request). */
export function teamFactsFor(app: TeamsApp, principal?: object): Promise<TeamFacts> {
  if (principal === undefined) return loadTeamFacts(app.db);
  let facts = factsCache.get(principal);
  if (facts === undefined) {
    facts = loadTeamFacts(app.db);
    factsCache.set(principal, facts);
  }
  return facts;
}

const uniq = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

/** The model of each page. */
function modelOfPage(facts: TeamFacts): Map<number, number> {
  return new Map(facts.pages.map((page) => [page.pageId, page.modelId]));
}

/** A person's teams, from the facts. */
export function teamsOfPerson(facts: TeamFacts, personId: number | null): ViewerTeams {
  if (personId === null) return { personId: null, mine: [], view: [], lead: [], customs: [] };
  const modelOf = modelOfPage(facts);
  const mine = uniq(facts.working.filter((row) => row.personId === personId).flatMap((row) => {
    const model = modelOf.get(row.pageId);
    return model === undefined ? [] : [model];
  }));
  const of = (kind: TeamRoleKind) => uniq(facts.roles.filter((role) => role.personId === personId && role.kind === kind).map((role) => role.modelId));
  return { personId, mine, view: of("view"), lead: of("lead"), customs: of("customs") };
}

export function personOfLogin(facts: TeamFacts, userId: number): number | null {
  return facts.logins.find((login) => login.userId === userId)?.personId ?? null;
}

function isOwnerReader(principal: HumanAuthPrincipal): boolean {
  return principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined;
}

/** The viewer's teams (`me`'s `teams`). The owner's lists are their own records; the owner reads every team anyway. */
export async function viewerTeams(app: TeamsApp, principal: HumanAuthPrincipal): Promise<ViewerTeams> {
  const facts = await teamFactsFor(app, principal);
  return teamsOfPerson(facts, personOfLogin(facts, principal.user.id));
}

/** The models whose teams a non-owner reads: in, given «видит», or leading. Of the principal's realm only. */
export function readModelsOf(facts: TeamFacts, teams: ViewerTeams, test: boolean): number[] {
  const realm = new Set(facts.models.filter((model) => model.test === test).map((model) => model.modelId));
  return uniq([...teams.mine, ...teams.view, ...teams.lead].filter((model) => realm.has(model)));
}

/** The pages of some models. */
export function pagesOfModels(facts: TeamFacts, modelIds: readonly number[]): number[] {
  const wanted = new Set(modelIds);
  return uniq(facts.pages.filter((page) => wanted.has(page.modelId)).map((page) => page.pageId));
}

/**
 * THE cut of every team read: undefined — no filter (a live owner while there is no test page, exactly as
 * `pageScopeFor`); else the page ids the principal's team reads may name.
 */
export async function teamPagesFor(app: TeamsApp, principal: AuthPrincipal): Promise<number[] | undefined> {
  if (principal.kind === "agent") return principal.pageIds;
  if (isOwnerReader(principal)) return ownerPageScope(principal);
  const facts = await teamFactsFor(app, principal);
  const teams = teamsOfPerson(facts, personOfLogin(facts, principal.user.id));
  const test = principal.sandbox?.test === true;
  const realmPages = new Set(facts.pages.filter((page) => page.test === test).map((page) => page.pageId));
  return uniq([...pagesOfModels(facts, readModelsOf(facts, teams, test)), ...principal.assignedPageIds].filter((id) => realmPages.has(id)));
}

/** The pages of the models the principal LEADS (by records; the owner leads nothing by name, he is above). */
export async function ledPagesFor(app: TeamsApp, principal: HumanAuthPrincipal): Promise<number[]> {
  if (principal.narrowDeviceTokenId !== undefined) return [];
  const facts = await teamFactsFor(app, principal);
  const teams = teamsOfPerson(facts, personOfLogin(facts, principal.user.id));
  return pagesOfModels(facts, teams.lead);
}

/** Whether the principal leads the model's team (the owner: always, his word is above). */
export async function leadsModel(app: TeamsApp, principal: HumanAuthPrincipal, modelId: number): Promise<boolean> {
  if (isOwnerReader(principal)) return true;
  if (principal.narrowDeviceTokenId !== undefined) return false;
  const facts = await teamFactsFor(app, principal);
  return teamsOfPerson(facts, personOfLogin(facts, principal.user.id)).lead.includes(modelId);
}

/** A cookie session of any human role — the narrow one too — for the team reads; device tokens and agents are refused. */
export function requireTeamReader(principal: AuthPrincipal): asserts principal is HumanAuthPrincipal {
  if (principal.kind === "agent" || principal.authMethod !== "session") {
    throw new ForbiddenError("Team routes require a cookie session");
  }
}

/**
 * Who may ASK whoever decides (products package R5): a cookie session as for the team reads, or the extension's own
 * narrow token — the question window in its frame over the site — for a question about a fan only (never «Подмена» or
 * «График», which change the schedule). Every other device token and agents are refused.
 */
export function requireTeamAsker(principal: AuthPrincipal, kind: string): asserts principal is HumanAuthPrincipal {
  if (principal.kind !== "agent" && principal.authMethod === "device_token" && principal.clientProfile === "chat-extension") {
    if (kind === "swap" || kind === "schedule") throw new ForbiddenError("A swap or the schedule is asked from Workboard");
    return;
  }
  requireTeamReader(principal);
}

// ── Who decides ─────────────────────────────────────────────────────────────

/**
 * What is decided: `dispute` — «чья продажа» between chatters; `gengar` — a disagreement with Gengar's proposal;
 * `customs` — a customs step of the model; `work` — any other team matter (a held send, a request); `pot` and
 * `off_platform` — the pot's and «мимо площадки»: the owner's alone.
 */
export type DecisionKind = "dispute" | "gengar" | "customs" | "work" | "pot" | "off_platform";

export type Decider =
  | { kind: "owner" }
  | { kind: "team_lead"; personId: number; userId: number; name: string };

/**
 * The login a person is addressed by as one who leads, decides or takes a step: their newest login that has signed in
 * (`signedInLoginSql`, team-roles.ts); null — none: an invited person not signed in yet leads nothing.
 */
export function loginOfPerson(facts: TeamFacts, personId: number): number | null {
  const ids = facts.logins.filter((login) => login.personId === personId && login.signedIn !== false).map((login) => login.userId);
  return ids.length === 0 ? null : Math.max(...ids);
}

function holderOf(facts: TeamFacts, modelId: number, kind: TeamRoleKind, sides: ReadonlySet<number>): Decider | null {
  for (const role of facts.roles) {
    if (role.modelId !== modelId || role.kind !== kind) continue;
    const userId = loginOfPerson(facts, role.personId);
    if (userId === null) continue;
    // A lead who is a side of the matter does not decide it: the owner does.
    if (sides.has(role.personId)) return null;
    const name = facts.people.find((person) => person.personId === role.personId)?.name ?? "";
    return { kind: "team_lead", personId: role.personId, userId, name };
  }
  return null;
}

/**
 * Who decides a matter of a model: the lead of its team; the owner when it has none, when the lead is a side
 * (`sidePersonIds`), when the model is unknown, and always for the pot and «мимо площадки». A customs step goes to
 * the model's customs lead first, then its team lead.
 */
export function deciderOf(
  facts: TeamFacts,
  modelId: number | null,
  kind: DecisionKind,
  sidePersonIds: readonly number[] = [],
): Decider {
  if (modelId === null || kind === "pot" || kind === "off_platform") return { kind: "owner" };
  const sides = new Set(sidePersonIds);
  if (kind === "customs") {
    const customs = holderOf(facts, modelId, "customs", sides);
    if (customs !== null) return customs;
  }
  const leadIsSide = facts.roles.some((role) => role.modelId === modelId && role.kind === "lead" && sides.has(role.personId));
  if (leadIsSide) return { kind: "owner" };
  return holderOf(facts, modelId, "lead", sides) ?? { kind: "owner" };
}

/** The model of a page; null — unknown. */
export function modelOfPageId(facts: TeamFacts, pageId: number | null | undefined): number | null {
  if (pageId === null || pageId === undefined) return null;
  return facts.pages.find((page) => page.pageId === pageId)?.modelId ?? null;
}

/** The persons behind some logins (the sides of a matter). */
export function personsOfLogins(facts: TeamFacts, userIds: readonly (number | null)[]): number[] {
  const wanted = new Set(userIds.filter((id): id is number => id !== null));
  return uniq(facts.logins.filter((login) => wanted.has(login.userId)).map((login) => login.personId));
}

import { productsOf, waitsInContentops, type AuthSsoWaitingResponse, type SigninPerson } from "@agency_hub_core/contracts";
import { findLoginPersonScope, listMatterPageLabels, listVisibleMatters, type MatterViewer } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { heldRolesOf } from "./matters.ts";
import { personOfLogin, teamFactsFor, teamsOfPerson } from "./teams.ts";

/**
 * What Hub tells ContentOps about a person it signed in (products plan §4.1, §4.4): who they are in the registry
 * (`personForContentops`, in the redeem and every re-check: enough for ContentOps to make, change and close its own
 * person) and what waits for them (`contentopsWaitingOf`, its «Ждут вас»). Hub stays the home of both: ContentOps keeps
 * a cache, never a copy.
 */

/** The client these go to; other services' answers stay as they were. */
export const PERSON_CLIENT = "contentops";

export interface SigninLogin {
  id: number;
  role: string;
}

/** The person behind the login; null — nobody's login in the registry. */
export async function personForContentops(app: Pick<AppContext, "db">, user: SigninLogin, test: boolean): Promise<SigninPerson> {
  const [person, facts] = await Promise.all([findLoginPersonScope(app.db, user.id), teamFactsFor(app)]);
  if (person === null) return null;
  // «Ведёт кастомы» by model: the team records (`team_roles` kind `customs`, services/teams.ts).
  const slugOf = new Map(facts.models.map((model) => [model.modelId, model.slug.toLowerCase()]));
  const customs = teamsOfPerson(facts, personOfLogin(facts, user.id)).customs
    .map((modelId) => slugOf.get(modelId))
    .filter((slug): slug is string => slug !== undefined)
    .sort();
  return {
    code: person.code,
    displayName: person.displayName,
    role: person.role,
    state: person.state,
    models: person.modelSlugs,
    customsModels: customs,
    products: productsOf({ role: user.role, narrow: false, test, personRole: person.role, leadsCustoms: customs.length > 0 }),
  };
}

const WAITING_LIMIT = 200;

/**
 * The person's own open matters of the kinds ContentOps shows (`waitsInContentops`): their user's, and the owner's
 * also those of the roles the owner holds — what «Ждут вас» counts for them, never a matter with money for anyone else.
 */
export async function contentopsWaitingOf(app: Pick<AppContext, "db">, user: SigninLogin, test: boolean, now: Date = new Date()): Promise<AuthSsoWaitingResponse> {
  const owner = user.role === "owner";
  const viewer: MatterViewer = { userId: user.id, role: owner ? "owner" : "chatter", pageIds: [], ...(test ? { realm: "test" as const } : {}) };
  const heldRoles = owner ? await heldRolesOf(app, viewer) : [];
  const [rows, pages, facts] = await Promise.all([
    listVisibleMatters(app.db, { viewer, state: "open", heldRoles, limit: 5000 }),
    listMatterPageLabels(app.db),
    teamFactsFor(app),
  ]);
  // The model of each page, as Hub's lower-case slug: ContentOps cuts «Ждут вас» by Hub's model, like its other screens.
  const slugOfModel = new Map(facts.models.map((model) => [model.modelId, model.slug.toLowerCase()]));
  const slugOfPage = new Map(facts.pages.flatMap((page) => {
    const slug = slugOfModel.get(page.modelId);
    return slug === undefined ? [] : [[page.pageId, slug] as const];
  }));
  const matters = rows.filter((row) => waitsInContentops(row.kind)).slice(0, WAITING_LIMIT).map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    link: row.link,
    pageLabels: row.pageIds.map((id) => pages.labelOf.get(id)).filter((label): label is string => label !== undefined),
    models: [...new Set(row.pageIds.map((id) => slugOfPage.get(id)).filter((slug): slug is string => slug !== undefined))].sort(),
    openedAt: row.openedAt.toISOString(),
  }));
  return { active: true, matters, serverNow: now.toISOString() };
}

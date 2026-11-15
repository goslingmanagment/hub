import type { ReviewNotesResponse, TeamRoleSetBody, TeamRolesResponse } from "@agency_hub_core/contracts";
import {
  findPersonRowByCode,
  findShiftAt,
  grantTeamRole,
  insertReviewNote,
  listPersonCodes,
  listReviewNotes,
  revokeTeamRole,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { recordAudit, type HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";
import { requireSameRealm, userIsTest } from "./sandbox/realm.ts";
import {
  deciderOf,
  modelOfPageId,
  personOfLogin,
  readModelsOf,
  requireTeamReader,
  teamFactsFor,
  teamsOfPerson,
} from "./teams.ts";

/**
 * The team records' and the review notes' doors (products package T). Who may do what is services/teams.ts: the
 * owner everything of his realm; a model's lead grants and takes back «видит команду» and «ведёт кастомы» on it and
 * writes notes on its shifts; «ведёт команду» is the owner's to give. No money anywhere.
 */

type App = Pick<AppContext, "db">;

const isOwner = (principal: HumanAuthPrincipal) => principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined;

function requireFullSession(principal: HumanAuthPrincipal) {
  if (principal.narrowDeviceTokenId !== undefined) throw new ForbiddenError("Войдите на сайте с паролем");
}

export async function readTeamRoles(app: App, principal: HumanAuthPrincipal, now = new Date()): Promise<TeamRolesResponse> {
  requireTeamReader(principal);
  const facts = await teamFactsFor(app, principal);
  const test = principal.sandbox?.test === true;
  const me = teamsOfPerson(facts, personOfLogin(facts, principal.user.id));
  const owner = isOwner(principal);
  const modelIds = new Set(owner
    ? facts.models.filter((model) => model.test === test).map((model) => model.modelId)
    : readModelsOf(facts, me, test));
  const peopleCodes = await codesOf(app, facts.people.map((person) => person.personId));
  const nameOf = (personId: number) => facts.people.find((person) => person.personId === personId)?.name ?? "";
  const nameOfLogin = (userId: number | null) => {
    if (userId === null) return null;
    const personId = personOfLogin(facts, userId);
    return personId === null ? null : nameOf(personId);
  };
  return {
    models: facts.models.filter((model) => modelIds.has(model.modelId)).map((model) => {
      const lead = deciderOf(facts, model.modelId, "work");
      return {
        id: model.modelId, slug: model.slug, name: model.name,
        canGrant: owner || me.lead.includes(model.modelId),
        canGrantLead: owner,
        leadName: lead.kind === "team_lead" ? lead.name : null,
      };
    }),
    records: facts.roles.filter((role) => modelIds.has(role.modelId)).map((role) => ({
      personId: role.personId,
      personCode: peopleCodes.get(role.personId) ?? "",
      personName: nameOf(role.personId),
      modelId: role.modelId,
      kind: role.kind,
      grantedByName: owner ? nameOfLogin(role.grantedByUserId) ?? (role.grantedByUserId === null ? null : "владелец") : nameOfLogin(role.grantedByUserId),
      grantedAt: role.grantedAt.toISOString(),
    })),
    serverNow: now.toISOString(),
  };
}

async function codesOf(app: App, personIds: readonly number[]): Promise<Map<number, string>> {
  if (personIds.length === 0) return new Map();
  return listPersonCodes(app.db, personIds);
}

export async function setTeamRole(app: App, principal: HumanAuthPrincipal, body: TeamRoleSetBody, now = new Date()) {
  requireTeamReader(principal);
  requireFullSession(principal);
  const person = await findPersonRowByCode(app.db, body.personCode);
  if (person === null) throw new NotFoundError("Person not found");
  const facts = await teamFactsFor(app);
  const model = facts.models.find((one) => one.modelId === body.modelId);
  if (model === undefined) throw new NotFoundError("Model not found");
  // The wall (sandbox/realm.ts): a person and a model of the principal's realm only, and of each other's.
  const notFound = () => new NotFoundError("Not found");
  requireSameRealm(principal, person.isTest, notFound);
  requireSameRealm(principal, model.test, notFound);
  const owner = isOwner(principal);
  if (!owner) {
    const me = teamsOfPerson(facts, personOfLogin(facts, principal.user.id));
    if (body.kind === "lead") throw new ForbiddenError("«Ведёт команду» даёт владелец");
    if (!me.lead.includes(body.modelId)) throw new ForbiddenError("Это может тот, кто ведёт команду этой модели");
  }
  if (person.state === "left" && body.granted) throw new BadRequestError("The person has left", { reason: "left" });
  const input = { personId: person.id, modelId: body.modelId, kind: body.kind };
  const changed = body.granted
    ? await grantTeamRole(app.db, { ...input, grantedByUserId: principal.user.id })
    : await revokeTeamRole(app.db, { ...input, revokedByUserId: principal.user.id });
  if (changed) {
    await recordAudit(app, {
      source: "workboard", actorUserId: principal.user.id,
      eventType: body.granted ? "team_role.grant" : "team_role.revoke",
      metadata: { personId: person.id, modelId: body.modelId, kind: body.kind },
    });
  }
  return { changed, savedAt: now.toISOString() };
}

// ── Review notes ────────────────────────────────────────────────────────────

async function shiftFor(app: App, principal: HumanAuthPrincipal, userId: number, at: string) {
  if ((await userIsTest(app, userId)) !== (principal.sandbox?.test === true)) throw new NotFoundError("The person has no shift at that time");
  return findShiftAt(app.db, userId, new Date(at));
}

/** Whether the principal leads a model of the shift's pages (the owner: always). */
async function leadsShift(app: App, principal: HumanAuthPrincipal, pageIds: readonly number[]): Promise<boolean> {
  if (isOwner(principal)) return true;
  if (principal.narrowDeviceTokenId !== undefined) return false;
  const facts = await teamFactsFor(app, principal);
  const me = teamsOfPerson(facts, personOfLogin(facts, principal.user.id));
  return pageIds.some((pageId) => {
    const model = modelOfPageId(facts, pageId);
    return model !== null && me.lead.includes(model);
  });
}

export async function readReviewNotes(app: App, principal: HumanAuthPrincipal, query: { userId: number; at: string }, now = new Date()): Promise<ReviewNotesResponse> {
  requireTeamReader(principal);
  const shift = await shiftFor(app, principal, query.userId, query.at);
  if (shift === null) return { shiftId: null, notes: [], canWrite: false, serverNow: now.toISOString() };
  const lead = await leadsShift(app, principal, shift.pageIds);
  const notes = (await listReviewNotes(app.db, [shift.shiftId]))
    // The chatter's own, what the viewer wrote, and everything for the lead and the owner; nobody else's.
    .filter((note) => lead || note.chatterUserId === principal.user.id || note.authorUserId === principal.user.id);
  return {
    shiftId: shift.shiftId,
    notes: notes.map((note) => ({ id: note.id, chatKey: note.chatKey, authorName: note.authorName, text: note.text, createdAt: note.createdAt.toISOString() })),
    canWrite: lead,
    serverNow: now.toISOString(),
  };
}

export async function addReviewNote(
  app: App,
  principal: HumanAuthPrincipal,
  body: { userId: number; at: string; chatKey?: string | null | undefined; text: string },
  now = new Date(),
) {
  requireTeamReader(principal);
  requireFullSession(principal);
  const shift = await shiftFor(app, principal, body.userId, body.at);
  if (shift === null) throw new NotFoundError("The person has no shift at that time");
  if (!(await leadsShift(app, principal, shift.pageIds))) throw new ForbiddenError("Заметку оставляет тот, кто ведёт команду");
  const id = await insertReviewNote(app.db, {
    shiftId: shift.shiftId, chatterUserId: body.userId, chatKey: body.chatKey ?? null, authorUserId: principal.user.id, text: body.text.trim(),
  });
  return { id, savedAt: now.toISOString() };
}

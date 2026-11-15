import { sql, type SQL } from "drizzle-orm";

import { testPageSql, testUserSql, type Database } from "@agency_hub_core/db";

import { NotFoundError } from "../errors.ts";
import type { AuthPrincipal } from "../auth.ts";
import { isTestAgent, isTestPrincipal } from "./realm.ts";

/**
 * THE WALL BY OBJECT (sandbox/realm.ts): what a request NAMES — a page, a login, a person, a model, a shift, a sale, a
 * claim, a report's candidate or proposal, a «мимо площадки» line, a question, an order, a publication — is of the
 * caller's realm, or the request is the same 404 as for an object that does not exist. One check, in the API's
 * preHandler (api/server.ts), for every route and every principal: a handler never has to remember which of its
 * parameters to look at.
 *
 * What a field names is decided here, once: by its name (`FIELD_OBJECTS`, the same word means the same object on every
 * route), or for a route whose field is ambiguous (`id`, `code`, `slug`) by `ROUTE_OBJECTS`. A field that names
 * something that is not an object of a realm (a device of the caller's own, a fan inside the route's own page) is said
 * so there with `none`. tests/sandbox-realm-objects.integration.test.ts reads every route a test principal can reach and
 * fails on an id-shaped field this file does not classify, then calls each classified one with an object of the other
 * realm.
 */

export type RealmObjectKind =
  | "page" | "pageLabel" | "model" | "modelSlug" | "login" | "personCode" | "shift" | "sale" | "claim" | "offPlatformLine"
  | "candidate" | "proposal" | "sighting" | "question" | "order" | "publication";

/** A field's object: a kind, or `none` (with the reason in a comment where it is declared). */
export type FieldObject = RealmObjectKind | "none";

/** The same name is the same object on every route. */
export const FIELD_OBJECTS: Readonly<Record<string, FieldObject>> = {
  pageId: "page",
  pageIds: "page",
  pageLabel: "pageLabel",
  pageLabels: "pageLabel",
  workingPageLabels: "pageLabel",
  modelId: "model",
  modelSlug: "modelSlug",
  leadModelSlugs: "modelSlug",
  userId: "login",
  shareWithUserId: "login",
  toUserId: "login",
  personCode: "personCode",
  // «Подмена»: who is absent and who covers (a swap's `swap.*`).
  absentPersonCode: "personCode",
  coverPersonCode: "personCode",
  shiftId: "shift",
  transactionId: "sale",
  transactionIds: "sale",
  saleId: "sale",
  claimId: "claim",
  offPlatformId: "offPlatformLine",
  candidateId: "candidate",
  proposalId: "proposal",
  sightingId: "sighting",
  questionId: "question",
  publicationId: "publication",
  // A fan, a conversation, a message, a media offer, a send attempt: named inside the route's own page (its pageLabel
  // is checked) or read through the caller's page scope; never an object of a realm by itself.
  platformUserId: "none",
  platformConversationId: "none",
  conversationId: "none",
  platformMessageId: "none",
  mediaOfferId: "none",
  attemptId: "none",
  // An export job of the caller's own (the service answers only the caller's jobs).
  jobId: "none",
};

/** Routes whose field is ambiguous by name. */
export const ROUTE_OBJECTS: Readonly<Record<string, Readonly<Record<string, FieldObject>>>> = {
  adminPublicationGet: { id: "publication" },
  adminPublicationCancel: { id: "publication" },
  adminPublicationResolve: { id: "publication" },
  adminPublicationWithdraw: { id: "publication" },
  adminPublicationReplace: { id: "publication" },
  adminPublicationApprove: { id: "publication" },
  adminPublicationDeletePost: { id: "publication" },
  teamQuestions: { id: "question" },
  teamQuestionAnswer: { id: "question" },
  teamQuestionClose: { id: "question" },
  teamSwapRevoke: { id: "question" },
  customOrder: { code: "order" },
  customOrderAct: { code: "order" },
  adminPerson: { code: "personCode" },
  adminPersonUpdate: { code: "personCode" },
  // A new person's code: nobody's yet (a code of an existing person is refused by the service).
  adminPersonCreate: { code: "none" },
  // The caller's own device (the service refuses another login's).
  authRevokeDevice: { deviceId: "none" },
  // «Обучение» and agents' reports are pages of the live agency's knowledge: a test principal reads none of them, by
  // their own services (learn-pages.ts, agent-reports.ts), whatever the slug.
  learnPage: { slug: "none" },
  reportGet: { slug: "none" },
  // A config switch's key (the owner's alone; a test person sets none: off the test owner's table).
  adminConfigUpdate: { key: "none" },
};

/** Which object a route's field names; undefined — the field is not classified. */
export function fieldObject(routeKey: string, field: string): FieldObject | undefined {
  return ROUTE_OBJECTS[routeKey]?.[field] ?? FIELD_OBJECTS[field];
}

/** The kinds named by a label, a slug or a code; every other kind by a numeric id. */
const BY_TEXT = new Set<RealmObjectKind>(["pageLabel", "modelSlug", "personCode", "order"]);

/** A test-ness query per kind: one row `test` (true/false) when the object exists, no row when it does not. */
function realmQuery(kind: RealmObjectKind, value: string): SQL {
  const id = sql`${value}::bigint`;
  const pageOf = (table: string, column = "page_id") =>
    sql`select ${testPageSql(sql.raw(`o.${column}`))} as test from ${sql.raw(table)} o where o.id = ${id}`;
  switch (kind) {
    case "page": return sql`select ${testPageSql(sql`p.id`)} as test from pages p where p.id = ${id}`;
    case "pageLabel": return sql`select ${testPageSql(sql`p.id`)} as test from pages p where p.label = ${id}`;
    case "model": return sql`select m.is_test as test from models m where m.id = ${id}`;
    case "modelSlug": return sql`select m.is_test as test from models m where m.slug = ${id}`;
    case "login": return sql`select ${testUserSql(sql`u.id`)} as test from users u where u.id = ${id}`;
    case "personCode": return sql`select p.is_test as test from people p where p.code = ${id}`;
    case "shift": return sql`select ${testUserSql(sql`s.user_id`)} as test from shifts s where s.id = ${id}`;
    case "sale": return pageOf("transactions", "platform_account_id");
    case "claim": return pageOf("sale_claims");
    case "offPlatformLine": return sql`select ${testUserSql(sql`o.user_id`)} as test from off_platform_sales o where o.id = ${id}`;
    case "candidate": return sql`select ${testUserSql(sql`h.user_id`)} as test from shift_handin_candidates o
      join shift_handins h on h.id = o.handin_id where o.id = ${id}`;
    case "proposal": return sql`select ${testUserSql(sql`h.user_id`)} as test from shift_handin_proposals o
      join shift_handins h on h.id = o.handin_id where o.id = ${id}`;
    case "sighting": return pageOf("sale_sightings");
    case "question": return pageOf("team_questions");
    case "order": return sql`select ${testPageSql(sql`o.page_id`)} as test from custom_orders o
      where o.id = ${value.replace(/^K-/u, "")}::bigint`;
    case "publication": return pageOf("publications");
  }
}

/** Whether an object is of the test realm; null — no such object (the handler answers that itself). */
export async function objectIsTest(db: Database, kind: RealmObjectKind, value: string): Promise<boolean | null> {
  // Not an id at all (the schema let a wrong shape through to the handler): no such object.
  const wellFormed = kind === "order" ? /^K-[1-9]\d{0,15}$/u.test(value) : BY_TEXT.has(kind) || /^[1-9]\d{0,17}$/u.test(value);
  if (!wellFormed) return null;
  const result = await db.execute<{ test: boolean }>(realmQuery(kind, value));
  const row = result.rows[0];
  return row === undefined ? null : row.test === true;
}

/**
 * The objects a request names: every classified field of its params, query and body, each value of a list, and the
 * same inside nested objects and lists of objects (a batch's `items[].id`).
 */
export function requestObjects(
  routeKey: string,
  parts: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Array<{ field: string; kind: RealmObjectKind; value: string }> {
  const out: Array<{ field: string; kind: RealmObjectKind; value: string }> = [];
  const walk = (part: unknown, depth: number) => {
    if (depth > 4 || part === null || typeof part !== "object") return;
    if (Array.isArray(part)) {
      for (const one of part) walk(one, depth + 1);
      return;
    }
    for (const [field, raw] of Object.entries(part as Record<string, unknown>)) {
      const kind = fieldObject(routeKey, field);
      if (kind !== undefined && kind !== "none") {
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          if (typeof value === "number" || (typeof value === "string" && value.length > 0)) out.push({ field, kind, value: String(value) });
        }
      }
      if (kind === undefined && raw !== null && typeof raw === "object") walk(raw, depth + 1);
    }
  };
  for (const part of parts) walk(part, 0);
  return out;
}

/**
 * THE CHECK: every object the request names is of the principal's realm, or «not found» (no oracle across the wall).
 * A live agent key is left to its page grant (a live key never holds a test page, 0414): its hot read plane asks
 * nothing more.
 */
export async function requireRequestObjectsOfRealm(
  app: { db: Database },
  principal: AuthPrincipal | null | undefined,
  routeKey: string,
  parts: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Promise<void> {
  if (!principal) return;
  const test = isTestPrincipal(principal) || isTestAgent(principal);
  if (principal.kind === "agent" && !test) return;
  for (const object of requestObjects(routeKey, parts)) {
    const objectTest = await objectIsTest(app.db, object.kind, object.value);
    if (objectTest !== null && objectTest !== test) throw new NotFoundError("Not found");
  }
}

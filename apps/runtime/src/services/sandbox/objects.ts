import { sql, type SQL } from "drizzle-orm";

import { testPageSql, testUserSql, type Database } from "@agency_hub_core/db";

import type { AuthPrincipal } from "../auth.ts";
import { isTestAgent, isTestPrincipal } from "./realm.ts";

/**
 * THE WALL BY OBJECT (sandbox/realm.ts): what a request NAMES — a page, a login, a person, a model, a shift, a sale, a
 * claim, a report's candidate or proposal, a «мимо площадки» line, a question, an order, a publication — is of the
 * caller's realm, or the request is answered exactly as for an object that does not exist. One check, in the API's
 * preHandler (api/server.ts) and the person's door, for every route and every principal: a handler never has to
 * remember which of its parameters to look at.
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

/**
 * A field's object: a kind; `none` (with the reason in a comment where it is declared); or `nested` — a container whose
 * own fields are classified the same way (a batch's `items`, a swap's details). A container not declared `nested` is
 * never looked into: inside one, a name like `userId` may be a platform's or Telegram's id, not a login.
 */
export type FieldObject = RealmObjectKind | "none" | "nested";

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
  // Containers whose fields name objects: a batch's items, a swap's details, a person's schedule and invitation, pay terms.
  items: "nested",
  swap: "nested",
  schedule: "nested",
  invite: "nested",
  payTerms: "nested",
  // A person's Telegram (`telegram.userId` is Telegram's id of the person, not a login).
  telegram: "none",
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
  adminConfigUpdate: { key: "none", patches: "none" },
  // A batch of fans by their platform ids, read through the batch's own page or model (the route's pageLabel/modelSlug).
  spenderBatch: { fans: "none" },
};

/** Which object a route's field names; undefined — the field is not classified. */
export function fieldObject(routeKey: string, field: string): FieldObject | undefined {
  return ROUTE_OBJECTS[routeKey]?.[field] ?? FIELD_OBJECTS[field];
}

/** The kinds named by a label, a slug or a code; every other kind by a numeric id. */
const BY_TEXT = new Set<RealmObjectKind>(["pageLabel", "modelSlug", "personCode", "order"]);

/** A value shaped like a key of its kind (else it names nothing, and the operation answers that itself). */
function wellFormed(kind: RealmObjectKind, value: string): boolean {
  if (kind === "order") return /^K-[1-9]\d{0,15}$/u.test(value);
  return BY_TEXT.has(kind) ? value.length > 0 : /^[1-9]\d{0,17}$/u.test(value);
}

/** The realm of several objects of one kind, in one query: `key` (as the request names it) and `test`. */
function realmQuery(kind: RealmObjectKind, values: readonly string[]): SQL {
  const ids = sql`${sql.param(kind === "order" ? values.map((value) => value.slice(2)) : values)}::text[]`;
  const byId = (table: string, test: SQL, key = sql`o.id::text`) =>
    sql`select ${key} as key, ${test} as test from ${sql.raw(table)} o where o.id = any(${ids}::bigint[])`;
  const pageOf = (table: string, column = "page_id") => byId(table, testPageSql(sql.raw(`o.${column}`)));
  const loginOfHandin = sql`${testUserSql(sql`(select h.user_id from shift_handins h where h.id = o.handin_id)`)}`;
  switch (kind) {
    case "page": return byId("pages", testPageSql(sql`o.id`));
    case "pageLabel": return sql`select o.label as key, ${testPageSql(sql`o.id`)} as test from pages o where o.label = any(${ids})`;
    case "model": return byId("models", sql`o.is_test`);
    case "modelSlug": return sql`select o.slug as key, o.is_test as test from models o where o.slug = any(${ids})`;
    case "login": return byId("users", testUserSql(sql`o.id`));
    case "personCode": return sql`select o.code as key, o.is_test as test from people o where o.code = any(${ids})`;
    case "shift": return byId("shifts", testUserSql(sql`o.user_id`));
    case "sale": return pageOf("transactions", "platform_account_id");
    case "claim": return pageOf("sale_claims");
    case "offPlatformLine": return byId("off_platform_sales", testUserSql(sql`o.user_id`));
    case "candidate": return byId("shift_handin_candidates", loginOfHandin);
    case "proposal": return byId("shift_handin_proposals", loginOfHandin);
    case "sighting": return pageOf("sale_sightings");
    case "question": return pageOf("team_questions");
    case "order": return byId("custom_orders", testPageSql(sql`o.page_id`), sql`'K-' || o.id::text`);
    case "publication": return pageOf("publications");
  }
}

/** The realm of each named object that exists (keyed by the value as named); a missing one is absent from the map. */
async function realmsOf(db: Database, kind: RealmObjectKind, values: readonly string[]): Promise<Map<string, boolean>> {
  const named = [...new Set(values.filter((value) => wellFormed(kind, value)))];
  if (named.length === 0) return new Map();
  const result = await db.execute<{ key: string; test: boolean }>(realmQuery(kind, named));
  return new Map(result.rows.map((row) => [String(row.key), row.test === true]));
}

/** Whether an object is of the test realm; null — no such object (the handler answers that itself). */
export async function objectIsTest(db: Database, kind: RealmObjectKind, value: string): Promise<boolean | null> {
  return (await realmsOf(db, kind, [value])).get(value) ?? null;
}

/** A named value: where it sits (to be replaced in place), its kind and its text. */
interface NamedValue { holder: Record<string, unknown> | unknown[]; at: string | number; kind: RealmObjectKind; value: string }

/** Every value the request names, in place: classified fields of params, query and body, and of declared containers. */
function namedValues(routeKey: string, parts: ReadonlyArray<Record<string, unknown> | null | undefined>): NamedValue[] {
  const out: NamedValue[] = [];
  const named = (value: unknown) => typeof value === "number" || (typeof value === "string" && value.length > 0);
  const walk = (part: unknown, depth: number) => {
    if (depth > 4 || part === null || typeof part !== "object") return;
    if (Array.isArray(part)) {
      for (const one of part) walk(one, depth + 1);
      return;
    }
    const record = part as Record<string, unknown>;
    for (const [field, raw] of Object.entries(record)) {
      const kind = fieldObject(routeKey, field);
      if (kind === "nested") walk(raw, depth + 1);
      if (kind === undefined || kind === "none" || kind === "nested") continue;
      if (Array.isArray(raw)) {
        raw.forEach((value, index) => { if (named(value)) out.push({ holder: raw, at: index, kind, value: String(value) }); });
      } else if (named(raw)) {
        out.push({ holder: record, at: field, kind, value: String(raw) });
      }
    }
  };
  for (const part of parts) walk(part, 0);
  return out;
}

/** The objects a request names (field-less view of `namedValues`, for the hook's quick «names nothing» exit and tests). */
export function requestObjects(
  routeKey: string,
  parts: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Array<{ kind: RealmObjectKind; value: string }> {
  return namedValues(routeKey, parts).map(({ kind, value }) => ({ kind, value }));
}

/** A value of the kind that names no object at all: what a request naming the other realm's object is answered as. */
export function absentValue(kind: RealmObjectKind, original: unknown): unknown {
  if (kind === "order") return "K-9007199254740991";
  if (BY_TEXT.has(kind)) return "∅";
  return typeof original === "number" ? Number.MAX_SAFE_INTEGER : String(Number.MAX_SAFE_INTEGER);
}

/**
 * THE CHECK: every object the request names is of the principal's realm. One of the other realm is replaced, in the
 * request itself, by a value that names nothing (`absentValue`), so the operation answers EXACTLY as for an object that
 * does not exist — its own 404, its own empty list — and nothing tells «there, but not yours» from «not there» (no
 * oracle across the wall). A field that names the object an operation CREATES is `none` (the service's own «taken»
 * answers); every other field the sentinel reaches is refused by the service as unknown (tests/sandbox-realm-objects:
 * a hidden object never makes a write succeed). One query per kind. Returns how many were hidden. A live agent key is
 * left to its page grant (a live key never holds a test page, 0414): its hot read plane asks nothing more.
 */
export async function hideObjectsOfOtherRealm(
  app: { db: Database },
  principal: AuthPrincipal | null | undefined,
  routeKey: string,
  parts: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Promise<number> {
  if (!principal) return 0;
  const test = isTestPrincipal(principal) || isTestAgent(principal);
  if (principal.kind === "agent" && !test) return 0;
  const values = namedValues(routeKey, parts);
  const byKind = new Map<RealmObjectKind, NamedValue[]>();
  for (const one of values) byKind.set(one.kind, [...(byKind.get(one.kind) ?? []), one]);
  let hidden = 0;
  for (const [kind, list] of byKind) {
    const realms = await realmsOf(app.db, kind, list.map((one) => one.value));
    for (const one of list) {
      const objectTest = realms.get(one.value);
      if (objectTest === undefined || objectTest === test) continue;
      const original = (one.holder as Record<string | number, unknown>)[one.at];
      (one.holder as Record<string | number, unknown>)[one.at] = absentValue(kind, original);
      hidden += 1;
    }
  }
  return hidden;
}

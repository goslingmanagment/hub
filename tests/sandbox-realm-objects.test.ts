import { describe, expect, it } from "vitest";

import { routeSchemas } from "@agency_hub_core/contracts";

import { fieldObject, KIND_TABLES, requestObjects, restoreHidden, type RealmObjectKind } from "../apps/runtime/src/services/sandbox/objects.ts";
import { SANDBOX_OWNER_OPERATIONS } from "../apps/runtime/src/services/sandbox/owner-operations.ts";
import { PERSON_DOOR_OPERATIONS } from "../apps/runtime/src/services/person-door.ts";

// The wall by object (services/sandbox/objects.ts) knows what every field a test principal can send names. This test
// reads the contract itself: every operation the test owner's table admits, every operation open to a chatter, a team
// lead or a content manager by its declaration, and every operation of the person's door (ContentOps acting as a person,
// checked as its console operation) — and fails on an id-shaped field of their params, query or body that the wall does
// not classify. A new route or a new field is classified before it ships (an object of a realm, or `none` with why).

type Zod = { _zod: { def: Record<string, unknown> & { type: string } } };
type RouteSchema = { auth?: { kind: string }; params?: Zod; querystring?: Zod; body?: Zod };

/** What looks like it names a thing: an id, a list of ids, a label, a slug, a code, a person. */
const ID_SHAPED = /(Id|Ids|Label|Labels|Slug|Slugs|Code|Codes)$|^(id|ids|code|slug|label|person|key)$/u;
/** Opaque idempotency and request ids the client mints itself: they name nothing of a realm. */
const MINTED = new Set(["clientRequestId", "idempotencyKey", "requestId", "clientEventId", "instanceId", "browserProfileId"]);

function unwrap(schema: Zod): Zod {
  let current = schema;
  for (;;) {
    const def = current._zod.def;
    if (["optional", "default", "catch", "nullable"].includes(def.type)) { current = def.innerType as Zod; continue; }
    if (def.type === "pipe") { current = def.in as Zod; continue; }
    return current;
  }
}

/** The fields of a shape (a list's element, a union's every option): name and schema. */
function shapeOf(schema: Zod | undefined): Array<[string, Zod]> {
  if (!schema) return [];
  let object = unwrap(schema);
  if (object._zod.def.type === "array") return shapeOf(object._zod.def.element as Zod);
  const shapes: Zod[] = object._zod.def.type === "union" ? (object._zod.def.options as Zod[]).map(unwrap) : [object];
  const out: Array<[string, Zod]> = [];
  for (object of shapes) {
    if (object._zod.def.type === "object") out.push(...Object.entries(object._zod.def.shape as Record<string, Zod>));
  }
  return out;
}

/** Whether a container holds an id-shaped field anywhere inside. */
function holdsIds(schema: Zod, depth = 0): boolean {
  return depth < 5 && shapeOf(schema).some(([name, field]) => (ID_SHAPED.test(name) && !MINTED.has(name)) || holdsIds(field, depth + 1));
}

/**
 * The fields the wall must classify: every id-shaped field at the top, every container holding one (it is `nested` or
 * `none`), and the fields of the containers it declares `nested`.
 */
function unclassifiedOf(routeKey: string, schema: Zod | undefined, prefix: string, skip: ReadonlySet<string>, depth = 0): string[] {
  const out: string[] = [];
  for (const [name, field] of shapeOf(schema)) {
    if (skip.has(name) || MINTED.has(name)) continue;
    const kind = fieldObject(routeKey, name);
    if (kind === "nested") { if (depth < 5) out.push(...unclassifiedOf(routeKey, field, `${prefix}${name}.`, skip, depth + 1)); continue; }
    if (kind !== undefined) continue;
    if (ID_SHAPED.test(name) || holdsIds(field)) out.push(`${prefix}${name}`);
  }
  return out;
}

const schemas = routeSchemas as unknown as Record<string, RouteSchema>;
const HUMAN_KINDS = new Set(["any", "any-session", "session"]);

describe("the wall by object classifies every field a test principal can send", () => {
  it("every id-shaped field of every operation open to the test realm names an object of a realm, or says it does not", () => {
    const unclassified: string[] = [];
    const doorConsole = new Map(Object.entries(PERSON_DOOR_OPERATIONS).map(([key, row]) => [key, row.console]));
    for (const [key, schema] of Object.entries(schemas)) {
      const console = doorConsole.get(key);
      const open = SANDBOX_OWNER_OPERATIONS.has(key) || HUMAN_KINDS.has(schema.auth?.kind ?? "") || console !== undefined;
      if (!open) continue;
      for (const [where, part] of [["params", schema.params], ["query", schema.querystring], ["body", schema.body]] as const) {
        const skip = new Set(console === undefined ? [] : ["client", "grant"]);
        for (const path of unclassifiedOf(console ?? key, part, "", skip)) unclassified.push(`${key} ${where}.${path}${console ? ` (as ${console})` : ""}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("names a claim by its id, a login by its id, every value of a list, and nothing it calls `none`", () => {
    expect(requestObjects("saleDisputeOfClaim", [{ claimId: 39 }])).toEqual([{ kind: "claim", value: "39" }]);
    expect(requestObjects("saleDisputeDecide", [{}, {}, { claimId: 39, outcome: "x" }])).toEqual([{ kind: "claim", value: "39" }]);
    expect(requestObjects("shiftReportsList", [{}, { userId: 17, from: "2026-11-01" }])).toEqual([{ kind: "login", value: "17" }]);
    expect(requestObjects("adminPersonCreate", [{}, {}, { code: "new", workingPageLabels: ["a", "b"] }]).map((one) => one.value)).toEqual(["a", "b"]);
    expect(requestObjects("customOrder", [{ code: "K-12" }])).toEqual([{ kind: "order", value: "K-12" }]);
    // Inside a container not declared `nested`, a `userId` is not a login (Telegram's id of a person, a platform's fan).
    expect(requestObjects("adminPersonCreate", [{}, {}, { code: "new", telegram: { userId: 5 }, schedule: { pageLabel: "p" } }])).toEqual([{ kind: "pageLabel", value: "p" }]);
    expect(requestObjects("ofapiActionPrepare", [{}, {}, { command: { userId: 5, pageId: 7 } }])).toEqual([]);
    expect(requestObjects("authRevokeDevice", [{ deviceId: 3 }])).toEqual([]);
    expect(requestObjects("adminPublicationApprove", [{}, {}, { items: [{ id: 5, version: 2 }, { id: 6, version: 1 }] }]).map((one) => one.value)).toEqual(["5", "6"]);
  });
});

/**
 * What each route's field really names, read from its handler, for every name that more than one table uses or that
 * means nothing by itself (`id`, `code`, `proposalId`, `questionId`): a route carrying one of these names is listed here
 * by hand, or this test fails. The unambiguous names (`pageLabel`, `userId`, `shiftId`, …) name one table everywhere.
 */
const AMBIGUOUS = new Set(["id", "code", "slug", "proposalId", "questionId", "candidateId", "sightingId", "publicationId"]);
const HANDLER_TABLES: Readonly<Record<string, string>> = {
  "adminPublicationGet id": "publications",
  "adminPublicationApprove id": "publications",
  "adminPublicationCancel id": "publications",
  "adminPublicationResolve id": "publications",
  "adminPublicationWithdraw id": "publications",
  "adminPublicationDeletePost id": "publications",
  "adminPublicationReplace id": "publications",
  "agentMediaLookCreate publicationId": "publications",
  "teamQuestions id": "team_questions",
  "teamQuestionAnswer id": "team_questions",
  "teamQuestionClose id": "team_questions",
  "teamSwapRevoke id": "team_questions",
  // A sale question of the agents' door is a row of sale_claims (kind `question`, sale-decisions-door.ts).
  "agentSaleQuestionAnswer questionId": "sale_claims",
  "agentSaleQuestionClose questionId": "sale_claims",
  // «Предложение» of a report card (the board) and an agent's proposal about a person: two tables, one name.
  "shiftReportProposalAnswer proposalId": "shift_handin_proposals",
  "adminPersonProposalDecide proposalId": "person_proposals",
  "shiftReportConfirm candidateId": "shift_handin_candidates",
  "agentShiftReportCheckAnswer candidateId": "shift_handin_candidates",
  "shiftReportSightingAdd sightingId": "sale_sightings",
  "customOrder code": "custom_orders",
  "customOrderAct code": "custom_orders",
  "adminPerson code": "people",
  "adminPersonUpdate code": "people",
};

function classified(key: string, schema: Zod | undefined, depth = 0): Array<{ name: string; kind: RealmObjectKind }> {
  const out: Array<{ name: string; kind: RealmObjectKind }> = [];
  for (const [name, field] of shapeOf(schema)) {
    const kind = fieldObject(key, name);
    if (kind === "nested") { if (depth < 5) out.push(...classified(key, field, depth + 1)); continue; }
    if (kind !== undefined && kind !== "none") out.push({ name, kind });
  }
  return out;
}

describe("the wall by object reads the table each route's field really names", () => {
  it("every classified field of every route of the contract: the kind's table is the handler's", () => {
    const wrong: string[] = [];
    for (const [key, schema] of Object.entries(schemas)) {
      for (const part of [schema.params, schema.querystring, schema.body]) {
        for (const { name, kind } of classified(key, part)) {
          const listed = HANDLER_TABLES[`${key} ${name}`];
          if (AMBIGUOUS.has(name) && listed === undefined) { wrong.push(`${key} ${name}: not listed in HANDLER_TABLES`); continue; }
          if (listed !== undefined && KIND_TABLES[kind] !== listed) wrong.push(`${key} ${name}: the wall reads ${KIND_TABLES[kind]}, the handler ${listed}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the wall by object costs nothing where it has nothing to look at", () => {
  it("never walks a raw body: a 1 MB buffer, a typed array, a date, a class instance are not entered", () => {
    const untouchable = new Proxy(Buffer.alloc(1024 * 1024, 1), { ownKeys() { throw new Error("walked"); } });
    class Thing { pageLabel = "test-1"; }
    const started = performance.now();
    expect(requestObjects("ingestObservations", [{}, {}, untouchable as unknown as Record<string, unknown>])).toEqual([]);
    expect(requestObjects("teamShifts", [{}, { pageLabel: new Date(), when: new Uint8Array(1024) }, new Thing() as unknown as Record<string, unknown>])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("puts nothing back when nothing was hidden: the answer is the same string", () => {
    const payload = JSON.stringify({ message: "∅1 9007199254740990" });
    expect(restoreHidden([{ a: 1 }, null, Buffer.alloc(8)], payload)).toBe(payload);
  });
});

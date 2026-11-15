import { describe, expect, it } from "vitest";

import { routeSchemas } from "@agency_hub_core/contracts";

import { fieldObject, requestObjects } from "../apps/runtime/src/services/sandbox/objects.ts";
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

/** Every field name of a shape, nested objects and lists of objects included (`items[].id` is `items.id`). */
function fieldsOf(schema: Zod | undefined, prefix = "", depth = 0): Array<{ path: string; name: string }> {
  if (!schema || depth > 4) return [];
  let object = unwrap(schema);
  if (object._zod.def.type === "array") return fieldsOf(object._zod.def.element as Zod, prefix, depth + 1);
  const shapes: Zod[] = object._zod.def.type === "union" ? (object._zod.def.options as Zod[]).map(unwrap) : [object];
  const out: Array<{ path: string; name: string }> = [];
  for (object of shapes) {
    if (object._zod.def.type !== "object") continue;
    for (const [name, field] of Object.entries(object._zod.def.shape as Record<string, Zod>)) {
      out.push({ path: `${prefix}${name}`, name });
      out.push(...fieldsOf(field, `${prefix}${name}.`, depth + 1));
    }
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
        for (const { path, name } of fieldsOf(part)) {
          if (!ID_SHAPED.test(name) || MINTED.has(name) || (console !== undefined && (name === "client" || name === "grant"))) continue;
          if (fieldObject(console ?? key, name) === undefined) unclassified.push(`${key} ${where}.${path}${console ? ` (as ${console})` : ""}`);
        }
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("names a claim by its id, a login by its id, every value of a list, and nothing it calls `none`", () => {
    expect(requestObjects("saleDisputeOfClaim", [{ claimId: 39 }])).toEqual([{ field: "claimId", kind: "claim", value: "39" }]);
    expect(requestObjects("saleDisputeDecide", [{}, {}, { claimId: 39, outcome: "x" }])).toEqual([{ field: "claimId", kind: "claim", value: "39" }]);
    expect(requestObjects("shiftReportsList", [{}, { userId: 17, from: "2026-11-01" }])).toEqual([{ field: "userId", kind: "login", value: "17" }]);
    expect(requestObjects("adminPersonCreate", [{}, {}, { code: "new", workingPageLabels: ["a", "b"] }]).map((one) => one.value)).toEqual(["a", "b"]);
    expect(requestObjects("customOrder", [{ code: "K-12" }])).toEqual([{ field: "code", kind: "order", value: "K-12" }]);
    expect(requestObjects("authRevokeDevice", [{ deviceId: 3 }])).toEqual([]);
    expect(requestObjects("adminPublicationApprove", [{}, {}, { items: [{ id: 5, version: 2 }, { id: 6, version: 1 }] }]).map((one) => one.value)).toEqual(["5", "6"]);
  });
});

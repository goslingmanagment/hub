import { describe, expect, it } from "vitest";

import {
  CUSTOM_ORDER_ACTIONS,
  OWNER_AGENT_CUSTOM_STEPS,
  OWNER_AGENT_OPERATION_NAMES,
  OWNER_AGENT_OPERATION_SCHEMAS,
  routeSchemas,
  type RouteAuthPolicy,
} from "@agency_hub_core/contracts";

import { computeAuthPolicyVerdict } from "../apps/runtime/src/api/auth-policy.ts";
import {
  canAccessPage,
  isAgentPrincipal,
  isNarrowPrincipal,
  requireAgentPrincipal,
  requireHumanPrincipal,
  requireOwnerAgentPrincipal,
  type AuthPrincipal,
  type OwnerAgentPrincipal,
} from "../apps/runtime/src/services/auth.ts";
import { OWNER_AGENT_NEVER, OWNER_AGENT_OPERATIONS, ownerAgentNever, ownerAgentNeverIn, ownerReasonOf } from "../apps/runtime/src/services/owner-agent-door.ts";
import { auditCtx, pageScopeFor } from "../apps/runtime/src/services/page-scope.ts";

// The owner's agent door (payouts plan 2026-11-24, §1.8, H9): its key's principal is neither a person nor an agent, so
// every route but its own refuses it by kind, and its own refuses everyone else; its table and what it never has do
// not meet; a call without the owner's reason never runs. Synthetic ids only.

const ownerAgent: OwnerAgentPrincipal = {
  kind: "owner_agent", authMethod: "owner_agent_key", agentKeyId: 41, keyName: "owner-desk-test", ownerUserId: 7, actsAsUserId: 7,
};
const ownerSession: AuthPrincipal = {
  authMethod: "session",
  user: { id: 7, username: "boss", role: "owner", assignedPages: [], mustChangePassword: false },
  assignedPageIds: [],
  authSessionId: 1,
};
const agentKey: AuthPrincipal = { kind: "agent", authMethod: "agent_key", agentKeyId: 42, keyName: "writer", capabilities: ["write:shift_reports"], pageIds: [3] };

const routes = Object.entries(routeSchemas as unknown as Record<string, { auth: RouteAuthPolicy }>);

function verdictFor(principal: AuthPrincipal, auth: RouteAuthPolicy) {
  return computeAuthPolicyVerdict({
    auth,
    resolvePrincipal: async () => principal,
    hasMonitoringToken: () => false,
    resolvePageAccess: async () => "ok",
    pageLabelParam: auth.scope === "page" ? "mia-1" : undefined,
  });
}

/** Every field name a schema can carry, nested objects and arrays included. */
function fieldNames(schema: unknown, depth = 0): string[] {
  if (depth > 6 || schema === null || typeof schema !== "object") return [];
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (def === undefined) return [];
  const inner = [def.innerType, def.in, def.out, def.element, def.schema].filter((one) => one !== undefined);
  const shape = def.shape as Record<string, unknown> | undefined;
  const own = shape === undefined ? [] : Object.entries(shape).flatMap(([name, field]) => [name, ...fieldNames(field, depth + 1)]);
  const options = Array.isArray(def.options) ? (def.options as unknown[]).flatMap((one) => fieldNames(one, depth + 1)) : [];
  return [...own, ...options, ...inner.flatMap((one) => fieldNames(one, depth + 1))];
}

describe("the owner's agent door: its principal", () => {
  it("is refused by every route but its own, and its own refuses a person and an agent", async () => {
    const admitted: string[] = [];
    for (const [key, schema] of routes) {
      if (schema.auth.kind === "public" || schema.auth.kind === "hmac") continue;
      const verdict = await verdictFor(ownerAgent, schema.auth);
      if (verdict.allow) admitted.push(key);
      else expect(verdict.statusCode, key).toBe(403);
    }
    expect(admitted).toEqual(["ownerAgentCall"]);

    const own = routeSchemas.ownerAgentCall.auth as RouteAuthPolicy;
    for (const principal of [ownerSession, agentKey]) {
      expect(await verdictFor(principal, own)).toMatchObject({ allow: false, statusCode: 403 });
    }
  });

  it("is neither a person nor an agent, and reaches no page itself", () => {
    expect(() => requireHumanPrincipal(ownerAgent)).toThrow(/agent keys/);
    expect(() => requireAgentPrincipal(ownerAgent)).toThrow(/agent key/);
    expect(isAgentPrincipal(ownerAgent)).toBe(false);
    expect(isNarrowPrincipal(ownerAgent)).toBe(false);
    expect(() => requireOwnerAgentPrincipal(ownerSession)).toThrow(/owner's agent key/);
    expect(() => requireOwnerAgentPrincipal(agentKey)).toThrow(/owner's agent key/);
    expect(pageScopeFor(ownerAgent)).toEqual([]);
    expect(canAccessPage(ownerAgent, 3)).toBe(false);
    // Its writes name the owner it acts as and the key beside him.
    expect(auditCtx(ownerAgent)).toEqual({ source: "owner_agent", actorUserId: 7, actorAgentKeyId: 41 });
  });
});

describe("the owner's agent door: its table", () => {
  it("has exactly the contract's operations, each doing a console operation that exists", () => {
    expect(Object.keys(OWNER_AGENT_OPERATIONS).sort()).toEqual([...OWNER_AGENT_OPERATION_NAMES].sort());
    for (const [op, row] of Object.entries(OWNER_AGENT_OPERATIONS)) {
      expect(Object.hasOwn(routeSchemas, row.console), `${op} → ${row.console}`).toBe(true);
    }
  });

  it("never meets what the door never has: no operation, console operation or argument of it", () => {
    const met = Object.entries(OWNER_AGENT_OPERATIONS).flatMap(([op, row]) => [op, row.console].filter((name) => ownerAgentNever(name)));
    expect(met).toEqual([]);
    // The walk reads nested fields (a schedule's slot, a share's person): the check below is not vacuous.
    expect(fieldNames(OWNER_AGENT_OPERATION_SCHEMAS["people.edit"].args)).toEqual(expect.arrayContaining(["workingPageLabels", "slot", "weekdays", "doneAt"]));
    expect(fieldNames(OWNER_AGENT_OPERATION_SCHEMAS["sale.decide"].args)).toEqual(expect.arrayContaining(["shares", "person", "percent"]));
    // …a custom step's union and its card's patch, a finding's record.
    expect(fieldNames(OWNER_AGENT_OPERATION_SCHEMAS["custom.step"].args)).toEqual(expect.arrayContaining(["step", "action", "card", "notes", "deadlineOn", "acceptedBy"]));
    expect(fieldNames(OWNER_AGENT_OPERATION_SCHEMAS["customFinding.answer"].args)).toEqual(expect.arrayContaining(["step", "card", "task", "code", "reason"]));
    const never = new Set<string>(OWNER_AGENT_NEVER.fields);
    for (const op of OWNER_AGENT_OPERATION_NAMES) {
      const names = fieldNames(OWNER_AGENT_OPERATION_SCHEMAS[op].args);
      expect(names.filter((name) => never.has(name)), op).toEqual([]);
    }
    // The predicate does refuse the families it names.
    for (const name of ["agentKeyCreate", "adminPersonPayTermSet", "authChangePassword", "erasureCreate", "adminConfigUpdate", "teamPayout"]) {
      expect(ownerAgentNever(name), name).toBe(true);
    }
  });

  it("refuses an argument an operation does not name: rights, pay terms, a login, a pot", () => {
    const edit = OWNER_AGENT_OPERATION_SCHEMAS["people.edit"].args;
    expect(edit.safeParse({ code: "anna", displayName: "Анна" }).success).toBe(true);
    for (const extra of [{ rights: ["submits_shift"] }, { payTerms: [] }, { logins: { add: [5] } }, { role: "team_lead" }, { telegram: { userId: 5 } }, { anything: 1 }]) {
      expect(edit.safeParse({ code: "anna", ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    // Nothing to change is nothing.
    expect(edit.safeParse({ code: "anna" }).success).toBe(false);
    const decide = OWNER_AGENT_OPERATION_SCHEMAS["sale.decide"].args;
    expect(decide.safeParse({ transactionId: 9, kind: "owner", shares: [{ person: "anna", percent: 100 }], note: "чат вела она" }).success).toBe(true);
    expect(decide.safeParse({ transactionId: 9, kind: "pot", shares: [], note: "x" }).success).toBe(false);
    expect(decide.safeParse({ transactionId: 9, kind: "owner", shares: [], note: "x", pot: "obshak" }).success).toBe(false);
  });
});

describe("the owner's agent door: what it never takes, in the arguments (H10)", () => {
  it("finds a never-field at any depth, in any case, with or without «_», and a never-step by its action", () => {
    for (const args of [
      { rights: [] },
      { schedule: { slot: { start: "10:00", rights: ["x"] } } },
      { onboarding: [{ step: "x", payout_details: {} }] },
      { a: [[{ b: { PaidWord: 1 } }]] },
      { step: { action: "edit", card: { price: "100$" } } },
      { step: { action: "edit", priceMills: 5 } },
      { step: { price_mills: 5 } },
      { proposal: {} },
      { step: { action: "payment", transactionRef: "1" } },
      { step: { action: "unpay" } },
      { step: { action: "PAID_WORD" } },
      { step: { action: "cancel" } },
    ]) {
      expect(ownerAgentNeverIn(args), JSON.stringify(args)).not.toBeNull();
    }
    // What the operations do take is no never-field: a card's link, a note, a taker, a sale's id.
    for (const args of [
      { code: "K-1", step: { action: "card", telegramRef: "https://t.me/c/1/2" } },
      { code: "K-1", step: { action: "accepted_by", acceptedBy: "anna" } },
      { code: "anna", note: "x", schedule: { from: "2026-12-01", slot: null }, workingPageLabels: ["mia-1"] },
      { decisionId: 1, transactionId: 2 },
      { key: "agent.ask:1", text: "action" },
    ]) {
      expect(ownerAgentNeverIn(args), JSON.stringify(args)).toBeNull();
    }
    // Deeper than any operation's arguments: refused as it is.
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) deep = { inner: deep };
    expect(ownerAgentNeverIn(deep)).not.toBeNull();
  });

  it("takes the board's steps of no money and no other; an edit is the card's fields without its price", () => {
    const steps = new Set<string>(OWNER_AGENT_CUSTOM_STEPS);
    expect(OWNER_AGENT_NEVER.steps.filter((step) => steps.has(step))).toEqual([]);
    expect(CUSTOM_ORDER_ACTIONS.filter((action) => !steps.has(action)).sort()).toEqual(["cancel", "paid_word", "payment", "unpay"]);
    const step = OWNER_AGENT_OPERATION_SCHEMAS["custom.step"].args;
    expect(step.safeParse({ code: "K-12", step: { action: "hold", reason: "ждём" } }).success).toBe(true);
    expect(step.safeParse({ code: "K-12", step: { action: "edit", card: { notes: "к субботе", urgency: null } } }).success).toBe(true);
    for (const body of [
      { action: "payment", transactionRef: "1" }, { action: "unpay", transactionRef: "1" }, { action: "paid_word", word: null }, { action: "cancel" },
      { action: "edit", card: { price: "200$" } }, { action: "edit", card: {} }, { action: "edit", card: { notes: "x" }, priceMills: 5 },
    ]) {
      expect(step.safeParse({ code: "K-12", step: body }).success, JSON.stringify(body)).toBe(false);
    }
    const finding = OWNER_AGENT_OPERATION_SCHEMAS["customFinding.answer"].args;
    expect(finding.safeParse({ findingId: 3, step: { action: "dismiss", reason: "not_custom" } }).success).toBe(true);
    expect(finding.safeParse({ findingId: 3, step: { action: "record", card: { task: "Ролик" } } }).success).toBe(true);
    expect(finding.safeParse({ findingId: 3, step: { action: "record", card: { task: "Ролик" }, priceMills: 5 } }).success).toBe(false);
    expect(finding.safeParse({ findingId: 3, step: { action: "record", card: { task: "Ролик", price: "100$" } } }).success).toBe(false);
  });
});

describe("the owner's reason", () => {
  it("is required, 1 to 500 characters after trimming, percent-encoded UTF-8", () => {
    for (const header of [undefined, "", "   ", encodeURIComponent("  ")]) {
      expect(() => ownerReasonOf(header), String(header)).toThrow(/x-hub-owner-reason/);
    }
    expect(ownerReasonOf(encodeURIComponent("  сверяю спорную продажу  "))).toBe("сверяю спорную продажу");
    expect(ownerReasonOf("plain ascii")).toBe("plain ascii");
    expect(ownerReasonOf(encodeURIComponent("я".repeat(500)))).toHaveLength(500);
    expect(() => ownerReasonOf(encodeURIComponent("я".repeat(501)))).toThrow(/500/);
    expect(() => ownerReasonOf("%E0%A4%A")).toThrow(/percent-encoded/);
  });
});

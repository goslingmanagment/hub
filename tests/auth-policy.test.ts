import { describe, expect, it } from "vitest";

import { routeSchemas, type RouteAuthPolicy } from "@agency_hub_core/contracts";

import {
  buildRoutePolicyIndex,
  classifyAuthPolicyDivergence,
  computeAuthPolicyVerdict,
  type PageAccessResolution,
} from "../apps/runtime/src/api/auth-policy.ts";
import type {
  AgentAuthPrincipal,
  AuthPrincipal,
  HumanAuthPrincipal,
} from "../apps/runtime/src/services/auth.ts";

function principalOf(input: {
  authMethod: HumanAuthPrincipal["authMethod"];
  role: HumanAuthPrincipal["user"]["role"];
  assignedPageIds?: number[];
}): HumanAuthPrincipal {
  return {
    authMethod: input.authMethod,
    user: {
      id: 42,
      username: "grid",
      role: input.role,
      mustChangePassword: false,
      assignedPages: [],
    },
    assignedPageIds: input.assignedPageIds ?? [],
  };
}

const ownerSession = principalOf({ authMethod: "session", role: "owner" });
const leadSession = principalOf({ authMethod: "session", role: "team_lead" });
// Decision 370: a chatter holds a cookie session or a device token, nothing else.
const chatterSession = principalOf({ authMethod: "session", role: "chatter" });
const chatterDevice: HumanAuthPrincipal = {
  ...principalOf({ authMethod: "device_token", role: "chatter" }),
  deviceTokenId: 7,
};

const agentKeyPrincipal: AgentAuthPrincipal = {
  kind: "agent",
  authMethod: "agent_key",
  agentKeyId: 9,
  keyName: "reader",
  capabilities: ["read:messages"],
  pageIds: [11],
};

/** Every human principal shape the kernel had before the agent plane existed. */
const humanPrincipals: ReadonlyArray<readonly [string, AuthPrincipal]> = [
  ["owner session", ownerSession],
  ["lead session", leadSession],
  ["chatter session", chatterSession],
  ["chatter device token", chatterDevice],
];

function evaluate(input: {
  auth: RouteAuthPolicy;
  principal?: AuthPrincipal | null;
  monitoringToken?: boolean;
  pendingDeviceToken?: boolean;
  pageAccess?: PageAccessResolution;
  pageLabelParam?: string;
}) {
  return computeAuthPolicyVerdict({
    auth: input.auth,
    resolvePrincipal: async () => {
      if (input.principal === undefined) {
        throw new Error("resolvePrincipal must not be called for this kind");
      }
      return input.principal;
    },
    resolvePendingDeviceToken: async () => input.pendingDeviceToken ?? false,
    hasMonitoringToken: () => input.monitoringToken ?? false,
    resolvePageAccess: async () => {
      if (input.pageAccess === undefined) {
        throw new Error("resolvePageAccess must not be called for this declaration");
      }
      return input.pageAccess;
    },
    pageLabelParam: input.pageLabelParam,
  });
}

describe("computeAuthPolicyVerdict", () => {
  it("allows public and hmac kinds without resolving a principal", async () => {
    await expect(evaluate({ auth: { kind: "public" } })).resolves.toEqual({ allow: true });
    // hmac routes authenticate in-handler over the raw body; the middleware
    // must not consume the request or resolve principals for them.
    await expect(evaluate({ auth: { kind: "hmac" } })).resolves.toEqual({ allow: true });
  });

  it("admits only the specialized pending bearer on the activation policy", async () => {
    await expect(evaluate({
      auth: { kind: "pending-device-token" },
      pendingDeviceToken: true,
    })).resolves.toEqual({ allow: true });
    await expect(evaluate({
      auth: { kind: "pending-device-token" },
      pendingDeviceToken: false,
    })).resolves.toEqual({
      allow: false,
      statusCode: 401,
      reason: "pending_device_token_required",
    });
  });

  it("denies unauthenticated requests on principal kinds with 401", async () => {
    for (const kind of ["session", "owner-session", "apiKey", "device-token", "agentKey", "any"] as const) {
      await expect(evaluate({ auth: { kind }, principal: null })).resolves.toEqual({
        allow: false,
        statusCode: 401,
        reason: "no_principal",
      });
    }
  });

  it("mirrors requireDashboardUser for kind session", async () => {
    await expect(evaluate({ auth: { kind: "session" }, principal: ownerSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "session" }, principal: leadSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "session" }, principal: chatterSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("mirrors requireOwner for kind owner-session", async () => {
    await expect(evaluate({ auth: { kind: "owner-session" }, principal: ownerSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "owner-session" }, principal: leadSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(evaluate({ auth: { kind: "owner-session" }, principal: chatterSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("mirrors requireApiKeyUser for kind apiKey: a device token, never a cookie", async () => {
    // The kind keeps its historical NAME (renaming hundreds of declarations is
    // its own PR); Decision 370 left it one credential — the device token.
    await expect(evaluate({ auth: { kind: "apiKey" }, principal: chatterDevice }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "apiKey" }, principal: chatterSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(evaluate({ auth: { kind: "apiKey" }, principal: ownerSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("accepts only a device-token principal for kind device-token", async () => {
    await expect(evaluate({ auth: { kind: "device-token" }, principal: chatterDevice }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "device-token" }, principal: chatterSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(evaluate({ auth: { kind: "device-token" }, principal: ownerSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("accepts any authenticated principal for kind any", async () => {
    await expect(evaluate({ auth: { kind: "any" }, principal: ownerSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "any" }, principal: chatterDevice }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "any" }, principal: chatterSession }))
      .resolves.toEqual({ allow: true });
  });

  // --- Agent Read Plane isolation (agent-read slice 0b) ---

  it("regression: every pre-agent principal still passes kind any", async () => {
    // "any" became an allowlist rather than a wildcard; the 26 routes that
    // declare it must keep serving sessions, api keys and device tokens.
    for (const [name, principal] of humanPrincipals) {
      await expect(evaluate({ auth: { kind: "any" }, principal }), name)
        .resolves.toEqual({ allow: true });
    }
  });

  it("admits an agent key on kind agentKey and nothing else", async () => {
    await expect(evaluate({ auth: { kind: "agentKey" }, principal: agentKeyPrincipal }))
      .resolves.toEqual({ allow: true });

    const humanOnlyKinds = [
      "monitoring",
      "session",
      "any-session",
      "owner-session",
      "apiKey",
      "device-token",
      "any",
    ] as const;
    for (const kind of humanOnlyKinds) {
      await expect(evaluate({ auth: { kind }, principal: agentKeyPrincipal }), kind)
        .resolves.toMatchObject({ allow: false, statusCode: 403 });
    }
  });

  it("refuses every human principal on kind agentKey", async () => {
    for (const [name, principal] of humanPrincipals) {
      await expect(evaluate({ auth: { kind: "agentKey" }, principal }), name)
        .resolves.toEqual({ allow: false, statusCode: 403, reason: "agent_key_required" });
    }
  });

  it("never satisfies a declared human role with an agent key", async () => {
    await expect(evaluate({
      auth: { kind: "agentKey", roles: ["owner"] },
      principal: agentKeyPrincipal,
    })).resolves.toEqual({ allow: false, statusCode: 403, reason: "role_not_allowed" });
  });

  it("answers denied and not-found identically for an agent key (existence oracle)", async () => {
    const auth: RouteAuthPolicy = { kind: "agentKey", scope: "page" };
    const denied = await evaluate({
      auth,
      principal: agentKeyPrincipal,
      pageAccess: "denied",
      pageLabelParam: "lana",
    });
    const notFound = await evaluate({
      auth,
      principal: agentKeyPrincipal,
      pageAccess: "not-found",
      pageLabelParam: "lana",
    });

    // Byte-identical: an agent key must not learn from the verdict whether a
    // page it cannot read exists at all (spec §5.6).
    expect(denied).toEqual({ allow: false, statusCode: 404, reason: "page_not_found" });
    expect(JSON.stringify(denied)).toBe(JSON.stringify(notFound));

    // A granted page still passes.
    await expect(evaluate({
      auth,
      principal: agentKeyPrincipal,
      pageAccess: "ok",
      pageLabelParam: "lana",
    })).resolves.toEqual({ allow: true });
  });

  it("keeps the 403/404 distinction for human principals", async () => {
    const auth: RouteAuthPolicy = { kind: "any", scope: "page" };
    await expect(evaluate({ auth, principal: chatterDevice, pageAccess: "denied", pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: false, statusCode: 403, reason: "page_access_denied" });
    await expect(evaluate({ auth, principal: chatterDevice, pageAccess: "not-found", pageLabelParam: "gone" }))
      .resolves.toEqual({ allow: false, statusCode: 404, reason: "page_not_found" });
  });

  it("honors the monitoring token before any principal, then falls back to a dashboard session", async () => {
    await expect(evaluate({ auth: { kind: "monitoring" }, monitoringToken: true }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "monitoring" }, principal: leadSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "monitoring" }, principal: chatterSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(evaluate({ auth: { kind: "monitoring" }, principal: null }))
      .resolves.toMatchObject({ allow: false, statusCode: 401 });
  });

  it("narrows by declared roles after the kind check", async () => {
    await expect(evaluate({ auth: { kind: "any", roles: ["owner"] }, principal: leadSession }))
      .resolves.toEqual({ allow: false, statusCode: 403, reason: "role_not_allowed" });
    await expect(evaluate({ auth: { kind: "any", roles: ["owner"] }, principal: ownerSession }))
      .resolves.toEqual({ allow: true });
  });

  it("resolves page scope through the handlers' not-found/denied shape", async () => {
    const auth: RouteAuthPolicy = { kind: "any", scope: "page" };
    await expect(evaluate({ auth, principal: chatterDevice, pageAccess: "ok", pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth, principal: chatterDevice, pageAccess: "denied", pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: false, statusCode: 403, reason: "page_access_denied" });
    await expect(evaluate({ auth, principal: chatterDevice, pageAccess: "not-found", pageLabelParam: "gone" }))
      .resolves.toEqual({ allow: false, statusCode: 404, reason: "page_not_found" });
  });

  it("skips page resolution when the route declares no page scope or carries no pageLabel", async () => {
    await expect(evaluate({ auth: { kind: "any" }, principal: chatterDevice, pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "any", scope: "page" }, principal: chatterDevice }))
      .resolves.toEqual({ allow: true });
  });
});

describe("classifyAuthPolicyDivergence", () => {
  it("flags middleware-deny on a legacy-served request as would-deny", () => {
    expect(classifyAuthPolicyDivergence(
      { allow: false, statusCode: 403, reason: "dashboard_session_required" },
      200,
    )).toBe("would-deny");
  });

  it("flags middleware-allow on a legacy 401/403 as would-allow", () => {
    expect(classifyAuthPolicyDivergence({ allow: true }, 403)).toBe("would-allow");
    expect(classifyAuthPolicyDivergence({ allow: true }, 401)).toBe("would-allow");
  });

  it("treats agreements and unrelated failures as no divergence", () => {
    expect(classifyAuthPolicyDivergence({ allow: true }, 200)).toBeNull();
    expect(classifyAuthPolicyDivergence({ allow: true }, 404)).toBeNull();
    expect(classifyAuthPolicyDivergence({ allow: true }, 500)).toBeNull();
    expect(classifyAuthPolicyDivergence(
      { allow: false, statusCode: 403, reason: "api_key_required" },
      403,
    )).toBeNull();
    expect(classifyAuthPolicyDivergence(
      { allow: false, statusCode: 404, reason: "page_not_found" },
      404,
    )).toBeNull();
  });
});

describe("buildRoutePolicyIndex", () => {
  it("indexes every routeSchemas entry by schema object identity", () => {
    const index = buildRoutePolicyIndex();
    expect(index.size).toBe(Object.keys(routeSchemas).length);
    expect(index.get(routeSchemas.health)).toEqual({
      key: "health",
      auth: { kind: "public" },
    });
    expect(index.get(routeSchemas.adminListUsers)).toEqual({
      key: "adminListUsers",
      auth: { kind: "owner-session" },
    });
    expect(index.get({})).toBeUndefined();
  });
});

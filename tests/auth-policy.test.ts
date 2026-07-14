import { describe, expect, it } from "vitest";

import { routeSchemas, type RouteAuthPolicy } from "@agency_hub_core/contracts";

import {
  buildRoutePolicyIndex,
  classifyAuthPolicyDivergence,
  computeAuthPolicyVerdict,
  type PageAccessResolution,
} from "../apps/runtime/src/api/auth-policy.ts";
import type { AuthPrincipal } from "../apps/runtime/src/services/auth.ts";

function principalOf(input: {
  authMethod: AuthPrincipal["authMethod"];
  role: AuthPrincipal["user"]["role"];
  assignedPageIds?: number[];
}): AuthPrincipal {
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
const chatterKey = principalOf({ authMethod: "api_key", role: "chatter" });
const chatterDevice: AuthPrincipal = {
  ...principalOf({ authMethod: "device_token", role: "chatter" }),
  deviceTokenId: 7,
};

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
    for (const kind of ["session", "owner-session", "apiKey", "device-token", "any"] as const) {
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
    await expect(evaluate({ auth: { kind: "session" }, principal: chatterKey }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("mirrors requireOwner for kind owner-session", async () => {
    await expect(evaluate({ auth: { kind: "owner-session" }, principal: ownerSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "owner-session" }, principal: leadSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(evaluate({ auth: { kind: "owner-session" }, principal: chatterKey }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("mirrors requireApiKeyUser for kind apiKey", async () => {
    await expect(evaluate({ auth: { kind: "apiKey" }, principal: chatterKey }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "apiKey" }, principal: ownerSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("accepts only a device-token principal for kind device-token", async () => {
    await expect(evaluate({ auth: { kind: "device-token" }, principal: chatterDevice }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "device-token" }, principal: chatterKey }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
    await expect(evaluate({ auth: { kind: "device-token" }, principal: ownerSession }))
      .resolves.toMatchObject({ allow: false, statusCode: 403 });
  });

  it("accepts any authenticated principal for kind any", async () => {
    await expect(evaluate({ auth: { kind: "any" }, principal: ownerSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "any" }, principal: chatterKey }))
      .resolves.toEqual({ allow: true });
  });

  it("honors the monitoring token before any principal, then falls back to a dashboard session", async () => {
    await expect(evaluate({ auth: { kind: "monitoring" }, monitoringToken: true }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "monitoring" }, principal: leadSession }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "monitoring" }, principal: chatterKey }))
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
    await expect(evaluate({ auth, principal: chatterKey, pageAccess: "ok", pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth, principal: chatterKey, pageAccess: "denied", pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: false, statusCode: 403, reason: "page_access_denied" });
    await expect(evaluate({ auth, principal: chatterKey, pageAccess: "not-found", pageLabelParam: "gone" }))
      .resolves.toEqual({ allow: false, statusCode: 404, reason: "page_not_found" });
  });

  it("skips page resolution when the route declares no page scope or carries no pageLabel", async () => {
    await expect(evaluate({ auth: { kind: "any" }, principal: chatterKey, pageLabelParam: "lana" }))
      .resolves.toEqual({ allow: true });
    await expect(evaluate({ auth: { kind: "any", scope: "page" }, principal: chatterKey }))
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

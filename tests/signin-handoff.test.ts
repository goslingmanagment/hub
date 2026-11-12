import { describe, expect, it } from "vitest";

import { NARROW_WEB_SESSION_OPERATIONS, routeSchemas, type RouteAuthPolicy } from "@agency_hub_core/contracts";

import { crossOriginRefusal, type OriginCheckInput } from "../apps/runtime/src/api/origin-check.ts";
import {
  NARROW_SESSION_TOKEN_PREFIX,
  requireDashboardUser,
  requireOwner,
  sessionTokenDigest,
  type HumanAuthPrincipal,
} from "../apps/runtime/src/services/auth.ts";
import { NARROW_WEB_SESSION_REFUSAL_MESSAGE, narrowWebSessionRefusal } from "../apps/runtime/src/services/narrow-web-session.ts";
import {
  openSessionToken,
  resolveBrowserNext,
  resolveClientNext,
  sealSessionToken,
  signinNamesOf,
} from "../apps/runtime/src/services/signin-handoff.ts";

// One sign-in across the names (ecosystem plan §3.2): the pure halves of the
// hand-off — where an accept may lead, which cookie changes are taken, what a
// narrow web session reaches. The flow itself, end to end on a database, is
// tests/signin-handoff.integration.test.ts.

const production = signinNamesOf({ isProduction: true } as never);

describe("where an accept may lead (`next`)", () => {
  const team = "https://chatgoose.gosling-agency.ru";

  it("takes a path of the target and an address on one of the names", () => {
    expect(resolveBrowserNext("/workboard/my/shifts?days=14", team, production)).toBe(`${team}/workboard/my/shifts?days=14`);
    expect(resolveBrowserNext("https://hub.gosling-agency.ru/settings?tab=users", team, production))
      .toBe("https://hub.gosling-agency.ru/settings?tab=users");
    expect(resolveBrowserNext(undefined, team, production)).toBe(`${team}/workboard/`);
    expect(resolveBrowserNext(undefined, "https://hub.gosling-agency.ru", production)).toBe("https://hub.gosling-agency.ru/");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/workboard/",
    "/\\evil.example",
    "\\\\evil.example",
    "https://hub.gosling-agency.ru@evil.example/",
    "https://user:pass@hub.gosling-agency.ru/",
    "https://hub.gosling-agency.ru.evil.example/",
    "http://hub.gosling-agency.ru/",
    "https://ext.gosling-agency.ru/",
    "https://contentops.gosling-agency.ru/",
    "https://tasks.gosling-agency.ru/board",
    "https://gosling-agency.ru/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "/api/v1/admin/users",
    "/workboard/../api/v1/auth/logout",
    "/workboard/%2e%2e/api/v1/admin/users",
    "https://hub.gosling-agency.ru/api/v1/auth/sso?to=x",
    "/workboard/my shifts",
    "/workboard/\u0000",
    "http://localhost:5173/",
  ])("refuses %s", (next) => {
    expect(resolveBrowserNext(next, team, production)).toBeNull();
  });

  it("takes a page of the one-name dev setup only outside production", () => {
    const local = signinNamesOf({ isProduction: false } as never);
    expect(resolveBrowserNext("http://localhost:5173/", team, local)).toBe("http://localhost:5173/");
    expect(resolveBrowserNext("http://localhost:5173/", team, production)).toBeNull();
    // A local stand's other names are configured, never assumed.
    expect(resolveBrowserNext("http://tasks.localhost:5173/", team, local)).toBeNull();
  });

  it("gives a client only a path of its own", () => {
    expect(resolveClientNext(undefined)).toBe("/");
    expect(resolveClientNext("/plan?week=2")).toBe("/plan?week=2");
    for (const next of ["https://evil.example/", "//evil.example", "/\\evil", "plan"]) {
      expect(resolveClientNext(next), next).toBeNull();
    }
  });
});

describe("the Origin check of a change made with a cookie", () => {
  const allowed = new Set(["https://hub.gosling-agency.ru", "https://chatgoose.gosling-agency.ru"]);
  const check = (input: Partial<OriginCheckInput> & { headers?: OriginCheckInput["headers"] }) => crossOriginRefusal({
    method: "POST",
    routeKey: "adminCreateInvite",
    authKind: "owner-session",
    headers: {},
    hasSessionCookie: true,
    allowedOrigins: allowed,
    allowLoopback: false,
    ...input,
  });

  it("refuses a page of another name, a sibling subdomain included, and an origin that will not say", () => {
    for (const origin of ["https://evil.example", "https://ext.gosling-agency.ru", "https://tasks.gosling-agency.ru", "https://gosling-agency.ru", "http://hub.gosling-agency.ru", "null"]) {
      expect(check({ headers: { origin } })?.statusCode, origin).toBe(403);
    }
    expect(check({ headers: { "sec-fetch-site": "same-site" } })?.statusCode).toBe(403);
    expect(check({ headers: { "sec-fetch-site": "cross-site" } })?.statusCode).toBe(403);
  });

  it("takes Hub's own pages, and a client that is not a browser", () => {
    expect(check({ headers: { origin: "https://hub.gosling-agency.ru" } })).toBeNull();
    expect(check({ headers: { origin: "https://chatgoose.gosling-agency.ru" } })).toBeNull();
    expect(check({ headers: { "sec-fetch-site": "same-origin" } })).toBeNull();
    expect(check({ headers: {} })).toBeNull();
  });

  it("leaves a bearer, a read and a request without a cookie alone", () => {
    expect(check({ headers: { origin: "https://evil.example", authorization: "Bearer agency_hub_device_x" } })).toBeNull();
    expect(check({ method: "GET", headers: { origin: "https://evil.example" } })).toBeNull();
    expect(check({ hasSessionCookie: false, headers: { origin: "https://evil.example" } })).toBeNull();
    // A public route that does not make a session (the model questionnaire, the device sign-in).
    expect(check({ authKind: "public", routeKey: "authIssueDeviceTokenWithPassword", headers: { origin: "moz-extension://x" } })).toBeNull();
  });

  it("checks the routes that make or end a session even without a cookie", () => {
    for (const routeKey of ["login", "logout", "authRedeemAccountLink"]) {
      expect(check({ routeKey, authKind: "public", hasSessionCookie: false, headers: { origin: "https://ext.gosling-agency.ru" } })?.statusCode, routeKey)
        .toBe(403);
    }
  });

  it("takes a page of the one-name dev setup only outside production", () => {
    expect(check({ headers: { origin: "http://localhost:5173" } })?.statusCode).toBe(403);
    expect(check({ allowLoopback: true, headers: { origin: "http://localhost:5173" } })).toBeNull();
    expect(check({ allowLoopback: true, headers: { origin: "http://tasks.localhost:5173" } })?.statusCode).toBe(403);
    expect(check({ allowLoopback: true, headers: { origin: "http://localhost.evil.example" } })?.statusCode).toBe(403);
  });
});

describe("the narrow web session", () => {
  const schemas = routeSchemas as unknown as Record<string, { auth?: RouteAuthPolicy }>;
  const narrowOwner: HumanAuthPrincipal = {
    authMethod: "session",
    user: { id: 1, username: "owner", role: "owner" } as HumanAuthPrincipal["user"],
    assignedPageIds: [],
    authSessionId: 5,
    narrowDeviceTokenId: 9,
  };

  it("lists no owner, team, device or agent route", () => {
    const refusedKinds = new Set(["owner-session", "session", "monitoring", "agentKey", "apiKey", "device-token"]);
    expect(NARROW_WEB_SESSION_OPERATIONS.filter((key) => refusedKinds.has(schemas[key]!.auth!.kind))).toEqual([]);
    expect(NARROW_WEB_SESSION_OPERATIONS.filter((key) => schemas[key]!.auth!.roles !== undefined)).toEqual([]);
  });

  it("is refused every route off its list, an owner's too, and the dashboard guard refuses it", () => {
    expect(narrowWebSessionRefusal("adminListUsers", narrowOwner)?.message).toBe(NARROW_WEB_SESSION_REFUSAL_MESSAGE);
    expect(narrowWebSessionRefusal("authListDevices", narrowOwner)).not.toBeNull();
    expect(narrowWebSessionRefusal("authSso", narrowOwner)).not.toBeNull();
    expect(narrowWebSessionRefusal("me", narrowOwner)).toBeNull();
    expect(() => requireDashboardUser(narrowOwner)).toThrow(/team's place/);
    expect(() => requireOwner(narrowOwner)).toThrow(/team's place/);
    const { narrowDeviceTokenId: _, ...full } = narrowOwner;
    expect(narrowWebSessionRefusal("adminListUsers", full)).toBeNull();
    expect(() => requireOwner(full)).not.toThrow();
  });

  it("keeps a digest a build without narrow sessions cannot find", () => {
    const token = `${NARROW_SESSION_TOKEN_PREFIX}abc`;
    expect(sessionTokenDigest(token)).not.toBe(sessionTokenDigest(token.slice(NARROW_SESSION_TOKEN_PREFIX.length)));
    expect(sessionTokenDigest("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the planted session's token, sealed by its code", () => {
  it("opens with its code alone", () => {
    const sealed = sealSessionToken("code-one", "session-token");
    expect(sealed).not.toContain("session-token");
    expect(openSessionToken("code-one", sealed)).toBe("session-token");
    expect(openSessionToken("code-two", sealed)).toBeNull();
    expect(openSessionToken("code-one", `${sealed.slice(0, -2)}xx`)).toBeNull();
  });
});

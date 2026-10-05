import { fixtureUserId } from "./helpers/user-identity.ts";
import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createInvite, redeemAccountLink } from "../apps/runtime/src/services/account-links.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// Decision 352 — the rights matrix of the unified account (plan §7). One test
// per row: not "does this service function work" (the PR-1A suites pin that),
// but "what can THIS person, signed in THIS way, reach right now" — the axes a
// single shared login does NOT by itself make consistent: role, sign-in method,
// page assignments, device rights.
//
// Everything runs over HTTP against a live server in enforce mode, because the
// matrix is a claim about what the API answers, not about what a service
// returns. Rows §7 marks "manual" or "documented" are NOT here — they live in
// `docs/identity-rights-matrix.md`, which carries the same row names, so the
// two artefacts can be read side by side.
//
// The server is rebuilt for every test on purpose: `/auth/login` and
// `/auth/device-tokens/password` are rate-limited per IP (20/min each) and
// `inject` gives every request in this file the same loopback address, so one
// shared instance would start answering 429 halfway down the matrix.

const OF_ACCOUNT_ID = "acct_01000000000000000000000000000000";

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const OWNER_AUDIT = { source: "cli" } as const;
const CHATTER_PASSWORD = "correct-horse-battery-1";
const OWNER_PASSWORD = "owner-secret";
const LEAD_PASSWORD = "lead-secret";

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) {
    context.skip();
    return null;
  }
  return { testDb, app, server };
}

function sessionCookieFrom(response: {
  headers: Record<string, string | string[] | number | undefined>;
}) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") throw new Error("Expected a session cookie");
  return value.split(";")[0]!;
}

async function login(
  activeServer: NonNullable<typeof server>,
  username: string,
  password: string,
) {
  return activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
}

async function loginCookie(
  activeServer: NonNullable<typeof server>,
  username: string,
  password: string,
) {
  const response = await login(activeServer, username, password);
  expect(response.statusCode).toBe(200);
  return sessionCookieFrom(response);
}

/** The single client sign-in (Р2): username + password → a live device token,
 * no cookie anywhere. This is how both clients get their credential. */
async function signInDevice(
  activeServer: NonNullable<typeof server>,
  username: string,
  password: string,
  label: string,
) {
  const response = await activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers: { "x-client-version": "2.3.0" },
    payload: { username, password, label, mode: "active" },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string; id: number; label: string }>();
}

async function get(
  activeServer: NonNullable<typeof server>,
  url: string,
  headers: Record<string, string>,
) {
  return activeServer.inject({ method: "GET", url, headers });
}

async function assignPage(
  activeServer: NonNullable<typeof server>,
  ownerCookie: string,
  username: string,
  pageLabel: string,
) {
  const response = await activeServer.inject({
    method: "POST",
    url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, username)}/pages`,
    headers: { cookie: ownerCookie },
    payload: { pageLabel },
  });
  expect(response.statusCode).toBe(200);
}

async function unassignPage(
  activeServer: NonNullable<typeof server>,
  ownerCookie: string,
  username: string,
  pageLabel: string,
) {
  const response = await activeServer.inject({
    method: "DELETE",
    url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, username)}/pages/${pageLabel}`,
    headers: { cookie: ownerCookie },
  });
  expect(response.statusCode).toBe(200);
}

/** Invites grisha the way the owner will from the console, then redeems the
 * link the way /join will — so every row below starts from a real
 * registration rather than from a hand-made password row. */
async function registerChatter(context: AppContext, pageLabels: string[] = []) {
  const invited = await createInvite(context, {
    username: "grisha",
    pageLabels,
  }, OWNER_AUDIT);
  await redeemAccountLink(context, {
    token: invited.link.token,
    password: CHATTER_PASSWORD,
  });
  return invited;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb, {
    authPolicyEnforcement: "enforce",
    // The desktop's read gateway, so the OnlyFans row can ask the question the
    // desktop asks. `app.ofapi` stays undefined: the /accounts branch answers
    // from the local page catalogue and must never reach the vendor.
    ofapiDesktopReadGatewayEnabled: true,
  });
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await server?.close();
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "dmitriy",
    role: "owner",
    password: OWNER_PASSWORD,
  }, OWNER_AUDIT);
  await createUserAccount(app, {
    username: "lead",
    role: "team_lead",
    password: LEAD_PASSWORD,
  }, OWNER_AUDIT);

  const model = await createModel(testDb.db, { slug: "lora-model", name: "Lora" });
  await createFanslyPage(testDb.db, { modelId: model!.id, label: "lora-fansly" });
  await createFanslyPage(testDb.db, { modelId: model!.id, label: "lora-vip" });
  const onlyFansPage = await createOnlyFansPage(testDb.db, {
    modelId: model!.id,
    label: "lora-of",
  });
  await setPageOfapiAccountId(testDb.db, {
    pageId: onlyFansPage!.id,
    ofapiAccountId: OF_ACCOUNT_ID,
  });
  await testDb.pool.query(
    "update pages set username = 'loravie', display_name = 'Lora Free', ofapi_auth_status = 'connected' where id = $1",
    [onlyFansPage!.id],
  );

  server = await buildApiServer(app);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("§7 — page assignments", () => {
  it("row «assigned a Fansly page»: /pages and me carry it on the very next request", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const bearer = { authorization: `Bearer ${device.token}` };

    // Before the assignment the same live credential sees nothing.
    expect((await get(setup.server, "/api/v1/pages", bearer)).json<unknown[]>()).toEqual([]);
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", bearer)).statusCode)
      .toBe(403);

    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);
    await assignPage(setup.server, ownerCookie, "grisha", "lora-fansly");

    // No re-issue, no re-login: the NEXT request on the same token sees it,
    // because the principal's pages are read from the database per request.
    const pages = await get(setup.server, "/api/v1/pages", bearer);
    expect(pages.statusCode).toBe(200);
    expect(pages.json<Array<{ label: string }>>().map((page) => page.label))
      .toEqual(["lora-fansly"]);

    const me = await get(setup.server, "/api/v1/auth/me", bearer);
    expect(me.statusCode).toBe(200);
    const state = me.json<{
      authMethod: string;
      user: {
        username: string;
        role: string;
        assignedPages: Array<{ label: string; platform: string }>;
      };
    }>();
    expect(state.authMethod).toBe("device_token");
    expect(state.user.username).toBe("grisha");
    expect(state.user.role).toBe("chatter");
    expect(state.user.assignedPages).toHaveLength(1);
    expect(state.user.assignedPages[0]).toMatchObject({
      label: "lora-fansly",
      platform: "fansly",
    });

    // …and the page's own operations open with it.
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", bearer)).statusCode)
      .toBe(200);
  }, 60_000);

  it("row «assigned an OnlyFans page»: the desktop's account list carries the acct_… id", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Desktop · kevin");
    const bearer = { authorization: `Bearer ${device.token}` };

    // Same account, same device token, no OnlyFans page yet: an empty rail.
    const before = await get(setup.server, "/api/v1/ofapi/read/accounts", bearer);
    expect(before.statusCode).toBe(200);
    expect(before.json<unknown[]>()).toEqual([]);

    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);
    await assignPage(setup.server, ownerCookie, "grisha", "lora-of");

    const after = await get(setup.server, "/api/v1/ofapi/read/accounts", bearer);
    expect(after.statusCode).toBe(200);
    const accounts = after.json<Array<{ id: string; onlyfans_username: string | null }>>();
    expect(accounts.map((account) => account.id)).toEqual([OF_ACCOUNT_ID]);
    expect(accounts[0]?.onlyfans_username).toBe("loravie");

    // The desktop's page identity crosses platforms on ONE principal: the same
    // token that just read an OnlyFans account also reads a Fansly assignment.
    await assignPage(setup.server, ownerCookie, "grisha", "lora-fansly");
    expect((await get(setup.server, "/api/v1/pages", bearer))
      .json<Array<{ label: string; platform: string }>>()
      .map((page) => `${page.platform}:${page.label}`).sort())
      .toEqual(["fansly:lora-fansly", "onlyfans:lora-of"]);
  }, 60_000);

  it("row «assignment removed»: the page's operations answer 403/404 and the rails go empty", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly", "lora-vip", "lora-of"]);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const bearer = { authorization: `Bearer ${device.token}` };
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);

    expect((await get(setup.server, "/api/v1/pages/lora-vip/subscribers", bearer)).statusCode)
      .toBe(200);
    expect((await get(setup.server, "/api/v1/ofapi/read/accounts", bearer))
      .json<Array<{ id: string }>>().map((account) => account.id)).toEqual([OF_ACCOUNT_ID]);

    await unassignPage(setup.server, ownerCookie, "grisha", "lora-vip");
    await unassignPage(setup.server, ownerCookie, "grisha", "lora-of");

    // Fansly: 403 for a page that exists and is no longer theirs, 404 for one
    // that never existed — the distinction the dashboard's copy depends on.
    expect((await get(setup.server, "/api/v1/pages/lora-vip/subscribers", bearer)).statusCode)
      .toBe(403);
    expect((await get(setup.server, "/api/v1/pages/ghost-page/subscribers", bearer)).statusCode)
      .toBe(404);

    // OnlyFans: the account leaves the rail, and every per-account read of it
    // 404s — before the gateway would have spent a single vendor credit.
    expect((await get(setup.server, "/api/v1/ofapi/read/accounts", bearer)).json<unknown[]>())
      .toEqual([]);
    const perAccount = await get(
      setup.server,
      `/api/v1/ofapi/read/${OF_ACCOUNT_ID}/chats?limit=10`,
      bearer,
    );
    expect(perAccount.statusCode).toBe(404);
    expect(setup.app.ofapi).toBeUndefined();

    // The credential itself is untouched: the page they KEPT still works.
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", bearer)).statusCode)
      .toBe(200);
    expect((await get(setup.server, "/api/v1/pages", bearer))
      .json<Array<{ label: string }>>().map((page) => page.label)).toEqual(["lora-fansly"]);
  }, 60_000);
});

describe("§7 — the revocation ladder as the person experiences it", () => {
  it("row «revoked one sign-in»: the other device keeps working, the revoked one says token_revoked", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly"]);
    const firefox = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const desktop = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Desktop · kevin");
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);

    const revoked = await setup.server.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/device-tokens/${firefox.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(revoked.statusCode).toBe(200);

    const dead = await get(setup.server, "/api/v1/auth/me", {
      authorization: `Bearer ${firefox.token}`,
    });
    expect(dead.statusCode).toBe(401);
    // The machine-readable reason is what lets the client wipe its own custody
    // and show a sign-in screen instead of a permanent red line (§4.5).
    expect(dead.json<{ reason?: string }>().reason).toBe("token_revoked");

    expect((await get(setup.server, "/api/v1/auth/me", {
      authorization: `Bearer ${desktop.token}`,
    })).statusCode).toBe(200);
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", {
      authorization: `Bearer ${desktop.token}`,
    })).statusCode).toBe(200);
  }, 60_000);

  it("row «revoked every device»: all tokens 401, the cookie session stays alive", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly"]);
    const firefox = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const desktop = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Desktop · kevin");
    const chatterCookie = await loginCookie(setup.server, "grisha", CHATTER_PASSWORD);
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);

    const revoked = await setup.server.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/device-tokens`,
      headers: { cookie: ownerCookie },
    });
    expect(revoked.statusCode).toBe(200);

    for (const token of [firefox.token, desktop.token]) {
      const response = await get(setup.server, "/api/v1/auth/me", {
        authorization: `Bearer ${token}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ reason?: string }>().reason).toBe("token_revoked");
    }

    // "Revoke all devices" means devices. The person is still signed in on the
    // web — including in their own cabinet, where they can see the damage.
    expect((await get(setup.server, "/api/v1/auth/me", { cookie: chatterCookie })).statusCode)
      .toBe(200);
    const devices = await get(setup.server, "/api/v1/auth/devices", { cookie: chatterCookie });
    expect(devices.statusCode).toBe(200);
    expect(devices.json<unknown[]>()).toEqual([]);

    // Decision 370 removed the other half of this trap: there is no longer a
    // legacy key that survives "revoke all devices". The trap that remains is
    // the live cookie session above — the offboarding runbook exists to close
    // it: "revoke all devices" is NOT "this person is out".
  }, 60_000);

  it("row «terminated all access»: tokens, sessions and links die — a fresh login with the same password does not", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly"]);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const chatterCookie = await loginCookie(setup.server, "grisha", CHATTER_PASSWORD);
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);

    // An unused reset link is a credential in waiting, so it belongs in the row.
    const link = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/links`,
      headers: { cookie: ownerCookie },
      payload: { kind: "password_reset" },
    });
    expect(link.statusCode).toBe(200);
    const linkToken = link.json<{ token: string }>().token;

    const terminated = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/terminate-access`,
      headers: { cookie: ownerCookie },
    });
    expect(terminated.statusCode).toBe(200);

    expect((await get(setup.server, "/api/v1/auth/me", {
      authorization: `Bearer ${device.token}`,
    })).statusCode).toBe(401);
    expect((await get(setup.server, "/api/v1/auth/me", { cookie: chatterCookie })).statusCode)
      .toBe(401);

    // The link is dead for redemption and discloses nothing but its state.
    const redeem = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/redeem",
      payload: { token: linkToken, password: "another-strong-secret-9" },
    });
    expect(redeem.statusCode).toBe(409);
    expect(redeem.json<{ reason?: string }>().reason).toBe("revoked");
    const inspect = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/inspect",
      payload: { token: linkToken },
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json()).toEqual({ state: "revoked" });

    // The account is neither disabled nor re-passworded: that is the row's
    // whole point — "terminate all access" is not "fire this person".
    expect((await login(setup.server, "grisha", CHATTER_PASSWORD)).statusCode).toBe(200);
    const again = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    expect((await get(setup.server, "/api/v1/auth/me", {
      authorization: `Bearer ${again.token}`,
    })).statusCode).toBe(200);
  }, 60_000);

  it("row «password reset by link»: the old password and every prior sign-in die together", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly"]);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const chatterCookie = await loginCookie(setup.server, "grisha", CHATTER_PASSWORD);
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);

    const link = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/links`,
      headers: { cookie: ownerCookie },
      payload: { kind: "password_reset" },
    });
    expect(link.statusCode).toBe(200);

    const redeem = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/links/redeem",
      payload: { token: link.json<{ token: string }>().token, password: "brand-new-secret-7" },
    });
    expect(redeem.statusCode).toBe(200);

    expect((await login(setup.server, "grisha", CHATTER_PASSWORD)).statusCode).toBe(401);
    expect((await login(setup.server, "grisha", "brand-new-secret-7")).statusCode).toBe(200);

    const dead = await get(setup.server, "/api/v1/auth/me", {
      authorization: `Bearer ${device.token}`,
    });
    expect(dead.statusCode).toBe(401);
    expect(dead.json<{ reason?: string }>().reason).toBe("token_revoked");
    expect((await get(setup.server, "/api/v1/auth/me", { cookie: chatterCookie })).statusCode)
      .toBe(401);

    // Signing in again with the NEW password gives a working device.
    const fresh = await signInDevice(setup.server, "grisha", "brand-new-secret-7", "Firefox · Windows");
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", {
      authorization: `Bearer ${fresh.token}`,
    })).statusCode).toBe(200);
  }, 60_000);

  it("row «deactivated»: every door closes and sign-in refuses WITHOUT an oracle", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly"]);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const chatterCookie = await loginCookie(setup.server, "grisha", CHATTER_PASSWORD);
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);

    const deactivated = await setup.server.inject({
      method: "POST",
      url: `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "grisha")}/deactivate`,
      headers: { cookie: ownerCookie },
    });
    expect(deactivated.statusCode).toBe(200);

    expect((await get(setup.server, "/api/v1/auth/me", {
      authorization: `Bearer ${device.token}`,
    })).statusCode).toBe(401);
    expect((await get(setup.server, "/api/v1/auth/me", { cookie: chatterCookie })).statusCode)
      .toBe(401);
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", {
      authorization: `Bearer ${device.token}`,
    })).statusCode).toBe(401);

    // No oracle: a deactivated account and an account that never existed give
    // byte-identical answers on both sign-in lanes, so a former chatter cannot
    // learn from the hub whether their login still exists.
    const deactivatedLogin = await login(setup.server, "grisha", CHATTER_PASSWORD);
    const unknownLogin = await login(setup.server, "nobody-at-all", CHATTER_PASSWORD);
    expect(deactivatedLogin.statusCode).toBe(401);
    expect(unknownLogin.statusCode).toBe(401);
    expect(deactivatedLogin.json()).toEqual(unknownLogin.json());

    const signIn = async (username: string) => setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      payload: {
        username,
        password: CHATTER_PASSWORD,
        label: "Firefox · Windows",
        mode: "active",
      },
    });
    const deactivatedDevice = await signIn("grisha");
    const unknownDevice = await signIn("nobody-at-all");
    expect(deactivatedDevice.statusCode).toBe(401);
    expect(deactivatedDevice.json()).toEqual(unknownDevice.json());
  }, 60_000);
});

describe("§7 — roles", () => {
  it("owner: every page by cookie, and a device token that is NOT an owner session", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);
    const ownerDevice = await signInDevice(setup.server, "dmitriy", OWNER_PASSWORD, "Firefox · macOS");
    const bearer = { authorization: `Bearer ${ownerDevice.token}` };

    // By cookie the owner reaches the console and every page, assigned or not.
    expect((await get(setup.server, "/api/v1/admin/users", { cookie: ownerCookie })).statusCode)
      .toBe(200);
    expect((await get(setup.server, "/api/v1/pages", { cookie: ownerCookie }))
      .json<Array<{ label: string }>>().map((page) => page.label).sort())
      .toEqual(["lora-fansly", "lora-of", "lora-vip"]);

    // The SAME person on a device token is a client principal, not an owner
    // session: the console stays shut (Р10 — this is why the owner's console
    // account and any account used on a chatter machine stay separate).
    expect((await get(setup.server, "/api/v1/admin/users", bearer)).statusCode).toBe(403);
    expect((await get(setup.server, `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "lead")}/links`, bearer)).statusCode)
      .toBe(403);
    // Nor does a device token open the cabinet: that surface is cookie-only.
    expect((await get(setup.server, "/api/v1/auth/devices", bearer)).statusCode).toBe(403);
    // …while the client surface answers it normally, with owner page reach.
    expect((await get(setup.server, "/api/v1/auth/me", bearer)).statusCode).toBe(200);
    expect((await get(setup.server, "/api/v1/pages/lora-vip/subscribers", bearer)).statusCode)
      .toBe(200);
  }, 60_000);

  it("team_lead: the dashboard yes, the owner routes no, the clients by assignment", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const ownerCookie = await loginCookie(setup.server, "dmitriy", OWNER_PASSWORD);
    await assignPage(setup.server, ownerCookie, "lead", "lora-fansly");
    const leadCookie = await loginCookie(setup.server, "lead", LEAD_PASSWORD);
    const leadDevice = await signInDevice(setup.server, "lead", LEAD_PASSWORD, "Desktop · lead-pc");
    const bearer = { authorization: `Bearer ${leadDevice.token}` };

    expect((await get(setup.server, "/api/v1/models", { cookie: leadCookie })).statusCode).toBe(200);
    expect((await get(setup.server, "/api/v1/admin/users", { cookie: leadCookie })).statusCode)
      .toBe(403);
    expect((await get(setup.server, `/api/v1/admin/users/by-id/${await fixtureUserId(app!, "lead")}/links`, { cookie: leadCookie }))
      .statusCode).toBe(403);

    // Clients: exactly the assigned pages, the same rule as for a chatter.
    expect((await get(setup.server, "/api/v1/pages", bearer))
      .json<Array<{ label: string }>>().map((page) => page.label)).toEqual(["lora-fansly"]);
    expect((await get(setup.server, "/api/v1/pages/lora-vip/subscribers", bearer)).statusCode)
      .toBe(403);
  }, 60_000);

  it("chatter: the cabinet and the clients, never the dashboard", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly"]);
    const chatterCookie = await loginCookie(setup.server, "grisha", CHATTER_PASSWORD);
    const device = await signInDevice(setup.server, "grisha", CHATTER_PASSWORD, "Firefox · Windows");
    const bearer = { authorization: `Bearer ${device.token}` };

    // The cabinet (/account) — the any-session routes, by cookie.
    expect((await get(setup.server, "/api/v1/auth/me", { cookie: chatterCookie })).statusCode)
      .toBe(200);
    const devices = await get(setup.server, "/api/v1/auth/devices", { cookie: chatterCookie });
    expect(devices.statusCode).toBe(200);
    expect(devices.json<Array<{ label: string }>>().map((row) => row.label))
      .toEqual(["Firefox · Windows"]);
    expect((await get(setup.server, "/api/v1/auth/usage", { cookie: chatterCookie })).statusCode)
      .toBe(200);

    // The dashboard and the console stay shut on the same cookie.
    expect((await get(setup.server, "/api/v1/models", { cookie: chatterCookie })).statusCode)
      .toBe(403);
    expect((await get(setup.server, "/api/v1/admin/users", { cookie: chatterCookie })).statusCode)
      .toBe(403);

    // The clients work on the device token, by assignment.
    expect((await get(setup.server, "/api/v1/pages/lora-fansly/subscribers", bearer)).statusCode)
      .toBe(200);
    expect((await get(setup.server, "/api/v1/pages/lora-vip/subscribers", bearer)).statusCode)
      .toBe(403);
  }, 60_000);

  it("chatter, chat-extension token: the extension's own surface and nothing else (H-3)", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await registerChatter(setup.app, ["lora-fansly", "lora-of"]);
    const issued = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": "chat-extension/1.0.0" },
      payload: {
        username: "grisha",
        password: CHATTER_PASSWORD,
        label: "Firefox · macOS · ChatSpace",
        mode: "active",
        client: "chat-extension",
      },
    });
    // Sign in at all: yes, and the hub says the token is the narrow one.
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json<{ client: string | null }>().client).toBe("chat-extension");
    const bearer = { authorization: `Bearer ${issued.json<{ token: string }>().token}` };
    const narrowRefusal = { error: "forbidden", message: "This route is not available to this client", statusCode: 403 };

    // Console, dashboard, cabinet, the plain page list, a page route off its
    // list, the desktop read gateway: one reason-less 403 for all of them.
    for (const url of [
      "/api/v1/admin/users",
      "/api/v1/models",
      "/api/v1/auth/devices",
      "/api/v1/pages",
      "/api/v1/pages/lora-fansly/subscribers",
      "/api/v1/ofapi/read/accounts",
      // The cabinet's list of held chat-extension sends (H-7e): the owner's
      // and a team lead's cookie, never the extension's own token.
      "/api/v1/client-send-custody",
    ]) {
      const response = await get(setup.server, url, bearer);
      expect(response.statusCode, url).toBe(403);
      expect(response.json(), url).toEqual(narrowRefusal);
    }

    // On its list: who am I, the bootstrap (assigned pages only), a page-scoped
    // read of an assigned page, and the page scope still holds on it.
    expect((await get(setup.server, "/api/v1/auth/me", bearer)).statusCode).toBe(200);
    const bootstrap = await get(setup.server, "/api/v1/client/bootstrap", bearer);
    expect(bootstrap.statusCode).toBe(200);
    const identity = bootstrap.json<{ identity: { tokenClient: string | null }; pages: Array<{ pageLabel: string }> }>();
    expect(identity.identity.tokenClient).toBe("chat-extension");
    expect(identity.pages.map((page) => page.pageLabel).sort()).toEqual(["lora-fansly", "lora-of"]);
    expect((await get(setup.server, "/api/v1/pages/lora-of/spender-autolists", bearer)).statusCode).toBe(200);
    const foreign = await get(setup.server, "/api/v1/pages/lora-vip/spender-autolists", bearer);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).not.toEqual(narrowRefusal);
  }, 60_000);

  it("content_manager: cannot sign in anywhere, by either lane", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    // Decision 370 took the role out of the wire enum too; the PG enum value
    // stays, so a historical row is still expressible — by raw SQL and nothing
    // else. What the row can do is the point: nothing, on either lane.
    const hash = await argon2.hash(CHATTER_PASSWORD, { type: argon2.argon2id });
    await setup.testDb.pool.query(
      "insert into users (username, role, password_hash) values ($1, 'content_manager', $2)",
      ["archivist", hash],
    );

    expect((await login(setup.server, "archivist", CHATTER_PASSWORD)).statusCode).toBe(401);
    const device = await setup.server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      payload: {
        username: "archivist",
        password: CHATTER_PASSWORD,
        label: "Firefox · Windows",
        mode: "active",
      },
    });
    expect(device.statusCode).toBe(401);

    // And nothing was minted on the way out.
    const minted = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens",
    );
    expect(Number(minted.rows[0]?.count)).toBe(0);
  }, 60_000);
});

import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import {
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken, issueDeviceTokenForUsername } from "./helpers/device-credentials.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision #126: offboarding is a disabled_at tombstone, never a DELETE.
// Deactivation must revoke every credential in one transaction and fail every
// auth path closed; reactivation restores password login only. Since Decision
// 370 "every credential" means sessions, device tokens, reservations and links.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let baseUrl = "";
let veraFirefoxToken = "";
let veraDeviceToken = "";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) {
    return;
  }
  app = createTestAppContext(testDb);

  await createUserAccount(app, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(app, {
    username: "vera",
    role: "chatter",
  }, { source: "cli" });
  await setUserPassword(app, {
    userId: await fixtureUserId(app, "vera"),
    password: "chatter-secret-1",
  }, { source: "cli" });
  veraFirefoxToken = (await issueChatterDeviceToken(app, { username: "vera" }, { source: "cli" })).key;
  veraDeviceToken = (await issueDeviceTokenForUsername(app, {
    username: "vera",
    label: "test-device",
  }, { source: "cli" })).token;

  const model = await createModel(testDb.db, { slug: "mira-model", name: "Mira Model" });
  await createFanslyPage(testDb.db, { modelId: model!.id, label: "mira" });

  server = await buildApiServer(createTestAppContext(testDb));
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (typeof address === "object" && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
}, 120_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

function requireSetup(context: { skip: () => void }) {
  if (!server) {
    context.skip();
    return null;
  }
  return true;
}

async function login(username: string, password: string) {
  return fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

function cookieOf(response: Response) {
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function me(headers: Record<string, string>) {
  return fetch(`${baseUrl}/api/v1/auth/me`, { headers });
}

describe("user deactivation (#126)", () => {
  it("deactivate revokes every credential and fails all auth paths closed; reactivate restores password only", async (context) => {
    if (!requireSetup(context)) return;

    const ownerCookie = cookieOf(await login("dima", "owner-secret"));

    // Vera is alive on every auth path she has, and each use stamps activity.
    const veraCookie = cookieOf(await login("vera", "chatter-secret-1"));
    expect((await me({ cookie: veraCookie })).status).toBe(200);
    expect((await me({ authorization: `Bearer ${veraFirefoxToken}` })).status).toBe(200);
    expect((await me({ authorization: `Bearer ${veraDeviceToken}` })).status).toBe(200);

    const deactivate = await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/deactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(deactivate.status).toBe(200);
    const result = await deactivate.json() as {
      ok: true;
      revokedDeviceTokens: number;
      revokedSessions: number;
    };
    // Decision 370: the response has no api-key counter left to report.
    expect(result).not.toHaveProperty("revokedApiKeys");
    expect(result.revokedDeviceTokens).toBe(2);
    expect(result.revokedSessions).toBeGreaterThanOrEqual(1);

    // Every path is dead: session, both device tokens, fresh login.
    expect((await me({ cookie: veraCookie })).status).toBe(401);
    expect((await me({ authorization: `Bearer ${veraFirefoxToken}` })).status).toBe(401);
    expect((await me({ authorization: `Bearer ${veraDeviceToken}` })).status).toBe(401);
    expect((await login("vera", "chatter-secret-1")).status).toBe(401);

    // The admin list still carries the row — tombstoned, with the honest
    // activity signal from the pre-deactivation device use.
    const list = await fetch(`${baseUrl}/api/v1/admin/users`, { headers: { cookie: ownerCookie } });
    expect(list.status).toBe(200);
    const users = await list.json() as Array<{
      username: string;
      disabledAt: string | null;
      lastActiveAt: string | null;
    }>;
    const vera = users.find((user) => user.username === "vera")!;
    expect(vera.disabledAt).not.toBeNull();
    expect(vera.lastActiveAt).not.toBeNull();

    // Frozen: nothing that re-opens access works on a tombstoned user. The
    // credential-minting routes are gone entirely (Decision 370), so what is
    // left to freeze is the link lane and page assignment.
    const relink = await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/links`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ kind: "password_reset" }),
    });
    expect(relink.status).toBe(400);
    const reassign = await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ pageLabel: "mira" }),
    });
    expect(reassign.status).toBe(400);

    // Guards: double-deactivate, owner target, unknown target.
    expect((await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/deactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "dima")}/deactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    })).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/admin/users/by-id/${2_147_483_647}/deactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    })).status).toBe(404);

    // Reactivate: the stored password works again; old device tokens stay revoked.
    const reactivate = await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/reactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(reactivate.status).toBe(200);
    expect((await login("vera", "chatter-secret-1")).status).toBe(200);
    expect((await me({ authorization: `Bearer ${veraFirefoxToken}` })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/reactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    })).status).toBe(400);
  }, 60_000);

  // Decision 349 §4.1 p.7: an invite or reset link is a credential in waiting,
  // so it dies with the account — and reactivation does NOT bring it back, the
  // owner mints a fresh one.
  it("revokes active links on deactivation and never revives them on reactivation", async (context) => {
    if (!requireSetup(context)) return;
    const ownerCookie = cookieOf(await login("dima", "owner-secret"));

    const createLink = async () => {
      const response = await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/links`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({ kind: "password_reset" }),
      });
      return { status: response.status, body: await response.json() as { id: number; token: string } };
    };
    const listLinks = async () => {
      const response = await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/links`, {
        headers: { cookie: ownerCookie },
      });
      return await response.json() as Array<{
        id: number;
        state: string;
        revokedReason: string | null;
      }>;
    };

    const link = await createLink();
    expect(link.status).toBe(200);
    expect((await listLinks()).find((row) => row.id === link.body.id)?.state).toBe("active");

    expect((await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/deactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    })).status).toBe(200);
    expect((await listLinks()).find((row) => row.id === link.body.id)).toMatchObject({
      state: "revoked",
      revokedReason: "user_deactivated",
    });

    const redeem = await fetch(`${baseUrl}/api/v1/auth/links/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.body.token, password: "correct-horse-battery-1" }),
    });
    expect(redeem.status).toBe(409);
    expect((await redeem.json() as { reason?: string }).reason).toBe("revoked");

    expect((await fetch(`${baseUrl}/api/v1/admin/users/by-id/${await fixtureUserId(app!, "vera")}/reactivate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    })).status).toBe(200);
    expect((await listLinks()).find((row) => row.id === link.body.id)?.state).toBe("revoked");

    // A new link, on the other hand, works immediately.
    const replacement = await createLink();
    expect(replacement.status).toBe(200);
    expect((await listLinks()).find((row) => row.id === replacement.body.id)?.state).toBe("active");
  }, 60_000);
});

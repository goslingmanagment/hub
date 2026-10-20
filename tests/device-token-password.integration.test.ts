import { fixtureUserId } from "./helpers/user-identity.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  deactivateUser,
  issueDeviceTokenWithPassword,
  loginWithPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 349 Р2: the single client sign-in — username + password, no cookie,
// `active` for the extension and `pending` (reserve → activate) for the
// desktop. It shares the login backoff, the login failure audit and the §4.3
// password core with the cookie lane.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const PASSWORD = "chatter-secret-1";

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) {
    context.skip();
    return null;
  }
  return { testDb, app, server };
}

async function signIn(
  activeServer: NonNullable<typeof server>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return activeServer.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers,
    payload,
  });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb);
  server = await buildApiServer(app);
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "grisha",
    role: "team_lead",
    password: PASSWORD,
  }, { source: "cli" });
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("mode=active (the extension's one atomic write)", () => {
  it("issues a live device token that authenticates immediately", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await signIn(setup.server, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    }, { "x-client-version": "2.3.0" });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      mode: string;
      token: string;
      id: number;
      label: string;
      keyPrefix: string;
      expiresAt: string;
    }>();
    expect(body.mode).toBe("active");
    expect(body.token).toMatch(/^agency_hub_device_/);
    expect(body.keyPrefix).toBe(body.token.slice(0, body.keyPrefix.length));
    expect(body.label).toBe("Firefox · Windows");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const me = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { username: string } }>().user.username).toBe("grisha");
  });
});

describe("who is refused", () => {
  it("answers 401 for a wrong password and journals the failure", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await signIn(setup.server, {
      username: "grisha",
      password: "not-the-password",
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ message: string }>().message).toBe("Invalid username or password");

    const audit = await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from audit_events where event_type = 'auth.login_failed'",
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
    expect(await setup.testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from device_tokens",
    ).then((result) => Number(result.rows[0]?.count))).toBe(0);
  });

  it("answers 401 for an unknown login without saying which half was wrong", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const response = await signIn(setup.server, {
      username: "nobody",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ message: string }>().message).toBe("Invalid username or password");
  });

  it("answers 401 for a deactivated account", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    // No actorUserId: the owner is not a fixture here, and a user may not
    // deactivate themselves.
    await deactivateUser(setup.app, { userId: await fixtureUserId(setup.app, "grisha") }, { source: "cli" });

    const response = await signIn(setup.server, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
    });
    expect(response.statusCode).toBe(401);
  });

  it("shares ONE per-account backoff with the cookie login", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    // Five failures is the free allowance; the sixth attempt is locked out —
    // and the lockout is the account's, not the route's.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(issueDeviceTokenWithPassword(setup.app, {
        username: "grisha",
        password: "not-the-password",
        label: "Firefox · Windows",
        mode: "active",
        clientVersion: null,
      })).rejects.toMatchObject({ statusCode: 401 });
    }

    await expect(loginWithPassword(setup.app, {
      username: "grisha",
      password: PASSWORD,
    })).rejects.toMatchObject({ statusCode: 429 });
    await expect(issueDeviceTokenWithPassword(setup.app, {
      username: "grisha",
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
      clientVersion: null,
    })).rejects.toMatchObject({ statusCode: 429 });
  });
});

// DP 7: a credential coming into existence is a business fact, so the issuance
// audit dual-writes an `observations` row at the choke point. On main this was
// pinned twice through `api_key.issued`; both pins left with the lane, and a
// grep for "device_token.issued" in tests/ came back empty — this is that hole.
//
// These go through the SERVICE rather than the route on purpose: the journaling
// lives there, and the route's per-IP rate limit (20/min, shared with every
// other sign-in this file makes) would otherwise decide the outcome.
describe("the issuance audit", () => {
  const AUDITED = "audrey";

  async function operatorObservations(setup: NonNullable<ReturnType<typeof requireSetup>>) {
    const rows = await setup.testDb.pool.query<{ kind: string; producer: string; payload: unknown }>(
      "select kind, producer, payload from observations where source = 'operator' order by id",
    );
    return rows.rows;
  }

  async function seedAudited(setup: NonNullable<ReturnType<typeof requireSetup>>) {
    // A fresh account per test: no backoff history, no rate-limit budget spent.
    await createUserAccount(setup.app, {
      username: AUDITED,
      role: "team_lead",
      password: PASSWORD,
    }, { source: "cli" });
    // Drop the account-creation rows so the assertions below speak only about
    // issuance (`user.created` journals through the same choke point).
    await setup.testDb.pool.query("delete from observations where source = 'operator'");
    await setup.testDb.pool.query("delete from audit_events");
  }

  it("journals the issuance of both modes with the prefix and NEITHER secret", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await seedAudited(setup);

    const active = await issueDeviceTokenWithPassword(setup.app, {
      username: AUDITED,
      password: PASSWORD,
      label: "Firefox · Windows",
      mode: "active",
      clientVersion: "2.4.0",
    });
    const pending = await issueDeviceTokenWithPassword(setup.app, {
      username: AUDITED,
      password: PASSWORD,
      label: "Desktop · audrey-pc",
      mode: "pending",
      clientVersion: "0.1.55",
    });

    const rows = await operatorObservations(setup);
    const issued = rows.find((row) => row.kind === "device_token.issued");
    const reserved = rows.find((row) => row.kind === "device_token.reserved");

    for (const [row, credential, label, clientVersion] of [
      [issued, active, "Firefox · Windows", "2.4.0"],
      [reserved, pending, "Desktop · audrey-pc", "0.1.55"],
    ] as const) {
      expect(row, label).toBeDefined();
      expect(row!.producer).toBe("api:admin");
      expect(row!.payload).toMatchObject({
        metadata: expect.objectContaining({
          username: AUDITED,
          label,
          keyPrefix: credential.keyPrefix,
          via: "password",
          clientVersion,
        }),
      });
    }

    // The secrets never reach the journal: not the bearer, not the password.
    // The prefix above is exactly what an operator may see — which is why this
    // check cannot be satisfied by simply writing nothing.
    const journal = JSON.stringify(rows);
    expect(journal).not.toContain(active.token);
    expect(journal).not.toContain(pending.token);
    expect(journal).not.toContain(PASSWORD);
  });
});

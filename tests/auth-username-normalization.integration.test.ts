import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findUserByUsername } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createInvite, redeemAccountLink } from "../apps/runtime/src/services/account-links.ts";
import {
  createUserAccount,
  issueDeviceTokenWithPassword,
  loginWithPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Decision 347 Р4: a login is one identity in any case. One normalization for
// the invite, the legacy create and every sign-in, and a unique index on
// lower(username) (migration 0200) so two concurrent creates cannot both win.

let testDb: StartedTestDatabase | null = null;
let app: AppContext | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

const OWNER_AUDIT = { source: "cli", actorUserId: 1 } as const;

function requireSetup(context: { skip: () => void }) {
  if (!testDb || !app || !server) {
    context.skip();
    return null;
  }
  return { testDb, app, server };
}

async function userCount(db: StartedTestDatabase, username: string) {
  const result = await db.pool.query<{ count: string }>(
    "select count(*)::text as count from users where lower(username) = lower($1)",
    [username],
  );
  return Number(result.rows[0]?.count ?? "-1");
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  app = createTestAppContext(testDb, { authPolicyEnforcement: "enforce" });
  server = await buildApiServer(app);
}, 120_000);

beforeEach(async () => {
  if (!testDb || !app) return;
  await resetIntegrationDatabase(testDb.pool);
  await createUserAccount(app, {
    username: "Grisha",
    role: "team_lead",
    password: "chatter-secret-1",
  }, { source: "cli" });
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("signing in", () => {
  it("accepts the login in any case, over cookie login and device sign-in alike", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    for (const spelling of ["Grisha", "grisha", "GRISHA", "  grisha  "]) {
      const session = await loginWithPassword(setup.app, {
        username: spelling,
        password: "chatter-secret-1",
      });
      // The stored spelling is what the person sees, not what they typed.
      expect(session.user.username).toBe("Grisha");
    }

    const issued = await issueDeviceTokenWithPassword(setup.app, {
      username: "gRiShA",
      password: "chatter-secret-1",
      label: "Firefox · Windows",
      mode: "active",
      clientVersion: "2.3.0",
    });
    expect(issued.mode).toBe("active");

    const me = await setup.server.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(me.json<{ user: { username: string } }>().user.username).toBe("Grisha");
  });

  it("still refuses a wrong password, whatever the case of the login", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    await expect(loginWithPassword(setup.app, {
      username: "GRISHA",
      password: "not-the-password",
    })).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("creating an account", () => {
  it("refuses a login that differs only in case — through both creation paths", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    await expect(createUserAccount(setup.app, {
      username: "grisha",
      role: "team_lead",
      password: "another-secret-1",
    }, { source: "cli" })).rejects.toThrow(/already exists/i);

    await expect(createInvite(setup.app, {
      username: "GRISHA",
      pageLabels: [],
    }, OWNER_AUDIT)).rejects.toThrow(/already exists/i);

    expect(await userCount(setup.testDb, "grisha")).toBe(1);
  });

  it("lets the database settle a race two pre-checks would both pass", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;

    const results = await Promise.allSettled([
      createInvite(setup.app, { username: "nikita", pageLabels: [] }, OWNER_AUDIT),
      createInvite(setup.app, { username: "Nikita", pageLabels: [] }, OWNER_AUDIT),
      createInvite(setup.app, { username: "NIKITA", pageLabels: [] }, OWNER_AUDIT),
    ]);

    const created = results.filter((result) => result.status === "fulfilled");
    expect(created).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        // The loser gets the same 400 the pre-check gives, never a 500 and
        // never a raw constraint name.
        expect(result.reason).toMatchObject({ statusCode: 400 });
        expect(String(result.reason)).toMatch(/already exists/i);
      }
    }
    expect(await userCount(setup.testDb, "nikita")).toBe(1);
  });

  it("keeps one identity from invite to first sign-in", async (context) => {
    const setup = requireSetup(context);
    if (!setup) return;
    const invited = await createInvite(setup.app, {
      username: "Nikita",
      pageLabels: [],
    }, OWNER_AUDIT);

    await redeemAccountLink(setup.app, {
      token: invited.link.token,
      password: "correct-horse-battery-1",
    });
    const session = await loginWithPassword(setup.app, {
      username: "nikita",
      password: "correct-horse-battery-1",
    });

    expect(session.user.username).toBe("Nikita");
    const stored = await findUserByUsername(setup.testDb.db, "NIKITA");
    expect(stored?.username).toBe("Nikita");
    expect(await userCount(setup.testDb, "nikita")).toBe(1);
  });
});

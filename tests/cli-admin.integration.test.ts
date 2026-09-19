import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { createAccountLinkForUserId } from "../apps/runtime/src/services/account-links.ts";
import {
  authenticateDeviceToken,
  authenticateSessionToken,
  loginWithPassword,
} from "../apps/runtime/src/services/auth.ts";
import { issueDeviceTokenForUsername } from "./helpers/device-credentials.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

async function loadCliProgram(appContext: ReturnType<typeof createTestAppContext>) {
  vi.resetModules();
  vi.doMock("../apps/runtime/src/bootstrap.ts", () => ({
    createAppContext: async () => appContext,
  }));

  const { buildProgram } = await import("../apps/runtime/src/cli.ts");
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
    outputError: () => {},
  });
  return program;
}

describe("CLI admin flows", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();

    if (!testDb) {
      return;
    }

    await resetIntegrationDatabase(testDb.pool);

    const model = await createModel(testDb.db, {
      slug: "lana-model",
      name: "Lana Model",
    });
    await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "lana",
    });
  });

  it("creates accounts, assigns pages and resets a password — no key group left", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const appContext = createTestAppContext(testDb);
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });

    const run = async (args: string[]) => {
      const program = await loadCliProgram(appContext);
      await program.parseAsync(args, { from: "user" });
    };

    await run(["user", "add", "--username", "dima", "--role", "owner", "--password", "owner-secret"]);
    await run(["user", "add", "--username", "lead", "--role", "team_lead", "--password", "lead-secret"]);
    const assignmentsBeforePage = await testDb.pool.query(`
      select count(*)::int as count
      from user_page_assignments upa
      join users u on u.id = upa.user_id
      where u.username = 'lead'
    `);
    expect(assignmentsBeforePage.rows[0]?.count).toBe(0);

    const leadId = await fixtureUserId(appContext, "lead");
    await run(["user", "assign-page", "--user-id", String(leadId), "--page", "lana"]);
    // Decision 370: `set-password` is the full reset primitive — it ends every
    // sign-in of that person, which is why the CLI says so out loud.
    await run(["user", "set-password", "--user-id", String(leadId), "--password", "lead-secret-2"]);

    consoleSpy.mockRestore();

    expect(logs.some((line) => line.includes("Created user dima"))).toBe(true);
    expect(logs.some((line) => line.includes(`Assigned ${leadId} to lana`))).toBe(true);
    expect(logs.some((line) => line.includes("all of their sign-ins were ended"))).toBe(true);

    const assignmentsAfterPage = await testDb.pool.query(`
      select count(*)::int as count
      from user_page_assignments upa
      join users u on u.id = upa.user_id
      where u.username = 'lead'
    `);
    expect(assignmentsAfterPage.rows[0]?.count).toBe(1);
  });

  it("`user set-password` ends every sign-in, not just the cookie ones", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Decision 370: before this PR the CLI reset advanced the epoch and revoked
    // SESSIONS, and left device tokens alive — so "I reset his password" was a
    // false statement about a laptop still holding a working bearer. It now runs
    // terminateAccessTx, the same primitive a reset link runs.
    const appContext = createTestAppContext(testDb);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const run = async (args: string[]) => {
      const program = await loadCliProgram(appContext);
      await program.parseAsync(args, { from: "user" });
    };

    await run(["user", "add", "--username", "dima", "--role", "owner", "--password", "owner-secret"]);
    await run([
      "user", "add", "--username", "lead", "--role", "team_lead", "--password", "lead-secret",
    ]);

    const device = await issueDeviceTokenForUsername(appContext, {
      username: "lead",
      label: "Desktop · lead-pc",
    }, { source: "cli" });
    const session = await loginWithPassword(appContext, {
      username: "lead",
      password: "lead-secret",
    });
    const leadId = await fixtureUserId(appContext, "lead");
    const link = await createAccountLinkForUserId(appContext, {
      userId: leadId,
      kind: "password_reset",
    }, { source: "cli", actorUserId: 1 });

    const epochBefore = await testDb.pool.query<{ epoch: number }>(
      "select device_token_epoch as epoch from users where username = 'lead'",
    );

    // Everything is alive before the reset.
    expect((await authenticateDeviceToken(appContext, device.token)).principal).not.toBeNull();
    expect(await authenticateSessionToken(appContext, session.sessionToken)).not.toBeNull();

    await run(["user", "set-password", "--user-id", String(leadId), "--password", "lead-secret-2"]);

    // The device token is refused WITH the self-healing reason, so the client
    // wipes its custody and shows a sign-in screen instead of a red line.
    expect(await authenticateDeviceToken(appContext, device.token)).toEqual({
      principal: null,
      failure: { reason: "token_revoked" },
    });
    expect(await authenticateSessionToken(appContext, session.sessionToken)).toBeNull();

    const linkRow = await testDb.pool.query<{ revoked_reason: string | null }>(
      "select revoked_reason from account_links where id = $1 and revoked_at is not null",
      [link.id],
    );
    expect(linkRow.rows).toEqual([{ revoked_reason: "password_set" }]);

    const epochAfter = await testDb.pool.query<{ epoch: number }>(
      "select device_token_epoch as epoch from users where username = 'lead'",
    );
    expect(Number(epochAfter.rows[0]!.epoch)).toBeGreaterThan(Number(epochBefore.rows[0]!.epoch));

    // And the new password is the one that works.
    await expect(loginWithPassword(appContext, {
      username: "lead",
      password: "lead-secret",
    })).rejects.toThrow();
    expect(await loginWithPassword(appContext, {
      username: "lead",
      password: "lead-secret-2",
    })).toBeTruthy();
  });
});

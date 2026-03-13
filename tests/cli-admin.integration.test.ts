import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import { startTestDatabase } from "./helpers/db.ts";
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
  let testDb: Awaited<ReturnType<typeof startTestDatabase>> | null = null;

  beforeAll(async () => {
    try {
      testDb = await startTestDatabase();
    } catch (error) {
      console.warn(
        `Skipping integration tests: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

    await testDb.pool.query(`
      truncate fan_flags, fan_summaries, fan_notes, audit_events, api_keys,
               auth_sessions, user_page_assignments, users, daily_revenue,
               daily_followers, daily_subscribers, transactions, page_subscriptions,
               page_follows, fan_pages, fans, raw_payloads, sync_checkpoints,
               sync_runs, platform_account_proxies, platform_account_credentials,
               platform_accounts, models
      restart identity cascade
    `);

    const model = await createModel(testDb.db, {
      slug: "lana-model",
      name: "Lana Model",
    });
    await createFanslyPage(testDb.db, {
      modelId: model.id,
      label: "lana",
    });
  });

  it("issues user API keys with optional page assignment side effects", async (context) => {
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
    await run(["user", "add", "--username", "anton", "--role", "chatter"]);
    await run(["apikey", "create", "--username", "anton"]);
    const assignmentsBeforePage = await testDb.pool.query(`
      select count(*)::int as count
      from user_page_assignments upa
      join users u on u.id = upa.user_id
      where u.username = 'anton'
    `);
    expect(assignmentsBeforePage.rows[0]?.count).toBe(0);

    await run(["apikey", "create", "--username", "anton", "--page", "lana"]);
    await run(["apikey", "show", "--username", "anton"]);
    await run(["apikey", "revoke", "--username", "anton"]);

    consoleSpy.mockRestore();

    expect(logs.some((line) => line.includes("Created user dima"))).toBe(true);
    expect(logs.some((line) => line.startsWith("agency_hub_core_"))).toBe(true);
    expect(logs.some((line) => line.includes("Revoked 1 API key(s) for anton"))).toBe(true);

    const keyRows = await testDb.pool.query(`
      select count(*)::int as count,
             bool_and(revoked_at is not null) as revoked
      from api_keys ak
      join users u on u.id = ak.user_id
      where u.username = 'anton'
    `);
    expect(keyRows.rows[0]?.count).toBe(2);
    expect(keyRows.rows[0]?.revoked).toBe(true);

    const assignmentsAfterPage = await testDb.pool.query(`
      select count(*)::int as count
      from user_page_assignments upa
      join users u on u.id = upa.user_id
      where u.username = 'anton'
    `);
    expect(assignmentsAfterPage.rows[0]?.count).toBe(1);
  });
});

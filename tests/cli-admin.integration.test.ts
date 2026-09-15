import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

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

    await run(["user", "assign-page", "--username", "lead", "--page", "lana"]);
    // Decision 353: `set-password` is the full reset primitive — it ends every
    // sign-in of that person, which is why the CLI says so out loud.
    await run(["user", "set-password", "--username", "lead", "--password", "lead-secret-2"]);

    consoleSpy.mockRestore();

    expect(logs.some((line) => line.includes("Created user dima"))).toBe(true);
    expect(logs.some((line) => line.includes("Assigned lead to lana"))).toBe(true);
    expect(logs.some((line) => line.includes("all of their sign-ins were ended"))).toBe(true);
    // The retired lane wrote nothing on the way out.
    expect(logs.some((line) => line.startsWith("agency_hub_core_"))).toBe(false);

    const keyRows = await testDb.pool.query("select count(*)::int as count from api_keys");
    expect(keyRows.rows[0]?.count).toBe(0);

    const assignmentsAfterPage = await testDb.pool.query(`
      select count(*)::int as count
      from user_page_assignments upa
      join users u on u.id = upa.user_id
      where u.username = 'lead'
    `);
    expect(assignmentsAfterPage.rows[0]?.count).toBe(1);
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfigOverrides, listConfigAudit, setConfigOverride } from "@agency_hub_core/db";

import { loadEffectiveConfig } from "../apps/runtime/src/services/effective-config.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// Fansly Sync Engine plan §2.1 / §2.5 p.5: the implementation session sets the Fansly
// pause (and rolls it back on a 429) without raw SQL, through `config set|clear|get`
// run inside the api container. It is the console's own write path: the same
// validation (a value below 2000 ms is rejected, never clamped), the same
// config_audit_log rows, and an audit_events row with source "cli".

const BELOW_FLOOR_MESSAGE = "Пауза между запросами Fansly не может быть меньше 2000 мс: правило владельца — "
  + "не чаще одного запроса страницы раз в 2 с. Ниже — только правкой кода.";
const COST_WARNING = "fanslyDefaultDelayMs: Lowering reduces politeness against Fansly's unofficial API; "
  + "raises ban/throttle risk.";

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

describe("CLI config (audited live overrides)", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    if (testDb) {
      await resetIntegrationDatabase(testDb.pool);
    }
  });

  function harness(db: StartedTestDatabase) {
    const appContext = createTestAppContext(db);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const run = async (args: string[]) => {
      const program = await loadCliProgram(appContext);
      await program.parseAsync(args, { from: "user" });
    };
    const takeLogs = () => logs.splice(0, logs.length);
    const auditEvents = async () => (await db.pool.query<{
      event_type: string;
      source: string;
      actor_user_id: number | null;
      metadata: unknown;
    }>(
      "select event_type, source, actor_user_id::int as actor_user_id, metadata from audit_events "
        + "where event_type like 'admin.config%' order by id",
    )).rows;
    return { appContext, run, takeLogs, auditEvents };
  }

  it("sets, reads and clears the Fansly pause with the console's audit trail", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { appContext, run, takeLogs, auditEvents } = harness(testDb);

    await run(["config", "get", "fanslyDefaultDelayMs"]);
    expect(takeLogs()).toEqual([
      "key: fanslyDefaultDelayMs (FANSLY_DEFAULT_DELAY_MS)",
      "env: 2500",
      "override: none",
      "effective: 2500",
    ]);

    await run([
      "config", "set", "fanslyDefaultDelayMs", "2000",
      "--note", "plan 2.5 p.5: 7 days without 429", "--expected-version", "0",
    ]);
    expect(takeLogs()).toEqual([
      "Set fanslyDefaultDelayMs = 2000 (override version 1); audited as admin.config_update, source cli",
    ]);
    expect((await getConfigOverrides(testDb.db)).get("fanslyDefaultDelayMs")).toEqual({ value: 2000, version: 1 });
    expect((await loadEffectiveConfig(appContext.db, appContext.config)).fanslyDefaultDelayMs).toBe(2000);

    const expectedNote = `[cli] plan 2.5 p.5: 7 days without 429 [cost-warnings] ${COST_WARNING}`;
    const [setRow] = await listConfigAudit(testDb.db, { key: "fanslyDefaultDelayMs" });
    expect(setRow).toMatchObject({
      userId: null,
      oldValue: null,
      newValue: 2000,
      oldVersion: null,
      newVersion: 1,
      note: expectedNote,
    });
    expect(await auditEvents()).toEqual([{
      event_type: "admin.config_update",
      source: "cli",
      actor_user_id: null,
      metadata: { keys: [{ key: "fanslyDefaultDelayMs", version: 1 }], note: expectedNote },
    }]);

    await run(["config", "get", "fanslyDefaultDelayMs"]);
    const shown = takeLogs();
    expect(shown.slice(0, 4)).toEqual([
      "key: fanslyDefaultDelayMs (FANSLY_DEFAULT_DELAY_MS)",
      "env: 2500",
      "override: 2000 (version 1)",
      "effective: 2000",
    ]);
    expect(shown[4]).toMatch(/^last change: \d{4}-\d\d-\d\dT.* by no user - \[cli\] plan 2\.5 p\.5/);

    // A 429 after the change: the session rolls back to the env value (2500).
    await run(["config", "clear", "fanslyDefaultDelayMs", "--note", "429 on lora-1", "--expected-version", "1"]);
    expect(takeLogs()).toEqual([
      "Cleared the fanslyDefaultDelayMs override; effective value is now 2500 (env); "
        + "audited as admin.config_clear, source cli",
    ]);
    expect((await getConfigOverrides(testDb.db)).has("fanslyDefaultDelayMs")).toBe(false);
    expect((await loadEffectiveConfig(appContext.db, appContext.config)).fanslyDefaultDelayMs).toBe(2500);
    const [clearRow] = await listConfigAudit(testDb.db, { key: "fanslyDefaultDelayMs" });
    expect(clearRow).toMatchObject({
      userId: null,
      oldValue: 2000,
      newValue: null,
      oldVersion: 1,
      newVersion: null,
      note: "[cli] 429 on lora-1",
    });
    expect((await auditEvents())[1]).toEqual({
      event_type: "admin.config_clear",
      source: "cli",
      actor_user_id: null,
      metadata: { key: "fanslyDefaultDelayMs", note: "[cli] 429 on lora-1" },
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rejects an out-of-range pause with the console's message and writes nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { run, auditEvents } = harness(testDb);

    await expect(run(["config", "set", "fanslyDefaultDelayMs", "1500", "--note", "faster"]))
      .rejects.toThrow(BELOW_FLOOR_MESSAGE);
    await expect(run(["config", "set", "fanslyDefaultDelayMs", "60001", "--note", "slower"]))
      .rejects.toThrow("Пауза больше 60000 мс похожа на опечатку. Допустимо от 2000 до 60000 мс.");
    await expect(run(["config", "set", "fanslyDefaultDelayMs", "2s", "--note", "typo"]))
      .rejects.toThrow("fanslyDefaultDelayMs expects a finite number");
    await expect(run(["config", "set", "fanslyDefaultDelayMs", "2000.5", "--note", "typo"]))
      .rejects.toThrow("fanslyDefaultDelayMs expects an integer");

    expect((await getConfigOverrides(testDb.db)).has("fanslyDefaultDelayMs")).toBe(false);
    expect(await listConfigAudit(testDb.db, { key: "fanslyDefaultDelayMs" })).toEqual([]);
    expect(await auditEvents()).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("accepts only live-editable keys and requires a real note", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { run, auditEvents } = harness(testDb);

    // Editable, but not wired live (the endpoint pause), a restart-only key, a secret.
    await expect(run(["config", "set", "fanslyDmMessagesDelayMs", "7500", "--note", "x"]))
      .rejects.toThrow("Config key is not runtime-editable: fanslyDmMessagesDelayMs");
    await expect(run(["config", "clear", "logLevel", "--note", "x"]))
      .rejects.toThrow("Config key is not runtime-editable: logLevel");
    await expect(run(["config", "get", "databaseUrl"]))
      .rejects.toThrow("Config key is not runtime-editable: databaseUrl");
    await expect(run(["config", "set", "noSuchKey", "1", "--note", "x"]))
      .rejects.toThrow("Config key is not runtime-editable: noSuchKey");

    await expect(run(["config", "set", "fanslyDefaultDelayMs", "2000", "--note", "   "]))
      .rejects.toThrow("--note must say why the value changes");
    // Leaving --note out is refused by the parser itself (a mandatory option; the
    // subcommands were built before exitOverride, so assert the declaration).
    const program = await loadCliProgram(createTestAppContext(testDb));
    const configCommand = program.commands.find((command) => command.name() === "config")!;
    for (const name of ["set", "clear"]) {
      const subcommand = configCommand.commands.find((command) => command.name() === name)!;
      expect(subcommand.options.find((option) => option.long === "--note")?.mandatory, name).toBe(true);
    }

    expect(await getConfigOverrides(testDb.db)).toEqual(new Map());
    expect(await auditEvents()).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps the optimistic lock: a stale --expected-version changes nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { run, auditEvents } = harness(testDb);

    await run(["config", "set", "fanslyDefaultDelayMs", "3000", "--note", "owner asked"]);
    await expect(run([
      "config", "set", "fanslyDefaultDelayMs", "2000", "--note", "stale", "--expected-version", "0",
    ])).rejects.toThrow('Config override version conflict for "fanslyDefaultDelayMs": expected 0, found 1');
    await expect(run([
      "config", "clear", "fanslyDefaultDelayMs", "--note", "stale", "--expected-version", "2",
    ])).rejects.toThrow('Config override version conflict for "fanslyDefaultDelayMs": expected 2, found 1');

    expect((await getConfigOverrides(testDb.db)).get("fanslyDefaultDelayMs")).toEqual({ value: 3000, version: 1 });
    expect(await listConfigAudit(testDb.db, { key: "fanslyDefaultDelayMs" })).toHaveLength(1);
    expect((await auditEvents()).map((event) => event.event_type)).toEqual(["admin.config_update"]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shows a hand-written out-of-range row as ignored, with the env value in effect", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { run, takeLogs } = harness(testDb);
    // Written past every validated path (as raw SQL would): the overlay must not apply it.
    await setConfigOverride(testDb.db, {
      key: "fanslyDefaultDelayMs",
      value: 1500,
      userId: null,
      groupId: randomUUID(),
    });

    await run(["config", "get", "fanslyDefaultDelayMs"]);
    expect(takeLogs().slice(0, 4)).toEqual([
      "key: fanslyDefaultDelayMs (FANSLY_DEFAULT_DELAY_MS)",
      "env: 2500",
      `override: 1500 (version 1) - ignored: ${BELOW_FLOOR_MESSAGE}`,
      "effective: 2500",
    ]);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

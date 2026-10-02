import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, upsertDemand, type Database } from "@agency_hub_core/db";

import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { LIVE_LOOP_ENABLED, SyncEngineHost, type SyncHostOptions } from "../apps/runtime/src/sync/engine/host.ts";
import { createPacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { changeSyncPageModeByOwner, SyncOwnerLeverError } from "../apps/runtime/src/sync/inspect.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  pollsRequest,
  quietLogger,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testConfig,
  testRegistry,
  testSpec,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// I17: no live sender before the step-3 switch. Three independent gates —
// the constant, the page mode (reachable only through the switch), and the
// step-1 guard row handed to the engine — each shown to hold on its own.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

function liveRegistry() {
  const read: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    shadow: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
  return testRegistry([testSpec("gate.read", read)]);
}

function hostOptions(overrides: Partial<SyncHostOptions>): SyncHostOptions {
  return {
    db: db(),
    connectionString: testDb!.connectionString,
    config: testConfig(testDb!.connectionString),
    rawConfig: testConfig(testDb!.connectionString),
    logger: quietLogger,
    registry: liveRegistry(),
    pause: { readSettingMs: async () => 50 },
    pacerFactory: (deps) => createPacer({ ...deps, minSettingMs: 1 }),
    modeLoopIntervalMs: 200,
    ...overrides,
  };
}

describe("I17: the live gates", () => {
  it("a page written 'live' is never acquired while LIVE_LOOP_ENABLED is false: no owner, no attempt, no transport", async (context) => {
    if (!testDb) return context.skip();
    expect(LIVE_LOOP_ENABLED).toBe(false);
    const { pageId } = await seedSyncPage(handles(), { mode: "live", guard: "fansly_sync_engine" });
    await upsertDemand(db(), { pageId, shadow: false, resource: "gate.read", kind: "trigger", class: "urgent" });
    let transports = 0;
    const host = new SyncEngineHost(hostOptions({
      liveTransportFactory: async () => {
        transports += 1;
        return new ScriptedLiveTransport();
      },
    }));
    await host.start();
    try {
      await host.tick();
      await sleep(1_500);
      await host.tick();
      expect(host.state(pageId)).toEqual({ kind: "idle" });
    } finally {
      await host.stop();
    }
    expect(transports).toBe(0);
    expect((await getSyncPage(db(), pageId))!.owner.generation).toBe(0n);
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts")).toBe(0);
  }, 30_000);

  it("with the constant overridden, a guard row still owned by the legacy engine refuses every live admission", async (context) => {
    if (!testDb) return context.skip();
    const { pageId } = await seedSyncPage(handles(), { mode: "live", guard: "legacy" });
    await upsertDemand(db(), { pageId, shadow: false, resource: "gate.read", kind: "trigger", class: "urgent" });
    const transport = new ScriptedLiveTransport();
    const metrics = new RecordingMetrics();
    const host = new SyncEngineHost(hostOptions({
      liveLoopEnabled: true,
      liveTransportFactory: async () => transport,
      metrics,
    }));
    await host.start();
    try {
      // Owned (ownership is not the gate), but past the takeover floor every
      // admission meets the legacy guard owner in its transaction.
      await waitFor(() => (metrics.get("sync_live_gate_closed") >= 1 ? true : null), 15_000, "a refused live admission");
      expect(host.state(pageId)).toMatchObject({ kind: "running", mode: "live" });
      expect(transport.hits).toHaveLength(0);
      expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts")).toBe(0);

      // Hand the guard row to the engine (the switch's step) and the same
      // work goes out: the guard row was the only gate left.
      await testDb.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [pageId]);
      await waitFor(async () => (
        await countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where apply_state = 'applied'") === 1 ? true : null
      ), 15_000, "the admission after the guard flip");
      expect(transport.hits).toHaveLength(1);
    } finally {
      await host.stop();
    }
  }, 45_000);

  it("`sync page mode` moves a page only between off and shadow", async (context) => {
    if (!testDb) return context.skip();
    const { label, pageId } = await seedSyncPage(handles());
    for (const to of ["live", "handover"]) {
      await expect(changeSyncPageModeByOwner(db(), { pageLabel: label, to, changedBy: "test" }))
        .rejects.toBeInstanceOf(SyncOwnerLeverError);
    }
    const printed: string[] = [];
    const sync = buildSyncEngineCommandGroup({
      openContext: async () => ({ db: db(), rawConfig: testConfig(testDb!.connectionString), close: async () => undefined }),
      print: (line) => printed.push(line),
    });
    await expect(sync.parseAsync(["page", "mode", "--page", label, "--to", "live"], { from: "user" }))
      .rejects.toThrow(/only between off and shadow/);
    expect((await getSyncPage(db(), pageId))!.mode).toBe("off");

    await sync.parseAsync(["page", "mode", "--page", label, "--to", "shadow", "--note", "acceptance"], { from: "user" });
    const page = await getSyncPage(db(), pageId);
    expect(page!.mode).toBe("shadow");
    expect(page!.modeChangedBy).toMatch(/^cli@.+: acceptance$/);
    expect(printed.at(-1)).toBe(`${label}: off → shadow (the sync host follows within 2 s)`);
  }, 30_000);
});

describe("I17: source pins", () => {
  const read = (file: string) => readFileSync(path.resolve(file), "utf8");

  it("LIVE_LOOP_ENABLED is false until the switch PR (S3-05)", () => {
    expect(read("apps/runtime/src/sync/engine/host.ts")).toContain("export const LIVE_LOOP_ENABLED = false;");
  });

  it("the live transport is built in one place: the host's live branch", () => {
    const root = path.resolve("apps/runtime/src");
    const builders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && /\bcreatePageTransport\(/.test(readFileSync(full, "utf8"))) {
          builders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(builders.sort()).toEqual([path.join("sync", "engine", "host.ts"), path.join("sync", "fansly", "transport.ts")]);
  });

  it("the production runtime passes none of the host's test-only options", () => {
    const main = read("apps/runtime/src/sync/main.ts");
    for (const option of ["liveLoopEnabled", "pacerFactory", "liveTransportFactory", "wsSourceOverrides", "liveSocket", "faults", "minSettingMs"]) {
      expect(main).not.toContain(option);
    }
  });
});

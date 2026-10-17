import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSyncWork, setPagePause, upsertDemand, type Database } from "@agency_hub_core/db";
import { admit } from "../apps/runtime/src/sync/engine/commit.ts";
import { SyncActor } from "../apps/runtime/src/sync/engine/actor.ts";
import { Pacer } from "../apps/runtime/src/sync/engine/pacer.ts";
import type { ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { makeTestActor, pollsRequest, ScriptedLiveTransport, seedSyncPage, testRegistry, testSpec } from "./helpers/sync-engine-host.ts";
import { FakeClock, FakePauseSource, ScriptedRng } from "./helpers/sync-fakes.ts";

// Audit-only regression: models the real actor's picked/planned work, followed
// by an owner's pause that commits before tx 1. No network transport is called.
let testDb: StartedTestDatabase | null = null;
beforeAll(async () => { testDb = await startIntegrationTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });

describe("audit lifecycle: owner pause at final admission", () => {
  it.each(["all", "requests", "resource"] as const)("refuses a new admission when %s was paused after the pick", async (scope, context) => {
    if (!testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const { pageId } = await seedSyncPage({ db, pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const key = `audit-pause.${scope}`;
    const workClass = scope === "requests" ? "requests" as const : "urgent" as const;
    const module: ResourceModule = {
      plan: async () => ({ kind: "request", request: pollsRequest }),
      apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
    };
    const registry = testRegistry([testSpec(key, module, { class: workClass })]);
    const actor = await makeTestActor({ db, pageId, registry });
    const enqueued = await upsertDemand(db, { pageId, resource: key, class: workClass, kind: "trigger" });
    const picked = (await getSyncWork(db, enqueued.id))!;

    await setPagePause(db, {
      pageId,
      ...(scope === "all" ? { all: true } : scope === "requests" ? { requests: true } : { resources: [key] }),
      note: "audit fixture: pause committed after pick, before admission",
    });
    let accepted = false;
    try {
      const admission = await admit(actor.deps,
        { work: picked, workClass, slot: 0, nextCyclePos: 1 },
        pollsRequest,
        { settingMs: 2_000, jitterU: 0, pauseMs: 2_000, earliestMono: 0 },
        { routeIntervalMs: 4_000, familyIntervalMs: 4_000 },
        module,
      );
      accepted = admission !== null;
    } catch {
      // Either a refusal or a null re-pick is a safe final admission result.
    }
    expect(accepted, `new admission after owner ${scope} pause committed`).toBe(false);
  });
});

it("audit actor path: no later admission/route/send check repairs a raised initial S", async (context) => {
  if (!testDb) return context.skip();
  const db = testDb.db as unknown as Database;
  const { pageId } = await seedSyncPage({ db, pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" });
  const key = "audit-takeover.read";
  const module: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done" }, followups: [] }),
  };
  const registry = testRegistry([testSpec(key, module)]);
  const transport = new ScriptedLiveTransport();
  const fixture = await makeTestActor({ db, pageId, registry, transport, routeTimeScale: 1 });
  const clock = new FakeClock({ startMono: 0, wallEpochMs: Date.now() });
  const pause = new FakePauseSource(2_000);
  const pacer = new Pacer({ clock, pause, rng: new ScriptedRng([0]), ownership: fixture.deps.ownership });
  pacer.initTakeover(2_400); // host computed its floor using the old 2s setting.
  clock.onSleep = () => { pause.settingMs = 60_000; };
  let sentAtMono: number | null = null;
  transport.onHit = async () => { sentAtMono = clock.monoNow(); fixture.stop.abort(); };
  await upsertDemand(db, { pageId, resource: key, class: "urgent", kind: "trigger" });
  const actor = new SyncActor({ ...fixture.deps, clock, pacer });
  await actor.run({ stop: fixture.stop.signal, abort: fixture.abort.signal });
  expect(transport.hits).toHaveLength(1);
  expect(sentAtMono).toBeGreaterThanOrEqual(72_000);
});

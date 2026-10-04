import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearPageHold, getSyncPage, setPageHold, upsertDemand, type Database, type SyncPageHoldKind } from "@agency_hub_core/db";

import { STEPS_BEFORE_GATE_PER_LAP, stepBeforeGate } from "../apps/runtime/src/sync/engine/actor.ts";
import type { EngineRegistry, ResourceModule, StepPlan } from "../apps/runtime/src/sync/engine/resource.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { runActorFor, runActorUntil } from "./helpers/sync-engine.ts";
import { pageHoldKindOf } from "./helpers/sync-holds.ts";
import {
  makeTestActor,
  pollsRequest,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  testRegistry,
  testSpec,
} from "./helpers/sync-engine-host.ts";

// Ruling 9 (step 3b): the steps that need no request run before the page's
// HTTP gate. A page hold (429, network, auth) and the pacer delay requests
// only; a `local` write and a closure are taken on the actor's lap under the
// same fences — the owner generation and mode, the owner's pause — at most
// STEPS_BEFORE_GATE_PER_LAP rows a lap, the keys without HTTP first. A plan
// that asks for a request is left untouched for its slot.

const LOCAL_KEY = "local.mark";
const FIND_KEY = "find.close";
const READ_KEY = "plain.read";

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

interface Fixture {
  registry: EngineRegistry;
  /** Subjects the local key wrote, in order. */
  written: string[];
  /** Subjects a list read already answered: their find closes with no request. */
  answered: Set<string>;
  /** Plans of the find key that asked for a request. */
  findRequests: string[];
}

/** A key without HTTP (a deletion's shape), a key that plans before the gate
 *  (a find's shape) and an ordinary read. */
function fixture(overrides: { localPlan?: (subject: string) => Promise<StepPlan> } = {}): Fixture {
  const written: string[] = [];
  const answered = new Set<string>();
  const findRequests: string[] = [];
  const local: ResourceModule = {
    plan: async (work) => (overrides.localPlan === undefined ? { kind: "local", reason: "test" } : overrides.localPlan(work.subject)),
    applyLocal: async (_tx, input) => {
      written.push(input.work.subject);
      return { work: { satisfiesRevision: true, close: "done", closeReason: "written" }, followups: [] };
    },
    apply: async () => {
      throw new Error("no request");
    },
  };
  const find: ResourceModule = {
    plan: async (work) => {
      if (answered.has(work.subject)) return { kind: "done", reason: "answered" };
      findRequests.push(work.subject);
      return { kind: "request", request: pollsRequest };
    },
    apply: async () => ({ work: { satisfiesRevision: true, close: "done", closeReason: "read" }, followups: [] }),
  };
  const read: ResourceModule = {
    plan: async () => ({ kind: "request", request: pollsRequest }),
    apply: async () => ({ work: { satisfiesRevision: true, close: "done", closeReason: "read" }, followups: [] }),
  };
  return {
    // The plain read first and the local key last: the order the step takes
    // is the rule's, not the registry's.
    registry: testRegistry([
      testSpec(READ_KEY, read),
      testSpec(FIND_KEY, find, { planBeforeGate: true }),
      testSpec(LOCAL_KEY, local, { http: false }),
    ]),
    written,
    answered,
    findRequests,
  };
}

async function livePage(label: string): Promise<number> {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { label, mode: "live", guard: "fansly_sync_engine" });
  return pageId;
}

async function demand(pageId: number, resource: string, subject = "", options: { deadlineAt?: Date } = {}): Promise<void> {
  await upsertDemand(db(), {
    pageId,
    resource,
    subject,
    kind: "trigger",
    class: "urgent",
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });
}

interface WorkView {
  subject: string;
  state: string;
  close_reason: string | null;
  attempts_count: number;
  waiting_reason: string | null;
  last_error_class: string | null;
}

async function works(pageId: number, resource: string): Promise<WorkView[]> {
  const result = await testDb!.pool.query<WorkView>(
    `select subject, state::text, close_reason, attempts_count, waiting_reason::text, last_error_class
       from sync_work where page_id = $1 and resource = $2 order by subject`,
    [pageId, resource],
  );
  return result.rows;
}

async function attempts(pageId: number): Promise<number> {
  const result = await testDb!.pool.query<{ n: number }>("select count(*)::int as n from sync_attempts where page_id = $1", [pageId]);
  return result.rows[0]!.n;
}

async function hold(pageId: number, kind: SyncPageHoldKind): Promise<void> {
  const until = kind === "auth" || kind === "identity_mismatch" ? "infinity" as const : new Date(Date.now() + 120_000);
  await setPageHold(db(), { pageId, kind, until, detail: kind === "auth" ? { credentialsGeneration: "g-failed" } : {} });
}

describe("steps that need no request run before the HTTP gate (ruling 9)", () => {
  it.each(["network", "auth", "identity_mismatch"] as const)(
    "under a %s page hold: the local write and the answered find are taken, nothing is sent, the reads wait; they go at their slot once it ends",
    async (kind) => {
      if (!testDb) return;
      const pageId = await livePage(`before-gate-${kind.replace("_", "-")}`);
      const fx = fixture();
      fx.answered.add("x");
      await hold(pageId, kind);
      await demand(pageId, LOCAL_KEY, "a");
      await demand(pageId, LOCAL_KEY, "b");
      await demand(pageId, FIND_KEY, "x");
      await demand(pageId, FIND_KEY, "y");
      await demand(pageId, READ_KEY);

      const transport = new ScriptedLiveTransport();
      const metrics = new RecordingMetrics();
      const held = await makeTestActor({ db: db(), pageId, registry: fx.registry, transport, metrics });
      await runActorUntil(held, async () => {
        const local = await works(pageId, LOCAL_KEY);
        const find = await works(pageId, FIND_KEY);
        return local.every((row) => row.state === "done") && find.find((row) => row.subject === "x")?.state === "done";
      }, 15_000, "the steps before the gate");

      expect(fx.written.sort()).toEqual(["a", "b"]);
      expect(await works(pageId, FIND_KEY)).toEqual([
        { subject: "x", state: "done", close_reason: "answered", attempts_count: 0, waiting_reason: null, last_error_class: null },
        // Asked for a read: left as it was for its slot.
        { subject: "y", state: "open", close_reason: null, attempts_count: 0, waiting_reason: null, last_error_class: null },
      ]);
      expect(fx.findRequests).toContain("y");
      expect(await works(pageId, READ_KEY)).toMatchObject([{ state: "open", attempts_count: 0 }]);
      expect(transport.hits).toEqual([]);
      expect(await attempts(pageId)).toBe(0);
      expect(pageHoldKindOf((await getSyncPage(db(), pageId))!)).toBe(kind);
      expect(metrics.get("sync_steps_before_gate")).toBe(3);

      // The hold ends: the reads the step before the gate left go at their
      // slots, one admission each.
      await clearPageHold(db(), { pageId, kinds: [kind] });
      const lifted = await makeTestActor({ db: db(), pageId, registry: fx.registry, transport });
      await runActorUntil(lifted, async () => {
        const open = [...await works(pageId, FIND_KEY), ...await works(pageId, READ_KEY)].filter((row) => row.state !== "done");
        return open.length === 0;
      }, 15_000, "the reads after the hold");
      expect(transport.hits.map((hit) => hit.spec)).toEqual(["polls", "polls"]);
      expect(await attempts(pageId)).toBe(2);
    },
    45_000,
  );

  it("the pacer's closed slot does not delay them: taken while the takeover floor keeps the first request a minute away", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage("before-gate-pacer");
    const fx = fixture();
    await demand(pageId, READ_KEY);
    await demand(pageId, LOCAL_KEY, "a");
    const transport = new ScriptedLiveTransport();
    const made = await makeTestActor({ db: db(), pageId, registry: fx.registry, transport, floorDelayMs: 60_000 });
    await runActorUntil(made, async () => (await works(pageId, LOCAL_KEY))[0]?.state === "done", 10_000, "the local write");
    expect(fx.written).toEqual(["a"]);
    expect(transport.hits).toEqual([]);
    expect(await works(pageId, READ_KEY)).toMatchObject([{ state: "open", attempts_count: 0 }]);
  }, 30_000);

  it("the owner's pause of the page and of the key still stops them", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage("before-gate-paused");
    const fx = fixture();
    fx.answered.add("x");
    await demand(pageId, LOCAL_KEY, "a");
    await demand(pageId, FIND_KEY, "x");
    await testDb.pool.query("update sync_pages set paused_all = true where page_id = $1", [pageId]);
    await runActorFor(await makeTestActor({ db: db(), pageId, registry: fx.registry }), 600);
    expect(fx.written).toEqual([]);
    expect((await works(pageId, FIND_KEY))[0]?.state).toBe("open");

    await testDb.pool.query("update sync_pages set paused_all = false, paused_resources = $2 where page_id = $1", [pageId, [LOCAL_KEY]]);
    const made = await makeTestActor({ db: db(), pageId, registry: fx.registry });
    await runActorUntil(made, async () => (await works(pageId, FIND_KEY))[0]?.state === "done", 10_000, "the answered find");
    expect(fx.written).toEqual([]);
    expect((await works(pageId, LOCAL_KEY))[0]?.state).toBe("open");
  }, 30_000);

  it("at most STEPS_BEFORE_GATE_PER_LAP rows a lap, the keys without HTTP first, then by deadline", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage("before-gate-bound");
    const fx = fixture();
    fx.answered.add("x");
    // The find's deadline is the earliest, yet the keys without HTTP go first.
    await demand(pageId, FIND_KEY, "x", { deadlineAt: new Date(Date.now() - 60_000) });
    const subjects = Array.from({ length: STEPS_BEFORE_GATE_PER_LAP + 2 }, (_, index) => `s${String(index).padStart(2, "0")}`);
    for (const subject of subjects) await demand(pageId, LOCAL_KEY, subject);
    const made = await makeTestActor({ db: db(), pageId, registry: fx.registry });
    const page = (await getSyncPage(db(), pageId))!;
    const stop = new AbortController().signal;

    expect(await stepBeforeGate(made.deps, page, stop)).toBe(STEPS_BEFORE_GATE_PER_LAP);
    expect(fx.written).toEqual(subjects.slice(0, STEPS_BEFORE_GATE_PER_LAP));
    expect((await works(pageId, FIND_KEY))[0]?.state).toBe("open");
    expect(await stepBeforeGate(made.deps, page, stop)).toBe(3);
    expect(fx.written).toEqual(subjects);
    expect((await works(pageId, FIND_KEY))[0]).toMatchObject({ state: "done", close_reason: "answered" });
    expect(await stepBeforeGate(made.deps, page, stop)).toBe(0);
    expect(await attempts(pageId)).toBe(0);
  }, 30_000);

  it("the generation fence holds: a takeover between the plan and the write leaves nothing written, and the actor leaves", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage("before-gate-fence");
    const fx = fixture({
      localPlan: async () => {
        // Another owner takes the page between the read-only plan and the
        // write's transaction.
        await testDb!.pool.query("update sync_pages set owner_generation = owner_generation + 1 where page_id = $1", [pageId]);
        return { kind: "local", reason: "test" };
      },
    });
    await hold(pageId, "network");
    await demand(pageId, LOCAL_KEY, "a");
    const made = await makeTestActor({ db: db(), pageId, registry: fx.registry });
    const exit = await made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
    expect(exit).toEqual({ kind: "ownership_lost", foreign: true });
    expect(fx.written).toEqual([]);
    expect(await works(pageId, LOCAL_KEY)).toMatchObject([{ state: "open", waiting_reason: null, last_error_class: null }]);
  }, 30_000);

  it("a plan that throws before the gate waits a minute, as at a slot; nothing is sent", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await livePage("before-gate-plan-error");
    const fx = fixture({
      localPlan: async () => {
        throw new Error("plan broke");
      },
    });
    await hold(pageId, "network");
    await demand(pageId, LOCAL_KEY, "a");
    const transport = new ScriptedLiveTransport();
    const made = await makeTestActor({ db: db(), pageId, registry: fx.registry, transport });
    await runActorUntil(made, async () => (await works(pageId, LOCAL_KEY))[0]?.last_error_class === "plan:Error", 10_000, "the deferral");
    expect(await works(pageId, LOCAL_KEY)).toMatchObject([{ state: "open", waiting_reason: "dependency" }]);
    expect(fx.written).toEqual([]);
    expect(transport.hits).toEqual([]);
  }, 30_000);
});

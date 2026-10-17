import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  listSyncPages,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { readSyncAlertStatus, SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";
import {
  createEngineRegistry,
  pollsFor,
  type EngineRegistry,
  type ResourceModule,
} from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import {
  makeTestActor,
  okResponse,
  quietLogger,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  waitFor,
} from "./helpers/sync-engine-host.ts";
import { replaceHoldRows, resourceBreakerRow } from "./helpers/sync-holds.ts";

// Bug hunt 2026-10-09, "does the engine notice its own failures?" (scratch,
// not for merge). Production functions against a real Postgres; the actor is
// the real one, only the failing module is a wrapper around the real module.

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

const OWN_ID = "300000000000000001";
const GROUP = "400000000000000001";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const fanslyRegistry = createFanslyRegistry();

/** Evidence lines for the write-up (BUGHUNT_OUT, JSON lines; bigint-safe). */
function record(name: string, value: unknown): void {
  const out = process.env.BUGHUNT_OUT;
  if (out === undefined) return;
  appendFileSync(out, `${JSON.stringify({ name, at: new Date().toISOString(), value }, (_key, item) => (typeof item === "bigint" ? item.toString() : item))}\n`);
}

const warnings: string[] = [];
const logger = { ...quietLogger, warn: (_obj: object, msg?: string) => void warnings.push(msg ?? "") };

async function seedPage(): Promise<{ pageId: number; label: string }> {
  const seeded = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  await testDb!.pool.query(
    "update pages set external_page_id = $2, metadata = $3::jsonb, last_verified_at = clock_timestamp() where id = $1",
    [seeded.pageId, OWN_ID, JSON.stringify({ accountCreatedAt: "2026-08-15T00:00:00.000Z" })],
  );
  return seeded;
}

/** The Fansly registry with the named modules wrapped (the fault under test). */
function registryWith(overrides: Record<string, (real: ResourceModule) => ResourceModule>): EngineRegistry {
  return createEngineRegistry(FANSLY_RESOURCE_SPECS.map((spec) => {
    const wrap = overrides[spec.key];
    if (wrap === undefined || spec.module === undefined) return spec;
    const load = spec.module;
    return { ...spec, module: async () => wrap(await load()) };
  }));
}

/** Every standing row of the page, parked far ahead (only what a test makes due runs). */
async function parkStandingRows(pageId: number, registry: EngineRegistry): Promise<void> {
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })) });
}

async function makeDue(pageId: number, resource: string, extra: { subject?: string; messageIds?: string[]; reason?: string } = {}) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), {
    pageId,
    resource,
    kind: spec.kind,
    class: spec.class,
    ...(extra.subject === undefined ? {} : { subject: extra.subject }),
    ...(extra.messageIds === undefined ? {} : { demand: { messageIds: extra.messageIds, reasons: [extra.reason ?? "test"] } }),
  });
}

interface WorkRow {
  id: number;
  state: string;
  kind: string;
  waiting_reason: string | null;
  last_error_class: string | null;
  failure_count: number;
  attempts_count: number;
  due_at: Date;
  first_demand_at: Date;
  last_served_at: Date | null;
  updated_at: Date;
  proof: Record<string, unknown> | null;
}

async function workRow(pageId: number, resource: string, subject = ""): Promise<WorkRow | null> {
  const result = await testDb!.pool.query<WorkRow>(
    `select id, state, kind, waiting_reason, last_error_class, failure_count, attempts_count, due_at, first_demand_at,
            last_served_at, updated_at, proof
       from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow order by id desc limit 1`,
    [pageId, resource, subject],
  );
  return result.rows[0] ?? null;
}

async function runActor(
  pageId: number,
  registry: EngineRegistry,
  until: () => Promise<boolean>,
  respond: (req: FanslyWireRequest, index: number) => FanslyWireOutcome = () => okResponse(),
  timeoutMs = 30_000,
): Promise<void> {
  const transport = new ScriptedLiveTransport();
  transport.respond = respond;
  const { actor, stop, abort } = await makeTestActor({
    db: db(), pageId, registry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), timeoutMs, "the condition");
  } finally {
    stop.abort();
    await run;
  }
}

async function evaluate() {
  const result = await new SyncAlertEvaluator({ db: db(), logger, registry: fanslyRegistry }).runOnce();
  expect(result, warnings.join("; ")).not.toBeNull();
  return result!;
}

/** What `sync alerts status` says holds now for the page (no write). */
async function conditionsOf(label: string) {
  const status = await readSyncAlertStatus(db(), { registry: fanslyRegistry, pages: await listSyncPages(db()) });
  return status.pages.find((entry) => entry.page === label)!.conditions;
}

function reasonsOf(conditions: Awaited<ReturnType<typeof conditionsOf>>, subKey: string): string[] {
  return conditions.find((entry) => entry.subKey === subKey)?.reasons.map((reason) => reason.detail) ?? [];
}

/** What would page for the failing work: alert 3's reasons and alert 2's
 *  quarantine (a test page has no socket, so alert 2's socket_down always
 *  holds and is left out). */
function failurePages(conditions: Awaited<ReturnType<typeof conditionsOf>>): string[] {
  return [...reasonsOf(conditions, "freshness"), ...reasonsOf(conditions, "live_degraded").filter((detail) => detail === "quarantined")];
}

function tx(id: string, overrides: Record<string, unknown> = {}) {
  return {
    walletId: "wallet-1", transactionId: id, accountId: OWN_ID, correlationId: null, correlationAccountId: null,
    type: 7001, destination: 1, amount: 10_000, destinationTax: 2_000, destinationAmount: 8_000, newBalance: null,
    newBalance64: 100_000, createdAt: Date.now() - HOUR, updatedAt: null, status: 1, senderId: null, receiverId: OWN_ID,
    ...overrides,
  };
}

function param(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

class SimulatedPlanBug extends TypeError {
  constructor() {
    super("simulated: the plan reads a shape it does not expect");
    this.name = "TypeError";
  }
}

describe("bughunt: silent paths of the Fansly Sync Engine", () => {
  it("SIL-1: a rescan that proves the ledger short never pages transactions_ledger_incomplete (the poll row never reaches 'done')", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    const registry = createFanslyRegistry();
    await parkStandingRows(pageId, registry);

    // The ledger's first row (a backfill), then a rescan of a 500-row listing
    // that stores 200: the ledger is provably short (the case the alert exists for).
    const checkpoint = Date.now() - 2 * DAY;
    await makeDue(pageId, "transactions.backfill");
    await runActor(pageId, registry, async () => (await workRow(pageId, "transactions.backfill"))?.state === "done",
      () => okResponse({ total: 1, data: [tx("tx-old", { status: 2, createdAt: checkpoint })] }));
    const inWindow = Array.from({ length: 100 }, (_, index) => tx(`tx-w-${String(index).padStart(3, "0")}`, { createdAt: Date.now() - (index + 1) * 60_000 }));
    const below = [tx("tx-below", { createdAt: checkpoint - 10 * DAY }), ...Array.from({ length: 99 }, (_, index) => tx(`tx-b-${index}`, { createdAt: checkpoint - 11 * DAY }))];
    await makeDue(pageId, "transactions.rescan");
    await runActor(pageId, registry, async () => {
      const applied = await testDb!.pool.query("select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'transactions.rescan' and apply_state = 'applied'", [pageId]);
      return applied.rows[0].n === 2;
    }, (req) => okResponse({ total: 500, data: param(req, "offset") === "0" ? inWindow : below }));

    const rescan = await workRow(pageId, "transactions.rescan");
    record("SIL-1 rescan row after a finished walk", { state: rescan!.state, kind: rescan!.kind, proof: rescan!.proof });
    // The walk finished and its receipt proves the hole …
    expect(rescan).toMatchObject({ state: "open", kind: "poll" });
    expect(Number(rescan!.proof!.ledgerIncomplete)).toBeGreaterThan(0);
    // … but no rescan row is 'done' — the only state the alert reads.
    const done = await testDb.pool.query("select count(*)::int as n from sync_work where page_id = $1 and resource = 'transactions.rescan' and state = 'done'", [pageId]);
    expect(done.rows[0].n).toBe(0);

    const first = await evaluate();
    expect(first.opened.filter((entry) => entry.detail === "transactions_ledger_incomplete")).toEqual([]);
    expect(reasonsOf(await conditionsOf(label), "stuck")).not.toContain("transactions_ledger_incomplete");

    // Control: the row shape the reader expects (and only a test writes) pages at once.
    await testDb.pool.query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, state, proof, closed_at)
       values ($1, false, 'transactions.rescan', '', 'goal', 'planned', 'done', $2::jsonb, clock_timestamp())`,
      [pageId, JSON.stringify(rescan!.proof)],
    );
    expect((await evaluate()).opened).toContainEqual({ pageId, subKey: "stuck", detail: "transactions_ledger_incomplete" });
  });

  it("SIL-2a: a chat find whose plan fails on every step loops for good — never quarantined, never urgent_waiting (watched for 130 s of real failures)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    let planFailures = 0;
    const registry = registryWith({
      "dm-conversations.find": (real) => ({
        ...real,
        plan: async () => {
          planFailures += 1;
          throw new SimulatedPlanBug();
        },
      }),
    });
    await parkStandingRows(pageId, registry);
    await makeDue(pageId, "dm-conversations.find", { subject: GROUP, messageIds: ["910000000000000001"], reason: "ws:message_unknown_chat" });

    // The real actor runs for 130 s (> the 2-minute urgent bound); the
    // evaluator's read is sampled every 10 s.
    const seen: string[][] = [];
    const startedAt = Date.now();
    await runActor(pageId, registry, async () => {
      const elapsed = Date.now() - startedAt;
      if (Math.floor(elapsed / 10_000) > seen.length) {
        seen.push(failurePages(await conditionsOf(label)));
      }
      return elapsed > 130_000;
    }, () => okResponse(), 180_000);

    const row = await workRow(pageId, "dm-conversations.find", GROUP);
    record("SIL-2a after 130 s", { planFailures, row, seen });
    expect(planFailures).toBeGreaterThanOrEqual(3);
    expect(Date.now() - row!.first_demand_at.getTime()).toBeGreaterThan(2 * 60_000);
    expect(row).toMatchObject({ state: "open", waiting_reason: "dependency", last_error_class: "plan:TypeError", failure_count: 0, attempts_count: 0 });
    // Nothing paged at any sampled instant: no urgent_waiting, no quarantine.
    expect(seen.length).toBeGreaterThanOrEqual(12);
    expect(seen.flat()).toEqual([]);
    expect((await evaluate()).opened.filter((entry) => entry.subKey === "freshness")).toEqual([]);

    // Even overdue (as if 40 minutes of failures and no pick right now), the
    // `dependency` label alone keeps it out of urgent_waiting …
    await testDb.pool.query(
      `update sync_work set first_demand_at = clock_timestamp() - interval '40 minutes', due_at = clock_timestamp() - interval '10 minutes'
        where id = $1`,
      [Number(row!.id)],
    );
    expect(reasonsOf(await conditionsOf(label), "freshness")).toEqual([]);
    // … while the same row without that label pages.
    await testDb.pool.query("update sync_work set waiting_reason = null where id = $1", [Number(row!.id)]);
    expect(reasonsOf(await conditionsOf(label), "freshness")).toEqual(["urgent_waiting"]);
  }, 240_000);

  it("SIL-2b: a socket deletion whose local step fails is retried for good — never counted, never quarantined, never paged", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    let localFailures = 0;
    const registry = registryWith({
      "dm-live.deletions": (real) => ({
        ...real,
        applyLocal: async () => {
          localFailures += 1;
          throw new SimulatedPlanBug();
        },
      }),
    });
    await parkStandingRows(pageId, registry);
    await makeDue(pageId, "dm-live.deletions", { subject: GROUP, messageIds: ["910000000000000002"], reason: "ws:message_deleted" });
    // Five rounds: each time the row is due again, the step fails again.
    for (let round = 1; round <= 5; round += 1) {
      const before = localFailures;
      const id = Number((await workRow(pageId, "dm-live.deletions", GROUP))!.id);
      await testDb.pool.query("update sync_work set due_at = clock_timestamp() where id = $1", [id]);
      await runActor(pageId, registry, async () => localFailures > before);
      await waitFor(async () => ((await workRow(pageId, "dm-live.deletions", GROUP))?.waiting_reason === "dependency" ? true : null), 5_000, "settle");
    }
    const row = await workRow(pageId, "dm-live.deletions", GROUP);
    record("SIL-2b after 5 failed local steps", { localFailures, row });
    expect(localFailures).toBeGreaterThanOrEqual(5);
    // The HTTP apply rule quarantines an unexpected error at the 3rd failure
    // (SYNC_APPLY_FAILURES_TO_QUARANTINE); the local step has no count at all.
    expect(row).toMatchObject({ state: "open", waiting_reason: "dependency", last_error_class: "local:TypeError", failure_count: 0 });
    expect(row!.due_at.getTime() - Date.now()).toBeGreaterThan(30_000);
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '40 minutes' where id = $1",
      [Number(row!.id)],
    );
    expect(failurePages(await conditionsOf(label))).toEqual([]);
  });

  it("SIL-2c: an urgent read whose apply hits a transient SQLSTATE every time stays 'running' for good — never counted, never urgent_waiting", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    let applyFailures = 0;
    const registry = registryWith({
      "transactions.head": (real) => ({
        ...real,
        apply: async () => {
          applyFailures += 1;
          const error = new Error("canceling statement due to statement timeout");
          (error as Error & { code: string }).code = "57014";
          throw error;
        },
      }),
    });
    await parkStandingRows(pageId, registry);
    await makeDue(pageId, "transactions.head");
    await runActor(pageId, registry, async () => applyFailures >= 4,
      () => okResponse({ total: 1, data: [tx("tx-head-1")] }), 60_000);
    const row = await workRow(pageId, "transactions.head");
    const attempt = await testDb.pool.query(
      "select apply_state, apply_failures, apply_error from sync_attempts where page_id = $1 and resource = 'transactions.head' order by id desc limit 1",
      [pageId],
    );
    record("SIL-2c after 4 failed applies", { applyFailures, row, attempt: attempt.rows[0] });
    expect(row).toMatchObject({ state: "running" });
    expect(attempt.rows[0]).toMatchObject({ apply_state: "deferred", apply_failures: 0, apply_error: "57014" });
    // 40 minutes on: the urgent rule reads open rows only.
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '40 minutes', due_at = clock_timestamp() - interval '40 minutes' where id = $1",
      [Number(row!.id)],
    );
    expect(failurePages(await conditionsOf(label))).toEqual([]);
  });

  it("SIL-3: the same plan failure pages through planned_stale on a poll, never on a standing walk (goal SLOs are read by nothing)", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    const failing = (real: ResourceModule): ResourceModule => ({ ...real, plan: async () => { throw new SimulatedPlanBug(); } });
    const registry = registryWith({ "media-stats.walk": failing, "stats.daily": failing });
    await parkStandingRows(pageId, registry);
    for (const resource of ["media-stats.walk", "stats.daily"]) {
      await testDb.pool.query("update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = $2", [pageId, resource]);
    }
    await runActor(pageId, registry, async () =>
      (await workRow(pageId, "media-stats.walk"))?.last_error_class === "plan:TypeError" &&
      (await workRow(pageId, "stats.daily"))?.last_error_class === "plan:TypeError");
    const walk = await workRow(pageId, "media-stats.walk");
    const poll = await workRow(pageId, "stats.daily");
    expect(walk).toMatchObject({ kind: "goal", state: "open", last_served_at: null, waiting_reason: "dependency" });
    expect(poll).toMatchObject({ kind: "poll", state: "open", last_served_at: null, waiting_reason: "dependency" });
    // Four days of the same failure (both SLOs are 72 h; neither row was ever admitted).
    await testDb.pool.query(
      "update sync_work set created_at = clock_timestamp() - interval '4 days', first_demand_at = clock_timestamp() - interval '4 days' where page_id = $1 and resource in ('media-stats.walk', 'stats.daily')",
      [pageId],
    );
    const stuck = (await conditionsOf(label)).find((entry) => entry.subKey === "stuck");
    record("SIL-3 stuck condition", stuck ?? null);
    expect(stuck?.reasons.find((reason) => reason.detail === "planned_stale")?.context).toEqual({ resources: ["stats.daily"] });
  });

  it("SIL-4: a file breaker silences alerts 3 and 4 for every key of its file, and no alert reports the breaker", async (context) => {
    if (!testDb) return context.skip();
    const { pageId, label } = await seedPage();
    await testDb.pool.query("update sync_pages set owner_heartbeat_at = clock_timestamp() where page_id = $1", [pageId]);
    await parkStandingRows(pageId, fanslyRegistry);
    // The chat list not read for 5 h (SLO 90 min) and a new chat's find due for an hour.
    await testDb.pool.query(
      "update sync_work set last_served_at = clock_timestamp() - interval '5 hours' where page_id = $1 and resource = 'dm-conversations.head'",
      [pageId],
    );
    await makeDue(pageId, "dm-conversations.find", { subject: GROUP, messageIds: ["910000000000000003"], reason: "ws:message_unknown_chat" });
    await testDb.pool.query(
      "update sync_work set due_at = clock_timestamp() - interval '1 hour', first_demand_at = clock_timestamp() - interval '1 hour' where page_id = $1 and resource = 'dm-conversations.find'",
      [pageId],
    );
    // The file's breaker on its third step (6 h), as five failing finds within ten minutes leave it.
    await replaceHoldRows(testDb, pageId, "resource", [resourceBreakerRow("dm-conversations", new Date(Date.now() + 6 * HOUR), { step: 3 })]);
    const held = await conditionsOf(label);
    record("SIL-4 conditions under the breaker", held);
    expect(held.filter((entry) => entry.subKey === "freshness" || entry.subKey === "stuck" || entry.subKey === "page_stopped")).toEqual([]);
    expect((await evaluate()).opened.filter((entry) => entry.subKey === "freshness" || entry.subKey === "stuck")).toEqual([]);

    await replaceHoldRows(testDb, pageId, "resource", []);
    const free = await conditionsOf(label);
    expect(reasonsOf(free, "freshness")).toContain("urgent_waiting");
    expect(reasonsOf(free, "stuck")).toContain("planned_stale");
  });
});

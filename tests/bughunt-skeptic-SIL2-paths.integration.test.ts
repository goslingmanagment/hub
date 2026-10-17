import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureFanslyPageSendGuard,
  ensurePollRows,
  getSyncPage,
  listSyncPages,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { readSyncAlertStatus, SyncAlertEvaluator } from "../apps/runtime/src/sync/engine/alerts.ts";
import { ApplyQuarantine } from "../apps/runtime/src/sync/engine/commit.ts";
import {
  createEngineRegistry,
  pollsFor,
  type EngineRegistry,
  type ResourceModule,
} from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsCapturePage, wsTransaction, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import {
  makeTestActor,
  okResponse,
  quietLogger,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  setModeDirect,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// Skeptic of SIL-2 (bug hunt 2026-10-09, scratch, not for merge). The real
// actor, the real commit paths and the real alert evaluator against a real
// Postgres; only the module step under test is wrapped to throw. Each case
// changes ONE assumption of the hunter's SIL-2 tests (the error's class, a
// restart, a backstop input) to find what does or does not catch it.

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

const OWN = "300000000000000011";
const GROUP = "400000000000000011";
const FAN = "500000000000000011";
const fanslyRegistry = createFanslyRegistry();

function record(name: string, value: unknown): void {
  const out = process.env.BUGHUNT_OUT;
  if (out === undefined) return;
  appendFileSync(out, `${JSON.stringify({ name, at: new Date().toISOString(), value }, (_key, item) => (typeof item === "bigint" ? item.toString() : item))}\n`);
}

const warnings: string[] = [];
const logger = { ...quietLogger, warn: (_obj: object, msg?: string) => void warnings.push(msg ?? "") };

/** A live engine page with an open receiver socket (so `socket_down` stays
 *  out of the picture), the send guard owned by the engine (live admission
 *  gate, I17) and a known identity. */
async function livePage(): Promise<WsCapturePage> {
  const page = await seedWsCapturePage({ db: db(), pool: testDb!.pool }, { ownRef: OWN });
  await setModeDirect(testDb!.pool, page.pageId, "live");
  await ensureFanslyPageSendGuard(db(), page.pageId);
  await testDb!.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [page.pageId]);
  await testDb!.pool.query(
    "update pages set metadata = $2::jsonb, last_verified_at = clock_timestamp() where id = $1",
    [page.pageId, JSON.stringify({ accountCreatedAt: "2026-08-15T00:00:00.000Z" })],
  );
  return page;
}

function registryWith(overrides: Record<string, (real: ResourceModule) => ResourceModule>): EngineRegistry {
  return createEngineRegistry(FANSLY_RESOURCE_SPECS.map((spec) => {
    const wrap = overrides[spec.key];
    if (wrap === undefined || spec.module === undefined) return spec;
    const load = spec.module;
    return { ...spec, module: async () => wrap(await load()) };
  }));
}

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
  id: string;
  state: string;
  waiting_reason: string | null;
  last_error_class: string | null;
  failure_count: number;
  attempts_count: number;
  due_at: Date;
  owner_generation: string | null;
}

async function workRow(pageId: number, resource: string, subject = ""): Promise<WorkRow | null> {
  const result = await testDb!.pool.query<WorkRow>(
    `select id::text, state, waiting_reason, last_error_class, failure_count, attempts_count, due_at, owner_generation::text
       from sync_work where page_id = $1 and resource = $2 and subject = $3 and not shadow order by id desc limit 1`,
    [pageId, resource, subject],
  );
  return result.rows[0] ?? null;
}

async function lastAttempt(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{ apply_state: string; apply_failures: number; apply_error: string | null; owner_generation: string }>(
    `select apply_state, apply_failures, apply_error, owner_generation::text
       from sync_attempts where page_id = $1 and resource = $2 order by id desc limit 1`,
    [pageId, resource],
  );
  return result.rows[0] ?? null;
}

/** Start the real actor (a fresh owner generation each time, as after a
 *  restart: `recoverUnfinished` runs first) until `until` holds. */
async function runActor(
  pageId: number,
  registry: EngineRegistry,
  until: () => Promise<boolean>,
  respond: (req: FanslyWireRequest, index: number) => FanslyWireOutcome = () => okResponse(),
  timeoutMs = 30_000,
): Promise<bigint> {
  const transport = new ScriptedLiveTransport();
  transport.respond = respond;
  const { actor, stop, abort, generation } = await makeTestActor({
    db: db(), pageId, registry, alerts: new RecordingAlerts(), metrics: new RecordingMetrics(), transport, ownRef: OWN,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), timeoutMs, "the condition");
  } finally {
    stop.abort();
    await run;
  }
  return generation;
}

async function evaluate() {
  const result = await new SyncAlertEvaluator({ db: db(), logger, registry: fanslyRegistry }).runOnce();
  expect(result, warnings.join("; ")).not.toBeNull();
  return result!;
}

async function statusOf(label: string) {
  const status = await readSyncAlertStatus(db(), { registry: fanslyRegistry, pages: await listSyncPages(db()) });
  return status.pages.find((entry) => entry.page === label)!;
}

function reasonsOf(conditions: Awaited<ReturnType<typeof statusOf>>["conditions"], subKey: string): string[] {
  return conditions.find((entry) => entry.subKey === subKey)?.reasons.map((reason) => reason.detail) ?? [];
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function tx(id: string) {
  return {
    walletId: "wallet-1", transactionId: id, accountId: OWN, correlationId: null, correlationAccountId: null,
    type: 7001, destination: 1, amount: 10_000, destinationTax: 2_000, destinationAmount: 8_000, newBalance: null,
    newBalance64: 100_000, createdAt: Date.now() - 3_600_000, updatedAt: null, status: 1, senderId: null, receiverId: OWN,
  };
}

describe("skeptic SIL-2: what catches a failure that sends nothing", () => {
  it("(a) a plan error is never classified: even a deterministic one (ApplyQuarantine, 23505) only waits on `dependency`, uncounted, never quarantined", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    const SECOND = "400000000000000012";
    const registry = registryWith({
      "dm-conversations.find": (real) => ({
        ...real,
        plan: async (work, ctx) => {
          if (work.subject === GROUP) throw new ApplyQuarantine("simulated_refusal_in_plan");
          if (work.subject === SECOND) throw pgError("23505", "duplicate key value violates unique constraint");
          return real.plan(work, ctx);
        },
      }),
    });
    await parkStandingRows(page.pageId, registry);
    await makeDue(page.pageId, "dm-conversations.find", { subject: GROUP, messageIds: ["910000000000000011"], reason: "ws:message_unknown_chat" });
    await makeDue(page.pageId, "dm-conversations.find", { subject: SECOND, messageIds: ["910000000000000012"], reason: "ws:message_unknown_chat" });
    await runActor(page.pageId, registry, async () =>
      (await workRow(page.pageId, "dm-conversations.find", GROUP))?.last_error_class !== null &&
      (await workRow(page.pageId, "dm-conversations.find", SECOND))?.last_error_class !== null);
    const first = await workRow(page.pageId, "dm-conversations.find", GROUP);
    const second = await workRow(page.pageId, "dm-conversations.find", SECOND);
    record("a: deterministic plan errors", { first, second });
    expect(first).toMatchObject({ state: "open", waiting_reason: "dependency", last_error_class: "plan:quarantine:simulated_refusal_in_plan", failure_count: 0, attempts_count: 0 });
    expect(second).toMatchObject({ state: "open", waiting_reason: "dependency", last_error_class: "plan:23505", failure_count: 0, attempts_count: 0 });
    // The same errors in an apply quarantine at once (classifyApplyError): here nothing does.
    const quarantined = await testDb.pool.query("select count(*)::int as n from sync_work where page_id = $1 and state = 'quarantined'", [page.pageId]);
    expect(quarantined.rows[0].n).toBe(0);
    // Forty minutes of it: nothing of alert 2 or 3.
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '40 minutes' where page_id = $1 and resource = 'dm-conversations.find'",
      [page.pageId],
    );
    const status = await statusOf(page.label);
    record("a: conditions", status.conditions);
    expect(reasonsOf(status.conditions, "freshness")).toEqual([]);
    expect(reasonsOf(status.conditions, "live_degraded")).not.toContain("quarantined");
  });

  it("(b) control: a local step whose error is deterministic (23505) IS quarantined at once and pages alert 2", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    const registry = registryWith({
      "dm-live.deletions": (real) => ({ ...real, applyLocal: async () => { throw pgError("23505", "duplicate key"); } }),
    });
    await parkStandingRows(page.pageId, registry);
    await makeDue(page.pageId, "dm-live.deletions", { subject: GROUP, messageIds: ["910000000000000021"], reason: "ws:message_deleted" });
    await runActor(page.pageId, registry, async () => (await workRow(page.pageId, "dm-live.deletions", GROUP))?.state === "quarantined");
    const row = await workRow(page.pageId, "dm-live.deletions", GROUP);
    record("b control: deterministic local error", row);
    expect(row).toMatchObject({ state: "quarantined", last_error_class: "local:23505" });
    expect((await evaluate()).opened).toContainEqual({ pageId: page.pageId, subKey: "live_degraded", detail: "quarantined" });
  });

  it("(b) a local step whose error is transient (57014) waits on the deferred ladder under `dependency`: uncounted, never paged", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    let failures = 0;
    const registry = registryWith({
      "dm-live.deletions": (real) => ({
        ...real,
        applyLocal: async () => {
          failures += 1;
          throw pgError("57014", "canceling statement due to statement timeout");
        },
      }),
    });
    await parkStandingRows(page.pageId, registry);
    await makeDue(page.pageId, "dm-live.deletions", { subject: GROUP, messageIds: ["910000000000000031"], reason: "ws:message_deleted" });
    // The demand is fresh: the ladder retries after 1 s, so a few failures come fast.
    await runActor(page.pageId, registry, async () => failures >= 3);
    // As if the deletion had been failing for 40 minutes: the ladder's cap.
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '40 minutes', due_at = clock_timestamp() where page_id = $1 and resource = 'dm-live.deletions'",
      [page.pageId],
    );
    const before = failures;
    await runActor(page.pageId, registry, async () => failures > before);
    await waitFor(async () => ((await workRow(page.pageId, "dm-live.deletions", GROUP))?.last_error_class === "local:57014" ? true : null), 5_000, "settle");
    const row = await workRow(page.pageId, "dm-live.deletions", GROUP);
    const dueInMs = row!.due_at.getTime() - Date.now();
    record("b transient: row after failures", { failures, row, dueInMs });
    expect(row).toMatchObject({ state: "open", waiting_reason: "dependency", last_error_class: "local:57014", failure_count: 0 });
    expect(dueInMs).toBeGreaterThan(50_000);
    expect(dueInMs).toBeLessThanOrEqual(61_000);
    const status = await statusOf(page.label);
    record("b transient: conditions", status.conditions);
    expect(reasonsOf(status.conditions, "freshness")).toEqual([]);
    expect(reasonsOf(status.conditions, "live_degraded")).not.toContain("quarantined");
    // The deletion reached no store: no `message.deleted` event key.
    const keys = await testDb.pool.query(
      "select count(*)::int as n from domain_event_keys where account_id = $1 and dedup_key like 'msg-deleted:fansly:%'",
      [page.pageId],
    );
    expect(keys.rows[0].n).toBe(0);
  });

  it("(c) control: an unexpected (non-SQLSTATE) apply error is counted and quarantined at the third try, and alert 2 opens (README Errors)", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    let failures = 0;
    const registry = registryWith({
      "transactions.head": (real) => ({
        ...real,
        apply: async () => {
          failures += 1;
          throw new TypeError("simulated: the apply reads a shape it does not expect");
        },
      }),
    });
    await parkStandingRows(page.pageId, registry);
    await makeDue(page.pageId, "transactions.head");
    await runActor(page.pageId, registry, async () => (await workRow(page.pageId, "transactions.head"))?.state === "quarantined",
      () => okResponse({ total: 1, data: [tx("tx-head-c1")] }));
    const attempt = await lastAttempt(page.pageId, "transactions.head");
    record("c control: other apply error", { failures, row: await workRow(page.pageId, "transactions.head"), attempt });
    expect(failures).toBe(3);
    expect(attempt).toMatchObject({ apply_state: "quarantined", apply_failures: 3, apply_error: "TypeError" });
    expect((await evaluate()).opened).toContainEqual({ pageId: page.pageId, subKey: "live_degraded", detail: "quarantined" });
  });

  it("(c) a transient apply error survives an actor restart (recovery re-applies it, it fails again, still running, uncounted); only the money backstop pages", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    let failures = 0;
    const registry = registryWith({
      "transactions.head": (real) => ({
        ...real,
        apply: async () => {
          failures += 1;
          throw pgError("57014", "canceling statement due to statement timeout");
        },
      }),
    });
    await parkStandingRows(page.pageId, registry);
    await makeDue(page.pageId, "transactions.head");
    const firstGeneration = await runActor(page.pageId, registry, async () => failures >= 2,
      () => okResponse({ total: 1, data: [tx("tx-head-c2")] }));
    // A restart: a new owner generation, `recoverUnfinished` first, then the due apply.
    const before = failures;
    const secondGeneration = await runActor(page.pageId, registry, async () => failures >= before + 2,
      () => okResponse({ total: 1, data: [tx("tx-head-c2")] }));
    const row = await workRow(page.pageId, "transactions.head");
    const attempt = await lastAttempt(page.pageId, "transactions.head");
    const attempts = await testDb.pool.query("select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'transactions.head'", [page.pageId]);
    record("c transient across a restart", { failures, firstGeneration, secondGeneration, row, attempt, attempts: attempts.rows[0].n });
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(row).toMatchObject({ state: "running", waiting_reason: "running" });
    expect(attempt).toMatchObject({ apply_state: "deferred", apply_failures: 0, apply_error: "57014" });
    // One request in all: the restart re-applied the journaled answer, it sent nothing new.
    expect(attempts.rows[0].n).toBe(1);
    // 40 minutes on, no money frame: nothing pages for the stuck urgent row.
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '40 minutes', due_at = clock_timestamp() - interval '40 minutes', last_served_at = clock_timestamp() - interval '40 minutes' where page_id = $1 and resource = 'transactions.head'",
      [page.pageId],
    );
    const quiet = await statusOf(page.label);
    record("c transient: conditions without a money frame", quiet.conditions);
    expect(reasonsOf(quiet.conditions, "freshness")).toEqual([]);
    expect(reasonsOf(quiet.conditions, "live_degraded")).not.toContain("quarantined");
    expect(reasonsOf(quiet.conditions, "stuck")).toEqual([]);
    // One assumption changed: the socket showed a new ledger row 10 min ago (what
    // asks for `transactions.head` in the first place): the money rule pages.
    await page.capture(wsTransaction("777000000000000099", 1), new Date(Date.now() - 10 * 60_000));
    const money = await statusOf(page.label);
    record("c transient: conditions with a money frame", money.conditions);
    expect(reasonsOf(money.conditions, "freshness")).toEqual(["money_not_in_ledger"]);
  }, 90_000);

  it("(c) a chat find whose list apply keeps failing transiently stays running; its chat's fan message is only counted, nothing pages — until a list read writes the chat", async (context) => {
    if (!testDb) return context.skip();
    const page = await livePage();
    let failures = 0;
    const registry = registryWith({
      "dm-conversations.find": (real) => ({
        ...real,
        apply: async () => {
          failures += 1;
          throw pgError("55P03", "canceling statement due to lock timeout");
        },
      }),
    });
    await parkStandingRows(page.pageId, registry);
    await makeDue(page.pageId, "dm-conversations.find", { subject: GROUP, messageIds: ["910000000000000041"], reason: "ws:message_unknown_chat" });
    await runActor(page.pageId, registry, async () => failures >= 3,
      (req) => (req.spec === "messaging.groups" ? okResponse({ data: [], aggregationData: { accounts: [], groups: [] } }) : okResponse()));
    const row = await workRow(page.pageId, "dm-conversations.find", GROUP);
    const attempt = await lastAttempt(page.pageId, "dm-conversations.find");
    record("c find: row and attempt", { failures, row, attempt });
    expect(row).toMatchObject({ state: "running" });
    expect(attempt).toMatchObject({ apply_state: "deferred", apply_failures: 0, apply_error: "55P03" });
    // The fan's message of that chat, shown by the socket 20 min ago, still awaited.
    const liveMessage = () => testDb!.pool.query(
      `insert into dm_live_messages (page_id, platform_message_id, platform_conversation_id, sender_platform_user_id,
                                     is_sent_by_page, created_at, decoder_version, first_visible_at, confirm_due_at)
       values ($1, '910000000000000041', $2, $3, false, clock_timestamp() - interval '21 minutes', 1,
               clock_timestamp() - interval '20 minutes', clock_timestamp() + interval '194 seconds')`,
      [page.pageId, GROUP, FAN],
    );
    await liveMessage();
    await testDb.pool.query(
      "update sync_work set first_demand_at = clock_timestamp() - interval '20 minutes', last_served_at = clock_timestamp() - interval '20 minutes' where page_id = $1 and resource = 'dm-conversations.find'",
      [page.pageId],
    );
    const silent = await statusOf(page.label);
    record("c find: status while the find is stuck", { conditions: silent.conditions, chats: silent.chats });
    expect(reasonsOf(silent.conditions, "freshness")).toEqual([]);
    expect(silent.chats?.unconfirmedWithoutThread.count).toBe(1);
    // One assumption changed: a list read wrote the chat (the 30-min list poll
    // would): the same unconfirmed message now pages `message_unconfirmed`.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, metadata, first_seen_at)
       values ($1, $2, '{}'::jsonb, clock_timestamp())`,
      [page.pageId, GROUP],
    );
    const known = await statusOf(page.label);
    record("c find: status once the chat is known", { conditions: known.conditions, chats: known.chats });
    expect(reasonsOf(known.conditions, "freshness")).toEqual(["message_unconfirmed"]);
  }, 90_000);
});

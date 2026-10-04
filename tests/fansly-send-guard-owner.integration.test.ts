import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureFanslyPageSendGuard,
  completeFanslySendAttempt,
  createFanslyPage,
  createModel,
  ensureFanslyPageSendGuard,
  ensurePageSyncStates,
  ensureSyncPage,
  getPageSyncState,
  listFanslySendGuards,
  requestPageSync,
  upsertFans,
  upsertPageDmConversation,
  type FanslySendHolderIdentity,
} from "@agency_hub_core/db";
import { FANSLY_SEND_SOURCES, FanslyAdapter } from "@agency_hub_core/fansly";

import {
  createFanslySendGuards,
  FanslyPageOwnedBySyncEngineError,
  isFanslyPageOwnedBySyncEngineError,
} from "../apps/runtime/src/services/fansly-send-guard/index.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
import { isThreadAttributableFanslyFailure } from "../apps/runtime/src/services/sync/fansly-dm-messages.ts";
import {
  runTargetedThreadBackfill,
  TargetedThreadBackfillRunError,
} from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";
import {
  resetIntegrationDatabase,
  seedFanslyPage,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import type { FanslySendGuardChildConfig } from "./helpers/fansly-send-guard-child.ts";
import { startFakeFanslyNetwork, type FakeFanslyNetwork } from "./helpers/fansly-send-guard-network.ts";
import { silentFanslySendGuardLogger } from "./helpers/fansly-send-guard.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Sync engine design §2.7 (0229): the owner of the step-1 send guard. Once the
// step-3 switch gives a page's guard row to the Fansly Sync Engine
// (`owner_engine = 'fansly_sync_engine'`), no legacy sender of any process
// captures it, from any source: zero requests reach the origin, no journal row
// is written, and the legacy paths treat the refusal as a page-level stop — no
// per-thread breaker row, no breaker increment. Handing the row back (the
// rollback flip, design §2.8) restores captures after 1.2 × S.

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

function holder(overrides: Partial<FanslySendHolderIdentity> = {}): FanslySendHolderIdentity {
  return {
    host: "test-host",
    pid: 4242,
    pidStart: "start",
    pidNs: null,
    bootId: null,
    instance: randomUUID(),
    role: "test",
    ...overrides,
  };
}

function captureInput(pageId: number, overrides: Partial<Parameters<typeof captureFanslyPageSendGuard>[1]> = {}) {
  return {
    pageId,
    token: randomUUID(),
    source: "sync_stream",
    operation: "messages",
    holder: holder(),
    settingMs: 300,
    leaseMs: 60_000,
    captureWaitMs: 0,
    captureRefusals: 0,
    ...overrides,
  };
}

async function seedGuardedPage(label = `owner-${randomUUID().slice(0, 8)}`) {
  const model = await createModel(testDb!.db, { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(testDb!.db, { modelId: model!.id, label });
  await ensureFanslyPageSendGuard(testDb!.db, page!.id);
  // Open: the previous request completed long ago.
  await testDb!.pool.query(
    "update fansly_page_send_guards set last_completed_at = now() - interval '1 hour', next_u = 0 where page_id = $1",
    [page!.id],
  );
  return page!;
}

/** The switch's flip (design §2.8), which waits for any legacy request in
 *  flight: it matches nothing while a holder is set. */
async function flipToEngine(pageId: number): Promise<boolean> {
  const flipped = await testDb!.pool.query(`
    update fansly_page_send_guards g
       set owner_engine = 'fansly_sync_engine', engine_switched_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where g.page_id = $1 and g.owner_engine = 'legacy' and g.holder_token is null
    returning g.last_completed_at`, [pageId]);
  return flipped.rowCount === 1;
}

/** The rollback's flip back (design §2.8, without its sync_pages conditions):
 *  the first legacy capture waits ≥ 1.2 × S from now. */
async function flipBackToLegacy(pageId: number) {
  await testDb!.pool.query(`
    update fansly_page_send_guards g
       set owner_engine = 'legacy', engine_switched_at = clock_timestamp(), updated_at = clock_timestamp(),
           last_completed_at = greatest(g.last_completed_at, clock_timestamp()), next_u = 0.2
     where g.page_id = $1 and g.owner_engine = 'fansly_sync_engine'`, [pageId]);
}

async function guardRow(pageId: number) {
  const result = await testDb!.pool.query(`
    select owner_engine, engine_switched_at, holder_token::text as holder_token, last_completed_at, next_u
      from fansly_page_send_guards where page_id = $1`, [pageId]);
  return result.rows[0] as {
    owner_engine: string; engine_switched_at: Date | null; holder_token: string | null;
    last_completed_at: Date; next_u: number;
  };
}

async function journalCount(pageId: number) {
  const result = await testDb!.pool.query("select count(*)::int as n from fansly_send_log where page_id = $1", [pageId]);
  return result.rows[0].n as number;
}

describe("the capture statement of a page the engine owns", () => {
  it("refuses every capture, journals nothing and touches nothing", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedGuardedPage();
    expect(await guardRow(page.id)).toMatchObject({ owner_engine: "legacy", engine_switched_at: null });
    expect(await flipToEngine(page.id)).toBe(true);
    const before = await guardRow(page.id);
    expect(before.engine_switched_at).toBeInstanceOf(Date);

    for (const source of FANSLY_SEND_SOURCES) {
      const result = await captureFanslyPageSendGuard(testDb.db, captureInput(page.id, { source }));
      expect(result).toEqual({
        kind: "engine_owned",
        ownerEngine: "fansly_sync_engine",
        engineSwitchedAt: before.engine_switched_at,
      });
    }
    expect(await journalCount(page.id)).toBe(0);
    expect(await guardRow(page.id)).toEqual(before);

    const [status] = await listFanslySendGuards(testDb.db);
    expect(status).toMatchObject({
      pageId: page.id, ownerEngine: "fansly_sync_engine", engineSwitchedAt: before.engine_switched_at,
      holderToken: null,
    });
  });

  it("lets the switch's flip wait for a legacy request in flight, then refuses the next capture", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedGuardedPage();
    const inFlight = captureInput(page.id);
    expect((await captureFanslyPageSendGuard(testDb.db, inFlight)).kind).toBe("captured");
    expect(await flipToEngine(page.id)).toBe(false);
    expect((await guardRow(page.id)).owner_engine).toBe("legacy");

    const completed = await completeFanslySendAttempt(testDb.db, {
      pageId: page.id, token: inFlight.token, nextU: 0, outcome: "response", outcomeDetail: null,
      httpStatus: 200, sentAt: null, sendOffsetMs: null,
    });
    expect(completed).toEqual({ released: true, journaled: true });
    expect(await flipToEngine(page.id)).toBe(true);
    await testDb.pool.query("update fansly_page_send_guards set last_completed_at = now() - interval '1 hour' where page_id = $1", [page.id]);
    expect((await captureFanslyPageSendGuard(testDb.db, captureInput(page.id))).kind).toBe("engine_owned");
    expect(await journalCount(page.id)).toBe(1);
  });

  it("reports the engine before a holder", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedGuardedPage();
    expect((await captureFanslyPageSendGuard(testDb.db, captureInput(page.id))).kind).toBe("captured");
    // Not reachable through the flip; pins the order of the read-back.
    await testDb.pool.query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [page.id]);
    expect((await captureFanslyPageSendGuard(testDb.db, captureInput(page.id))).kind).toBe("engine_owned");
  });

  it("accepts only the two owners", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedGuardedPage();
    await expect(testDb.pool.query("update fansly_page_send_guards set owner_engine = 'other' where page_id = $1", [page.id]))
      .rejects.toThrow(/fansly_page_send_guards_owner_engine_check/);
  });
});

describe("the 0229 migration", () => {
  it("gives every existing guard row to the legacy engine and keeps the read role's access", async (context) => {
    if (!testDb) return context.skip();
    const partial = await startIntegrationTestDatabase({ through: "0228_sync_engine_core.sql" });
    if (!partial) return context.skip();
    try {
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      await partial.pool.query(`insert into pages (model_id, platform, label)
        select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model'`);
      await partial.pool.query(`insert into fansly_page_send_guards (page_id, last_completed_at, next_u)
        select id, now() - interval '1 minute', 0.1 from pages where label = 'seed-fansly'`);
      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const client = await partial.pool.connect();
      try {
        await runMigrations({
          db: client,
          migrationsDir: path.resolve("packages/db/migrations"),
          through: "0229_send_guard_owner_engine.sql",
        });
      } finally {
        client.release();
      }
      const rows = await partial.pool.query(`
        select p.label, g.owner_engine, g.engine_switched_at, g.next_u
          from fansly_page_send_guards g join pages p on p.id = g.page_id`);
      expect(rows.rows).toEqual([{ label: "seed-fansly", owner_engine: "legacy", engine_switched_at: null, next_u: 0.1 }]);
      const constraint = await partial.pool.query(`
        select convalidated from pg_constraint where conname = 'fansly_page_send_guards_owner_engine_check'`);
      expect(constraint.rows).toEqual([{ convalidated: true }]);
      const grants = await partial.pool.query(`
        select has_column_privilege('read_only', 'fansly_page_send_guards', 'owner_engine', 'select') as owner,
               has_column_privilege('read_only', 'fansly_page_send_guards', 'engine_switched_at', 'select') as switched`);
      expect(grants.rows[0]).toEqual({ owner: true, switched: true });
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

// ── Every source of every process ───────────────────────────────────────────

const S_MS = 300;
const CHILD = "tests/helpers/fansly-send-guard-child.ts";

function runChild(config: FanslySendGuardChildConfig) {
  const child = spawn(process.execPath, ["--import", "tsx/esm", CHILD], {
    env: { ...process.env, FANSLY_SEND_GUARD_CHILD_CONFIG: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise<{
    code: number | null;
    summary: {
      responses: number;
      counters: { captures: number; captureRefusals: number; engineOwnedRefusals: number };
      errors: Record<string, number>;
    };
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        resolve({ code, summary: JSON.parse(line) });
      } catch {
        reject(new Error(`child ${config.name} printed no summary; stderr:\n${stderr}`));
      }
    });
  });
}

describe("every source of every process, on a page the engine owns", () => {
  it("sends nothing until the page is handed back, then captures again after 1.2 × S", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb;
    const page = await seedGuardedPage("owner-acceptance");
    expect(await flipToEngine(page.id)).toBe(true);
    const network = await startFakeFanslyNetwork();
    try {
      const base = {
        pageId: page.id,
        baseUrl: network.baseUrl,
        proxyUrl: network.proxyUrl,
        settingMs: S_MS,
        leaseMarginMs: 500,
        durationMs: 1_500,
        captureDelay: { longProbability: 0, longMaxMs: 0, shortMaxMs: 0 },
        blockAfterSendCheck: null,
        hangBeforeCompletion: null,
        sweepIntervalMs: 400,
      } satisfies Partial<FanslySendGuardChildConfig>;
      const half = Math.ceil(FANSLY_SEND_SOURCES.length / 2);
      const sourcesOf = (list: readonly (typeof FANSLY_SEND_SOURCES)[number][]) =>
        list.map((source) => ({ source, requestTimeoutMs: 2_000 }));
      const [a, b] = await Promise.all([
        runChild({ ...base, name: "A", databaseUrl: db.connectionString, sources: sourcesOf(FANSLY_SEND_SOURCES.slice(0, half)) }),
        runChild({ ...base, name: "B", databaseUrl: db.connectionString, sources: sourcesOf(FANSLY_SEND_SOURCES.slice(half)) }),
      ]);

      expect([a.code, b.code]).toEqual([0, 0]);
      expect(network.arrivals).toEqual([]);
      expect(network.tunnels).toBe(0);
      expect(await journalCount(page.id)).toBe(0);
      for (const { summary } of [a, b]) {
        expect(summary.responses).toBe(0);
        expect(summary.counters.captures).toBe(0);
        expect(summary.counters.engineOwnedRefusals).toBeGreaterThanOrEqual(half);
        expect(summary.counters.captureRefusals).toBe(summary.counters.engineOwnedRefusals);
        expect(Object.keys(summary.errors)).toEqual(["FanslyPageOwnedBySyncEngineError"]);
      }

      // Handed back: closed for 1.2 × S from the flip, by the database clock.
      await flipBackToLegacy(page.id);
      const flipped = await guardRow(page.id);
      expect(flipped).toMatchObject({ owner_engine: "legacy", next_u: 0.2 });
      const paused = await captureFanslyPageSendGuard(db.db, captureInput(page.id, { settingMs: S_MS }));
      expect(paused.kind).toBe("pause");
      expect(paused.kind === "pause" ? paused.waitMs : 0).toBeGreaterThan(1.2 * S_MS - 150);

      const registry = createFanslySendGuards({
        db: db.db,
        config: {} as never,
        logger: silentFanslySendGuardLogger,
        role: "test",
        readSettingMs: async () => S_MS,
      });
      const adapter = new FanslyAdapter({ baseUrl: network.baseUrl });
      try {
        await adapter.getAccountMe({
          session: { authorization: "synthetic" },
          proxy: { url: network.proxyUrl },
          egressKey: network.proxyUrl,
          requestTimeoutMs: 2_000,
          remainingAttempts: () => 1,
          sendGuard: registry.forPage(page.id, "account_me_cli"),
        });
      } finally {
        await registry.close();
        await adapter.close();
      }
      expect(network.arrivals).toHaveLength(1);
      const journal = await db.pool.query(`
        select jitter_u, pause_ms, previous_completed_at, captured_at, outcome
          from fansly_send_log where page_id = $1`, [page.id]);
      expect(journal.rows).toHaveLength(1);
      const row = journal.rows[0] as {
        jitter_u: number; pause_ms: number; previous_completed_at: Date; captured_at: Date; outcome: string;
      };
      expect(row).toMatchObject({ jitter_u: 0.2, pause_ms: Math.ceil(1.2 * S_MS), outcome: "response" });
      expect(row.previous_completed_at).toEqual(flipped.last_completed_at);
      expect(row.captured_at.getTime() - flipped.engine_switched_at!.getTime()).toBeGreaterThanOrEqual(1.2 * S_MS - 1);
    } finally {
      await network.close();
    }
  }, 60_000);
});

// ── The legacy DM paths: a page-level stop, never a thread's failure ───────

const POISON = "group-poison";
const HEALTHY = "group-healthy";

function seedThreadInput(platformAccountId: number, platformConversationId: string) {
  return {
    platformAccountId,
    fanId: null,
    platformConversationId,
    partnerPlatformUserId: `fan-${platformConversationId}`,
    partnerUsername: `fan_${platformConversationId}`,
    partnerDisplayName: null,
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: `msg-${platformConversationId}`,
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-03-09T12:00:00.000Z"),
    lastMessageSenderId: `fan-${platformConversationId}`,
    lastMessageSenderRole: "fan" as const,
    lastMessagePreview: "seeded",
    isVisible: true,
    lastSeenGeneration: 1,
    metadata: {},
  };
}

async function legacyDmFixture(network: FakeFanslyNetwork) {
  const app = createTestAppContext(testDb!, {
    syncSharedRateLimitEnabled: true,
    fanslyDmMessagesDelayMs: 0,
    fanslyDmConversationsDelayMs: 0,
    adapter: new FanslyAdapter({ baseUrl: network.baseUrl }) as never,
  });
  const { page } = await seedFanslyPage(app.db, app.config.encryptionKey, 1, "owner-dm");
  if (!page) throw new Error("Expected a fixture page");
  await testDb!.pool.query("update pages set external_page_id = '999' where id = $1", [page.id]);
  await saveProxy(app, page.id, { url: network.proxyUrl });
  const threads: Record<string, number> = {};
  for (const group of [POISON, HEALTHY]) {
    const [fan] = await upsertFans(app.db, [{ platform: "fansly", platformUserId: `fan-${group}` }]);
    const thread = await upsertPageDmConversation(app.db, {
      ...seedThreadInput(page.id, group), fanId: fan!.id, unreadCount: 1,
    });
    threads[group] = thread!.id;
  }
  // The poison thread's breaker: one failure, its window lapsed — a retry of
  // a failing thread, the path that would record the next failure.
  await testDb!.pool.query(`insert into page_dm_message_sync_health (conversation_id, platform_account_id,
      failure_count, error_class, last_error, last_attempt_at, next_retry_at)
    values ($1, $2, 1, 'fansly_500', 'error getting group messages', now() - interval '6 minutes',
      now() - interval '1 second')`, [threads[POISON], page.id]);

  await ensurePageSyncStates(app.db, { pageId: page.id });
  await testDb!.pool.query(`update page_sync_states set status = 'idle', applied_seq = request_seq, leased_seq = null,
    lease_token = null, lease_expires_at = null, retry_at = null, retry_kind = null where page_id = $1`, [page.id]);
  await ensureFanslyPageSendGuard(app.db, page.id);
  await testDb!.pool.query(
    "update fansly_page_send_guards set last_completed_at = now() - interval '1 hour', next_u = 0 where page_id = $1",
    [page.id],
  );
  expect(await flipToEngine(page.id)).toBe(true);

  const health = async () => (await testDb!.pool.query(`
    select conversation_id, failure_count, error_class, last_attempt_at, next_retry_at, quarantine_until
      from page_dm_message_sync_health where platform_account_id = $1 order by conversation_id`, [page.id])).rows;
  return { app, page, threads, health };
}

describe("the legacy DM paths on a page the engine owns", () => {
  it("never charges the refusal to a thread", () => {
    const refusal = new FanslyPageOwnedBySyncEngineError(1);
    expect(isThreadAttributableFanslyFailure(refusal)).toBe(false);
    expect(isThreadAttributableFanslyFailure(new Error("chunk failed", { cause: refusal }))).toBe(false);
  });

  it("the targeted thread backfill fails with the refusal and leaves the thread's breaker alone", async (context) => {
    if (!testDb) return context.skip();
    const network = await startFakeFanslyNetwork();
    try {
      const f = await legacyDmFixture(network);
      const healthBefore = await f.health();

      for (const group of [POISON, HEALTHY]) {
        const failure = await runTargetedThreadBackfill(f.app, { threadId: f.threads[group]! })
          .catch((error: unknown) => error);
        // The run throws (no `vendor_error`): the hydration settlement reads
        // the class, and the spend is zero.
        expect(failure).toBeInstanceOf(TargetedThreadBackfillRunError);
        expect(isFanslyPageOwnedBySyncEngineError(failure)).toBe(true);
        expect(failure).toMatchObject({
          failureClass: "sync_engine_owned",
          result: { outcome: "partial", requests: 0, requestAttempts: 0 },
        });
      }

      expect(await f.health()).toEqual(healthBefore);
      expect(network.arrivals).toEqual([]);
      expect(await journalCount(f.page.id)).toBe(0);
      expect(f.app.fanslySendGuards!.counters).toMatchObject({ captures: 0, engineOwnedRefusals: 2 });
    } finally {
      await network.close();
    }
  });
});

// ── Step 3: the switch's fence in front of the guard ────────────────────────

describe("a page the switch fenced: handover plus the engine's guard row (step-3 design §3.1)", () => {
  it("the legacy schedulers lease nothing, and every source is still refused at the wire", async (context) => {
    if (!testDb) return context.skip();
    const network = await startFakeFanslyNetwork();
    try {
      const f = await legacyDmFixture(network);
      // The switch's phase A: mode first (the predicate), then the guard
      // flip (done by the fixture).
      await ensureSyncPage(f.app.db, { pageId: f.page.id });
      await testDb.pool.query(
        "update sync_pages set mode = 'handover', mode_changed_by = 'test' where page_id = $1", [f.page.id],
      );
      const healthBefore = await f.health();
      await requestPageSync(f.app.db, { pageId: f.page.id, streams: ["dm_messages"], source: "scheduled" });

      // The predicate fences before the guard: no lease, so no refusal, no
      // retry and no failure charged to the stream.
      expect(await executeNextSyncPageChunk(f.app, f.page.id)).toMatchObject({ kind: "idle" });
      expect(await getPageSyncState(f.app.db, f.page.id, "dm_messages")).toMatchObject({
        status: "pending", leasedSeq: null, retryKind: null, retryAt: null, consecutiveFailures: 0, blockerKind: null,
      });
      // The targeted backfill finds no lease and does not wait for one.
      const startedAt = Date.now();
      expect(await runTargetedThreadBackfill(f.app, { threadId: f.threads[HEALTHY]! })).toMatchObject({
        outcome: "lease_unavailable", requests: 0, requestAttempts: 0,
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(f.app.fanslySendGuards!.counters).toMatchObject({ captures: 0, engineOwnedRefusals: 0 });

      // The catch-all: every source of the journal's vocabulary is refused
      // at the capture, in this process as in any other.
      for (const source of FANSLY_SEND_SOURCES) {
        const refused = await f.app.fanslySendGuards!.forPage(f.page.id, source)
          .acquire({ operation: "probe", requestTimeoutMs: 2_000 })
          .then(() => null, (error: unknown) => error);
        expect(refused).toBeInstanceOf(FanslyPageOwnedBySyncEngineError);
      }
      expect(f.app.fanslySendGuards!.counters).toMatchObject({
        captures: 0, engineOwnedRefusals: FANSLY_SEND_SOURCES.length,
      });
      expect(network.arrivals).toEqual([]);
      expect(network.tunnels).toBe(0);
      expect(await journalCount(f.page.id)).toBe(0);
      expect(await f.health()).toEqual(healthBefore);
    } finally {
      await network.close();
    }
  });
});

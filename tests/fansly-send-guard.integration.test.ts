import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  captureFanslyPageSendGuard,
  completeFanslySendAttempt,
  confirmFanslySendGuardTerminated,
  createFanslyPage,
  createModel,
  deleteExpiredSyncObservability,
  ensureFanslyPageSendGuard,
  listFanslySendGuards,
  markFanslySendGuardClosed,
  type FanslySendHolderIdentity,
} from "@agency_hub_core/db";

import {
  confirmFanslySendGuardHostsTerminated,
  createDefaultFanslySendOsProbe,
  createFanslySendGuards,
  startFanslySendGuardSweeper,
} from "../apps/runtime/src/services/fansly-send-guard/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import type { FanslySendGuardChildConfig } from "./helpers/fansly-send-guard-child.ts";
import { startFakeFanslyNetwork } from "./helpers/fansly-send-guard-network.ts";
import { silentFanslySendGuardLogger } from "./helpers/fansly-send-guard.ts";

// Plan §2.5 step 1: the legacy engine's per-page Fansly send guard on a real
// Postgres. The first part pins the statements (capture by DB clock, release
// by token only, an expired lease never opens the page, the confirmation of a
// dead holder, retention, the migration's seed); the second is the acceptance
// test of §2.5 p.3 (a): two OS processes on one page, many senders in each,
// against a fake Fansly behind a CONNECT proxy, through stalls, lost database
// connections, a stopped process and a hung one — and not one pair of
// arrivals at the origin closer than S.

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

async function seedPage(label = `guard-${randomUUID().slice(0, 8)}`) {
  const model = await createModel(testDb!.db, { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(testDb!.db, { modelId: model!.id, label });
  return page!;
}

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
    operation: "account_me",
    holder: holder(),
    settingMs: 300,
    leaseMs: 60_000,
    captureWaitMs: 0,
    captureRefusals: 0,
    ...overrides,
  };
}

async function openGuard(pageId: number) {
  await ensureFanslyPageSendGuard(testDb!.db, pageId);
  await testDb!.pool.query(
    "update fansly_page_send_guards set last_completed_at = now() - interval '1 hour', next_u = 0 where page_id = $1",
    [pageId],
  );
}

async function complete(pageId: number, token: string, nextU = 0) {
  return completeFanslySendAttempt(testDb!.db, {
    pageId, token, nextU, outcome: "response", outcomeDetail: null, httpStatus: 200, sentAt: null, sendOffsetMs: null,
  });
}

describe("the guard statements", () => {
  it("lets exactly one of many concurrent captures win, and journals it in the same statement", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await openGuard(page.id);
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      captureFanslyPageSendGuard(testDb!.db, captureInput(page.id))));
    expect(results.filter((result) => result.kind === "captured")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "busy")).toHaveLength(11);
    const journal = await testDb.pool.query("select count(*)::int as n from fansly_send_log where page_id = $1", [page.id]);
    expect(journal.rows[0].n).toBe(1);
  });

  it("opens the page S × (1 + u) after the COMPLETION, by the database clock", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await openGuard(page.id);
    const first = captureInput(page.id);
    expect((await captureFanslyPageSendGuard(testDb.db, first)).kind).toBe("captured");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await complete(page.id, first.token, 0.1)).released).toBe(true);

    const refused = await captureFanslyPageSendGuard(testDb.db, captureInput(page.id));
    expect(refused.kind).toBe("pause");
    const waitMs = refused.kind === "pause" ? refused.waitMs : 0;
    // 300 × 1.1 = 330 ms from the completion, a few ms of which have passed.
    expect(waitMs).toBeGreaterThan(250);
    expect(waitMs).toBeLessThanOrEqual(330);
    await new Promise((resolve) => setTimeout(resolve, waitMs + 5));
    const second = captureInput(page.id);
    expect((await captureFanslyPageSendGuard(testDb.db, second)).kind).toBe("captured");

    const rows = await testDb.pool.query(`
      select jitter_u, pause_ms, extract(epoch from (captured_at - previous_completed_at)) * 1000 as gap_ms
        from fansly_send_log where guard_token = $1`, [second.token]);
    expect(Number(rows.rows[0].jitter_u)).toBeCloseTo(0.1);
    expect(rows.rows[0].pause_ms).toBe(330);
    expect(Number(rows.rows[0].gap_ms)).toBeGreaterThanOrEqual(330);
  });

  it("releases only by the holder's token, once", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await openGuard(page.id);
    const capture = captureInput(page.id);
    await captureFanslyPageSendGuard(testDb.db, capture);
    expect(await complete(page.id, randomUUID())).toEqual({ released: false, journaled: false });
    expect(await complete(page.id, capture.token)).toEqual({ released: true, journaled: true });
    expect(await complete(page.id, capture.token)).toEqual({ released: false, journaled: false });
  });

  it("keeps an expired lease closed; only a confirmation of the holder's death opens it, 1.2 × S later", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await openGuard(page.id);
    const capture = captureInput(page.id, { leaseMs: 50 });
    await captureFanslyPageSendGuard(testDb.db, capture);
    // Not expired yet: neither marked closed nor confirmable as expired.
    expect(await confirmFanslySendGuardTerminated(testDb.db, {
      pageId: page.id, token: capture.token, evidence: "test", requireExpiredLease: true,
    })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const refused = await captureFanslyPageSendGuard(testDb.db, captureInput(page.id));
    expect(refused).toMatchObject({ kind: "busy", leaseExpired: true, holder: { token: capture.token } });
    expect(await markFanslySendGuardClosed(testDb.db, { pageId: page.id, token: capture.token, reason: "lease_expired_unconfirmed" }))
      .toBe(true);
    expect(await markFanslySendGuardClosed(testDb.db, { pageId: page.id, token: capture.token, reason: "again" }))
      .toBe(false);
    // A wrong token confirms nothing.
    expect(await confirmFanslySendGuardTerminated(testDb.db, {
      pageId: page.id, token: randomUUID(), evidence: "test", requireExpiredLease: true,
    })).toBe(false);
    expect(await confirmFanslySendGuardTerminated(testDb.db, {
      pageId: page.id, token: capture.token, evidence: "pid_gone", requireExpiredLease: true,
    })).toBe(true);

    const [guard] = await listFanslySendGuards(testDb.db);
    expect(guard).toMatchObject({ holderToken: null, closedReason: null, nextU: 0.2 });
    const journal = await testDb.pool.query(
      "select outcome, outcome_detail, completed_at is not null as done from fansly_send_log where guard_token = $1",
      [capture.token],
    );
    expect(journal.rows[0]).toEqual({ outcome: "confirmed_terminated", outcome_detail: "pid_gone", done: true });
    // The late completion of the "dead" holder changes nothing.
    expect(await complete(page.id, capture.token)).toEqual({ released: false, journaled: false });
    const next = await captureFanslyPageSendGuard(testDb.db, captureInput(page.id));
    expect(next.kind).toBe("pause");
    if (next.kind === "pause") expect(next.waitMs).toBeGreaterThan(330);
  });

  it("seeds a page without a row closed for 1.2 × S", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    const result = await captureFanslyPageSendGuard(testDb.db, captureInput(page.id));
    expect(result).toEqual({ kind: "pause", waitMs: 0 });
    const next = await captureFanslyPageSendGuard(testDb.db, captureInput(page.id));
    expect(next.kind).toBe("pause");
    if (next.kind === "pause") {
      expect(next.waitMs).toBeGreaterThan(300);
      expect(next.waitMs).toBeLessThanOrEqual(360);
    }
  });

  it("the sweeper releases a holder whose process is gone and only marks a live one closed", async (context) => {
    if (!testDb) return context.skip();
    const probe = createDefaultFanslySendOsProbe();
    const registry = createFanslySendGuards({
      db: testDb.db, config: {} as never, logger: silentFanslySendGuardLogger, role: "test", probe,
    });
    const me = registry.holderIdentity();
    const finished = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const dead = await seedPage("guard-dead");
    const alive = await seedPage("guard-alive");
    const elsewhere = await seedPage("guard-elsewhere");
    for (const page of [dead, alive, elsewhere]) await openGuard(page.id);
    const deadCapture = captureInput(dead.id, {
      leaseMs: 1, holder: { ...me, pid: finished.pid!, pidStart: "gone", instance: randomUUID() },
    });
    // This very process, as seen from another registry instance: alive.
    const aliveCapture = captureInput(alive.id, { leaseMs: 1, holder: { ...me, instance: randomUUID() } });
    // Another container: nothing this host can prove.
    const elsewhereCapture = captureInput(elsewhere.id, {
      leaseMs: 1, holder: { ...me, host: "another-container", pid: finished.pid!, instance: randomUUID() },
    });
    for (const capture of [deadCapture, aliveCapture, elsewhereCapture]) {
      expect((await captureFanslyPageSendGuard(testDb.db, capture)).kind).toBe("captured");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sweeper = startFanslySendGuardSweeper(
      { db: testDb.db, logger: silentFanslySendGuardLogger },
      { registry, probe, intervalMs: 60_000 },
    );
    try {
      const result = await sweeper.sweepOnce();
      expect(result.confirmed).toEqual([{ pageId: dead.id, evidence: "pid_gone" }]);
      expect(result.closed.sort()).toEqual([alive.id, elsewhere.id].sort());
    } finally {
      await sweeper.stop();
    }
    const guards = new Map((await listFanslySendGuards(testDb.db)).map((row) => [row.pageId, row]));
    expect(guards.get(dead.id)?.holderToken).toBeNull();
    expect(guards.get(alive.id)?.holderToken).toBe(aliveCapture.token);
    expect(guards.get(alive.id)?.closedReason).toBe("lease_expired_unconfirmed");
    expect(guards.get(elsewhere.id)?.holderToken).toBe(elsewhereCapture.token);
  });

  it("confirms holders of containers that are no longer running (Docker level)", async (context) => {
    if (!testDb) return context.skip();
    const gone = await seedPage("guard-gone");
    const running = await seedPage("guard-running");
    const fresh = await seedPage("guard-fresh");
    for (const page of [gone, running, fresh]) await openGuard(page.id);
    const goneCapture = captureInput(gone.id, { leaseMs: 1, holder: holder({ host: "old-worker" }) });
    const runningCapture = captureInput(running.id, { leaseMs: 1, holder: holder({ host: "worker-now" }) });
    const freshCapture = captureInput(fresh.id, { leaseMs: 600_000, holder: holder({ host: "old-api" }) });
    for (const capture of [goneCapture, runningCapture, freshCapture]) {
      await captureFanslyPageSendGuard(testDb.db, capture);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: [], ownHost: hostname(), confirmer: "test", includeUnexpired: false, dryRun: false,
    })).rejects.toThrow("--running-hosts");

    const dryRun = await confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: ["worker-now"], ownHost: hostname(), confirmer: "test", includeUnexpired: false, dryRun: true,
    });
    expect(dryRun.map((row) => [row.pageId, row.released])).toEqual([[gone.id, false]]);

    const expiredOnly = await confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: ["worker-now"], ownHost: hostname(), confirmer: "test", includeUnexpired: false, dryRun: false,
    });
    expect(expiredOnly.map((row) => [row.pageId, row.released])).toEqual([[gone.id, true]]);
    const all = await confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: ["worker-now"], ownHost: hostname(), confirmer: "test", includeUnexpired: true, dryRun: false,
    });
    expect(all.map((row) => [row.pageId, row.released])).toEqual([[fresh.id, true]]);
    const guards = new Map((await listFanslySendGuards(testDb.db)).map((row) => [row.pageId, row]));
    expect(guards.get(running.id)?.holderToken).toBe(runningCapture.token);
  });

  it("expires completed journal rows with the sync telemetry and keeps an uncompleted one", async (context) => {
    if (!testDb) return context.skip();
    const page = await seedPage();
    await openGuard(page.id);
    const old = captureInput(page.id);
    await captureFanslyPageSendGuard(testDb.db, old);
    await complete(page.id, old.token);
    await testDb.pool.query("update fansly_page_send_guards set last_completed_at = now() - interval '1 hour' where page_id = $1", [page.id]);
    const open = captureInput(page.id);
    await captureFanslyPageSendGuard(testDb.db, open);
    await testDb.pool.query(`update fansly_send_log set captured_at = now() - interval '40 days',
      completed_at = case when completed_at is null then null else now() - interval '40 days' end`);

    const result = await deleteExpiredSyncObservability(testDb.db, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    expect(result.deletedSendLog).toBe(1);
    const left = await testDb.pool.query("select guard_token::text as token from fansly_send_log");
    expect(left.rows.map((row) => row.token)).toEqual([open.token]);
  });
});

describe("the 0225 migration", () => {
  it("seeds every existing Fansly page closed for 1.2 × S and grants the read role", async (context) => {
    if (!testDb) return context.skip();
    const partial = await startIntegrationTestDatabase({ through: "0224_page_fan_account_lookup_stamps.sql" });
    if (!partial) return context.skip();
    try {
      await partial.pool.query("insert into models (slug, name) values ('seed-model', 'Seed')");
      await partial.pool.query(`insert into pages (model_id, platform, label)
        select id, 'fansly', 'seed-fansly' from models where slug = 'seed-model'`);
      await partial.pool.query(`insert into pages (model_id, platform, label)
        select id, 'onlyfans', 'seed-onlyfans' from models where slug = 'seed-model'`);
      const { runMigrations } = await import("../packages/db/src/migrate-runner.ts");
      const client = await partial.pool.connect();
      try {
        await runMigrations({
          db: client,
          migrationsDir: path.resolve("packages/db/migrations"),
          through: "0225_fansly_page_send_guards.sql",
        });
      } finally {
        client.release();
      }
      const seeded = await partial.pool.query(`
        select p.label, g.next_u, g.holder_token, g.last_completed_at > now() - interval '1 minute' as fresh
          from fansly_page_send_guards g join pages p on p.id = g.page_id`);
      expect(seeded.rows).toEqual([{ label: "seed-fansly", next_u: 0.2, holder_token: null, fresh: true }]);
      const grants = await partial.pool.query(`
        select has_table_privilege('read_only', 'fansly_page_send_guards', 'select') as guards,
               has_table_privilege('read_only', 'fansly_send_log', 'select') as log`);
      expect(grants.rows[0]).toEqual({ guards: true, log: true });
    } finally {
      await partial.stop();
    }
  }, 120_000);
});

// ── Acceptance: two OS processes on one page (plan §2.5 p.3 (a)) ───────────

const S_MS = 300;
const LEASE_MARGIN_MS = 500;
const CHILD = "tests/helpers/fansly-send-guard-child.ts";

function startChild(config: FanslySendGuardChildConfig) {
  const child = spawn(process.execPath, ["--import", "tsx/esm", CHILD], {
    env: { ...process.env, FANSLY_SEND_GUARD_CHILD_CONFIG: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    summary: () => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        return JSON.parse(line) as {
          pid: number;
          responses: number;
          counters: { captures: number; captureRefusals: number; sendRefusals: number; closedRefusals: number };
          errors: Record<string, number>;
        };
      } catch {
        throw new Error(`child ${config.name} printed no summary; stderr:\n${stderr}`);
      }
    },
  };
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("acceptance: two processes, every sender, one page", () => {
  it("never lets two arrivals of the page come closer than S", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb;
    const page = await seedPage("guard-acceptance");
    await openGuard(page.id);
    const markers = mkdtempSync(path.join(tmpdir(), "fansly-send-guard-"));
    // The origin answers in 0–40 ms and closes 40 % of connections, so many
    // requests need a new tunnel; a fifth of the tunnels take 0.8–2 s.
    const network = await startFakeFanslyNetwork({
      closeShare: 0.4,
      tunnelDelayMs: () => (Math.random() < 0.2 ? 800 + Math.random() * 1_200 : Math.random() * 100),
    });
    const urlFor = (name: string) => {
      const url = new URL(db.connectionString);
      url.searchParams.set("application_name", `fansly-guard-${name}`);
      return url.toString();
    };
    const base = {
      pageId: page.id,
      baseUrl: network.baseUrl,
      proxyUrl: network.proxyUrl,
      settingMs: S_MS,
      leaseMarginMs: LEASE_MARGIN_MS,
      // A tenth of the captures wait 0–5 s before their send (inside the 6 s
      // send window of the long-timeout sources).
      captureDelay: { longProbability: 0.1, longMaxMs: 5_000, shortMaxMs: 40 },
      blockAfterSendCheck: null,
      hangBeforeCompletion: null,
      sweepIntervalMs: null,
    } satisfies Partial<FanslySendGuardChildConfig>;
    const blockMarker = path.join(markers, "a-blocked.json");
    const hangMarker = path.join(markers, "c-hung.json");
    const children: Array<ReturnType<typeof startChild>> = [];
    const killBackends = (name: string) => db.pool.query(`select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and application_name = $1`, [`fansly-guard-${name}`]);

    let killing = true;
    let killer: Promise<void> = Promise.resolve();
    try {
      // ── Phase 1: A and B, eight senders, 30 s. A's `account_me_cli` goes
      // first; its lease is 1 s + 1 s + 0.5 s, and its first send freezes the
      // whole process for 3.5 s right after the token check. The other
      // senders join 1.5 s later and keep trying while A is stopped.
      const a = startChild({
        ...base,
        name: "A",
        databaseUrl: urlFor("A"),
        durationMs: 30_000,
        sources: [
          { source: "account_me_cli", requestTimeoutMs: 1_000, captureDelay: false },
          { source: "sync_stream", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
          { source: "ws_hint", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
          { source: "ai_fast_lane", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
        ],
        blockAfterSendCheck: { source: "account_me_cli", nth: 1, blockMs: 3_500, markerPath: blockMarker },
      });
      const b = startChild({
        ...base,
        name: "B",
        databaseUrl: urlFor("B"),
        durationMs: 30_000,
        sources: [
          { source: "sync_stream", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
          { source: "targeted_backfill", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
          { source: "ai_accelerator", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
          { source: "endpoint_probe", requestTimeoutMs: 1_000, startDelayMs: 1_500 },
        ],
        sweepIntervalMs: 400,
      });
      children.push(a, b);

      // Lost database connections mid-flight, in both processes, all along.
      killer = (async () => {
        while (killing) {
          await new Promise((resolve) => setTimeout(resolve, 1_500 + Math.random() * 1_500));
          if (killing) await Promise.all([killBackends("A"), killBackends("B")]);
        }
      })();

      // A froze after its last token check: drop its connections while it is
      // stopped. The page must stay closed to B for the whole stop, past A's
      // lease, although A's database sessions are gone.
      const blocked = await waitFor(
        () => (existsSync(blockMarker) ? JSON.parse(readFileSync(blockMarker, "utf8")) as { token: string } : null),
        20_000, "A to stop after its token check");
      await killBackends("A");

      const [aExit, bExit] = await Promise.all([a.exited, b.exited]);
      killing = false;
      await killer;
      expect(aExit.code).toBe(0);
      expect(bExit.code).toBe(0);

      // ── Phase 2: a hung sender. C captures first and never completes; D's
      // senders join 1.5 s later and find the page held, then closed once C's
      // lease expired. C is killed; D's sweeper sees its pid gone on this host
      // and releases the page, which opens 1.2 × S later.
      const c = startChild({
        ...base,
        name: "C",
        databaseUrl: urlFor("C"),
        durationMs: 60_000,
        sources: [{ source: "replay_probe", requestTimeoutMs: 1_000, captureDelay: false }],
        hangBeforeCompletion: { nth: 1, markerPath: hangMarker },
      });
      const d = startChild({
        ...base,
        name: "D",
        databaseUrl: urlFor("D"),
        durationMs: 12_000,
        sources: [
          { source: "sync_stream", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
          { source: "alias_backfill", requestTimeoutMs: 6_000, startDelayMs: 1_500 },
        ],
        sweepIntervalMs: 400,
      });
      children.push(c, d);
      const hung = await waitFor(
        () => (existsSync(hangMarker) ? JSON.parse(readFileSync(hangMarker, "utf8")) as { token: string } : null),
        20_000, "C to hang before its completion");
      await waitFor(async () => {
        const held = await db.pool.query(`select 1 from fansly_page_send_guards
          where page_id = $1 and holder_token = $2 and lease_until <= clock_timestamp()`, [page.id, hung.token]);
        return held.rowCount ? true : null;
      }, 10_000, "C's lease to expire");
      // D keeps trying while the page is closed; give it a few attempts.
      await new Promise((resolve) => setTimeout(resolve, 500));
      c.child.kill("SIGKILL");
      await c.exited;
      await waitFor(async () => {
        const row = await db.pool.query("select outcome from fansly_send_log where guard_token = $1", [hung.token]);
        return row.rows[0]?.outcome === "confirmed_terminated" ? true : null;
      }, 10_000, "C's confirmed termination");
      const dExit = await d.exited;
      expect(dExit.code).toBe(0);

      const summaries = [a.summary(), b.summary(), d.summary()];
      const journal = await db.pool.query<{
        token: string; holder_pid: number; captured_at: Date; completed_at: Date | null; sent_at: Date | null;
        outcome: string | null; outcome_detail: string | null; pause_ms: number; jitter_u: number;
        previous_completed_at: Date | null; capture_refusals: number;
      }>(`select guard_token::text as token, holder_pid, captured_at, completed_at, sent_at, outcome, outcome_detail,
                 pause_ms, jitter_u, previous_completed_at, capture_refusals
            from fansly_send_log where page_id = $1 order by captured_at`, [page.id]);
      const rows = journal.rows;
      const arrivals = network.arrivals;

      // 1. The rule, at the origin: no two arrivals closer than S.
      expect(arrivals.length).toBeGreaterThanOrEqual(15);
      const gaps = arrivals.slice(1).map((arrival, index) => arrival.monotonicMs - arrivals[index]!.monotonicMs);
      expect(gaps.filter((gap) => gap < S_MS)).toEqual([]);

      // 2. Every arrival has its journal row, in the same order. A row whose
      //    request was cut by its timeout right after the send may lack an
      //    arrival; an arrival without a row is a send the guard never saw.
      const sent = rows.filter((row) => row.sent_at !== null).sort((x, y) => x.sent_at!.getTime() - y.sent_at!.getTime());
      let cursor = 0;
      const unmatchedArrivals: number[] = [];
      for (const arrival of arrivals) {
        while (cursor < sent.length && arrival.wallMs - sent[cursor]!.sent_at!.getTime() >= 5_000) {
          expect(["timeout", "transport_error"]).toContain(sent[cursor]!.outcome);
          cursor += 1;
        }
        const row = sent[cursor];
        if (row && arrival.wallMs >= row.sent_at!.getTime() - 5) {
          cursor += 1;
        } else {
          unmatchedArrivals.push(arrival.wallMs);
        }
      }
      expect(unmatchedArrivals).toEqual([]);
      for (const row of sent.slice(cursor)) expect(["timeout", "transport_error"]).toContain(row.outcome);

      // 3. One request in flight: captures never overlap, and each waited out
      //    its pause from the previous completion (database clock).
      expect(rows.every((row) => row.completed_at !== null)).toBe(true);
      for (let index = 1; index < rows.length; index += 1) {
        expect(rows[index]!.captured_at.getTime()).toBeGreaterThanOrEqual(rows[index - 1]!.completed_at!.getTime());
      }
      for (const row of rows.filter((candidate) => candidate.previous_completed_at !== null)) {
        expect(row.captured_at.getTime() - row.previous_completed_at!.getTime()).toBeGreaterThanOrEqual(row.pause_ms - 1);
      }

      // 4. A, stopped past its lease with its connections dropped, kept the
      //    page: its request completed by itself and was never "confirmed
      //    dead". The only confirmation is C's, and the capture after it
      //    waited 1.2 × S.
      const aBlocked = rows.find((row) => row.token === blocked.token)!;
      expect(aBlocked.outcome).not.toBe("confirmed_terminated");
      expect(aBlocked.sent_at).not.toBeNull();
      expect(rows.filter((row) => row.outcome === "confirmed_terminated").map((row) => row.token)).toEqual([hung.token]);
      const afterConfirmation = rows[rows.findIndex((row) => row.token === hung.token) + 1]!;
      expect(afterConfirmation.jitter_u).toBe(0.2);
      expect(afterConfirmation.captured_at.getTime() - afterConfirmation.previous_completed_at!.getTime())
        .toBeGreaterThanOrEqual(1.2 * S_MS - 1);

      // 5. Both processes of phase 1 sent, and the guard worked for it.
      const pids = new Set(rows.filter((row) => row.sent_at !== null).map((row) => row.holder_pid));
      expect(pids.has(summaries[0]!.pid) && pids.has(summaries[1]!.pid)).toBe(true);
      expect(rows.reduce((sum, row) => sum + row.capture_refusals, 0)).toBeGreaterThan(0);
      const counters = summaries.map((summary) => summary.counters);
      expect(counters.reduce((sum, counter) => sum + counter.captureRefusals, 0)).toBeGreaterThan(0);
      // B met the page closed behind the stopped A; D behind the hung C.
      expect(counters[1]!.closedRefusals).toBeGreaterThan(0);
      expect(counters[2]!.closedRefusals).toBeGreaterThan(0);
    } finally {
      killing = false;
      await killer.catch(() => undefined);
      for (const child of children) child.child.kill("SIGKILL");
      await network.close();
      rmSync(markers, { recursive: true, force: true });
    }
  }, 120_000);
});

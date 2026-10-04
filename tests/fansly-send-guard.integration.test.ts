import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
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
  confirmFanslySendGuardHolderTerminated,
  confirmFanslySendGuardHostsTerminated,
  createDefaultFanslySendOsProbe,
  createFanslySendGuards,
  startFanslySendGuardSweeper,
  type FanslySendOsProbe,
} from "../apps/runtime/src/services/fansly-send-guard/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { silentFanslySendGuardLogger } from "./helpers/fansly-send-guard.ts";

// Plan §2.5 step 1: the legacy engine's per-page Fansly send guard on a real
// Postgres: the statements (capture by DB clock, release by token only, an
// expired lease never opens the page, the confirmation of a dead holder,
// retention, the migration's seed).
//
// The acceptance run of §2.5 p.3 (a) — two OS processes on one page, every
// legacy sender in each through the real adapter — went with the adapter and
// those senders (step 4, S4-20): nothing in the runtime captures a page any
// more.

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

  it("the sweeper of a restarted container releases its earlier run's holder after the lease", async (context) => {
    if (!testDb) return context.skip();
    // The container (hostname = its id) restarted on the same kernel boot and
    // got a new pid namespace; the earlier run's pid 7 is taken again.
    const containerId = "48edd945dd22a3a9f0a6a0c1d4be2d4f0e1c6b3f9a1d2e3c4b5a69788796a5b4";
    const restarted: FanslySendOsProbe = {
      hostname: () => "48edd945dd22",
      bootId: () => "boot-1",
      pidNamespace: () => "pid:[4026532779]",
      processStartToken: (pid) => (pid === 7 ? "start-7-new" : null),
      containerId: () => containerId,
    };
    const registry = createFanslySendGuards({
      db: testDb.db, config: {} as never, logger: silentFanslySendGuardLogger, role: "worker", probe: restarted,
    });
    const earlierRun = holder({
      host: "48edd945dd22", pid: 7, pidStart: "start-7-old", pidNs: "pid:[4026532643]", bootId: "boot-1", role: "worker",
    });
    const expired = await seedPage("guard-restart-expired");
    const leased = await seedPage("guard-restart-leased");
    const sibling = await seedPage("guard-restart-sibling");
    for (const page of [expired, leased, sibling]) await openGuard(page.id);
    const expiredCapture = captureInput(expired.id, { leaseMs: 1, holder: earlierRun });
    const leasedCapture = captureInput(leased.id, { leaseMs: 600_000, holder: { ...earlierRun, instance: randomUUID() } });
    // Same pid namespace as this run: compared by pid, and pid 7 is alive.
    const siblingCapture = captureInput(sibling.id, {
      leaseMs: 1, holder: { ...earlierRun, pidNs: "pid:[4026532779]", pidStart: "start-7-new", instance: randomUUID() },
    });
    for (const capture of [expiredCapture, leasedCapture, siblingCapture]) {
      expect((await captureFanslyPageSendGuard(testDb.db, capture)).kind).toBe("captured");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sweeper = startFanslySendGuardSweeper(
      { db: testDb.db, logger: silentFanslySendGuardLogger },
      { registry, probe: restarted, intervalMs: 60_000 },
    );
    try {
      const result = await sweeper.sweepOnce();
      expect(result.confirmed).toEqual([{ pageId: expired.id, evidence: "pid_namespace_replaced" }]);
      expect(result.closed).toEqual([sibling.id]);
    } finally {
      await sweeper.stop();
    }
    const guards = new Map((await listFanslySendGuards(testDb.db)).map((row) => [row.pageId, row]));
    expect(guards.get(expired.id)?.holderToken).toBeNull();
    expect(guards.get(expired.id)?.nextU).toBe(0.2);
    // Not before its lease is over, whatever the evidence.
    expect(guards.get(leased.id)?.holderToken).toBe(leasedCapture.token);
    expect(guards.get(sibling.id)?.holderToken).toBe(siblingCapture.token);
    const journal = await testDb.pool.query(
      "select outcome, outcome_detail from fansly_send_log where guard_token = $1",
      [expiredCapture.token],
    );
    expect(journal.rows).toEqual([{
      outcome: "confirmed_terminated",
      outcome_detail: expect.stringMatching(/^pid_namespace_replaced; confirmed by worker@48edd945dd22 pid \d+$/),
    }]);

    // The same restart without proof that the hostname is the container's own
    // id (`--hostname`, `network_mode: host`): the page stays closed.
    const unproven = await seedPage("guard-restart-unproven");
    await openGuard(unproven.id);
    const unprovenCapture = captureInput(unproven.id, { leaseMs: 1, holder: { ...earlierRun, instance: randomUUID() } });
    await captureFanslyPageSendGuard(testDb.db, unprovenCapture);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const blind = startFanslySendGuardSweeper(
      { db: testDb.db, logger: silentFanslySendGuardLogger },
      { registry, probe: { ...restarted, containerId: () => null }, intervalMs: 60_000 },
    );
    try {
      const result = await blind.sweepOnce();
      expect(result.confirmed).toEqual([]);
      expect(result.closed).toEqual([unproven.id]);
    } finally {
      await blind.stop();
    }
  });

  it("releases one holder by its token once the operator confirmed it gone, only past its lease", async (context) => {
    if (!testDb) return context.skip();
    const stuck = await seedPage("guard-token-stuck");
    const fresh = await seedPage("guard-token-fresh");
    for (const page of [stuck, fresh]) await openGuard(page.id);
    const stuckCapture = captureInput(stuck.id, { leaseMs: 1, holder: holder({ host: "worker-container" }) });
    const freshCapture = captureInput(fresh.id, { leaseMs: 600_000, holder: holder({ host: "worker-container" }) });
    for (const capture of [stuckCapture, freshCapture]) await captureFanslyPageSendGuard(testDb.db, capture);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const confirm = (token: string, dryRun = false) =>
      confirmFanslySendGuardHolderTerminated(testDb!.db, { token, confirmer: "cli@test pid 1", dryRun });

    await expect(confirm("not-a-token")).rejects.toThrow("--holder-token expects a holder token");
    await expect(confirm(randomUUID())).rejects.toThrow("No Fansly page is held by token");
    await expect(confirm(freshCapture.token)).rejects.toThrow("only past its lease");

    expect(await confirm(stuckCapture.token.toUpperCase(), true)).toEqual({
      pageId: stuck.id, pageLabel: "guard-token-stuck", holderHost: "worker-container", released: false,
    });
    expect((await listFanslySendGuards(testDb.db)).find((row) => row.pageId === stuck.id)?.holderToken)
      .toBe(stuckCapture.token);

    expect((await confirm(stuckCapture.token)).released).toBe(true);
    const guards = new Map((await listFanslySendGuards(testDb.db)).map((row) => [row.pageId, row]));
    expect(guards.get(stuck.id)?.holderToken).toBeNull();
    expect(guards.get(stuck.id)?.nextU).toBe(0.2);
    expect(guards.get(fresh.id)?.holderToken).toBe(freshCapture.token);
    const journal = await testDb.pool.query(
      "select outcome, outcome_detail from fansly_send_log where guard_token = $1",
      [stuckCapture.token],
    );
    expect(journal.rows).toEqual([
      { outcome: "confirmed_terminated", outcome_detail: "operator_confirmed_holder; confirmed by cli@test pid 1" },
    ]);
    await expect(confirm(stuckCapture.token)).rejects.toThrow("No Fansly page is held by token");
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
    // A live lease is released only for a capture older than the listing of
    // the running hostnames, whose instant must be given.
    await expect(confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: ["worker-now"], ownHost: hostname(), confirmer: "test", includeUnexpired: true, dryRun: false,
    })).rejects.toThrow("--captured-before");
    const listedAt = (await testDb.pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    const all = await confirmFanslySendGuardHostsTerminated(testDb.db, {
      runningHosts: ["worker-now"], ownHost: hostname(), confirmer: "test", includeUnexpired: true,
      capturedBefore: listedAt, dryRun: false,
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

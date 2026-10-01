import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  advanceWsRouterCursor,
  captureAttempt,
  clearPageHold,
  confirmSyncOwnersStopped,
  createFanslyPage,
  createModel,
  ensureFanslyPageSendGuard,
  ensurePollRows,
  ensureSyncPage,
  getSyncAttempt,
  getSyncPage,
  getWorkForStatus,
  heartbeatSyncPageOwner,
  insertAdmission,
  countRecentFailedSubjects,
  issueSyncSwitchCapability,
  lastRateLimitAt,
  latestClosedWorkForKey,
  listSendsForPaceAudit,
  listSyncPages,
  listUnfinishedAttempts,
  LiveGateClosedError,
  lockOwnedPage,
  lockWorkRows,
  markApplied,
  markAttemptSent,
  markDeferred,
  markWorkRunning,
  OwnershipLostError,
  paceFloorFromDb,
  pickPlanned,
  pickUrgent,
  quarantineWork,
  recordApplyFailure,
  recoverUnfinishedAttempts,
  setNetworkFailureStreak,
  setPageHold,
  setPagePause,
  setRegistryOverride,
  setResourceHold,
  setSyncPageMode,
  settleAttemptWithoutCapture,
  settleWork,
  supersedeShadowWork,
  SYNC_PACE_AUDIT_LOOKBACK_MS,
  upsertDemand,
  upsertDemands,
  writeSafeRelease,
  type Database,
  type FanslySendHolderIdentity,
  type SyncEngineWorkClass,
  type SyncSwitchCapability,
  type UpsertDemandInput,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

// Fansly Sync Engine core state (design §2.2, §2.10, §3.3–§3.7) on a real
// Postgres: the page row (mode, ownership, holds), the work queue (demand
// merge, picks, settlement) and the attempt journal (admission, capture,
// apply, recovery, the takeover floor, the pace audit).

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

async function inTx<T>(body: (tx: Database) => Promise<T>): Promise<T> {
  return testDb!.db.transaction(async (tx) => body(tx as unknown as Database));
}

async function seedPage(label = `sync-${randomUUID().slice(0, 8)}`): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

function owner(overrides: Partial<FanslySendHolderIdentity> = {}): FanslySendHolderIdentity {
  return {
    host: "sync-host-a",
    pid: 1,
    pidStart: "start-a",
    pidNs: "pid:[4026531836]",
    bootId: "boot-1",
    instance: randomUUID(),
    role: "sync",
    ...overrides,
  };
}

async function own(pageId: number, identity = owner()): Promise<bigint> {
  const acquired = await acquireSyncPageOwnership(db(), { pageId, owner: identity });
  if (acquired.kind !== "acquired") throw new Error(`expected to acquire page ${pageId}: ${acquired.kind}`);
  return acquired.generation;
}

async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

/** Seconds from the database clock to a timestamptz column value. */
async function secondsFromNow(table: string, column: string, id: number): Promise<number> {
  const rows = await query<{ s: number }>(
    `select extract(epoch from ${column} - clock_timestamp())::float8 as s from ${table} where id = $1`,
    [id],
  );
  return Number(rows[0]!.s);
}

function demand(pageId: number, overrides: Partial<UpsertDemandInput> = {}): UpsertDemandInput {
  return {
    pageId,
    shadow: false,
    resource: "dm-messages.head",
    subject: "group-1",
    kind: "trigger",
    class: "urgent",
    ...overrides,
  };
}

async function admit(
  pageId: number,
  generation: bigint,
  work: { id: number; resource: string; subject: string; class: SyncEngineWorkClass },
  options: { shadow?: boolean; evidence?: boolean; slot?: number; nextCyclePos?: number } = {},
): Promise<{ attemptId: number; demandRevision: number }> {
  return inTx(async (tx) => {
    await lockOwnedPage(tx, { pageId, generation, lock: "no_key_update" });
    const running = await markWorkRunning(tx, { workId: work.id, generation });
    if (!running) throw new Error(`work ${work.id} is not open`);
    const { attemptId } = await insertAdmission(tx, {
      pageId,
      shadow: options.shadow ?? false,
      workId: work.id,
      resource: work.resource,
      subject: work.subject,
      class: work.class,
      slot: options.slot ?? 0,
      nextCyclePos: options.nextCyclePos ?? 1,
      generation,
      demandRevision: running.demandRevision,
      settingMs: 2_000,
      jitterU: 0.1,
      pauseMs: 2_200,
      operation: "messages.page",
      request: { path: "/api/v1/message", query: { groupId: work.subject, limit: "25" } },
      evidence: options.evidence ?? true,
    });
    return { attemptId, demandRevision: running.demandRevision };
  });
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Heap Fetches"?: number;
  Plans?: PlanNode[];
}

/** The result of `run` and the last statement it put on the pool, verbatim. */
async function captureStatement<T>(run: () => Promise<T>): Promise<{ result: T; text: string; values: unknown[] }> {
  const pool = testDb!.pool as unknown as { query: (config: unknown, values?: unknown) => Promise<unknown> };
  const original = pool.query.bind(pool);
  const captured: { text: string; values: unknown[] }[] = [];
  pool.query = (config: unknown, values?: unknown) => {
    if (typeof config === "string") {
      captured.push({ text: config, values: (values as unknown[] | undefined) ?? [] });
    } else if (config && typeof (config as { text?: unknown }).text === "string") {
      const record = config as { text: string; values?: unknown[] };
      captured.push({ text: record.text, values: (values as unknown[] | undefined) ?? record.values ?? [] });
    }
    return original(config, values);
  };
  try {
    const result = await run();
    const statement = captured.at(-1);
    if (!statement) throw new Error("no statement reached the pool");
    return { result, ...statement };
  } finally {
    pool.query = original;
  }
}

/** Rows of `relation` the executed plan read from the heap (kept or filtered out). */
async function heapVisits(statement: { text: string; values: unknown[] }, relation: string): Promise<number> {
  const explained = await testDb!.pool.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
    `explain (analyze, format json) ${statement.text}`,
    statement.values,
  );
  const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
  return flatten(explained.rows[0]!["QUERY PLAN"][0]!.Plan).reduce((sum, node) => {
    if (node["Relation Name"] !== relation) return sum;
    return sum + (node["Node Type"] === "Index Only Scan"
      ? node["Heap Fetches"] ?? 0
      : ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 0));
  }, 0);
}

// ── pages ────────────────────────────────────────────────────────────────────

describe("sync_pages rows and modes", () => {
  it("gives a Fansly page one row in mode off, and none to another platform", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("rows-fansly");
    expect(await ensureSyncPage(db(), { pageId })).toEqual({ created: false });
    const model = await query<{ id: string }>("select id::text from models limit 1");
    const onlyfans = await query<{ id: string }>(
      "insert into pages (model_id, platform, label) values ($1, 'onlyfans', 'rows-onlyfans') returning id::text",
      [model[0]!.id],
    );
    expect(await ensureSyncPage(db(), { pageId: Number(onlyfans[0]!.id) })).toEqual({ created: false });

    const page = await getSyncPage(db(), pageId);
    expect(page).toMatchObject({
      pageId,
      pageLabel: "rows-fansly",
      mode: "off",
      cyclePos: 0,
      pausedAll: false,
      pausedResources: [],
      holdKind: null,
      wsRouterCursor: 0,
      owner: { generation: 0n, host: null, releasedAt: null },
    });
    expect((await listSyncPages(db())).map((row) => row.pageId)).toEqual([pageId]);
    expect(await listSyncPages(db(), { modes: ["shadow"] })).toEqual([]);
    expect(await getSyncPage(db(), Number(onlyfans[0]!.id))).toBeNull();
  });

  it("moves off ↔ shadow freely and handover/live only with the switch capability (I17)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("modes");
    const other = await seedPage("modes-other");

    expect(await setSyncPageMode(db(), { pageId, to: "live", changedBy: "test" }))
      .toEqual({ kind: "refused", from: "off", to: "live", reason: "transition_not_allowed" });
    expect(await setSyncPageMode(db(), { pageId, to: "shadow", changedBy: "owner" }))
      .toMatchObject({ kind: "changed", from: "off", to: "shadow" });
    expect(await setSyncPageMode(db(), { pageId, to: "shadow", changedBy: "owner" }))
      .toEqual({ kind: "unchanged", mode: "shadow" });
    expect(await setSyncPageMode(db(), { pageId, to: "off", changedBy: "owner", expectFrom: "live" }))
      .toEqual({ kind: "refused", from: "shadow", to: "off", reason: "expected_mode_mismatch" });

    // No capability, a forged one, one for another page: all refused.
    expect(await setSyncPageMode(db(), { pageId, to: "handover", changedBy: "test" }))
      .toMatchObject({ kind: "refused", reason: "capability_required" });
    const forged = { kind: "sync_switch", pageId, purpose: "forged" } as SyncSwitchCapability;
    expect(await setSyncPageMode(db(), { pageId, to: "handover", changedBy: "test", capability: forged }))
      .toMatchObject({ kind: "refused", reason: "capability_required" });
    const foreign = issueSyncSwitchCapability({ pageId: other, purpose: "test" });
    expect(await setSyncPageMode(db(), { pageId, to: "handover", changedBy: "test", capability: foreign }))
      .toMatchObject({ kind: "refused", reason: "capability_required" });
    expect((await getSyncPage(db(), pageId))!.mode).toBe("shadow");

    const capability = issueSyncSwitchCapability({ pageId, purpose: "test switch" });
    expect(await setSyncPageMode(db(), { pageId, to: "live", changedBy: "switch", capability }))
      .toMatchObject({ kind: "refused", reason: "transition_not_allowed" });
    expect(await setSyncPageMode(db(), { pageId, to: "handover", changedBy: "switch", capability }))
      .toMatchObject({ kind: "changed", from: "shadow", to: "handover" });
    // Out of handover/live the owner's lever does not work either.
    expect(await setSyncPageMode(db(), { pageId, to: "shadow", changedBy: "owner" }))
      .toMatchObject({ kind: "refused", reason: "capability_required" });
    expect(await setSyncPageMode(db(), { pageId, to: "live", changedBy: "switch", capability }))
      .toMatchObject({ kind: "changed", from: "handover", to: "live" });
    expect(await setSyncPageMode(db(), { pageId, to: "off", changedBy: "switch", capability }))
      .toMatchObject({ kind: "refused", reason: "transition_not_allowed" });
    expect(await setSyncPageMode(db(), { pageId, to: "shadow", changedBy: "switch", capability }))
      .toMatchObject({ kind: "refused", reason: "transition_not_allowed" });

    // Rollback: live → handover → off clears the legacy import mark.
    await query("update sync_pages set legacy_imported_at = clock_timestamp() where page_id = $1", [pageId]);
    expect(await setSyncPageMode(db(), { pageId, to: "handover", changedBy: "rollback", capability }))
      .toMatchObject({ kind: "changed" });
    expect((await getSyncPage(db(), pageId))!.legacyImportedAt).not.toBeNull();
    expect(await setSyncPageMode(db(), { pageId, to: "off", changedBy: "rollback", capability }))
      .toMatchObject({ kind: "changed", from: "handover", to: "off" });
    const page = await getSyncPage(db(), pageId);
    expect(page).toMatchObject({ mode: "off", modeChangedBy: "rollback", legacyImportedAt: null });
    expect(await setSyncPageMode(db(), { pageId: 999_999, to: "shadow", changedBy: "owner" }))
      .toMatchObject({ kind: "refused", reason: "no_page" });
  });
});

describe("page ownership (I6, I7)", () => {
  it("acquires only after a confirmed stop: never owned, safe release, OS proof, operator confirmation", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("owners");
    const first = owner({ host: "host-old", pid: 1, pidNs: "pid:[1]" });
    const acquired = await acquireSyncPageOwnership(db(), { pageId, owner: first });
    expect(acquired).toMatchObject({ kind: "acquired", generation: 1n, evidence: "never_owned" });
    expect(await heartbeatSyncPageOwner(db(), { pageId, generation: 1n })).toBe(true);

    // The owner did not release: no automatic takeover, with or without a judge.
    const second = owner({ host: "host-new", pid: 1, pidNs: "pid:[2]" });
    const judged: unknown[] = [];
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: second })).toMatchObject({
      kind: "unconfirmed",
      previous: { generation: 1n, host: "host-old", pid: 1, pidNs: "pid:[1]", instance: first.instance },
    });
    expect(await acquireSyncPageOwnership(db(), {
      pageId,
      owner: second,
      judgePreviousOwner: (previous) => {
        judged.push(previous.host);
        return null;
      },
    })).toMatchObject({ kind: "unconfirmed" });
    expect(judged).toEqual(["host-old"]);
    expect((await getSyncPage(db(), pageId))!.owner.generation).toBe(1n);

    // (c)/(d): the acquiring host's OS proof.
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: second, judgePreviousOwner: () => "pid_gone" }))
      .toMatchObject({ kind: "acquired", generation: 2n, evidence: "os:pid_gone" });
    expect(await heartbeatSyncPageOwner(db(), { pageId, generation: 1n })).toBe(false);
    expect(await writeSafeRelease(db(), { pageId, generation: 1n })).toBe(false);

    // (b): the owner's own safe release.
    expect(await writeSafeRelease(db(), { pageId, generation: 2n })).toBe(true);
    const released = (await getSyncPage(db(), pageId))!.owner;
    expect(released.releaseGeneration).toBe(2n);
    expect(await writeSafeRelease(db(), { pageId, generation: 2n })).toBe(true);
    expect((await getSyncPage(db(), pageId))!.owner.releasedAt).toEqual(released.releasedAt);
    expect(await heartbeatSyncPageOwner(db(), { pageId, generation: 2n })).toBe(false);
    const third = owner({ host: "host-third" });
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: third, judgePreviousOwner: () => {
      throw new Error("a released owner needs no OS proof");
    } })).toMatchObject({ kind: "acquired", generation: 3n, evidence: "safe_release" });
    const page = await getSyncPage(db(), pageId);
    expect(page!.owner).toMatchObject({
      generation: 3n, host: "host-third", instance: third.instance, releasedAt: null, releaseGeneration: null,
    });

    // (e): a deploy confirms that every owner off the running containers is gone.
    await expect(confirmSyncOwnersStopped(db(), { runningHosts: [], ownHost: "", confirmedBy: "t", dryRun: true }))
      .rejects.toThrow(/running-hosts/);
    expect(await confirmSyncOwnersStopped(db(), {
      runningHosts: ["host-third"], ownHost: "cli", confirmedBy: "deploy", dryRun: false,
    })).toEqual([]);
    const dry = await confirmSyncOwnersStopped(db(), {
      runningHosts: ["host-next"], ownHost: "cli", confirmedBy: "deploy", dryRun: true,
    });
    expect(dry).toEqual([{ pageId, pageLabel: "owners", generation: 3n, ownerHost: "host-third", confirmed: false }]);
    expect((await getSyncPage(db(), pageId))!.owner.stopConfirmedAt).toBeNull();
    expect(await confirmSyncOwnersStopped(db(), {
      runningHosts: ["host-next"], ownHost: "cli", confirmedBy: "deploy", dryRun: false, pageIds: [pageId],
    })).toEqual([{ pageId, pageLabel: "owners", generation: 3n, ownerHost: "host-third", confirmed: true }]);
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: owner({ host: "host-next" }) }))
      .toMatchObject({ kind: "acquired", generation: 4n, evidence: "stop_confirmed" });
    // That confirmation predates generation 4's acquisition: it confirms nothing now.
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: owner({ host: "host-later" }) }))
      .toMatchObject({ kind: "unconfirmed", previous: { generation: 4n, stopConfirmedBy: "deploy" } });

    expect(await acquireSyncPageOwnership(db(), { pageId: 999_999, owner: owner() })).toEqual({ kind: "no_page" });
  });

  it("fences every write by the generation and gates a live lock on mode and guard owner", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("fence");
    const generation = await own(pageId);
    expect(await inTx((tx) => lockOwnedPage(tx, { pageId, generation, lock: "no_key_update" })))
      .toEqual({ mode: "off", ownerEngine: null });
    const stale = await inTx((tx) => lockOwnedPage(tx, { pageId, generation: generation - 1n, lock: "share" }))
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(OwnershipLostError);
    expect(stale).toMatchObject({ pageId, generation: generation - 1n, currentGeneration: generation });
    await expect(inTx((tx) => lockOwnedPage(tx, { pageId: 999_999, generation, lock: "share" })))
      .rejects.toMatchObject({ name: "OwnershipLostError", currentGeneration: null });

    // Live: the mode first, then the guard row's owner.
    const live = (tx: Database) => lockOwnedPage(tx, { pageId, generation, lock: "no_key_update", live: true });
    await expect(inTx(live)).rejects.toMatchObject({ name: "LiveGateClosedError", reason: "mode", mode: "off" });
    await query("update sync_pages set mode = 'live' where page_id = $1", [pageId]);
    await expect(inTx(live)).rejects.toMatchObject({ reason: "guard_owner_engine", ownerEngine: null });
    await ensureFanslyPageSendGuard(db(), pageId);
    // A new guard row belongs to the legacy engine (0229 default): closed.
    const closed = await inTx(live).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(LiveGateClosedError);
    expect(closed).toMatchObject({ reason: "guard_owner_engine", ownerEngine: "legacy" });
    // The switch's flip (design §2.8) opens it.
    await query("update fansly_page_send_guards set owner_engine = 'fansly_sync_engine' where page_id = $1", [pageId]);
    expect(await inTx(live)).toEqual({ mode: "live", ownerEngine: "fansly_sync_engine" });

    // Generation-fenced page writes.
    await expect(advanceWsRouterCursor(db(), { pageId, generation: generation + 1n, cursor: 10 }))
      .rejects.toBeInstanceOf(OwnershipLostError);
    await advanceWsRouterCursor(db(), { pageId, generation, cursor: 10 });
    await advanceWsRouterCursor(db(), { pageId, generation, cursor: 4 });
    expect((await getSyncPage(db(), pageId))!.wsRouterCursor).toBe(10);
  });
});

describe("holds, pauses and overrides", () => {
  it("holds and lifts the page, keeps the start of an ongoing hold, and holds resource files", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("holds");
    const generation = await own(pageId);
    const until = new Date(Date.now() + 120_000);
    await setPageHold(db(), { pageId, generation, kind: "rate_limit", until, step: 1, detail: { status: 429 } });
    const first = await getSyncPage(db(), pageId);
    expect(first).toMatchObject({ holdKind: "rate_limit", holdStep: 1, holdDetail: { status: 429 } });
    expect(first!.holdUntil!.getTime()).toBe(until.getTime());
    await setPageHold(db(), { pageId, generation, kind: "rate_limit", until: new Date(Date.now() + 240_000), step: 2 });
    const second = await getSyncPage(db(), pageId);
    expect(second!.holdSince).toEqual(first!.holdSince);
    expect(second!.holdStep).toBe(2);
    await setPageHold(db(), { pageId, generation, kind: "auth", until: "infinity", step: 0, detail: { credentialsGeneration: "g1" } });
    const auth = await getSyncPage(db(), pageId);
    expect(auth!.holdKind).toBe("auth");
    // 'infinity': the latest instant a Date holds.
    expect(auth!.holdUntil!.getTime()).toBe(8.64e15);
    await expect(setPageHold(db(), { pageId, generation: generation + 1n, kind: "network", until, step: 0 }))
      .rejects.toBeInstanceOf(OwnershipLostError);
    await clearPageHold(db(), { pageId, generation });
    expect(await getSyncPage(db(), pageId)).toMatchObject({ holdKind: null, holdUntil: null, holdSince: null, holdStep: 0 });
    // The owner may lift a hold without a generation.
    await setPageHold(db(), { pageId, generation, kind: "network", until, step: 3 });
    await clearPageHold(db(), { pageId });
    expect(await getSyncPage(db(), pageId)).toMatchObject({ holdKind: null, holdStep: 3 });

    await setNetworkFailureStreak(db(), { pageId, generation, streak: 2 });
    expect((await getSyncPage(db(), pageId))!.networkFailureStreak).toBe(2);

    await setResourceHold(db(), { pageId, generation, file: "media-stats", hold: { until, step: 0 } });
    const held = (await getSyncPage(db(), pageId))!.resourceHolds["media-stats"];
    expect(held).toMatchObject({ step: 0 });
    expect(new Date(held!.until).getTime()).toBe(until.getTime());
    await setResourceHold(db(), { pageId, generation, file: "media-stats", hold: { until, step: 1 } });
    expect((await getSyncPage(db(), pageId))!.resourceHolds["media-stats"]).toMatchObject({ step: 1, since: held!.since });
    await setResourceHold(db(), { pageId, generation, file: "media-stats", hold: null });
    expect((await getSyncPage(db(), pageId))!.resourceHolds).toEqual({});
    await expect(setResourceHold(db(), { pageId, file: "Media Stats", hold: null })).rejects.toThrow(/resource file/);
  });

  it("sets the owner's pauses field by field and the registry overrides per key, waking the actor", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("pauses");
    const listener: PoolClient = await testDb.pool.connect();
    const payloads: string[] = [];
    try {
      await listener.query("listen fansly_sync_work");
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      const paused = await setPagePause(db(), { pageId, all: true, note: "owner pause" });
      expect(paused).toMatchObject({ pausedAll: true, pausedRequests: false, pausedResources: [], pauseNote: "owner pause" });
      const resources = await setPagePause(db(), { pageId, resources: ["media-stats.walk", "catalog.vault", "catalog.vault"] });
      expect(resources).toMatchObject({ pausedAll: true, pausedResources: ["catalog.vault", "media-stats.walk"], pauseNote: "owner pause" });
      expect(await setPagePause(db(), { pageId, all: false, requests: true, note: null }))
        .toMatchObject({ pausedAll: false, pausedRequests: true, pauseNote: null });
      await expect(setPagePause(db(), { pageId, resources: ["catalog"] })).rejects.toThrow(/resource key/);
      expect(await setPagePause(db(), { pageId: 999_999, all: true })).toBeNull();

      expect(await setRegistryOverride(db(), { pageId, key: "media-stats.walk", override: { everyMs: 86_400_000 } })).toBe(true);
      expect(await setRegistryOverride(db(), { pageId, key: "posts.refresh", override: { enabled: false } })).toBe(true);
      expect((await getSyncPage(db(), pageId))!.registryOverrides).toEqual({
        "media-stats.walk": { everyMs: 86_400_000 },
        "posts.refresh": { enabled: false },
      });
      expect(await setRegistryOverride(db(), { pageId, key: "posts.refresh", override: null })).toBe(true);
      expect((await getSyncPage(db(), pageId))!.registryOverrides).toEqual({ "media-stats.walk": { everyMs: 86_400_000 } });
      await expect(setRegistryOverride(db(), { pageId, key: "posts", override: null })).rejects.toThrow(/resource key/);
      await expect(setRegistryOverride(db(), { pageId, key: "posts.refresh", override: { everyMs: 0 } }))
        .rejects.toThrow(/positive/);
      await expect.poll(() => payloads.length).toBeGreaterThanOrEqual(5);
      expect(new Set(payloads)).toEqual(new Set([String(pageId)]));
    } finally {
      await listener.query("unlisten *");
      listener.release();
    }
  });
});

// ── work ─────────────────────────────────────────────────────────────────────

describe("sync_work demand", () => {
  it("creates one open row per key and merges later demand into it (I11)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("demand");
    const listener: PoolClient = await testDb.pool.connect();
    const payloads: string[] = [];
    try {
      await listener.query("listen fansly_sync_work");
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      const t0 = Date.now();
      const created = await upsertDemand(db(), demand(pageId, {
        dueAt: new Date(t0 + 5_000),
        coalesceUntil: new Date(t0 + 20_000),
        deadlineAt: new Date(t0 + 30_000),
        extendOnSignal: true,
        demand: { messageIds: ["m1", "m2"], reasons: ["ws:message_created"] },
        params: { note: "first" },
      }));
      expect(created).toMatchObject({ demandRevision: 1, created: true });
      await expect.poll(() => payloads).toEqual([String(pageId)]);

      // Extension: a later quiet window moves the due time, never past the cap.
      const merged = await upsertDemand(db(), demand(pageId, {
        dueAt: new Date(t0 + 9_000),
        coalesceUntil: new Date(t0 + 60_000),
        deadlineAt: new Date(t0 + 25_000),
        extendOnSignal: true,
        demand: { messageIds: ["m2", "m3"], reasons: ["ws:message_created"] },
        params: { note: "second" },
      }));
      expect(merged).toEqual({ id: created.id, demandRevision: 2, created: false });
      let [row] = await getWorkForStatus(db(), { pageId });
      expect(row).toMatchObject({
        kind: "trigger",
        class: "urgent",
        state: "open",
        demandRevision: 2,
        appliedRevision: 0,
        demand: { messageIds: ["m1", "m2", "m3"], txIds: [], reasons: ["ws:message_created"], overflow: false },
        params: { note: "first" },
      });
      expect(row!.dueAt.getTime()).toBe(t0 + 9_000);
      expect(row!.coalesceUntil!.getTime()).toBe(t0 + 20_000);
      expect(row!.deadlineAt!.getTime()).toBe(t0 + 25_000);
      await upsertDemand(db(), demand(pageId, { dueAt: new Date(t0 + 50_000), extendOnSignal: true }));
      [row] = await getWorkForStatus(db(), { pageId });
      expect(row!.dueAt.getTime()).toBe(t0 + 20_000);
      // Without extension the earlier due time wins.
      await upsertDemand(db(), demand(pageId, { dueAt: new Date(t0 + 1_000) }));
      [row] = await getWorkForStatus(db(), { pageId });
      expect(row!.dueAt.getTime()).toBe(t0 + 1_000);
      expect(row!.demandRevision).toBe(4);

      // Shadow and live, and different subjects, are different keys.
      expect((await upsertDemand(db(), demand(pageId, { shadow: true }))).created).toBe(true);
      expect((await upsertDemand(db(), demand(pageId, { subject: "group-2" }))).created).toBe(true);
      expect(await getWorkForStatus(db(), { pageId })).toHaveLength(3);

      await expect(upsertDemand(db(), demand(pageId, { resource: "dm_messages.head" }))).rejects.toThrow(/resource key/);
      await expect(upsertDemand(db(), demand(pageId, { subject: "x".repeat(201) }))).rejects.toThrow(/200/);
    } finally {
      await listener.query("unlisten *");
      listener.release();
    }
  });

  it("bounds the merged id lists at 200 (first ones kept, overflow flagged) and reasons at 20", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("caps");
    const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => `m${from + index}`);
    await upsertDemand(db(), demand(pageId, { demand: { messageIds: ids(0, 150), reasons: ids(0, 15) } }));
    await upsertDemand(db(), demand(pageId, { demand: { messageIds: ids(100, 100), reasons: ids(10, 15) } }));
    let [row] = await getWorkForStatus(db(), { pageId });
    expect(row!.demand.messageIds).toEqual(ids(0, 200));
    expect(row!.demand.overflow).toBe(false);
    expect(row!.demand.reasons).toEqual(ids(0, 20));
    await upsertDemand(db(), demand(pageId, { demand: { messageIds: ["m999"], txIds: ["t1"] } }));
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row!.demand.messageIds).toEqual(ids(0, 200));
    expect(row!.demand.txIds).toEqual(["t1"]);
    expect(row!.demand.overflow).toBe(true);
    // Overflow is sticky.
    await upsertDemand(db(), demand(pageId, { demand: { txIds: ["t2"] } }));
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row!.demand.overflow).toBe(true);
  });

  it("carries the subject breaker of the newest closed row of the key into a new row", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("breaker");
    const generation = await own(pageId);
    const first = await upsertDemand(db(), demand(pageId, { secretParams: "ciphertext" }));
    const breakerUntil = new Date(Date.now() + 600_000);
    await settleWork(db(), {
      workId: first.id, generation, servedRevision: 1, satisfiesRevision: false,
      breaker: { failureCount: 2, breakerUntil, blockedByVendorAt: null }, lastErrorClass: "subject_failure",
    });
    await settleWork(db(), { workId: first.id, generation, servedRevision: 1, satisfiesRevision: false, close: "cancelled", closeReason: "test" });
    const closed = await latestClosedWorkForKey(db(), { pageId, shadow: false, resource: "dm-messages.head", subject: "group-1" });
    expect(closed).toMatchObject({ id: first.id, state: "cancelled", closeReason: "test", failureCount: 2 });
    expect((await query<{ secret_params: string | null }>("select secret_params from sync_work where id = $1", [first.id]))[0]!.secret_params)
      .toBeNull();

    const next = await upsertDemand(db(), demand(pageId));
    expect(next.created).toBe(true);
    const [row] = await getWorkForStatus(db(), { pageId, states: ["open"] });
    expect(row).toMatchObject({ id: next.id, failureCount: 2, lastErrorClass: "subject_failure" });
    expect(row!.breakerUntil!.getTime()).toBe(breakerUntil.getTime());
  });

  it("creates the registry's polls once, each with a random phase", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("polls");
    const polls = [
      { resource: "subscribers.poll", class: "planned" as const, everyMs: 3_600_000, phase: 0.5 },
      { resource: "account.poll", class: "planned" as const, everyMs: 60_000, phase: 0 },
      { resource: "notifications.forward", class: "planned" as const, everyMs: 1_800_000 },
    ];
    expect(await ensurePollRows(db(), { pageId, shadow: true, polls })).toBe(3);
    expect(await ensurePollRows(db(), { pageId, shadow: true, polls })).toBe(0);
    expect(await ensurePollRows(db(), { pageId, shadow: false, polls: polls.slice(0, 1) })).toBe(1);
    const rows = await getWorkForStatus(db(), { pageId, shadow: true });
    expect(rows.map((row) => [row.resource, row.kind, row.class, row.subject]).sort()).toEqual([
      ["account.poll", "poll", "planned", ""],
      ["notifications.forward", "poll", "planned", ""],
      ["subscribers.poll", "poll", "planned", ""],
    ]);
    const byResource = new Map(rows.map((row) => [row.resource, row.id]));
    expect(await secondsFromNow("sync_work", "due_at", byResource.get("account.poll")!)).toBeLessThan(1);
    const subscribers = await secondsFromNow("sync_work", "due_at", byResource.get("subscribers.poll")!);
    expect(subscribers).toBeGreaterThan(1_795);
    expect(subscribers).toBeLessThan(1_801);
    const notifications = await secondsFromNow("sync_work", "due_at", byResource.get("notifications.forward")!);
    expect(notifications).toBeGreaterThan(-1);
    expect(notifications).toBeLessThan(1_801);
    await expect(ensurePollRows(db(), { pageId, shadow: true, polls: [{ ...polls[0]!, phase: 1 }] })).rejects.toThrow(/phase/);
  });
});

describe("sync_work picks (design §3.4)", () => {
  it("serves urgent work by deadline, then by first demand; skips not-due, breaker, paused and held work", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("urgent");
    const other = await seedPage("urgent-other");
    const now = Date.now();
    const past = (ms: number) => new Date(now - ms);
    const a = await upsertDemand(db(), demand(pageId, { subject: "a", dueAt: past(5_000), deadlineAt: new Date(now + 30_000) }));
    const b = await upsertDemand(db(), demand(pageId, { subject: "b", dueAt: past(5_000), deadlineAt: new Date(now + 10_000) }));
    const c = await upsertDemand(db(), demand(pageId, { subject: "c", dueAt: past(5_000) }));
    const d = await upsertDemand(db(), demand(pageId, { resource: "transactions.head", subject: "", dueAt: past(5_000) }));
    await upsertDemand(db(), demand(pageId, { subject: "later", dueAt: new Date(now + 60_000) }));
    await upsertDemand(db(), demand(pageId, { subject: "shadow", shadow: true, dueAt: past(5_000) }));
    await upsertDemand(db(), demand(other, { subject: "a", dueAt: past(5_000) }));
    await upsertDemand(db(), demand(pageId, { subject: "planned", class: "planned", dueAt: past(5_000) }));
    const broken = await upsertDemand(db(), demand(pageId, { subject: "broken", dueAt: past(5_000) }));
    await query("update sync_work set breaker_until = clock_timestamp() + interval '1 hour' where id = $1", [broken.id]);

    const ids = async (filter: Partial<Parameters<typeof pickUrgent>[1]> = {}) =>
      (await pickUrgent(db(), { pageId, shadow: false, ...filter })).map((row) => row.id);
    expect(await ids()).toEqual([b.id, a.id, c.id, d.id]);
    expect(await ids({ limit: 2 })).toEqual([b.id, a.id]);
    expect(await ids({ excludeResources: ["dm-messages.head"] })).toEqual([d.id]);
    expect(await ids({ excludeFiles: ["transactions"] })).toEqual([b.id, a.id, c.id]);
    expect(await ids({ now: new Date(now + 7_200_000) })).toContain(broken.id);
    expect((await pickUrgent(db(), { pageId, shadow: true })).map((row) => row.subject)).toEqual(["shadow"]);
    await expect(pickUrgent(db(), { pageId, shadow: false, excludeFiles: ["no.dots"] })).rejects.toThrow(/resource file/);
  });

  it("puts due polls first, then round robin by resource key so triggers never starve a walk", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("planned");
    const generation = await own(pageId);
    const past = new Date(Date.now() - 60_000);
    const triggers: UpsertDemandInput[] = Array.from({ length: 60 }, (_, index) => demand(pageId, {
      resource: "dm-messages.catchup", subject: `g${String(index).padStart(3, "0")}`, class: "planned", dueAt: past,
    }));
    await upsertDemands(db(), triggers);
    const mediaWalk = await upsertDemand(db(), demand(pageId, {
      resource: "media-stats.walk", subject: "", kind: "goal", class: "planned", dueAt: new Date(Date.now() - 1_000),
    }));
    const vaultWalk = await upsertDemand(db(), demand(pageId, {
      resource: "catalog.vault", subject: "", kind: "goal", class: "planned", dueAt: new Date(Date.now() - 1_000),
    }));
    await ensurePollRows(db(), { pageId, shadow: false, polls: [{ resource: "subscribers.poll", class: "planned", everyMs: 60_000, phase: 0 }] });

    const served: string[] = [];
    for (let slot = 0; slot < 12; slot++) {
      const picked = await pickPlanned(db(), { pageId, shadow: false });
      expect(picked).not.toBeNull();
      const work = picked!.work;
      served.push(work.resource);
      const admitted = await admit(pageId, generation, work, { slot: 9, nextCyclePos: 0 });
      // Walks continue (open, due now); triggers and the poll complete.
      await settleWork(db(), work.kind === "goal"
        ? { workId: work.id, generation, servedRevision: admitted.demandRevision, satisfiesRevision: false }
        : work.kind === "poll"
          ? {
            workId: work.id, generation, servedRevision: admitted.demandRevision, satisfiesRevision: true,
            nextDueAt: new Date(Date.now() + 3_600_000), waitingReason: "not_due",
          }
          : { workId: work.id, generation, servedRevision: admitted.demandRevision, satisfiesRevision: true, close: "done" });
    }
    expect(served[0]).toBe("subscribers.poll");
    const walks = served.slice(1);
    for (let start = 0; start + 3 <= walks.length; start++) {
      const window = walks.slice(start, start + 3);
      expect(window, `planned slots ${start + 1}..${start + 3}`).toContain("media-stats.walk");
      expect(window).toContain("catalog.vault");
    }
    const page = await getSyncPage(db(), pageId);
    expect(Object.keys(page!.plannedRr).sort()).toEqual(["catalog.vault", "dm-messages.catchup", "media-stats.walk", "subscribers.poll"]);
    expect(page!.cyclePos).toBe(0);

    // A paused key is skipped, the next key is served.
    const paused = await pickPlanned(db(), {
      pageId, shadow: false, excludeResources: ["media-stats.walk", "catalog.vault"],
    });
    expect(paused!.work.resource).toBe("dm-messages.catchup");
    const held = await pickPlanned(db(), { pageId, shadow: false, excludeFiles: ["dm-messages", "catalog"] });
    expect(held!.work.id).toBe(mediaWalk.id);
    expect(await pickPlanned(db(), { pageId, shadow: false, plannedRr: { "media-stats.walk": new Date(0).toISOString() } }))
      .toMatchObject({ level: "round_robin" });
    expect(vaultWalk.created).toBe(true);
    expect(await pickPlanned(db(), { pageId, shadow: true })).toBeNull();
  });
});

describe("sync_work settlement", () => {
  it("closes only when no newer demand arrived during the step; otherwise runs again (I11)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("settle");
    const generation = await own(pageId);
    const work = await upsertDemand(db(), demand(pageId, { secretParams: "secret" }));
    const running = await markWorkRunning(db(), { workId: work.id, generation });
    expect(running).toEqual({ demandRevision: 1 });
    expect(await markWorkRunning(db(), { workId: work.id, generation })).toBeNull();
    let [row] = await getWorkForStatus(db(), { pageId });
    expect(row).toMatchObject({ state: "running", waitingReason: "running", attemptsCount: 1, ownerGeneration: generation });

    // A new event while the read is in flight.
    await upsertDemand(db(), demand(pageId, { dueAt: new Date(Date.now() + 5_000), demand: { messageIds: ["m9"] } }));
    const settled = await settleWork(db(), {
      workId: work.id, generation, servedRevision: 1, satisfiesRevision: true, close: "done",
      cursor: { headId: "m8" }, nextDueAt: new Date(Date.now() + 3_600_000),
    });
    expect(settled).toEqual({ state: "open", demandRevision: 2, appliedRevision: 1 });
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row).toMatchObject({ state: "open", cursor: { headId: "m8" }, closedAt: null, waitingReason: null });
    // The newer demand's due time stands; the step's later one does not push it.
    expect(await secondsFromNow("sync_work", "due_at", work.id)).toBeLessThan(6);
    expect((await query<{ secret_params: string | null }>("select secret_params from sync_work where id = $1", [work.id]))[0]!.secret_params)
      .toBe("secret");

    // The next read serves revision 2: now it closes.
    const again = await markWorkRunning(db(), { workId: work.id, generation });
    expect(again).toEqual({ demandRevision: 2 });
    expect(await settleWork(db(), {
      workId: work.id, generation, servedRevision: 2, satisfiesRevision: true, close: "done", proof: { kind: "head_known_item" },
      result: { visible: 1 },
    })).toEqual({ state: "done", demandRevision: 2, appliedRevision: 2 });
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row).toMatchObject({ state: "done", proof: { kind: "head_known_item" }, result: { visible: 1 } });
    expect(row!.closedAt).not.toBeNull();
    expect((await query<{ secret_params: string | null }>("select secret_params from sync_work where id = $1", [work.id]))[0]!.secret_params)
      .toBeNull();
    expect(await settleWork(db(), { workId: work.id, generation, servedRevision: 2, satisfiesRevision: true })).toBeNull();
  });

  it("reschedules a poll, quarantines, supersedes shadow work and locks rows in id order", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("misc");
    const generation = await own(pageId);
    await ensurePollRows(db(), { pageId, shadow: false, polls: [{ resource: "account.poll", class: "planned", everyMs: 3_600_000, phase: 0 }] });
    const [poll] = await getWorkForStatus(db(), { pageId });
    const waitingUntil = new Date(Date.now() + 3_600_000);
    expect(await settleWork(db(), {
      workId: poll!.id, generation, servedRevision: 1, satisfiesRevision: true,
      nextDueAt: waitingUntil, waitingReason: "not_due", waitingUntil, proof: null,
    })).toEqual({ state: "open", demandRevision: 1, appliedRevision: 1 });
    const [rescheduled] = await getWorkForStatus(db(), { pageId });
    expect(rescheduled).toMatchObject({ waitingReason: "not_due", proof: null });
    expect(rescheduled!.dueAt.getTime()).toBe(waitingUntil.getTime());

    const broken = await upsertDemand(db(), demand(pageId, { subject: "broken" }));
    expect(await quarantineWork(db(), { workId: broken.id, generation, errorClass: "contract" })).toBe(true);
    expect(await quarantineWork(db(), { workId: broken.id, generation, errorClass: "contract" })).toBe(false);
    expect(await upsertDemand(db(), demand(pageId, { subject: "broken" }))).toMatchObject({ id: broken.id, created: false, demandRevision: 2 });
    expect((await pickUrgent(db(), { pageId, shadow: false })).map((row) => row.id)).not.toContain(broken.id);
    expect((await getWorkForStatus(db(), { pageId, subject: "broken" }))[0])
      .toMatchObject({ state: "quarantined", waitingReason: "quarantined", lastErrorClass: "contract" });

    const shadowOpen = await upsertDemand(db(), demand(pageId, { shadow: true, subject: "s1" }));
    const shadowRunning = await upsertDemand(db(), demand(pageId, { shadow: true, subject: "s2" }));
    await markWorkRunning(db(), { workId: shadowRunning.id, generation });
    expect(await supersedeShadowWork(db(), { pageId })).toBe(2);
    expect((await getWorkForStatus(db(), { pageId, shadow: true })).map((row) => [row.id, row.state, row.closeReason]).sort())
      .toEqual([[shadowOpen.id, "superseded", "shadow_ended"], [shadowRunning.id, "superseded", "shadow_ended"]].sort());
    expect((await getWorkForStatus(db(), { pageId, shadow: false })).every((row) => row.state !== "superseded")).toBe(true);

    const locked = await inTx((tx) => lockWorkRows(tx, [broken.id, poll!.id, broken.id]));
    expect(locked.map((row) => row.id)).toEqual([poll!.id, broken.id].sort((x, y) => x - y));
    expect(await lockWorkRows(db(), [])).toEqual([]);
  });
});

// ── attempts ─────────────────────────────────────────────────────────────────

describe("sync_attempts", () => {
  it("admits under the generation: attempt, work link, cycle pointer, planned round-robin stamp", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("admit");
    const generation = await own(pageId);
    const work = await upsertDemand(db(), demand(pageId));
    const { attemptId } = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject: "group-1", class: "urgent" }, {
      slot: 4, nextCyclePos: 5,
    });
    const attempt = await getSyncAttempt(db(), attemptId);
    expect(attempt).toMatchObject({
      pageId, shadow: false, workId: work.id, resource: "dm-messages.head", subject: "group-1", class: "urgent", slot: 4,
      ownerGeneration: generation, demandRevision: 1, settingMs: 2_000, jitterU: 0.1, pauseMs: 2_200,
      outcome: "admitted", applyState: "none", evidence: true, sentAt: null,
      request: { path: "/api/v1/message", query: { groupId: "group-1", limit: "25" } },
    });
    const page = await getSyncPage(db(), pageId);
    expect(page!.cyclePos).toBe(5);
    expect(page!.plannedRr).toEqual({});
    expect(page!.lastAdmittedAt).not.toBeNull();
    expect((await getWorkForStatus(db(), { pageId }))[0]).toMatchObject({ state: "running", lastAttemptId: attemptId });

    // A planned admission stamps its key; a shadow attempt is never evidence.
    const shadowWork = await upsertDemand(db(), demand(pageId, { shadow: true, resource: "catalog.vault", subject: "", kind: "goal", class: "planned" }));
    const shadowAttempt = await admit(pageId, generation, { ...shadowWork, resource: "catalog.vault", subject: "", class: "planned" }, {
      shadow: true, evidence: true, slot: 9, nextCyclePos: 0,
    });
    expect(await getSyncAttempt(db(), shadowAttempt.attemptId)).toMatchObject({ shadow: true, evidence: false, class: "planned" });
    expect(Object.keys((await getSyncPage(db(), pageId))!.plannedRr)).toEqual(["catalog.vault"]);

    // A foreign generation admits nothing: the whole transaction rolls back.
    const third = await upsertDemand(db(), demand(pageId, { subject: "group-3" }));
    const before = await query<{ n: number }>("select count(*)::int as n from sync_attempts");
    await expect(inTx(async (tx) => {
      await markWorkRunning(tx, { workId: third.id, generation });
      await insertAdmission(tx, {
        pageId, shadow: false, workId: third.id, resource: "dm-messages.head", subject: "group-3", class: "urgent", slot: 0,
        nextCyclePos: 1, generation: generation + 1n, demandRevision: 1, settingMs: 2_000, jitterU: 0, pauseMs: 2_000,
        operation: "messages.page", request: {}, evidence: true,
      });
    })).rejects.toBeInstanceOf(OwnershipLostError);
    expect(await query<{ n: number }>("select count(*)::int as n from sync_attempts")).toEqual(before);
    expect((await getWorkForStatus(db(), { pageId, subject: "group-3" }))[0]!.state).toBe("open");
  });

  it("captures the outcome and the page's send facts once, never moving last_send_at back", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("capture");
    const generation = await own(pageId);
    const first = await upsertDemand(db(), demand(pageId, { subject: "a" }));
    const a = await admit(pageId, generation, { ...first, resource: "dm-messages.head", subject: "a", class: "urgent" });
    const sentAt = new Date(Date.now() - 3_000);
    expect(await markAttemptSent(db(), { attemptId: a.attemptId, sentAt })).toBe(true);
    expect(await markAttemptSent(db(), { attemptId: a.attemptId, sentAt })).toBe(false);
    expect(await getSyncAttempt(db(), a.attemptId)).toMatchObject({ outcome: "sent", sentAt });

    const receivedAt = new Date(Date.now() - 2_000);
    const captured = await captureAttempt(db(), {
      attemptId: a.attemptId, pageId, outcome: "response", sent: true, sentAt, sendMark: "request_start",
      sendMonoOffsetMs: 12.5, gapPrevMs: null, httpStatus: 200, durationMs: 640, responseBytes: 2_048,
      observation: { id: 42, receivedAt }, applyState: "captured",
    });
    expect(captured).toEqual({ captured: true, previousSendAt: null, paceGapMs: null });
    expect(await getSyncAttempt(db(), a.attemptId)).toMatchObject({
      outcome: "response", sendMark: "request_start", httpStatus: 200, durationMs: 640, responseBytes: 2_048,
      observationId: 42, observationReceivedAt: receivedAt, applyState: "captured", sendMonoOffsetMs: 12.5,
    });
    const page = await getSyncPage(db(), pageId);
    expect(page).toMatchObject({ lastSendAt: sentAt, lastSendAttemptId: a.attemptId });
    expect(page!.lastCompletedAt).not.toBeNull();
    // Repeated capture: nothing changes.
    expect(await captureAttempt(db(), {
      attemptId: a.attemptId, pageId, outcome: "timeout", sent: false, sentAt: null, sendMark: null, applyState: "none",
    })).toMatchObject({ captured: false });

    // The next send of the page: the gap is reported for the pace self-check.
    const second = await upsertDemand(db(), demand(pageId, { subject: "b" }));
    const b = await admit(pageId, generation, { ...second, resource: "dm-messages.head", subject: "b", class: "urgent" });
    const closeSend = new Date(sentAt.getTime() + 1_500);
    const close = await captureAttempt(db(), {
      attemptId: b.attemptId, pageId, outcome: "transport_error", sent: true, sentAt: closeSend, sendMark: "request_start",
      errorClass: "network", applyState: "none",
    });
    expect(close).toEqual({ captured: true, previousSendAt: sentAt, paceGapMs: 1_500 });
    expect(await getSyncAttempt(db(), b.attemptId)).toMatchObject({ outcome: "transport_error", errorClass: "network", applyState: "none" });

    // A late capture of an older send never moves last_send_at back.
    const third = await upsertDemand(db(), demand(pageId, { subject: "c" }));
    const c = await admit(pageId, generation, { ...third, resource: "dm-messages.head", subject: "c", class: "urgent" });
    await captureAttempt(db(), {
      attemptId: c.attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(sentAt.getTime() - 10_000),
      sendMark: "completion_fallback", httpStatus: 500, applyState: "none",
    });
    expect((await getSyncPage(db(), pageId))!.lastSendAt).toEqual(closeSend);

    // A transport error before the send leaves the page's send facts alone.
    const fourth = await upsertDemand(db(), demand(pageId, { subject: "d" }));
    const d = await admit(pageId, generation, { ...fourth, resource: "dm-messages.head", subject: "d", class: "urgent" });
    const lastCompleted = (await getSyncPage(db(), pageId))!.lastCompletedAt;
    expect(await captureAttempt(db(), {
      attemptId: d.attemptId, pageId, outcome: "transport_error", sent: false, sentAt: null, sendMark: null, applyState: "none",
    })).toMatchObject({ captured: true, paceGapMs: null });
    expect(await getSyncAttempt(db(), d.attemptId)).toMatchObject({ sentAt: null, sendMark: null });
    expect((await getSyncPage(db(), pageId))!.lastCompletedAt).toEqual(lastCompleted);
  });

  it("settles shadow and refused attempts without the live send facts", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("shadow-settle");
    const generation = await own(pageId);
    const work = await upsertDemand(db(), demand(pageId, { shadow: true }));
    const shadow = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject: "group-1", class: "urgent" }, { shadow: true });
    // A live outcome is never written as 'shadow' onto a live row and vice versa.
    const simulated = new Date(Date.now() - 100);
    expect(await settleAttemptWithoutCapture(db(), { attemptId: shadow.attemptId, outcome: "shadow", sentAt: simulated, gapPrevMs: 2_300 }))
      .toBe(true);
    expect(await getSyncAttempt(db(), shadow.attemptId)).toMatchObject({
      outcome: "shadow", sendMark: "shadow", sentAt: simulated, applyState: "skipped", gapPrevMs: 2_300,
    });
    expect(await settleAttemptWithoutCapture(db(), { attemptId: shadow.attemptId, outcome: "shadow" })).toBe(false);
    expect((await getSyncPage(db(), pageId))!.lastSendAt).toBeNull();

    const live = await upsertDemand(db(), demand(pageId, { subject: "live" }));
    const refused = await admit(pageId, generation, { ...live, resource: "dm-messages.head", subject: "live", class: "urgent" });
    expect(await settleAttemptWithoutCapture(db(), { attemptId: refused.attemptId, outcome: "shadow" })).toBe(false);
    expect(await settleAttemptWithoutCapture(db(), {
      attemptId: refused.attemptId, outcome: "aborted_before_send", errorClass: "send_deadline_passed",
    })).toBe(true);
    expect(await getSyncAttempt(db(), refused.attemptId)).toMatchObject({
      outcome: "aborted_before_send", errorClass: "send_deadline_passed", sentAt: null, sendMark: null, applyState: "none",
    });
  });

  it("applies, defers and quarantines by the §3.7.3 rules", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("apply");
    const generation = await own(pageId);
    const attempts: number[] = [];
    for (const subject of ["ok", "generic", "deterministic"]) {
      const work = await upsertDemand(db(), demand(pageId, { subject }));
      const { attemptId } = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject, class: "urgent" });
      await captureAttempt(db(), {
        attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(), sendMark: "request_start", httpStatus: 200,
        observation: { id: attemptId, receivedAt: new Date() }, applyState: "captured",
      });
      attempts.push(attemptId);
    }
    const [ok, generic, deterministic] = attempts as [number, number, number];
    expect((await listUnfinishedAttempts(db(), { pageId, phase: "apply", dueOnly: true })).map((row) => row.id).sort())
      .toEqual([...attempts].sort((x, y) => x - y));

    expect(await markDeferred(db(), { attemptId: ok, error: "erasure_busy", retryInMs: 60_000 })).toBe(true);
    expect((await listUnfinishedAttempts(db(), { pageId, phase: "apply", dueOnly: true })).map((row) => row.id)).not.toContain(ok);
    expect(await getSyncAttempt(db(), ok)).toMatchObject({ applyState: "deferred", applyError: "erasure_busy", applyFailures: 0 });
    expect(await markApplied(db(), { attemptId: ok })).toBe(true);
    expect(await markApplied(db(), { attemptId: ok })).toBe(false);
    expect(await getSyncAttempt(db(), ok)).toMatchObject({ applyState: "applied", applyError: null, applyRetryAt: null });

    expect(await recordApplyFailure(db(), { attemptId: generic, error: "Error", retryInMs: 1_000, deterministic: false }))
      .toEqual({ failures: 1, quarantined: false });
    expect(await recordApplyFailure(db(), { attemptId: generic, error: "Error", retryInMs: 5_000, deterministic: false }))
      .toEqual({ failures: 2, quarantined: false });
    expect(await getSyncAttempt(db(), generic)).toMatchObject({ applyState: "deferred" });
    expect(await recordApplyFailure(db(), { attemptId: generic, error: "Error", retryInMs: 30_000, deterministic: false }))
      .toEqual({ failures: 3, quarantined: true });
    expect(await getSyncAttempt(db(), generic)).toMatchObject({ applyState: "quarantined", applyRetryAt: null });
    expect(await recordApplyFailure(db(), { attemptId: generic, error: "Error", retryInMs: 0, deterministic: false })).toBeNull();

    expect(await recordApplyFailure(db(), { attemptId: deterministic, error: "23505", retryInMs: 1_000, deterministic: true }))
      .toEqual({ failures: 1, quarantined: true });
    expect(await listUnfinishedAttempts(db(), { pageId, phase: "apply" })).toEqual([]);
  });

  it("recovers a previous run: unknown live sends, closed shadow admissions, due applies, reopened work", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("recover");
    const generation = await own(pageId);
    const make = async (subject: string, shadow = false) => {
      const work = await upsertDemand(db(), demand(pageId, { subject, shadow }));
      const admitted = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject, class: "urgent" }, { shadow });
      return { workId: work.id, attemptId: admitted.attemptId };
    };
    const admitted = await make("admitted");
    const sent = await make("sent");
    await markAttemptSent(db(), { attemptId: sent.attemptId, sentAt: new Date() });
    const shadow = await make("shadow", true);
    const captured = await make("captured");
    await captureAttempt(db(), {
      attemptId: captured.attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(), sendMark: "request_start",
      httpStatus: 200, observation: { id: 7, receivedAt: new Date() }, applyState: "captured",
    });
    await markDeferred(db(), { attemptId: captured.attemptId, error: "erasure_busy", retryInMs: 3_600_000 });
    expect((await listUnfinishedAttempts(db(), { pageId, phase: "send" })).map((row) => row.id).sort((x, y) => x - y))
      .toEqual([admitted.attemptId, sent.attemptId, shadow.attemptId]);

    // The run "crashed": its successor is admitted by an operator's confirmation.
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: owner({ host: "after-restart" }) }))
      .toMatchObject({ kind: "unconfirmed" });
    await confirmSyncOwnersStopped(db(), { runningHosts: ["after-restart"], ownHost: "cli", confirmedBy: "test", dryRun: false });
    expect(await own(pageId, owner({ host: "after-restart" }))).toBe(generation + 1n);
    expect(await inTx((tx) => recoverUnfinishedAttempts(tx, { pageId })))
      .toEqual({ unknown: 2, shadowClosed: 1, workReopened: 3, appliesDue: 1 });
    expect(await getSyncAttempt(db(), admitted.attemptId)).toMatchObject({ outcome: "unknown" });
    expect(await getSyncAttempt(db(), sent.attemptId)).toMatchObject({ outcome: "unknown" });
    expect(await getSyncAttempt(db(), shadow.attemptId)).toMatchObject({ outcome: "shadow", sendMark: "shadow", applyState: "skipped" });
    expect((await listUnfinishedAttempts(db(), { pageId, phase: "apply", dueOnly: true })).map((row) => row.id))
      .toEqual([captured.attemptId]);
    const states = new Map((await getWorkForStatus(db(), { pageId })).map((row) => [row.id, row.state]));
    expect(states.get(admitted.workId)).toBe("open");
    expect(states.get(sent.workId)).toBe("open");
    expect(states.get(shadow.workId)).toBe("open");
    expect(states.get(captured.workId)).toBe("running");
    expect(await inTx((tx) => recoverUnfinishedAttempts(tx, { pageId })))
      .toEqual({ unknown: 0, shadowClosed: 0, workReopened: 0, appliesDue: 1 });
  });
});

describe("the takeover floor (I5) and the pace audit", () => {
  const S = 2_000;

  it("waits 1.2 × S after every earlier send the database knows of, by the database clock", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("floor");
    const generation = await own(pageId);
    const floor = () => paceFloorFromDb(db(), { pageId, settingMs: S });
    const near = (value: number, expected: number) => {
      expect(value).toBeGreaterThan(expected - 1_000);
      expect(value).toBeLessThanOrEqual(expected + 1);
    };
    near(await floor(), 2_400);

    // The page's last live send in the future of now (another owner's clock).
    await query("update sync_pages set last_send_at = clock_timestamp() + interval '3 seconds' where page_id = $1", [pageId]);
    near(await floor(), 5_400);
    await query("update sync_pages set last_send_at = null, last_completed_at = clock_timestamp() + interval '4 seconds' where page_id = $1", [pageId]);
    near(await floor(), 6_400);
    await query("update sync_pages set last_completed_at = null where page_id = $1", [pageId]);

    // An admitted live attempt with no recorded send may still be sending
    // until its send window ends.
    const work = await upsertDemand(db(), demand(pageId));
    const admitted = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject: "group-1", class: "urgent" });
    near(await floor(), 15_000 + 2_400);
    // Its recorded send (a second ago) replaces the window bound.
    await markAttemptSent(db(), { attemptId: admitted.attemptId, sentAt: new Date(Date.now() - 1_000) });
    near(await floor(), 2_400);
    // An unknown outcome still counts; one older than the 10-minute lookback does not.
    await query("update sync_attempts set outcome = 'unknown', sent_at = null where id = $1", [admitted.attemptId]);
    near(await floor(), 15_000 + 2_400);
    await query("update sync_attempts set admitted_at = clock_timestamp() - interval '11 minutes' where id = $1", [admitted.attemptId]);
    near(await floor(), 2_400);
    // Shadow attempts never count.
    const shadowWork = await upsertDemand(db(), demand(pageId, { shadow: true }));
    await admit(pageId, generation, { ...shadowWork, resource: "dm-messages.head", subject: "group-1", class: "urgent" }, { shadow: true });
    near(await floor(), 2_400);

    // The legacy guard: its last completion, and a request holding it right now.
    await ensureFanslyPageSendGuard(db(), pageId);
    await query("update fansly_page_send_guards set last_completed_at = clock_timestamp() + interval '5 seconds' where page_id = $1", [pageId]);
    near(await floor(), 7_400);
    await query(`update fansly_page_send_guards
                    set holder_token = gen_random_uuid(), holder_source = 'sync_stream', holder_host = 'w', holder_pid = 1,
                        holder_instance = gen_random_uuid(), captured_at = clock_timestamp(),
                        lease_until = clock_timestamp() + interval '20 seconds'
                  where page_id = $1`, [pageId]);
    near(await floor(), 22_400);
    near(await paceFloorFromDb(db(), { pageId, settingMs: 10_000 }), 32_000);

    await expect(paceFloorFromDb(db(), { pageId: 999_999, settingMs: S })).rejects.toThrow(/no sync_pages row/);
    await expect(paceFloorFromDb(db(), { pageId, settingMs: 0 })).rejects.toThrow(/positive/);
  });

  it("lists the sends of a window with the gap to the previous send, across owners", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("audit");
    const generation = await own(pageId);
    const base = Date.now() - 60_000;
    const sends = [0, 2_100, 4_300, 5_000, 9_000];
    const ids: number[] = [];
    for (const [index, offset] of sends.entries()) {
      const work = await upsertDemand(db(), demand(pageId, { subject: `s${index}` }));
      const { attemptId } = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject: `s${index}`, class: "urgent" });
      await captureAttempt(db(), {
        attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(base + offset), sendMark: "request_start",
        httpStatus: 200, applyState: "none",
      });
      ids.push(attemptId);
    }
    const audit = await listSendsForPaceAudit(db(), { pageId, since: new Date(base + 1_000), until: new Date(base + 8_000) });
    expect(audit.map((send) => [send.attemptId, send.gapMs])).toEqual([
      [ids[1], 2_100],
      [ids[2], 2_200],
      [ids[3], 700],
    ]);
    expect(audit.every((send) => send.settingMs === 2_000 && send.ownerGeneration === generation)).toBe(true);
    expect((await listSendsForPaceAudit(db(), { pageId, since: new Date(base - 1_000) }))[0]).toMatchObject({ attemptId: ids[0], gapMs: null });
    expect(await listSendsForPaceAudit(db(), { pageId, since: new Date(base - 1_000), shadow: true })).toEqual([]);
  });

  it("looks back a bounded span for the previous send, however long the other journal is", async (context) => {
    if (!testDb) return context.skip();
    // 30 days of one journal (a send every 2 min) and nothing of the other
    // before the window: the live audit of a page in its first hour after the
    // switch, or the shadow audit of a page live for a long time. The audit's
    // reads must stay inside its window and the look-back.
    for (const shadow of [false, true]) {
      const pageId = await seedPage(`audit-history-${shadow ? "shadow" : "live"}`);
      const generation = await own(pageId);
      const since = new Date(Date.now() - 60_000);
      const columns = `page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                       admitted_at, sent_at, send_mark, operation, request, outcome`;
      const values = `$1, $2::boolean, 'dm-messages.head', 'group-1', 'urgent', $3, 2000, 0.1, 2200, t, t,
                      case when $2::boolean then 'shadow' else 'request_start' end, 'messages.page', '{}'::jsonb,
                      case when $2::boolean then 'shadow' else 'response' end`;
      await query(
        `insert into sync_attempts (${columns})
         select ${values} from generate_series(1, 21600) n, lateral (select $4::timestamptz - n * interval '2 minutes') s(t)`,
        [pageId, !shadow, generation.toString(), since],
      );
      const send = async (at: number): Promise<number> => {
        const rows = await query<{ id: string }>(
          `insert into sync_attempts (${columns}) select ${values} from (select $4::timestamptz) s(t) returning id::text`,
          [pageId, shadow, generation.toString(), new Date(at)],
        );
        return Number(rows[0]!.id);
      };
      const ids = [await send(since.getTime() + 1_000), await send(since.getTime() + 3_100), await send(since.getTime() + 5_300)];
      await query("analyze sync_attempts");

      const audit = await captureStatement(() => listSendsForPaceAudit(db(), { pageId, since, shadow }));
      expect(audit.result.map((row) => [row.attemptId, row.gapMs])).toEqual([[ids[0], null], [ids[1], 2_100], [ids[2], 2_200]]);
      expect(await heapVisits(audit, "sync_attempts")).toBeLessThan(50);

      // An earlier send of the same journal beyond the look-back is no pace
      // violation whatever the setting: the window's first gap stays unknown.
      const earlier = await send(since.getTime() - SYNC_PACE_AUDIT_LOOKBACK_MS - 1);
      expect((await listSendsForPaceAudit(db(), { pageId, since, shadow }))[0]).toMatchObject({ attemptId: ids[0], gapMs: null });
      // At the look-back's edge it is the previous send.
      await query("update sync_attempts set sent_at = $2 where id = $1", [earlier, new Date(since.getTime() - SYNC_PACE_AUDIT_LOOKBACK_MS)]);
      expect((await listSendsForPaceAudit(db(), { pageId, since, shadow }))[0]).toMatchObject({
        attemptId: ids[0],
        gapMs: SYNC_PACE_AUDIT_LOOKBACK_MS + 1_000,
      });
    }
  }, 120_000);
});

describe("the capture's reads of the journal (under the page row lock)", () => {
  it("read only the attempts admitted within their bound, however long the journal is", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("rate-limit-lookback");
    const generation = await own(pageId);
    const withinMs = 70 * 60_000;
    const columns = `page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                     admitted_at, sent_at, completed_at, send_mark, operation, request, outcome, http_status`;
    const insert = async (shadow: boolean, admittedAt: Date, status: number): Promise<number> => {
      const rows = await query<{ id: string }>(
        `insert into sync_attempts (${columns})
         values ($1, $2::boolean, 'posts.refresh', '', 'planned', $3, 2000, 0.1, 2200, $4, $4,
                 $4::timestamptz + interval '5 seconds', 'request_start', 'posts.page', '{}'::jsonb, 'response', $5)
         returning id::text`,
        [pageId, shadow, generation.toString(), admittedAt, status],
      );
      return Number(rows[0]!.id);
    };
    // 30 days of answers (one every 2 min): a 429 among them every day, a
    // subject failure every third.
    const now = Date.now();
    await query(
      `insert into sync_attempts (${columns}, error_class)
       select $1, false, 'posts.refresh', 'subject-' || n, 'planned', $2, 2000, 0.1, 2200, t, t, t + interval '1 second',
              'request_start', 'posts.page', '{}'::jsonb, 'response', case when n % 720 = 0 then 429 else 200 end,
              case when n % 3 = 0 then 'subject_failure' end
         from generate_series(1, 21600) n, lateral (select $3::timestamptz - n * interval '2 minutes') s(t)
        where t < $3::timestamptz - interval '2 hours'`,
      [pageId, generation.toString(), new Date(now)],
    );
    await query("analyze sync_attempts");

    // Every 429 of the journal is older than the bound: the ladder has reset.
    const read = await captureStatement(() => lastRateLimitAt(db(), { pageId, withinMs }));
    expect(read.result).toBeNull();
    expect(await heapVisits(read, "sync_attempts")).toBeLessThan(50);

    const failed = await captureStatement(() => countRecentFailedSubjects(db(), { pageId, file: "posts", windowMs: 600_000 }));
    expect(failed.result).toBe(0);
    expect(await heapVisits(failed, "sync_attempts")).toBeLessThan(50);

    // A 429 inside the bound is the newest one, by its completion.
    const recent = new Date(now - 30 * 60_000);
    const recentId = await insert(false, recent, 429);
    expect((await lastRateLimitAt(db(), { pageId, withinMs }))?.getTime()).toBe(recent.getTime() + 5_000);
    // The outcome being captured does not count, nor does a shadow attempt.
    expect(await lastRateLimitAt(db(), { pageId, withinMs, excludeAttemptId: recentId })).toBeNull();
    await query("delete from sync_attempts where id = $1", [recentId]);
    await insert(true, recent, 429);
    expect(await lastRateLimitAt(db(), { pageId, withinMs })).toBeNull();
    // Admitted just past the bound: forgotten.
    await insert(false, new Date(now - withinMs - 60_000), 429);
    expect(await lastRateLimitAt(db(), { pageId, withinMs })).toBeNull();
  }, 120_000);
});

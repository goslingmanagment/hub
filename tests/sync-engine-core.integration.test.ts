import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
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
  nextOpenWorkDueAt,
  OwnershipLostError,
  paceFloorFromDb,
  pickCredentialsCheck,
  pickPlanned,
  pickUrgent,
  quarantineWork,
  readRouteJournal,
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
  SYNC_CREDENTIALS_CHECK_KEYS,
  SYNC_PACE_AUDIT_LOOKBACK_MS,
  SYNC_ROUTE_JOURNAL_SLACK_MS,
  SYNC_SEND_WINDOW_MS,
  upsertDemand,
  upsertDemands,
  writeSafeRelease,
  type Database,
  type FanslySendHolderIdentity,
  type SyncEngineWorkClass,
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
  options: { evidence?: boolean; slot?: number; nextCyclePos?: number } = {},
): Promise<{ attemptId: number; demandRevision: number }> {
  return inTx(async (tx) => {
    await lockOwnedPage(tx, { pageId, generation, lock: "no_key_update" });
    const running = await markWorkRunning(tx, { workId: work.id, generation });
    if (!running) throw new Error(`work ${work.id} is not open`);
    const { attemptId } = await insertAdmission(tx, {
      pageId,
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
      holds: [],
      owner: { generation: 0n, host: null, releasedAt: null },
    });
    expect((await listSyncPages(db())).map((row) => row.pageId)).toEqual([pageId]);
    expect(await listSyncPages(db(), { modes: ["shadow"] })).toEqual([]);
    expect(await getSyncPage(db(), Number(onlyfans[0]!.id))).toBeNull();
  });

  it("takes a page left in shadow to off and nothing else: no way into shadow, handover or live, none out of them (I17)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("modes");

    // Nothing leaves off: shadow is a mode no lever reaches any more.
    for (const to of ["shadow", "handover", "live"] as const) {
      expect(await setSyncPageMode(db(), { pageId, to, changedBy: "owner" }), `off → ${to}`)
        .toEqual({ kind: "refused", from: "off", to, reason: "transition_not_allowed" });
    }
    expect(await setSyncPageMode(db(), { pageId, to: "off", changedBy: "owner" })).toEqual({ kind: "unchanged", mode: "off" });
    expect((await getSyncPage(db(), pageId))!.mode).toBe("off");

    // A page in handover or live stays there: no lever takes it out.
    for (const from of ["handover", "live"] as const) {
      await query("update sync_pages set mode = $2, legacy_imported_at = clock_timestamp() where page_id = $1", [pageId, from]);
      for (const to of ["off", "shadow", "handover", "live"] as const) {
        expect(await setSyncPageMode(db(), { pageId, to, changedBy: "owner" }), `${from} → ${to}`).toEqual(
          to === from ? { kind: "unchanged", mode: from } : { kind: "refused", from, to, reason: "transition_not_allowed" },
        );
      }
      expect(await getSyncPage(db(), pageId)).toMatchObject({ mode: from });
      expect((await getSyncPage(db(), pageId))!.legacyImportedAt).not.toBeNull();
    }

    // A row left in shadow (the CHECK value stays, forward-only) goes off and
    // nowhere else; off runs no loop, so the change leaves no import mark.
    await query("update sync_pages set mode = 'shadow' where page_id = $1", [pageId]);
    for (const to of ["handover", "live"] as const) {
      expect(await setSyncPageMode(db(), { pageId, to, changedBy: "owner" }))
        .toEqual({ kind: "refused", from: "shadow", to, reason: "transition_not_allowed" });
    }
    expect(await setSyncPageMode(db(), { pageId, to: "off", changedBy: "owner", expectFrom: "live" }))
      .toEqual({ kind: "refused", from: "shadow", to: "off", reason: "expected_mode_mismatch" });
    expect(await setSyncPageMode(db(), { pageId, to: "off", changedBy: "owner" }))
      .toMatchObject({ kind: "changed", from: "shadow", to: "off" });
    expect(await getSyncPage(db(), pageId)).toMatchObject({ mode: "off", modeChangedBy: "owner", legacyImportedAt: null });
    expect(await setSyncPageMode(db(), { pageId, to: "shadow", changedBy: "owner" }))
      .toEqual({ kind: "refused", from: "off", to: "shadow", reason: "transition_not_allowed" });
    expect(await setSyncPageMode(db(), { pageId: 999_999, to: "off", changedBy: "owner" }))
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
  });
});

describe("holds, pauses and overrides", () => {
  it("holds and lifts the page, keeps the start of an ongoing hold, and holds resource files", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("holds");
    const generation = await own(pageId);
    const until = new Date(Date.now() + 120_000);
    const pageHolds = async () => (await getSyncPage(db(), pageId))!.holds.filter((row) => row.scope === "page");
    await setPageHold(db(), { pageId, generation, kind: "network", until, detail: { streak: 3 } });
    const [first] = await pageHolds();
    expect(first).toMatchObject({ scope: "page", key: "", kind: "network", detail: { streak: 3 }, revision: 1 });
    expect(first!.until!.getTime()).toBe(until.getTime());
    // Retaken while in force: the episode keeps its start.
    await setPageHold(db(), { pageId, generation, kind: "network", until: new Date(Date.now() + 240_000), detail: { streak: 4 } });
    const [second] = await pageHolds();
    expect(second).toMatchObject({ kind: "network", detail: { streak: 4 }, revision: 2 });
    expect(second!.since).toEqual(first!.since);
    // A credentials hold is a row of its own beside it, indefinite.
    await setPageHold(db(), { pageId, generation, kind: "auth", until: "infinity", detail: { credentialsGeneration: "g1" } });
    const both = await pageHolds();
    expect(both.map((row) => row.kind)).toEqual(["auth", "network"]);
    // 'infinity': the latest instant a Date holds.
    expect(both[0]!.until!.getTime()).toBe(8.64e15);
    // The other credentials kind replaces it — one credentials hold a page —
    // and keeps the episode's start.
    await setPageHold(db(), { pageId, generation, kind: "identity_mismatch", until: "infinity", detail: { credentialsGeneration: "g2" } });
    const replaced = await pageHolds();
    expect(replaced.map((row) => row.kind)).toEqual(["identity_mismatch", "network"]);
    expect(replaced[0]).toMatchObject({ detail: { credentialsGeneration: "g2" }, since: both[0]!.since });
    await expect(setPageHold(db(), { pageId, generation: generation + 1n, kind: "network", until }))
      .rejects.toBeInstanceOf(OwnershipLostError);
    // Lifting the credentials hold leaves the network hold standing.
    await clearPageHold(db(), { pageId, generation, kinds: ["auth", "identity_mismatch"] });
    expect((await pageHolds()).map((row) => row.kind)).toEqual(["network"]);
    await expect(clearPageHold(db(), { pageId, generation: generation + 1n, kinds: ["network"] }))
      .rejects.toBeInstanceOf(OwnershipLostError);
    // The owner may lift a hold without a generation.
    await clearPageHold(db(), { pageId, kinds: ["network"] });
    expect(await pageHolds()).toEqual([]);
    // A hold taken after one that ended starts a new episode.
    await setPageHold(db(), { pageId, generation, kind: "network", until: new Date(Date.now() - 1_000) });
    const [ended] = await pageHolds();
    await setPageHold(db(), { pageId, generation, kind: "network", until });
    expect((await pageHolds())[0]!.since.getTime()).toBeGreaterThan(ended!.since.getTime());
    await clearPageHold(db(), { pageId, generation, kinds: ["network"] });

    await setNetworkFailureStreak(db(), { pageId, generation, streak: 2 });
    expect((await getSyncPage(db(), pageId))!.networkFailureStreak).toBe(2);

    await setResourceHold(db(), { pageId, generation, file: "media-stats", hold: { until, step: 0 } });
    const [held] = (await getSyncPage(db(), pageId))!.holds;
    expect(held).toMatchObject({ scope: "resource", key: "media-stats", kind: "resource_breaker", ladderStep: 0 });
    expect(held!.until!.getTime()).toBe(until.getTime());
    await setResourceHold(db(), { pageId, generation, file: "media-stats", hold: { until, step: 1 } });
    expect((await getSyncPage(db(), pageId))!.holds).toEqual([expect.objectContaining({ key: "media-stats", ladderStep: 1, since: held!.since })]);
    await setResourceHold(db(), { pageId, generation, file: "media-stats", hold: null });
    expect((await getSyncPage(db(), pageId))!.holds).toEqual([]);
    await expect(setResourceHold(db(), { pageId, file: "Media Stats", hold: null })).rejects.toThrow(/resource file/);
    await expect(setResourceHold(db(), { pageId, generation: generation + 1n, file: "media-stats", hold: { until, step: 1 } }))
      .rejects.toBeInstanceOf(OwnershipLostError);
    expect((await getSyncPage(db(), pageId))!.holds).toEqual([]);
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

      // Different subjects are different keys.
      expect((await upsertDemand(db(), demand(pageId, { subject: "group-2" }))).created).toBe(true);
      expect(await getWorkForStatus(db(), { pageId })).toHaveLength(2);
      expect(await query<{ shadow: boolean }>("select distinct shadow from sync_work where page_id = $1", [pageId]))
        .toEqual([{ shadow: false }]);

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
    const closed = await latestClosedWorkForKey(db(), { pageId, resource: "dm-messages.head", subject: "group-1" });
    expect(closed).toMatchObject({ id: first.id, state: "cancelled", closeReason: "test", failureCount: 2 });
    expect((await query<{ secret_params: string | null }>("select secret_params from sync_work where id = $1", [first.id]))[0]!.secret_params)
      .toBeNull();

    const next = await upsertDemand(db(), demand(pageId));
    expect(next.created).toBe(true);
    const [row] = await getWorkForStatus(db(), { pageId, states: ["open"] });
    expect(row).toMatchObject({ id: next.id, failureCount: 2, lastErrorClass: "subject_failure" });
    expect(row!.breakerUntil!.getTime()).toBe(breakerUntil.getTime());
    // Due when the inherited breaker ends, not before.
    expect(row!.dueAt.getTime()).toBe(breakerUntil.getTime());
  });

  it("never makes a row due before its own breaker ends; a passed coalescing cap gives way to the signal's window (row 362195)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("own-breaker");
    const generation = await own(pageId);
    const DAY = 86_400_000;
    const t0 = Date.now();
    // Row 362195's shape: its first signal's fast window (2 s quiet, 6 s cap)
    // closed four days ago; the eighth failure set the vendor's daily probe
    // 16 h ahead, and the step's due time with it.
    const first = await upsertDemand(db(), demand(pageId, {
      dueAt: new Date(t0 - 4 * DAY + 2_000), coalesceUntil: new Date(t0 - 4 * DAY + 6_000), deadlineAt: new Date(t0 - 4 * DAY + 30_000),
      extendOnSignal: true, demand: { messageIds: ["m1"], reasons: ["ws:message_created"] },
    }));
    expect(await markWorkRunning(db(), { workId: first.id, generation })).toEqual({
      demandRevision: 1, demand: { messageIds: ["m1"], txIds: [], reasons: ["ws:message_created"], overflow: false },
    });
    const breakerUntil = new Date(t0 + 16 * 3_600_000);
    await settleWork(db(), {
      workId: first.id, generation, servedRevision: 1, satisfiesRevision: false,
      nextDueAt: breakerUntil, waitingReason: "blocked_by_vendor", waitingUntil: breakerUntil,
      breaker: { failureCount: 8, breakerUntil, blockedByVendorAt: new Date(t0 - 3 * DAY) }, lastErrorClass: "subject_failure",
    });
    // A new message in the chat: the same fast window.
    const signal = (at: number, messageId: string) => demand(pageId, {
      dueAt: new Date(at + 2_000), coalesceUntil: new Date(at + 6_000), deadlineAt: new Date(at + 30_000),
      extendOnSignal: true, demand: { messageIds: [messageId], reasons: ["ws:message_created"] },
    });
    const s1 = Date.now();
    expect(await upsertDemand(db(), signal(s1, "m2"))).toEqual({ id: first.id, demandRevision: 2, created: false });
    let [row] = await getWorkForStatus(db(), { pageId });
    // Not the four-day-old cap: due when the breaker ends; the window is the signal's.
    expect(row!.dueAt.getTime()).toBe(breakerUntil.getTime());
    expect(row!.coalesceUntil!.getTime()).toBe(s1 + 6_000);
    expect(row!.demand.messageIds).toEqual(["m1", "m2"]);
    // A further signal inside that window moves nothing before the breaker either.
    expect(await upsertDemand(db(), signal(Date.now(), "m3"))).toMatchObject({ id: first.id, demandRevision: 3 });
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row!.dueAt.getTime()).toBe(breakerUntil.getTime());
    expect(row!.coalesceUntil!.getTime()).toBe(s1 + 6_000);
    // Without extension the earlier due time wins — not over the breaker.
    await upsertDemand(db(), demand(pageId, { dueAt: new Date(Date.now() + 1_000) }));
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row!.dueAt.getTime()).toBe(breakerUntil.getTime());
    expect(row!.demandRevision).toBe(4);

    // The actor's pick and its idle wait: not before the breaker ends.
    const picked = async (now?: Date) => (await pickUrgent(db(), { pageId, ...(now === undefined ? {} : { now }) })).map((work) => work.id);
    expect(await picked()).toEqual([]);
    expect(await picked(new Date(breakerUntil.getTime() - 1_000))).toEqual([]);
    expect(await picked(breakerUntil)).toEqual([first.id]);
    expect((await nextOpenWorkDueAt(db(), { pageId }))!.getTime()).toBe(breakerUntil.getTime());
  });

  it("keeps a credentials check due when its demand says, whatever its breaker: the hold's pick runs it regardless", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("credentials-check");
    const generation = await own(pageId);
    const check = (resource: string, overrides: Partial<UpsertDemandInput> = {}) => demand(pageId, { resource, subject: "", ...overrides });
    const breakerUntil = new Date(Date.now() + 3_600_000);
    const failed = { failureCount: 2, breakerUntil, blockedByVendorAt: null };
    const rowOf = async (resource: string) => (await getWorkForStatus(db(), { pageId, resource, states: ["open"] }))[0]!;

    // An `account.identity` with a pasted candidate failed: its breaker an hour ahead.
    const identity = await upsertDemand(db(), check(SYNC_CREDENTIALS_CHECK_KEYS.identity, { secretParams: "candidate-1" }));
    await markWorkRunning(db(), { workId: identity.id, generation });
    await settleWork(db(), {
      workId: identity.id, generation, servedRevision: 1, satisfiesRevision: false,
      nextDueAt: breakerUntil, breaker: failed, lastErrorClass: "subject_failure",
    });
    // A new demand keeps its due time: now, not the breaker's end.
    const now = new Date();
    await upsertDemand(db(), check(SYNC_CREDENTIALS_CHECK_KEYS.identity, { dueAt: now }));
    let row = await rowOf(SYNC_CREDENTIALS_CHECK_KEYS.identity);
    expect(row.breakerUntil!.getTime()).toBe(breakerUntil.getTime());
    expect(row.dueAt.getTime()).toBe(now.getTime());
    expect((await pickCredentialsCheck(db(), { pageId, verify: false }))?.id).toBe(identity.id);

    // A new candidate's row inherits the breaker and is due at once all the same.
    await settleWork(db(), { workId: identity.id, generation, servedRevision: 2, satisfiesRevision: false, close: "cancelled", closeReason: "test" });
    const before = Date.now();
    const next = await upsertDemand(db(), check(SYNC_CREDENTIALS_CHECK_KEYS.identity, { secretParams: "candidate-2", createOnly: true }));
    expect(next.created).toBe(true);
    row = await rowOf(SYNC_CREDENTIALS_CHECK_KEYS.identity);
    expect(row.breakerUntil!.getTime()).toBe(breakerUntil.getTime());
    expect(row.dueAt.getTime()).toBeLessThan(before + 5_000);
    expect((await pickCredentialsCheck(db(), { pageId, verify: false }))?.id).toBe(next.id);
    await settleWork(db(), { workId: next.id, generation, servedRevision: 1, satisfiesRevision: false, close: "cancelled", closeReason: "test" });

    // An `account.verify` that fails while a newer demand came: the newer demand's due time stands.
    const verify = await upsertDemand(db(), check(SYNC_CREDENTIALS_CHECK_KEYS.verify, { dueAt: new Date(Date.now() + 60_000) }));
    await markWorkRunning(db(), { workId: verify.id, generation });
    const asked = new Date();
    await upsertDemand(db(), check(SYNC_CREDENTIALS_CHECK_KEYS.verify, { dueAt: asked }));
    await settleWork(db(), {
      workId: verify.id, generation, servedRevision: 1, satisfiesRevision: false,
      nextDueAt: breakerUntil, breaker: failed, lastErrorClass: "subject_failure",
    });
    row = await rowOf(SYNC_CREDENTIALS_CHECK_KEYS.verify);
    expect(row.dueAt.getTime()).toBe(asked.getTime());
    expect((await pickCredentialsCheck(db(), { pageId, verify: true }))?.id).toBe(verify.id);
    expect(await pickCredentialsCheck(db(), { pageId, verify: false })).toBeNull();
    // Outside a credentials hold, the ordinary urgent pick still waits for the breaker.
    expect(await pickUrgent(db(), { pageId })).toEqual([]);
  });

  it("a passed coalescing cap never delays a runnable row, and a waiting one takes the signal's window", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("closed-window");
    const generation = await own(pageId);
    const t0 = Date.now();
    const signal = (at: number, overrides: Partial<UpsertDemandInput> = {}) => demand(pageId, {
      dueAt: new Date(at + 5_000), coalesceUntil: new Date(at + 20_000), extendOnSignal: true, ...overrides,
    });
    // Runnable since its cap passed a minute ago (it waits for a slot): a
    // signal leaves it due — it still reads at the next slot.
    const due = await upsertDemand(db(), signal(t0 - 80_000, { subject: "due" }));
    expect(await upsertDemand(db(), signal(Date.now(), { subject: "due" }))).toMatchObject({ id: due.id, demandRevision: 2 });
    let [row] = await getWorkForStatus(db(), { pageId, subject: "due" });
    expect(row!.dueAt.getTime()).toBe(t0 - 75_000);
    expect(row!.coalesceUntil!.getTime()).toBe(t0 - 60_000);

    // A step put the row off for an hour after its window closed: a signal
    // opens its own window, so the row is due within its cap (20 s), not at
    // once and not in an hour.
    const waits = await upsertDemand(db(), signal(t0 - 80_000, { subject: "waits" }));
    await markWorkRunning(db(), { workId: waits.id, generation });
    await settleWork(db(), { workId: waits.id, generation, servedRevision: 1, satisfiesRevision: true, nextDueAt: new Date(t0 + 3_600_000) });
    const s1 = Date.now();
    await upsertDemand(db(), signal(s1, { subject: "waits" }));
    [row] = await getWorkForStatus(db(), { pageId, subject: "waits" });
    expect(row!.dueAt.getTime()).toBe(s1 + 20_000);
    expect(row!.coalesceUntil!.getTime()).toBe(s1 + 20_000);
    // Inside the new window a signal moves it as ever: never past the cap.
    await upsertDemand(db(), signal(s1 + 30_000, { subject: "waits" }));
    [row] = await getWorkForStatus(db(), { pageId, subject: "waits" });
    expect(row!.dueAt.getTime()).toBe(s1 + 20_000);
    expect(row!.coalesceUntil!.getTime()).toBe(s1 + 20_000);
  });

  it("creates the registry's polls once, each with a random phase", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("polls");
    const polls = [
      { resource: "subscribers.poll", class: "planned" as const, everyMs: 3_600_000, phase: 0.5 },
      { resource: "account.poll", class: "planned" as const, everyMs: 60_000, phase: 0 },
      { resource: "notifications.forward", class: "planned" as const, everyMs: 1_800_000 },
    ];
    expect(await ensurePollRows(db(), { pageId, polls })).toBe(3);
    expect(await ensurePollRows(db(), { pageId, polls })).toBe(0);
    expect(await ensurePollRows(db(), { pageId, polls: polls.slice(0, 1) })).toBe(0);
    const rows = await getWorkForStatus(db(), { pageId });
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
    await expect(ensurePollRows(db(), { pageId, polls: [{ ...polls[0]!, phase: 1 }] })).rejects.toThrow(/phase/);
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
    await upsertDemand(db(), demand(other, { subject: "a", dueAt: past(5_000) }));
    await upsertDemand(db(), demand(pageId, { subject: "planned", class: "planned", dueAt: past(5_000) }));
    const broken = await upsertDemand(db(), demand(pageId, { subject: "broken", dueAt: past(5_000) }));
    await query("update sync_work set breaker_until = clock_timestamp() + interval '1 hour' where id = $1", [broken.id]);

    const ids = async (filter: Partial<Parameters<typeof pickUrgent>[1]> = {}) =>
      (await pickUrgent(db(), { pageId, ...filter })).map((row) => row.id);
    expect(await ids()).toEqual([b.id, a.id, c.id, d.id]);
    expect(await ids({ limit: 2 })).toEqual([b.id, a.id]);
    expect(await ids({ excludeResources: ["dm-messages.head"] })).toEqual([d.id]);
    expect(await ids({ excludeFiles: ["transactions"] })).toEqual([b.id, a.id, c.id]);
    expect(await ids({ now: new Date(now + 7_200_000) })).toContain(broken.id);
    await expect(pickUrgent(db(), { pageId, excludeFiles: ["no.dots"] })).rejects.toThrow(/resource file/);
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
    await ensurePollRows(db(), { pageId, polls: [{ resource: "subscribers.poll", class: "planned", everyMs: 60_000, phase: 0 }] });

    const served: string[] = [];
    for (let slot = 0; slot < 12; slot++) {
      const picked = await pickPlanned(db(), { pageId });
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
      pageId, excludeResources: ["media-stats.walk", "catalog.vault"],
    });
    expect(paused!.work.resource).toBe("dm-messages.catchup");
    const held = await pickPlanned(db(), { pageId, excludeFiles: ["dm-messages", "catalog"] });
    expect(held!.work.id).toBe(mediaWalk.id);
    expect(await pickPlanned(db(), { pageId, plannedRr: { "media-stats.walk": new Date(0).toISOString() } }))
      .toMatchObject({ level: "round_robin" });
    expect(vaultWalk.created).toBe(true);
  });

  it("never reads a row shadow mode left behind (step 4, S4-23): no pick, no status, and its key opens beside it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("left-behind");
    const past = new Date(Date.now() - 5_000);
    await query(
      `insert into sync_work (page_id, shadow, resource, subject, kind, class, due_at)
       values ($1, true, 'dm-messages.head', 'group-1', 'trigger', 'urgent', $2),
              ($1, true, 'catalog.vault', '', 'goal', 'planned', $2)`,
      [pageId, past],
    );
    expect(await pickUrgent(db(), { pageId })).toEqual([]);
    expect(await pickPlanned(db(), { pageId })).toBeNull();
    expect(await getWorkForStatus(db(), { pageId })).toEqual([]);
    expect(await latestClosedWorkForKey(db(), { pageId, resource: "dm-messages.head", subject: "group-1" })).toBeNull();

    // The same key opens as the engine's own row, and only that one is served.
    const opened = await upsertDemand(db(), demand(pageId, { dueAt: past }));
    expect(opened).toMatchObject({ created: true, demandRevision: 1 });
    expect((await pickUrgent(db(), { pageId })).map((row) => row.id)).toEqual([opened.id]);
    expect((await getWorkForStatus(db(), { pageId })).map((row) => row.id)).toEqual([opened.id]);
    expect(await query<{ n: number }>("select count(*)::int as n from sync_work where page_id = $1 and shadow", [pageId]))
      .toEqual([{ n: 2 }]);
  });
});

describe("sync_work settlement", () => {
  it("closes only when no newer demand arrived during the step; otherwise runs again (I11)", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("settle");
    const generation = await own(pageId);
    const work = await upsertDemand(db(), demand(pageId, { secretParams: "secret" }));
    const running = await markWorkRunning(db(), { workId: work.id, generation });
    expect(running).toMatchObject({ demandRevision: 1 });
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
    expect(again).toMatchObject({ demandRevision: 2 });
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

  it("leaves a row a step failed due when its breaker ends, a demand that came during the step included", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("settle-breaker");
    const generation = await own(pageId);
    const work = await upsertDemand(db(), demand(pageId));
    await markWorkRunning(db(), { workId: work.id, generation });
    // A new event while the read is in flight, then the read fails.
    await upsertDemand(db(), demand(pageId, { dueAt: new Date(Date.now() + 2_000), demand: { messageIds: ["m9"] } }));
    const breakerUntil = new Date(Date.now() + 60_000);
    expect(await settleWork(db(), {
      workId: work.id, generation, servedRevision: 1, satisfiesRevision: false,
      nextDueAt: breakerUntil, waitingReason: "subject_breaker", waitingUntil: breakerUntil,
      breaker: { failureCount: 1, breakerUntil, blockedByVendorAt: null }, lastErrorClass: "subject_failure",
    })).toEqual({ state: "open", demandRevision: 2, appliedRevision: 0 });
    let [row] = await getWorkForStatus(db(), { pageId });
    expect(row!.breakerUntil!.getTime()).toBe(breakerUntil.getTime());
    expect(row!.dueAt.getTime()).toBe(breakerUntil.getTime());

    // The next read answers: the breaker resets, and a newer demand's due time stands again.
    await markWorkRunning(db(), { workId: work.id, generation });
    await upsertDemand(db(), demand(pageId, { dueAt: new Date(Date.now() + 2_000), demand: { messageIds: ["m10"] } }));
    await settleWork(db(), {
      workId: work.id, generation, servedRevision: 2, satisfiesRevision: true, close: "done",
      breaker: { failureCount: 0, breakerUntil: null, blockedByVendorAt: null },
    });
    [row] = await getWorkForStatus(db(), { pageId });
    expect(row).toMatchObject({ state: "open", breakerUntil: null, demandRevision: 3, appliedRevision: 2 });
    expect(await secondsFromNow("sync_work", "due_at", work.id)).toBeLessThan(3);
  });

  it("reschedules a poll, quarantines and locks rows in id order", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("misc");
    const generation = await own(pageId);
    await ensurePollRows(db(), { pageId, polls: [{ resource: "account.poll", class: "planned", everyMs: 3_600_000, phase: 0 }] });
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
    expect((await pickUrgent(db(), { pageId })).map((row) => row.id)).not.toContain(broken.id);
    expect((await getWorkForStatus(db(), { pageId, subject: "broken" }))[0])
      .toMatchObject({ state: "quarantined", waitingReason: "quarantined", lastErrorClass: "contract" });

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
      pageId, workId: work.id, resource: "dm-messages.head", subject: "group-1", class: "urgent", slot: 4,
      ownerGeneration: generation, demandRevision: 1, settingMs: 2_000, jitterU: 0.1, pauseMs: 2_200,
      outcome: "admitted", applyState: "none", evidence: true, sentAt: null,
      request: { path: "/api/v1/message", query: { groupId: "group-1", limit: "25" } },
    });
    const page = await getSyncPage(db(), pageId);
    expect(page!.cyclePos).toBe(5);
    expect(page!.plannedRr).toEqual({});
    expect(page!.lastAdmittedAt).not.toBeNull();
    expect((await getWorkForStatus(db(), { pageId }))[0]).toMatchObject({ state: "running", lastAttemptId: attemptId });

    // A planned admission stamps its key; the row is live, evidence as the caller says.
    const plannedWork = await upsertDemand(db(), demand(pageId, { resource: "catalog.vault", subject: "", kind: "goal", class: "planned" }));
    const plannedAttempt = await admit(pageId, generation, { ...plannedWork, resource: "catalog.vault", subject: "", class: "planned" }, {
      evidence: false, slot: 9, nextCyclePos: 0,
    });
    expect(await getSyncAttempt(db(), plannedAttempt.attemptId)).toMatchObject({ evidence: false, class: "planned" });
    expect(await query<{ shadow: boolean }>("select distinct shadow from sync_attempts where page_id = $1", [pageId]))
      .toEqual([{ shadow: false }]);
    expect(Object.keys((await getSyncPage(db(), pageId))!.plannedRr)).toEqual(["catalog.vault"]);

    // A foreign generation admits nothing: the whole transaction rolls back.
    const third = await upsertDemand(db(), demand(pageId, { subject: "group-3" }));
    const before = await query<{ n: number }>("select count(*)::int as n from sync_attempts");
    await expect(inTx(async (tx) => {
      await markWorkRunning(tx, { workId: third.id, generation });
      await insertAdmission(tx, {
        pageId, workId: third.id, resource: "dm-messages.head", subject: "group-3", class: "urgent", slot: 0,
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

  it("settles a refused attempt without the send facts", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("refused-settle");
    const generation = await own(pageId);
    const work = await upsertDemand(db(), demand(pageId));
    const refused = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject: "group-1", class: "urgent" });
    expect(await settleAttemptWithoutCapture(db(), {
      attemptId: refused.attemptId, outcome: "aborted_before_send", errorClass: "send_deadline_passed",
    })).toBe(true);
    expect(await getSyncAttempt(db(), refused.attemptId)).toMatchObject({
      outcome: "aborted_before_send", errorClass: "send_deadline_passed", sentAt: null, sendMark: null, applyState: "none",
    });
    // Idempotent like the capture, and the page's send facts are untouched.
    expect(await settleAttemptWithoutCapture(db(), { attemptId: refused.attemptId, outcome: "unknown" })).toBe(false);
    expect(await getSyncAttempt(db(), refused.attemptId)).toMatchObject({ outcome: "aborted_before_send" });
    expect((await getSyncPage(db(), pageId))!.lastSendAt).toBeNull();
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

  it("recovers a previous run: unknown sends, due applies, reopened work", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("recover");
    const generation = await own(pageId);
    const make = async (subject: string) => {
      const work = await upsertDemand(db(), demand(pageId, { subject }));
      const admitted = await admit(pageId, generation, { ...work, resource: "dm-messages.head", subject, class: "urgent" });
      return { workId: work.id, attemptId: admitted.attemptId };
    };
    const admitted = await make("admitted");
    const sent = await make("sent");
    await markAttemptSent(db(), { attemptId: sent.attemptId, sentAt: new Date() });
    const captured = await make("captured");
    await captureAttempt(db(), {
      attemptId: captured.attemptId, pageId, outcome: "response", sent: true, sentAt: new Date(), sendMark: "request_start",
      httpStatus: 200, observation: { id: 7, receivedAt: new Date() }, applyState: "captured",
    });
    await markDeferred(db(), { attemptId: captured.attemptId, error: "erasure_busy", retryInMs: 3_600_000 });
    expect((await listUnfinishedAttempts(db(), { pageId, phase: "send" })).map((row) => row.id).sort((x, y) => x - y))
      .toEqual([admitted.attemptId, sent.attemptId]);

    // The run "crashed": its successor is admitted by an operator's confirmation.
    expect(await acquireSyncPageOwnership(db(), { pageId, owner: owner({ host: "after-restart" }) }))
      .toMatchObject({ kind: "unconfirmed" });
    await confirmSyncOwnersStopped(db(), { runningHosts: ["after-restart"], ownHost: "cli", confirmedBy: "test", dryRun: false });
    expect(await own(pageId, owner({ host: "after-restart" }))).toBe(generation + 1n);
    expect(await inTx((tx) => recoverUnfinishedAttempts(tx, { pageId })))
      .toEqual({
        unknown: 2,
        unknownWorkIds: [admitted.workId, sent.workId].sort((x, y) => x - y),
        memorySkipped: 0,
        workReopened: 2,
        appliesDue: 1,
      });
    expect(await getSyncAttempt(db(), admitted.attemptId)).toMatchObject({ outcome: "unknown" });
    expect(await getSyncAttempt(db(), sent.attemptId)).toMatchObject({ outcome: "unknown" });
    expect((await listUnfinishedAttempts(db(), { pageId, phase: "apply", dueOnly: true })).map((row) => row.id))
      .toEqual([captured.attemptId]);
    const states = new Map((await getWorkForStatus(db(), { pageId })).map((row) => [row.id, row.state]));
    expect(states.get(admitted.workId)).toBe("open");
    expect(states.get(sent.workId)).toBe("open");
    expect(states.get(captured.workId)).toBe("running");
    expect(await inTx((tx) => recoverUnfinishedAttempts(tx, { pageId })))
      .toEqual({ unknown: 0, unknownWorkIds: [], memorySkipped: 0, workReopened: 0, appliesDue: 1 });
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
    // A row shadow mode left behind never counts: it was never a send.
    await query(
      `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                  admitted_at, sent_at, send_mark, operation, request, outcome, apply_state)
       values ($1, true, 'dm-messages.head', 'group-1', 'urgent', $2, 2000, 0.1, 2200, clock_timestamp(),
               clock_timestamp() + interval '30 seconds', 'shadow', 'messages.page', '{}'::jsonb, 'shadow', 'skipped')`,
      [pageId, generation.toString()],
    );
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
  });

  it("looks back a bounded span for the previous send, however many rows shadow mode left behind", async (context) => {
    if (!testDb) return context.skip();
    // 30 days of rows shadow mode left (one every 2 min) and no send before
    // the window: the audit never reads them, and its reads stay inside its
    // window and the look-back.
    const pageId = await seedPage("audit-history");
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
      [pageId, true, generation.toString(), since],
    );
    const send = async (at: number, shadow = false): Promise<number> => {
      const rows = await query<{ id: string }>(
        `insert into sync_attempts (${columns}) select ${values} from (select $4::timestamptz) s(t) returning id::text`,
        [pageId, shadow, generation.toString(), new Date(at)],
      );
      return Number(rows[0]!.id);
    };
    const ids = [await send(since.getTime() + 1_000), await send(since.getTime() + 3_100), await send(since.getTime() + 5_300)];
    // One of the rows left behind inside the window: no send, no gap.
    await send(since.getTime() + 2_000, true);
    await query("analyze sync_attempts");

    const audit = await captureStatement(() => listSendsForPaceAudit(db(), { pageId, since }));
    expect(audit.result.map((row) => [row.attemptId, row.gapMs])).toEqual([[ids[0], null], [ids[1], 2_100], [ids[2], 2_200]]);
    expect(await heapVisits(audit, "sync_attempts")).toBeLessThan(50);

    // An earlier send beyond the look-back is no pace violation whatever the
    // setting: the window's first gap stays unknown.
    const earlier = await send(since.getTime() - SYNC_PACE_AUDIT_LOOKBACK_MS - 1);
    expect((await listSendsForPaceAudit(db(), { pageId, since }))[0]).toMatchObject({ attemptId: ids[0], gapMs: null });
    // At the look-back's edge it is the previous send.
    await query("update sync_attempts set sent_at = $2 where id = $1", [earlier, new Date(since.getTime() - SYNC_PACE_AUDIT_LOOKBACK_MS)]);
    expect((await listSendsForPaceAudit(db(), { pageId, since }))[0]).toMatchObject({
      attemptId: ids[0],
      gapMs: SYNC_PACE_AUDIT_LOOKBACK_MS + 1_000,
    });
  }, 120_000);
});

describe("the capture's reads of the journal (under the page row lock)", () => {
  it("count the failed subjects within their window only, however long the journal is", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("failed-subjects-window");
    const generation = await own(pageId);
    const columns = `page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                     admitted_at, sent_at, completed_at, send_mark, operation, request, outcome, http_status`;
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

    const failed = await captureStatement(() => countRecentFailedSubjects(db(), { pageId, file: "posts", windowMs: 600_000 }));
    expect(failed.result).toBe(0);
    expect(await heapVisits(failed, "sync_attempts")).toBeLessThan(50);
  }, 120_000);

  it("reads the route clocks' sends inside their look-back, from both journals, however long they are", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage("route-journal");
    const generation = await own(pageId);
    const withinMs = 40_000;
    const columns = `page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                     admitted_at, sent_at, completed_at, send_mark, operation, request, outcome, http_status`;
    const logColumns = `page_id, guard_token, source, operation, holder_host, holder_pid, holder_role, holder_instance,
                        captured_at, sent_at, completed_at, outcome, lease_until`;
    // 30 days of answers in both journals (one every 2 min), all older than
    // the look-back.
    await query(
      `insert into sync_attempts (${columns})
       select $1, false, 'media-stats.walk', 'subject-' || n, 'planned', $2, 2000, 0.1, 2200, t, t, t + interval '1 second',
              'request_start', 'media.offer_stats', '{}'::jsonb, 'response', 200
         from generate_series(1, 21600) n, lateral (select clock_timestamp() - n * interval '2 minutes') s(t)
        where t < clock_timestamp() - interval '1 hour'`,
      [pageId, generation.toString()],
    );
    await query(
      `insert into fansly_send_log (${logColumns})
       select $1, gen_random_uuid(), 'sync_stream', 'messages', 'w', 1, 'worker', gen_random_uuid(),
              t, t, t + interval '1 second', 'response', t + interval '20 seconds'
         from generate_series(1, 21600) n, lateral (select clock_timestamp() - n * interval '2 minutes') s(t)
        where t < clock_timestamp() - interval '1 hour'`,
      [pageId],
    );
    await query("analyze sync_attempts");
    await query("analyze fansly_send_log");

    const live = { pageId, withinMs };
    const idle = await captureStatement(() => readRouteJournal(db(), live));
    expect(idle.result).toEqual([]);
    expect(await heapVisits(idle, "sync_attempts")).toBeLessThan(50);
    expect(await heapVisits(idle, "fansly_send_log")).toBeLessThan(50);

    const attempt = async (input: { shadow?: boolean; operation: string; admittedAgoMs: number; sentAgoMs: number | null; outcome: string }) => {
      await query(
        `insert into sync_attempts (${columns})
         select $1, $2::boolean, 'x.y', '', 'planned', $3, 2000, 0.1, 2200, a, s, null, null, $4, '{}'::jsonb, $5, null
           from (select clock_timestamp() - $6::double precision * interval '1 millisecond' as a,
                        case when $7::double precision is null then null
                             else clock_timestamp() - $7::double precision * interval '1 millisecond' end as s) t`,
        [pageId, input.shadow ?? false, generation.toString(), input.operation, input.outcome, input.admittedAgoMs, input.sentAgoMs],
      );
    };
    const logged = async (input: { operation: string; capturedAgoMs: number; sentAgoMs: number | null; outcome: string | null; leaseMs?: number }) => {
      await query(
        `insert into fansly_send_log (${logColumns})
         select $1, gen_random_uuid(), 'sync_stream', $2, 'w', 1, 'worker', gen_random_uuid(), c, s,
                case when $4::text is null then null else c + interval '1 second' end, $4,
                c + $6::double precision * interval '1 millisecond'
           from (select clock_timestamp() - $3::double precision * interval '1 millisecond' as c,
                        case when $5::double precision is null then null
                             else clock_timestamp() - $5::double precision * interval '1 millisecond' end as s) t`,
        [pageId, input.operation, input.capturedAgoMs, input.outcome, input.sentAgoMs, input.leaseMs ?? 20_000],
      );
    };
    // The engine: a sent media read, an older one, a refusal and a failure
    // before any byte (nothing sent), and an attempt a dead owner left
    // unknown (counted at admission + the send window).
    await attempt({ operation: "media.offer_stats", admittedAgoMs: 1_500, sentAgoMs: 1_000, outcome: "response" });
    await attempt({ operation: "media.offer_stats", admittedAgoMs: 9_000, sentAgoMs: 8_000, outcome: "response" });
    await attempt({ operation: "messages.page", admittedAgoMs: 500, sentAgoMs: null, outcome: "aborted_before_send" });
    await attempt({ operation: "transactions.page", admittedAgoMs: 500, sentAgoMs: null, outcome: "transport_error" });
    await attempt({ operation: "messaging.groups", admittedAgoMs: 2_000, sentAgoMs: null, outcome: "unknown" });
    // A row shadow mode left behind: never a send, never read.
    await attempt({ shadow: true, operation: "polls", admittedAgoMs: 700, sentAgoMs: 600, outcome: "shadow" });
    // Legacy: a send, a capture whose holder never completed (its lease end),
    // a completion without a send mark, a capture released unsent.
    await logged({ operation: "messages", capturedAgoMs: 3_200, sentAgoMs: 3_000, outcome: "response" });
    await logged({ operation: "followers", capturedAgoMs: 1_000, sentAgoMs: null, outcome: null, leaseMs: 20_000 });
    await logged({ operation: "account_me", capturedAgoMs: 4_000, sentAgoMs: null, outcome: "transport_error" });
    await logged({ operation: "messaging_groups", capturedAgoMs: 500, sentAgoMs: null, outcome: "aborted_before_send" });

    const nowMs = Date.now();
    const read = await captureStatement(() => readRouteJournal(db(), live));
    const byKey = new Map(read.result.map((send) => [`${send.journal}:${send.operation}`, nowMs - send.lastAt.getTime()]));
    expect([...byKey.keys()].sort()).toEqual([
      "engine:media.offer_stats", "engine:messaging.groups",
      "legacy:account_me", "legacy:followers", "legacy:messages",
    ]);
    const near = (key: string, agoMs: number) => {
      expect(Math.abs(byKey.get(key)! - agoMs), key).toBeLessThan(1_000);
    };
    near("engine:media.offer_stats", 1_000);
    near("engine:messaging.groups", 2_000 - SYNC_SEND_WINDOW_MS);
    near("legacy:messages", 3_000);
    near("legacy:followers", 1_000 - 20_000);
    near("legacy:account_me", 3_000);
    expect(await heapVisits(read, "sync_attempts")).toBeLessThan(50);
    expect(await heapVisits(read, "fansly_send_log")).toBeLessThan(50);

    // Past the look-back and its slack: forgotten.
    await query("update sync_attempts set admitted_at = admitted_at - $2::double precision * interval '1 millisecond' where page_id = $1 and admitted_at > clock_timestamp() - interval '1 minute'",
      [pageId, withinMs + SYNC_ROUTE_JOURNAL_SLACK_MS]);
    await query("update fansly_send_log set captured_at = captured_at - $2::double precision * interval '1 millisecond' where page_id = $1 and captured_at > clock_timestamp() - interval '1 minute'",
      [pageId, withinMs + SYNC_ROUTE_JOURNAL_SLACK_MS]);
    expect(await readRouteJournal(db(), live)).toEqual([]);
  }, 120_000);
});

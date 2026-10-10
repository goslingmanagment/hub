import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensurePollRows,
  getSyncPage,
  upsertDemand,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { createEngineRegistry, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS, fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  countRows,
  makeTestActor,
  okResponse,
  RecordingAlerts,
  RecordingMetrics,
  ScriptedLiveTransport,
  seedSyncPage,
  statusResponse,
  waitFor,
} from "./helpers/sync-engine-host.ts";

// The money resources of the Fansly Sync Engine (design §5.6–§5.10) through
// the real actor and commits against a real database: a scripted live
// transport answers each wire route. Pinned: the ledger, rankings, receipts
// and coverage the legacy lanes write land in the apply transaction with the
// observation's lineage; every walk keeps its position in its work row and
// stops on the legacy rule; a page whose ledger has another writer sends
// nothing.

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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function tx(id: string, overrides: Record<string, unknown> = {}) {
  return {
    walletId: "wallet-1",
    transactionId: id,
    accountId: OWN_ID,
    correlationId: null,
    correlationAccountId: null,
    type: 7001,
    destination: 1,
    amount: 10_000,
    destinationTax: 2_000,
    destinationAmount: 8_000,
    newBalance: null,
    newBalance64: 100_000,
    createdAt: Date.now() - HOUR,
    updatedAt: null,
    status: 1,
    senderId: null,
    receiverId: OWN_ID,
    ...overrides,
  };
}

function txPage(data: unknown[], total: number) {
  return { total, data };
}

type Responder = (req: FanslyWireRequest, index: number) => FanslyWireOutcome;

function param(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

/** A registry of every Fansly entry whose standing polls are parked far ahead,
 *  so only the work a test makes due runs. */
async function quietRegistry(pageId: number): Promise<EngineRegistry> {
  const registry = createEngineRegistry(FANSLY_RESOURCE_SPECS);
  const page = await getSyncPage(db(), pageId);
  await ensurePollRows(db(), {
    pageId,
    polls: pollsFor(registry, page!).map((poll) => ({ ...poll, phase: 0.999 })),
  });
  return registry;
}

async function makeDue(
  pageId: number,
  resource: string,
  extra: { subject?: string; params?: unknown; txIds?: string[] } = {},
) {
  const spec = fanslyResourceSpec(resource)!;
  await upsertDemand(db(), {
    pageId,
    resource,
    kind: spec.kind,
    class: spec.class,
    ...(extra.subject === undefined ? {} : { subject: extra.subject }),
    ...(extra.params === undefined ? {} : { params: extra.params }),
    ...(extra.txIds === undefined ? {} : { demand: { txIds: extra.txIds, reasons: ["test"] } }),
  });
}

async function seedPage(options: { accountCreatedAt?: string | null } = {}) {
  const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
  const metadata = options.accountCreatedAt === null ? {} : { accountCreatedAt: options.accountCreatedAt ?? "2026-08-15T00:00:00.000Z" };
  await testDb!.pool.query(
    "update pages set external_page_id = $2, metadata = $3::jsonb, last_verified_at = clock_timestamp() where id = $1",
    [pageId, OWN_ID, JSON.stringify(metadata)],
  );
  return pageId;
}

async function runLive(
  pageId: number,
  respond: Responder,
  until: () => Promise<boolean>,
  options: {
    alerts?: RecordingAlerts;
    metrics?: RecordingMetrics;
    registry?: EngineRegistry;
    settingMs?: number;
    /** Runs while a request is in flight (after admission, before its apply). */
    onHit?: (req: FanslyWireRequest, index: number) => Promise<void>;
  } = {},
) {
  const registry = options.registry ?? await quietRegistry(pageId);
  const transport = new ScriptedLiveTransport();
  const requests: FanslyWireRequest[] = [];
  transport.respond = (req, index) => {
    requests.push(req);
    return respond(req, index);
  };
  if (options.onHit !== undefined) {
    const onHit = options.onHit;
    transport.onHit = (req) => onHit(req, transport.hits.length - 1);
  }
  const alerts = options.alerts ?? new RecordingAlerts();
  const metrics = options.metrics ?? new RecordingMetrics();
  const { actor, stop, abort } = await makeTestActor({
    db: db(),
    pageId,
    registry,
    alerts,
    metrics,
    ...(options.settingMs === undefined ? {} : { settingMs: options.settingMs }),
    transport,
  });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 30_000, "the work to settle");
  } finally {
    stop.abort();
    await run;
  }
  return { hits: transport.hits.map((hit) => hit.spec), requests, alerts, metrics };
}

async function workRow(pageId: number, resource: string, options: { subject?: string } = {}) {
  const result = await testDb!.pool.query<{
    state: string; cursor: Record<string, unknown>; proof: Record<string, unknown> | null; result: Record<string, unknown> | null;
    waiting_reason: string | null; due_at: Date; params: Record<string, unknown>; close_reason: string | null; subject: string;
  }>(
    `select state, cursor, proof, result, waiting_reason, due_at, params, close_reason, subject from sync_work
      where page_id = $1 and resource = $2 and not shadow and ($3::text is null or subject = $3)
      order by id desc limit 1`,
    [pageId, resource, options.subject ?? null],
  );
  return result.rows[0] ?? null;
}

async function workRows(pageId: number, resource: string) {
  const result = await testDb!.pool.query<{ subject: string; state: string; params: Record<string, unknown> }>(
    "select subject, state, params from sync_work where page_id = $1 and resource = $2 and not shadow order by subject",
    [pageId, resource],
  );
  return result.rows;
}

async function attempts(pageId: number, resource: string, applyState = "applied"): Promise<number> {
  return countRows(testDb!.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = $3",
    [pageId, resource, applyState]);
}

async function ledger(pageId: number) {
  const result = await testDb!.pool.query<{
    id: string; gross: string; net: string; state: string; raw_status: string; observation: boolean; fan: boolean;
  }>(
    `select transaction_id as id, gross_amount_mills::text as gross, creator_net_amount_mills::text as net,
            transaction_state::text as state, raw_status, source_observation_id is not null as observation, fan_id is not null as fan
       from transactions where platform_account_id = $1 order by transaction_id`,
    [pageId],
  );
  return result.rows;
}

describe("transactions", () => {
  it("insurance: writes the page with its observation, ensures the fans and asks for lookups, targets and the roster", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "transactions.insurance");
    const fan = { correlationAccountId: "500000000000000001", senderId: "500000000000000001" };
    const served = [
      tx("tx-3", { ...fan, type: 2110, correlationId: "880000000000000001", amount: 5_000, destinationAmount: 5_000, destinationTax: null }),
      tx("tx-2", fan),
      tx("tx-1", { ...fan, status: 2, createdAt: Date.now() - 2 * HOUR }),
    ];
    // A 2 s setting keeps the follow-ups the apply asks for ≥ 2 s behind the
    // step, so the actor stops before any of them is sent.
    const { hits, requests } = await runLive(pageId, (req) => {
      if (req.spec === "transactions.page") return okResponse(txPage(served, 3));
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await attempts(pageId, "transactions.insurance")) === 1, { settingMs: 2_000 });

    expect(hits).toEqual(["transactions.page"]);
    expect(param(requests[0]!, "limit")).toBe("20");
    expect(param(requests[0]!, "offset")).toBe("0");
    // Net-only rows derive the gross from the page's commission (0 here).
    expect(await ledger(pageId)).toEqual([
      { id: "tx-1", gross: "10000", net: "8000", state: "posted", raw_status: "2", observation: true, fan: true },
      { id: "tx-2", gross: "10000", net: "8000", state: "pending", raw_status: "1", observation: true, fan: true },
      { id: "tx-3", gross: "5000", net: "5000", state: "pending", raw_status: "1", observation: true, fan: true },
    ]);
    const observation = await testDb.pool.query("select kind, producer from observations where account_id = $1", [pageId]);
    expect(observation.rows).toEqual([{ kind: "earnings_transactions", producer: "fansly-sync:transactions.insurance" }]);
    // The projections rebuilt in the same apply.
    expect(await countRows(testDb.pool, "select count(*)::int as n from revenue_daily where platform_account_id = $1", [pageId])).toBeGreaterThan(0);
    // The poll stays the page's standing row; the short page ended the walk.
    const poll = await workRow(pageId, "transactions.insurance");
    expect(poll).toMatchObject({ state: "open", proof: { stop: "end", pages: 1, fetched: 3 } });
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(3 * 60_000);
    // Follow-ups: the fan's profile, the PPV order history, the dirty roster.
    expect((await workRow(pageId, "fan-profiles.lookup"))!.params).toEqual({ ids: ["500000000000000001"] });
    expect(await workRows(pageId, "purchases.targets")).toEqual([
      { subject: "media:880000000000000001", state: "open", params: { target: { kind: "media", id: "880000000000000001" } } },
    ]);
    expect(await workRow(pageId, "fan-earnings.roster")).not.toBeNull();
    const dirty = await testDb.pool.query(
      "select plane, refresh_class from subject_refresh_state where page_id = $1 and subject_ref = '500000000000000001' order by plane",
      [pageId],
    );
    expect(dirty.rows).toEqual([
      { plane: "fan_earnings_lifetime", refresh_class: "dirty" },
      { plane: "fan_earnings_monthly", refresh_class: "dirty" },
    ]);
  });

  it("head: walks pages of 20 until a known, unchanged row once every demanded id was served", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const known = tx("tx-known", { status: 2, createdAt: Date.now() - 3 * DAY });
    await makeDue(pageId, "transactions.backfill");
    await runLive(pageId, () => okResponse(txPage([known], 1)), async () => (await workRow(pageId, "transactions.backfill"))?.state === "done");

    const fresh = Array.from({ length: 20 }, (_, index) => tx(`tx-new-${String(index).padStart(2, "0")}`, { createdAt: Date.now() - index * 1_000 }));
    const second = [tx("tx-demanded", { createdAt: Date.now() - 2 * DAY }), known];
    await makeDue(pageId, "transactions.head", { txIds: ["tx-demanded"] });
    const { requests } = await runLive(pageId, (req) => {
      const offset = param(req, "offset");
      if (offset === "0") return okResponse(txPage(fresh, 22));
      if (offset === "20") return okResponse(txPage(second, 22));
      throw new Error(`unexpected offset ${offset}`);
    }, async () => (await workRow(pageId, "transactions.head"))?.state === "done");

    expect(requests.map((req) => param(req, "offset"))).toEqual(["0", "20"]);
    const head = await workRow(pageId, "transactions.head");
    expect(head).toMatchObject({ close_reason: "known_item", proof: { stop: "known_item", pages: 2, fetched: 22 } });
    expect(await countRows(testDb.pool, "select count(*)::int as n from transactions where platform_account_id = $1", [pageId])).toBe(22);
  });

  it("head: a walk that reaches offset 200 hands over to the rescan", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "transactions.head");
    const { requests, metrics } = await runLive(pageId, (req) => {
      const offset = Number(param(req, "offset"));
      return okResponse(txPage(Array.from({ length: 20 }, (_, index) => tx(`tx-${offset + index}`)), 500));
    }, async () => (await workRow(pageId, "transactions.head"))?.state === "done");

    // Ten head pages (offsets 0 … 180); the rescan it hands over to reads 100.
    expect(requests.filter((req) => param(req, "limit") === "20")).toHaveLength(10);
    expect(await workRow(pageId, "transactions.head")).toMatchObject({ close_reason: "escalated", proof: { stop: "escalated", pages: 10 } });
    const rescan = await testDb.pool.query("select demand -> 'reasons' as reasons from sync_work where page_id = $1 and resource = 'transactions.rescan'", [pageId]);
    expect(rescan.rows[0].reasons).toContain("escalated:transactions.head");
    expect(metrics.get("sync_apply_effect")).toBeGreaterThan(0);
  });

  it("a page whose ledger has another writer sends nothing; its transactions work waits", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await testDb.pool.query("update pages set transactions_writer = null where id = $1", [pageId]);
    await makeDue(pageId, "transactions.insurance");
    const { hits } = await runLive(pageId, () => okResponse(txPage([], 0)),
      async () => (await workRow(pageId, "transactions.insurance"))?.waiting_reason === "dependency");
    expect(hits).toEqual([]);
    const poll = await workRow(pageId, "transactions.insurance");
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
  });

  it("rescan: the window from the checkpoint, early-stopped on the page below it, then the new checkpoint", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const checkpoint = Date.now() - 2 * DAY;
    await makeDue(pageId, "transactions.backfill");
    await runLive(pageId, () => okResponse(txPage([tx("tx-old", { status: 2, createdAt: checkpoint })], 1)),
      async () => (await workRow(pageId, "transactions.backfill"))?.state === "done");

    // 100 rows inside the window, then a page reaching below it (> 9 days).
    const inWindow = Array.from({ length: 100 }, (_, index) => tx(`tx-w-${String(index).padStart(3, "0")}`, { createdAt: Date.now() - (index + 1) * 60_000 }));
    const below = [tx("tx-below", { createdAt: checkpoint - 10 * DAY }), ...Array.from({ length: 99 }, (_, index) => tx(`tx-b-${index}`, { createdAt: checkpoint - 11 * DAY }))];
    await makeDue(pageId, "transactions.rescan");
    const { requests } = await runLive(pageId, (req) => {
      const offset = param(req, "offset");
      if (offset === "0") return okResponse(txPage(inWindow, 500));
      if (offset === "100") return okResponse(txPage(below, 500));
      throw new Error(`unexpected offset ${offset}`);
    }, async () => (await attempts(pageId, "transactions.rescan")) === 2);

    expect(requests.map((req) => [param(req, "limit"), param(req, "offset")])).toEqual([["100", "0"], ["100", "100"]]);
    const rescan = await workRow(pageId, "transactions.rescan");
    expect(rescan).toMatchObject({ state: "open", proof: { earlyStopped: true, pages: 2, fetched: 200, total: 500 } });
    expect(Date.parse(rescan!.cursor.cursorTimestamp as string)).toBe(inWindow[0]!.createdAt);
    // The lower bound reached back 7 days from the checkpoint.
    expect(Date.parse(rescan!.proof!.after as string)).toBe(checkpoint - 7 * DAY);
  });

  it("rescan: a total that moves under the walk restarts it; the page is not written", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "transactions.backfill");
    await runLive(pageId, () => okResponse(txPage([tx("tx-seed", { status: 2 })], 1)),
      async () => (await workRow(pageId, "transactions.backfill"))?.state === "done");
    await makeDue(pageId, "transactions.rescan");
    const first = Array.from({ length: 100 }, (_, index) => tx(`tx-f-${index}`));
    await runLive(pageId, (req) => (param(req, "offset") === "0"
      ? okResponse(txPage(first, 150))
      : okResponse(txPage([tx("tx-late")], 151))),
    async () => (await attempts(pageId, "transactions.rescan")) === 2);

    const rescan = await workRow(pageId, "transactions.rescan");
    expect(rescan!.cursor).toMatchObject({ walk: null, restartCount: 1 });
    expect(rescan!.result).toMatchObject({ restartReason: "total_changed" });
    expect(rescan!.due_at.getTime() - Date.now()).toBeGreaterThan(45_000);
    expect(await countRows(testDb.pool, "select count(*)::int as n from transactions where transaction_id = 'tx-late'")).toBe(0);
  });

  it("rescan: past the restart bound a withheld round keeps the last certified proof", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const seed = tx("tx-seed", { status: 2, createdAt: Date.now() - DAY });
    await makeDue(pageId, "transactions.backfill");
    await runLive(pageId, () => okResponse(txPage([seed], 1)), async () => (await workRow(pageId, "transactions.backfill"))?.state === "done");
    // A certified round: the whole (one-row) list, its receipt the row's proof.
    await makeDue(pageId, "transactions.rescan");
    await runLive(pageId, () => okResponse(txPage([seed], 1)), async () => (await attempts(pageId, "transactions.rescan")) === 1);
    const certified = (await workRow(pageId, "transactions.rescan"))!.proof;
    expect(certified).toMatchObject({ fetched: 1, total: 1, ledgerRows: 1 });
    expect(certified).toHaveProperty("walkStartedAt");

    // Three rounds that fetch fewer rows than the stated total: two restarts,
    // then the round closes withheld.
    for (let round = 2; round <= 4; round += 1) {
      await makeDue(pageId, "transactions.rescan");
      await runLive(pageId, () => okResponse(txPage([seed], 5)), async () => (await attempts(pageId, "transactions.rescan")) === round);
    }
    const rescan = (await workRow(pageId, "transactions.rescan"))!;
    expect(rescan.state).toBe("open");
    expect(rescan.result).toEqual({ withheld: "total_mismatch", pages: 1, fetched: 1, total: 5 });
    expect(rescan.cursor).toMatchObject({ walk: null, restartCount: 0, last: rescan.result });
    // The receipt went to `result` alone: the proof is the certified round's.
    expect(rescan.proof).toEqual(certified);
  });

  it("backfill: the whole list in pages of 100, fetched equal to total", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "transactions.backfill");
    const rows = Array.from({ length: 150 }, (_, index) => tx(`tx-${String(index).padStart(3, "0")}`, { createdAt: Date.now() - (index + 1) * 60_000 }));
    await runLive(pageId, (req) => {
      const offset = Number(param(req, "offset"));
      return okResponse(txPage(rows.slice(offset, offset + 100), 150));
    }, async () => (await workRow(pageId, "transactions.backfill"))?.state === "done");

    expect(await workRow(pageId, "transactions.backfill")).toMatchObject({
      close_reason: "backfill_complete", proof: { pages: 2, fetched: 150, total: 150 },
    });
    expect(await countRows(testDb.pool, "select count(*)::int as n from transactions where platform_account_id = $1", [pageId])).toBe(150);
  });

  it("an item that fails the contract quarantines the step and writes nothing", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "transactions.insurance");
    const alerts = new RecordingAlerts();
    await runLive(pageId, () => okResponse(txPage([tx("tx-bad", { amount: 10.5 })], 1)),
      async () => (await workRow(pageId, "transactions.insurance"))?.state === "quarantined", { alerts });
    expect(await ledger(pageId)).toEqual([]);
    expect(await attempts(pageId, "transactions.insurance", "quarantined")).toBe(1);
    expect(alerts.opened.map((alert) => alert.detail)).toContain("quarantined");
  });
});

describe("fan-earnings.roster", () => {
  async function seedSpender(pageId: number, fanRef: string) {
    const [fan] = await upsertFans(db(), [{ platform: "fansly", platformUserId: fanRef }]);
    await testDb!.pool.query(
      `insert into page_fans (platform_account_id, fan_id, total_creator_net_mills) values ($1, $2, 5000)
       on conflict (platform_account_id, fan_id) do update set total_creator_net_mills = 5000`,
      [pageId, fan!.id],
    );
  }

  async function subjects(pageId: number) {
    const result = await testDb!.pool.query<{
      plane: string; outcome: string | null; claimed: boolean; failures: number; due: Date | null; visited: boolean; fingerprint: boolean;
    }>(
      `select plane, last_refresh_outcome as outcome, claim_token is not null as claimed, consecutive_failures as failures,
              next_due_at as due, last_visited_at is not null as visited, last_content_fingerprint is not null as fingerprint
         from subject_refresh_state where page_id = $1 and plane like 'fan_earnings_%' order by plane, subject_ref`,
      [pageId],
    );
    return result.rows;
  }

  it("reads each never-read spender's two endpoints under a claim, settles the receipts, then closes", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const fanRef = "500000000000000007";
    await seedSpender(pageId, fanRef);
    await makeDue(pageId, "fan-earnings.roster");
    const row = { correlationAccountId: fanRef, type: 7001, totalGross: 1_000, totalNet: 800 };
    const { hits, requests } = await runLive(pageId, (req) => {
      if (req.spec === "earnings.stats_accounts") return okResponse([row]);
      if (req.spec === "earnings.monthly_accounts") return okResponse([{ ...row, year: 2026, month: 9 }]);
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await workRow(pageId, "fan-earnings.roster"))?.state === "done");

    expect(hits.sort()).toEqual(["earnings.monthly_accounts", "earnings.stats_accounts"]);
    for (const req of requests) {
      expect(param(req, "correlationAccountId")).toBe(fanRef);
      expect(param(req, "after")).toBe("0");
    }
    expect(await subjects(pageId)).toEqual([
      { plane: "fan_earnings_lifetime", outcome: "observed", claimed: false, failures: 0, due: null, visited: true, fingerprint: true },
      { plane: "fan_earnings_monthly", outcome: "observed", claimed: false, failures: 0, due: null, visited: true, fingerprint: true },
    ]);
    expect(await workRow(pageId, "fan-earnings.roster")).toMatchObject({ close_reason: "roster_fresh" });
    const kinds = await testDb.pool.query("select kind from observations where account_id = $1 order by id", [pageId]);
    expect(kinds.rows.map((r) => r.kind).sort()).toEqual(["fan_earnings_monthly", "fan_earnings_stats"]);
  });

  it("a 404 is the subject's answer for now; a 5xx climbs its breaker; the walk goes on", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const fanRef = "500000000000000008";
    await seedSpender(pageId, fanRef);
    await makeDue(pageId, "fan-earnings.roster");
    const { hits } = await runLive(pageId, (req) => (req.spec === "earnings.stats_accounts"
      ? statusResponse(404, { success: false, error: { code: 404 } })
      : statusResponse(500, { success: false })),
    async () => (await workRow(pageId, "fan-earnings.roster"))?.state === "done");

    expect(hits).toHaveLength(2);
    const [lifetime, monthly] = await subjects(pageId);
    expect(lifetime).toMatchObject({ plane: "fan_earnings_lifetime", outcome: "rejected", claimed: false, due: null });
    expect(monthly).toMatchObject({ plane: "fan_earnings_monthly", outcome: "failed", claimed: false, failures: 1 });
    expect(monthly!.due!.getTime() - Date.now()).toBeGreaterThan(30_000);
    expect(monthly!.due!.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
  });
});

describe("purchases.targets", () => {
  function order(orderId: string, buyer: string) {
    return { orderId, accountId: buyer, accountMediaId: "880000000000000002", createdAt: Math.floor(Date.now() / 1000) - 60, type: 1 };
  }

  it("walks one target to an empty page, then re-reads it from its head only until a known order", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const subject = "media:880000000000000002";
    await makeDue(pageId, "purchases.targets", { subject });
    const { requests } = await runLive(pageId, (req) => (param(req, "before") === null
      ? okResponse({ accountMediaOrderHistory: [order("9002", "500000000000000011"), order("9001", "500000000000000012")] })
      : okResponse({ accountMediaOrderHistory: [] })),
    async () => (await workRow(pageId, "purchases.targets", { subject }))?.state === "done");

    expect(requests.map((req) => [param(req, "accountMediaId"), param(req, "before"), param(req, "limit")])).toEqual([
      ["880000000000000002", null, "100"],
      ["880000000000000002", "9001", "100"],
    ]);
    expect(await workRow(pageId, "purchases.targets", { subject })).toMatchObject({
      close_reason: "empty_page", proof: { stop: "empty_page", pages: 2, orders: 2, headOrderIds: ["9002", "9001"] },
    });
    // The request parameters are coverage evidence (design §2.9).
    expect(await countRows(testDb.pool, "select count(*)::int as n from sync_attempts where page_id = $1 and resource = 'purchases.targets' and evidence", [pageId])).toBe(2);

    // A new order: the head page holds an order the last walk saw ⇒ one read.
    await makeDue(pageId, "purchases.targets", { subject });
    const reread = await runLive(pageId, () => okResponse({ accountMediaOrderHistory: [order("9003", "500000000000000013"), order("9002", "500000000000000011")] }),
      async () => (await countRows(testDb!.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource = 'purchases.targets' and state = 'done'", [pageId])) === 2);
    expect(reread.requests).toHaveLength(1);
    expect(await workRow(pageId, "purchases.targets", { subject })).toMatchObject({ close_reason: "known_order", proof: { headOrderIds: ["9003", "9002"] } });
  });

  const doneTargets = (pageId: number) => countRows(testDb!.pool,
    "select count(*)::int as n from sync_work where page_id = $1 and resource = 'purchases.targets' and state = 'done'", [pageId]);
  const orderPage = (ids: string[]) => okResponse({ accountMediaOrderHistory: ids.map((id, index) => order(id, `5000000000000000${20 + index}`)) });

  it("a sale signalled while the stopping page is in flight re-reads the head, never the older history", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const subject = "media:880000000000000002";
    await makeDue(pageId, "purchases.targets", { subject });
    await runLive(pageId, (req) => orderPage(param(req, "before") === null ? ["9002", "9001"] : []),
      async () => (await doneTargets(pageId)) === 1);

    // A sale reopens the target; while its head page is in flight a second
    // sale bumps the row. The head holds a known order, so the walk would
    // close — but the newer demand keeps the row open.
    await makeDue(pageId, "purchases.targets", { subject });
    const { requests } = await runLive(pageId, (req, index) => (param(req, "before") !== null
      ? orderPage([])
      : orderPage(index === 0 ? ["9003", "9002"] : ["9004", "9003", "9002"])),
    async () => (await doneTargets(pageId)) === 2,
    { onHit: async (_req, index) => {
      if (index === 0) await makeDue(pageId, "purchases.targets", { subject });
    } });

    // The reopened row reads the head again (no `before`) and stops on the
    // head it saw; the older history is not walked.
    expect(requests.map((req) => param(req, "before"))).toEqual([null, null]);
    expect(await workRow(pageId, "purchases.targets", { subject })).toMatchObject({
      state: "done", close_reason: "known_order", proof: { stop: "known_order", pages: 1, headOrderIds: ["9004", "9003", "9002"] },
    });
  });

  it("a sale signalled after the head was read re-reads the head before the walk closes", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    const subject = "media:880000000000000002";
    await makeDue(pageId, "purchases.targets", { subject });
    const metrics = new RecordingMetrics();
    // The head is read at revision 1; a sale bumps the row while it is in
    // flight, so the next (older) page is admitted at revision 2.
    const { requests } = await runLive(pageId, (req, index) => (param(req, "before") !== null
      ? orderPage([])
      : orderPage(index === 0 ? ["9002", "9001"] : ["9003", "9002", "9001"])),
    async () => (await doneTargets(pageId)) === 1,
    {
      metrics,
      onHit: async (_req, index) => {
        if (index === 0) await makeDue(pageId, "purchases.targets", { subject });
      },
    });

    // The empty page does not close the walk: the new order is newer than its
    // head. The head is read again and the walk stops on the head it saw.
    expect(requests.map((req) => param(req, "before"))).toEqual([null, "9001", null]);
    expect(await workRow(pageId, "purchases.targets", { subject })).toMatchObject({
      state: "done", close_reason: "known_order", proof: { pages: 1, headOrderIds: ["9003", "9002", "9001"] },
    });
  });

  it("a 404 closes the target with its answer; contract drift quarantines it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "purchases.targets", { subject: "bundle:770000000000000001" });
    await makeDue(pageId, "purchases.targets", { subject: "media:770000000000000002" });
    const { requests } = await runLive(pageId, (req) => (param(req, "accountMediaBundleId") !== null
      ? statusResponse(404, { success: false })
      : okResponse({ unexpected: true })),
    async () => (await countRows(testDb!.pool, "select count(*)::int as n from sync_work where page_id = $1 and resource = 'purchases.targets' and state in ('done', 'quarantined')", [pageId])) === 2);

    expect(requests).toHaveLength(2);
    expect(await workRow(pageId, "purchases.targets", { subject: "bundle:770000000000000001" })).toMatchObject({ state: "done", close_reason: "subject_terminal:404" });
    expect(await workRow(pageId, "purchases.targets", { subject: "media:770000000000000002" })).toMatchObject({ state: "quarantined" });
  });
});

describe("top-spenders", () => {
  function spender(fan: string, gross: number) {
    return { totalGross: gross, totalNet: gross - 200, accountId: OWN_ID, correlationAccountId: fan };
  }

  it("window: the trailing 7 days into the rankings; a capped answer splits into days", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "top-spenders.window");
    const capped = Array.from({ length: 100 }, (_, index) => spender(`5100000000000${String(index).padStart(5, "0")}`, 1_000 + index));
    const { requests } = await runLive(pageId, (req) => {
      const after = Number(param(req, "after"));
      const before = Number(param(req, "before"));
      return before - after > 2 * DAY ? okResponse(capped) : okResponse([spender("520000000000000001", 9_000)]);
    }, async () => (await workRow(pageId, "top-spenders.window"))?.proof !== null);

    expect(requests).toHaveLength(8);
    const spans = requests.map((req) => Number(param(req, "before")) - Number(param(req, "after")));
    expect(spans[0]).toBe(7 * DAY);
    expect(spans.slice(1).every((span) => span <= DAY)).toBe(true);
    const rankings = await testDb.pool.query<{ key: string; gross: string; fan: boolean }>(
      "select source_identity_key as key, gross_amount_mills::text as gross, fan_id is not null as fan from page_fan_identities where platform_account_id = $1",
      [pageId],
    );
    expect(rankings.rows).toEqual([{ key: "fan:520000000000000001", gross: "9000", fan: true }]);
    const poll = await workRow(pageId, "top-spenders.window");
    expect(poll).toMatchObject({ state: "open", cursor: { pending: [] } });
    expect(poll!.due_at.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
  });

  it("bootstrap waits for the account's creation date and makes account.poll due", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage({ accountCreatedAt: null });
    await testDb.pool.query("update pages set last_verified_at = null where id = $1", [pageId]);
    await makeDue(pageId, "top-spenders.bootstrap");
    const { hits } = await runLive(pageId, (req) => {
      if (req.spec === "account.me") {
        return okResponse({
          account: {
            id: OWN_ID, username: "model", displayName: "Model", createdAt: Date.UTC(2026, 8, 20), followCount: 0,
            subscriberCount: 0, earningsWallet: { id: "wallet", balance: 0 }, walls: [], subscriptionTiers: [],
          },
        });
      }
      throw new Error(`unexpected ${req.spec}`);
    }, async () => (await attempts(pageId, "account.poll")) === 1);
    expect(hits).toEqual(["account.me"]);
    expect(await workRow(pageId, "top-spenders.bootstrap")).toMatchObject({ state: "open", waiting_reason: "dependency" });
  });
});

describe("payouts", () => {
  function payout(id: number, createdAt: number) {
    return { id: String(id), accountId: OWN_ID, amount: 100_000, payoutMethodId: "9001", status: 8, createdAt, updatedAt: createdAt, version: 1 };
  }

  async function coverage(pageId: number) {
    const result = await testDb!.pool.query<{ scope: string; status: string; proof: string; reason: string | null; observation: boolean }>(
      `select scope_ref as scope, status, proof, reason_code as reason, proof_observation_id is not null as observation
         from capture_coverage where page_id = $1 and plane = 'payouts' order by scope_ref`,
      [pageId],
    );
    return result.rows;
  }

  it("daily: the method listing, the head, then the first history walk to the floor", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await makeDue(pageId, "payouts.daily");
    const rows = Array.from({ length: 15 }, (_, index) => payout(1_000 - index, Date.UTC(2026, 6, 1) + index * DAY));
    const { requests } = await runLive(pageId, (req) => {
      if (req.spec === "payouts.methods") return okResponse([{ id: "9001", providerId: "2", status: 3, metadata: "{}" }]);
      const offset = Number(param(req, "offset"));
      return okResponse({ total: 15, data: rows.slice(offset, offset + 10) });
    }, async () => (await workRow(pageId, "payouts.walk"))?.state === "done");

    expect(requests.map((req) => [req.spec, param(req, "offset"), param(req, "limit"), param(req, "before")])).toEqual([
      ["payouts.methods", null, null, null],
      ["payouts.requests", "0", "10", ""],
      ["payouts.requests", "10", "10", ""],
    ]);
    expect(await coverage(pageId)).toEqual([
      { scope: "payout_methods", status: "provider_exhausted", proof: "terminal_response", reason: "full_listing", observation: true },
      { scope: "payout_requests", status: "provider_exhausted", proof: "terminal_response", reason: "walk_exhausted", observation: true },
    ]);
    const daily = await workRow(pageId, "payouts.daily");
    expect(daily).toMatchObject({ state: "open", cursor: { step: 0, walkTotal: 15 } });
    expect((daily!.cursor.headRefs as string[])).toHaveLength(10);
  });

  it("daily: a full head that shares no row with the previous head opens a catch-up walk", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await seedPage();
    await testDb.pool.query(
      `insert into capture_coverage (page_id, platform, plane, scope_ref, status, acquisition_mode, proof, reason_code)
       values ($1, 'fansly', 'payouts', 'payout_requests', 'provider_exhausted', 'retroactive', 'none', 'walk_exhausted')`,
      [pageId],
    );
    await makeDue(pageId, "payouts.daily");
    await testDb.pool.query(
      "update sync_work set cursor = $2::jsonb where page_id = $1 and resource = 'payouts.daily'",
      [pageId, JSON.stringify({ step: 1, headRefs: ["500"], walkTotal: 20, unknownStatusCodes: [] })],
    );
    const fresh = Array.from({ length: 25 }, (_, index) => payout(900 - index, Date.UTC(2026, 8, 1) + index));
    const { requests } = await runLive(pageId, (req) => {
      const offset = Number(param(req, "offset"));
      if (offset === 20) return okResponse({ total: 45, data: [...fresh.slice(20, 25), payout(500, 1), ...fresh.slice(0, 4)] });
      return okResponse({ total: 45, data: fresh.slice(offset, offset + 10) });
    }, async () => (await workRow(pageId, "payouts.walk"))?.state === "done");

    expect(requests.map((req) => param(req, "offset"))).toEqual(["0", "10", "20"]);
    expect(await workRow(pageId, "payouts.walk")).toMatchObject({ close_reason: "exhausted" });
    expect((await coverage(pageId)).find((row) => row.scope === "payout_requests")).toMatchObject({ status: "provider_exhausted" });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createLiveSyncPage,
  createModel,
  ensurePollRows,
  getSyncPage,
  readSyncJournalAlertFacts,
  upsertDemand,
  upsertDemands,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { collectPageAlerts } from "../apps/runtime/src/sync/engine/alerts.ts";
import { demandToUpsert, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, fanslyNewPageKeys, fanslyNewPageWork } from "../apps/runtime/src/sync/fansly/registry.ts";
import { applyAccountMeToPage } from "../apps/runtime/src/sync/fansly/resources/account.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { makeTestActor, okResponse, ScriptedLiveTransport, waitFor } from "./helpers/sync-engine-host.ts";

// A Fansly page born live gets its whole money history by itself (bug hunt
// 2026-10-09 Д1). Its birth transaction — the page, its `/account/me` write,
// `createLiveSyncPage` and the `new_page` work (`fanslyNewPageWork`), as
// `onboardFanslyPage` runs it (tests/sync-onboard-live pins that it does) —
// queues `transactions.backfill`, so whichever money read runs first, the
// ledger reaches Fansly's lifetime total:
//
//  (a) the 5-minute insurance poll first: it stores the newest 200 rows and
//      escalates to the rescan, whose 7-day window never reaches the rest —
//      the backfill does;
//  (b) the socket's money head first (`ws_gap`, as every verified connection
//      asks for it), the rescan due 5 s later: the same;
//  (c) the rescan first: its fallback demand for the backfill (nothing stored)
//      merges into the birth's row — one walk, five pages.
//
// Alert 4 (`transactions_ledger_incomplete`) never opens meanwhile: a moving
// backfill, then one completed after the shortfall's round began, explain
// it; the next rescan round finds the ledger whole. Production actor,
// registry and transactions module; fixed answers (no HTTP). The page's
// other history walks are paused: this is about its money.

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
const DAY = 86_400_000;
const HOUR = 3_600_000;
const LIFETIME = 450;

/** The page's lifetime earnings ledger as Fansly lists it, newest first: one
 *  settled 10.00/8.00 tip a day for 450 days, no fan named (no lookups, no
 *  roster, no purchase targets follow). */
const now = Date.now();
const LEDGER = Array.from({ length: LIFETIME }, (_, index) => ({
  walletId: "wallet-1",
  transactionId: `tx-${String(index).padStart(4, "0")}`,
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
  createdAt: now - (index + 1) * DAY,
  updatedAt: null,
  status: 2,
  senderId: null,
  receiverId: OWN_ID,
}));

function param(req: FanslyWireRequest, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}

/** `GET /account/wallets/earnings/transactions?limit&offset` over LEDGER. */
function fansly(req: FanslyWireRequest): FanslyWireOutcome {
  if (req.spec !== "transactions.page") throw new Error(`unexpected ${req.spec}`);
  const offset = Number(param(req, "offset"));
  const limit = Number(param(req, "limit"));
  return okResponse({ total: LIFETIME, data: LEDGER.slice(offset, offset + limit) });
}

const MONEY_KEY = "transactions.backfill";

/** The birth transaction of `onboardFanslyPage` after its identity check;
 *  the page's history walks other than its money are paused. */
async function bornPage(label: string): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const pageId = await testDb!.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const page = await createFanslyPage(tx, { modelId: model!.id, label });
    await applyAccountMeToPage(tx, {
      pageId: page!.id,
      account: {
        id: OWN_ID,
        username: "user_001",
        displayName: "User 001",
        createdAt: 1_772_157_317_000,
        followCount: 42,
        subscriberCount: 7,
        earningsWallet: { id: "wallet-1", balance: 12_345 },
        walls: [{ id: "wall-1" }],
        subscriptionTiers: [{ id: "tier-1" }],
      } as never,
      syncType: "light",
    });
    await createLiveSyncPage(tx, {
      pageId: page!.id,
      by: "onboarding:test",
      identityAccountId: OWN_ID,
      identityCheckedAt: new Date(),
      credentialsGeneration: "a".repeat(64),
    });
    await upsertDemands(tx, fanslyNewPageWork({ pageId: page!.id, now: new Date() }));
    return page!.id;
  });
  await testDb!.pool.query("update sync_pages set paused_resources = $2::text[] where page_id = $1", [
    pageId, fanslyNewPageKeys().filter((key) => key !== MONEY_KEY),
  ]);
  return pageId;
}

/** The actor's first lap with fixed phases: `phases[key]` for the named
 *  keys, every other standing row parked near the end of its period. */
async function standingRows(pageId: number, registry: EngineRegistry, phases: Record<string, number>): Promise<void> {
  const page = (await getSyncPage(db(), pageId))!;
  await ensurePollRows(db(), { pageId, polls: pollsFor(registry, page).map((poll) => ({ ...poll, phase: phases[poll.resource] ?? 0.999 })) });
}

async function workRows(pageId: number, resource: string) {
  return (await testDb!.pool.query<{
    id: number; kind: string; state: string; closeReason: string | null; reasons: string[] | null;
    proof: Record<string, unknown> | null; closedAt: Date | null;
  }>(
    `select id::int, kind, state, close_reason as "closeReason", demand -> 'reasons' as reasons, proof, closed_at as "closedAt"
       from sync_work where page_id = $1 and not shadow and resource = $2 order by id`,
    [pageId, resource],
  )).rows;
}

async function ledgerCount(pageId: number): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from transactions where platform_account_id = $1 and source = 'fansly:rest'", [pageId],
  )).rows[0]!.n;
}

async function appliedAttempts(pageId: number, resource: string): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'",
    [pageId, resource],
  )).rows[0]!.n;
}

/** What alert 4 reads and says now. */
async function alert4(pageId: number, registry: EngineRegistry) {
  const facts = await readSyncJournalAlertFacts(db(), {
    pageId, stopLookbackMs: 600_000, urgentAfterMs: 120_000, requestStallMs: 1_800_000,
  });
  const conditions = await collectPageAlerts(db(), { page: (await getSyncPage(db(), pageId))!, registry });
  return {
    shortfall: facts.ledgerIncomplete,
    backfill: facts.transactionsBackfill,
    pages: conditions.flatMap((condition) => condition.reasons.map((reason) => reason.detail)).includes("transactions_ledger_incomplete"),
  };
}

interface Run {
  /** The money requests in order. */
  sent: string[];
  /** Alert 4 after every applied step (before each next request, and at the end). */
  checks: Array<Awaited<ReturnType<typeof alert4>>>;
}

async function runActor(pageId: number, registry: EngineRegistry, until: () => Promise<boolean>): Promise<Run> {
  const run: Run = { sent: [], checks: [] };
  const transport = new ScriptedLiveTransport();
  transport.respond = (req) => {
    run.sent.push(`${req.spec}?limit=${param(req, "limit")}&offset=${param(req, "offset")}`);
    return fansly(req);
  };
  // Every step before this request has committed its apply.
  transport.onHit = async () => {
    run.checks.push(await alert4(pageId, registry));
  };
  const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, ownRef: OWN_ID });
  const running = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 90_000, "the walks to settle");
  } finally {
    stop.abort();
    await running;
  }
  run.checks.push(await alert4(pageId, registry));
  return run;
}

/** The next hourly rescan round, now: due at once, run until it applied. */
async function nextRescanRound(pageId: number, registry: EngineRegistry): Promise<Run> {
  const before = await appliedAttempts(pageId, "transactions.rescan");
  await testDb!.pool.query(
    "update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'transactions.rescan' and state = 'open'", [pageId],
  );
  return runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.rescan")) > before);
}

/** The birth's backfill done with the whole ledger, and the next rescan
 *  round certified whole; alert 4 never paged. */
async function expectWholeLedger(pageId: number, registry: EngineRegistry, runs: Run[]): Promise<void> {
  expect(await ledgerCount(pageId)).toBe(LIFETIME);
  const backfills = await workRows(pageId, MONEY_KEY);
  expect(backfills).toHaveLength(1);
  expect(backfills[0]).toMatchObject({
    kind: "goal", state: "done", closeReason: "backfill_complete", proof: { fetched: LIFETIME, total: LIFETIME },
  });
  expect(backfills[0]!.reasons).toContain("new_page");
  // Five pages of 100: no restart, no second walk.
  expect(await appliedAttempts(pageId, MONEY_KEY)).toBe(Math.ceil(LIFETIME / 100));

  const round = await nextRescanRound(pageId, registry);
  const [rescan] = await workRows(pageId, "transactions.rescan");
  expect(rescan).toMatchObject({ kind: "poll", state: "open", proof: { total: LIFETIME, ledgerRows: LIFETIME } });
  expect(rescan!.proof).not.toHaveProperty("ledgerIncomplete");
  expect(Date.parse(String(rescan!.proof!.walkStartedAt))).toBeGreaterThan(backfills[0]!.closedAt!.getTime());

  const checks = [...runs, round].flatMap((entry) => entry.checks);
  expect(checks.length).toBeGreaterThan(5);
  expect(checks.filter((check) => check.pages)).toEqual([]);
  expect(checks.at(-1)).toMatchObject({ shortfall: null, pages: false });
}

describe("a page born live gets its whole money history (Д1)", () => {
  it("(a) insurance first: 200 rows, an escalated 7-day rescan proving the hole, and the birth's backfill fills it", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await bornPage("insurance-first");
    const registry = createFanslyRegistry();
    await standingRows(pageId, registry, { "transactions.insurance": 0 });

    const run = await runActor(pageId, registry, async () => (await workRows(pageId, MONEY_KEY))[0]?.state === "done");
    // The insurance's ten head pages of 20 up to offset 200 (escalated) and
    // the backfill's five pages of 100 all went out.
    expect(run.sent.filter((line) => line.includes("limit=20&")))
      .toEqual(Array.from({ length: 10 }, (_, page) => `transactions.page?limit=20&offset=${page * 20}`));
    for (const offset of [100, 200, 300, 400]) expect(run.sent).toContain(`transactions.page?limit=100&offset=${offset}`);
    const [insurance] = await workRows(pageId, "transactions.insurance");
    expect(insurance).toMatchObject({ kind: "poll", state: "open", proof: { stop: "escalated", pages: 10, fetched: 200 } });
    // The escalated rescan ran while the backfill was still walking and
    // proved a hole: explained by the moving backfill, never paged.
    expect(await appliedAttempts(pageId, "transactions.rescan")).toBeGreaterThanOrEqual(1);
    expect(run.checks.some((check) => check.shortfall !== null && check.backfill.openProgressAt !== null && !check.pages)).toBe(true);

    await expectWholeLedger(pageId, registry, [run]);
  }, 300_000);

  it("(b) the socket's money head first (ws_gap at birth), the rescan due 5 s later: the backfill fills the same hole", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await bornPage("socket-first");
    const registry = createFanslyRegistry();
    await standingRows(pageId, registry, { "transactions.rescan": 5_000 / HOUR });
    // The money head of the first verified socket's repair (repair.ts: reason ws_gap).
    const head = demandToUpsert({ resource: "transactions.head", demand: { reason: "ws_gap" } }, registry.spec("transactions.head")!, {
      pageId, now: new Date(),
    })!;
    await upsertDemand(db(), head);

    // The head's whole walk lands first — the race of the bug: the planned
    // class (the birth's backfill) only gets a slot after it, as behind a
    // busy planned queue (here: the backfill held by a pause meanwhile).
    await testDb.pool.query("update sync_pages set paused_resources = paused_resources || $2::text[] where page_id = $1", [pageId, [MONEY_KEY]]);
    const first = await runActor(pageId, registry, async () => (await workRows(pageId, "transactions.head"))[0]?.state === "done");
    expect(first.sent.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, page) => `transactions.page?limit=20&offset=${page * 20}`));
    const [moneyHead] = await workRows(pageId, "transactions.head");
    expect(moneyHead).toMatchObject({ state: "done", closeReason: "escalated" });
    expect(await ledgerCount(pageId)).toBe(200);

    await testDb.pool.query("update sync_pages set paused_resources = array_remove(paused_resources, $2) where page_id = $1", [pageId, MONEY_KEY]);
    const run = await runActor(pageId, registry, async () => (await workRows(pageId, MONEY_KEY))[0]?.state === "done");
    for (const offset of [0, 100, 200, 300, 400]) expect(run.sent).toContain(`transactions.page?limit=100&offset=${offset}`);

    await expectWholeLedger(pageId, registry, [first, run]);
  }, 300_000);

  it("(c) control, the rescan first: its fallback demand merges into the birth's row — one backfill, five pages", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await bornPage("rescan-first");
    const registry = createFanslyRegistry();
    await standingRows(pageId, registry, { "transactions.rescan": 0 });

    const run = await runActor(pageId, registry, async () => (await workRows(pageId, MONEY_KEY))[0]?.state === "done");
    expect(run.sent).toEqual([0, 100, 200, 300, 400].map((offset) => `transactions.page?limit=100&offset=${offset}`));
    const [backfill] = await workRows(pageId, MONEY_KEY);
    expect(backfill!.reasons).toEqual(["new_page", "dependency:transactions.rescan"]);

    await expectWholeLedger(pageId, registry, [run]);
  }, 300_000);
});

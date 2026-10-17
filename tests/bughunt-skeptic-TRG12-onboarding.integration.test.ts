import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createLiveSyncPage,
  createModel,
  ensurePollRows,
  getSyncPage,
  readSyncJournalAlertFacts,
  upsertDemand,
  type Database,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { collectPageAlerts } from "../apps/runtime/src/sync/engine/alerts.ts";
import { demandToUpsert, pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry } from "../apps/runtime/src/sync/fansly/registry.ts";
import { applyAccountMeToPage } from "../apps/runtime/src/sync/fansly/resources/account.ts";
import { enqueueOwnerSyncWork } from "../apps/runtime/src/sync/inspect.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { makeTestActor, okResponse, ScriptedLiveTransport, waitFor } from "./helpers/sync-engine-host.ts";

// Skeptic of TRG-1 / TRG-2 (bug hunt 2026-10-09). One assumption of the
// hunter's test changed at a time, production code throughout:
//  A. socket first — the money head a verified socket's `repair.ws-gap` asks
//     for (reason `ws_gap`, as on prod after every connection) is demanded at
//     birth, the rescan is due 5 s later (phase ≈ 0.0014 — luckier than
//     99.86 % of births): does the rescan still ask for the backfill?
//  B. a second hourly rescan round: does the poll row ever close `done`, does
//     alert 4's fact ever turn non-null?
//  C. the owner's lever (`sync work enqueue --resource transactions.backfill`)
//     afterwards: is the hole recoverable, at what request cost?

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
const LIFETIME = 450;
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

function fansly(req: FanslyWireRequest): FanslyWireOutcome {
  if (req.spec !== "transactions.page") throw new Error(`unexpected ${req.spec}`);
  const offset = Number(param(req, "offset"));
  const limit = Number(param(req, "limit"));
  return okResponse({ total: LIFETIME, data: LEDGER.slice(offset, offset + limit) });
}

async function onboard(label: string): Promise<number> {
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  return testDb!.db.transaction(async (raw) => {
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
    return page!.id;
  });
}

/** The actor's first lap with fixed phases: `phases[key]` for the named
 *  keys, every other standing row parked near the end of its period. */
async function standingRows(pageId: number, registry: EngineRegistry, phases: Record<string, number>): Promise<void> {
  const page = (await getSyncPage(db(), pageId))!;
  const polls = pollsFor(registry, page);
  await ensurePollRows(db(), { pageId, polls: polls.map((poll) => ({ ...poll, phase: phases[poll.resource] ?? 0.999 })) });
}

async function workRows(pageId: number, resource: string) {
  return (await testDb!.pool.query<{ id: number; kind: string; state: string; reasons: string[] | null; proof: Record<string, unknown> | null }>(
    `select id::int, kind, state, demand -> 'reasons' as reasons, proof from sync_work
      where page_id = $1 and not shadow and resource = $2 order by id`,
    [pageId, resource],
  )).rows;
}

async function ledgerCount(pageId: number): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from transactions where platform_account_id = $1", [pageId],
  )).rows[0]!.n;
}

async function appliedAttempts(pageId: number, resource: string): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'",
    [pageId, resource],
  )).rows[0]!.n;
}

async function alert4(pageId: number, registry: EngineRegistry) {
  const facts = await readSyncJournalAlertFacts(db(), {
    pageId, stopLookbackMs: 600_000, urgentAfterMs: 120_000, requestStallMs: 1_800_000,
  });
  const conditions = await collectPageAlerts(db(), { page: (await getSyncPage(db(), pageId))!, registry });
  return {
    fact: facts.ledgerIncomplete,
    reasons: conditions.flatMap((condition) => condition.reasons.map((reason) => reason.detail)),
  };
}

async function runActor(pageId: number, registry: EngineRegistry, until: () => Promise<boolean>): Promise<string[]> {
  const transport = new ScriptedLiveTransport();
  const requests: FanslyWireRequest[] = [];
  transport.respond = (req) => {
    requests.push(req);
    return fansly(req);
  };
  const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, ownRef: OWN_ID });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 90_000, "the walk to settle");
  } finally {
    stop.abort();
    await run;
  }
  return requests.map((req) => `${req.spec}?limit=${param(req, "limit")}&offset=${param(req, "offset")}`);
}

describe("skeptic TRG-1 / TRG-2", () => {
  it("A+B+C: socket head first, a second rescan round, then the owner's backfill", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await onboard("socket-first");
    const registry = createFanslyRegistry();
    // The rescan due 5 s after birth; insurance and the rest parked.
    await standingRows(pageId, registry, { "transactions.rescan": 5_000 / 3_600_000 });
    // A: the money head of the first verified socket's repair (repair.ts: reason ws_gap).
    const spec = registry.spec("transactions.head")!;
    const upsert = demandToUpsert({ resource: "transactions.head", demand: { reason: "ws_gap" } }, spec, { pageId, now: new Date() })!;
    await upsertDemand(db(), upsert);

    const sentA = await runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.rescan")) >= 1);
    const backfillA = await workRows(pageId, "transactions.backfill");
    const [rescanA] = await workRows(pageId, "transactions.rescan");
    const alertA = await alert4(pageId, registry);
    console.log("A sent", JSON.stringify(sentA));
    console.log("A outcome", JSON.stringify({ backfill: backfillA.length, ledger: await ledgerCount(pageId), rescan: rescanA, alert4: alertA.fact }));
    expect(backfillA).toEqual([]);
    expect(await ledgerCount(pageId)).toBe(200);
    expect(rescanA).toMatchObject({ kind: "poll", state: "open", proof: { total: LIFETIME, ledgerRows: 200, ledgerIncomplete: 250 } });
    expect(alertA.fact).toBeNull();
    expect(alertA.reasons).not.toContain("transactions_ledger_incomplete");

    // B: the next hourly round (due now instead of in an hour).
    await testDb.pool.query(
      "update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'transactions.rescan' and state = 'open'", [pageId],
    );
    const sentB = await runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.rescan")) >= 2);
    const rescanRowsB = await workRows(pageId, "transactions.rescan");
    const alertB = await alert4(pageId, registry);
    console.log("B sent", JSON.stringify(sentB));
    console.log("B outcome", JSON.stringify({ rows: rescanRowsB.map((row) => `${row.kind}/${row.state}`), proof: rescanRowsB[0]?.proof, alert4: alertB.fact }));
    expect(rescanRowsB.map((row) => row.state)).toEqual(["open"]);
    expect(await workRows(pageId, "transactions.backfill")).toEqual([]);
    expect(alertB.fact).toBeNull();

    // C: the owner's lever, then one more rescan round.
    const queued = await enqueueOwnerSyncWork(db(), registry, {
      pageLabel: "socket-first", resource: "transactions.backfill", actor: "skeptic", note: "new page",
    });
    const sentC = await runActor(pageId, registry, async () => (await workRows(pageId, "transactions.backfill"))[0]?.state === "done");
    await testDb.pool.query(
      "update sync_work set due_at = clock_timestamp() where page_id = $1 and resource = 'transactions.rescan' and state = 'open'", [pageId],
    );
    await runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.rescan")) >= 3);
    const [backfillC] = await workRows(pageId, "transactions.backfill");
    const [rescanC] = await workRows(pageId, "transactions.rescan");
    console.log("C sent", JSON.stringify(sentC));
    console.log("C outcome", JSON.stringify({ queued, backfill: backfillC, ledger: await ledgerCount(pageId), rescanProof: rescanC?.proof }));
    expect(backfillC).toMatchObject({ kind: "goal", state: "done", proof: { total: LIFETIME, fetched: LIFETIME } });
    expect(await ledgerCount(pageId)).toBe(LIFETIME);
    expect(rescanC!.proof).toMatchObject({ total: LIFETIME, ledgerRows: LIFETIME });
    expect(rescanC!.proof).not.toHaveProperty("ledgerIncomplete");
  }, 300_000);
});

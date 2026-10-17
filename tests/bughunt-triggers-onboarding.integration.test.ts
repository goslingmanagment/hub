import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createLiveSyncPage,
  createModel,
  ensurePollRows,
  getSyncPage,
  readSyncJournalAlertFacts,
  type Database,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import type { FanslyWireOutcome, FanslyWireRequest } from "@agency_hub_core/fansly";

import { collectPageAlerts } from "../apps/runtime/src/sync/engine/alerts.ts";
import { pollsFor, type EngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { applyAccountMeToPage } from "../apps/runtime/src/sync/fansly/resources/account.ts";
import { transactionsModule } from "../apps/runtime/src/sync/fansly/resources/transactions.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { makeTestActor, okResponse, ScriptedLiveTransport, waitFor } from "./helpers/sync-engine-host.ts";

// Bug hunt 2026-10-09, lifecycle/triggers (TRG-1, TRG-2). What a Fansly page
// born live (onboarding's DB part: the page, its `/account/me` write and
// `createLiveSyncPage`, in one transaction, as `onboardFanslyPage` runs it)
// gets on its own, driven through the production actor, registry and
// transactions module with fixed answers (no HTTP):
//
//  - nothing at birth: the registry's `new_page` trigger (transactions.backfill,
//    top-spenders.bootstrap) has no emitter;
//  - the runbook's fallback ("the hourly transactions rescan asks for the
//    transactions backfill while nothing is stored") only fires when the
//    rescan is the first to touch the ledger. The 5-minute insurance poll (or
//    any socket money frame's head read) stores the newest 200 rows first and
//    escalates to the rescan, which then reads its 7-day window and never asks
//    for the backfill: the ledger stays short of Fansly's lifetime total;
//  - the rescan's own proof says so (`ledgerIncomplete`), but alert 4
//    `transactions_ledger_incomplete` reads only a `done` rescan row, and a
//    poll row never closes `done`: the alert's fact is null, nothing pages.

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

/** The page's lifetime earnings ledger as Fansly lists it, newest first: one
 *  settled 10.00/8.00 tip a day for 450 days. */
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

/** Onboarding's database transaction (`onboardFanslyPage` after its no-page
 *  identity check): the page, the account the check proved, the live row. */
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

/** The actor's first lap (`#ensurePolls`), with the phases `ensurePollRows`
 *  would otherwise draw from `random()` fixed: `first` due now, every other
 *  standing row parked near the end of its first period. */
async function standingRows(pageId: number, registry: EngineRegistry, first: string): Promise<string[]> {
  const page = (await getSyncPage(db(), pageId))!;
  const polls = pollsFor(registry, page);
  await ensurePollRows(db(), { pageId, polls: polls.map((poll) => ({ ...poll, phase: poll.resource === first ? 0 : 0.999 })) });
  return polls.map((poll) => poll.resource).sort();
}

async function workRows(pageId: number, resource?: string) {
  return (await testDb!.pool.query<{ resource: string; kind: string; state: string; reasons: string[] | null; proof: Record<string, unknown> | null }>(
    `select resource, kind, state, demand -> 'reasons' as reasons, proof from sync_work
      where page_id = $1 and not shadow and ($2::text is null or resource = $2) order by id`,
    [pageId, resource ?? null],
  )).rows;
}

async function ledgerRows(pageId: number): Promise<{ n: number; net: string }> {
  return (await testDb!.pool.query<{ n: number; net: string }>(
    "select count(*)::int as n, coalesce(sum(creator_net_amount_mills), 0)::text as net from transactions where platform_account_id = $1",
    [pageId],
  )).rows[0]!;
}

async function appliedAttempts(pageId: number, resource: string): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from sync_attempts where page_id = $1 and resource = $2 and apply_state = 'applied'",
    [pageId, resource],
  )).rows[0]!.n;
}

async function runActor(pageId: number, registry: EngineRegistry, until: () => Promise<boolean>) {
  const transport = new ScriptedLiveTransport();
  const requests: FanslyWireRequest[] = [];
  transport.respond = (req) => {
    requests.push(req);
    return fansly(req);
  };
  const { actor, stop, abort } = await makeTestActor({ db: db(), pageId, registry, transport, ownRef: OWN_ID });
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 60_000, "the walk to settle");
  } finally {
    stop.abort();
    await run;
  }
  return requests.map((req) => `${req.spec}?limit=${param(req, "limit")}&offset=${param(req, "offset")}`);
}

describe("a page born live: its money history (TRG-1, TRG-2)", () => {
  it("gets no work at birth: nothing emits the registry's `new_page` trigger", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await onboard("born-live");
    expect(await workRows(pageId)).toEqual([]);

    const newPageKeys = FANSLY_RESOURCE_SPECS.filter((spec) => spec.triggers.includes("new_page")).map((spec) => spec.key);
    expect(newPageKeys).toEqual(["transactions.backfill", "top-spenders.bootstrap"]);
    // The actor's first lap creates the standing rows, and only them.
    const standing = await standingRows(pageId, createFanslyRegistry(), "none");
    expect(standing).not.toContain("transactions.backfill");
    expect(standing).not.toContain("top-spenders.bootstrap");
    expect((await workRows(pageId)).map((row) => row.resource).sort()).toEqual(standing);
  });

  it("insurance first (≈ 96 % of births, and every birth with an early money frame): 200 rows, a 7-day rescan, never the backfill, and alert 4 sees nothing", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await onboard("insurance-first");
    const registry = createFanslyRegistry();
    await standingRows(pageId, registry, "transactions.insurance");

    const sent = await runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.rescan")) >= 1);

    // Ten head pages of 20 up to offset 200 (escalated), then one rescan page.
    expect(sent).toEqual([
      ...Array.from({ length: 10 }, (_, page) => `transactions.page?limit=20&offset=${page * 20}`),
      "transactions.page?limit=100&offset=0",
    ]);
    const [insurance] = await workRows(pageId, "transactions.insurance");
    expect(insurance).toMatchObject({ kind: "poll", state: "open", proof: { stop: "escalated", pages: 10, fetched: 200 } });

    // The rescan proved the hole and kept its poll row open, as every poll does.
    const [rescan] = await workRows(pageId, "transactions.rescan");
    expect(rescan).toMatchObject({
      kind: "poll",
      state: "open",
      proof: { earlyStopped: true, total: LIFETIME, ledgerRows: 200, ledgerIncomplete: LIFETIME - 200 },
    });
    expect(rescan!.reasons).toContain("escalated:transactions.insurance");

    // No backfill was asked for, and none ever will be: every later round of
    // the rescan plans its window again (a ledger with one row has a checkpoint).
    expect(await workRows(pageId, "transactions.backfill")).toEqual([]);
    const openRescan = (await testDb.pool.query<{ cursor: unknown }>(
      "select cursor from sync_work where page_id = $1 and resource = 'transactions.rescan' and state = 'open'", [pageId],
    )).rows[0]!;
    // (The plan reads the row's cursor only.)
    const plan = await transactionsModule("rescan").plan(
      { cursor: openRescan.cursor } as unknown as SyncWorkRow,
      { db: db(), pageId, now: new Date(), page: (await getSyncPage(db(), pageId))!, registry },
    );
    expect(plan).toMatchObject({ kind: "request", request: { spec: "transactions.page", params: { limit: 100, offset: 0 } } });

    // 250 of 450 transactions (2 000.00 of 3 600.00 net) never reach the ledger.
    expect(await ledgerRows(pageId)).toEqual({ n: 200, net: String(200 * 8_000) });

    // Alert 4's fact reads only a `done` rescan row: null, so nothing opens.
    const facts = await readSyncJournalAlertFacts(db(), {
      pageId, stopLookbackMs: 600_000, urgentAfterMs: 120_000, requestStallMs: 1_800_000,
    });
    expect(facts.ledgerIncomplete).toBeNull();
    const conditions = await collectPageAlerts(db(), { page: (await getSyncPage(db(), pageId))!, registry });
    const reasons = conditions.flatMap((condition) => condition.reasons.map((reason) => reason.detail));
    expect(reasons).not.toContain("transactions_ledger_incomplete");
  });

  it("EXPECTED (runbook 'Onboarding a page' step 3, registry `new_page`): the whole ledger arrives, or alert 4 says it did not — FAILS", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await onboard("promise");
    const registry = createFanslyRegistry();
    await standingRows(pageId, registry, "transactions.insurance");
    await runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.rescan")) >= 1);

    const facts = await readSyncJournalAlertFacts(db(), {
      pageId, stopLookbackMs: 600_000, urgentAfterMs: 120_000, requestStallMs: 1_800_000,
    });
    const outcome = {
      backfillAsked: (await workRows(pageId, "transactions.backfill")).length > 0,
      ledgerRows: (await ledgerRows(pageId)).n,
      alert4: facts.ledgerIncomplete,
    };
    // Either the backfill is asked for (new_page / the rescan's fallback), or
    // the owner is told the ledger is short (alert 4).
    expect(outcome.backfillAsked || outcome.alert4 !== null, JSON.stringify(outcome)).toBe(true);
  });

  it("control: only a rescan that runs before anything is stored asks for the backfill", async (context) => {
    if (!testDb) return context.skip();
    const pageId = await onboard("rescan-first");
    const registry = createFanslyRegistry();
    await standingRows(pageId, registry, "transactions.rescan");

    const sent = await runActor(pageId, registry, async () => (await appliedAttempts(pageId, "transactions.backfill")) >= 5);
    expect(sent.slice(0, 5)).toEqual([0, 100, 200, 300, 400].map((offset) => `transactions.page?limit=100&offset=${offset}`));
    const [backfill] = await workRows(pageId, "transactions.backfill");
    expect(backfill).toMatchObject({ kind: "goal", reasons: ["dependency:transactions.rescan"] });
    expect((await ledgerRows(pageId)).n).toBe(LIFETIME);
  });
});

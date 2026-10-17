import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";

const fakes = vi.hoisted(() => ({
  ledgerCount: 20,
  writer: vi.fn(async () => ({ transactionsWriter: "fansly" })),
  write: vi.fn(async () => ({})),
  revenue: vi.fn(async () => undefined),
  spenders: vi.fn(async () => undefined),
}));
vi.mock("@agency_hub_core/db", async (original) => ({
  ...await original<object>(),
  getPageTransactionsWriterInfo: fakes.writer,
  countTransactionsBySource: vi.fn(async () => fakes.ledgerCount),
  getOldestPendingTransactionAt: vi.fn(async () => null),
  upsertFanslyTransactionWithEarningsDirty: fakes.write,
  rebuildRevenueRollups: fakes.revenue,
  rebuildSpenderProjections: fakes.spenders,
  upsertFans: vi.fn(async () => []),
}));

import { createEngineRegistry, pollsFor } from "../apps/runtime/src/sync/engine/resource.ts";
import { FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { transactionsModule } from "../apps/runtime/src/sync/fansly/resources/transactions.ts";
import { readSyncJournalAlertFacts } from "../packages/db/src/repositories/sync/observability.ts";

const now = new Date("2026-10-09T12:00:00Z");
const dialect = new PgDialect();
function sqlText(query: unknown): string { return dialect.sqlToQuery(query as never).sql; }
const mockDb = {
  execute: vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("select max(occurred_at)")) return { rows: [{ at: now }] };
    if (text.includes("commission_rate")) return { rows: [{ rate: 0.2 }] };
    return { rows: [] };
  }),
};
function work(cursor: unknown = {}) { return { cursor, demand: { txIds: [], overflow: false }, params: {}, subject: "", demandRevision: 1 }; }
function transaction(index: number) {
  return {
    transactionId: String(1000 - index), walletId: "wallet", accountId: "page", correlationId: null,
    correlationAccountId: null, type: 7001, destination: 1, amount: 10000, destinationAmount: 8000,
    destinationTax: 2000, newBalance64: null, senderId: null, receiverId: null, status: 2,
    createdAt: now.getTime() - index * 24 * 60 * 60 * 1000, updatedAt: null,
  };
}
beforeEach(() => { vi.clearAllMocks(); fakes.ledgerCount = 20; });

describe("2026-10-09 audit: new page historical ledger bootstrap", () => {
  it("control: an entirely empty ledger asks for the lifetime backfill", async () => {
    fakes.ledgerCount = 0;
    const plan = await transactionsModule("rescan").plan(work() as never, { db: mockDb, pageId: 99, now } as never);
    expect(plan).toMatchObject({ kind: "wait", enqueue: [{ resource: "transactions.backfill" }] });
  });

  it("FAILS: birth's standing work must include the declared new_page money bootstrap", () => {
    const standing = pollsFor(createEngineRegistry(FANSLY_RESOURCE_SPECS), { registryOverrides: {} } as never);
    expect(standing.map((row) => row.resource)).toContain("transactions.backfill");
  });

  it("FAILS: after insurance seeds 20 head rows, a rescan must schedule the missing lifetime history", async () => {
    // An insurance poll became due within five minutes; rescan's random phase
    // may be almost one hour. No historical bootstrap row was seeded at birth.
    const module = transactionsModule("rescan");
    const plan = await module.plan(work() as never, { db: mockDb, pageId: 99, now } as never);
    expect(plan).toMatchObject({ kind: "request" });
    fakes.ledgerCount = 100; // first rescan page is now stored, total is 500.
    const page = { data: Array.from({ length: 100 }, (_, i) => transaction(i)), total: 500 };
    const applied = await module.apply(mockDb as never, {
      pageId: 99, now, parsed: page, response: page, work: work(),
      request: { spec: "transactions.page", params: { limit: 100, offset: 0 } },
      attempt: { admittedAt: now, demandRevision: 1 }, observation: { id: 1 },
    } as never);
    expect(applied.work).toMatchObject({ close: "done", proof: { earlyStopped: true, ledgerIncomplete: 400 } });
    expect(applied.followups).toContainEqual(expect.objectContaining({ resource: "transactions.backfill" }));
  });
});

describe("2026-10-09 audit: poll receipts feed the ledger-gap alert", () => {
  it("FAILS: the actual alert query must see the gap on the durable open poll", async () => {
    const queries: string[] = [];
    const db = { execute: async (query: unknown) => {
      const text = sqlText(query); queries.push(text);
      // Model the production work shape: latest completed cycle proof lives
      // on state=open, closed_at=NULL. No state=done rescan row exists.
      if (text.includes("'transactions.rescan'") && !text.includes("w.state = 'done'")) {
        return { rows: [{ missing: "400", at: now }] };
      }
      return { rows: [] };
    } };
    const facts = await readSyncJournalAlertFacts(db as never, {
      pageId: 99, stopLookbackMs: 10000, urgentAfterMs: 10000, requestStallMs: 10000,
    });
    expect(queries.find((q) => q.includes("'transactions.rescan'"))).toBeDefined();
    expect(facts.ledgerIncomplete).toEqual({ missing: 400, at: now });
  });
});

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { QueryConfig, QueryResult } from "pg";
import {
  createFanslyPage,
  createModel,
  listTransactionsForScope,
} from "@agency_hub_core/db";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase;
let pageId: number;
let otherPageId: number;
const from = new Date("2026-09-03T00:00:00Z");
const to = new Date("2026-09-11T00:00:00Z");
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Integration database is required");
  testDb = started;
}, 120_000);
afterAll(async () => {
  await testDb?.stop();
});
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  const model = await createModel(testDb.db, { slug: "test", name: "Test" });
  pageId = (
    await createFanslyPage(testDb.db, { modelId: model!.id, label: "page" })
  )!.id;
  otherPageId = (
    await createFanslyPage(testDb.db, { modelId: model!.id, label: "denied" })
  )!.id;
});
async function insert(
  id: string,
  net: number,
  at: Date,
  type = "tip",
  state = "pending",
  scope = pageId,
) {
  await testDb.pool.query(
    `insert into transactions (platform_account_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source) values ($1,$2,'2000',$3,$4,'test',$5,$5,$5,$6,'fansly:rest')`,
    [scope, id, type, state, net, at],
  );
}
const input = () => ({
  pageIds: [pageId],
  period: { from, to },
  reportableOnly: true,
  limit: 1,
  offset: 0,
});
describe("exact revenue operations", () => {
  it("uses [from,to), all states and reportable types; summary does not shrink with pagination", async () => {
    await insert("before", 99000, new Date(from.getTime() - 1));
    await insert("at-from", 10000, from, "tip", "pending");
    await insert(
      "refund",
      -2000,
      new Date(from.getTime() + 1),
      "refund",
      "posted",
    );
    await insert("other", 333, new Date(to.getTime() - 1), "other", "unknown");
    await insert("at-to", 99000, to);
    await insert("excluded", 50000, from, "payout_reversal");
    await insert("foreign", 88000, from, "tip", "posted", otherPageId);
    const result = await listTransactionsForScope(testDb.db, input());
    expect(result.total).toBe(3);
    expect(result.netAmountMills).toBe(8333n);
    expect(result.items.map((item) => item.transactionId)).toEqual(["other"]);
    expect(result.items[0]?.fanPlatformUserId).toBeNull();
    const second = await listTransactionsForScope(testDb.db, {
      ...input(),
      offset: 1,
    });
    expect(second.total).toBe(3);
    expect(second.netAmountMills).toBe(8333n);
    expect(second.items.map((item) => item.transactionId)).toEqual(["refund"]);
    const ordinary = await listTransactionsForScope(testDb.db, {
      ...input(),
      reportableOnly: false,
    });
    expect(ordinary.netAmountMills).toBe(58333n);
    expect(ordinary.total).toBe(4);
    const typed = await listTransactionsForScope(testDb.db, {
      ...input(),
      canonicalType: "refund",
    });
    expect(typed.total).toBe(1);
    expect(typed.netAmountMills).toBe(-2000n);
  });
  it("retains deleted-page history and cannot broaden an empty or foreign-label scope", async () => {
    await insert("kept", 1500, from);
    await insert("hidden", 9999, from, "tip", "posted", otherPageId);
    await testDb.pool.query("update pages set status='deleted' where id=$1", [
      pageId,
    ]);
    expect(
      (
        await listTransactionsForScope(testDb.db, {
          ...input(),
          pageLabel: "page",
        })
      ).netAmountMills,
    ).toBe(1500n);
    expect(
      (
        await listTransactionsForScope(testDb.db, {
          ...input(),
          pageLabel: "denied",
        })
      ).total,
    ).toBe(0);
    expect(
      (await listTransactionsForScope(testDb.db, { ...input(), pageIds: [] }))
        .total,
    ).toBe(0);
  });
  it("keeps items and summary in one snapshot when an operation arrives between the two reads", async () => {
    await insert("first", 1000, from);
    const connect = testDb.pool.connect.bind(testDb.pool);
    let inserted = false;
    vi.spyOn(testDb.pool, "connect").mockImplementationOnce(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const spy = vi.spyOn(client, "query");
      spy.mockImplementation((async (
        config: string | QueryConfig,
        values?: unknown[],
      ): Promise<QueryResult> => {
        const result = await query(config, values);
        const sqlText = typeof config === "string" ? config : config.text;
        if (!inserted && sqlText.includes("count(*)")) {
          inserted = true;
          await insert("arrived", 9000, new Date(from.getTime() + 1));
        }
        return result;
      }) as typeof client.query);
      return client;
    });
    try {
      const result = await listTransactionsForScope(testDb.db, {
        ...input(),
        limit: 50,
      });
      expect(inserted).toBe(true);
      expect(result.total).toBe(1);
      expect(result.netAmountMills).toBe(1000n);
      expect(result.items.map((item) => item.transactionId)).toEqual(["first"]);
    } finally {
      vi.restoreAllMocks();
    }
    const refreshed = await listTransactionsForScope(testDb.db, {
      ...input(),
      limit: 50,
    });
    expect(refreshed.total).toBe(2);
    expect(refreshed.netAmountMills).toBe(10000n);
  });
});

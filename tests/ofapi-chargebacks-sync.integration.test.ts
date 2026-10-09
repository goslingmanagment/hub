// Stage 14: chargebacks via OFAPI — the daily reconcile writes
// canonical_type='chargeback' rows (source 'ofapi:rest', gross negated,
// OnlyMonster-shape) without ever touching the original settled spend row,
// and re-runs converge (0 new rows).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listNotificationIncidents,
  listStalePendingOfapiTransactions,
  retireStalePendingTransactionsById,
  setPageOfapiAccountId,
  upsertTransaction,
} from "@agency_hub_core/db";
import { createLogger } from "@agency_hub_core/shared";
import {
  repairNegationAnomalies,
  upsertTransactionWithNegationGuards,
} from "../apps/runtime/src/services/money-negation-guards.ts";
import { runOfapiPendingReconcile } from "../apps/runtime/src/services/ofapi-pending-reconcile.ts";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  runOfapiChargebacksReconcile,
  startOfapiChargebacksWorker,
} from "../apps/runtime/src/services/ofapi-chargebacks-sync.ts";
import {
  createOfapiClient,
  OfapiApiError,
  type OfapiClient,
  type OfapiListPage,
} from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiChargebacksReconcileEnabled: true,
    ofapiCreditLedgerEnabled: true,
  });
});

async function seedOfapiPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  if (!model) {
    throw new Error("model seed failed");
  }
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  if (!page) {
    throw new Error("page seed failed");
  }
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  return page;
}

// Vendored-spec response shape: data.list of { id, createdAt, paymentType,
// payment{ id, amount, net, fee, vatAmount, taxAmount, status, user{id} } }.
function chargebackItem(paymentId: string, fanId: string) {
  return {
    id: 7,
    createdAt: "2026-06-20T10:00:00+00:00",
    paymentType: "tips",
    payment: {
      id: paymentId,
      amount: 12.34,
      vatAmount: 1.5,
      taxAmount: 0,
      net: 9.87,
      fee: 2.47,
      createdAt: "2026-06-15T10:00:00+00:00",
      currency: "USD",
      status: "undo",
      user: { id: Number(fanId), name: "Fan", username: `u${fanId}` },
    },
  };
}

// A test double hands back the body it "received", as the real client does on
// this route (keepRawBody): the reconcile journals that body before reading it.
function chargebacksPage(items: Record<string, unknown>[], hasNextPage: boolean): OfapiListPage {
  return {
    items,
    hasNextPage,
    nextMarker: null,
    nextPageUrl: null,
    meta: null,
    rawBody: { data: { list: items } },
  };
}

type ChargebacksCall = {
  accountId: string;
  offset: number;
  startDate: string | undefined;
  endDate: string | undefined;
};

function chargebacksClient(input: {
  itemsByAccount: Map<string, Record<string, unknown>[]>;
  calls: ChargebacksCall[];
}): OfapiClient {
  return {
    async listChargebacks(
      _context: unknown,
      accountId: string,
      params: { offset?: number; startDate?: string; endDate?: string },
    ): Promise<OfapiListPage> {
      input.calls.push({
        accountId,
        offset: params.offset ?? 0,
        startDate: params.startDate,
        endDate: params.endDate,
      });
      return chargebacksPage(input.itemsByAccount.get(accountId) ?? [], false);
    },
  } as unknown as OfapiClient;
}

describe("OFAPI chargebacks reconcile", () => {
  it("writes negated chargeback rows without demoting the original settled spend", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("cb-of", "acct_cb");
    // The original settled payment the chargeback reverses — must survive.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      transactionId: "pay-1",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "settled",
      grossAmountMills: 12_340n,
      sourceDestinationAmountMills: 12_340n,
      creatorNetAmountMills: 9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-15T10:00:00.000Z"),
    });

    const calls: ChargebacksCall[] = [];
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls,
        itemsByAccount: new Map([["acct_cb", [chargebackItem("pay-1", "555001")]]]),
      }),
    };

    const first = await runOfapiChargebacksReconcile(appContext);
    expect(first.pages).toHaveLength(1);
    expect(first.pages[0]).toMatchObject({ status: "written", writtenRows: 1 });
    // First run on a page with no chargeback rows walks the FULL history.
    expect(calls[0]?.startDate).toBeUndefined();
    expect(calls[0]?.endDate).toBeUndefined();

    const { rows } = await testDb.pool.query<{
      transaction_id: string;
      canonical_type: string;
      transaction_state: string;
      source: string;
      gross_amount_mills: string;
      creator_net_amount_mills: string;
      platform_fee_mills: string | null;
      vat_amount_mills: string | null;
    }>(`
      select transaction_id, canonical_type::text, transaction_state::text, source,
             gross_amount_mills::text, creator_net_amount_mills::text,
             platform_fee_mills::text, vat_amount_mills::text
      from transactions where platform_account_id = $1
      order by transaction_id
    `, [page.id]);

    expect(rows).toEqual([
      {
        // The original settled row is untouched — the chargeback never shares
        // its transaction_id (payment.id carries a :chargeback suffix).
        transaction_id: "pay-1",
        canonical_type: "tip",
        transaction_state: "posted",
        source: "ofapi:webhook",
        gross_amount_mills: "12340",
        creator_net_amount_mills: "9870",
        platform_fee_mills: null,
        vat_amount_mills: null,
      },
      {
        transaction_id: "pay-1:chargeback",
        canonical_type: "chargeback",
        transaction_state: "posted",
        source: "ofapi:rest",
        gross_amount_mills: "-12340",
        creator_net_amount_mills: "-9870",
        platform_fee_mills: "-2470",
        vat_amount_mills: "-1500",
      },
    ]);

    // Re-run: converges, adds nothing, and now uses the trailing window.
    const second = await runOfapiChargebacksReconcile(appContext);
    expect(second.pages[0]).toMatchObject({ status: "written", writtenRows: 1 });
    expect(calls[1]?.startDate).toBeDefined();
    expect(calls[1]?.endDate).toBeDefined();
    expect(new Date(calls[1]!.endDate!.replace(" ", "T") + "Z").getTime())
      .toBeGreaterThan(new Date(calls[1]!.startDate!.replace(" ", "T") + "Z").getTime());
    const { rows: countRows } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(countRows).toEqual([{ n: "2" }]);
  });

  it("discards a truncated first full-history walk so the 90-day window never locks in early", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("cb-trunc-of", "acct_trunc");
    // 101 chargebacks = one full API page (100) + a tail page. The walk needs
    // two requests to complete.
    const items = Array.from({ length: 101 }, (_, i) =>
      chargebackItem(`pay-t${i}`, String(600_000 + i)));
    const calls: ChargebacksCall[] = [];
    const pagedClient = {
      async listChargebacks(
        _context: unknown,
        accountId: string,
        params: { limit?: number; offset?: number; startDate?: string; endDate?: string },
      ): Promise<OfapiListPage> {
        const offset = params.offset ?? 0;
        calls.push({
          accountId,
          offset,
          startDate: params.startDate,
          endDate: params.endDate,
        });
        const slice = items.slice(offset, offset + (params.limit ?? 100));
        return chargebacksPage(slice, offset + slice.length < items.length);
      },
    } as unknown as OfapiClient;

    // Day budget of 1 credit: the guard admits the first request, then blocks
    // before the second — truncating the initial full-history walk.
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiChargebacksReconcileEnabled: true,
        ofapiCreditLedgerEnabled: true,
        ofapiBackfillDailyCreditBudget: 1,
      }),
      ofapi: pagedClient,
    };
    const truncated = await runOfapiChargebacksReconcile(appContext);
    expect(truncated.pages[0]).toMatchObject({
      status: "blocked",
      reason: "ofapi_daily_credit_budget",
      apiPages: 1,
      rawRows: 100,
      writtenRows: 0,
    });
    // Nothing landed — otherwise pageHasChargebackRows would flip this page
    // into the trailing window with 1 of 101 rows forever missing history.
    const { rows: afterTruncation } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(afterTruncation).toEqual([{ n: "0" }]);

    // Next run with budget available: STILL a full-history walk, completes,
    // writes everything.
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiChargebacksReconcileEnabled: true,
        ofapiCreditLedgerEnabled: true,
        ofapiBackfillDailyCreditBudget: 200,
      }),
      ofapi: pagedClient,
    };
    const completed = await runOfapiChargebacksReconcile(appContext);
    expect(calls[1]?.startDate).toBeUndefined();
    expect(calls[2]?.offset).toBe(100);
    expect(completed.pages[0]).toMatchObject({ status: "written", writtenRows: 101 });
    const { rows: afterCompletion } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(afterCompletion).toEqual([{ n: "101" }]);
  });

  it("isolates a failed page, keeps the worker failed, and resolves one global incident after a clean run", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const failedPage = await seedOfapiPage("a-cb-fail", "acct_cb_fail");
    const healthyPage = await seedOfapiPage("b-cb-healthy", "acct_cb_healthy");
    let vendorFailure = true;
    const calls: ChargebacksCall[] = [];
    appContext = {
      ...appContext,
      ofapi: {
        async listChargebacks(
          _context: unknown,
          accountId: string,
          params: { offset?: number; startDate?: string; endDate?: string },
        ): Promise<OfapiListPage> {
          calls.push({
            accountId,
            offset: params.offset ?? 0,
            startDate: params.startDate,
            endDate: params.endDate,
          });
          if (accountId === "acct_cb_fail" && vendorFailure) {
            throw new Error("scripted OFAPI validation failure");
          }
          return chargebacksPage(
            accountId === "acct_cb_healthy" ? [chargebackItem("pay-healthy", "555010")] : [],
            false,
          );
        },
      } as unknown as OfapiClient,
    };

    const first = await runOfapiChargebacksReconcile(appContext);
    expect(first.pages).toEqual([
      expect.objectContaining({
        pageLabel: failedPage.label,
        status: "failed",
        reason: "scripted OFAPI validation failure",
      }),
      expect.objectContaining({
        pageLabel: healthyPage.label,
        status: "written",
        writtenRows: 1,
      }),
    ]);
    const { rows: healthyRows } = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from transactions where platform_account_id = $1 and transaction_id = 'pay-healthy:chargeback'",
      [healthyPage.id],
    );
    expect(healthyRows).toEqual([{ n: 1 }]);

    let incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      incidentKey: "ofapi_chargebacks_reconcile_failed:global",
      kind: "ofapi_chargebacks_reconcile_failed",
      platformAccountId: null,
      status: "open",
    });

    // A second failing pass refreshes the same global latch. The worker still
    // marks its pg-boss job failed, but only after the healthy page ran.
    let workerHandler: (() => Promise<void>) | null = null;
    await startOfapiChargebacksWorker(appContext, {
      async work(_queue, _options, handler) {
        workerHandler = handler;
        return null;
      },
    });
    expect(workerHandler).not.toBeNull();
    await expect(workerHandler!()).rejects.toThrow(
      "OFAPI chargebacks reconcile failed for 1 page(s)",
    );
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.status).toBe("open");
    expect(calls.filter((call) => call.accountId === "acct_cb_healthy")).toHaveLength(2);

    vendorFailure = false;
    const recovered = await runOfapiChargebacksReconcile(appContext);
    expect(recovered.pages.map((page) => page.status)).toEqual(["written", "written"]);
    incidents = await listNotificationIncidents(appContext.db);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "ofapi_chargebacks_reconcile_failed",
      status: "resolved",
    });
  });

  it("keeps the failure incident open when a trailing walk writes a budget-truncated partial", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedOfapiPage("cb-partial", "acct_cb_partial");
    // Force trailing mode without spending a vendor call. The failed pass
    // below conservatively leaves one backfill credit reserved.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "seed:chargeback",
      rawType: "ofapi:chargeback",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -1_000n,
      sourceDestinationAmountMills: -1_000n,
      creatorNetAmountMills: -800n,
      senderId: "555000",
      occurredAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    appContext = {
      ...appContext,
      ofapi: {
        async listChargebacks() {
          throw new Error("scripted reconcile failure");
        },
      } as unknown as OfapiClient,
    };
    const failed = await runOfapiChargebacksReconcile(appContext);
    expect(failed.pages[0]?.status).toBe("failed");
    expect((await listNotificationIncidents(appContext.db))[0]?.status).toBe("open");

    const partialItems = Array.from({ length: 100 }, (_, index) =>
      chargebackItem(`partial-${index}`, String(700_000 + index)));
    appContext = {
      ...createTestAppContext(testDb, {
        ofapiChargebacksReconcileEnabled: true,
        ofapiCreditLedgerEnabled: true,
        // One credit is already held by the failed attempt. Admit exactly one
        // page, then block before page two.
        ofapiBackfillDailyCreditBudget: 2,
      }),
      ofapi: {
        async listChargebacks(): Promise<OfapiListPage> {
          return chargebacksPage(partialItems, true);
        },
      } as unknown as OfapiClient,
    };

    const partial = await runOfapiChargebacksReconcile(appContext);
    expect(partial.pages[0]).toMatchObject({
      status: "blocked",
      reason: "ofapi_daily_credit_budget",
      apiPages: 1,
      rawRows: 100,
      writtenRows: 100,
    });
    const { rows: transactionCount } = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(transactionCount).toEqual([{ n: 101 }]);
    expect((await listNotificationIncidents(appContext.db))[0]).toMatchObject({
      kind: "ofapi_chargebacks_reconcile_failed",
      status: "open",
    });
  });

  // The 200 body the pinned (2026-09-05) and live OFAPI spec document for
  // GET /{account}/chargebacks: `data.list` plus an informational
  // `data.marker`, no `hasMore`, no `_pagination`. From 2026-09-08 the client
  // refused this body ("continuation unavailable") on every daily run.
  function vendorChargebacksBody(list: Record<string, unknown>[]) {
    return {
      data: { list, marker: 1_757_300_000 },
      _meta: {
        _credits: { used: 1, balance: 90_000, note: "Always" },
        _cache: { is_cached: false, note: "Cache disabled for this endpoint" },
        _rate_limits: { limit_minute: 1000, limit_day: 50000, remaining_minute: 999, remaining_day: 49994 },
      },
    };
  }

  it("reads the vendor's real chargebacks body through the client and catches up a month of failed runs once", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const DAY_MS = 24 * 60 * 60 * 1000;
    const page = await seedOfapiPage("cb-real", "acct_real");
    // A chargeback written before the outage puts the page in trailing mode.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "before-outage:chargeback",
      rawType: "ofapi:chargeback",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -1_000n,
      sourceDestinationAmountMills: -1_000n,
      creatorNetAmountMills: -800n,
      senderId: "555000",
      occurredAt: new Date(Date.now() - 60 * DAY_MS),
    });

    // The outage as production saw it: the client threw on the body, the page
    // failed, the global incident opened.
    appContext = {
      ...appContext,
      ofapi: {
        async listChargebacks() {
          throw new OfapiApiError("OFAPI list page continuation unavailable", 200, null);
        },
      } as unknown as OfapiClient,
    };
    const failed = await runOfapiChargebacksReconcile(appContext);
    expect(failed.pages[0]).toMatchObject({
      status: "failed",
      reason: "OFAPI list page continuation unavailable",
    });
    expect((await listNotificationIncidents(appContext.db))[0]?.status).toBe("open");

    // 103 vendor rows raised during the outage, 32 days ago. Row 100 is row 99
    // again: a chargeback that shifted across the offset boundary mid-walk.
    const missedAt = new Date(Date.now() - 32 * DAY_MS);
    const vendorList = Array.from({ length: 103 }, (_, index) => {
      const id = index === 100 ? 99 : index;
      return { ...chargebackItem(`pay-real-${id}`, String(800_000 + id)), createdAt: missedAt.toISOString() };
    });
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit"));
      return new Response(JSON.stringify(vendorChargebacksBody(vendorList.slice(offset, offset + limit))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    appContext = { ...appContext, ofapi: createOfapiClient({ apiKey: "test", restDelayMs: 0 }) };

    const caughtUp = await runOfapiChargebacksReconcile(appContext);
    // A full page continues, the short page ends the walk: two requests.
    expect(caughtUp.pages[0]).toMatchObject({
      status: "written",
      reason: null,
      apiPages: 2,
      rawRows: 103,
      writtenRows: 102,
    });
    expect(requests.map((url) => url.searchParams.get("offset"))).toEqual(["0", "100"]);
    // The trailing window reaches back past the whole outage.
    const startDate = new Date(`${requests[0]!.searchParams.get("start_date")!.replace(" ", "T")}Z`);
    expect(startDate.getTime()).toBeLessThan(missedAt.getTime());
    expect((await listNotificationIncidents(appContext.db))[0]?.status).toBe("resolved");

    const countRows = async () => (await testDb!.pool.query<{ n: number }>(
      "select count(*)::int as n from transactions where platform_account_id = $1",
      [page.id],
    )).rows[0]!.n;
    expect(await countRows()).toBe(103);

    // Each page the vendor answered is journaled verbatim, with its request.
    const { rows: journal } = await testDb.pool.query<{ payload: Record<string, unknown> }>(`
      select payload from observations
      where kind = 'ofapi_chargebacks' and account_id = $1 and source = 'pull' and platform = 'onlyfans'
      order by id
    `, [page.id]);
    expect(journal.map((row) => row.payload)).toEqual([0, 100].map((offset) => ({
      ofapiAccountId: "acct_real",
      limit: 100,
      offset,
      startDate: requests[0]!.searchParams.get("start_date"),
      endDate: requests[0]!.searchParams.get("end_date"),
      body: vendorChargebacksBody(vendorList.slice(offset, offset + 100)),
    })));
    const { rows: rawRows } = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from sync_raw_payloads where endpoint = 'ofapi_chargebacks' and page_id = $1",
      [page.id],
    );
    expect(rawRows).toEqual([{ n: 2 }]);

    // The next day's run re-reads the same window and adds nothing.
    const again = await runOfapiChargebacksReconcile(appContext);
    expect(again.pages[0]).toMatchObject({ status: "written", apiPages: 2, writtenRows: 102 });
    expect(await countRows()).toBe(103);
  });

  it("journals a page the client refuses, then fails the page as before and writes no money", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-refused", "acct_refused");
    // A body without a list envelope (say, a renamed field): the client
    // refuses it, as it refused every page from 2026-09-08.
    const refused = {
      data: { items: [chargebackItem("pay-refused", "555020")], marker: 1_757_300_000 },
      _meta: { _credits: { used: 1, balance: 90_000 } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refused), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    appContext = { ...appContext, ofapi: createOfapiClient({ apiKey: "test", restDelayMs: 0 }) };

    const result = await runOfapiChargebacksReconcile(appContext);
    expect(result.pages[0]).toMatchObject({
      status: "failed",
      reason: "OFAPI list page shape unavailable",
    });
    const { rows: journal } = await testDb.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from observations where kind = 'ofapi_chargebacks' and account_id = $1",
      [page.id],
    );
    expect(journal).toEqual([{
      payload: {
        ofapiAccountId: "acct_refused",
        limit: 100,
        offset: 0,
        startDate: null,
        endDate: null,
        body: refused,
      },
    }]);
    const { rows: money } = await testDb.pool.query<{ n: number }>(
      "select count(*)::int as n from transactions where platform_account_id = $1",
      [page.id],
    );
    expect(money).toEqual([{ n: 0 }]);
    expect((await listNotificationIncidents(appContext.db))[0]?.status).toBe("open");
  });

  it("a journal insert that fails logs and reports only the sanitized summary, never the vendor body", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const lines: string[] = [];
    const logger = createLogger("debug", { write: (line: string) => { lines.push(line); } });
    const acceptedPage = await seedOfapiPage("cb-leak-accepted", "acct_leak_accepted");
    const refusedPage = await seedOfapiPage("cb-leak-refused", "acct_leak_refused");
    // The fan and payment the bodies carry; neither may reach a log line, a
    // page result or the incident text.
    const secret = chargebackItem("pay-secret-7f3a", "555031");
    const bodies: Record<string, unknown> = {
      acct_leak_accepted: vendorChargebacksBody([secret]),
      acct_leak_refused: { data: { items: [secret] }, _meta: { _credits: { used: 1, balance: 90_000 } } },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const account = url.pathname.split("/").find((segment) => segment.startsWith("acct_"))!;
      return new Response(JSON.stringify(bodies[account]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    // The journal INSERT fails the way a statement timeout does: the driver's
    // error then carries the bound values — the whole body — in its message.
    await testDb.pool.query(`
      create or replace function test_fail_chargebacks_journal() returns trigger
      language plpgsql as $$
      begin
        raise exception 'canceling statement due to statement timeout' using errcode = '57014';
      end $$
    `);
    await testDb.pool.query(`
      create trigger test_fail_chargebacks_journal before insert on sync_raw_payloads
      for each row when (new.endpoint = 'ofapi_chargebacks')
      execute function test_fail_chargebacks_journal()
    `);
    try {
      appContext = {
        ...createTestAppContext(testDb, {
          ofapiChargebacksReconcileEnabled: true,
          ofapiCreditLedgerEnabled: true,
          logger,
        }),
        ofapi: createOfapiClient({ apiKey: "test", restDelayMs: 0 }),
      };
      const result = await runOfapiChargebacksReconcile(appContext);

      const byLabel = new Map(result.pages.map((page) => [page.pageLabel, page]));
      expect(byLabel.get(acceptedPage.label)).toMatchObject({
        status: "failed",
        reason: expect.stringMatching(/^OFAPI chargebacks page not journaled: \w+ while journal chargebacks page \(57014\)$/),
      });
      expect(byLabel.get(refusedPage.label)).toMatchObject({
        status: "failed",
        reason: "OFAPI list page shape unavailable",
      });
      const incident = (await listNotificationIncidents(appContext.db))[0];
      expect(incident?.status).toBe("open");

      const output = lines.join("");
      // Both failures were logged…
      expect(output).toContain("OFAPI chargebacks: could not journal the refused page");
      expect(output).toMatch(/\w+ while journal chargebacks page \(57014\)/);
      // …and nothing of the body went with them.
      for (const text of [output, JSON.stringify(result), incident?.errorSummary ?? ""]) {
        expect(text).not.toContain("pay-secret-7f3a");
        expect(text).not.toContain("u555031");
        expect(text).not.toContain("params:");
      }
    } finally {
      await testDb.pool.query("drop trigger if exists test_fail_chargebacks_journal on sync_raw_payloads");
      await testDb.pool.query("drop function if exists test_fail_chargebacks_journal()");
    }
  });

  // ——— W7.3 (A21+B4, decision #132): negation guards ———

  function settledOriginal(pageId: number, transactionId: string) {
    return upsertTransactionWithNegationGuards(appContext.db, {
      platformAccountId: pageId,
      source: "ofapi:webhook",
      transactionId,
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "settled",
      grossAmountMills: 12_340n,
      sourceDestinationAmountMills: 12_340n,
      creatorNetAmountMills: 9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-15T10:00:00.000Z"),
    });
  }

  function reversalRow(pageId: number, baseId: string) {
    return upsertTransactionWithNegationGuards(appContext.db, {
      platformAccountId: pageId,
      source: "ofapi:webhook",
      transactionId: `${baseId}:reversal`,
      rawType: "ofapi:tip",
      canonicalType: "refund",
      transactionState: "posted",
      rawStatus: "refunded",
      grossAmountMills: -12_340n,
      sourceDestinationAmountMills: -12_340n,
      creatorNetAmountMills: -9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-20T10:00:00.000Z"),
    });
  }

  async function rowState(pageId: number, transactionId: string) {
    const { rows } = await testDb!.pool.query<{
      is_active: boolean;
      inactive_reason: string | null;
    }>(
      "select is_active, inactive_reason::text from transactions where platform_account_id = $1 and transaction_id = $2",
      [pageId, transactionId],
    );
    return rows[0] ?? null;
  }

  async function activeNetMills(pageId: number) {
    const { rows } = await testDb!.pool.query<{ net: string }>(
      "select coalesce(sum(creator_net_amount_mills), 0)::text as net from transactions where platform_account_id = $1 and is_active",
      [pageId],
    );
    return rows[0]!.net;
  }

  it("guard 1 (B4): a chargeback with an active reversal twin writes INACTIVE — never double-negate", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-twin", "acct_twin");
    await settledOriginal(page.id, "pay-1");
    const reversal = await reversalRow(page.id, "pay-1");
    expect(reversal.suppressedAs).toBeNull();

    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_twin", [chargebackItem("pay-1", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);

    expect(await rowState(page.id, "pay-1:reversal")).toEqual({
      is_active: true,
      inactive_reason: null,
    });
    expect(await rowState(page.id, "pay-1:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "superseded_duplicate_negation",
    });
    // Net over ACTIVE rows = settled + one negation = 0.
    expect(await activeNetMills(page.id)).toBe("0");
  });

  it("guard 1 symmetric: a reversal landing after an active chargeback is the suppressed twin", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-sym", "acct_sym");
    await settledOriginal(page.id, "pay-2");
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_sym", [chargebackItem("pay-2", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);

    const reversal = await reversalRow(page.id, "pay-2");
    expect(reversal.suppressedAs).toBe("superseded_duplicate_negation");
    expect(await rowState(page.id, "pay-2:reversal")).toEqual({
      is_active: false,
      inactive_reason: "superseded_duplicate_negation",
    });
    expect(await activeNetMills(page.id)).toBe("0");
  });

  it("guard 2 (A21): a negative with no settled original writes INACTIVE; a late original reactivates it (net 0)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-orphan", "acct_orphan");
    // Chargeback for a payment we never saw settle.
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_orphan", [chargebackItem("pay-3", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);
    expect(await rowState(page.id, "pay-3:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "reversal_without_settled_original",
    });
    expect(await activeNetMills(page.id)).toBe("0");

    // The original settles late → the fixup reactivates the negation.
    const original = await settledOriginal(page.id, "pay-3");
    expect(original.reactivatedFrom).not.toBeNull();
    expect(await rowState(page.id, "pay-3:chargeback")).toEqual({
      is_active: true,
      inactive_reason: null,
    });
    expect(await activeNetMills(page.id)).toBe("0");
  });

  it("guard 0: a redelivery re-upsert NEVER resurrects a suppressed negation (sticky)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-sticky", "acct_sticky");
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls: [],
        itemsByAccount: new Map([["acct_sticky", [chargebackItem("pay-4", "555001")]]]),
      }),
    };
    await runOfapiChargebacksReconcile(appContext);
    expect((await rowState(page.id, "pay-4:chargeback"))!.is_active).toBe(false);

    // Redelivery through the PLAIN upsert (the pre-guard writer shape) —
    // the conflict-set itself must preserve the suppression.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "pay-4:chargeback",
      rawType: "ofapi:chargeback",
      canonicalType: "chargeback",
      transactionState: "posted",
      rawStatus: "undo",
      grossAmountMills: -12_340n,
      sourceDestinationAmountMills: -12_340n,
      creatorNetAmountMills: -9_870n,
      senderId: "555001",
      occurredAt: new Date("2026-06-20T10:00:00.000Z"),
    });
    expect(await rowState(page.id, "pay-4:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "reversal_without_settled_original",
    });
  });

  it("repair CLI: deactivates census anomalies (orphans + duplicate twins, reversal canonical) and rebuilds", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-repair", "acct_repair");
    // Pre-guard world: seed an ACTIVE orphan reversal and an ACTIVE
    // double-negative pair via the plain upsert.
    const plain = (transactionId: string, net: bigint, canonicalType: "tip" | "refund" | "chargeback", state: "posted" | "pending" = "posted") =>
      upsertTransaction(appContext.db, {
        platformAccountId: page.id,
        source: "ofapi:webhook",
        transactionId,
        rawType: "ofapi:tip",
        canonicalType,
        transactionState: state,
        rawStatus: "x",
        grossAmountMills: net,
        sourceDestinationAmountMills: net,
        creatorNetAmountMills: net,
        senderId: "555001",
        occurredAt: new Date("2026-06-18T10:00:00.000Z"),
      });
    await plain("orphan-1:reversal", -5_000n, "refund");
    await plain("dup-1", 8_000n, "tip");
    await plain("dup-1:reversal", -8_000n, "refund");
    await plain("dup-1:chargeback", -8_000n, "chargeback");

    const dry = await repairNegationAnomalies(appContext, { dryRun: true });
    expect(dry).toMatchObject({ pairs: 1, deactivated: 0, dryRun: true });
    expect((await rowState(page.id, "orphan-1:reversal"))!.is_active).toBe(true);

    const real = await repairNegationAnomalies(appContext, { dryRun: false });
    expect(real.pairs).toBe(1);
    expect(real.deactivated).toBeGreaterThanOrEqual(2);
    // Canonical-twin pin: the :reversal stays, the :chargeback deactivates.
    expect((await rowState(page.id, "dup-1:reversal"))!.is_active).toBe(true);
    expect(await rowState(page.id, "dup-1:chargeback")).toEqual({
      is_active: false,
      inactive_reason: "superseded_duplicate_negation",
    });
    expect(await rowState(page.id, "orphan-1:reversal")).toEqual({
      is_active: false,
      inactive_reason: "reversal_without_settled_original",
    });
    // dup pair nets 0 over active rows; orphan no longer subtracts.
    expect(await activeNetMills(page.id)).toBe("0");
  });

  // ——— W7.4 (A47): pending settle-or-expire ———

  it("stale-pending listing + targeted retire: only still-pending rows expire", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedOfapiPage("cb-pending", "acct_pending");
    const pendingAt = new Date(Date.now() - 10 * 86_400_000);
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      transactionId: "pend-1",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 4_000n,
      sourceDestinationAmountMills: 4_000n,
      creatorNetAmountMills: 3_200n,
      senderId: "555001",
      occurredAt: pendingAt,
    });
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:webhook",
      transactionId: "pend-2",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 1_000n,
      sourceDestinationAmountMills: 1_000n,
      creatorNetAmountMills: 800n,
      senderId: "555001",
      occurredAt: new Date(), // fresh — not stale
    });

    const stale = await listStalePendingOfapiTransactions(appContext.db, {
      olderThan: new Date(Date.now() - 7 * 86_400_000),
    });
    const staleIds = stale.filter((row) => row.platformAccountId === page.id);
    expect(staleIds.map((row) => row.transactionId)).toEqual(["pend-1"]);

    // Simulate the rescan settling pend-1 BEFORE the retire pass: the
    // targeted retire re-checks state and must not touch it.
    await upsertTransaction(appContext.db, {
      platformAccountId: page.id,
      source: "ofapi:rest",
      transactionId: "pend-1",
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: "done",
      grossAmountMills: 4_000n,
      sourceDestinationAmountMills: 4_000n,
      creatorNetAmountMills: 3_200n,
      senderId: "555001",
      occurredAt: pendingAt,
    });
    const retired = await retireStalePendingTransactionsById(appContext.db, {
      platformAccountId: page.id,
      ids: staleIds.map((row) => row.id),
    });
    expect(retired).toBe(0);
    expect((await rowState(page.id, "pend-1"))!.is_active).toBe(true);

    // And a row the rescan did NOT settle retires.
    const { rows } = await testDb.pool.query<{ id: number }>(
      "update transactions set transaction_state = 'pending' where platform_account_id = $1 and transaction_id = 'pend-1' returning id",
      [page.id],
    );
    const retired2 = await retireStalePendingTransactionsById(appContext.db, {
      platformAccountId: page.id,
      ids: [rows[0]!.id],
    });
    expect(retired2).toBe(1);
    expect(await rowState(page.id, "pend-1")).toEqual({
      is_active: false,
      inactive_reason: "missing_from_sync_window",
    });
  });

  it("pending reconcile is a no-op with truth ingest disabled", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiSpendTransactionIngestEnabled: false,
    });
    const result = await runOfapiPendingReconcile(appContext);
    expect(result).toMatchObject({ skipped: "disabled", stalePendings: 0, expired: 0 });
  });

  // Every listTransactions call answers the same single page.
  function restTransactionsClient(input: {
    items: Record<string, unknown>[];
    calls: string[];
  }): OfapiClient {
    return {
      async listTransactions(_context: unknown, accountId: string): Promise<OfapiListPage> {
        input.calls.push(accountId);
        return {
          items: input.items,
          hasNextPage: false,
          nextMarker: null,
          nextPageUrl: null,
          meta: null,
        };
      },
    } as unknown as OfapiClient;
  }

  const STALE_AT = () => new Date(Date.now() - 10 * 86_400_000);

  function restTip(id: string, status: string) {
    return {
      id,
      type: "tip",
      status,
      amount: "4.00",
      net: "3.20",
      createdAt: STALE_AT().toISOString(),
      user: { id: 555101 },
    };
  }

  async function seedStalePending(pageId: number, transactionId: string) {
    await upsertTransaction(appContext.db, {
      platformAccountId: pageId,
      source: "ofapi:webhook",
      transactionId,
      rawType: "ofapi:tip",
      canonicalType: "tip",
      transactionState: "pending",
      rawStatus: "pending",
      grossAmountMills: 4_000n,
      sourceDestinationAmountMills: 4_000n,
      creatorNetAmountMills: 3_200n,
      senderId: "555101",
      occurredAt: STALE_AT(),
    });
  }

  function reconcileContext() {
    return createTestAppContext(testDb!, {
      ofapiCreditLedgerEnabled: true,
      ofapiSpendTransactionIngestEnabled: true,
    });
  }

  it("a rescan refused at the credit floor retires nothing (2026-09-06)", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = reconcileContext();
    const page = await seedOfapiPage("pend-floor", "acct_pend_floor");
    await seedStalePending(page.id, "floor-1");
    // The incident balance: fresh, 479 credits under the default 500 floor.
    await testDb.pool.query(
      "insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,479,now()) on conflict(id) do update set last_balance=479,last_balance_at=now()",
    );
    const calls: string[] = [];
    appContext = { ...appContext, ofapi: restTransactionsClient({ items: [], calls }) };

    const result = await runOfapiPendingReconcile(appContext);

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      stalePendings: 1,
      pagesTouched: 0,
      expired: 0,
      unresolved: 0,
      deferred: 1,
      blockedPages: [],
      unscannedPages: [page.label],
    });
    expect(await rowState(page.id, "floor-1")).toEqual({ is_active: true, inactive_reason: null });
  });

  it("an empty rescan feed retires nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = reconcileContext();
    const page = await seedOfapiPage("pend-empty", "acct_pend_empty");
    await seedStalePending(page.id, "empty-1");
    const calls: string[] = [];
    appContext = { ...appContext, ofapi: restTransactionsClient({ items: [], calls }) };

    const result = await runOfapiPendingReconcile(appContext);

    expect(calls).toEqual(["acct_pend_empty"]);
    expect(result).toMatchObject({ expired: 0, deferred: 1, unscannedPages: [page.label] });
    expect(await rowState(page.id, "empty-1")).toEqual({ is_active: true, inactive_reason: null });
  });

  it("a full rescan settles what it lists and retires what it no longer lists", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = reconcileContext();
    const page = await seedOfapiPage("pend-full", "acct_pend_full");
    await seedStalePending(page.id, "settle-1");
    await seedStalePending(page.id, "gone-1");
    const calls: string[] = [];
    appContext = {
      ...appContext,
      ofapi: restTransactionsClient({ items: [restTip("settle-1", "done")], calls }),
    };

    const result = await runOfapiPendingReconcile(appContext);

    expect(calls).toEqual(["acct_pend_full"]);
    expect(result).toMatchObject({
      stalePendings: 2,
      pagesTouched: 1,
      expired: 1,
      settledByRescan: 1,
      unresolved: 0,
      deferred: 0,
      unscannedPages: [],
    });
    expect(await rowState(page.id, "settle-1")).toEqual({ is_active: true, inactive_reason: null });
    expect(await rowState(page.id, "gone-1")).toEqual({
      is_active: false,
      inactive_reason: "missing_from_sync_window",
    });
  });

  it("does nothing with the flag off", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    appContext = createTestAppContext(testDb, {
      ofapiChargebacksReconcileEnabled: false,
      ofapiCreditLedgerEnabled: true,
    });
    await seedOfapiPage("cb-off-of", "acct_cb_off");
    const calls: ChargebacksCall[] = [];
    appContext = {
      ...appContext,
      ofapi: chargebacksClient({
        calls,
        itemsByAccount: new Map([["acct_cb_off", [chargebackItem("pay-9", "555009")]]]),
      }),
    };

    const result = await runOfapiChargebacksReconcile(appContext);
    expect(result.pages).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

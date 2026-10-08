// The Spenders `asOf` stamp means "money data complete as of", not "when the
// numbers last changed". On 2026-10-08 the chat extension showed «данные на
// 15:03» from 15:03 until after 18:40 MSK on lora-vip-of: the stamp was the
// spender rebuild watermark, which moves only when money is projected, while
// 20-129 other OFAPI deliveries an hour kept proving the numbers current.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  getSpenderMoneyAsOf,
  getSpenderProjectionAsOf,
  rebuildSpenderProjections,
  setPageOfapiAccountId,
  upsertOfapiSpendProjectionEvent,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { applyOfapiSpendProjectionTransactions } from "../apps/runtime/src/services/ofapi-spend-transaction-ingest.ts";
import { getPageSpenderAutoLists } from "../apps/runtime/src/services/spenders.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let deliveryCounter = 0;

const ACCOUNT = "acct_main0000000000000000000000000";
const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * HOUR_MS);
}

async function seedOfapiPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, { slug: `model-${label}`, name: `Model ${label}` });
  const page = await createOnlyFansPage(appContext.db, { modelId: model!.id, label });
  // The mapping assigns transactions_writer = 'ofapi' (Stage 13).
  await setPageOfapiAccountId(appContext.db, { pageId: page!.id, ofapiAccountId });
  return page!;
}

/** One journaled OFAPI delivery, shaped as the receiver and the settle leave it. */
async function journal(input: {
  eventType: string;
  receivedAt: Date;
  ofapiAccountId?: string | null;
  /** Set by the settle; null while pending. */
  pageId?: number | null;
  status?: "pending" | "processed" | "skipped";
}) {
  deliveryCounter += 1;
  const status = input.status ?? "processed";
  const { rows } = await testDb!.pool.query<{ id: string }>(
    `insert into ofapi_webhook_events (
       idempotency_key, event_type, ofapi_account_id, platform_account_id,
       payload, status, received_at, processed_at
     ) values ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7)
     returning id::text`,
    [
      `evt_${String(deliveryCounter).padStart(20, "0")}`,
      input.eventType,
      input.ofapiAccountId === undefined ? ACCOUNT : input.ofapiAccountId,
      status === "pending" ? null : input.pageId ?? null,
      status,
      input.receivedAt,
      status === "pending" ? null : input.receivedAt,
    ],
  );
  return Number(rows[0]!.id);
}

/** The projection's row for a settled transactions.new delivery. */
async function project(input: { journalId: number; pageId: number; transactionId: string; occurredAt: Date }) {
  await upsertOfapiSpendProjectionEvent(appContext.db, {
    domainKey: `ofapi:${ACCOUNT}:tx:${input.transactionId}`,
    projectionStatus: "projected",
    sourceEventType: "transactions.new",
    sourceIdempotencyKey: `idem-${input.transactionId}`,
    journalId: input.journalId,
    ofapiAccountId: ACCOUNT,
    pageId: input.pageId,
    fanPlatformUserId: "1000003",
    transactionId: input.transactionId,
    occurredAt: input.occurredAt,
    category: "message",
    currency: "USD",
    grossAmountMills: 17_000n,
    creatorNetAmountMills: 13_600n,
    eventStatus: "settled",
  });
}

async function pageStamp(label: string, app: AppContext = appContext) {
  const response = await getPageSpenderAutoLists(app, label);
  expect(response.period.asOf).toBe(response.asOf);
  return response.asOf;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  deliveryCounter = 0;
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {
    ofapiSpendProjectionShadowEnabled: true,
    ofapiSpendTransactionIngestEnabled: true,
  });
});

afterAll(async () => {
  await testDb?.stop();
});

describe("Spenders asOf: money data complete as of", () => {
  it("follows a quiet page's webhook stream instead of its last money rebuild", async () => {
    const page = await seedOfapiPage("lora-vip-of", ACCOUNT);
    const rebuiltAt = hoursAgo(4);
    await rebuildSpenderProjections(appContext.db, page.id, null, rebuiltAt);
    const heardAt = hoursAgo(1);
    await journal({ eventType: "users.online", receivedAt: hoursAgo(2), pageId: page.id });
    await journal({ eventType: "messages.received", receivedAt: heardAt, pageId: page.id });

    // The old stamp was the watermark: four hours stale on a live page.
    expect(await pageStamp(page.label)).toBe(heardAt.toISOString());
    // The watermark itself is unchanged — caches keyed on it still turn over
    // only when the numbers can have changed.
    expect(await getSpenderProjectionAsOf(appContext.db, { pageIds: [page.id] }))
      .toEqual(rebuiltAt);
  });

  it("never reads earlier than the last rebuild", async () => {
    const page = await seedOfapiPage("lora-vip-of", ACCOUNT);
    const rebuiltAt = hoursAgo(1);
    await rebuildSpenderProjections(appContext.db, page.id, null, rebuiltAt);
    await journal({ eventType: "users.online", receivedAt: hoursAgo(3), pageId: page.id });

    expect(await pageStamp(page.label)).toBe(rebuiltAt.toISOString());
  });

  it("holds at the arrival of a transactions.new delivery until the ingest has applied it", async () => {
    const page = await seedOfapiPage("lora-vip-of", ACCOUNT);
    await rebuildSpenderProjections(appContext.db, page.id, null, hoursAgo(4));
    const paidAt = hoursAgo(3);
    await journal({ eventType: "messages.received", receivedAt: hoursAgo(1), pageId: page.id });

    // 1. Received, not settled yet (no page on the row until the settle).
    const journalId = await journal({ eventType: "transactions.new", receivedAt: paidAt, status: "pending" });
    expect(await pageStamp(page.label)).toBe(paidAt.toISOString());

    // 2. Settled to the page, not projected yet.
    await testDb!.pool.query(
      "update ofapi_webhook_events set status = 'skipped', platform_account_id = $2, processed_at = received_at where id = $1",
      [journalId, page.id],
    );
    expect(await pageStamp(page.label)).toBe(paidAt.toISOString());

    // 3. Projected, not applied to transaction truth yet.
    await project({ journalId, pageId: page.id, transactionId: "tx-1", occurredAt: paidAt });
    expect(await pageStamp(page.label)).toBe(paidAt.toISOString());

    // 4. Applied: the ingest rebuilds the page, the stamp moves on.
    const before = Date.now();
    expect(await applyOfapiSpendProjectionTransactions(appContext)).toBe(1);
    const watermark = await getSpenderProjectionAsOf(appContext.db, { pageIds: [page.id] });
    expect(watermark!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await pageStamp(page.label)).toBe(watermark!.toISOString());
  });

  it("counts an unsettled delivery from the page's custody history and an unparsed raw one, not another account's", async () => {
    // The page's earlier account stays in its custody after a re-mapping.
    const page = await seedOfapiPage("lora-of", "acct_old000000000000000000000000000");
    await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: null });
    await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: ACCOUNT });
    await rebuildSpenderProjections(appContext.db, page.id, null, hoursAgo(4));
    const heardAt = hoursAgo(1);
    await journal({ eventType: "users.online", receivedAt: heardAt, pageId: page.id });

    const foreign = await journal({
      eventType: "transactions.new",
      receivedAt: hoursAgo(3),
      ofapiAccountId: "acct_other00000000000000000000000000",
      status: "pending",
    });
    expect(await pageStamp(page.label)).toBe(heardAt.toISOString());
    await testDb!.pool.query("delete from ofapi_webhook_events where id = $1", [foreign]);

    const custodyPaidAt = hoursAgo(3);
    const custody = await journal({
      eventType: "transactions.new",
      receivedAt: custodyPaidAt,
      ofapiAccountId: "acct_old000000000000000000000000000",
      status: "pending",
    });
    expect(await pageStamp(page.label)).toBe(custodyPaidAt.toISOString());
    await testDb!.pool.query("delete from ofapi_webhook_events where id = $1", [custody]);

    // A raw capture has no type or account yet: it may be this page's money.
    const rawAt = hoursAgo(2);
    await journal({ eventType: "__raw__", receivedAt: rawAt, ofapiAccountId: null, status: "pending" });
    expect(await pageStamp(page.label)).toBe(rawAt.toISOString());
  });

  it("does not let a stream silent for over a day vouch past the rebuild", async () => {
    const page = await seedOfapiPage("lora-of", ACCOUNT);
    const rebuiltAt = hoursAgo(72);
    await rebuildSpenderProjections(appContext.db, page.id, null, rebuiltAt);
    await journal({ eventType: "users.online", receivedAt: hoursAgo(30), pageId: page.id });

    expect(await pageStamp(page.label)).toBe(rebuiltAt.toISOString());
  });

  it("keeps the watermark where webhooks do not feed the page's money", async () => {
    const page = await seedOfapiPage("lora-vip-of", ACCOUNT);
    const rebuiltAt = hoursAgo(4);
    await rebuildSpenderProjections(appContext.db, page.id, null, rebuiltAt);
    await journal({ eventType: "users.online", receivedAt: hoursAgo(1), pageId: page.id });

    // The truth ingest off: webhook money never reaches the numbers.
    const ingestOff = createTestAppContext(testDb!, { ofapiSpendProjectionShadowEnabled: true });
    expect(await pageStamp(page.label, ingestOff)).toBe(rebuiltAt.toISOString());

    // Another transactions writer owns the page.
    await testDb!.pool.query("update pages set transactions_writer = 'onlymonster' where id = $1", [page.id]);
    expect(await pageStamp(page.label)).toBe(rebuiltAt.toISOString());
  });

  it("leaves Fansly pages and never-rebuilt pages as they were", async () => {
    const model = await createModel(appContext.db, { slug: "fansly-model", name: "Fansly Model" });
    const fansly = await createFanslyPage(appContext.db, { modelId: model!.id, label: "lora-1" });
    const fanslyRebuiltAt = hoursAgo(2);
    await rebuildSpenderProjections(appContext.db, fansly!.id, null, fanslyRebuiltAt);
    expect(await pageStamp("lora-1")).toBe(fanslyRebuiltAt.toISOString());

    // The epoch placeholder means "never rebuilt": no stamp, deliveries or not.
    const fresh = await seedOfapiPage("lora-of", ACCOUNT);
    await journal({ eventType: "users.online", receivedAt: hoursAgo(1), pageId: fresh.id });
    expect(await pageStamp(fresh.label)).toBeNull();
  });

  it("is the earliest page of the scope", async () => {
    const vip = await seedOfapiPage("lora-vip-of", ACCOUNT);
    const free = await seedOfapiPage("lora-of", "acct_free00000000000000000000000000");
    await rebuildSpenderProjections(appContext.db, vip.id, null, hoursAgo(5));
    await rebuildSpenderProjections(appContext.db, free.id, null, hoursAgo(48));
    await journal({ eventType: "users.online", receivedAt: hoursAgo(1), pageId: vip.id });
    const freeHeardAt = hoursAgo(2);
    await journal({
      eventType: "users.online",
      receivedAt: freeHeardAt,
      ofapiAccountId: "acct_free00000000000000000000000000",
      pageId: free.id,
    });

    expect(await getSpenderMoneyAsOf(appContext.db, {
      pageIds: [vip.id, free.id],
      platform: "onlyfans",
      ofapiWebhookMoney: true,
    })).toEqual(freeHeardAt);
  });
});

describe("Spenders asOf query plan", () => {
  /** The statements drizzle put on the wire for `run`, verbatim. */
  async function captureStatements(run: () => Promise<unknown>) {
    const pool = testDb!.pool as unknown as {
      query: (config: unknown, values?: unknown) => Promise<unknown>;
    };
    const original = pool.query.bind(pool);
    const captured: { text: string; values: unknown[] }[] = [];
    pool.query = (config: unknown, values?: unknown) => {
      if (typeof config === "string") {
        captured.push({ text: config, values: (values as unknown[]) ?? [] });
      } else if (config && typeof (config as { text?: unknown }).text === "string") {
        const record = config as { text: string; values?: unknown[] };
        captured.push({ text: record.text, values: (values as unknown[]) ?? record.values ?? [] });
      }
      return original(config, values);
    };
    try {
      await run();
    } finally {
      pool.query = original;
    }
    return captured;
  }

  it(
    "reads the journal through page-and-time indexes, never by walking the deliveries since the rebuild",
    async () => {
      const pool = testDb!.pool;
      const vip = await seedOfapiPage("lora-vip-of", ACCOUNT);
      const free = await seedOfapiPage("lora-of", "acct_free00000000000000000000000000");

      // 60 000 deliveries over ~7 days, the prod mix: transactions.new ~0.1 %,
      // the rest messages, presence and typing, both pages busy.
      await pool.query(
        `
        insert into ofapi_webhook_events (
          idempotency_key, event_type, ofapi_account_id, platform_account_id,
          payload, status, received_at, processed_at
        )
        select
          'bulk_' || lpad(n::text, 20, '0'),
          case
            when n % 1000 in (0, 1) then 'transactions.new'
            when n % 3 = 0 then 'messages.received'
            when n % 3 = 1 then 'users.online'
            else 'users.typing'
          end,
          case when n % 2 = 0 then $1 else $2 end,
          case when n % 2 = 0 then $3::bigint else $4::bigint end,
          '{}'::jsonb,
          case when n % 1000 in (0, 1) then 'skipped' else 'processed' end,
          now() - make_interval(secs => n * 10),
          now() - make_interval(secs => n * 10)
        from generate_series(1, 60000) as n
      `,
        [ACCOUNT, "acct_free00000000000000000000000000", vip.id, free.id],
      );
      await rebuildSpenderProjections(appContext.db, vip.id, null, hoursAgo(1));
      // The free page's last money is a week back.
      await rebuildSpenderProjections(appContext.db, free.id, null, hoursAgo(24 * 6));
      await pool.query("vacuum analyze ofapi_webhook_events");
      await pool.query("analyze ofapi_spend_projection_events");

      const statements = await captureStatements(() =>
        getSpenderMoneyAsOf(appContext.db, {
          pageIds: [vip.id, free.id],
          platform: "onlyfans",
          ofapiWebhookMoney: true,
        })
      );
      const probe = statements.find((statement) => statement.text.includes("union all"));
      expect(probe).toBeDefined();

      const plan = (await pool.query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers) ${probe!.text}`,
        probe!.values,
      )).rows.map((row) => row["QUERY PLAN"]).join("\n");

      // The money probe of each page reads only that page's transactions.new
      // rows since its rebuild. The paths it replaces cost 115 ms and 3.3 s on
      // prod: every delivery since the rebuild, of the page or of every page.
      expect(plan.match(/using ofapi_webhook_events_transactions_page_received_idx/g)).toHaveLength(2);
      expect(plan).not.toContain("Seq Scan on ofapi_webhook_events");
      expect(plan).not.toContain("Bitmap Heap Scan on ofapi_webhook_events");
      // Every other read of the journal is bounded: the pending backlog, or a
      // time bound (the heard probe walks at most its window, whichever index
      // the planner takes).
      const lines = plan.split("\n");
      lines.forEach((line, index) => {
        if (!/Scan.* on ofapi_webhook_events/.test(line)) {
          return;
        }
        expect(lines[index + 1]).toMatch(/Index Cond: .*(received_at > |status = 'pending')/);
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS * 2,
  );
});

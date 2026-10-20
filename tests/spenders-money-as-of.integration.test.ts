// The Spenders `asOf` stamp means "money data complete as of", not "when the
// numbers last changed". On 2026-10-08 the chat extension showed «данные на
// 15:03» from 15:03 until after 18:40 MSK on lora-vip-of: the stamp was the
// spender rebuild watermark, which moves only when money is projected, while
// 20-129 other OFAPI deliveries an hour kept proving the numbers current.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
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

  it("does not let a stream silent for over a day vouch past the rebuild", async () => {
    const page = await seedOfapiPage("lora-of", ACCOUNT);
    const rebuiltAt = hoursAgo(72);
    await rebuildSpenderProjections(appContext.db, page.id, null, rebuiltAt);
    await journal({ eventType: "users.online", receivedAt: hoursAgo(30), pageId: page.id });

    expect(await pageStamp(page.label)).toBe(rebuiltAt.toISOString());
  });
});

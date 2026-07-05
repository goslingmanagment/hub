import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertOfapiSpendProjectionEvent,
  upsertTransaction,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let journalId = 0;

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    throw new Error("Expected a session cookie");
  }
  return value.split(";")[0]!;
}

async function loginCookie(username: string, password: string) {
  if (!server) {
    throw new Error("server not started");
  }
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode).toBe(200);
  return sessionCookieFrom(login);
}

async function seedUsers() {
  await createUserAccount(appContext, {
    username: "dima",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, {
    username: "lead",
    role: "team_lead",
    password: "lead-secret",
  }, { source: "cli" });
}

async function seedPage(label: string, accountId: string) {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: accountId });
  return page;
}

async function seedShadowTransaction(input: {
  pageId: number;
  accountId: string;
  transactionId: string;
  fanId: string;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  occurredAt: Date;
}) {
  journalId += 1;
  return upsertOfapiSpendProjectionEvent(appContext.db, {
    domainKey: `ofapi:${input.accountId}:tx:${input.transactionId}`,
    projectionStatus: "projected",
    sourceEventType: "transactions.new",
    sourceIdempotencyKey: `idem-${input.transactionId}`,
    journalId,
    ofapiAccountId: input.accountId,
    pageId: input.pageId,
    fanPlatformUserId: input.fanId,
    transactionId: input.transactionId,
    occurredAt: input.occurredAt,
    category: "message",
    currency: "USD",
    grossAmountMills: input.grossAmountMills,
    creatorNetAmountMills: input.creatorNetAmountMills,
    eventStatus: "pending",
  });
}

async function seedCoreTransaction(input: {
  pageId: number;
  transactionId: string;
  fanId: string;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  occurredAt: Date;
}) {
  await upsertTransaction(appContext.db, {
    platformAccountId: input.pageId,
    source: "onlymonster",
    transactionId: input.transactionId,
    rawType: "message",
    canonicalType: "message_purchase",
    transactionState: "pending",
    rawStatus: "pending",
    grossAmountMills: input.grossAmountMills,
    sourceDestinationAmountMills: input.grossAmountMills,
    creatorNetAmountMills: input.creatorNetAmountMills,
    senderId: input.fanId,
    occurredAt: input.occurredAt,
  });
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  journalId = 0;
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { ofapiSpendProjectionShadowEnabled: true });
  await seedUsers();
  server = await buildApiServer(appContext);
  await server.ready();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

afterAll(async () => {
  await testDb?.stop();
});

describe("OFAPI spend shadow comparison", () => {
  it("is owner-only", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/spend/comparison",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const nonOwnerCookie = await loginCookie("lead", "lead-secret");
    const forbidden = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/spend/comparison",
      headers: { cookie: nonOwnerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("classifies shadow spend against core transaction truth without writing truth", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }

    const page = await seedPage("lora-of", "acct_main");
    const otherPage = await seedPage("lora-vip-of", "acct_other");
    const occurredAt = new Date(Date.now() - 60_000);

    await seedShadowTransaction({
      pageId: page.id,
      accountId: "acct_main",
      transactionId: "tx-matched",
      fanId: "fan-1",
      grossAmountMills: 45_000n,
      creatorNetAmountMills: 36_000n,
      occurredAt,
    });
    await seedCoreTransaction({
      pageId: page.id,
      transactionId: "tx-matched",
      fanId: "fan-1",
      grossAmountMills: 45_000n,
      creatorNetAmountMills: 36_000n,
      occurredAt,
    });

    await seedShadowTransaction({
      pageId: page.id,
      accountId: "acct_main",
      transactionId: "tx-missing",
      fanId: "fan-2",
      grossAmountMills: 60_000n,
      creatorNetAmountMills: 48_000n,
      occurredAt,
    });

    await seedShadowTransaction({
      pageId: page.id,
      accountId: "acct_main",
      transactionId: "tx-amount",
      fanId: "fan-3",
      grossAmountMills: 39_000n,
      creatorNetAmountMills: 31_200n,
      occurredAt,
    });
    await seedCoreTransaction({
      pageId: page.id,
      transactionId: "tx-amount",
      fanId: "fan-3",
      grossAmountMills: 40_000n,
      creatorNetAmountMills: 32_000n,
      occurredAt,
    });

    await seedShadowTransaction({
      pageId: page.id,
      accountId: "acct_main",
      transactionId: "tx-fan",
      fanId: "fan-4",
      grossAmountMills: 11_000n,
      creatorNetAmountMills: 8_800n,
      occurredAt,
    });
    await seedCoreTransaction({
      pageId: page.id,
      transactionId: "tx-fan",
      fanId: "fan-other",
      grossAmountMills: 11_000n,
      creatorNetAmountMills: 8_800n,
      occurredAt,
    });

    await seedShadowTransaction({
      pageId: page.id,
      accountId: "acct_main",
      transactionId: "tx-page",
      fanId: "fan-5",
      grossAmountMills: 4_990n,
      creatorNetAmountMills: 3_990n,
      occurredAt,
    });
    await seedCoreTransaction({
      pageId: otherPage.id,
      transactionId: "tx-page",
      fanId: "fan-5",
      grossAmountMills: 4_990n,
      creatorNetAmountMills: 3_990n,
      occurredAt,
    });

    await upsertOfapiSpendProjectionEvent(appContext.db, {
      domainKey: "ofapi:acct_main:ppv:not-settled:fan-6",
      projectionStatus: "projected",
      sourceEventType: "messages.ppv.unlocked",
      sourceIdempotencyKey: "idem-ppv",
      journalId: 100,
      ofapiAccountId: "acct_main",
      pageId: page.id,
      fanPlatformUserId: "fan-6",
      messageId: "msg-ppv",
      occurredAt,
      category: "message",
      currency: "USD",
      grossAmountMills: 12_000n,
      creatorNetAmountMills: null,
      eventStatus: "estimated",
    });

    await upsertOfapiSpendProjectionEvent(appContext.db, {
      domainKey: "ofapi:acct_main:tip:not-live",
      projectionStatus: "blocked",
      blockedReason: "tips_received_live_fixture_required",
      sourceEventType: "tips.received",
      sourceIdempotencyKey: "idem-tip",
      journalId: 101,
      ofapiAccountId: "acct_main",
      pageId: page.id,
      fanPlatformUserId: "fan-7",
      messageId: "msg-tip",
      occurredAt,
      category: "tip",
      currency: "USD",
    });

    const cookie = await loginCookie("dima", "owner-secret");
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/admin/ofapi/spend/comparison?days=1&sampleLimit=10",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const counts = Object.fromEntries(
      body.summary.map((row: { status: string; count: number }) => [row.status, row.count]),
    );
    expect(counts).toMatchObject({
      matched: 1,
      missing_in_core_truth: 1,
      amount_mismatch: 1,
      fan_mismatch: 1,
      page_mismatch: 1,
      ppv_estimated: 1,
      tips_blocked: 1,
    });

    const pageCounts = Object.fromEntries(
      body.byPage
        .filter((row: { pageId: number }) => row.pageId === page.id)
        .map((row: { status: string; count: number }) => [row.status, row.count]),
    );
    expect(pageCounts).toMatchObject({
      matched: 1,
      missing_in_core_truth: 1,
      amount_mismatch: 1,
      fan_mismatch: 1,
      page_mismatch: 1,
      ppv_estimated: 1,
      tips_blocked: 1,
    });

    const samples = body.samples as Array<{
      comparisonStatus: string;
      transactionId: string | null;
      corePageId: number | null;
      coreGrossAmountMills: number | null;
      blockedReason: string | null;
    }>;
    expect(samples.some((row) => row.comparisonStatus === "missing_in_core_truth"
      && row.transactionId === "tx-missing")).toBe(true);
    expect(samples.some((row) => row.comparisonStatus === "amount_mismatch"
      && row.transactionId === "tx-amount"
      && row.coreGrossAmountMills === 40_000)).toBe(true);
    expect(samples.some((row) => row.comparisonStatus === "page_mismatch"
      && row.transactionId === "tx-page"
      && row.corePageId === otherPage.id)).toBe(true);
    expect(samples.some((row) => row.comparisonStatus === "tips_blocked"
      && row.blockedReason === "tips_received_live_fixture_required")).toBe(true);
    expect(body.limitations).toContain(
      "Desktop spend sweep must stay at the old cadence until matched production comparison is proven.",
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

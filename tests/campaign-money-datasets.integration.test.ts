import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyTrafficBindingsChange,
  createModel,
  createOnlyFansPage,
  createUser,
  insertAgentKey,
  insertLinkStatRunWithSnapshots,
  setConfigOverride,
  upsertTransaction,
  type InsertLinkStatSnapshotInput,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import { projectLinkFanJournal } from "../apps/runtime/src/services/ofapi-link-fans-projection.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// OnlyFans traffic sources (plan 2026-10-08, PR 15): Hub's own money per link
// as Agent Read datasets — `campaigns` (one row per link: the latest snapshot,
// the channel and contractor now, both money figures) and
// `campaign_money_daily` (Hub's figure per Moscow day) — through the real
// route, keys and capabilities.

let testDb: StartedTestDatabase | null = null;
let app: ReturnType<typeof createTestAppContext>;
let pageId = 0;
let actor = 0;

// Hub's floor: the first fan walk, 2026-10-09 03:30 UTC (06:30 Moscow).
const F = Date.parse("2026-10-09T03:30:00Z");
const h = (hours: number) => new Date(F + hours * 3_600_000);
const WIDE = { from: "2026-07-01T00:00:00Z", to: "2026-11-01T00:00:00Z" };

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);
afterAll(async () => {
  await testDb?.stop();
});

type Item = Record<string, unknown>;
const subscriber = (id: number, active: boolean): Item => ({ id, subscribedOnExpiredNow: !active });

async function walk(linkId: string, requestSeq: number, at: Date, items: Item[]) {
  await testDb!.pool.query(
    `insert into sync_raw_payloads (page_id, endpoint, request_params, response_payload, mapper_version,
       payload_kind, captured_at, retain_until)
     values ($1, 'link_fans_trial_subscribers', '{}'::jsonb, $2::jsonb, 'ofapi-link-fans-v1', 'mapping_critical', $3,
       now() + interval '100 years')`,
    [pageId, JSON.stringify({
      link: { kind: "trial", id: Number(linkId) }, list: "subscribers", offset: 0, limit: 100, requestSeq,
      ofapiAccountId: "acct_x", items, hasNextPage: false, nextPageUrl: null,
    }), at],
  );
}

async function fanId(ref: number) {
  const { rows } = await testDb!.pool.query<{ id: string }>(
    "select id::text from fans where platform = 'onlyfans' and platform_user_id = $1", [String(ref)]);
  return Number(rows[0]!.id);
}

async function transaction(fanRef: number, at: Date, mills: bigint, input: {
  state?: "posted" | "pending"; transactionId?: string; canonicalType?: "message_purchase" | "chargeback";
} = {}) {
  const transactionId = input.transactionId ?? randomUUID();
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "ofapi:rest", fanId: await fanId(fanRef), transactionId,
    rawType: "test", canonicalType: input.canonicalType ?? "message_purchase", transactionState: input.state ?? "posted",
    rawStatus: "test", grossAmountMills: mills, sourceDestinationAmountMills: mills, creatorNetAmountMills: mills,
    occurredAt: at,
  });
  return transactionId;
}

function snapshot(platformLinkId: string, values: Partial<InsertLinkStatSnapshotInput>): InsertLinkStatSnapshotInput {
  return {
    platformAccountId: pageId, linkKind: "trial", platformLinkId, name: `link ${platformLinkId}`,
    url: `https://onlyfans.com/action/trial/${platformLinkId}`, linkCreatedAt: new Date("2026-04-01T00:00:00Z"),
    linkEndsAt: null, isFinished: false, clicksCount: 100, claimsCount: 40, subscribersCount: 0, spendersCount: 3,
    revenueNetMills: 50_000n, revenueChargebacksMills: 0n, revenueIsLoading: false, revenueCalculatedAt: h(20),
    trialDays: 180, tags: ["porn"], ...values,
  };
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  actor = (await createUser(app.db, { username: "owner", role: "owner", passwordHash: "synthetic" }))!.id;
  const model = (await createModel(app.db, { slug: "lora", name: "Lora" }))!;
  pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "lora-vip-of" }))!.id;
  await setConfigOverride(app.db, { key: "agentReadPlaneMode", value: "full", userId: actor, groupId: randomUUID() });

  // A (11170786): fans 1 and 2 active from the floor. B (11170787): fan 1
  // too. C (11213035): read in the series but never walked to the end.
  await walk("11170786", 1, h(0), [subscriber(1, true), subscriber(2, true)]);
  await walk("11170787", 1, h(0.01), [subscriber(1, true)]);
  // Walk 2 shows fan 1 expired in B: B's period closes at h(6.01), between
  // his purchase (h(1)) and its chargeback (h(20)) — the chargeback must
  // still take the purchase's B share, not go whole to A.
  await walk("11170786", 2, h(6), [subscriber(1, true), subscriber(2, true)]);
  await walk("11170787", 2, h(6.01), [subscriber(1, false)]);
  await projectLinkFanJournal(app, { pageId, maxPages: 100 });
  const purchase = await transaction(1, h(1), 1001n); // A 501 / B 500, Moscow 2026-10-09
  await transaction(2, h(2), 2000n); // A
  await transaction(2, h(3), 300n, { state: "pending" }); // A, pending
  // The purchase charged back the next Moscow day (2026-10-10 02:30 Moscow).
  await transaction(1, h(20), -1001n, { transactionId: `${purchase}:chargeback`, canonicalType: "chargeback" });

  await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: pageId, linkKind: "trial", status: "complete", pulledAt: h(-6), apiPages: 1,
    rawItems: 3, writtenRows: 3, ofapiAccountId: "acct_x",
  }, [snapshot("11170786", { clicksCount: 90 }), snapshot("11170787", {}), snapshot("11213035", {})]);
  await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: pageId, linkKind: "trial", status: "complete", pulledAt: h(21), apiPages: 1,
    rawItems: 3, writtenRows: 3, ofapiAccountId: "acct_x",
  }, [
    snapshot("11170786", { clicksCount: 120, claimsCount: 44, revenueNetMills: 52_000n }),
    snapshot("11170787", {}),
    snapshot("11213035", { tags: [] }),
  ]);

  await applyTrafficBindingsChange(app.db, {
    contractors: [{ key: "coraline-red", title: "@coraline_red" }],
    channels: [{ key: "lora.porntoki", title: "Порнтоки" }],
    terms: [{ channelKey: "lora.porntoki", contractorKey: "coraline-red", validFrom: new Date("2026-04-01T00:00:00Z"), validTo: null, validFromBasis: "confirmed" }],
    bindings: [{ pageLabel: "lora-vip-of", linkKind: "trial", linkId: "11170786", channelKey: "lora.porntoki",
      validFrom: new Date("2026-04-01T00:00:00Z"), validTo: null, validFromBasis: "confirmed" }],
  }, { write: true, actor: "test", command: "import" });
});

async function makeKey(name: string, capabilities: string[]): Promise<string> {
  const token = `${AGENT_KEY_TOKEN_PREFIX}${name}-synthetic-token`;
  await insertAgentKey(app.db, {
    name, keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6), keyDigest: sha256Hex(token), capabilities,
    pageIds: [pageId], dailyRequestBudget: 100, dailyRowBudget: 10_000,
    expiresAt: new Date(Date.now() + 86_400_000), createdBy: actor,
  });
  return token;
}

interface DatasetBody {
  items: Array<{ key: string; fields: Record<string, unknown>; provenance: { ingestPaths: string[]; convergence: string } }>;
}

async function withServer<T>(run: (query: (token: string, dataset: string, payload: Record<string, unknown>) =>
  Promise<{ statusCode: number; body: string; json: () => DatasetBody }>) => Promise<T>): Promise<T> {
  const server = await buildApiServer(app);
  try {
    return await run(async (token, dataset, payload) => {
      const response = await server.inject({
        method: "POST",
        url: `/api/v1/agent/pages/lora-vip-of/datasets/${dataset}/query`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      return { statusCode: response.statusCode, body: response.body, json: () => JSON.parse(response.body) as DatasetBody };
    });
  } finally {
    await server.close();
  }
}

describe("campaigns and campaign_money_daily: Hub's own money per link", () => {
  it("serves each link's latest state with both money figures, its channel now and Hub's floor; read:money gates it", async () => {
    const noMoney = await makeKey("datasets-only", ["read:datasets"]);
    const money = await makeKey("datasets-money", ["read:datasets", "read:money"]);
    await withServer(async (query) => {
      expect((await query(noMoney, "campaigns", WIDE)).statusCode).toBe(403);
      const response = await query(money, "campaigns", { ...WIDE, limit: 50 });
      expect(response.statusCode, response.body).toBe(200);
      const byRef = new Map(response.json().items.map((item) => [item.fields.linkRef, item]));
      expect(byRef.get("11170786")!.fields).toEqual({
        linkKind: "trial", linkRef: "11170786", name: "link 11170786",
        url: "https://onlyfans.com/action/trial/11170786",
        linkCreatedAt: "2026-04-01T00:00:00.000Z", linkEndsAt: null, isFinished: false, trialDays: 180, tags: ["porn"],
        channelKey: "lora.porntoki", contractorKey: "coraline-red",
        lastObservedAt: h(21).toISOString(), clicks: 120, fans: 44, fansMetric: "claims", subscribers: 0, spenders: 3,
        vendorRevenueNetMills: 52_000, vendorRevenueCalculatedAt: h(20).toISOString(),
        // 501 + 2000 − 501 (the chargeback on the purchase's shares); the pending 300 apart.
        hubRevenueNetMills: 2000, hubPendingMills: 300, hubMoneyFloorAt: h(0).toISOString(),
        attributionRule: "ofapi_subscription_period_equal_split.v1", revenueBasis: "creator_net_after_platform_fee",
      });
      expect(byRef.get("11170787")!.fields).toMatchObject({
        channelKey: null, contractorKey: null, hubRevenueNetMills: 0, hubPendingMills: 0,
        hubMoneyFloorAt: h(0.01).toISOString(),
      });
      // No finished fan walk: no floor, no figure — null, never zero.
      expect(byRef.get("11213035")!.fields).toMatchObject({ hubRevenueNetMills: null, hubPendingMills: null, hubMoneyFloorAt: null, tags: [] });
      expect(byRef.get("11170786")!.provenance).toMatchObject({ ingestPaths: ["hot_projection"], convergence: "converging" });
    });
  });

  it("gives Hub's money per link and Moscow day, a chargeback on its own day with its purchase's shares", async () => {
    // At the chargeback only A holds fan 1 (his B period closed at h(6.01)).
    const { rows } = await testDb!.pool.query(
      `select platform_link_id as link, closed_at from page_link_fan_periods p
         join fans f on f.id = p.fan_id where f.platform_user_id = '1' order by 1`);
    expect(rows).toEqual([{ link: "11170786", closed_at: null }, { link: "11170787", closed_at: h(6.01) }]);
    const noMoney = await makeKey("datasets-only", ["read:datasets"]);
    const money = await makeKey("datasets-money", ["read:datasets", "read:money"]);
    await withServer(async (query) => {
      expect((await query(noMoney, "campaign_money_daily", WIDE)).statusCode).toBe(403);
      const response = await query(money, "campaign_money_daily", { ...WIDE, limit: 50 });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items.map((item) => item.fields)).toEqual([
        { businessDate: "2026-10-09", dayStartAt: "2026-10-08T21:00:00.000Z", linkKind: "trial", linkRef: "11170786",
          hubRevenueNetMills: 2501, hubPendingMills: 300, transactionCount: 2, fanCount: 2,
          attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: h(0).toISOString() },
        { businessDate: "2026-10-09", dayStartAt: "2026-10-08T21:00:00.000Z", linkKind: "trial", linkRef: "11170787",
          hubRevenueNetMills: 500, hubPendingMills: 0, transactionCount: 1, fanCount: 1,
          attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: h(0.01).toISOString() },
        { businessDate: "2026-10-10", dayStartAt: "2026-10-09T21:00:00.000Z", linkKind: "trial", linkRef: "11170786",
          hubRevenueNetMills: -501, hubPendingMills: 0, transactionCount: 1, fanCount: 1,
          attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: h(0).toISOString() },
        { businessDate: "2026-10-10", dayStartAt: "2026-10-09T21:00:00.000Z", linkKind: "trial", linkRef: "11170787",
          hubRevenueNetMills: -500, hubPendingMills: 0, transactionCount: 1, fanCount: 1,
          attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: h(0.01).toISOString() },
      ]);
      // A filter by link never re-splits: B's day keeps its half.
      const onlyB = await query(money, "campaign_money_daily", {
        ...WIDE, filters: [{ field: "linkRef", op: "eq", value: "11170787" }],
      });
      expect(onlyB.json().items.map((item) => item.fields.hubRevenueNetMills)).toEqual([500, -500]);
    });
  });
});

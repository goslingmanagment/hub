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
  type InsertLinkStatSnapshotInput,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// OnlyFans traffic sources (plan 2026-10-08, PR 14): the Agent Read datasets
// traffic-control switches to from SSH psql — the link series
// (campaign_snapshots), every attempt to read it (campaign_runs) and who brings
// each link's traffic (campaign_bindings) — through the real route, keys and
// capabilities.

let testDb: StartedTestDatabase | null = null;
let app: ReturnType<typeof createTestAppContext>;
let pageId = 0;
let actor = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

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
});

async function makeKey(name: string, capabilities: string[]): Promise<string> {
  const token = `${AGENT_KEY_TOKEN_PREFIX}${name}-synthetic-token`;
  await insertAgentKey(app.db, {
    name,
    keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(token),
    capabilities,
    pageIds: [pageId],
    dailyRequestBudget: 100,
    dailyRowBudget: 10_000,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdBy: actor,
  });
  return token;
}

interface DatasetBody {
  items: Array<{ key: string; fields: Record<string, unknown>; provenance: { ingestPaths: string[]; convergence: string } }>;
  delivery: { nextCursor: string | null };
  capture: {
    planes: Array<{ plane: string; state: string; captureFloor?: { at: string | null; kind: string } }>;
    gaps: Array<{ kind: string; to: string | null; plane: string }>;
  };
}

async function withServer<T>(run: (query: (
  token: string,
  dataset: string,
  payload: Record<string, unknown>,
) => Promise<{ statusCode: number; body: string; json: () => DatasetBody }>) => Promise<T>): Promise<T> {
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

function snapshot(
  linkKind: "tracking" | "trial",
  platformLinkId: string,
  overrides: Partial<InsertLinkStatSnapshotInput> = {},
): InsertLinkStatSnapshotInput {
  return {
    platformAccountId: pageId,
    linkKind,
    platformLinkId,
    name: `link ${platformLinkId}`,
    url: null,
    linkCreatedAt: new Date("2026-04-01T00:00:00Z"),
    linkEndsAt: null,
    isFinished: linkKind === "trial" ? false : null,
    clicksCount: 100,
    claimsCount: linkKind === "trial" ? 40 : null,
    subscribersCount: 7,
    spendersCount: 3,
    revenueNetMills: 12_345n,
    revenueChargebacksMills: 0n,
    revenueIsLoading: false,
    revenueCalculatedAt: new Date("2026-10-08T06:00:00Z"),
    trialDays: linkKind === "trial" ? 7 : null,
    tags: [],
    ...overrides,
  };
}

async function run(
  input: {
    linkKind: "tracking" | "trial";
    status: "complete" | "partial" | "truncated" | "failed" | "skipped";
    pulledAt: string;
    windowAt?: string | null;
    reason?: string | null;
    rawItems?: number;
    apiPages?: number;
    ofapiAccountId?: string | null;
  },
  rows: InsertLinkStatSnapshotInput[] = [],
): Promise<number> {
  const { runId } = await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: pageId,
    linkKind: input.linkKind,
    status: input.status,
    pulledAt: new Date(input.pulledAt),
    apiPages: input.apiPages ?? (input.status === "skipped" ? 0 : 1),
    rawItems: input.rawItems ?? rows.length,
    writtenRows: rows.length,
    reason: input.reason ?? null,
    windowAt: input.windowAt === undefined || input.windowAt === null ? null : new Date(input.windowAt),
    ofapiAccountId: input.ofapiAccountId ?? "acct_new",
  }, rows);
  return runId;
}

const WIDE = { from: "2026-07-01T00:00:00Z", to: "2026-11-01T00:00:00Z" };

describe("campaign_snapshots: the link series", () => {
  it("serves only usable results, oldest first, with net money and the series' floor; read:money gates it", async () => {
    // The series' first read, before migration 0255: no window, no recorded
    // binding flag, the money only under the deprecated column name.
    const legacy = await run({ linkKind: "trial", status: "complete", pulledAt: "2026-07-22T12:17:47Z" }, [
      snapshot("trial", "11170786", { revenueNetMills: null }),
    ]);
    await testDb!.pool.query(
      "update page_link_stat_snapshots set revenue_gross_mills = 300000 where run_id = $1",
      [legacy],
    );
    // A truncated walk that (as a legacy anomaly) carries a snapshot: no
    // result of its window, so never a point of the series.
    const truncated = await run({ linkKind: "trial", status: "complete", pulledAt: "2026-07-21T00:00:00Z" }, [
      snapshot("trial", "11170786", { clicksCount: 1 }),
    ]);
    await testDb!.pool.query("update page_link_stat_runs set status = 'truncated' where id = $1", [truncated]);
    // Today's window: the first non-empty walk under a new OFAPI account.
    const rebound = await run({
      linkKind: "trial",
      status: "partial",
      pulledAt: "2026-10-08T21:45:20Z",
      windowAt: "2026-10-08T21:45:00Z",
      reason: "binding_changed,multi_page",
      apiPages: 2,
    }, [
      snapshot("trial", "11170786", { clicksCount: 120, claimsCount: 44, revenueNetMills: 310_500n }),
      snapshot("trial", "11687581", { clicksCount: 5, claimsCount: 1, spendersCount: null, revenueNetMills: null }),
    ]);
    const tracking = await run({
      linkKind: "tracking",
      status: "complete",
      pulledAt: "2026-10-08T21:45:20Z",
      windowAt: "2026-10-08T21:45:00Z",
    }, [snapshot("tracking", "3760278")]);
    // Attempts without a result carry no snapshot and stay out of the series.
    await run({ linkKind: "trial", status: "failed", pulledAt: "2026-10-09T03:45:10Z", windowAt: "2026-10-09T03:45:00Z", reason: "timeout" });

    const noMoney = await makeKey("datasets-only", ["read:datasets"]);
    const money = await makeKey("datasets-money", ["read:datasets", "read:money"]);
    await withServer(async (query) => {
      expect((await query(noMoney, "campaign_snapshots", WIDE)).statusCode).toBe(403);

      const response = await query(money, "campaign_snapshots", { ...WIDE, limit: 50 });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.items.map((item) => [item.fields.runRef, item.fields.linkRef])).toEqual([
        [String(legacy), "11170786"],
        // Same observedAt: the stable key (run, link) orders the tie.
        [String(rebound), "11170786"],
        [String(rebound), "11687581"],
        [String(tracking), "3760278"],
      ]);
      expect(body.items[0]!.fields).toMatchObject({
        linkKind: "trial",
        observedAt: "2026-07-22T12:17:47.000Z",
        businessDate: "2026-07-22",
        windowAt: null,
        runStatus: "complete",
        // Not recorded by the image that wrote it — unknown, not false.
        bindingChanged: null,
        // The deprecated column's value, already net.
        vendorRevenueNetMills: 300_000,
      });
      expect(body.items[1]!.fields).toMatchObject({
        name: "link 11170786",
        // 21:45 UTC is the next day in Moscow.
        businessDate: "2026-10-09",
        windowAt: "2026-10-08T21:45:00.000Z",
        runStatus: "partial",
        bindingChanged: true,
        clicks: 120,
        claims: 44,
        subscribers: 7,
        spenders: 3,
        vendorRevenueNetMills: 310_500,
        vendorChargebacksMills: 0,
        vendorRevenueCalculatedAt: "2026-10-08T06:00:00.000Z",
        isFinished: false,
        linkEndsAt: null,
      });
      // Unknown money and an uncomputed spender count stay null, never zero.
      expect(body.items[2]!.fields).toMatchObject({ spenders: null, vendorRevenueNetMills: null });
      expect(body.items[3]!.fields).toMatchObject({
        linkKind: "tracking",
        claims: null,
        bindingChanged: false,
        isFinished: null,
      });
      expect(body.items[0]!.provenance).toMatchObject({ ingestPaths: ["ofapi_rest_pull"], convergence: "final" });

      // The floor is the first USABLE read, not the truncated anomaly before it.
      expect(body.capture.planes).toContainEqual(expect.objectContaining({
        plane: "page_link_stat_snapshots",
        state: "read",
        captureFloor: expect.objectContaining({ at: "2026-07-22T12:17:47.000Z" }),
      }));
      expect(body.capture.gaps).toContainEqual(expect.objectContaining({
        kind: "before_capture_floor",
        plane: "page_link_stat_snapshots",
        to: "2026-07-22T12:17:47.000Z",
      }));

      // A filter and a cursor walk a tie on observedAt without a repeat.
      const first = await query(money, "campaign_snapshots", {
        from: "2026-10-08T00:00:00Z",
        to: "2026-10-10T00:00:00Z",
        filters: [{ field: "linkKind", op: "eq", value: "trial" }],
        limit: 1,
      });
      expect(first.statusCode, first.body).toBe(200);
      const firstBody = first.json();
      expect(firstBody.items.map((item) => item.fields.linkRef)).toEqual(["11170786"]);
      expect(firstBody.delivery.nextCursor).not.toBeNull();
      const second = await query(money, "campaign_snapshots", { cursor: firstBody.delivery.nextCursor });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().items.map((item) => item.fields.linkRef)).toEqual(["11687581"]);
    });
  });
});

describe("campaign_runs: every attempt", () => {
  it("lists failed, skipped and empty attempts beside the results and says which ones are usable", async () => {
    // A pair that never showed a link: its first empty read is no result,
    // one that has stayed empty for 24 hours is (linkStatRunUsableResultSql).
    const emptyFirst = await run({ linkKind: "trial", status: "partial", pulledAt: "2026-10-07T03:45:10Z", windowAt: "2026-10-07T03:45:00Z", reason: "empty_unverified", rawItems: 0 });
    const emptyLater = await run({ linkKind: "trial", status: "partial", pulledAt: "2026-10-08T03:45:10Z", windowAt: "2026-10-08T03:45:00Z", reason: "empty_unverified", rawItems: 0 });
    const result = await run({ linkKind: "tracking", status: "complete", pulledAt: "2026-10-08T09:45:10Z", windowAt: "2026-10-08T09:45:00Z" }, [snapshot("tracking", "3760278")]);
    const failed = await run({ linkKind: "tracking", status: "failed", pulledAt: "2026-10-08T15:45:10Z", windowAt: "2026-10-08T15:45:00Z", reason: "OFAPI request timed out" });
    const retried = await run({ linkKind: "tracking", status: "complete", pulledAt: "2026-10-08T16:00:10Z", windowAt: "2026-10-08T15:45:00Z" }, [snapshot("tracking", "3760278")]);
    const missed = await run({ linkKind: "tracking", status: "skipped", pulledAt: "2026-10-08T22:00:00Z", windowAt: "2026-10-08T21:45:00Z", reason: "window_missed", ofapiAccountId: null });

    const datasetsOnly = await makeKey("runs-reader", ["read:datasets"]);
    await withServer(async (query) => {
      const response = await query(datasetsOnly, "campaign_runs", { ...WIDE, limit: 50 });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.items.map((item) => [
        item.fields.runRef, item.fields.status, item.fields.attempt, item.fields.usableResult,
      ])).toEqual([
        [String(emptyFirst), "partial", 1, false],
        [String(emptyLater), "partial", 1, true],
        [String(result), "complete", 1, true],
        [String(failed), "failed", 1, false],
        [String(retried), "complete", 2, true],
        [String(missed), "skipped", 1, false],
      ]);
      expect(body.items[3]!.fields).toMatchObject({
        linkKind: "tracking",
        windowAt: "2026-10-08T15:45:00.000Z",
        observedAt: "2026-10-08T15:45:10.000Z",
        businessDate: "2026-10-08",
        reason: "OFAPI request timed out",
        apiPages: 1,
        rawItems: 0,
        writtenRows: 0,
        bindingChanged: false,
      });
      expect(body.items[5]!.fields).toMatchObject({ reason: "window_missed", apiPages: 0, businessDate: "2026-10-09" });
      expect(body.capture.planes).toContainEqual(expect.objectContaining({
        plane: "page_link_stat_runs",
        state: "read",
        captureFloor: expect.objectContaining({ at: "2026-10-07T03:45:10.000Z" }),
      }));

      // An attempt row is filterable by its own vocabulary: the holes alone.
      const holes = await query(datasetsOnly, "campaign_runs", {
        ...WIDE,
        filters: [{ field: "usableResult", op: "eq", value: false }],
      });
      expect(holes.json().items.map((item) => item.fields.runRef))
        .toEqual([String(emptyFirst), String(failed), String(missed)]);
    });
  });
});

describe("campaign_bindings: link → channel → contractor, with dates", () => {
  it("cuts a binding at every contractor change and names a stretch without one", async () => {
    await applyTrafficBindingsChange(app.db, {
      contractors: [
        { key: "dima-s", title: "Dima S" },
        { key: "garantteam-social", title: "GaranTTeam" },
      ],
      channels: [
        { key: "lora.insta-main", title: "Instagram основа" },
        { key: "lora.reddit", title: "Reddit" },
      ],
      terms: [
        {
          channelKey: "lora.insta-main", contractorKey: "dima-s",
          validFrom: new Date("2026-04-13T10:43:14Z"), validTo: new Date("2026-08-01T00:00:00Z"),
          validFromBasis: "assumed_link_created",
        },
        {
          channelKey: "lora.insta-main", contractorKey: "garantteam-social",
          validFrom: new Date("2026-09-09T21:00:00Z"), validTo: null, validFromBasis: "confirmed",
        },
      ],
      bindings: [
        {
          pageLabel: "lora-vip-of", linkKind: "trial", linkId: "11199824", channelKey: "lora.insta-main",
          validFrom: new Date("2026-04-13T10:43:14Z"), validTo: null, validFromBasis: "assumed_link_created",
        },
        {
          pageLabel: "lora-vip-of", linkKind: "trial", linkId: "10573270", channelKey: "lora.reddit",
          validFrom: new Date("2025-09-06T16:52:26Z"), validTo: new Date("2026-06-14T21:00:00Z"),
          validFromBasis: "assumed_link_created",
        },
      ],
    }, { write: true, actor: "test", command: "import" });

    const datasetsOnly = await makeKey("bindings-reader", ["read:datasets"]);
    await withServer(async (query) => {
      const response = await query(datasetsOnly, "campaign_bindings", {
        from: "2000-01-01T00:00:00Z",
        to: "2100-01-01T00:00:00Z",
      });
      expect(response.statusCode, response.body).toBe(200);
      const rows = response.json().items.map((item) => item.fields);
      expect(rows).toEqual([
        {
          linkKind: "trial", linkRef: "10573270", channelKey: "lora.reddit", channelTitle: "Reddit",
          contractorKey: null, contractorTitle: null,
          validFrom: "2025-09-06T16:52:26.000Z", validTo: "2026-06-14T21:00:00.000Z",
          validFromBasis: "assumed_link_created",
          bindingValidFrom: "2025-09-06T16:52:26.000Z", bindingValidTo: "2026-06-14T21:00:00.000Z",
          contractorValidFrom: null, contractorValidTo: null, contractorValidFromBasis: null,
        },
        {
          linkKind: "trial", linkRef: "11199824", channelKey: "lora.insta-main", channelTitle: "Instagram основа",
          contractorKey: "dima-s", contractorTitle: "Dima S",
          validFrom: "2026-04-13T10:43:14.000Z", validTo: "2026-08-01T00:00:00.000Z",
          validFromBasis: "assumed_link_created",
          bindingValidFrom: "2026-04-13T10:43:14.000Z", bindingValidTo: null,
          contractorValidFrom: "2026-04-13T10:43:14.000Z", contractorValidTo: "2026-08-01T00:00:00.000Z",
          contractorValidFromBasis: "assumed_link_created",
        },
        // Between the two terms the channel had no contractor.
        expect.objectContaining({
          linkRef: "11199824", contractorKey: null,
          validFrom: "2026-08-01T00:00:00.000Z", validTo: "2026-09-09T21:00:00.000Z",
          contractorValidFromBasis: null,
        }),
        expect.objectContaining({
          linkRef: "11199824", contractorKey: "garantteam-social",
          validFrom: "2026-09-09T21:00:00.000Z", validTo: null,
          validFromBasis: "assumed_link_created",
          contractorValidFrom: "2026-09-09T21:00:00.000Z", contractorValidTo: null,
          contractorValidFromBasis: "confirmed",
        }),
      ]);

      // The window applies to a stretch's start.
      const september = await query(datasetsOnly, "campaign_bindings", {
        from: "2026-09-01T00:00:00Z",
        to: "2026-10-01T00:00:00Z",
      });
      expect(september.json().items.map((item) => item.fields.contractorKey)).toEqual(["garantteam-social"]);
      // Configuration, not captured history: no capture floor is claimed.
      expect(september.json().capture.planes).toContainEqual(expect.objectContaining({
        plane: "traffic_link_bindings",
        state: "read",
      }));
      expect(september.json().capture.gaps).toEqual([]);
    });
  });
});

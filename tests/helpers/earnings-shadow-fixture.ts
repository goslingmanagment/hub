import { createHash, randomUUID } from "node:crypto";
import {
  createModel, createFanslyPage, ensurePageSyncStates, findPageById,
  startSyncRun, upsertFans, upsertFanPages, insertObservation,
  type UpsertTransactionInput,
} from "@agency_hub_core/db";
import { millsFromInteger } from "@agency_hub_core/shared";
import { vi } from "vitest";
import { SyncChunkBudget } from "../../apps/runtime/src/services/sync/chunk-budget.ts";
import type { StartedTestDatabase } from "./db.ts";
import { createTestAppContext } from "./runtime.ts";

export async function earningsShadowFixture(testDb: StartedTestDatabase, shadow = true) {
  const model = await createModel(testDb.db, { slug: "earnings-shadow", name: "Earnings" });
  if (!model) throw new Error("Model seed failed");
  const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "earnings-shadow" });
  if (!page) throw new Error("Page seed failed");
  const pageId = page.id;
  await ensurePageSyncStates(testDb.db, { pageId: page.id });
  const fans = await upsertFans(testDb.db, ["fan-a", "fan-b"].map((platformUserId) => ({
    platform: "fansly" as const, platformUserId, username: platformUserId,
  })));
  await upsertFanPages(testDb.db, fans.map((fan) => ({ fanId: fan.id, platformAccountId: page.id })));
  await testDb.pool.query("update page_fans set total_creator_net_mills = 100 where platform_account_id = $1", [page.id]);
  const app = createTestAppContext(testDb, {
    fanslyFanEarningsSyncEnabled: true,
    fanslyFanEarningsShadowPageAllowlist: shadow ? page.label : "none",
  });
  const transaction: UpsertTransactionInput & { source: "fansly:rest" } = {
    platformAccountId: page.id, source: "fansly:rest", transactionId: "transaction-a",
    correlationAccountId: "fan-a", fanId: fans[0]!.id, rawType: 2110, canonicalType: "tip",
    rawStatus: 1, transactionState: "pending", grossAmountMills: millsFromInteger(100),
    sourceDestinationAmountMills: millsFromInteger(80), creatorNetAmountMills: millsFromInteger(80),
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  };
  async function rows() {
    return (await testDb.pool.query(`select * from subject_refresh_state
      where page_id = $1 order by subject_ref, plane`, [pageId])).rows;
  }
  async function observation() {
    const payload = [{ correlationAccountId: "fan-a", type: 2110, totalGross: 100, totalNet: 80 }];
    const result = await insertObservation(testDb.db, {
      source: "pull", producer: "test:earnings", platform: "fansly", accountId: pageId,
      kind: "fan_earnings_stats", payload, idempotencyKey: randomUUID(),
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
    });
    if (result.observationId === null) throw new Error("Observation seed failed");
    return result.observationId;
  }
  async function chunkInput(maxRequests = 10) {
    const run = await startSyncRun(testDb.db, {
      platformAccountId: pageId, stream: "fan_earnings", trigger: "manual",
    });
    const stored = await findPageById(testDb.db, pageId);
    if (!run || !stored) throw new Error("Run seed failed");
    return {
      pageContext: { page: stored.page, platform: "fansly", session: null, proxy: null, egressKey: "direct" } as never,
      syncRunId: run.id,
      telemetry: {
        recordPhaseStarted: vi.fn(async () => {}), addAnomaly: vi.fn(async () => {}),
        getRequestObserver: () => null,
      } as never,
      budget: new SyncChunkBudget(maxRequests, 60_000),
    };
  }
  return { app, page, fans, transaction, rows, observation, chunkInput };
}

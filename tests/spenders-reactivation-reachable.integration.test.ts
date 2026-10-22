// The "needs reactivation" spender list (and its total) leaves out fans no
// page in scope can message: the page's "not seen" answer or an OnlyFans
// closed chat. A fan never checked stays; a fan another page in scope can
// reach stays on the multi-page list; every other list keeps them all.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  listRankedSpenders,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;

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
});

const NOW = new Date("2026-10-22T12:00:00.000Z");
const LONG_AGO = "2026-03-01T12:00:00.000Z";

describe("needs-reactivation spender list", () => {
  it("leaves out fans no page in scope can message, on the list and its total only", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const { db } = createTestAppContext(testDb, {});
    const model = await createModel(db, { slug: "model-reach", name: "Model reach" });
    const pageA = (await createOnlyFansPage(db, { modelId: model!.id, label: "reach-a" }))!;
    const pageB = (await createOnlyFansPage(db, { modelId: model!.id, label: "reach-b" }))!;

    // id → [lifetime net on page A in mills, page A answer, page B answer]
    type Answer = { resolved: boolean | null; contactability: string | null } | null;
    const seen = { resolved: true, contactability: "contactable" };
    const specs: Array<[string, number, Answer, Answer]> = [
      ["11", 500_000, seen, null],
      ["12", 400_000, { resolved: false, contactability: "gone" }, null],
      ["13", 300_000, { resolved: true, contactability: "unavailable" }, null],
      ["14", 200_000, { resolved: null, contactability: null }, null],
      ["15", 150_000, { resolved: false, contactability: "blocked" }, seen],
      // Under the $100 line: an inactive fan, never on the reactivation list.
      ["16", 50_000, { resolved: false, contactability: "gone" }, null],
    ];
    const rows = await upsertFans(db, specs.map(([id]) => ({ platform: "onlyfans" as const, platformUserId: id, username: `u${id}` })));
    const fanId = new Map(rows.map((row) => [row.platformUserId, row.id]));
    for (const [id, net, onA, onB] of specs) {
      const fan = fanId.get(id)!;
      await upsertFanPages(db, [
        { fanId: fan, platformAccountId: pageA.id },
        ...(onB ? [{ fanId: fan, platformAccountId: pageB.id }] : []),
      ]);
      await testDb.pool.query(
        `insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills, last_transaction_at)
         values ($1, $2, $3, $3, $4)`,
        [pageA.id, fan, net, LONG_AGO],
      );
      for (const [pageId, answer] of [[pageA.id, onA], [pageB.id, onB]] as const) {
        if (!answer) continue;
        await testDb.pool.query(
          `update page_fans set account_probe_resolved = $1, account_contactability = $2,
             account_probe_at = case when $1::boolean is null then null else now() end
           where platform_account_id = $3 and fan_id = $4`,
          [answer.resolved, answer.contactability, pageId, fan],
        );
      }
    }

    const list = async (pageIds: number[], retentionStatus: "needs_reactivation" | "inactive" | "all") => {
      const result = await listRankedSpenders(db, {
        platform: "onlyfans", pageIds, period: "lifetime", sortBy: "lifetimeCreatorNetAmountMills",
        sortDir: "desc", limit: 50, offset: 0, retentionStatus, now: NOW,
      });
      return { total: result.total, ids: result.items.map((item) => item.platformUserId) };
    };

    // Page A: the gone, the closed chat and the blocked one leave the list
    // and its total; the never-checked fan stays.
    expect(await list([pageA.id], "needs_reactivation")).toEqual({ total: 2, ids: ["11", "14"] });
    // Both pages: page B can still reach fan 15, so he is back.
    expect(await list([pageA.id, pageB.id], "needs_reactivation")).toEqual({ total: 3, ids: ["11", "14", "15"] });
    // The other lists keep everyone, unreachable fans and their money included.
    expect(await list([pageA.id], "all")).toEqual({ total: 6, ids: ["11", "12", "13", "14", "15", "16"] });
    expect(await list([pageA.id], "inactive")).toEqual({ total: 1, ids: ["16"] });
  });
});

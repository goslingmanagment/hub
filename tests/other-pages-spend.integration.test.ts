import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, createOnlyFansPage, readOtherPagesSpend, type Database } from "@agency_hub_core/db";
import { millsFromDollars } from "@agency_hub_core/shared";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// The mark on a fan in a chatter's lists: what he paid on other pages of the
// asked page's platform (any model), the biggest first, only sums above zero.

let testDb: StartedTestDatabase | null = null;
const pageIds = new Map<string, number>();
const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);

async function fan(ref: string, platform: "fansly" | "onlyfans", paid: Record<string, number>): Promise<number> {
  const id = Number((await q(
    "insert into fans (platform, platform_user_id, first_seen_at) values ($1, $2, '2026-01-01T00:00:00Z') returning id",
    [platform, ref],
  )).rows[0].id);
  for (const [label, amount] of Object.entries(paid)) {
    await q(
      "insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills) values ($1, $2, $3, $3)",
      [pageIds.get(label), id, millsFromDollars(amount).toString()],
    );
  }
  return id;
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (!testDb) return;
  const db = testDb.db as unknown as Database;
  const lora = (await createModel(db, { slug: "lora", name: "Lora" }))!;
  const ari = (await createModel(db, { slug: "ari", name: "Ari" }))!;
  for (const label of ["lora-1", "lora-2", "lora-3", "gone-1"]) {
    pageIds.set(label, (await createFanslyPage(db, { modelId: lora.id, label })).id);
  }
  pageIds.set("ari-1", (await createFanslyPage(db, { modelId: ari.id, label: "ari-1" })).id);
  pageIds.set("lora-of", (await createOnlyFansPage(db, { modelId: lora.id, label: "lora-of" })).id);
  await q("update pages set deleted_at = now() where id = $1", [pageIds.get("gone-1")]);
}, INTEGRATION_TEST_TIMEOUT_MS);

afterAll(async () => {
  await testDb?.stop();
}, INTEGRATION_TEST_TIMEOUT_MS);

describe("readOtherPagesSpend", () => {
  it("takes other pages of the same platform, any model, the biggest first; a fan with none has no entry", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const spender = await fan("100000000000000001", "fansly", { "lora-1": 500, "lora-2": 30.5, "ari-1": 1653, "lora-3": 0, "lora-of": 900, "gone-1": 70 });
    const refunded = await fan("100000000000000002", "fansly", { "lora-2": -5 });
    const onlyHere = await fan("100000000000000003", "fansly", { "lora-1": 40 });
    const cold = await fan("100000000000000004", "fansly", {});

    const spend = await readOtherPagesSpend(db, { pageId: pageIds.get("lora-1")!, fanIds: [spender, refunded, onlyHere, cold] });

    expect([...spend.keys()]).toEqual([spender]);
    expect(spend.get(spender)).toEqual([
      { pageLabel: "ari-1", grossMills: 1_653_000 },
      { pageLabel: "lora-2", grossMills: 30_500 },
    ]);
    // Asked on another page, the money of lora-1 counts and that page's own does not.
    expect((await readOtherPagesSpend(db, { pageId: pageIds.get("lora-2")!, fanIds: [spender] })).get(spender)?.map((row) => row.pageLabel)).toEqual(["ari-1", "lora-1"]);
    expect((await readOtherPagesSpend(db, { pageId: pageIds.get("lora-1")!, fanIds: [] })).size).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

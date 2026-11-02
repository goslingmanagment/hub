import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel, createOnlyFansPage, readOtherPages, type Database } from "@agency_hub_core/db";
import { millsFromDollars } from "@agency_hub_core/shared";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

// The mark on a fan in a chatter's lists: the other pages of the asked page's
// platform (any model) where he paid, however long ago, or wrote himself within
// 90 days. Biggest money first, then the freshest word.

let testDb: StartedTestDatabase | null = null;
const pageIds = new Map<string, number>();
const q = (text: string, values: unknown[] = []) => testDb!.pool.query(text, values);
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

async function fan(
  ref: string,
  platform: "fansly" | "onlyfans",
  facts: { paid?: Record<string, number>; wrote?: Record<string, number>; follows?: string[]; subscribes?: string[] },
): Promise<number> {
  const id = Number((await q(
    "insert into fans (platform, platform_user_id, first_seen_at) values ($1, $2, '2026-01-01T00:00:00Z') returning id",
    [platform, ref],
  )).rows[0].id);
  for (const [label, amount] of Object.entries(facts.paid ?? {})) {
    await q(
      "insert into fan_spend_lifetime (platform_account_id, fan_id, gross_amount_mills, creator_net_amount_mills) values ($1, $2, $3, $3)",
      [pageIds.get(label), id, millsFromDollars(amount).toString()],
    );
  }
  for (const [label, days] of Object.entries(facts.wrote ?? {})) {
    await q(
      "insert into page_dm_threads (platform_account_id, platform_conversation_id, fan_id, last_fan_message_at) values ($1, $2, $3, $4)",
      [pageIds.get(label), `${ref}-${label}`, id, daysAgo(days)],
    );
  }
  for (const label of facts.follows ?? []) {
    await q("insert into page_fans (platform_account_id, fan_id, is_follower) values ($1, $2, true)", [pageIds.get(label), id]);
  }
  for (const label of facts.subscribes ?? []) {
    await q("insert into page_fans (platform_account_id, fan_id, is_follower, is_subscriber) values ($1, $2, true, true)", [pageIds.get(label), id]);
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

describe("readOtherPages", () => {
  it("takes the money of other pages of the same platform, any model, the biggest first", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const spender = await fan("100000000000000001", "fansly", { paid: { "lora-1": 500, "lora-2": 30.5, "ari-1": 1653, "lora-3": 0, "lora-of": 900, "gone-1": 70 } });
    const refunded = await fan("100000000000000002", "fansly", { paid: { "lora-2": -5 } });
    const onlyHere = await fan("100000000000000003", "fansly", { paid: { "lora-1": 40 }, wrote: { "lora-1": 1 } });
    const cold = await fan("100000000000000004", "fansly", {});

    const pages = await readOtherPages(db, { pageId: pageIds.get("lora-1")!, fanIds: [spender, refunded, onlyHere, cold] });

    expect([...pages.keys()]).toEqual([spender]);
    expect(pages.get(spender)).toEqual([
      { pageLabel: "ari-1", grossMills: 1_653_000, lastFanMessageAt: null, relation: null },
      { pageLabel: "lora-2", grossMills: 30_500, lastFanMessageAt: null, relation: null },
    ]);
    // Asked on another page, the money of lora-1 counts and that page's own does not.
    expect((await readOtherPages(db, { pageId: pageIds.get("lora-2")!, fanIds: [spender] })).get(spender)?.map((row) => row.pageLabel)).toEqual(["ari-1", "lora-1"]);
    expect((await readOtherPages(db, { pageId: pageIds.get("lora-1")!, fanIds: [] })).size).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes his own word within 90 days without money; an old word or a follow alone is no reason", async (context) => {
    if (!testDb) return context.skip();
    const db = testDb.db as unknown as Database;
    const talker = await fan("100000000000000011", "fansly", { wrote: { "lora-2": 40, "lora-3": 5, "ari-1": 200 }, subscribes: ["lora-3"], follows: ["lora-2"] });
    const oldWord = await fan("100000000000000012", "fansly", { wrote: { "lora-2": 91 } });
    const follower = await fan("100000000000000013", "fansly", { follows: ["lora-2"] });
    const paidLongAgo = await fan("100000000000000014", "fansly", { paid: { "lora-2": 20 }, wrote: { "lora-2": 400 }, follows: ["lora-2"] });

    const pages = await readOtherPages(db, { pageId: pageIds.get("lora-1")!, fanIds: [talker, oldWord, follower, paidLongAgo] });

    expect([...pages.keys()].sort()).toEqual([talker, paidLongAgo].sort());
    expect(pages.get(talker)?.map(({ pageLabel, grossMills, relation }) => ({ pageLabel, grossMills, relation }))).toEqual([
      { pageLabel: "lora-3", grossMills: 0, relation: "subscriber" },
      { pageLabel: "lora-2", grossMills: 0, relation: "follower" },
    ]);
    expect(Date.parse(pages.get(talker)![0]!.lastFanMessageAt!)).toBeGreaterThan(Date.now() - 6 * 86_400_000);
    // Money counts however old, and the old word still says when he wrote.
    expect(pages.get(paidLongAgo)?.[0]).toMatchObject({ pageLabel: "lora-2", grossMills: 20_000, relation: "follower" });
    expect(Date.parse(pages.get(paidLongAgo)![0]!.lastFanMessageAt!)).toBeLessThan(Date.now() - 399 * 86_400_000);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

// The OnlyFans fan account check: paying fans are read ten at a time through
// the page's account and each returned profile becomes the page's answer —
// seen or not, and whether the page can message him — on the page link only,
// never the shared deleted mark, each answer journaled first. An answered or
// left-out fan is not asked again inside the recheck window; the pass shares
// its requests across pages and hands the unused part on; a policy refusal
// costs no budget; a refused body is journaled and records nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  OfapiCollectionPolicyError,
  setPageOfapiAccountId,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS,
  runOfapiFanAccountCheck,
} from "../apps/runtime/src/services/ofapi-fan-account-check.ts";
import {
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

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, {});
});

async function seedPage(label: string, ofapiAccountId: string) {
  const model = await createModel(appContext.db, { slug: `model-${label}`, name: `Model ${label}` });
  const page = await createOnlyFansPage(appContext.db, { modelId: model!.id, label });
  await setPageOfapiAccountId(appContext.db, { pageId: page!.id, ofapiAccountId });
  return page!;
}

async function seedFans(pageId: number, specs: Array<{ id: string; netMills: number }>) {
  const rows = await upsertFans(appContext.db, specs.map((spec) => (
    { platform: "onlyfans" as const, platformUserId: spec.id, username: `u${spec.id}` }
  )));
  await upsertFanPages(appContext.db, rows.map((fan) => ({ fanId: fan.id, platformAccountId: pageId })));
  for (const spec of specs) {
    await testDb!.pool.query(
      `update page_fans set total_creator_net_mills = $1
       where platform_account_id = $2 and fan_id = (select id from fans where platform = 'onlyfans' and platform_user_id = $3)`,
      [spec.netMills, pageId, spec.id],
    );
  }
}

// Production shapes (2026-10-22): a live fan, a deleted account's stub, a
// fan whose chat is closed to the page, a blocked one.
const PROFILES: Record<string, Record<string, unknown>> = {
  101: { id: 101, username: "u101", name: "Fan", isBlocked: false, isRestricted: false, canReceiveChatMessage: true },
  102: { id: 102, username: "", name: "Ian", isBlocked: false, isRestricted: false, canReceiveChatMessage: false },
  104: { id: 104, username: "u104", name: "Fan", isBlocked: false, isRestricted: false, canReceiveChatMessage: false },
  105: { id: 105, username: "u105", name: "Fan", isBlocked: true, isRestricted: false, canReceiveChatMessage: false },
};

function usersPage(userIds: string[], profiles: Record<string, Record<string, unknown>>): OfapiListPage {
  const data = Object.fromEntries(userIds.flatMap((id) => profiles[id] ? [[id, profiles[id]]] : []));
  return { items: Object.values(data), hasNextPage: false, meta: null, rawBody: { data } };
}

function usersClient(answer: (accountId: string, userIds: string[]) => OfapiListPage | Error, calls: string[][]): OfapiClient {
  return {
    async getUserDetailsList(_context: unknown, accountId: string, userIds: string[]) {
      calls.push(userIds);
      const result = answer(accountId, userIds);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as OfapiClient;
}

async function answers(pageId: number) {
  const { rows } = await testDb!.pool.query<{
    id: string; asked: boolean; resolved: boolean | null; contactability: string | null; deleted_mark: boolean;
  }>(`
    select f.platform_user_id as id, pf.account_lookup_at is not null as asked,
           pf.account_probe_resolved as resolved, pf.account_contactability as contactability,
           f.deleted_detected_at is not null as deleted_mark
    from page_fans pf join fans f on f.id = pf.fan_id
    where pf.platform_account_id = $1 order by f.platform_user_id
  `, [pageId]);
  return rows;
}

async function journal(pageId: number) {
  const { rows } = await testDb!.pool.query<{ payload: Record<string, unknown> }>(`
    select coalesce(o.payload, b.body) as payload from observations o
    left join capture_json_hot_bodies b on b.bucket_month = o.payload_bucket_month and b.object_id = o.payload_object_id
    where o.kind = 'ofapi_users_list' and o.account_id = $1 and o.source = 'pull' and o.platform = 'onlyfans'
    order by o.id
  `, [pageId]);
  return rows.map((row) => row.payload);
}

async function dayCredits() {
  const { rows } = await testDb!.pool.query<{ global: number; audience: number }>(
    "select coalesce(spent_credits, 0)::int as global, coalesce(audience_spent_credits, 0)::int as audience from ofapi_credit_state where id = 1",
  );
  return rows[0] ?? { global: 0, audience: 0 };
}

describe("OFAPI fan account check", () => {
  it("records each paying fan's answer on the page, journaled, and asks again only after a week", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("fac-of", "acct_fac");
    await seedFans(page.id, [
      { id: "101", netMills: 50_000 },
      { id: "102", netMills: 900_000 },
      { id: "103", netMills: 0 },
      { id: "104", netMills: 40_000 },
      { id: "105", netMills: 30_000 },
      { id: "106", netMills: 20_000 },
    ]);

    const calls: string[][] = [];
    appContext = { ...appContext, ofapi: usersClient((_account, ids) => usersPage(ids, PROFILES), calls) };

    const first = await runOfapiFanAccountCheck(appContext);
    expect(first.pages).toEqual([{
      pageLabel: "fac-of", status: "checked", reason: null, requests: 1,
      answers: { gone: 1, contactable: 1, unavailable: 1, blocked: 1 }, unanswered: 1,
    }]);
    // Bigger spenders first; the fan who never paid is never asked.
    expect(calls).toEqual([["102", "101", "104", "105", "106"]]);
    expect(await answers(page.id)).toEqual([
      { id: "101", asked: true, resolved: true, contactability: "contactable", deleted_mark: false },
      { id: "102", asked: true, resolved: false, contactability: "gone", deleted_mark: false },
      { id: "103", asked: false, resolved: null, contactability: null, deleted_mark: false },
      { id: "104", asked: true, resolved: true, contactability: "unavailable", deleted_mark: false },
      { id: "105", asked: true, resolved: false, contactability: "blocked", deleted_mark: false },
      // Left out of the answer: asked, no answer, asked again next week.
      { id: "106", asked: true, resolved: null, contactability: null, deleted_mark: false },
    ]);
    const { data } = usersPage(["102", "101", "104", "105", "106"], PROFILES).rawBody as { data: unknown };
    expect(await journal(page.id)).toEqual([
      { ofapiAccountId: "acct_fac", userIds: ["102", "101", "104", "105", "106"], body: { data } },
    ]);

    // Fresh answers: the next pass asks nobody.
    await runOfapiFanAccountCheck(appContext);
    expect(calls).toHaveLength(1);

    // A week on, the fan is asked again and his new answer replaces the old.
    await testDb.pool.query(
      `update page_fans set account_lookup_at = now() - interval '8 days'
       where platform_account_id = $1 and fan_id = (select id from fans where platform_user_id = '104')`,
      [page.id],
    );
    appContext = {
      ...appContext,
      ofapi: usersClient((_account, ids) => usersPage(ids, { 104: { ...PROFILES[104], canReceiveChatMessage: true } }), calls),
    };
    await runOfapiFanAccountCheck(appContext);
    expect(calls.at(-1)).toEqual(["104"]);
    expect((await answers(page.id)).find((row) => row.id === "104")).toMatchObject({ resolved: true, contactability: "contactable" });
  });

  it("gives each page its share of the pass and hands the unused part to the page with fans left", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const small = await seedPage("fac-small", "acct_small");
    const big = await seedPage("fac-big", "acct_big");
    await seedFans(small.id, [{ id: "1", netMills: 10_000 }]);
    await seedFans(big.id, Array.from({ length: 400 }, (_, index) => ({ id: String(1000 + index), netMills: 10_000 })));

    const calls: string[][] = [];
    const accounts: string[] = [];
    appContext = {
      ...appContext,
      ofapi: usersClient((account, ids) => {
        accounts.push(account);
        return usersPage(ids, {});
      }, calls),
    };

    await runOfapiFanAccountCheck(appContext);
    expect(calls).toHaveLength(OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS);
    expect(accounts.filter((account) => account === "acct_small")).toHaveLength(1);
    expect(accounts.filter((account) => account === "acct_big")).toHaveLength(OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS - 1);
  });

  it("spends no budget on a collection policy refusal and records nothing", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("fac-policy", "acct_policy");
    await seedFans(page.id, [{ id: "301", netMills: 50_000 }]);
    const calls: string[][] = [];
    appContext = { ...appContext, ofapi: usersClient(() => new OfapiCollectionPolicyError("daily_limit"), calls) };

    const before = await dayCredits();
    const result = await runOfapiFanAccountCheck(appContext);
    expect(result.pages[0]).toMatchObject({ status: "blocked", reason: "ofapi_collection_daily_limit", requests: 0 });
    expect(await dayCredits()).toEqual(before);
    expect(await answers(page.id)).toEqual([
      { id: "301", asked: false, resolved: null, contactability: null, deleted_mark: false },
    ]);
  });

  it("journals a body the client refused, records nothing and fails the page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage("fac-refused", "acct_refused");
    await seedFans(page.id, [{ id: "201", netMills: 50_000 }]);
    const refused = new OfapiApiError("OFAPI user details list shape unavailable", 200, null);
    Object.defineProperty(refused, "refusedListBody", { value: { data: [] }, enumerable: false });
    const calls: string[][] = [];
    appContext = { ...appContext, ofapi: usersClient(() => refused, calls) };

    const result = await runOfapiFanAccountCheck(appContext);
    expect(result.pages[0]).toMatchObject({ status: "failed", requests: 0 });
    expect(await journal(page.id)).toEqual([{ ofapiAccountId: "acct_refused", userIds: ["201"], body: { data: [] } }]);
    expect(await answers(page.id)).toEqual([
      { id: "201", asked: false, resolved: null, contactability: null, deleted_mark: false },
    ]);
  });
});

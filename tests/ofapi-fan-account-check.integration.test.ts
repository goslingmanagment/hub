// The OnlyFans fan account check: a paying fan the page's account still sees
// is recorded seen, OnlyFans' "User not found" 404 is recorded not seen — on
// the page link only, never the shared deleted mark — each answer journaled
// first; an answered fan is not asked again inside the recheck window, and an
// answer the check cannot read records nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  upsertFanPages,
  upsertFans,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runOfapiFanAccountCheck } from "../apps/runtime/src/services/ofapi-fan-account-check.ts";
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

// The production answer for a deleted fan (2026-10-22).
const USER_NOT_FOUND_BODY = JSON.stringify({
  error: "ONLYFANS_COM_ERROR",
  message: "The requested OnlyFans resource was not found.",
  onlyfans_response: { status: 404, body: { error: { code: 0, message: "User not found" } } },
});

async function seedPage() {
  const model = await createModel(appContext.db, { slug: "model-fac", name: "Model fac" });
  const page = await createOnlyFansPage(appContext.db, { modelId: model!.id, label: "fac-of" });
  await setPageOfapiAccountId(appContext.db, { pageId: page!.id, ofapiAccountId: "acct_fac" });
  return page!;
}

async function seedFan(pageId: number, platformUserId: string, netMills: number) {
  const [fan] = await upsertFans(appContext.db, [{ platform: "onlyfans", platformUserId, username: `u${platformUserId}` }]);
  await upsertFanPages(appContext.db, [{ fanId: fan!.id, platformAccountId: pageId }]);
  await testDb!.pool.query(
    "update page_fans set total_creator_net_mills = $1 where platform_account_id = $2 and fan_id = $3",
    [netMills, pageId, fan!.id],
  );
  return fan!;
}

function profilePage(id: string): OfapiListPage {
  const profile = { id: Number(id), username: `u${id}`, name: "Fan" };
  return { items: [profile], hasNextPage: false, meta: null, rawBody: { data: profile } };
}

function userDetailsClient(answer: (userId: string) => OfapiListPage | Error, calls: string[]): OfapiClient {
  return {
    async getUserDetails(_context: unknown, _accountId: string, userId: string) {
      calls.push(userId);
      const result = answer(userId);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as OfapiClient;
}

async function answers(pageId: number) {
  const { rows } = await testDb!.pool.query<{
    platform_user_id: string;
    looked_up: boolean;
    resolved: boolean | null;
    deleted_mark: boolean;
  }>(`
    select f.platform_user_id, pf.account_lookup_at is not null as looked_up,
           pf.account_probe_resolved as resolved, f.deleted_detected_at is not null as deleted_mark
    from page_fans pf join fans f on f.id = pf.fan_id
    where pf.platform_account_id = $1 order by f.platform_user_id
  `, [pageId]);
  return rows;
}

async function journal(pageId: number) {
  const { rows } = await testDb!.pool.query<{ payload: Record<string, unknown> }>(`
    select coalesce(o.payload, b.body) as payload from observations o
    left join capture_json_hot_bodies b on b.bucket_month = o.payload_bucket_month and b.object_id = o.payload_object_id
    where o.kind = 'ofapi_user_details' and o.account_id = $1 and o.source = 'pull' and o.platform = 'onlyfans'
    order by o.id
  `, [pageId]);
  return rows.map((row) => row.payload);
}

describe("OFAPI fan account check", () => {
  it("records a seen and a not-seen paying fan on the page, journaled, and skips a fan who never paid", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedFan(page.id, "101", 50_000);
    await seedFan(page.id, "102", 900_000);
    await seedFan(page.id, "103", 0);

    const calls: string[] = [];
    appContext = {
      ...appContext,
      ofapi: userDetailsClient((userId) => userId === "102"
        ? new OfapiApiError("OFAPI request failed: GET /acct_fac/users/102 returned 404", 404, USER_NOT_FOUND_BODY)
        : profilePage(userId), calls),
    };

    const first = await runOfapiFanAccountCheck(appContext);
    expect(first.pages).toEqual([{ pageLabel: "fac-of", status: "checked", reason: null, seen: 1, notSeen: 1 }]);
    // The bigger spender first; the fan who never paid is never asked.
    expect(calls).toEqual(["102", "101"]);
    expect(await answers(page.id)).toEqual([
      { platform_user_id: "101", looked_up: true, resolved: true, deleted_mark: false },
      { platform_user_id: "102", looked_up: true, resolved: false, deleted_mark: false },
      { platform_user_id: "103", looked_up: false, resolved: null, deleted_mark: false },
    ]);
    expect(await journal(page.id)).toEqual([
      { ofapiAccountId: "acct_fac", userId: "102", status: 404, body: JSON.parse(USER_NOT_FOUND_BODY) },
      { ofapiAccountId: "acct_fac", userId: "101", status: 200, body: { data: { id: 101, username: "u101", name: "Fan" } } },
    ]);

    // Both answers are fresh: the next pass asks nobody.
    const second = await runOfapiFanAccountCheck(appContext);
    expect(second.pages[0]).toMatchObject({ status: "checked", seen: 0, notSeen: 0 });
    expect(calls).toHaveLength(2);
  });

  it("records nothing for an answer it cannot read and fails the page", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await seedFan(page.id, "201", 50_000);

    const calls: string[] = [];
    // Our own account missing is not the fan missing.
    const accountNotFound = JSON.stringify({ error: { code: "account_not_found" } });
    appContext = {
      ...appContext,
      ofapi: userDetailsClient(() => new OfapiApiError("returned 404", 404, accountNotFound), calls),
    };

    const result = await runOfapiFanAccountCheck(appContext);
    expect(result.pages[0]).toMatchObject({ status: "failed", seen: 0, notSeen: 0 });
    expect(await answers(page.id)).toEqual([
      { platform_user_id: "201", looked_up: false, resolved: null, deleted_mark: false },
    ]);
    expect(await journal(page.id)).toEqual([]);
  });
});

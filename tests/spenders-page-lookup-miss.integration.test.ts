// Arena "vanished chat" R6: a payer the page cannot see carries the page's own
// mark in that page's spender lists. Since PR8 a page's Fansly account lookup
// records its answer on the page link (page_fans.account_probe_at /
// account_probe_resolved) instead of the shared deleted mark. The lists read
// only the listed page's answer: `festerpenis` unseen by lora-1 is marked there
// and shows normally on lilly-2, which sees him. Who is listed, the sums and
// the shared deleted mark's handling do not change.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  recalculateFanPageSpend,
  recordFanPageAccountLookupAnswers,
  upsertFanPage,
  upsertFans,
  upsertTransaction,
} from "@agency_hub_core/db";
import type { PageSpenderAutoListDetailResponse, SpenderListResponse } from "@agency_hub_core/contracts";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { getPageSpenderAutoListDetail, getSpenderList } from "../apps/runtime/src/services/spenders.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

const DAY_MS = 24 * 60 * 60 * 1000;
const ANSWERED_AT = new Date(Date.now() - 3 * DAY_MS);

const owner: HumanAuthPrincipal = {
  authMethod: "session",
  user: { id: 1, username: "owner", role: "owner", mustChangePassword: false, assignedPages: [] },
  assignedPageIds: [],
};

type Pages = Record<"lora1" | "lora2" | "lilly2", { id: number; label: string }>;
type Fans = Record<"hidden" | "seen" | "unasked" | "deleted", { id: number; platformUserId: string }>;

async function seed(): Promise<{ pages: Pages; fans: Fans }> {
  const lora = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const lilly = await createModel(appContext.db, { slug: "lilly", name: "Lilly" });
  const pages: Pages = {
    lora1: (await createFanslyPage(appContext.db, { modelId: lora!.id, label: "lora-1" }))!,
    lora2: (await createFanslyPage(appContext.db, { modelId: lora!.id, label: "lora-2" }))!,
    lilly2: (await createFanslyPage(appContext.db, { modelId: lilly!.id, label: "lilly-2" }))!,
  };
  const [hidden, seen, unasked, deleted] = await upsertFans(appContext.db, [
    { platform: "fansly", platformUserId: "100000000000000001", username: "festerpenis", displayName: null },
    { platform: "fansly", platformUserId: "100000000000000002", username: "seenbuyer", displayName: null },
    { platform: "fansly", platformUserId: "100000000000000003", username: "neverasked", displayName: null },
    { platform: "fansly", platformUserId: "100000000000000004", username: "gone", displayName: null },
  ]);
  const fans: Fans = { hidden: hidden!, seen: seen!, unasked: unasked!, deleted: deleted! };

  // Who paid where: the hidden payer on all three pages, the rest on lora-1.
  const spend: Array<[keyof Pages, keyof Fans, bigint]> = [
    ["lora1", "hidden", 40_000n],
    ["lora2", "hidden", 30_000n],
    ["lilly2", "hidden", 35_000n],
    ["lora1", "seen", 45_000n],
    ["lora1", "unasked", 30_000n],
    ["lora1", "deleted", 26_000n],
  ];
  let n = 0;
  for (const [pageKey, fanKey, amount] of spend) {
    n += 1;
    await upsertFanPage(appContext.db, { fanId: fans[fanKey].id, platformAccountId: pages[pageKey].id, isFollower: true });
    await upsertTransaction(appContext.db, {
      platformAccountId: pages[pageKey].id,
      source: "fansly:rest",
      fanId: fans[fanKey].id,
      transactionId: `tx-${n}`,
      rawType: 7,
      canonicalType: "tip",
      transactionState: "posted",
      rawStatus: 2,
      grossAmountMills: amount,
      sourceDestinationAmountMills: amount,
      creatorNetAmountMills: amount,
      occurredAt: new Date(Date.now() - (2 * DAY_MS) - n * 60_000),
    });
  }
  // The shared deleted mark keeps hiding its fan, as before.
  await upsertFans(appContext.db, [{
    platform: "fansly",
    platformUserId: fans.deleted.platformUserId,
    deletedDetectedAt: new Date(Date.now() - DAY_MS),
  }]);
  for (const page of Object.values(pages)) {
    await recalculateFanPageSpend(appContext.db, page.id);
  }
  return { pages, fans };
}

/** The page answers as PR8 records them: lora-1 does not see the hidden payer
 *  (nor the deleted one) and sees `seenbuyer`; lilly-2 sees the hidden payer;
 *  lora-2 never asked. */
async function recordAnswers({ pages, fans }: { pages: Pages; fans: Fans }) {
  await recordFanPageAccountLookupAnswers(appContext.db, {
    platformAccountId: pages.lora1.id,
    answeredAt: ANSWERED_AT,
    resolvedFanIds: [fans.seen.id],
    unresolvedFanIds: [fans.hidden.id, fans.deleted.id],
  });
  await recordFanPageAccountLookupAnswers(appContext.db, {
    platformAccountId: pages.lilly2.id,
    answeredAt: ANSWERED_AT,
    resolvedFanIds: [fans.hidden.id],
    unresolvedFanIds: [],
  });
}

function pageList(pageLabel: string, period: "lifetime" | "30d" = "lifetime") {
  return getSpenderList(appContext, owner, { scope: "page", pageLabel, period, limit: 50, offset: 0 });
}

function autoList(pageLabel: string, bucketKey: string, period: "lifetime" | "30d" = "lifetime") {
  return getPageSpenderAutoListDetail(appContext, pageLabel, bucketKey, { limit: 50, offset: 0, period });
}

function marks(response: SpenderListResponse | PageSpenderAutoListDetailResponse) {
  return Object.fromEntries(response.items.map((item) => [item.fan.username, item.accountLookupMissAt]));
}

/** Everything but the mark, to prove the mark moved nothing else. */
function withoutMarks<T extends SpenderListResponse | PageSpenderAutoListDetailResponse>(response: T) {
  return { ...response, items: response.items.map(({ accountLookupMissAt: _mark, ...rest }) => rest) };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
});

afterAll(async () => {
  await testDb?.stop();
});

describe("a page's spender lists carry its own 'cannot see this fan' answer", () => {
  it("marks the payer on the page that does not see him and nowhere else", async () => {
    const seeded = await seed();
    await recordAnswers(seeded);
    const missAt = ANSWERED_AT.toISOString();

    for (const period of ["lifetime", "30d"] as const) {
      expect(marks(await pageList("lora-1", period)), period).toEqual({
        festerpenis: missAt,
        seenbuyer: null,
        neverasked: null,
      });
      // lilly-2's own lookup returned him; lora-2 never asked.
      expect(marks(await pageList("lilly-2", period)), period).toEqual({ festerpenis: null });
      expect(marks(await pageList("lora-2", period)), period).toEqual({ festerpenis: null });
    }

    // A list over several pages has no single page's answer to show.
    const model = await getSpenderList(appContext, owner, {
      scope: "model", modelSlug: "lora", platform: "fansly", period: "lifetime", limit: 50, offset: 0,
    });
    expect(marks(model)).toEqual({ festerpenis: null, seenbuyer: null, neverasked: null });

    // The auto-lists read the same page link, lifetime and windowed.
    for (const period of ["lifetime", "30d"] as const) {
      expect(marks(await autoList("lora-1", "25-50", period)), period).toEqual({
        seenbuyer: null,
        festerpenis: missAt,
        neverasked: null,
      });
      expect(marks(await autoList("lilly-2", "25-50", period)), period).toEqual({ festerpenis: null });
    }
  });

  it("changes nothing but the mark: the same payers, order, totals and money", async () => {
    const seeded = await seed();
    const before = {
      lifetime: await pageList("lora-1"),
      window: await pageList("lora-1", "30d"),
      auto: await autoList("lora-1", "25-50"),
    };
    for (const response of Object.values(before)) {
      expect(response.items.every((item) => item.accountLookupMissAt === null)).toBe(true);
      // The fan under the shared deleted mark stays out of the lists, as before.
      expect(response.items.map((item) => item.fan.username)).not.toContain("gone");
    }

    await recordAnswers(seeded);

    expect(withoutMarks(await pageList("lora-1"))).toEqual(withoutMarks(before.lifetime));
    expect(withoutMarks(await pageList("lora-1", "30d"))).toEqual(withoutMarks(before.window));
    expect(withoutMarks(await autoList("lora-1", "25-50"))).toEqual(withoutMarks(before.auto));
  });

  it("drops the mark once the page's latest answer returns the fan", async () => {
    const seeded = await seed();
    await recordAnswers(seeded);
    await recordFanPageAccountLookupAnswers(appContext.db, {
      platformAccountId: seeded.pages.lora1.id,
      answeredAt: new Date(ANSWERED_AT.getTime() + DAY_MS),
      resolvedFanIds: [seeded.fans.hidden.id],
      unresolvedFanIds: [],
    });

    expect(marks(await pageList("lora-1")).festerpenis).toBeNull();
    expect(marks(await autoList("lora-1", "25-50")).festerpenis).toBeNull();
  });
});

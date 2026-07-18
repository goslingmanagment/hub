// Stage 14: fan_identities OFAPI branch — tracking/trial-link users flow into
// fans/page_fans via OFAPI (the stream keeps its name, the vendor changes).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findPageById,
  getCheckpoint,
  setPageOfapiAccountId,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { syncOfapiFanIdentities } from "../apps/runtime/src/services/sync/ofapi-fan-identities.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const OFAPI_ACCOUNT = "acct_links";

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
  appContext = createTestAppContext(testDb, {
    ofapiFanIdentitiesSyncEnabled: true,
    ofapiCreditLedgerEnabled: true,
  });
});

function listPage(items: Record<string, unknown>[]): OfapiListPage {
  return { items, hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null };
}

function linkUser(id: number, username: string, name: string) {
  return { id, username, name, displayName: "" };
}

function fakeLinksClient(input: {
  trackingLinks: Record<string, unknown>[];
  trialLinks: Record<string, unknown>[];
  trackingUsers: Map<string, Record<string, unknown>[]>; // key `${linkId}:${kind}`
  trialSubscribers: Map<string, Record<string, unknown>[]>;
}) {
  const calls: string[] = [];
  const client = {
    listTrackingLinks: vi.fn(async () => {
      calls.push("tracking-links");
      return listPage(input.trackingLinks);
    }),
    listTrialLinks: vi.fn(async () => {
      calls.push("trial-links");
      return listPage(input.trialLinks);
    }),
    listTrackingLinkUsers: vi.fn(async (
      _context: unknown,
      _accountId: string,
      linkId: string,
      kind: string,
    ) => {
      calls.push(`tracking:${linkId}:${kind}`);
      return listPage(input.trackingUsers.get(`${linkId}:${kind}`) ?? []);
    }),
    listTrialLinkSubscribers: vi.fn(async (
      _context: unknown,
      _accountId: string,
      linkId: string,
    ) => {
      calls.push(`trial:${linkId}`);
      return listPage(input.trialSubscribers.get(linkId) ?? []);
    }),
  } as unknown as OfapiClient;
  return { client, calls };
}

function fakeTelemetry() {
  return {
    recordPhaseStarted: vi.fn(async () => {}),
    recordCheckpointLoaded: vi.fn(async () => {}),
    recordCheckpointAdvanced: vi.fn(async () => {}),
    addAnomaly: vi.fn(async () => {}),
    addNote: vi.fn(async () => {}),
    getRequestObserver: () => null,
  } as never;
}

async function seedMappedPage(label = "links-of") {
  const model = await createModel(appContext.db, {
    slug: `model-${label}`,
    name: `Model ${label}`,
  });
  if (!model) {
    throw new Error(`failed to create model for ${label}`);
  }
  const page = await createOnlyFansPage(appContext.db, { modelId: model.id, label });
  if (!page) {
    throw new Error(`failed to create page ${label}`);
  }
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId: OFAPI_ACCOUNT });
  return page;
}

async function buildInput(page: { id: number }) {
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  return {
    pageContext: {
      page: stored.page,
      platform: "onlyfans" as const,
      auth: { token: "unused" },
      proxy: null,
      egressKey: "direct",
    } as never,
    telemetry: fakeTelemetry(),
    budget: new SyncChunkBudget(50, 60_000),
    requestSeq: 1,
  };
}

describe("OFAPI fan identities (tracking/trial links)", () => {
  it("feeds link users into fans and page_fans", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage();
    const { client, calls } = fakeLinksClient({
      trackingLinks: [{ id: 42, campaignName: "IG Bio" }],
      trialLinks: [{ id: 7, trialLinkName: "Trial A" }],
      trackingUsers: new Map([
        ["42:subscribers", [linkUser(100001, "user1", "User One"), linkUser(100002, "user2", "User Two")]],
        // user2 also spent — dedupe happens naturally via the fans upsert.
        ["42:spenders", [linkUser(100002, "user2", "User Two")]],
      ]),
      trialSubscribers: new Map([
        ["7", [linkUser(100003, "user3", "Deleted user")]],
      ]),
    });
    appContext = { ...appContext, ofapi: client };

    const result = await syncOfapiFanIdentities(appContext, await buildInput(page));

    expect(result.satisfied).toBe(true);
    expect(result.stats).toMatchObject({
      trackingLinks: 1,
      trialLinks: 1,
    });
    // tracking-links, trial-links, 42:subscribers, 42:spenders, trial:7
    expect(calls).toEqual([
      "tracking-links",
      "trial-links",
      "tracking:42:subscribers",
      "tracking:42:spenders",
      "trial:7",
    ]);

    const { rows } = await testDb.pool.query<{
      platform_user_id: string;
      username: string | null;
      display_name: string | null;
      on_page: boolean;
    }>(`
      select f.platform_user_id, f.username, f.display_name,
             exists(
               select 1 from page_fans pf
               where pf.fan_id = f.id and pf.platform_account_id = $1
             ) as on_page
      from fans f order by f.platform_user_id
    `, [page.id]);

    expect(rows).toEqual([
      { platform_user_id: "100001", username: "user1", display_name: "User One", on_page: true },
      { platform_user_id: "100002", username: "user2", display_name: "User Two", on_page: true },
      // "Deleted user" display names are dropped; the fan row still lands.
      { platform_user_id: "100003", username: "user3", display_name: null, on_page: true },
    ]);
  });

  it("yields on the per-run request cap with partial coverage kept", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiFanIdentitiesSyncEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiAudienceMaxRequestsPerRun: 3,
    });
    const page = await seedMappedPage("links-cap-of");
    const { client } = fakeLinksClient({
      trackingLinks: [{ id: 42 }],
      trialLinks: [{ id: 7 }],
      trackingUsers: new Map([
        ["42:subscribers", [linkUser(200001, "cap1", "Cap One")]],
        ["42:spenders", [linkUser(200002, "cap2", "Cap Two")]],
      ]),
      trialSubscribers: new Map([["7", [linkUser(200003, "cap3", "Cap Three")]]]),
    });
    appContext = { ...appContext, ofapi: client };

    const result = await syncOfapiFanIdentities(appContext, await buildInput(page));

    // 3 requests allowed: tracking-links, trial-links, 42:subscribers — then cap.
    expect(result.satisfied).toBe(false);
    expect(result.yieldReason).toBe("request_budget");
    expect(result.stats).toMatchObject({ ofapiBudgetBlock: "ofapi_request_budget" });

    const { rows } = await testDb.pool.query<{ n: string }>(
      "select count(*)::text as n from fans",
    );
    // The prefix fetched before the cap (42:subscribers) is kept.
    expect(rows).toEqual([{ n: "1" }]);
  });

  it("resumes after completed targets and within a paginated target", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiFanIdentitiesSyncEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiAudienceMaxRequestsPerRun: 4,
    });
    const page = await seedMappedPage("links-resume-of");
    const calls: string[] = [];
    const hundredUsers = Array.from({ length: 100 }, (_, index) =>
      linkUser(300000 + index, `resume${index}`, `Resume ${index}`)
    );
    appContext = {
      ...appContext,
      ofapi: {
        listTrackingLinks: vi.fn(async () => {
          calls.push("tracking-links");
          return listPage([{ id: 42 }, { id: 43 }]);
        }),
        listTrialLinks: vi.fn(async () => {
          calls.push("trial-links");
          return listPage([]);
        }),
        listTrackingLinkUsers: vi.fn(async (
          _context: unknown,
          _accountId: string,
          linkId: string,
          kind: string,
          options: { offset?: number },
        ) => {
          const offset = options.offset ?? 0;
          calls.push(`tracking:${linkId}:${kind}:${offset}`);
          if (linkId === "42" && kind === "spenders" && offset === 0) {
            return listPage(hundredUsers);
          }
          return listPage([linkUser(Number(linkId) * 100 + offset, `u${linkId}`, `U ${linkId}`)]);
        }),
        listTrialLinkSubscribers: vi.fn(async () => listPage([])),
      } as unknown as OfapiClient,
    };

    const first = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(first.satisfied).toBe(false);
    expect(first.stats).toMatchObject({
      completedTargets: 1,
      activeTargetKey: "tracking:42:spenders",
      activeOffset: 100,
    });

    const second = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(second.satisfied).toBe(true);
    expect(second.stats).toMatchObject({ completedTargets: 4 });
    expect(calls.filter((call) => call === "tracking-links")).toHaveLength(1);
    expect(calls.filter((call) => call === "trial-links")).toHaveLength(1);
    expect(calls.filter((call) => call === "tracking:42:subscribers:0")).toHaveLength(1);
    expect(calls.filter((call) => call === "tracking:42:spenders:0")).toHaveLength(1);
    expect(calls.filter((call) => call === "tracking:42:spenders:100")).toHaveLength(1);
  });

  it("checkpoints multi-page link discovery across chunks without replaying offsets", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    appContext = createTestAppContext(testDb, {
      ofapiFanIdentitiesSyncEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiAudienceMaxRequestsPerRun: 2,
    });
    const page = await seedMappedPage("links-phase-one-resume-of");
    const linkCalls: string[] = [];
    const userCalls: string[] = [];
    const repeatedLinks = (id: number, count: number) =>
      Array.from({ length: count }, () => ({ id }));
    appContext = {
      ...appContext,
      ofapi: {
        listTrackingLinks: vi.fn(async (
          _context: unknown,
          _accountId: string,
          options: { offset?: number; limit?: number },
        ) => {
          const offset = options.offset ?? 0;
          const limit = options.limit ?? 0;
          linkCalls.push(`tracking:${offset}:${limit}`);
          return listPage(offset < 200 ? repeatedLinks(42, 100) : [{ id: 42 }]);
        }),
        listTrialLinks: vi.fn(async (
          _context: unknown,
          _accountId: string,
          options: { offset?: number; limit?: number },
        ) => {
          const offset = options.offset ?? 0;
          const limit = options.limit ?? 0;
          linkCalls.push(`trial:${offset}:${limit}`);
          return listPage(offset === 0 ? repeatedLinks(7, 100) : [{ id: 7 }]);
        }),
        listTrackingLinkUsers: vi.fn(async (
          _context: unknown,
          _accountId: string,
          linkId: string,
          kind: string,
          options: { offset?: number },
        ) => {
          userCalls.push(`tracking:${linkId}:${kind}:${options.offset ?? 0}`);
          return listPage([]);
        }),
        listTrialLinkSubscribers: vi.fn(async (
          _context: unknown,
          _accountId: string,
          linkId: string,
          options: { offset?: number },
        ) => {
          userCalls.push(`trial:${linkId}:${options.offset ?? 0}`);
          return listPage([]);
        }),
      } as unknown as OfapiClient,
    };

    const first = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(first).toMatchObject({
      satisfied: false,
      stats: { phase: "links", linkType: "tracking", linkOffset: 200 },
    });
    const second = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(second).toMatchObject({
      satisfied: false,
      stats: { phase: "links", linkType: "trial", linkOffset: 100 },
    });
    const third = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(third.satisfied).toBe(false);
    const fourth = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(fourth.satisfied).toBe(true);

    expect(linkCalls).toEqual([
      "tracking:0:100",
      "tracking:100:100",
      "tracking:200:100",
      "trial:0:100",
      "trial:100:100",
    ]);
    expect(userCalls).toEqual([
      "tracking:42:subscribers:0",
      "tracking:42:spenders:0",
      "trial:7:0",
    ]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_identities");
    expect(checkpoint?.state).toMatchObject({
      version: 2,
      phase: "users",
      linkType: null,
      linkOffset: 0,
      trackingLinkIds: ["42"],
      trialLinkIds: ["7"],
    });
  });

  it("upgrades a v1 cursor without losing completed or active user targets", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage("links-v1-upgrade-of");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "fan_identities",
      state: {
        version: 1,
        revision: 1,
        completedTargetKeys: ["tracking:42:subscribers"],
        activeTargetKey: "tracking:42:spenders",
        activeOffset: 100,
      },
    });
    const calls: string[] = [];
    appContext = {
      ...appContext,
      ofapi: {
        listTrackingLinks: vi.fn(async () => listPage([{ id: 42 }])),
        listTrialLinks: vi.fn(async () => listPage([{ id: 7 }])),
        listTrackingLinkUsers: vi.fn(async (
          _context: unknown,
          _accountId: string,
          linkId: string,
          kind: string,
          options: { offset?: number },
        ) => {
          calls.push(`tracking:${linkId}:${kind}:${options.offset ?? 0}`);
          return listPage([]);
        }),
        listTrialLinkSubscribers: vi.fn(async (
          _context: unknown,
          _accountId: string,
          linkId: string,
          options: { offset?: number },
        ) => {
          calls.push(`trial:${linkId}:${options.offset ?? 0}`);
          return listPage([]);
        }),
      } as unknown as OfapiClient,
    };

    const result = await syncOfapiFanIdentities(appContext, await buildInput(page));

    expect(result.satisfied).toBe(true);
    expect(calls).toEqual([
      "tracking:42:spenders:100",
      "trial:7:0",
    ]);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_identities");
    expect(checkpoint?.state).toMatchObject({
      version: 2,
      phase: "users",
      completedTargetKeys: [
        "tracking:42:spenders",
        "tracking:42:subscribers",
        "trial:7:subscribers",
      ],
    });
  });
});

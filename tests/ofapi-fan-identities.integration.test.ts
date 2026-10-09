// Stage 14: fan_identities OFAPI branch — tracking/trial-link users flow into
// fans/page_fans via OFAPI (the stream keeps its name, the vendor changes).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  ensurePageSyncStates,
  findPageById,
  getCheckpoint,
  requestPageSync,
  setPageOfapiAccountId,
  startSyncRun,
  upsertCheckpointProgress,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { SyncPayloadPersistenceError } from "../apps/runtime/src/services/sync/errors.ts";
import { executeNextSyncPageChunk } from "../apps/runtime/src/services/sync/executor.ts";
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

function listPage(items: Record<string, unknown>[], hasNextPage = items.length === 100): OfapiListPage {
  return { items, hasNextPage, nextMarker: null, nextPageUrl: null, meta: null };
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

async function buildInput(page: { id: number }, options?: { syncRunId?: number }) {
  const stored = await findPageById(appContext.db, page.id);
  if (!stored) {
    throw new Error(`page ${page.id} missing`);
  }
  // Each chunk has its own run, as in the executor: the journal rows point at it.
  const syncRunId = options?.syncRunId ?? (await startSyncRun(appContext.db, {
    platformAccountId: page.id,
    stream: "fan_identities",
    trigger: "manual",
  }))!.id;
  return {
    syncRunId,
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
  // Since 2026-09-29 OFAPI answers absolute next_page links on api.onlyfansapi.com.
  it.each([
    ["a relative", ""],
    ["an api.onlyfansapi.com", "https://api.onlyfansapi.com"],
  ])("R1 persists a short subscriber continuation from %s link and resumes without completing or rebuying its prefix", async (_label, origin) => {
    appContext = createTestAppContext(testDb!, {
      ofapiFanIdentitiesSyncEnabled: true, ofapiCreditLedgerEnabled: true,
      ofapiAudienceMaxRequestsPerRun: 4,
    });
    const page = await seedMappedPage("short-continuation");
    const calls: string[] = [];
    appContext = { ...appContext, ofapi: {
      listTrackingLinks: async (_context: unknown, _account: string, params: { offset: number }) => {
        calls.push(`links:${params.offset}`);
        return params.offset === 0 ? { ...listPage([{ id: 42 }], true),
          nextPageUrl: `${origin}/api/${OFAPI_ACCOUNT}/tracking-links?offset=10&limit=100` } : listPage([]);
      },
      listTrialLinks: async () => { calls.push("trial"); return listPage([]); },
      listTrackingLinkUsers: async (_context: unknown, _account: string, _id: string,
        kind: string, params: { offset: number }) => {
        calls.push(`${kind}:${params.offset}`);
        if (kind === "spenders") return listPage([]);
        return { ...listPage([linkUser(700000 + params.offset, "user", "User")], params.offset === 0),
          nextPageUrl: params.offset === 0 ? `${origin}/api/${OFAPI_ACCOUNT}/tracking-links/42/subscribers?offset=10&limit=100` : null };
      },
      listTrialLinkSubscribers: async () => listPage([]),
    } as unknown as OfapiClient };
    const result = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(result.satisfied).toBe(false);
    const checkpoint = await getCheckpoint(appContext.db, page.id, "fan_identities");
    expect(checkpoint?.state).toMatchObject({ activeTargetKey: "tracking:42:subscribers", activeOffset: 10, completedTargetKeys: [] });
    const resumed = await syncOfapiFanIdentities(appContext, await buildInput(page));
    expect(resumed.satisfied).toBe(true);
    expect(calls).toEqual(["links:0", "links:10", "trial", "subscribers:0", "subscribers:10", "spenders:0"]);
    const fans = await testDb!.pool.query("select platform_user_id from fans order by platform_user_id");
    expect(fans.rows).toEqual([{ platform_user_id: "700000" }, { platform_user_id: "700010" }]);
  });

  it("R1 stops at a full terminal link page without buying an extra page", async () => {
    const page = await seedMappedPage("full-terminal");
    const { client } = fakeLinksClient({ trackingLinks: [], trialLinks: [], trackingUsers: new Map(), trialSubscribers: new Map() });
    const tracking = vi.fn(async () => listPage(Array.from({ length: 100 }, () => ({ id: 42 })), false));
    client.listTrackingLinks = tracking;
    appContext = { ...appContext, ofapi: client };
    expect((await syncOfapiFanIdentities(appContext, await buildInput(page))).satisfied).toBe(true);
    expect(tracking).toHaveBeenCalledTimes(1);
  });

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
        ["42:spenders", [{ onlyfans_id: "100002", username: "user2", name: "User Two" }, { onlyfans_id: "100004", username: "spender", name: "Spender Only" }]],
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
      { platform_user_id: "100004", username: "spender", display_name: "Spender Only", on_page: true },
    ]);
  });

  it("leaves last_seen_at of known fans alone and still renames them", async () => {
    const page = await seedMappedPage("links-last-seen-of");
    const subscribers = [linkUser(110001, "known", "Known"), linkUser(110002, "renamed", "Before")];
    const { client } = fakeLinksClient({
      trackingLinks: [{ id: 42 }],
      trialLinks: [],
      trackingUsers: new Map([["42:subscribers", subscribers]]),
      trialSubscribers: new Map(),
    });
    appContext = { ...appContext, ofapi: client };
    expect((await syncOfapiFanIdentities(appContext, await buildInput(page))).satisfied).toBe(true);

    // Both fans were last seen long before the next walk.
    const longAgo = "2026-01-01T00:00:00.000Z";
    await testDb!.pool.query("update fans set last_seen_at = $1", [longAgo]);
    await testDb!.pool.query("update page_fans set last_seen_at = $1", [longAgo]);
    subscribers.splice(1, 1, linkUser(110002, "renamed2", "After"), linkUser(110003, "fresh", "Fresh"));

    const next = await syncOfapiFanIdentities(appContext, { ...await buildInput(page), requestSeq: 2 });
    expect(next.satisfied).toBe(true);

    const { rows } = await testDb!.pool.query(`
      select f.platform_user_id, f.username, f.display_name,
             f.last_seen_at = $2::timestamptz as fan_kept,
             pf.last_seen_at = $2::timestamptz as page_fan_kept
      from fans f join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = $1
      order by f.platform_user_id
    `, [page.id, longAgo]);
    expect(rows).toEqual([
      { platform_user_id: "110001", username: "known", display_name: "Known", fan_kept: true, page_fan_kept: true },
      { platform_user_id: "110002", username: "renamed2", display_name: "After", fan_kept: true, page_fan_kept: true },
      // A fan the walk met for the first time is stamped as before.
      { platform_user_id: "110003", username: "fresh", display_name: "Fresh", fan_kept: false, page_fan_kept: false },
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

  it("resumes the active user target before sorted incomplete targets", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const page = await seedMappedPage("links-active-order-of");
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "fan_identities",
      state: {
        version: 2,
        revision: 1,
        phase: "users",
        linkType: null,
        linkOffset: 0,
        trackingLinkIds: ["10", "9"],
        trialLinkIds: [],
        completedTargetKeys: ["tracking:9:subscribers"],
        activeTargetKey: "tracking:9:spenders",
        activeOffset: 100,
      },
    });
    const calls: string[] = [];
    appContext = {
      ...appContext,
      ofapi: {
        listTrackingLinks: vi.fn(async () => {
          throw new Error("link discovery must not replay from a users-phase cursor");
        }),
        listTrialLinks: vi.fn(async () => {
          throw new Error("link discovery must not replay from a users-phase cursor");
        }),
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
        listTrialLinkSubscribers: vi.fn(async () => listPage([])),
      } as unknown as OfapiClient,
    };

    const result = await syncOfapiFanIdentities(appContext, await buildInput(page));

    expect(result.satisfied).toBe(true);
    expect(calls).toEqual([
      "tracking:9:spenders:100",
      "tracking:10:subscribers:0",
      "tracking:10:spenders:0",
    ]);
  });

  it("journals every list page with its link and request, untrimmed", async () => {
    const page = await seedMappedPage("links-journal-of");
    const trackingLinks = [{ id: 42, campaignName: "IG Bio", subscribersCount: 101 }];
    const trialLinks = [{ id: 7, trialLinkName: "Trial A", isFinished: true }];
    const firstSubscribers = Array.from({ length: 100 }, (_, index) =>
      linkUser(400000 + index, `journal${index}`, `Journal ${index}`)
    );
    const lastSubscribers = [
      { ...linkUser(400100, "journal100", "Journal 100"), subscribedOnData: { subscribeAt: "2026-10-01T00:00:00+00:00" } },
      // The parser drops a record without an id; the journal keeps it.
      { username: "no-id", name: "No Id" },
    ];
    const spenders = [{
      onlyfans_id: "400100",
      username: "journal100",
      name: "Journal 100",
      revenue: { total: 12.5, chargebacks: 0, calculated_at: "2026-10-08T00:00:00+00:00" },
    }];
    const trialSubscribers = [linkUser(400200, "trial1", "Trial One")];
    const nextPageUrl = `/api/${OFAPI_ACCOUNT}/tracking-links/42/subscribers?offset=100&limit=100`;
    appContext = {
      ...appContext,
      ofapi: {
        listTrackingLinks: async () => listPage(trackingLinks),
        listTrialLinks: async () => listPage(trialLinks),
        listTrackingLinkUsers: async (
          _context: unknown,
          _accountId: string,
          _linkId: string,
          kind: string,
          options: { offset?: number },
        ) => {
          if (kind === "spenders") return listPage(spenders);
          return (options.offset ?? 0) === 0
            ? { ...listPage(firstSubscribers, true), nextPageUrl }
            : listPage(lastSubscribers);
        },
        listTrialLinkSubscribers: async () => listPage(trialSubscribers),
      } as unknown as OfapiClient,
    };

    const input = await buildInput(page);
    const result = await syncOfapiFanIdentities(appContext, input);
    expect(result.satisfied).toBe(true);

    const journal = await testDb!.pool.query(
      `select endpoint, sync_run_id::int as sync_run_id, payload_kind, request_params, response_payload
       from sync_raw_payloads where page_id = $1 order by id`,
      [page.id],
    );
    expect(journal.rows.every((row) =>
      row.sync_run_id === input.syncRunId && row.payload_kind === "mapping_critical"
    )).toBe(true);
    const context = { limit: 100, requestSeq: 1, ofapiAccountId: OFAPI_ACCOUNT, hasNextPage: false, nextPageUrl: null };
    const link42 = { kind: "tracking", id: "42" };
    expect(journal.rows.map((row) => [row.endpoint, row.response_payload])).toEqual([
      ["link_lists_tracking_live", { ...context, linkKind: "tracking", offset: 0, items: trackingLinks }],
      ["link_lists_trial_live", { ...context, linkKind: "trial", offset: 0, items: trialLinks }],
      ["link_fans_tracking_subscribers", {
        ...context, link: link42, list: "subscribers", offset: 0, items: firstSubscribers,
        hasNextPage: true, nextPageUrl,
      }],
      ["link_fans_tracking_subscribers", {
        ...context, link: link42, list: "subscribers", offset: 100, items: lastSubscribers,
      }],
      ["link_fans_tracking_spenders", { ...context, link: link42, list: "spenders", offset: 0, items: spenders }],
      ["link_fans_trial_subscribers", {
        ...context, link: { kind: "trial", id: "7" }, list: "subscribers", offset: 0, items: trialSubscribers,
      }],
    ]);
    expect(journal.rows.map((row) => row.request_params)).toEqual([
      { limit: 100, offset: 0, path: "/:accountId/tracking-links" },
      { limit: 100, offset: 0, path: "/:accountId/trial-links" },
      { limit: 100, offset: 0, path: "/:accountId/tracking-links/:trackingLinkId/subscribers" },
      { limit: 100, offset: 100, path: "/:accountId/tracking-links/:trackingLinkId/subscribers" },
      { limit: 100, offset: 0, path: "/:accountId/tracking-links/:trackingLinkId/spenders" },
      { limit: 100, offset: 0, path: "/:accountId/trial-links/:trialLinkId/subscribers" },
    ]);

    // The observation half of the same dual-write carries the same body.
    const observations = await testDb!.pool.query(
      `select kind, source, platform, payload from observations where account_id = $1 order by id`,
      [page.id],
    );
    expect(observations.rows).toEqual(journal.rows.map((row) => ({
      kind: row.endpoint,
      source: "pull",
      platform: "onlyfans",
      payload: row.response_payload,
    })));
  });

  // A run id no sync_runs row has makes the raw insert fail on its foreign
  // key: the journal write is the first thing that can fail after the fetch.
  it.each([
    ["a link list", "links"],
    ["a link's users", "users"],
  ] as const)("fails the chunk when the journal write for %s fails, before the page is read", async (_label, phase) => {
    const page = await seedMappedPage(`links-journal-fail-${phase}-of`);
    const cursor = {
      version: 2,
      revision: 1,
      phase,
      linkType: phase === "links" ? "tracking" : null,
      linkOffset: 0,
      trackingLinkIds: phase === "links" ? [] : ["42"],
      trialLinkIds: [],
      completedTargetKeys: [],
      activeTargetKey: null,
      activeOffset: 0,
    };
    await upsertCheckpointProgress(appContext.db, {
      platformAccountId: page.id,
      stream: "fan_identities",
      state: cursor,
    });
    const { client, calls } = fakeLinksClient({
      trackingLinks: [{ id: 42 }],
      trialLinks: [],
      trackingUsers: new Map([["42:subscribers", [linkUser(500001, "lost", "Lost")]]]),
      trialSubscribers: new Map(),
    });
    appContext = { ...appContext, ofapi: client };

    const failure = await syncOfapiFanIdentities(appContext, await buildInput(page, { syncRunId: 2_000_000_000 }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncPayloadPersistenceError);
    expect((failure as SyncPayloadPersistenceError).endpoint)
      .toBe(phase === "links" ? "link_lists_tracking_live" : "link_fans_tracking_subscribers");
    // One page was bought and nothing read it: no fan, no discovered link, and
    // the cursor still points at the page the retry has to ask for again.
    expect(calls).toEqual([phase === "links" ? "tracking-links" : "tracking:42:subscribers"]);
    expect((await testDb!.pool.query("select count(*)::int as n from fans")).rows).toEqual([{ n: 0 }]);
    expect((await getCheckpoint(appContext.db, page.id, "fan_identities"))?.state).toEqual(cursor);
  });

  it("journals the pages of every executor chunk of one request", async () => {
    appContext = createTestAppContext(testDb!, {
      ofapiFanIdentitiesSyncEnabled: true,
      ofapiCreditLedgerEnabled: true,
      ofapiAudienceMaxRequestsPerRun: 3,
    });
    const page = await seedMappedPage("links-journal-chunks-of");
    const { client, calls } = fakeLinksClient({
      trackingLinks: [{ id: 42 }],
      trialLinks: [{ id: 7 }],
      trackingUsers: new Map([
        ["42:subscribers", [linkUser(600001, "chunk1", "Chunk One")]],
        ["42:spenders", [{ onlyfans_id: "600002", username: "chunk2", name: "Chunk Two" }]],
      ]),
      trialSubscribers: new Map([["7", [linkUser(600003, "chunk3", "Chunk Three")]]]),
    });
    appContext = { ...appContext, ofapi: client };
    await ensurePageSyncStates(appContext.db, { pageId: page.id });
    await testDb!.pool.query(
      "update page_sync_states set applied_seq = request_seq, status = 'idle' where page_id = $1",
      [page.id],
    );
    await requestPageSync(appContext.db, { pageId: page.id, streams: ["fan_identities"], source: "manual" });

    const first = await executeNextSyncPageChunk(appContext, page.id);
    expect(first).toMatchObject({ kind: "yielded", stream: "fan_identities" });
    const second = await executeNextSyncPageChunk(appContext, page.id);
    expect(second).toMatchObject({ kind: "success", stream: "fan_identities" });
    expect(calls).toHaveLength(5);

    // Both chunks restart the per-chunk fetch counter under one request
    // revision, so only the run id keeps the second chunk's observations from
    // repeating the first chunk's idempotency keys and being dropped.
    const kinds = [
      "link_lists_tracking_live",
      "link_lists_trial_live",
      "link_fans_tracking_subscribers",
      "link_fans_tracking_spenders",
      "link_fans_trial_subscribers",
    ];
    const journal = await testDb!.pool.query(
      `select endpoint, sync_run_id::int as sync_run_id from sync_raw_payloads where page_id = $1 order by id`,
      [page.id],
    );
    expect(journal.rows).toEqual([
      ...kinds.slice(0, 3).map((endpoint) => ({ endpoint, sync_run_id: first.runId })),
      ...kinds.slice(3).map((endpoint) => ({ endpoint, sync_run_id: second.runId })),
    ]);
    const observations = await testDb!.pool.query(
      `select kind, producer from observations where account_id = $1 order by id`,
      [page.id],
    );
    expect(observations.rows).toEqual(kinds.map((kind) => ({ kind, producer: "sync:onlyfans:fan_identities" })));
  });
});

// OnlyFans fan sweep (plan 2026-10-08, PR 10): the finished-link knob,
// `ofapiFanIdentitiesFinishedLinkIntervalHours` (live, default 0). At 0 every
// sweep re-reads every link, as before. At N a trial link the vendor's list
// calls finished is not re-read when its subscriber list was read to the end
// less than N hours ago — skipped, not read: no walk, so the link ↔ fan
// periods take no evidence from it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findPageById,
  getCheckpoint,
  setPageOfapiAccountId,
  startSyncRun,
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

let testDb: StartedTestDatabase | null = null;
let app: AppContext;

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
  app = createTestAppContext(testDb, { ofapiFanIdentitiesSyncEnabled: true, ofapiCreditLedgerEnabled: true });
});

const listPage = (items: Record<string, unknown>[]): OfapiListPage =>
  ({ items, hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null });
const fan = (id: number) => ({ id, username: `u${id}`, subscribedOnExpiredNow: false });

/** A page with one finished trial link (7) and one running (8). */
async function seed() {
  const model = await createModel(app.db, { slug: "model-lf-knob", name: "lf-knob" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "lf-knob" });
  await setPageOfapiAccountId(app.db, { pageId: page!.id, ofapiAccountId: "acct_knob" });
  const stored = (await findPageById(app.db, page!.id))!;
  const calls: string[] = [];
  const client = {
    listTrackingLinks: vi.fn(async () => listPage([])),
    listTrialLinks: vi.fn(async () => listPage([{ id: 7, isFinished: true }, { id: 8, isFinished: false }])),
    listTrackingLinkUsers: vi.fn(async () => listPage([])),
    listTrialLinkSubscribers: vi.fn(async (_c: unknown, _a: string, linkId: string) => {
      calls.push(linkId);
      return listPage(linkId === "7" ? [fan(1)] : [fan(2)]);
    }),
  } as unknown as OfapiClient;
  const sweep = async (requestSeq: number) => {
    const result = await syncOfapiFanIdentities({ ...app, ofapi: client }, {
      syncRunId: (await startSyncRun(app.db, { platformAccountId: stored.page.id, stream: "fan_identities", trigger: "manual" }))!.id,
      pageContext: { page: stored.page, platform: "onlyfans" as const, auth: { token: "unused" }, proxy: null, egressKey: "direct" } as never,
      telemetry: {
        recordPhaseStarted: vi.fn(async () => {}), recordCheckpointLoaded: vi.fn(async () => {}),
        recordCheckpointAdvanced: vi.fn(async () => {}), addAnomaly: vi.fn(async () => {}),
        addNote: vi.fn(async () => {}), getRequestObserver: () => null,
      } as never,
      budget: new SyncChunkBudget(50, 60_000),
      requestSeq,
    });
    expect(result.satisfied).toBe(true);
    return result;
  };
  return { pageId: stored.page.id, calls, sweep };
}

async function setInterval(hours: number) {
  await testDb!.pool.query(
    `insert into config_settings (scope_type, scope_id, key, value, version)
     values ('global', 0, 'ofapiFanIdentitiesFinishedLinkIntervalHours', $1::jsonb, 1)
     on conflict (scope_type, scope_id, key) do update set value = excluded.value, version = config_settings.version + 1`,
    [JSON.stringify(hours)],
  );
}

describe("finished trial link interval (ofapiFanIdentitiesFinishedLinkIntervalHours)", () => {
  it("0 (the default) re-reads every link in every sweep, as before", async () => {
    const { calls, sweep } = await seed();
    await sweep(1);
    const second = await sweep(2);
    expect(calls).toEqual(["7", "8", "7", "8"]);
    expect(second.stats).toMatchObject({ finishedLinksSkipped: 0 });
  });

  it("N skips a finished link read to the end less than N hours ago, takes effect without a restart, and reads it again once N hours have passed", async () => {
    const { pageId, calls, sweep } = await seed();
    await sweep(1);
    // The owner sets 24 h between two sweeps: the next sweep reads it live.
    await setInterval(24);
    const second = await sweep(2);
    expect(calls).toEqual(["7", "8", "8"]);
    expect(second.stats).toMatchObject({ finishedLinksSkipped: 1 });
    const { rows } = await testDb!.pool.query(
      `select platform_link_id as link, request_seq::int as seq from page_link_fan_walks
        where platform_account_id = $1 order by request_seq, platform_link_id`, [pageId]);
    expect(rows).toEqual([{ link: "7", seq: 1 }, { link: "8", seq: 1 }, { link: "8", seq: 2 }]);
    // Skipped is not read: fan 1's period on link 7 stays as it was.
    const { rows: periods } = await testDb!.pool.query(
      "select platform_link_id as link, closed_at from page_link_fan_periods order by 1");
    expect(periods).toEqual([{ link: "7", closed_at: null }, { link: "8", closed_at: null }]);
    expect((await getCheckpoint(app.db, pageId, "fan_identities"))?.state)
      .toMatchObject({ finishedTrialLinkIds: ["7"] });

    // 25 hours later the link is read again.
    await testDb!.pool.query(
      "update page_link_fan_walks set started_at = started_at - interval '25 hours', finished_at = finished_at - interval '25 hours'");
    await sweep(3);
    expect(calls).toEqual(["7", "8", "8", "7", "8"]);
  });

  it("a cursor written without the field (the previous image) re-reads every link", async () => {
    const { pageId, calls, sweep } = await seed();
    await setInterval(24);
    await sweep(1);
    // The same revision resumes from a cursor that never knew finished links.
    await upsertCheckpointProgress(app.db, {
      platformAccountId: pageId,
      stream: "fan_identities",
      state: {
        version: 2, revision: 1, phase: "users", linkType: null, linkOffset: 0,
        trackingLinkIds: [], trialLinkIds: ["7", "8"], completedTargetKeys: [], activeTargetKey: null, activeOffset: 0,
      },
    });
    await sweep(1);
    expect(calls).toEqual(["7", "8", "7", "8"]);
  });
});

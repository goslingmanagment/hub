// OnlyFans link ↔ fan (plan 2026-10-08, PR 9): link-fans:reproject rebuilds a
// page's projection from the fan sweep's journal and compares it with the
// state the sweep wrote. Built by the same functions from the same journal
// rows, the two are identical; a damaged state is reported and, with
// --write, replaced.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findPageById,
  setPageOfapiAccountId,
  startSyncRun,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { rebuildLinkFanProjection } from "../apps/runtime/src/services/ofapi-link-fans-projection.ts";
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

type Item = Record<string, unknown>;
const subscriber = (id: number, active: boolean): Item => ({ id, username: `u${id}`, subscribedOnExpiredNow: !active });
const listPage = (items: Item[], hasNextPage = false): OfapiListPage =>
  ({ items, hasNextPage, nextMarker: null, nextPageUrl: null, meta: null });

/** The sweep over one trial link and one tracking link; each list is what
 *  the vendor answers in that sweep, the trial list in pages of two. */
async function sweepPage() {
  const model = await createModel(app.db, { slug: "model-lf-reproject", name: "lf-reproject" });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label: "lf-reproject" });
  await setPageOfapiAccountId(app.db, { pageId: page!.id, ofapiAccountId: "acct_reproject" });
  const stored = (await findPageById(app.db, page!.id))!;
  return async (requestSeq: number, lists: { trial: Item[]; tracking: Item[]; spenders: Item[] }) => {
    const client = {
      listTrackingLinks: vi.fn(async () => listPage([{ id: 42 }])),
      listTrialLinks: vi.fn(async () => listPage([{ id: 7 }])),
      listTrackingLinkUsers: vi.fn(async (_c: unknown, _a: string, _id: string, kind: string) =>
        listPage(kind === "spenders" ? lists.spenders : lists.tracking)),
      listTrialLinkSubscribers: vi.fn(async (_c: unknown, _a: string, _id: string, params: { offset: number }) => {
        const slice = lists.trial.slice(params.offset, params.offset + 2);
        return { ...listPage(slice, params.offset + 2 < lists.trial.length),
          nextPageUrl: params.offset + 2 < lists.trial.length
            ? `/api/acct_reproject/trial-links/7/subscribers?offset=${params.offset + 2}&limit=100`
            : null };
      }),
    } as unknown as OfapiClient;
    const result = await syncOfapiFanIdentities({ ...app, ofapi: client }, {
      syncRunId: (await startSyncRun(app.db, { platformAccountId: stored.page.id, stream: "fan_identities", trigger: "manual" }))!.id,
      pageContext: { page: stored.page, platform: "onlyfans" as const, auth: { token: "unused" }, proxy: null, egressKey: "direct" } as never,
      telemetry: {
        recordPhaseStarted: vi.fn(async () => {}), recordCheckpointLoaded: vi.fn(async () => {}),
        recordCheckpointAdvanced: vi.fn(async () => {}), addAnomaly: vi.fn(async () => {}),
        addNote: vi.fn(async () => {}), getRequestObserver: () => null,
      } as never,
      budget: new SyncChunkBudget(100, 60_000),
      requestSeq,
    });
    expect(result.satisfied).toBe(true);
    return stored.page.id;
  };
}

async function count(table: string, pageId: number) {
  const { rows } = await testDb!.pool.query<{ n: number }>(
    `select count(*)::int as n from ${table} where platform_account_id = $1`, [pageId]);
  return rows[0]!.n;
}

describe("link-fans:reproject", () => {
  it("rebuilds exactly the state the sweep wrote, reports damage, and replaces it only with --write", async () => {
    const sweep = await sweepPage();
    const pageId = await sweep(1, {
      trial: [subscriber(1, true), subscriber(2, false), subscriber(3, true)],
      tracking: [subscriber(10, true)],
      spenders: [{ onlyfans_id: "10", revenue: { total: 12.5, chargebacks: 0, calculated_at: "2026-10-09T00:00:00Z" } }],
    });
    await sweep(2, { trial: [subscriber(2, true), subscriber(3, true)], tracking: [], spenders: [] });
    await sweep(3, { trial: [subscriber(3, false)], tracking: [], spenders: [] });
    await sweep(4, { trial: [subscriber(1, true), subscriber(3, true)], tracking: [subscriber(10, true)], spenders: [] });
    // Something to rebuild: periods opened and closed both ways.
    const { rows: reasons } = await testDb!.pool.query(
      "select close_reason, count(*)::int as n from page_link_fan_periods group by 1 order by 1");
    // Fans 1 and 10 missed twice and back, fan 2 missed twice, fan 3 expired and back.
    expect(reasons).toEqual([
      { close_reason: "absent", n: 3 },
      { close_reason: "not_active", n: 1 },
      { close_reason: null, n: 3 },
    ]);

    const dry = await rebuildLinkFanProjection(app, { pageId, write: false });
    expect(dry).toMatchObject({ written: false, from: null, journalPages: { skipped: 0 } });
    // Per sweep one tracking subscribers and one spenders page; the trial list
    // in pages of two: 2 + 1 + 1 + 1.
    expect(dry.journalPages.applied).toBe(4 * 2 + 5);
    expect(dry.diff.identical).toBe(true);
    expect(dry.diff.periods).toMatchObject({ before: 7, after: 7, added: 0, removed: 0, changed: 0 });

    // Damage the state: a lost period, a wrong close, a walk's count.
    const ids = (await testDb!.pool.query<{ id: string }>("select id::text from page_link_fan_walks order by id")).rows;
    await testDb!.pool.query("delete from page_link_fan_periods where id = (select min(id) from page_link_fan_periods)");
    await testDb!.pool.query("update page_link_fan_periods set close_reason = 'absent' where close_reason = 'not_active'");
    await testDb!.pool.query("update page_link_fan_walks set items = items + 1 where id = $1", [ids[0]!.id]);
    const report = await rebuildLinkFanProjection(app, { pageId, write: false });
    expect(report.diff).toMatchObject({
      identical: false,
      walks: { changed: 1, added: 0, removed: 0 },
      periods: { before: 6, after: 7, added: 1, changed: 1, removed: 0 },
    });
    // A dry run writes nothing: the damage is still there.
    expect(await count("page_link_fan_periods", pageId)).toBe(6);

    const written = await rebuildLinkFanProjection(app, { pageId, write: true });
    expect(written).toMatchObject({ written: true, diff: { identical: false } });
    expect(await count("page_link_fan_periods", pageId)).toBe(7);
    expect((await rebuildLinkFanProjection(app, { pageId, write: false })).diff.identical).toBe(true);

    // The sweep goes on from the rebuilt cursor.
    await sweep(5, { trial: [subscriber(1, true), subscriber(3, true)], tracking: [subscriber(10, true)], spenders: [] });
    expect((await rebuildLinkFanProjection(app, { pageId, write: false })).diff.identical).toBe(true);
  });

  it("--from starts the projection at that instant: earlier pages are not applied and the floor moves", async () => {
    const sweep = await sweepPage();
    const pageId = await sweep(1, { trial: [subscriber(1, true)], tracking: [], spenders: [] });
    await testDb!.pool.query("update sync_raw_payloads set captured_at = captured_at - interval '1 day' where page_id = $1", [pageId]);
    await rebuildLinkFanProjection(app, { pageId, write: true });
    const from = new Date(Date.now() - 3_600_000);
    await sweep(2, { trial: [subscriber(1, true), subscriber(2, true)], tracking: [], spenders: [] });
    // Built from the start: fan 2 joined after the floor.
    const sources = async () => (await testDb!.pool.query(
      `select f.platform_user_id as fan, p.period_start_source as source
         from page_link_fan_periods p join fans f on f.id = p.fan_id order by 1`)).rows;
    expect(await sources()).toEqual([{ fan: "1", source: "before_floor" }, { fan: "2", source: "first_seen" }]);

    const rebuilt = await rebuildLinkFanProjection(app, { pageId, from, write: true });
    expect(rebuilt).toMatchObject({ from: from.toISOString(), journalPages: { applied: 3, skipped: 0 } });
    expect(await sources()).toEqual([{ fan: "1", source: "before_floor" }, { fan: "2", source: "before_floor" }]);
    expect(await count("page_link_fan_walks", pageId)).toBe(3);
  });
});

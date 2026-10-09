// OnlyFans link ↔ fan (plan 2026-10-08, PR 8): the projection of the fan
// sweep's journal into walks, fans and periods under
// ofapi_subscription_period_equal_split.v1 — a period is open while the fan
// is in the link's subscriber list and flagged active; it closes at the start
// of the first finished walk that shows him not active, or of the first of
// two finished walks in a row that miss him; an unfinished walk closes
// nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  findPageById,
  setPageOfapiAccountId,
  startSyncRun,
} from "@agency_hub_core/db";
import { LINK_ATTRIBUTION_RULE } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type { OfapiClient, OfapiListPage } from "../apps/runtime/src/services/ofapi.ts";
import { SyncChunkBudget } from "../apps/runtime/src/services/sync/chunk-budget.ts";
import { syncOfapiFanIdentities } from "../apps/runtime/src/services/sync/ofapi-fan-identities.ts";
import {
  parseLinkFansJournalPage,
  projectLinkFanJournal,
} from "../apps/runtime/src/services/ofapi-link-fans-projection.ts";
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

const T0 = Date.parse("2026-10-09T03:30:00Z");
const HOUR = 3_600_000;
const at = (hours: number, seconds = 0) => new Date(T0 + hours * HOUR + seconds * 1000);

async function seedPage(label = "lf-vip") {
  const model = await createModel(app.db, { slug: `model-${label}`, name: label });
  const page = await createOnlyFansPage(app.db, { modelId: model!.id, label });
  return page!;
}

/** Fans of the page, as the sweep leaves them before it projects: a fans row
 *  and the page's page_fans row. */
async function seedFans(pageId: number, ids: number[]) {
  await testDb!.pool.query(
    `with f as (
       insert into fans (platform, platform_user_id)
       select 'onlyfans', unnest($1::text[])
       on conflict (platform, platform_user_id) do update set platform_user_id = excluded.platform_user_id
       returning id)
     insert into page_fans (fan_id, platform_account_id) select f.id, $2 from f
     on conflict do nothing`,
    [ids.map(String), pageId],
  );
}

type Item = Record<string, unknown>;
/** A trial-subscriber item as the vendor sends it: the relation's dates are
 *  the same whatever the link, the flag says whether the fan is subscribed. */
const subscriber = (id: number, active: boolean | null): Item => ({
  id,
  username: `u${id}`,
  subscribedOnExpiredNow: active === null ? null : !active,
  subscribedOnData: { subscribeAt: "2025-09-29T05:28:57+00:00", expiredAt: "2026-03-28T05:28:57+00:00" },
});

async function journal(pageId: number, endpoint: string, body: Item, capturedAt: Date) {
  const result = await testDb!.pool.query<{ id: string }>(
    `insert into sync_raw_payloads (page_id, endpoint, request_params, response_payload, mapper_version,
       payload_kind, captured_at, retain_until)
     values ($1, $2, '{}'::jsonb, $3::jsonb, 'ofapi-link-fans-v1', 'mapping_critical', $4, now() + interval '100 years')
     returning id::text`,
    [pageId, endpoint, JSON.stringify(body), capturedAt],
  );
  return Number(result.rows[0]!.id);
}

/** One walk of a trial link's subscriber list: a page per item group, the
 *  last one without a next page. `pages` empty journals one empty page. */
async function trialWalk(
  pageId: number,
  input: { linkId: string; requestSeq: number; start: Date; pages: Item[][]; account?: string; stopAfter?: number },
) {
  const pages = input.pages.length === 0 ? [[]] : input.pages;
  const count = input.stopAfter ?? pages.length;
  for (let index = 0; index < count; index += 1) {
    await journal(pageId, "link_fans_trial_subscribers", {
      link: { kind: "trial", id: Number(input.linkId) },
      list: "subscribers",
      offset: index * 100,
      limit: 100,
      requestSeq: input.requestSeq,
      ofapiAccountId: input.account ?? "acct_a",
      items: pages[index],
      hasNextPage: index < pages.length - 1,
      nextPageUrl: null,
    }, new Date(input.start.getTime() + index * 1000));
  }
}

async function project(pageId: number) {
  return projectLinkFanJournal(app, { pageId, maxPages: 1_000 });
}

async function periods(pageId: number) {
  const { rows } = await testDb!.pool.query(`
    select f.platform_user_id as fan, p.platform_link_id as link, p.period_start_source as source,
           p.period_start_at as start_at, p.closed_at, p.close_reason
      from page_link_fan_periods p join fans f on f.id = p.fan_id
     where p.platform_account_id = $1
     order by f.platform_user_id, p.id`, [pageId]);
  return rows;
}

async function walks(pageId: number) {
  const { rows } = await testDb!.pool.query(`
    select platform_link_id as link, list_kind, request_seq::int as seq, api_pages, items,
           finished_at is not null as finished, broken_reason, evidential
      from page_link_fan_walks where platform_account_id = $1 order by id`, [pageId]);
  return rows;
}

describe("link ↔ fan projection (ofapi_subscription_period_equal_split.v1)", () => {
  it("opens periods only for active fans, closes on 'not active' at once and on absence after two finished walks, and reopens as a new period", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1, 2, 3]);

    // Walk 1 is the floor: fan 1 active, fan 2 expired, fan 3 never flagged.
    await trialWalk(page.id, { linkId: "11170786", requestSeq: 1, start: at(0),
      pages: [[subscriber(1, true), subscriber(2, false)], [subscriber(3, null)]] });
    expect(await project(page.id)).toMatchObject({ applied: 2, skipped: 0, pending: false });
    expect(await walks(page.id)).toEqual([
      { link: "11170786", list_kind: "subscribers", seq: 1, api_pages: 2, items: 3, finished: true,
        broken_reason: null, evidential: true },
    ]);
    // A fan first seen not active opens no period.
    expect(await periods(page.id)).toEqual([
      { fan: "1", link: "11170786", source: "before_floor", start_at: null, closed_at: null, close_reason: null },
    ]);

    // Walk 2: fan 1 missing (once), fan 2 now active (a new subscription after the floor).
    await trialWalk(page.id, { linkId: "11170786", requestSeq: 2, start: at(6),
      pages: [[subscriber(2, true), subscriber(3, null)]] });
    await project(page.id);
    expect(await periods(page.id)).toEqual([
      { fan: "1", link: "11170786", source: "before_floor", start_at: null, closed_at: null, close_reason: null },
      { fan: "2", link: "11170786", source: "first_seen", start_at: at(6), closed_at: null, close_reason: null },
    ]);

    // Walk 3: fan 1 missing again → closed at the start of walk 2; fan 2 flagged
    // expired → closed at the start of walk 3.
    await trialWalk(page.id, { linkId: "11170786", requestSeq: 3, start: at(12),
      pages: [[subscriber(2, false), subscriber(3, null)]] });
    await project(page.id);
    expect(await periods(page.id)).toEqual([
      { fan: "1", link: "11170786", source: "before_floor", start_at: null, closed_at: at(6), close_reason: "absent" },
      { fan: "2", link: "11170786", source: "first_seen", start_at: at(6), closed_at: at(12), close_reason: "not_active" },
    ]);

    // Walk 4: both come back active → new periods; fan 1's start is his one
    // subscription.started webhook since the last finished walk.
    await testDb!.pool.query(
      `insert into domain_events (account_id, account_seq, type, occurred_at, fan_identity_ref, data,
         schema_version, observation_id, dedup_key)
       values ($1, 1, 'subscription.started', $2, '1', '{"subType":"new_subscriber_trial"}'::jsonb, 1, 1, 'lf-sub-1'),
              ($1, 2, 'subscription.started', $3, '2', '{"subType":"customer_award_for_model_top"}'::jsonb, 1, 2, 'lf-top-2')`,
      [page.id, at(15), at(16)],
    );
    await trialWalk(page.id, { linkId: "11170786", requestSeq: 4, start: at(18),
      pages: [[subscriber(1, true), subscriber(2, true)]] });
    await project(page.id);
    const rows = await periods(page.id);
    expect(rows.slice(1, 2)).toEqual([
      { fan: "1", link: "11170786", source: "hub_subscription_event", start_at: at(15), closed_at: null, close_reason: null },
    ]);
    // The top-fan award is no subscription: fan 2 starts at the sighting.
    expect(rows[3]).toEqual(
      { fan: "2", link: "11170786", source: "first_seen", start_at: at(18), closed_at: null, close_reason: null },
    );

    const { rows: fans } = await testDb!.pool.query(`
      select f.platform_user_id as fan, lf.last_seen_active, lf.vendor_status, lf.absent_walks,
             lf.vendor_subscribed_at
        from page_link_fans lf join fans f on f.id = lf.fan_id order by 1`);
    expect(fans).toEqual([
      { fan: "1", last_seen_active: true, vendor_status: "active", absent_walks: 0,
        vendor_subscribed_at: new Date("2025-09-29T05:28:57Z") },
      { fan: "2", last_seen_active: true, vendor_status: "active", absent_walks: 0,
        vendor_subscribed_at: new Date("2025-09-29T05:28:57Z") },
      // Missed by walk 4 once; never flagged, so never a period.
      { fan: "3", last_seen_active: false, vendor_status: null, absent_walks: 1,
        vendor_subscribed_at: new Date("2025-09-29T05:28:57Z") },
    ]);
  });

  it("an unfinished walk, a broken one and a cold new account close nothing", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1, 2]);
    await trialWalk(page.id, { linkId: "7", requestSeq: 1, start: at(0), pages: [[subscriber(1, true), subscriber(2, true)]] });
    // Unfinished twice: first page only, the second page never journaled.
    await trialWalk(page.id, { linkId: "7", requestSeq: 2, start: at(6), pages: [[], [subscriber(1, true)]], stopAfter: 1 });
    await trialWalk(page.id, { linkId: "7", requestSeq: 3, start: at(12), pages: [[], [subscriber(1, true)]], stopAfter: 1 });
    // Broken: a page at offset 200 after offset 0 (journal gap).
    await journal(page.id, "link_fans_trial_subscribers", {
      link: { kind: "trial", id: 7 }, list: "subscribers", offset: 0, limit: 100, requestSeq: 4,
      ofapiAccountId: "acct_a", items: [], hasNextPage: true, nextPageUrl: null }, at(18));
    await journal(page.id, "link_fans_trial_subscribers", {
      link: { kind: "trial", id: 7 }, list: "subscribers", offset: 200, limit: 100, requestSeq: 4,
      ofapiAccountId: "acct_a", items: [], hasNextPage: false, nextPageUrl: null }, at(18, 2));
    // A new OFAPI account whose lists all come back empty, twice.
    await trialWalk(page.id, { linkId: "7", requestSeq: 5, start: at(24), pages: [[]], account: "acct_b" });
    await trialWalk(page.id, { linkId: "7", requestSeq: 6, start: at(30), pages: [[]], account: "acct_b" });
    await project(page.id);

    expect((await walks(page.id)).map(({ seq, finished, broken_reason, evidential }) =>
      ({ seq, finished, broken_reason, evidential }))).toEqual([
      { seq: 1, finished: true, broken_reason: null, evidential: true },
      { seq: 2, finished: false, broken_reason: null, evidential: null },
      { seq: 3, finished: false, broken_reason: null, evidential: null },
      { seq: 4, finished: false, broken_reason: "offset_gap", evidential: null },
      { seq: 5, finished: true, broken_reason: null, evidential: false },
      { seq: 6, finished: true, broken_reason: null, evidential: false },
    ]);
    expect((await periods(page.id)).map((row) => row.closed_at)).toEqual([null, null]);
    const { rows } = await testDb!.pool.query("select absent_walks from page_link_fans order by id");
    expect(rows).toEqual([{ absent_walks: 0 }, { absent_walks: 0 }]);

    // Once the new account's lists return anyone, its finished walks count.
    await seedFans(page.id, [9]);
    await trialWalk(page.id, { linkId: "8", requestSeq: 7, start: at(36), pages: [[subscriber(9, true)]], account: "acct_b" });
    await trialWalk(page.id, { linkId: "7", requestSeq: 7, start: at(36, 30), pages: [[]], account: "acct_b" });
    await trialWalk(page.id, { linkId: "7", requestSeq: 8, start: at(42), pages: [[]], account: "acct_b" });
    await project(page.id);
    expect((await periods(page.id)).filter((row) => row.link === "7").map((row) => [row.closed_at, row.close_reason]))
      .toEqual([[at(36, 30), "absent"], [at(36, 30), "absent"]]);
  });

  it("a re-read page replaces its items; spenders feed the vendor's money and open no period; unreadable pages are skipped", async () => {
    const page = await seedPage("lf-free");
    await seedFans(page.id, [5, 6]);
    const body = (offset: number, items: Item[], hasNextPage: boolean): Item => ({
      link: { kind: "tracking", id: 42 }, list: "subscribers", offset, limit: 100, requestSeq: 1,
      ofapiAccountId: "acct_a", items, hasNextPage, nextPageUrl: null,
    });
    await seedFans(page.id, [7]);
    // The chunk failed after journaling offset 0; the retry bought it again.
    await journal(page.id, "link_fans_tracking_subscribers", body(0, [subscriber(404, true)], true), at(0));
    await journal(page.id, "link_fans_tracking_subscribers", body(0, [subscriber(404, true), subscriber(5, true)], true), at(0, 1));
    await journal(page.id, "link_fans_tracking_subscribers", body(100, [subscriber(7, true)], false), at(0, 2));
    await journal(page.id, "link_fans_tracking_spenders", {
      link: { kind: "tracking", id: 42 }, list: "spenders", offset: 0, limit: 100, requestSeq: 1,
      ofapiAccountId: "acct_a", hasNextPage: false, nextPageUrl: null,
      items: [
        { onlyfans_id: "5", revenue: { total: 26.8, chargebacks: 6.4, calculated_at: "2026-10-09T01:00:00.000000Z" } },
        { onlyfans_id: "6", revenue: { total: "109.88", chargebacks: 0, calculated_at: null } },
      ],
    }, at(0, 3));
    await journal(page.id, "link_fans_tracking_spenders", { not: "a page" }, at(0, 4));

    expect(await project(page.id)).toMatchObject({ applied: 4, skipped: 1, pending: false });
    // Offset 0 was read twice: still two pages, the second read's items.
    expect((await walks(page.id)).map(({ list_kind, api_pages, items, finished }) =>
      ({ list_kind, api_pages, items, finished }))).toEqual([
      { list_kind: "subscribers", api_pages: 2, items: 3, finished: true },
      { list_kind: "spenders", api_pages: 1, items: 2, finished: true },
    ]);
    const { rows } = await testDb!.pool.query(`
      select f.platform_user_id as fan, lf.in_subscriber_list, lf.vendor_revenue_net_mills::text as net,
             lf.vendor_chargebacks_mills::text as chargebacks, lf.vendor_revenue_calculated_at
        from page_link_fans lf join fans f on f.id = lf.fan_id order by 1`);
    expect(rows).toEqual([
      // Fan 404 had no fans row (a crash before the sweep upserted him): the
      // journal is the record, he is restored onto the page.
      { fan: "404", in_subscriber_list: true, net: null, chargebacks: null, vendor_revenue_calculated_at: null },
      { fan: "5", in_subscriber_list: true, net: "26800", chargebacks: "6400",
        vendor_revenue_calculated_at: new Date("2026-10-09T01:00:00Z") },
      { fan: "6", in_subscriber_list: false, net: "109880", chargebacks: "0", vendor_revenue_calculated_at: null },
      { fan: "7", in_subscriber_list: true, net: null, chargebacks: null, vendor_revenue_calculated_at: null },
    ]);
    expect((await periods(page.id)).map((row) => row.fan)).toEqual(["404", "5", "7"]);
    const { rows: cursor } = await testDb!.pool.query(
      "select rule, pages_applied::int, pages_skipped::int from page_link_fan_journal_cursors where platform_account_id = $1",
      [page.id],
    );
    expect(cursor).toEqual([{ rule: LINK_ATTRIBUTION_RULE, pages_applied: 4, pages_skipped: 1 }]);
  });

  it("a walk continued under another OFAPI account (a rebind mid-walk) is broken and closes nothing", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1, 2]);
    await trialWalk(page.id, { linkId: "7", requestSeq: 1, start: at(0), pages: [[subscriber(1, true), subscriber(2, true)]] });
    // Fan 1 missed once by a finished walk under account A.
    await trialWalk(page.id, { linkId: "7", requestSeq: 2, start: at(6), pages: [[subscriber(2, true)]] });
    // Account A reads the first page, the sweep pauses, the page is rebound,
    // account B answers the rest of the same revision with an empty last page.
    const page3 = (offset: number, account: string, items: Item[], hasNextPage: boolean): Item => ({
      link: { kind: "trial", id: 7 }, list: "subscribers", offset, limit: 100, requestSeq: 3,
      ofapiAccountId: account, items, hasNextPage, nextPageUrl: null,
    });
    await journal(page.id, "link_fans_trial_subscribers", page3(0, "acct_a", [subscriber(2, true)], true), at(12));
    await journal(page.id, "link_fans_trial_subscribers", page3(100, "acct_b", [], false), at(12, 30));
    await project(page.id);

    expect((await walks(page.id)).map(({ seq, finished, broken_reason }) => ({ seq, finished, broken_reason })))
      .toEqual([
        { seq: 1, finished: true, broken_reason: null },
        { seq: 2, finished: true, broken_reason: null },
        { seq: 3, finished: false, broken_reason: "account_changed" },
      ]);
    expect((await periods(page.id)).map((row) => [row.fan, row.closed_at])).toEqual([["1", null], ["2", null]]);
    const { rows } = await testDb!.pool.query(
      "select f.platform_user_id as fan, lf.absent_walks from page_link_fans lf join fans f on f.id = lf.fan_id order by 1");
    expect(rows).toEqual([{ fan: "1", absent_walks: 1 }, { fan: "2", absent_walks: 0 }]);
  });

  it("a body that cannot be read now is not skipped: the call fails, the cursor stays, the next call applies it", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1]);
    // Pointer-only row whose catalog object cannot be read (a lost or
    // momentarily unreachable copy).
    const { rows } = await testDb!.pool.query<{ id: string }>(
      `insert into sync_raw_payloads (page_id, endpoint, request_params, response_payload, mapper_version,
         payload_kind, captured_at, retain_until, payload_bucket_month, payload_object_id)
       values ($1, 'link_fans_trial_subscribers', '{}'::jsonb, null, 'ofapi-link-fans-v1', 'mapping_critical',
         $2, now() + interval '100 years', '2026-10-01', 987654321)
       returning id::text`,
      [page.id, at(0)],
    );
    await expect(project(page.id)).rejects.toThrow();
    const cursor = async () => (await testDb!.pool.query(
      "select last_raw_payload_id::int as at, pages_skipped::int as skipped from page_link_fan_journal_cursors")).rows;
    expect(await cursor()).toEqual([]);

    // The copy is readable again.
    await testDb!.pool.query(
      `update sync_raw_payloads set response_payload = $2::jsonb, payload_bucket_month = null, payload_object_id = null
        where id = $1`,
      [rows[0]!.id, JSON.stringify({
        link: { kind: "trial", id: 7 }, list: "subscribers", offset: 0, limit: 100, requestSeq: 1,
        ofapiAccountId: "acct_a", items: [subscriber(1, true)], hasNextPage: false, nextPageUrl: null,
      })],
    );
    expect(await project(page.id)).toMatchObject({ applied: 1, skipped: 0 });
    expect(await cursor()).toEqual([{ at: Number(rows[0]!.id), skipped: 0 }]);
  });

  it("never writes back what an erasure took: the page's erased material, or a page naming an erased fan", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1, 2]);
    const owner = (await testDb!.pool.query<{ id: string }>(
      "insert into users (username, role) values ('lf-owner', 'owner') returning id::text")).rows[0]!.id;

    // A fan erasure of fan 2 that started after walk 2 was captured — and
    // whose deletion stopped after its tombstone, so the journal still holds
    // fan 2 on walk 2's page, the very first page there is no cursor for yet
    // (a fan erasure must not stall the page): the page applies without fan 2.
    await trialWalk(page.id, { linkId: "7", requestSeq: 2, start: at(6), pages: [[subscriber(1, true), subscriber(2, true)]] });
    await trialWalk(page.id, { linkId: "7", requestSeq: 3, start: at(8), pages: [[subscriber(1, true)]] });
    await testDb!.pool.query(
      `insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan, started_at)
       values ('fan', 'fan:onlyfans:2', $1, false, '{}'::jsonb, $2)`, [owner, at(7)]);
    expect(await project(page.id)).toMatchObject({ applied: 2, fenced: 0, pending: false });
    expect((await walks(page.id)).map((row) => [row.seq, row.items])).toEqual([[2, 1], [3, 1]]);
    expect((await periods(page.id)).map((row) => row.fan)).toEqual(["1"]);
    expect((await testDb!.pool.query("select 1 from fans where platform_user_id = '2'")).rowCount).toBe(1);
    expect((await testDb!.pool.query(
      "select 1 from page_link_fans lf join fans f on f.id = lf.fan_id where f.platform_user_id = '2'")).rowCount).toBe(0);

    // An erasure of the whole page (its rows gone, its tombstone in place) and
    // a journal page captured before it that a run had already read: nothing
    // is written back, not even the cursor.
    await testDb!.pool.query(
      `insert into erasure_log (scope_type, scope_ref, initiated_by, dry_run, plan, started_at)
       values ('page', 'page:lf-vip', $1, false, $2::jsonb, $3)`,
      [owner, JSON.stringify({ resolvedPageIds: [page.id] }), at(13)]);
    for (const table of ["page_link_fan_periods", "page_link_fans", "page_link_fan_walks", "page_link_fan_journal_cursors"]) {
      await testDb!.pool.query(`delete from ${table} where platform_account_id = $1`, [page.id]);
    }
    await trialWalk(page.id, { linkId: "7", requestSeq: 3, start: at(12), pages: [[subscriber(1, true)]] });
    expect(await project(page.id)).toMatchObject({ applied: 0, fenced: 1 });
    for (const table of ["page_link_fan_periods", "page_link_fans", "page_link_fan_walks", "page_link_fan_journal_cursors"]) {
      expect((await testDb!.pool.query(`select 1 from ${table} where platform_account_id = $1`, [page.id])).rowCount)
        .toBe(0);
    }

    // While an erasure of the page runs (its exclusive fence lock held), the
    // projection writes nothing and comes back later.
    const eraser = await testDb!.pool.connect();
    try {
      await eraser.query("begin");
      await eraser.query("select pg_advisory_xact_lock(815402, $1::integer)", [page.id]);
      expect(await project(page.id)).toMatchObject({ applied: 0, fenced: 0, pending: true });
      await eraser.query("rollback");
    } finally {
      eraser.release();
    }
  });

  it("rows naming a fan go with the fan's page_fans row (an older image's page erasure)", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1, 2]);
    await trialWalk(page.id, { linkId: "7", requestSeq: 1, start: at(0), pages: [[subscriber(1, true), subscriber(2, true)]] });
    await project(page.id);
    expect((await periods(page.id)).map((row) => row.fan)).toEqual(["1", "2"]);

    await testDb!.pool.query("delete from page_fans where platform_account_id = $1", [page.id]);
    for (const table of ["page_link_fan_periods", "page_link_fans"]) {
      expect((await testDb!.pool.query(`select 1 from ${table} where platform_account_id = $1`, [page.id])).rowCount)
        .toBe(0);
    }
  });

  it("a fan the sweep never upserted (a crash between journaling and the upsert) is restored from the journal and starts at that page", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1]);
    await trialWalk(page.id, { linkId: "7", requestSeq: 1, start: at(0), pages: [[subscriber(1, true)]] });
    // Walk 2 journals fan 3 on its first page, the chunk dies before the
    // upsert; the retried request finds him on the next page.
    await trialWalk(page.id, { linkId: "7", requestSeq: 2, start: at(6),
      pages: [[subscriber(1, true), subscriber(3, true)], [subscriber(3, true)]] });
    // Fan 3 exists elsewhere, not on this page (and fan 4 nowhere at all).
    await testDb!.pool.query("insert into fans (platform, platform_user_id) values ('onlyfans', '3')");
    await trialWalk(page.id, { linkId: "7", requestSeq: 3, start: at(12), pages: [[subscriber(4, true)]] });
    await project(page.id);

    const rows = await periods(page.id);
    expect(rows.map((row) => [row.fan, row.source, row.start_at])).toEqual([
      ["1", "before_floor", null],
      ["3", "first_seen", at(6)],
      ["4", "first_seen", at(12)],
    ]);
    const { rows: onPage } = await testDb!.pool.query(
      `select f.platform_user_id as fan from page_fans pf join fans f on f.id = pf.fan_id
        where pf.platform_account_id = $1 order by 1`, [page.id]);
    expect(onPage).toEqual([{ fan: "1" }, { fan: "3" }, { fan: "4" }]);
  });

  it("a re-read of an already finished walk (a lost sweep checkpoint) bounds a new fan's start by that walk", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1, 2]);
    // The link's first walk: finished, so it is the floor.
    await trialWalk(page.id, { linkId: "7", requestSeq: 1, start: at(0), pages: [[subscriber(1, true)]] });
    await project(page.id);
    // Fan 2 subscribes; the sweep re-reads the walk's last page under the
    // same revision (its checkpoint was lost) and meets him.
    await testDb!.pool.query(
      `insert into domain_events (account_id, account_seq, type, occurred_at, fan_identity_ref, data,
         schema_version, observation_id, dedup_key)
       values ($1, 1, 'subscription.started', $2, '2', '{"subType":"new_subscriber_trial"}'::jsonb, 1, 1, 'lf-replay-2')`,
      [page.id, at(1)],
    );
    await journal(page.id, "link_fans_trial_subscribers", {
      link: { kind: "trial", id: 7 }, list: "subscribers", offset: 0, limit: 100, requestSeq: 1,
      ofapiAccountId: "acct_a", items: [subscriber(1, true), subscriber(2, true)], hasNextPage: false, nextPageUrl: null,
    }, at(2));
    await project(page.id);
    expect((await periods(page.id)).map((row) => [row.fan, row.source, row.start_at])).toEqual([
      ["1", "before_floor", null],
      ["2", "hub_subscription_event", at(1)],
    ]);
  });

  it("waits for nobody: a held lock leaves the pages for the next call, which applies them in order", async () => {
    const page = await seedPage();
    await seedFans(page.id, [1]);
    await trialWalk(page.id, { linkId: "7", requestSeq: 1, start: at(0), pages: [[subscriber(1, true)]] });
    const holder = await testDb!.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::integer, $2::integer)", [0x4c46, page.id]);
      expect(await project(page.id)).toMatchObject({ applied: 0, pending: true });
      await holder.query("rollback");
    } finally {
      holder.release();
    }
    expect(await project(page.id)).toMatchObject({ applied: 1, pending: false });
    expect(await project(page.id)).toMatchObject({ applied: 0, pending: false });
  });

  it("the sweep projects every page it journals, and a projection that cannot run never holds up the walk", async () => {
    const model = await createModel(app.db, { slug: "model-lf-sweep", name: "lf-sweep" });
    const created = await createOnlyFansPage(app.db, { modelId: model!.id, label: "lf-sweep" });
    await setPageOfapiAccountId(app.db, { pageId: created!.id, ofapiAccountId: "acct_sweep" });
    const stored = (await findPageById(app.db, created!.id))!;
    const listPage = (items: Item[]): OfapiListPage =>
      ({ items, hasNextPage: false, nextMarker: null, nextPageUrl: null, meta: null });
    const client = {
      listTrackingLinks: vi.fn(async () => listPage([])),
      listTrialLinks: vi.fn(async () => listPage([{ id: 7 }])),
      listTrackingLinkUsers: vi.fn(async () => listPage([])),
      listTrialLinkSubscribers: vi.fn(async () => listPage([subscriber(700001, true), subscriber(700002, false)])),
    } as unknown as OfapiClient;
    const input = async (requestSeq: number) => ({
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

    const first = await syncOfapiFanIdentities({ ...app, ofapi: client }, await input(1));
    expect(first.satisfied).toBe(true);
    expect(first.stats).toMatchObject({ linkFanPagesProjected: 1, linkFanProjectionErrors: 0 });
    expect((await periods(stored.page.id)).map((row) => [row.fan, row.source])).toEqual([["700001", "before_floor"]]);

    // The projection cannot run (a rebuild holds its lock): the walk still
    // completes, and the next call applies what was left.
    const holder = await testDb!.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::integer, $2::integer)", [0x4c46, stored.page.id]);
      const second = await syncOfapiFanIdentities({ ...app, ofapi: client }, await input(2));
      expect(second.satisfied).toBe(true);
      expect(second.stats).toMatchObject({ linkFanPagesProjected: 0 });
      await holder.query("rollback");
    } finally {
      holder.release();
    }
    expect(await project(stored.page.id)).toMatchObject({ applied: 1, pending: false });
    expect(await walks(stored.page.id)).toHaveLength(2);
  });
});

describe("parseLinkFansJournalPage", () => {
  const base = {
    link: { kind: "trial", id: 11170786 }, list: "subscribers", offset: 0, limit: 100, requestSeq: 331,
    ofapiAccountId: "acct_x", hasNextPage: true, nextPageUrl: null,
  };

  it("reads the walk's next offset the way the walk does", () => {
    const parse = (overrides: Item) => {
      const parsed = parseLinkFansJournalPage("link_fans_trial_subscribers", { ...base, items: [], ...overrides });
      return parsed.ok ? parsed.page.next : parsed.reason;
    };
    expect(parse({})).toEqual({ kind: "offset", offset: 100 });
    expect(parse({ hasNextPage: false })).toEqual({ kind: "last" });
    expect(parse({ nextPageUrl: "https://api.onlyfansapi.com/api/acct_x/trial-links/11170786/subscribers?offset=100&limit=100" }))
      .toEqual({ kind: "offset", offset: 100 });
    expect(parse({ nextPageUrl: "/x?offset=abc" })).toEqual({ kind: "invalid" });
  });

  it("only an explicit 'not expired' is active", () => {
    const parsed = parseLinkFansJournalPage("link_fans_trial_subscribers", {
      ...base,
      items: [subscriber(1, true), subscriber(2, false), subscriber(3, null), { id: 4 }, { username: "no id" }],
    });
    expect(parsed.ok && parsed.page.subscribers.map((item) => [item.platformUserId, item.active, item.vendorStatus]))
      .toEqual([["1", true, "active"], ["2", false, "expired"], ["3", false, null], ["4", false, null]]);
    expect(parsed.ok && parsed.page.itemCount).toBe(5);
  });

  it("refuses a body that does not match its journal kind", () => {
    expect(parseLinkFansJournalPage("link_fans_tracking_subscribers", { ...base, items: [] }))
      .toEqual({ ok: false, reason: "link does not match the journal kind" });
    expect(parseLinkFansJournalPage("link_fans_trial_subscribers", { ...base, list: "spenders", items: [] }))
      .toEqual({ ok: false, reason: "list does not match the journal kind" });
    expect(parseLinkFansJournalPage("link_lists_trial_live", { ...base, items: [] }).ok).toBe(false);
  });
});

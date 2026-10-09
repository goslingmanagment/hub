// Hub's own money per OnlyFans link (traffic plan §2.4, PR 13) through the
// «Ссылки OnlyFans» reads: posted transactions only (П9.3), split over the
// links whose link ↔ fan periods hold them, chargebacks with their original
// purchase's shares (П2), recipients decided before any channel cut, and the
// comparison with OFAPI's figure and its state.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyTrafficBindingsChange,
  createModel,
  createOnlyFansPage,
  insertLinkStatRunWithSnapshots,
  upsertTransaction,
  type InsertLinkStatSnapshotInput,
} from "@agency_hub_core/db";

import { projectLinkFanJournal } from "../apps/runtime/src/services/ofapi-link-fans-projection.ts";
import { getOfLinkChannels, getOfLinkHistory, getOfLinks } from "../apps/runtime/src/services/of-links.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let vipPage = 0;
let freePage = 0;
let ariPage = 0;

// Hub's floor: the first fan walk, 2026-10-09 03:30 UTC (06:30 Moscow).
const F = Date.parse("2026-10-09T03:30:00Z");
const h = (hours: number) => new Date(F + hours * 3_600_000);
const NOW = h(30);

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Integration database unavailable");
  testDb = started;
}, 120_000);
afterAll(async () => { await testDb?.stop(); });

type Item = Record<string, unknown>;
const subscriber = (id: number, active: boolean): Item => ({ id, subscribedOnExpiredNow: !active });

async function journal(pageId: number, endpoint: string, body: Item, capturedAt: Date) {
  await testDb.pool.query(
    `insert into sync_raw_payloads (page_id, endpoint, request_params, response_payload, mapper_version,
       payload_kind, captured_at, retain_until)
     values ($1, $2, '{}'::jsonb, $3::jsonb, 'ofapi-link-fans-v1', 'mapping_critical', $4, now() + interval '100 years')`,
    [pageId, endpoint, JSON.stringify(body), capturedAt],
  );
}

/** One finished one-page walk of a link's subscriber list. */
async function walk(pageId: number, kind: "trial" | "tracking", linkId: string, requestSeq: number, at: Date, items: Item[]) {
  await journal(pageId, kind === "trial" ? "link_fans_trial_subscribers" : "link_fans_tracking_subscribers", {
    link: { kind, id: Number(linkId) }, list: "subscribers", offset: 0, limit: 100, requestSeq,
    ofapiAccountId: "acct_x", items, hasNextPage: false, nextPageUrl: null,
  }, at);
}

const fanIds = new Map<number, number>();
async function fan(ref: number) {
  return fanIds.get(ref)!;
}

let transactionSeq = 0;
async function transaction(pageId: number, fanRef: number, at: Date, mills: bigint, input: {
  state?: "posted" | "pending"; transactionId?: string; canonicalType?: "message_purchase" | "chargeback";
} = {}) {
  const transactionId = input.transactionId ?? `lf-tx-${++transactionSeq}`;
  await upsertTransaction(app.db, {
    platformAccountId: pageId, source: "ofapi:rest", fanId: await fan(fanRef), transactionId,
    rawType: "test", canonicalType: input.canonicalType ?? "message_purchase", transactionState: input.state ?? "posted",
    rawStatus: "test", grossAmountMills: mills, sourceDestinationAmountMills: mills, creatorNetAmountMills: mills,
    occurredAt: at,
  });
  return transactionId;
}

function snapshot(pageId: number, kind: "trial" | "tracking", id: string, values: Partial<InsertLinkStatSnapshotInput>): InsertLinkStatSnapshotInput {
  return {
    platformAccountId: pageId, linkKind: kind, platformLinkId: id, name: id, url: null,
    linkCreatedAt: new Date("2026-04-01T00:00:00Z"), linkEndsAt: null, isFinished: kind === "trial" ? false : null,
    clicksCount: 0, claimsCount: kind === "trial" ? 0 : null, subscribersCount: 0, spendersCount: 0,
    revenueNetMills: 0n, revenueChargebacksMills: 0n, revenueIsLoading: false, revenueCalculatedAt: null,
    trialDays: kind === "trial" ? 180 : null, tags: [], ...values,
  };
}

async function run(pageId: number, kind: "trial" | "tracking", pulledAt: Date, rows: InsertLinkStatSnapshotInput[]) {
  await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: pageId, linkKind: kind, status: "complete", pulledAt, apiPages: 1,
    rawItems: rows.length, writtenRows: rows.length, ofapiAccountId: "acct_x",
  }, rows);
}

beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  vipPage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-vip-of" }))!.id;
  freePage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" }))!.id;
  ariPage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "ari-of" }))!.id;
  await testDb.pool.query("update pages set ofapi_account_id = 'acct_' || id, created_at = '2026-07-01T00:00:00Z'");

  // VIP: trial links A (11170786) and B (11170787). Walk 1 is the floor:
  // fan 1 active in A and B, fan 2 active in A, fan 3 listed in B but
  // expired. Walk 2: fan 4 claims A.
  await walk(vipPage, "trial", "11170786", 1, h(0), [subscriber(1, true), subscriber(2, true)]);
  await walk(vipPage, "trial", "11170787", 1, h(0.01), [subscriber(1, true), subscriber(3, false)]);
  await walk(vipPage, "trial", "11170786", 2, h(6), [subscriber(1, true), subscriber(2, true), subscriber(4, true)]);
  await walk(vipPage, "trial", "11170787", 2, h(6.01), [subscriber(1, true), subscriber(3, false)]);
  // C (11213035): fan 8; the link moves from Reddit to Porntoki at h(12).
  await walk(vipPage, "trial", "11213035", 1, h(0.02), [subscriber(8, true)]);
  // The walks of h(28): read to the end, past every compared stretch.
  await walk(vipPage, "trial", "11170786", 3, h(28), [subscriber(1, true), subscriber(2, true), subscriber(4, true)]);
  await walk(vipPage, "trial", "11170787", 3, h(28.01), [subscriber(1, true), subscriber(3, false)]);
  await walk(vipPage, "trial", "11213035", 2, h(28.02), [subscriber(8, true)]);
  // Free page: tracking links T (2099377, fan 5) and T2 (2117449, fan 6).
  await walk(freePage, "tracking", "2099377", 1, h(0), [subscriber(5, true)]);
  await walk(freePage, "tracking", "2117449", 1, h(0.01), [subscriber(6, true)]);
  await walk(freePage, "tracking", "2099377", 2, h(28), [subscriber(5, true)]);
  await walk(freePage, "tracking", "2117449", 2, h(28.01), [subscriber(6, true)]);
  // Ari: tracking links T3 (2099526, fan 7) and T4 (2103813, fan 9). T4 is
  // read to the end at h(28); T3's walk of h(28) is still being read.
  await walk(ariPage, "tracking", "2099526", 1, h(0.02), [subscriber(7, true)]);
  await walk(ariPage, "tracking", "2103813", 1, h(0.03), [subscriber(9, true)]);
  await walk(ariPage, "tracking", "2103813", 2, h(28.03), [subscriber(9, true)]);
  await journal(ariPage, "link_fans_tracking_subscribers", {
    link: { kind: "tracking", id: 2099526 }, list: "subscribers", offset: 0, limit: 100, requestSeq: 2,
    ofapiAccountId: "acct_x", items: [subscriber(7, true)], hasNextPage: true, nextPageUrl: null,
  }, h(28.02));
  await projectLinkFanJournal(app, { pageId: vipPage, maxPages: 100 });
  await projectLinkFanJournal(app, { pageId: freePage, maxPages: 100 });
  await projectLinkFanJournal(app, { pageId: ariPage, maxPages: 100 });
  const { rows } = await testDb.pool.query<{ id: string; ref: string }>("select id::text, platform_user_id as ref from fans");
  for (const row of rows) fanIds.set(Number(row.ref), Number(row.id));

  // VIP money.
  await transaction(vipPage, 1, h(-1), 10_000n); // before the floor
  const split = await transaction(vipPage, 1, h(1), 1001n); // A 501 / B 500
  await transaction(vipPage, 2, h(2), 2000n); // A
  await transaction(vipPage, 3, h(2), 500n); // expired fan: no link
  await transaction(vipPage, 4, h(7), 700n); // A, his period opened at walk 2
  await transaction(vipPage, 2, h(8), 300n, { state: "pending" }); // A, pending
  // A chargeback of the split purchase, 19 hours later: the purchase's shares.
  await transaction(vipPage, 1, h(20), -1001n, { transactionId: `${split}:chargeback`, canonicalType: "chargeback" });
  await transaction(vipPage, 8, h(11), 1000n); // C, while it was Reddit's
  // Free page money.
  await transaction(freePage, 5, h(1), 1000n); // T
  await transaction(freePage, 6, h(-1), 1000n); // T2, before Hub's floor
  await transaction(ariPage, 7, h(1), 500n); // T3
  await transaction(ariPage, 9, h(1), 400n); // T4

  // The link series. A: before the floor (computed 1 h before it) and after.
  await run(vipPage, "trial", h(-6), [
    snapshot(vipPage, "trial", "11170786", { revenueNetMills: 1_000_000n, revenueCalculatedAt: h(-1) }),
  ]);
  await run(vipPage, "trial", h(27), [
    snapshot(vipPage, "trial", "11170786", { revenueNetMills: 1_002_700n, revenueCalculatedAt: h(26) }),
    // B was never read before the floor although it is old.
    snapshot(vipPage, "trial", "11170787", { revenueNetMills: 50_000n, revenueCalculatedAt: h(26) }),
  ]);
  // C: OFAPI first reads it at h(13), after it left Reddit.
  await run(vipPage, "trial", h(13), [
    snapshot(vipPage, "trial", "11213035", { revenueNetMills: 1000n, revenueCalculatedAt: h(12.5) }),
  ]);
  // T and T3: a computation before the floor, one just after it (h(0.5)) and
  // the latest (h(3)). T2: none between its baseline (before the floor) and
  // the latest.
  await run(freePage, "tracking", h(-6), [
    snapshot(freePage, "tracking", "2099377", { revenueNetMills: 0n, revenueCalculatedAt: h(-2) }),
    snapshot(freePage, "tracking", "2117449", { revenueNetMills: 0n, revenueCalculatedAt: h(-2) }),
  ]);
  await run(freePage, "tracking", h(0.75), [
    snapshot(freePage, "tracking", "2099377", { revenueNetMills: 0n, revenueCalculatedAt: h(0.5) }),
    snapshot(freePage, "tracking", "2117449", { revenueNetMills: 1000n, revenueCalculatedAt: h(-2) }),
  ]);
  await run(freePage, "tracking", h(27), [
    snapshot(freePage, "tracking", "2099377", { revenueNetMills: 1000n, revenueCalculatedAt: h(3) }),
    snapshot(freePage, "tracking", "2117449", { revenueNetMills: 1000n, revenueCalculatedAt: h(3) }),
  ]);
  for (const [at, calculated, t3, t4] of [[h(0.75), h(0.5), 0n, 0n], [h(27), h(3), 500n, 400n]] as const) {
    await run(ariPage, "tracking", at, [
      snapshot(ariPage, "tracking", "2099526", { revenueNetMills: t3, revenueCalculatedAt: calculated }),
      snapshot(ariPage, "tracking", "2103813", { revenueNetMills: t4, revenueCalculatedAt: calculated }),
    ]);
  }

  await applyTrafficBindingsChange(app.db, {
    contractors: [{ key: "coraline-red", title: "@coraline_red" }],
    channels: [{ key: "lora.porntoki", title: "Порнтоки" }, { key: "lora.reddit", title: "Reddit" }],
    terms: [{ channelKey: "lora.porntoki", contractorKey: "coraline-red", validFrom: new Date("2026-04-01T00:00:00Z"), validTo: null, validFromBasis: "confirmed" }],
    bindings: [
      ...["11170786", "11170787"].map((linkId) => ({
        pageLabel: "lora-vip-of", linkKind: "trial" as const, linkId, channelKey: "lora.porntoki",
        validFrom: new Date("2026-04-01T00:00:00Z"), validTo: null, validFromBasis: "confirmed" as const,
      })),
      // Nobody confirmed when C went to Reddit (П9.7).
      { pageLabel: "lora-vip-of", linkKind: "trial" as const, linkId: "11213035", channelKey: "lora.reddit",
        validFrom: new Date("2026-04-01T00:00:00Z"), validTo: h(12), validFromBasis: "assumed_link_created" as const },
      { pageLabel: "lora-vip-of", linkKind: "trial" as const, linkId: "11213035", channelKey: "lora.porntoki",
        validFrom: h(12), validTo: null, validFromBasis: "confirmed" as const },
    ],
  }, { write: true, actor: "test", command: "import" });
});

describe("Hub's own money per link", () => {
  it("counts posted money since the floor, split over the links holding it, with chargebacks on their purchase's shares", async () => {
    const result = await getOfLinks(app.db, { seriesEnabled: true, now: NOW });
    const byRef = new Map(result.links.map((link) => [link.linkRef, link]));
    expect(byRef.get("11170786")!.hubMoney).toEqual({
      state: "available", reason: null, revenueBasis: "creator_net_after_platform_fee",
      attributionRule: "ofapi_subscription_period_equal_split.v1", floorAt: h(0).toISOString(),
      // 501 + 2000 + 700 − 501; the pending 300 apart; fan 3 and the pre-floor 10 000 are nobody's.
      netMills: 2700, pendingMills: 300, transactionCount: 4, fanCount: 3,
    });
    expect(byRef.get("11170787")!.hubMoney).toMatchObject({ state: "available", netMills: 0, pendingMills: 0, transactionCount: 2, fanCount: 1 });
    expect(byRef.get("2099377")!.hubMoney).toMatchObject({ state: "available", netMills: 1000, transactionCount: 1, fanCount: 1 });
  });

  it("puts the two figures side by side over the same stretch, and says when it cannot", async () => {
    const result = await getOfLinks(app.db, { seriesEnabled: true, now: NOW });
    const byRef = new Map(result.links.map((link) => [link.linkRef, link]));
    // T: OFAPI computed at h(0.5) (after Hub's floor) and at h(3); Hub's
    // figure over exactly [h(0.5), h(3)); walks read past it; a tracking link;
    // nothing pending: comparable, equal.
    expect(byRef.get("2099377")!.comparison).toEqual({
      state: "comparable", flags: [], fromAt: h(0.5).toISOString(), toAt: h(3).toISOString(),
      vendorDeltaMills: 1000, hubNetMills: 1000, differenceMills: 0,
    });
    // T2: OFAPI's only baseline was computed before Hub's floor and counts a
    // payment Hub's figure starts after — never comparable.
    expect(byRef.get("2117449")!.comparison).toMatchObject({
      state: "provisional", flags: ["window_mismatch"], fromAt: h(0.01).toISOString(), toAt: h(3).toISOString(),
      vendorDeltaMills: 1000, hubNetMills: 0, differenceMills: -1000,
    });
    // T3: its last finished walk starts before the stretch's end and the next
    // one is still being read — a payer of it may be on an unread page.
    expect(byRef.get("2099526")!.comparison).toMatchObject({
      state: "incomplete", vendorDeltaMills: 500, hubNetMills: 500, differenceMills: 0,
    });
    // T4 is read to the end, equal on the same stretch — but T3, of the same
    // page, is not: a fan of T4 found in T3 would halve T4's share.
    expect(byRef.get("2103813")!.comparison).toMatchObject({
      state: "incomplete", flags: [], vendorDeltaMills: 400, hubNetMills: 400, differenceMills: 0,
    });
    // A: a trial link, and its baseline is before the floor.
    expect(byRef.get("11170786")!.comparison).toMatchObject({
      state: "provisional", flags: ["window_mismatch"], vendorDeltaMills: 2700, hubNetMills: 2700, differenceMills: 0,
      toAt: h(26).toISOString(),
    });
    // No vendor snapshot of B before the floor: OFAPI all-time against Hub since the floor.
    expect(byRef.get("11170787")!.comparison).toMatchObject({
      state: "different_history", vendorDeltaMills: 50_000, hubNetMills: 0, differenceMills: -50_000,
    });

    // The chargebacks reconcile failing: Hub's ledger may lack chargebacks.
    await testDb.pool.query(`
      insert into notification_incidents (kind, incident_key, opened_at, last_seen_at, error_summary)
      values ('ofapi_chargebacks_reconcile_failed', 'ofapi_chargebacks_reconcile_failed:global', now(), now(), 'continuation unavailable')`);
    const gap = await getOfLinks(app.db, { seriesEnabled: true, now: NOW });
    expect(gap.links.find((link) => link.linkRef === "2099377")!.comparison)
      .toMatchObject({ state: "provisional", flags: ["ledger_gap"] });
  });

  it("gives each business day its share and says nothing of the days before the floor", async () => {
    const history = await getOfLinkHistory(app.db, {
      seriesEnabled: true, pageId: vipPage, linkKind: "trial", linkRef: "11170786",
      from: "2026-10-08", to: "2026-10-10", now: NOW,
    });
    expect(history.days.map((day) => [day.businessDate, day.hub])).toEqual([
      ["2026-10-08", null],
      // Moscow 2026-10-09: 501 + 2000 + 700 posted, 300 pending.
      ["2026-10-09", { netMills: 3201, pendingMills: 300, transactionCount: 3, fanCount: 3 }],
      // The chargeback (2026-10-09 23:30 UTC) stands on its own day.
      ["2026-10-10", { netMills: -501, pendingMills: 0, transactionCount: 1, fanCount: 1 }],
    ]);
    expect(history.hubMoney).toMatchObject({ state: "available", netMills: 2700, floorAt: h(0).toISOString() });

    const before = await getOfLinkHistory(app.db, {
      seriesEnabled: true, pageId: vipPage, linkKind: "trial", linkRef: "11170786",
      from: "2026-10-01", to: "2026-10-08", now: NOW,
    });
    expect(before.hubMoney).toMatchObject({ state: "no_data", reason: "before_floor", netMills: null, floorAt: h(0).toISOString() });
  });

  it("keeps Hub's money of a channel's stretch OFAPI never read (the link moved before its first snapshot)", async () => {
    const result = await getOfLinkChannels(app.db, { from: "2026-10-09", to: "2026-10-10", now: NOW });
    const reddit = result.channels.find((channel) => channel.channelKey === "lora.reddit");
    // OFAPI has no segment for Reddit (no snapshot of C before it left), Hub
    // has C's 1000: OFAPI's figure there is unknown, not zero, and the
    // binding's start was assumed.
    expect(reddit).toMatchObject({
      segments: [], totals: { vendorNetMills: 0, hubMoney: { state: "partial", netMills: 1000 } },
      flags: ["money_unknown", "assumed_binding_start"],
    });
    const byContractor = new Map(result.contractors.map((row) => [row.contractorKey, row]));
    // Reddit has no contractor: C's Reddit stretch is in the contractor-less row.
    expect(byContractor.get(null)!.totals.hubMoney.netMills).toBeGreaterThanOrEqual(1000);
    expect(byContractor.get(null)!.channelKeys).toContain("lora.reddit");
  });

  it("sums a channel over its links' shares, partial while Hub's floor falls inside the range", async () => {
    const wide = await getOfLinkChannels(app.db, { from: "2026-10-01", to: "2026-10-10", now: NOW });
    const porntoki = wide.channels.find((channel) => channel.channelKey === "lora.porntoki")!;
    expect(porntoki.totals.hubMoney).toEqual({
      state: "partial", reason: null, revenueBasis: "creator_net_after_platform_fee",
      attributionRule: "ofapi_subscription_period_equal_split.v1", netMills: 2700, pendingMills: 300,
    });
    // After the floor only: the whole range is Hub's.
    const after = await getOfLinkChannels(app.db, { from: "2026-10-10", to: "2026-10-10", now: NOW });
    expect(after.channels.find((channel) => channel.channelKey === "lora.porntoki")!.totals.hubMoney)
      .toMatchObject({ state: "available", netMills: -1001, pendingMills: 0 });
  });
});

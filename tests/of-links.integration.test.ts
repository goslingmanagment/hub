import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyTrafficBindingsChange,
  createModel,
  createOnlyFansPage,
  insertLinkStatRun,
  insertLinkStatRunWithSnapshots,
  type InsertLinkStatSnapshotInput,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { getOfLinkChannels, getOfLinkHistory, getOfLinks } from "../apps/runtime/src/services/of-links.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// «Ссылки OnlyFans» API (traffic plan §2.6, PR 12): the link series, its
// bindings and its collection state, read for the owner. Hub money is not
// computed before PR 13 and says so.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let freePage = 0;
let vipPage = 0;
let stalePage = 0;

const NOW = new Date("2026-10-09T12:00:00Z");
const at = (value: string) => new Date(value);

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Integration database unavailable");
  testDb = started;
}, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(async () => { await server?.close(); server = null; });

function trialLink(id: string, values: Partial<InsertLinkStatSnapshotInput>): InsertLinkStatSnapshotInput {
  return {
    platformAccountId: vipPage,
    linkKind: "trial",
    platformLinkId: id,
    name: null,
    url: `https://onlyfans.com/action/trial/${id}`,
    linkCreatedAt: null,
    linkEndsAt: null,
    isFinished: false,
    clicksCount: 0,
    claimsCount: 0,
    subscribersCount: 0,
    spendersCount: 0,
    revenueNetMills: 0n,
    revenueChargebacksMills: 0n,
    revenueIsLoading: false,
    revenueCalculatedAt: null,
    trialDays: 180,
    tags: [],
    ...values,
  };
}

const rsr3 = (values: Partial<InsertLinkStatSnapshotInput>) => trialLink("10802699", {
  name: "reddit rsr_3", linkCreatedAt: at("2025-11-26T17:06:21Z"), linkEndsAt: at("2026-09-30T00:42:13Z"), isFinished: true, ...values,
});
const erome = (values: Partial<InsertLinkStatSnapshotInput>) => trialLink("11170787", {
  name: "Erome", linkCreatedAt: at("2026-04-01T13:31:20Z"), ...values,
});

async function trialRun(pulledAt: string, rows: InsertLinkStatSnapshotInput[], extra: { reason?: string; account?: string; windowAt?: string } = {}) {
  return insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: vipPage, linkKind: "trial", status: extra.reason ? "partial" : "complete",
    pulledAt: at(pulledAt), apiPages: 1, rawItems: rows.length, writtenRows: rows.length,
    reason: extra.reason ?? null, windowAt: extra.windowAt ? at(extra.windowAt) : null,
    ofapiAccountId: extra.account ?? "acct_new",
  }, rows);
}

beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  const model = await createModel(app.db, { slug: "lora", name: "Lora" });
  freePage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-of" }))!.id;
  vipPage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "lora-vip-of" }))!.id;
  stalePage = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "ari-of" }))!.id;
  await testDb.pool.query("update pages set ofapi_account_id = 'acct_free' where id = $1", [freePage]);
  await testDb.pool.query("update pages set ofapi_account_id = 'acct_new' where id = $1", [vipPage]);

  // VIP trial links: the series' first read (money only in the deprecated
  // column, as rows written before 0256 have it), the read after the OFAPI
  // account changed, the vendor's recalculation a day later, today's window
  // with a new link whose money is still computing, and a failed retry.
  const first = await trialRun("2026-07-22T12:17:47Z", [
    rsr3({ clicksCount: 5000, claimsCount: 1000, revenueNetMills: 5_000_000n }),
    erome({ clicksCount: 50, claimsCount: 30, revenueNetMills: 892_000n }),
  ], { account: "acct_old" });
  await testDb.pool.query("update page_link_stat_snapshots set revenue_net_mills = null where run_id = $1", [first.runId]);
  await trialRun("2026-09-09T04:45:00Z", [
    rsr3({ clicksCount: 11000, claimsCount: 2900, revenueNetMills: 13_000_000n }),
    erome({ clicksCount: 120, claimsCount: 76, revenueNetMills: 992_000n }),
  ], { reason: "binding_changed" });
  await trialRun("2026-09-10T04:45:00Z", [
    rsr3({ clicksCount: 11674, claimsCount: 2939, spendersCount: 126, revenueNetMills: 13_483_440n }),
    erome({ clicksCount: 120, claimsCount: 76, revenueNetMills: 728_000n }),
  ]);
  await trialRun("2026-10-09T03:45:30Z", [
    rsr3({ clicksCount: 11674, claimsCount: 2939, spendersCount: 126, revenueNetMills: 13_483_440n }),
    erome({ clicksCount: 124, claimsCount: 76, revenueNetMills: 728_000n }),
    trialLink("11687581", { name: "SpankBang", linkCreatedAt: at("2026-10-08T16:55:31Z"), spendersCount: null, revenueNetMills: null, revenueChargebacksMills: null, revenueIsLoading: true }),
  ], { windowAt: "2026-10-09T03:45:00Z" });
  await insertLinkStatRun(app.db, {
    platformAccountId: vipPage, linkKind: "trial", status: "failed", pulledAt: at("2026-10-09T09:45:20Z"),
    apiPages: 0, rawItems: 0, writtenRows: 0, reason: "OFAPI HTTP 502", windowAt: at("2026-10-09T09:45:00Z"), ofapiAccountId: "acct_new",
  });
  await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: vipPage, linkKind: "tracking", status: "complete", pulledAt: at("2026-10-09T09:45:10Z"),
    apiPages: 1, rawItems: 1, writtenRows: 1, windowAt: at("2026-10-09T09:45:00Z"), ofapiAccountId: "acct_new",
  }, [{ ...trialLink("2150850", { name: "GG twitter", trialDays: null }), linkKind: "tracking", claimsCount: null, linkEndsAt: at("2025-09-25T23:31:52Z") }]);

  // The free page's tracking links; one ended a year ago.
  const tracking = (id: string, values: Partial<InsertLinkStatSnapshotInput>): InsertLinkStatSnapshotInput => ({
    ...trialLink(id, values), platformAccountId: freePage, linkKind: "tracking", claimsCount: null, trialDays: null, isFinished: null,
  });
  await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: freePage, linkKind: "tracking", status: "complete", pulledAt: at("2026-10-09T09:45:05Z"),
    apiPages: 1, rawItems: 2, writtenRows: 2, windowAt: at("2026-10-09T09:45:00Z"), ofapiAccountId: "acct_new",
  }, [
    tracking("2099377", { name: "xfree", clicksCount: 920, subscribersCount: 130, spendersCount: 3, revenueNetMills: 254_150n }),
    tracking("2099526", { name: "redgifts", linkEndsAt: at("2025-09-13T09:06:38Z") }),
  ]);

  // A page whose series stopped two days ago.
  await insertLinkStatRunWithSnapshots(app.db, {
    platformAccountId: stalePage, linkKind: "tracking", status: "complete", pulledAt: at("2026-10-07T03:45:10Z"),
    apiPages: 1, rawItems: 0, writtenRows: 0, windowAt: at("2026-10-07T03:45:00Z"), ofapiAccountId: null,
  }, []);

  await applyTrafficBindingsChange(app.db, {
    contractors: [{ key: "coraline-red", title: "@coraline_red" }],
    channels: [
      { key: "lora.porntoki", title: "Порнтоки" },
      { key: "lora.reddit", title: "Reddit" },
    ],
    terms: [{ channelKey: "lora.porntoki", contractorKey: "coraline-red", validFrom: at("2026-03-31T21:00:00Z"), validTo: null, validFromBasis: "confirmed" }],
    bindings: [
      { pageLabel: "lora-vip-of", linkKind: "trial", linkId: "11170787", channelKey: "lora.porntoki", validFrom: at("2026-03-31T21:00:00Z"), validTo: null, validFromBasis: "confirmed" },
      { pageLabel: "lora-vip-of", linkKind: "trial", linkId: "10802699", channelKey: "lora.reddit", validFrom: at("2025-11-26T17:06:21Z"), validTo: at("2026-09-30T00:00:00Z"), validFromBasis: "assumed_link_created" },
    ],
  }, { write: true, actor: "test", command: "import" });
});

describe("GET /of-links", () => {
  it("gives every link its latest snapshot, fans by kind, its state, its channel and empty Hub money", async () => {
    const result = await getOfLinks(app.db, { pageId: vipPage, now: NOW });
    expect(result.links.map((link) => `${link.linkKind}:${link.linkRef}`)).toEqual([
      "tracking:2150850", "trial:10802699", "trial:11170787", "trial:11687581",
    ]);
    const byRef = new Map(result.links.map((link) => [link.linkRef, link]));
    // Window 3 §8 п. 14: the trial link's fans are its claims (2 939), not "subscribers 0".
    expect(byRef.get("10802699")).toMatchObject({
      fans: 2939, fansMetric: "claims", claims: 2939, subscribers: 0, state: "expired", inLatestRun: true,
      observedAt: "2026-10-09T03:45:30.000Z", businessDate: "2026-10-09",
      vendorMoney: { revenueBasis: "creator_net_after_platform_fee", netMills: 13_483_440, lastRecalculation: null },
      binding: { channelKey: "lora.reddit", channelTitle: "Reddit", validTo: "2026-09-30T00:00:00.000Z", validFromBasis: "assumed_link_created", contractor: null },
      hubMoney: { state: "no_data", reason: "not_computed", netMills: null, floorAt: null, attributionRule: "ofapi_subscription_period_equal_split.v1" },
      comparison: { state: null, vendorDeltaMills: null, hubNetMills: null },
    });
    expect(byRef.get("11170787")).toMatchObject({
      state: "active",
      vendorMoney: {
        netMills: 728_000,
        lastRecalculation: {
          observedAt: "2026-09-10T04:45:00.000Z", previousObservedAt: "2026-09-09T04:45:00.000Z",
          fromMills: 992_000, toMills: 728_000, bindingChanged: false, accountChangedAt: "2026-09-09T04:45:00.000Z",
        },
      },
      binding: { channelKey: "lora.porntoki", validTo: null, contractor: { contractorKey: "coraline-red", contractorTitle: "@coraline_red" } },
    });
    expect(byRef.get("11687581")).toMatchObject({ state: "active", spenders: null, vendorMoney: { netMills: null, isLoading: true }, binding: null });
    expect(byRef.get("2150850")).toMatchObject({ fansMetric: "subscribers", claims: null, state: "expired" });

    // Window 3 §8 п. 11: the API sums to what the series' latest trial read holds.
    const sums = await testDb.pool.query<{ clicks: number; claims: number; net: string }>(`
      select sum(clicks_count)::int clicks, sum(claims_count)::int claims,
             sum(coalesce(revenue_net_mills, revenue_gross_mills))::text net
      from page_link_stat_snapshots
      where run_id = (select max(id) from page_link_stat_runs
                      where platform_account_id = $1 and link_kind = 'trial' and status in ('complete','partial'))`, [vipPage]);
    const trial = result.links.filter((link) => link.linkKind === "trial" && link.inLatestRun);
    expect(trial.reduce((sum, link) => sum + link.clicks, 0)).toBe(sums.rows[0]!.clicks);
    expect(trial.reduce((sum, link) => sum + (link.claims ?? 0), 0)).toBe(sums.rows[0]!.claims);
    expect(String(trial.reduce((sum, link) => sum + (link.vendorMoney.netMills ?? 0), 0))).toBe(sums.rows[0]!.net);
  });

  it("states each page's collection: last attempt, last usable result, staleness by the series' rule", async () => {
    const result = await getOfLinks(app.db, { now: NOW });
    expect(result.staleAfterHours).toBe(15);
    expect(result.seriesFloorAt).toBe("2026-07-22T12:17:47.000Z");
    expect(result.pages.map((page) => page.pageLabel)).toEqual(["lora-of", "lora-vip-of", "ari-of"]);
    const vip = result.pages.find((page) => page.pageId === vipPage)!;
    expect(vip.kinds.find((kind) => kind.linkKind === "trial")).toMatchObject({
      lastUsableAt: "2026-10-09T03:45:30.000Z", linkCount: 3, stale: false, staleSince: null,
      lastAttempt: { status: "failed", reason: "OFAPI HTTP 502", usable: false, windowAt: "2026-10-09T09:45:00.000Z", attempt: 1 },
    });
    const stale = result.pages.find((page) => page.pageId === stalePage)!;
    expect(stale.ofapiMapped).toBe(false);
    expect(stale.kinds).toEqual([
      expect.objectContaining({ linkKind: "tracking", stale: true, staleSince: "2026-10-07T03:45:10.000Z", linkCount: 0 }),
      expect.objectContaining({ linkKind: "trial", stale: false, lastAttempt: null, lastUsableAt: null }),
    ]);
    // Without a page, every page's links.
    expect(result.links.filter((link) => link.pageId === freePage).map((link) => [link.linkRef, link.state])).toEqual([
      ["2099377", "active"], ["2099526", "expired"],
    ]);
  });
});

describe("GET /of-links/history", () => {
  it("gives business-day deltas between the last snapshots before each Moscow midnight, with their flags", async () => {
    const history = await getOfLinkHistory(app.db, {
      pageId: vipPage, linkKind: "trial", linkRef: "11170787", from: "2026-09-08", to: "2026-09-10", now: NOW,
    });
    expect(history.range).toEqual({
      from: "2026-09-08", to: "2026-09-10", fromAt: "2026-09-07T21:00:00.000Z", toAt: "2026-09-10T21:00:00.000Z",
    });
    expect(history.days.map((day) => [day.businessDate, day.startObservedAt, day.endObservedAt, day.clicks, day.claims, day.fans, day.vendorNetMills, day.flags, day.missedWindows]))
      .toEqual([
        ["2026-09-08", "2026-07-22T12:17:47.000Z", "2026-07-22T12:17:47.000Z", 0, 0, 0, 0, [], null],
        ["2026-09-09", "2026-07-22T12:17:47.000Z", "2026-09-09T04:45:00.000Z", 70, 46, 46, 100_000, ["binding_changed"], null],
        // A fall of OFAPI's money is a recalculation, not a loss.
        ["2026-09-10", "2026-09-09T04:45:00.000Z", "2026-09-10T04:45:00.000Z", 0, 0, 0, -264_000, ["vendor_recalculated"], null],
      ]);
    expect(history.snapshots.map((snapshot) => [snapshot.observedAt, snapshot.bindingChanged, snapshot.vendorRecalculated])).toEqual([
      ["2026-09-09T04:45:00.000Z", true, false],
      ["2026-09-10T04:45:00.000Z", false, true],
    ]);
    expect(history.days.every((day) => day.hub === null)).toBe(true);
    expect(history.hubMoney).toMatchObject({ state: "no_data", reason: "not_computed" });
  });

  it("counts a link older than the series from zero with no_baseline, and reads money from the deprecated column", async () => {
    const history = await getOfLinkHistory(app.db, {
      pageId: vipPage, linkKind: "trial", linkRef: "10802699", from: "2026-07-22", to: "2026-07-22", now: NOW,
    });
    expect(history.days).toEqual([expect.objectContaining({
      startObservedAt: null, clicks: 5000, claims: 1000, vendorNetMills: 5_000_000, flags: ["no_baseline"],
    })]);
    expect(history.snapshots[0]).toMatchObject({ vendorNetMills: 5_000_000, fans: 1000 });
  });

  it("lists the list's attempts and counts a window missed only once it has closed", async () => {
    const midday = await getOfLinkHistory(app.db, {
      pageId: vipPage, linkKind: "trial", linkRef: "11687581", from: "2026-10-09", to: "2026-10-09", now: NOW,
    });
    expect(midday.attempts.map((attempt) => [attempt.status, attempt.usable, attempt.windowAt])).toEqual([
      ["complete", true, "2026-10-09T03:45:00.000Z"],
      ["failed", false, "2026-10-09T09:45:00.000Z"],
    ]);
    expect(midday.days).toEqual([expect.objectContaining({
      // Created 10-08 19:55 MSK, first read 10-09: what it gathered before the day is not known apart.
      businessDate: "2026-10-09", missedWindows: 0, startObservedAt: null, clicks: 0, vendorNetMills: null, flags: ["no_baseline", "money_unknown"],
    })]);
    const evening = await getOfLinkHistory(app.db, {
      pageId: vipPage, linkKind: "trial", linkRef: "11687581", from: "2026-10-09", to: "2026-10-09", now: at("2026-10-09T16:00:00Z"),
    });
    expect(evening.days[0]!.missedWindows).toBe(1);
  });

  it("refuses an unknown link, an unknown page and a reversed range", async () => {
    await expect(getOfLinkHistory(app.db, { pageId: vipPage, linkKind: "trial", linkRef: "1", now: NOW })).rejects.toMatchObject({ kind: "not_found" });
    await expect(getOfLinkHistory(app.db, { pageId: 999_999, linkKind: "trial", linkRef: "1", now: NOW })).rejects.toMatchObject({ kind: "not_found" });
    await expect(getOfLinkHistory(app.db, {
      pageId: vipPage, linkKind: "trial", linkRef: "11170787", from: "2026-09-10", to: "2026-09-08", now: NOW,
    })).rejects.toMatchObject({ kind: "bad_request" });
  });
});

describe("GET /of-links/channels", () => {
  it("sums links by channel and contractor over dated bindings, the rest in «без канала»", async () => {
    const result = await getOfLinkChannels(app.db, { from: "2026-09-01", to: "2026-10-09", pageId: vipPage, now: NOW });
    expect(result.range).toEqual({ from: "2026-09-01", to: "2026-10-09", fromAt: "2026-08-31T21:00:00.000Z", toAt: NOW.toISOString() });
    expect(result.channels.map((channel) => [channel.channelKey, channel.totals.linkCount, channel.totals.clicks, channel.totals.fans, channel.totals.vendorNetMills, channel.flags]))
      .toEqual([
        ["lora.porntoki", 1, 74, 46, -164_000, ["vendor_recalculated", "binding_changed"]],
        // The binding's start is assumed (П9.7); it closed 30.09.
        ["lora.reddit", 1, 6674, 1939, 8_483_440, ["binding_changed", "assumed_binding_start"]],
        // rsr_3 after its binding closed, the unbound new link (money unknown), and the
        // tracking link the series first read on 10-09 (older: counted whole, flagged).
        [null, 3, 0, 0, 0, ["no_baseline", "money_unknown"]],
      ]);
    const porntoki = result.channels[0]!;
    expect(porntoki.contractors).toEqual([expect.objectContaining({ contractorKey: "coraline-red", validFromBasis: "confirmed" })]);
    expect(porntoki.segments).toEqual([expect.objectContaining({
      linkRef: "11170787", contractorKey: null, startAt: "2026-08-31T21:00:00.000Z", endAt: NOW.toISOString(),
      startObservedAt: "2026-07-22T12:17:47.000Z", endObservedAt: "2026-10-09T03:45:30.000Z",
    })]);
    expect(porntoki.totals.hubMoney).toMatchObject({ state: "no_data", reason: "not_computed", netMills: null });
    expect(result.contractors.map((contractor) => [contractor.contractorKey, contractor.channelKeys, contractor.totals.clicks])).toEqual([
      ["coraline-red", ["lora.porntoki"], 74],
      [null, ["lora.reddit"], 6674],
    ]);
  });

  it("keeps a channel's total when a new contractor starts between snapshots whose money is unknown", async () => {
    // Erome's 09-09 read did not know its money; on 09-09 12:00 the channel
    // passes to another contractor.
    await testDb.pool.query(`
      update page_link_stat_snapshots set revenue_net_mills = null, revenue_gross_mills = null
      where platform_link_id = '11170787' and run_id = (select id from page_link_stat_runs where pulled_at = '2026-09-09T04:45:00Z')`);
    await applyTrafficBindingsChange(app.db, {
      contractors: [{ key: "coraline-red", title: "@coraline_red" }, { key: "true-helper", title: "True Helper" }],
      channels: [{ key: "lora.porntoki", title: "Порнтоки" }],
      terms: [
        { channelKey: "lora.porntoki", contractorKey: "coraline-red", validFrom: at("2026-03-31T21:00:00Z"), validTo: at("2026-09-09T12:00:00Z"), validFromBasis: "confirmed" },
        { channelKey: "lora.porntoki", contractorKey: "true-helper", validFrom: at("2026-09-09T12:00:00Z"), validTo: null, validFromBasis: "confirmed" },
      ],
      bindings: [],
    }, { write: true, actor: "test", command: "import" });
    const result = await getOfLinkChannels(app.db, { from: "2026-09-01", to: "2026-10-09", pageId: vipPage, now: NOW });
    const porntoki = result.channels.find((channel) => channel.channelKey === "lora.porntoki")!;
    expect(porntoki.totals.vendorNetMills).toBe(-164_000);
    expect(porntoki.flags).not.toContain("money_unknown");
    expect(porntoki.contractors.map((term) => term.contractorKey)).toEqual(["coraline-red", "true-helper"]);
    const byContractor = new Map(result.contractors.map((contractor) => [contractor.contractorKey, contractor]));
    for (const key of ["coraline-red", "true-helper"]) {
      expect(byContractor.get(key)).toMatchObject({ channelKeys: ["lora.porntoki"], totals: { vendorNetMills: 0 }, flags: expect.arrayContaining(["money_unknown"]) });
      expect(byContractor.get(key)!.segments).toEqual([expect.objectContaining({ contractorKey: key, vendorNetMills: null })]);
    }
  });

  it("keeps a deleted page's links in historical totals, and out of the current collection state", async () => {
    const before = await getOfLinkChannels(app.db, { from: "2026-10-09", to: "2026-10-09", now: NOW });
    const freeSegments = (result: typeof before) =>
      result.channels.flatMap((channel) => channel.segments).filter((segment) => segment.pageId === freePage);
    expect(freeSegments(before).map((segment) => segment.linkRef)).toEqual(["2099377", "2099526"]);
    await testDb.pool.query("update pages set status = 'deleted', deleted_at = now() where id = $1", [freePage]);
    const after = await getOfLinkChannels(app.db, { from: "2026-10-09", to: "2026-10-09", now: NOW });
    expect(freeSegments(after)).toEqual(freeSegments(before));
    expect(after.channels.at(-1)!.totals).toEqual(before.channels.at(-1)!.totals);
    const current = await getOfLinks(app.db, { now: NOW });
    expect(current.pages.map((page) => page.pageLabel)).toEqual(["lora-vip-of", "ari-of"]);
    expect(current.links.some((link) => link.pageId === freePage)).toBe(false);
  });

  it("over all time counts accumulated values from zero and flags the links older than the series", async () => {
    const result = await getOfLinkChannels(app.db, { now: NOW });
    expect(result.range.from).toBe("2026-07-22");
    const reddit = result.channels.find((channel) => channel.channelKey === "lora.reddit")!;
    expect(reddit.totals).toMatchObject({ clicks: 11674, claims: 2939, vendorNetMills: 13_483_440 });
    expect(reddit.flags).toContain("no_baseline");
    const unbound = result.channels.at(-1)!;
    expect(unbound.channelKey).toBeNull();
    expect(unbound.segments.map((segment) => segment.pageLabel)).toContain("lora-of");
  });
});

describe("routes", () => {
  async function cookie(username: string, role: "owner" | "team_lead") {
    await createUserAccount(app, { username, role, password: "synthetic-password" }, { source: "cli" });
    server ??= await buildApiServer(app);
    const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
  }

  it("serve the owner, refuse anyone else, and answer 404 and 400 for what does not exist or does not parse", async () => {
    const owner = await cookie("owner", "owner");
    const lead = await cookie("lead", "team_lead");
    const urls = [
      `/api/v1/admin/of-links?pageId=${vipPage}`,
      `/api/v1/admin/of-links/history?pageId=${vipPage}&linkKind=trial&linkRef=11170787&from=2026-09-01&to=2026-09-30`,
      "/api/v1/admin/of-links/channels?from=2026-09-01",
    ];
    for (const url of urls) {
      expect((await server!.inject({ method: "GET", url, headers: { cookie: owner } })).statusCode).toBe(200);
      expect((await server!.inject({ method: "GET", url, headers: { cookie: lead } })).statusCode).toBe(403);
      expect((await server!.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    const body = (await server!.inject({ method: "GET", url: urls[0]!, headers: { cookie: owner } })).json();
    expect(body.links.find((link: { linkRef: string }) => link.linkRef === "10802699").fans).toBe(2939);
    const get = (url: string) => server!.inject({ method: "GET", url, headers: { cookie: owner } });
    expect((await get("/api/v1/admin/of-links?pageId=999999")).statusCode).toBe(404);
    expect((await get(`/api/v1/admin/of-links/history?pageId=${vipPage}&linkKind=trial&linkRef=42`)).statusCode).toBe(404);
    expect((await get(`/api/v1/admin/of-links/history?pageId=${vipPage}&linkKind=smart&linkRef=42`)).statusCode).toBe(400);
    expect((await get("/api/v1/admin/of-links/channels?from=2026-10-09&to=2026-09-01")).statusCode).toBe(400);
    expect((await get("/api/v1/admin/of-links/channels?from=2026-02-30")).statusCode).toBe(400);
  });
});

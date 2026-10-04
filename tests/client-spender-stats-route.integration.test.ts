import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientBootstrapResponseSchema,
  clientSpenderStatsResponseSchema,
  errorResponseSchema,
  revenueDailyResponseSchema,
  spenderListResponseSchema,
  type ClientSpenderStatsResponse,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  deletePageByLabel,
  getPageSpenderStats,
  insertAgentKey,
  rebuildSpenderProjections,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { nextBusinessDate, sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
  unassignPageFromUser,
  type HumanAuthPrincipal,
} from "../apps/runtime/src/services/auth.ts";
import type * as ClientCapabilitiesModule from "../apps/runtime/src/services/client-capabilities.ts";
import { getClientSpenderStats, toClientSpenderStats } from "../apps/runtime/src/services/spender-stats.ts";
import { frozenClientSpenderStatsSchema } from "./helpers/client-frozen-spender-stats.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  SPENDER_STATS_FIXTURE_AS_OF,
  SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT,
  spenderStatsFixture,
} from "./helpers/spender-stats-fixture.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// chat-extension H-8b: GET /api/v1/client/pages/:pageLabel/spenders/stats, the
// Spenders statistics of one page. What each number means is proven on the
// repository (tests/client-spender-stats.integration.test.ts, the same seeded
// page) and the wire shape in tests/client-spender-stats-contract.test.ts; this
// file is the route: who may ask, what it answers, how it reconciles with the
// hub's other money reads, how long an answer is kept, and that it never
// reaches a platform. Every test runs under the no-outbound trap.

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// The `stats` feature needs two hub capabilities: `spenders-stats-v1` (this
// route) and `awaiting-reply-v1` (the queue, H-8c, not served yet). As merged,
// the route therefore answers `hub_not_ready` whatever the owner switches on;
// the first test below holds exactly that. Every other test stands in for the
// hub that serves both, which is the only state the route answers in. When
// H-8c adds `awaiting-reply-v1` to SERVED_CLIENT_CAPABILITIES, this mock and
// the `hub_not_ready` half of the first test go.
const hub = vi.hoisted(() => ({ servesQueue: true }));
vi.mock("../apps/runtime/src/services/client-capabilities.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientCapabilitiesModule>();
  return {
    ...actual,
    get SERVED_CLIENT_CAPABILITIES() {
      return hub.servesQueue
        ? [...new Set([...actual.SERVED_CLIENT_CAPABILITIES, "awaiting-reply-v1"])]
        : actual.SERVED_CLIENT_CAPABILITIES;
    },
  };
});

/** The instant every seeded number is of: 2026-10-03 12:00Z. */
const NOW = SPENDER_STATS_FIXTURE_AS_OF;
const PAGE = "stats-of";
const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", grisha: "grisha-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** A live Agent Read Plane key granted the page: refused by its kind, not by the page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientspenderstats00`;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/** authPolicyEnforcement "log" (the test default): the handler's own guards answer. */
let server: ApiServer | null = null;
/** authPolicyEnforcement "enforce": the declared policy answers before the handler. */
let enforceServer: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let ownerToken = "";
let leadToken = "";
/** Grisha's narrow chat-extension token, issued by the real password sign-in. */
let narrowToken = "";
/** Grisha's full device token. */
let fullToken = "";
/** A chatter of stats-other-of only. */
let nikitaToken = "";
let ownerId = 0;
let grishaId = 0;
const pageIds: Record<string, number> = {};

function db() {
  if (!testDb) throw new Error("test database missing");
  return testDb;
}

const fixture = spenderStatsFixture(db);

function statsUrl(pageLabel: string, query: string) {
  return `/api/v1/client/pages/${pageLabel}/spenders/stats${query === "" ? "" : `?${query}`}`;
}

async function stats(
  token: string,
  pageLabel: string,
  query: string,
  options: { via?: ApiServer; clientVersion?: string | null } = {},
): Promise<InjectResponse> {
  const clientVersion = options.clientVersion === undefined ? EXTENSION_VERSION : options.clientVersion;
  return (options.via ?? server!).inject({
    method: "GET",
    url: statsUrl(pageLabel, query),
    headers: {
      authorization: `Bearer ${token}`,
      ...(clientVersion === null ? {} : { "x-client-version": clientVersion }),
    },
  });
}

/** A 200 answer, checked against the installed client's own shape first, then the hub's (what the SDK parses with). */
async function report(token: string, pageLabel: string, query = "windowDays=30&timeZone=UTC"): Promise<ClientSpenderStatsResponse> {
  const response = await stats(token, pageLabel, query);
  expect(response.statusCode, response.body).toBe(200);
  frozenClientSpenderStatsSchema.parse(response.json());
  return clientSpenderStatsResponseSchema.parse(response.json());
}

function expectRefused(response: InjectResponse, statusCode: number, error: string, reason?: string) {
  expect(response.statusCode, response.body).toBe(statusCode);
  const body = errorResponseSchema.parse(response.json());
  expect(body).toMatchObject({ error, statusCode, ...(reason === undefined ? {} : { reason }) });
  if (reason === undefined) {
    expect(body.reason, response.body).toBeUndefined();
  }
}

/** A cookie session, by the real password sign-in. */
async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORDS[username] },
  });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** The owner's master switch and the `stats` flag, for every page. */
async function switchStatsOn() {
  await patchConfig([
    { key: "chatExtensionEnabled", value: true },
    { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { stats: true } }) },
  ]);
}

async function bootstrapOf(token: string) {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/client/bootstrap",
    headers: { authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json());
}

/**
 * Arms the trap again after a test seeded its own rows: the trap compares the
 * chats' unread counts row by row, so a chat seeded after it was armed would
 * read as a change.
 */
async function rearmTrap() {
  await trap?.restore();
  trap = await armNoOutboundTrap(db());
}

/** An OnlyFans page the extension can bind, granted to grisha. */
async function seedGrantedPage(label: string, externalPageId: string) {
  const page = await fixture.seedPage(label);
  await db().pool.query("update pages set external_page_id = $1 where id = $2", [externalPageId, page.id]);
  await assignPageToUser(app, { userId: grishaId, pageLabel: label }, AUDIT);
  pageIds[label] = page.id;
  return page;
}

describe("GET /api/v1/client/pages/:pageLabel/spenders/stats", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    hub.servesQueue = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    await createUserAccount(app, { username: "nikita", role: "chatter" }, AUDIT);
    ownerId = await fixtureUserId(app, "owner");
    const leadId = await fixtureUserId(app, "lead");
    grishaId = await fixtureUserId(app, "grisha");
    const nikitaId = await fixtureUserId(app, "nikita");
    // Setting a password ends every sign-in, so it comes before the tokens.
    await setUserPassword(app, { userId: grishaId, password: PASSWORDS.grisha }, AUDIT);

    // The seeded page of the repository tests, and another page's spend beside it.
    const { page, other } = await fixture.seedMainPage();
    pageIds[PAGE] = page.id;
    pageIds["stats-other-of"] = other.id;
    await fixture.rebuildAll(page.id);
    await fixture.rebuildAll(other.id);
    await setPageOfapiAccountId(testDb.db, { pageId: page.id, ofapiAccountId: SPENDER_STATS_FIXTURE_OFAPI_ACCOUNT });
    await testDb.pool.query("update pages set external_page_id = '100000001' where id = $1", [page.id]);
    await testDb.pool.query("update pages set external_page_id = '100000002' where id = $1", [other.id]);

    const aux = await createModel(app.db, { slug: "aux", name: "Aux" });
    for (const [label, create] of [
      ["stats-fansly", createFanslyPage],
      // An OnlyFans page the extension could not bind: no platform account id.
      ["nova-of", createOnlyFansPage],
      ["stats-old-of", createOnlyFansPage],
    ] as const) {
      const created = await create(app.db, { modelId: aux!.id, label });
      pageIds[label] = created!.id;
    }
    for (const label of [PAGE, "stats-fansly", "nova-of", "stats-old-of"]) {
      await assignPageToUser(app, { userId: grishaId, pageLabel: label }, AUDIT);
    }
    await assignPageToUser(app, { userId: leadId, pageLabel: PAGE }, AUDIT);
    await assignPageToUser(app, { userId: nikitaId, pageLabel: "stats-other-of" }, AUDIT);
    await deletePageByLabel(app.db, "stats-old-of");

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: leadId, label: "lead client" })).token;
    fullToken = (await issueDeviceTokenForUserId(app, { userId: grishaId, label: "grisha full" })).token;
    nikitaToken = (await issueDeviceTokenForUserId(app, { userId: nikitaId, label: "nikita client" })).token;
    await insertAgentKey(app.db, {
      name: "client-spender-stats-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:money"],
      pageIds: [page.id],
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();
    enforceServer = await buildApiServer(createTestAppContext(testDb, { authPolicyEnforcement: "enforce" }));
    await enforceServer.ready();

    const narrow = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": EXTENSION_VERSION },
      payload: {
        username: "grisha",
        password: PASSWORDS.grisha,
        label: "Firefox · macOS · ChatSpace",
        mode: "active",
        client: "chat-extension",
      },
    });
    expect(narrow.statusCode, narrow.body).toBe(200);
    expect(narrow.json()).toMatchObject({ client: "chat-extension" });
    narrowToken = narrow.json<{ token: string }>().token;

    ownerCookie = await loginCookie("owner");
    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
    await enforceServer?.close();
    enforceServer = null;
    vi.useRealTimers();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("is inert as merged: disabled at rest, then hub_not_ready until the awaiting-reply queue is served", async (context) => {
    if (!server) return context.skip();
    hub.servesQueue = false;

    // At rest (what a merge leaves): every caller is refused, whatever the query.
    for (const token of [narrowToken, fullToken, ownerToken]) {
      expectRefused(await stats(token, PAGE, "windowDays=30&timeZone=UTC"), 409, "client_feature_disabled", "disabled");
    }
    expectRefused(await stats(narrowToken, PAGE, "timeZone=Mars/Olympus"), 409, "client_feature_disabled", "disabled");
    const atRest = await bootstrapOf(narrowToken);
    expect(atRest.capabilities).toContain("spenders-stats-v1");
    expect(atRest.capabilities).not.toContain("awaiting-reply-v1");
    expect(atRest.pages.find((page) => page.pageLabel === PAGE)?.features.stats)
      .toEqual({ available: false, reason: "disabled" });

    // The owner switches Statistics on: the hub still does not serve the whole
    // feature (the queue is H-8c), so the route stays shut and says why.
    await switchStatsOn();
    for (const token of [narrowToken, fullToken, ownerToken]) {
      expectRefused(await stats(token, PAGE, "windowDays=30&timeZone=UTC"), 409, "client_feature_disabled", "hub_not_ready");
    }
    expect((await bootstrapOf(narrowToken)).pages.find((page) => page.pageLabel === PAGE)?.features.stats)
      .toEqual({ available: false, reason: "hub_not_ready" });

    // The hub that serves both capabilities answers.
    hub.servesQueue = true;
    expect((await report(narrowToken, PAGE)).pageLabel).toBe(PAGE);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers the page's numbers as the repository counted them, the same to everyone granted the page", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    const body = await report(narrowToken, PAGE, "windowDays=30&timeZone=UTC");

    // The route adds nothing and drops nothing: it is the repository's answer on the wire.
    const counted = await getPageSpenderStats(app.db, { pageId: pageIds[PAGE]!, timeZone: "UTC", asOf: NOW });
    expect(body).toEqual(toClientSpenderStats(PAGE, counted));

    expect(body).toMatchObject({
      pageLabel: PAGE,
      metricVersion: 1,
      moneyUnit: "USD-mills",
      basis: "gross",
      timeZone: "UTC",
      from: "2026-09-04",
      to: "2026-10-03",
      asOf: NOW.toISOString(),
      projectionAsOf: NOW.toISOString(),
      coverage: { state: "complete", reasons: [] },
      avgCheckMills: 4_438,
      newPayers: { count: 4, firstPurchaseKnown: true },
      queueSummary: { total: 3, unknown: 1 },
    });
    expect([...body.includedStates].sort()).toEqual(["pending", "posted", "unknown"]);
    expect(body.days).toHaveLength(30);
    expect(body.days.map((day) => day.date)).toEqual([...body.days.map((day) => day.date)].sort());
    expect(body.days[0]!.date).toBe(body.from);
    expect(body.days.at(-1)!.date).toBe(body.to);
    expect(body.totals.d30).toEqual({
      grossMills: 32_000,
      purchasesGrossMills: 35_500,
      adjustmentsMills: -3_500,
      creatorNetMills: 25_600,
      purchaseCount: 8,
      payerCount: 6,
    });
    expect(body.totals.today).toMatchObject({ grossMills: 5_000, purchaseCount: 1, payerCount: 1 });
    expect(body.totals.d7).toMatchObject({ grossMills: 14_000, adjustmentsMills: -3_000, payerCount: 3 });
    expect(body.totals.prev7).toMatchObject({ grossMills: 14_000, purchaseCount: 2, payerCount: 1 });
    expect(body.totals.d7DeltaPct).toBe(0);
    // The refund day: negative gross, and the states sum to it.
    expect(body.days.find((day) => day.date === "2026-09-30")).toMatchObject({
      grossMills: -1_000,
      purchasesGrossMills: 2_000,
      adjustmentsMills: -3_000,
      byState: { posted: -3_000, pending: 2_000, unknown: 0 },
    });
    expect(body.silence).toEqual({
      d8to21: { fans: 2, lifetimeGrossMills: 712_000 },
      over21: { fans: 1, lifetimeGrossMills: 197_000 },
      unknown: { fans: 1, lifetimeGrossMills: 1_000 },
    });
    // Σ tiers = the window total, the two remainders included.
    expect(body.tiers.map((tier) => tier.key)).toEqual(["0-25", "25-50", "50-150", "150-350", "350-600", "600-plus", "untiered", "unattributed"]);
    expect(body.tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0)).toBe(body.totals.d30.grossMills);

    // The page's numbers are the page's: an owner, a team lead, a chatter's
    // narrow and full tokens all read the same body.
    for (const [who, token] of [["owner", ownerToken], ["team lead", leadToken], ["full token", fullToken]] as const) {
      expect(await report(token, PAGE, "windowDays=30&timeZone=UTC"), who).toEqual(body);
    }
    // The default window is the only one.
    expect(await report(narrowToken, PAGE, "timeZone=UTC")).toEqual(body);

    // Another page is another answer.
    const other = await report(ownerToken, "stats-other-of", "timeZone=UTC");
    expect(other.pageLabel).toBe("stats-other-of");
    expect(other.totals.d30).toMatchObject({ grossMills: 77_000, purchaseCount: 1, payerCount: 1 });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reconciles with /api/v2/spenders and pageRevenueDaily of the same page, dates and instant", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    const body = await report(narrowToken, PAGE, "windowDays=30&timeZone=UTC");

    // /api/v2/spenders?period=30d: the same 30 UTC dates, and its total gross.
    const spenders = await server.inject({
      method: "GET",
      url: `/api/v2/spenders?scope=page&pageLabel=${PAGE}&period=30d&limit=50&offset=0`,
      headers: { authorization: `Bearer ${narrowToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(spenders.statusCode, spenders.body).toBe(200);
    const board = spenderListResponseSchema.parse(spenders.json());
    expect(board.period).toMatchObject({ fromBusinessDate: body.from, toBusinessDateInclusive: body.to });
    expect(body.totals.d30.grossMills).toBe(board.diagnostics.totalGrossAmountMills);
    expect(body.totals.d30.creatorNetMills).toBe(board.diagnostics.totalCreatorNetAmountMills);
    expect(body.tiers.find((tier) => tier.key === "unattributed")?.windowGrossMills)
      .toBe(board.diagnostics.unattributedGrossAmountMills);
    // Σ tiers = the total.
    expect(body.tiers.reduce((sum, tier) => sum + tier.windowGrossMills, 0)).toBe(board.diagnostics.totalGrossAmountMills);

    // The shelves (pageSpenderAutoLists, lifetime) count the same members per bucket.
    const shelves = await server.inject({
      method: "GET",
      url: `/api/v1/pages/${PAGE}/spender-autolists?period=lifetime`,
      headers: { authorization: `Bearer ${narrowToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(shelves.statusCode, shelves.body).toBe(200);
    const lists = shelves.json<{ lists: Array<{ key: string; entryCount: number; minAmountMills: number; maxAmountMillsExclusive: number | null }> }>().lists;
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(body.tiers.find((tier) => tier.key === list.key), list.key).toMatchObject({
        members: list.entryCount,
        minMills: list.minAmountMills,
        maxMills: list.maxAmountMillsExclusive,
      });
    }

    // pageRevenueDaily serves creator net by UTC date, to a session, and only
    // `custom` covers these 30 dates (on OnlyFans `30d` is 31 dates; a custom
    // `to` is exclusive).
    const revenue = await server.inject({
      method: "GET",
      url: `/api/v1/pages/${PAGE}/revenue/daily?period=custom&from=${body.from}&to=${nextBusinessDate(body.to)}`,
      headers: { cookie: ownerCookie },
    });
    expect(revenue.statusCode, revenue.body).toBe(200);
    const series = revenueDailyResponseSchema.parse(revenue.json()).series;
    expect(series.length).toBeGreaterThan(0);
    const daysNet = body.days.reduce((sum, day) => sum + day.creatorNetMills, 0);
    expect(daysNet).toBe(series.reduce((sum, row) => sum + row.netAmountMills, 0));
    expect(daysNet).toBe(body.totals.d30.creatorNetMills);
    for (const row of series) {
      expect(body.days.find((day) => day.date === row.businessDate)?.creatorNetMills, row.businessDate).toBe(row.netAmountMills);
    }
    const thirtyDays = await server.inject({
      method: "GET",
      url: `/api/v1/pages/${PAGE}/revenue/daily?period=30d`,
      headers: { cookie: ownerCookie },
    });
    // A's tip of 2026-09-03 is in the dashboard's 31-date "30d" and outside the stats' 30 dates.
    expect(revenueDailyResponseSchema.parse(thirtyDays.json()).series.map((row) => row.businessDate)).toContain("2026-09-03");
    expect(body.days.map((day) => day.date)).not.toContain("2026-09-03");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("counts a page of more than 1000 payers whole, and says what it does not know of them", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    // 1200 payers: each paid 30 000 in August, every third one 5 000 more inside
    // the window. No message of theirs is held anywhere.
    const big = await seedGrantedPage("stats-big-of", "100000003");
    await db().pool.query(
      `with new_fans as (
         insert into fans (platform, platform_user_id, username)
         select 'onlyfans', (500000 + g)::text, 'bulk' || g from generate_series(1, 1200) g
         returning id, platform_user_id
       ), memberships as (
         insert into page_fans (fan_id, platform_account_id) select id, $1 from new_fans
       )
       insert into transactions (
         platform_account_id, fan_id, transaction_id, raw_type, canonical_type, transaction_state, raw_status,
         gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, is_active, source
       )
       select $1, f.id, 'bulk-' || f.platform_user_id || '-' || t.n, 'tip', 'tip', 'posted', 'ok',
              t.gross, t.gross, t.gross * 8 / 10, t.at, true, 'ofapi:rest'
       from new_fans f
       cross join lateral (
         values (1, 30000::bigint, timestamptz '2026-08-15T10:00:00Z'),
                (2, 5000::bigint, timestamptz '2026-09-20T10:00:00Z')
       ) as t(n, gross, at)
       where t.n = 1 or f.platform_user_id::bigint % 3 = 0`,
      [big.id],
    );
    await fixture.rebuildAll(big.id);

    const body = await report(narrowToken, "stats-big-of");

    // Every payer is in a tier, not only the 1000 a board lists.
    expect(body.tiers.reduce((sum, tier) => sum + tier.members, 0)).toBe(1200);
    expect(body.tiers.find((tier) => tier.key === "25-50")).toMatchObject({
      members: 1200, windowPayers: 400, windowGrossMills: 2_000_000,
    });
    expect(body.totals.d30).toMatchObject({ grossMills: 2_000_000, purchaseCount: 400, payerCount: 400 });
    expect(body.avgCheckMills).toBe(5_000);
    // They paid before the window, so none is new, and that is known.
    expect(body.newPayers).toEqual({ count: 0, firstPurchaseKnown: true });
    // Unknown history: no message of the page is held, so no payer's silence is
    // known. They are counted as unknown, not as silent, and coverage says why.
    expect(body.coverage).toEqual({ state: "partial", reasons: ["messages_missing"] });
    expect(body.silence).toEqual({
      d8to21: { fans: 0, lifetimeGrossMills: 0 },
      over21: { fans: 0, lifetimeGrossMills: 0 },
      unknown: { fans: 1200, lifetimeGrossMills: 1200 * 30_000 + 400 * 5_000 },
    });
    expect(body.queueSummary).toEqual({ total: 0, unknown: 0 });

    // And it still reconciles with the board, whose rows stop at 1000.
    const spenders = await server.inject({
      method: "GET",
      url: "/api/v2/spenders?scope=page&pageLabel=stats-big-of&period=30d&limit=1&offset=0",
      headers: { authorization: `Bearer ${narrowToken}`, "x-client-version": EXTENSION_VERSION },
    });
    expect(spenders.statusCode, spenders.body).toBe(200);
    expect(spenderListResponseSchema.parse(spenders.json()).diagnostics.totalGrossAmountMills).toBe(body.totals.d30.grossMills);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("says what it does not know: no history, a projection never built, a history that starts inside the window", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    // A page that never had a transaction or a projection: nothing is known, and nothing is 0 by guess.
    await seedGrantedPage("stats-empty-of", "100000004");
    const empty = await report(narrowToken, "stats-empty-of");
    expect(empty.coverage).toEqual({ state: "unknown", reasons: ["no_revenue_history"] });
    expect(empty.projectionAsOf).toBeNull();
    expect(empty.avgCheckMills).toBeNull();
    expect(empty.totals.d7DeltaPct).toBeNull();
    expect(empty.newPayers).toEqual({ count: 0, firstPurchaseKnown: false });
    expect(empty.days).toHaveLength(30);
    expect(empty.days.every((day) => day.grossMills === 0 && day.purchaseCount === 0)).toBe(true);
    expect(empty.silence.unknown).toEqual({ fans: 0, lifetimeGrossMills: 0 });

    // Transactions, and a spender projection that was never built: the window
    // money is exact, tiers and silence have nobody yet, and coverage says so.
    const raw = await seedGrantedPage("stats-raw-of", "100000005");
    const rawFan = await fixture.seedFan(raw.id, "9001");
    await fixture.addTransaction(raw.id, { fanId: rawFan, type: "tip", gross: 40_000n, at: "2026-08-01T10:00:00Z" });
    await fixture.addTransaction(raw.id, { fanId: rawFan, type: "tip", gross: 6_000n, at: "2026-09-25T10:00:00Z" });
    const unbuilt = await report(narrowToken, "stats-raw-of");
    expect(unbuilt.coverage).toEqual({ state: "partial", reasons: ["projection_missing"] });
    expect(unbuilt.projectionAsOf).toBeNull();
    expect(unbuilt.totals.d30).toMatchObject({ grossMills: 6_000, payerCount: 1 });
    expect(unbuilt.tiers.find((tier) => tier.key === "untiered")).toMatchObject({ members: 1, windowGrossMills: 6_000 });
    expect(unbuilt.silence.unknown.fans).toBe(0);

    // A history that starts inside the window, and a payer who never wrote: the
    // first purchase is only the first one observed, and the silence is unknown.
    const fresh = await seedGrantedPage("stats-fresh-of", "100000006");
    const newcomer = await fixture.seedFan(fresh.id, "9002");
    await fixture.addTransaction(fresh.id, { fanId: newcomer, type: "tip", gross: 6_000n, at: "2026-09-20T10:00:00Z" });
    await fixture.addThread(fresh.id, { fanId: newcomer, conversationRef: "9002", headRole: "model" });
    // The payer's chat holds only our message: the page has messages, the fan has no text.
    await fixture.addMessage(fresh.id, { conversationRef: "9002", fromFan: false, at: "2026-09-21T10:00:00Z", text: "thank you!" });
    await fixture.rebuildAll(fresh.id);
    await rearmTrap();
    const young = await report(narrowToken, "stats-fresh-of");
    expect(young.coverage).toEqual({ state: "partial", reasons: ["history_starts_in_window"] });
    expect(young.newPayers).toEqual({ count: 1, firstPurchaseKnown: false });
    expect(young.silence).toEqual({
      d8to21: { fans: 0, lifetimeGrossMills: 0 },
      over21: { fans: 0, lifetimeGrossMills: 0 },
      unknown: { fans: 1, lifetimeGrossMills: 6_000 },
    });

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("dates the window in the caller's zone, by the zone's own name however Postgres would read it", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    const moscow = await report(narrowToken, PAGE, "windowDays=30&timeZone=Europe/Moscow");
    expect(moscow).toMatchObject({ timeZone: "Europe/Moscow", from: "2026-09-04", to: "2026-10-03" });
    // A's tip of 22:30Z on 3 September is 01:30 on 4 September in Moscow.
    expect(moscow.days[0]).toMatchObject({ date: "2026-09-04", grossMills: 3_000, purchaseCount: 2 });
    expect(moscow.totals.d30.grossMills).toBe(34_000);

    // East of the date line the day has already turned.
    const auckland = await report(narrowToken, PAGE, "timeZone=Pacific/Auckland");
    expect(auckland).toMatchObject({ timeZone: "Pacific/Auckland", from: "2026-09-05", to: "2026-10-04" });

    // Names a browser still sends and the hub's Postgres has no zone for (no
    // tzdata-legacy), or reads as a fixed offset (CET): the same answer as the
    // zone's primary name, never an error. Only Intl reads the name.
    for (const [legacy, primary] of [
      ["Europe/Kiev", "Europe/Kyiv"],
      ["Asia/Calcutta", "Asia/Kolkata"],
      ["US/Pacific", "America/Los_Angeles"],
      ["CET", "Europe/Brussels"],
    ] as const) {
      const fromLegacy = await report(narrowToken, PAGE, `timeZone=${legacy}`);
      expect(fromLegacy.timeZone).toBe(legacy);
      expect({ ...fromLegacy, timeZone: primary }, legacy).toEqual(await report(narrowToken, PAGE, `timeZone=${primary}`));
    }
    // Only the letter case is normalized.
    expect((await report(narrowToken, PAGE, "timeZone=europe/moscow")).timeZone).toBe("Europe/Moscow");

    // A name that is no zone: 400 with the reason, whatever it looks like. Never a 500.
    for (const zone of [
      "Mars/Olympus", "Moscow", "UTC+3", "GMT+3", "+03:00", "03:00", "Europe/Moscow;", "Europe/Moscow' or '1'='1",
      "Europe/Moscow/../UTC", "Factory", "localtime", "posixrules", "A/B/C", "x".repeat(64),
    ]) {
      expectRefused(
        await stats(narrowToken, PAGE, `timeZone=${encodeURIComponent(zone)}`), 400, "bad_request", "unknown_time_zone",
      );
    }

    // The request schema's own refusals (the validation envelope, no reason).
    for (const query of [
      "",
      "windowDays=30",
      "windowDays=7&timeZone=UTC",
      "windowDays=31&timeZone=UTC",
      "windowDays=thirty&timeZone=UTC",
      "timeZone=",
      `timeZone=${"x".repeat(65)}`,
      // The page is the path's; a page or an instant in the query is refused, not ignored.
      "timeZone=UTC&pageLabel=stats-other-of",
      "timeZone=UTC&asOf=2026-01-01T00:00:00Z",
    ]) {
      const response = await stats(narrowToken, PAGE, query);
      expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
      const error = errorResponseSchema.parse(response.json());
      expect(error.reason, query).toBeUndefined();
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reads silence from the messages a generation reads: the archive, and the union once the owner serves it", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();
    const archiveSilence = {
      d8to21: { fans: 2, lifetimeGrossMills: 712_000 },
      over21: { fans: 1, lifetimeGrossMills: 197_000 },
      unknown: { fans: 1, lifetimeGrossMills: 1_000 },
    };

    // B's last archived text is 10 days old. An hour ago the fan wrote again,
    // and so far only the webhook store has that message.
    await fixture.addDmMessage(pageIds[PAGE]!, { conversationRef: "1002", fromFan: true, at: "2026-10-03T11:00:00Z", text: "are you there?" });

    // `off` (the resting value): the archive serves a generation, and silence with it.
    expect((await report(narrowToken, PAGE)).silence).toEqual(archiveSilence);

    // `shadow`: the union is computed for comparison, the archive still serves.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await patchConfig([{ key: "aiTranscriptFreshUnionMode", value: "shadow" }]);
    const shadow = await report(narrowToken, PAGE);
    expect(shadow.asOf).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(shadow.silence).toEqual(archiveSilence);

    // `serve`: a generation reads the union, so B has just written and is not
    // silent. The switch is part of what an answer depends on: the answer kept
    // from a moment ago is not served in its place.
    await patchConfig([{ key: "aiTranscriptFreshUnionMode", value: "serve" }]);
    const served = await report(narrowToken, PAGE);
    expect(served.asOf).toBe(shadow.asOf);
    expect(served.silence).toEqual({
      d8to21: { fans: 1, lifetimeGrossMills: 700_000 },
      over21: { fans: 1, lifetimeGrossMills: 197_000 },
      unknown: { fans: 1, lifetimeGrossMills: 1_000 },
    });
    // Nothing else follows the switch.
    expect({ ...served, silence: archiveSilence }).toEqual(shadow);

    // Back to the archive at once when the owner rolls the switch back.
    await patchConfig([{ key: "aiTranscriptFreshUnionMode", value: "off" }]);
    expect((await report(narrowToken, PAGE)).silence).toEqual(archiveSilence);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps an answer for 60 seconds, shares it, and counts anew at once when a transaction lands", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

    const first = await report(narrowToken, PAGE);
    expect(first.asOf).toBe(NOW.toISOString());
    expect(first.queueSummary).toEqual({ total: 3, unknown: 1 });

    // We reply to A: A no longer waits. No transaction moved, so nothing tells
    // the cache; the kept answer is served, and `asOf` says how old it is.
    await db().pool.query(
      `update page_dm_threads set last_model_message_at = $1, last_message_at = $1, last_message_sender_role = 'model'
       where platform_account_id = $2 and platform_conversation_id = '1001'`,
      [at(10).toISOString(), pageIds[PAGE]],
    );
    vi.setSystemTime(at(30));
    expect(await report(narrowToken, PAGE)).toEqual(first);
    // The owner asks within the minute: the same kept answer, not a second count.
    expect(await report(ownerToken, PAGE)).toEqual(first);
    vi.setSystemTime(at(59));
    expect(await report(narrowToken, PAGE)).toEqual(first);

    // Another zone is another answer: counted now, and it sees the reply.
    const moscow = await report(narrowToken, PAGE, "timeZone=Europe/Moscow");
    expect(moscow.asOf).toBe(at(59).toISOString());
    expect(moscow.queueSummary).toEqual({ total: 2, unknown: 1 });

    // 60 seconds on, the answer is counted again.
    vi.setSystemTime(at(60));
    const second = await report(narrowToken, PAGE);
    expect(second.asOf).toBe(at(60).toISOString());
    expect(second.queueSummary).toEqual({ total: 2, unknown: 1 });
    expect(second.totals).toEqual(first.totals);

    // A purchase lands five seconds later: its writer rebuilds the spender
    // projection, the watermark moves, and the next answer has the money
    // without waiting out the minute.
    vi.setSystemTime(at(65));
    await fixture.addTransaction(pageIds[PAGE]!, { fanId: null, type: "tip", gross: 9_000n, at: at(64).toISOString() });
    await rebuildSpenderProjections(app.db, pageIds[PAGE]!, null, at(65));
    const third = await report(narrowToken, PAGE);
    expect(third.asOf).toBe(at(65).toISOString());
    expect(third.projectionAsOf).toBe(at(65).toISOString());
    expect(third.totals.d30.grossMills).toBe(first.totals.d30.grossMills + 9_000);
    expect(third.totals.today.grossMills).toBe(first.totals.today.grossMills + 9_000);

    // Callers that ask while an answer is being counted wait for that one count.
    // (Asked of the service with two different clocks: one count means one `asOf`.)
    vi.setSystemTime(at(200));
    const owner: HumanAuthPrincipal = {
      authMethod: "device_token",
      user: { id: ownerId, username: "owner", role: "owner", assignedPages: [], mustChangePassword: false },
      assignedPageIds: [],
    };
    const request = { headers: { "x-client-version": EXTENSION_VERSION } };
    const input = { pageLabel: PAGE, query: { windowDays: 30, timeZone: "UTC" } };
    const together = await Promise.all([
      getClientSpenderStats(app, request, owner, input, at(200)),
      getClientSpenderStats(app, request, owner, input, at(201)),
      getClientSpenderStats(app, request, owner, input, at(202)),
    ]);
    expect(new Set(together.map((answer) => answer.asOf)).size).toBe(1);
    expect(together[1]).toEqual(together[0]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("checks the caller on every request, before any kept answer", async (context) => {
    if (!server) return context.skip();
    await switchStatsOn();

    // An answer for the page is kept in this process.
    const kept = await report(narrowToken, PAGE);

    // A chatter of another page asks for the same page, zone and window.
    expectRefused(await stats(nikitaToken, PAGE, "windowDays=30&timeZone=UTC"), 409, "client_feature_disabled", "not_granted");
    // An outdated extension.
    expectRefused(
      await stats(narrowToken, PAGE, "windowDays=30&timeZone=UTC", { clientVersion: "chatgoose-extension/2.7.1" }),
      409, "client_feature_disabled", "client_outdated",
    );
    // The chatter loses the page.
    await unassignPageFromUser(app, { userId: grishaId, pageLabel: PAGE }, AUDIT);
    for (const token of [narrowToken, fullToken]) {
      expectRefused(await stats(token, PAGE, "windowDays=30&timeZone=UTC"), 409, "client_feature_disabled", "not_granted");
    }
    // The owner still reads the kept answer.
    expect(await report(ownerToken, PAGE)).toEqual(kept);

    // The owner switches Statistics off for this page only: it holds from the next request.
    await patchConfig([{
      key: "chatExtensionFeatures",
      value: JSON.stringify({ "*": { stats: true }, [PAGE]: { stats: false } }),
    }]);
    expectRefused(await stats(ownerToken, PAGE, "windowDays=30&timeZone=UTC"), 409, "client_feature_disabled", "flag_off");
    expect((await report(ownerToken, "stats-other-of")).pageLabel).toBe("stats-other-of");
    // And the master switch.
    await patchConfig([{ key: "chatExtensionEnabled", value: false }]);
    expectRefused(await stats(ownerToken, "stats-other-of", "windowDays=30&timeZone=UTC"), 409, "client_feature_disabled", "disabled");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is refused where the feature is not available, with the reason", async (context) => {
    if (!server) return context.skip();
    const query = "windowDays=30&timeZone=UTC";

    // The extension is on, the `stats` flag is not.
    await patchConfig([{ key: "chatExtensionEnabled", value: true }]);
    expectRefused(await stats(narrowToken, PAGE, query), 409, "client_feature_disabled", "flag_off");

    await patchConfig([
      { key: "chatExtensionFeatures", value: JSON.stringify({ "*": { stats: true } }) },
      { key: "chatExtensionMinVersion", value: "1.2.0" },
    ]);
    expect((await stats(narrowToken, PAGE, query, { clientVersion: "chat-extension/1.2.0" })).statusCode).toBe(200);
    // The feature exists on OnlyFans only; a page the extension cannot bind has no use for it.
    expectRefused(await stats(narrowToken, "stats-fansly", query), 409, "client_feature_disabled", "platform_unsupported");
    expectRefused(await stats(narrowToken, "nova-of", query), 409, "client_feature_disabled", "binding_missing");
    for (const clientVersion of ["chat-extension/1.1.9", "chatgoose-extension/2.7.1", "0.1.64", "chat-extension/1.2", null]) {
      expectRefused(await stats(narrowToken, PAGE, query, { clientVersion }), 409, "client_feature_disabled", "client_outdated");
    }
    // The page and the feature are checked before the query: a refused caller
    // learns nothing from a bad zone.
    expectRefused(await stats(narrowToken, "stats-fansly", "timeZone=Mars/Olympus"), 409, "client_feature_disabled", "platform_unsupported");
    expectRefused(await stats(nikitaToken, PAGE, "timeZone=Mars/Olympus"), 409, "client_feature_disabled", "not_granted");

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds its rights-matrix row in both auth-policy modes: device tokens on a granted page only", async (context) => {
    if (!server || !enforceServer) return context.skip();
    await switchStatsOn();

    const leadCookie = await loginCookie("lead");
    const chatterCookie = await loginCookie("grisha");

    interface Refusal { status: number; error: string; reason?: string }
    const notGranted = (enforce: Refusal) => ({
      log: { status: 409, error: "client_feature_disabled", reason: "not_granted" },
      enforce,
    });
    const cases: Array<{
      who: string;
      page: string;
      headers: Record<string, string>;
      /** 200, or the refusal; where the two layers answer differently, one per mode. */
      expected: 200 | Refusal | { log: Refusal; enforce: Refusal };
    }> = [
      { who: "anonymous", page: PAGE, headers: {}, expected: { status: 401, error: "unauthorized" } },
      {
        who: "unknown bearer", page: PAGE,
        headers: { authorization: "Bearer agency_hub_device_not-a-real-token" },
        expected: { status: 401, error: "unauthorized" },
      },
      { who: "owner cookie", page: PAGE, headers: { cookie: ownerCookie }, expected: { status: 403, error: "forbidden" } },
      { who: "team_lead cookie", page: PAGE, headers: { cookie: leadCookie }, expected: { status: 403, error: "forbidden" } },
      { who: "chatter cookie", page: PAGE, headers: { cookie: chatterCookie }, expected: { status: 403, error: "forbidden" } },
      // Live and granted the page: refused by kind, before any page is looked at.
      {
        who: "agent key", page: PAGE,
        headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` },
        expected: { status: 403, error: "forbidden" },
      },
      { who: "owner device token", page: "stats-other-of", headers: { authorization: `Bearer ${ownerToken}` }, expected: 200 },
      { who: "team_lead device token", page: PAGE, headers: { authorization: `Bearer ${leadToken}` }, expected: 200 },
      { who: "chatter narrow token", page: PAGE, headers: { authorization: `Bearer ${narrowToken}` }, expected: 200 },
      { who: "chatter full token", page: PAGE, headers: { authorization: `Bearer ${fullToken}` }, expected: 200 },
      // A page of someone else, a tombstone and a page that never existed: the
      // handler's own guard answers all three alike and reveals nothing; the
      // declared policy answers 403 / 404 before the handler runs.
      {
        who: "chatter, a page not granted", page: "stats-other-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: notGranted({ status: 403, error: "forbidden" }),
      },
      {
        who: "team_lead, a page not granted", page: "stats-other-of",
        headers: { authorization: `Bearer ${leadToken}` },
        expected: notGranted({ status: 403, error: "forbidden" }),
      },
      {
        who: "chatter, a tombstoned page", page: "stats-old-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: notGranted({ status: 404, error: "not_found" }),
      },
      {
        who: "chatter, a page that does not exist", page: "ghost-of",
        headers: { authorization: `Bearer ${narrowToken}` },
        expected: notGranted({ status: 404, error: "not_found" }),
      },
    ];

    for (const [mode, via] of [["log", server], ["enforce", enforceServer]] as const) {
      for (const testCase of cases) {
        const label = `${mode} mode, ${testCase.who}`;
        const response = await via.inject({
          method: "GET",
          url: statsUrl(testCase.page, "windowDays=30&timeZone=UTC"),
          headers: { "x-client-version": EXTENSION_VERSION, ...testCase.headers },
        });
        if (testCase.expected === 200) {
          expect(response.statusCode, `${label}: ${response.body}`).toBe(200);
          frozenClientSpenderStatsSchema.parse(response.json());
          continue;
        }
        const expected = "log" in testCase.expected ? testCase.expected[mode] : testCase.expected;
        expect(response.statusCode, `${label}: ${response.body}`).toBe(expected.status);
        // Every refusal is the declared error body, so the SDK raises a typed error.
        const error = errorResponseSchema.parse(response.json());
        expect(error, label).toMatchObject({ error: expected.error, statusCode: expected.status });
        expect(error.reason, label).toBe(expected.reason);
      }
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

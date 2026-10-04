import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_HEALTH_PERF_METRICS,
  adminClientHealthResponseSchema,
  errorResponseSchema,
  type AdminClientHealthResponse,
} from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, insertAgentKey } from "@agency_hub_core/db";
import { MOSCOW_TIME_ZONE, nextBusinessDate, previousBusinessDate, sha256Hex, toBusinessDate } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import {
  CLIENT_HEALTH_DOM_NODES_BOUNDS,
  CLIENT_HEALTH_FOOTPRINT_BOUNDS,
  intakeClientHealthReports,
} from "../apps/runtime/src/services/client-health-intake.ts";
import { clientHealthPercentile } from "../apps/runtime/src/services/client-health-perf.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// chat-extension H-11c: the owner's view over the hourly client_health rollups
// of H-11b. The reports are folded by the real intake at chosen instants, and
// read back through the route. The shaping alone (suppression, the footprint
// merge, the contract rows) is tests/client-health-view.test.ts.

const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", chatter: "chatter-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clienthealthview000`;
const ROLLUP_TABLES = [
  "client_health_receipts",
  "client_health_contract_hourly",
  "client_health_missing_hourly",
  "client_health_counters_hourly",
  "client_health_perf_hourly",
] as const;
const BUILD = "index-DEVowLko";
/** The Moscow day the fixtures are filed in: 2026-10-02T21:00Z … 2026-10-03T21:00Z. */
const DAY = "2026-10-03";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type Histogram = {
  metric: string; unit: "ms"; schemaVersion: number; bounds: number[]; counts: number[]; count: number; sum: number; max: number;
};

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/** authPolicyEnforcement "log" (the test default): the handler's own guards answer. */
let server: ApiServer | null = null;
/** authPolicyEnforcement "enforce": the declared policy answers before the handler. */
let enforceServer: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let pageId = 0;

function bucketsOf(bounds: readonly number[], samples: readonly number[]): number[] {
  const counts = Array.from({ length: bounds.length + 1 }, () => 0);
  for (const sample of samples) {
    const index = bounds.findIndex((bound) => sample <= bound);
    counts[index === -1 ? bounds.length : index]! += 1;
  }
  return counts;
}

/** A histogram on the registry's bounds, built the way the client builds one. */
function histogramFor(metric: keyof typeof CLIENT_HEALTH_PERF_METRICS, samples: number[]): Histogram {
  const entry = CLIENT_HEALTH_PERF_METRICS[metric];
  return {
    metric,
    unit: entry.unit,
    schemaVersion: entry.schemaVersion,
    bounds: [...entry.bounds],
    counts: bucketsOf(entry.bounds, samples),
    count: samples.length,
    sum: Math.round(samples.reduce((total, sample) => total + sample, 0) * 1000) / 1000,
    max: samples.length === 0 ? 0 : Math.max(...samples),
  };
}

/** A report body as the extension builds it (its `kind` rides the envelope). */
function healthReport(overrides: {
  version?: string;
  build?: string | null;
  contractOk?: boolean;
  missing?: string[];
  perf?: Histogram[];
  counters?: Record<string, number>;
  cachesKB?: number;
  logsKB?: number;
} = {}): Record<string, unknown> {
  return {
    v: 1,
    window: { from: "2026-10-03T10:00:00.123Z", to: "2026-10-03T10:15:00.456Z" },
    client: { name: "chat-extension", version: overrides.version ?? "1.4.2", browser: "firefox", browserMajor: 157, os: "windows" },
    host: {
      kind: "chatspace",
      build: overrides.build === undefined ? BUILD : overrides.build,
      contractOk: overrides.contractOk ?? true,
      missing: overrides.missing ?? [],
    },
    disabled: ["previewSend"],
    perf: overrides.perf ?? [],
    counters: overrides.counters ?? {},
    footprint: { kind: "owned-estimate", cachesKB: overrides.cachesKB ?? 420, logsKB: overrides.logsKB ?? 900 },
  };
}

/** The intake called as the capture lane calls it, at a chosen instant. */
async function fold(receivedAt: string, ...reports: Array<Record<string, unknown>>) {
  const events = reports.map((payload) => ({ clientEventId: randomUUID(), payload }));
  const result = await app.db.transaction((tx) => intakeClientHealthReports(app, tx, {
    events,
    enabled: true,
    receivedAt: new Date(receivedAt),
  }));
  expect(result).toEqual({ accepted: reports.length, duplicates: 0 });
}

function viewRequest(query: Record<string, string>, headers: Record<string, string>, via: ApiServer = server!) {
  return via.inject({ method: "GET", url: "/api/v1/admin/client-health", query, headers });
}

async function view(query: Record<string, string>): Promise<AdminClientHealthResponse> {
  const response = await viewRequest(query, { cookie: ownerCookie });
  expect(response.statusCode, response.body).toBe(200);
  return adminClientHealthResponseSchema.parse(response.json());
}

async function loginCookie(username: string, password: string): Promise<string> {
  const login = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

/** Every stored rollup row, as text: a read that wrote anything changes it. */
async function storedRollups(): Promise<Record<string, string[]>> {
  const stored: Record<string, string[]> = {};
  for (const table of ROLLUP_TABLES) {
    stored[table] = (await testDb!.pool.query<{ row: string }>(
      `select t::text as row from ${table} t order by 1`,
    )).rows.map((entry) => entry.row);
  }
  return stored;
}

async function journaled(): Promise<number> {
  return (await testDb!.pool.query<{ n: number }>("select count(*)::int as n from observations")).rows[0]!.n;
}

const range = (count: number, from: number, step: number) => Array.from({ length: count }, (_, index) => from + index * step);

describe("GET /api/v1/admin/client-health (H-11c)", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    await setUserPassword(app, { userId: await fixtureUserId(app, "grisha"), password: PASSWORDS.chatter }, AUDIT);

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(app.db, { modelId: lora!.id, label: "lora-of" });
    pageId = page!.id;
    await testDb.pool.query(`update pages set external_page_id = '100000001' where id = $1`, [pageId]);
    await assignPageToUser(app, { userId: await fixtureUserId(app, "grisha"), pageLabel: "lora-of" }, AUDIT);

    server = await buildApiServer(app);
    await server.ready();
    enforceServer = await buildApiServer(createTestAppContext(testDb, { authPolicyEnforcement: "enforce" }));
    await enforceServer.ready();
    ownerCookie = await loginCookie("owner", PASSWORDS.owner);
    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
    await enforceServer?.close();
    enforceServer = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("reads the hours of the asked Moscow days, merged, and writes nothing", async (context) => {
    if (!server) return context.skip();

    // Three reports inside the day: its first hour, noon, its last second.
    const first = range(10, 5, 3); // 5 … 32 ms
    const noon = range(10, 40, 9); // 40 … 121 ms
    const last = [3, 7, 260, 480, 1400];
    await fold("2026-10-02T21:00:00.000Z", healthReport({
      perf: [histogramFor("insertMs", first), histogramFor("panelOpenMs", [30, 31])],
      counters: { "p1.insert-misplaced": 0, "error.CG-NET-TIMEOUT": 2, "footprint.dom-nodes-max": 5200 },
    }));
    await fold("2026-10-03T09:10:00.000Z", healthReport({
      perf: [histogramFor("insertMs", noon)],
      contractOk: false,
      missing: ["composer.editor", "chat.list"],
      counters: { "p1.insert-misplaced": 1, "error.CG-NET-TIMEOUT": 3 },
    }));
    await fold("2026-10-03T20:59:59.999Z", healthReport({
      perf: [histogramFor("insertMs", last)],
      contractOk: false,
      missing: ["composer.editor"],
    }), healthReport({ build: null, version: "1.4.1" }));
    // The neighbouring days: the second before, and the first instant after.
    await fold("2026-10-02T20:59:59.999Z", healthReport({
      perf: [histogramFor("insertMs", [900, 950])],
      counters: { "error.CG-NET-TIMEOUT": 100 },
    }));
    await fold("2026-10-03T21:00:00.000Z", healthReport({
      perf: [histogramFor("insertMs", [800])],
      contractOk: false,
      missing: ["chat.header"],
      counters: { "error.CG-NET-TIMEOUT": 1000 },
    }));

    const before = await storedRollups();
    const journaledBefore = await journaled();
    const day = await view({ from: DAY, to: DAY });

    expect(day.range).toEqual({ from: DAY, to: DAY, timeZone: "Europe/Moscow" });
    expect(day.minGroupSize).toBe(20);
    expect(Number.isNaN(Date.parse(day.asOf))).toBe(false);

    const samples = [...first, ...noon, ...last];
    const { bounds } = CLIENT_HEALTH_PERF_METRICS.insertMs;
    const merged = { bounds, counts: bucketsOf(bounds, samples), max: 1400 };
    expect(day.perf).toEqual([
      {
        clientName: "chat-extension",
        clientVersion: "1.4.2",
        hostKind: "chatspace",
        hostBuild: BUILD,
        metric: "insertMs",
        schemaVersion: 1,
        count: 25,
        mean: samples.reduce((total, sample) => total + sample, 0) / 25,
        max: 1400,
        p50: clientHealthPercentile(merged, 0.5),
        p95: clientHealthPercentile(merged, 0.95),
        suppressed: false,
      },
      {
        clientName: "chat-extension",
        clientVersion: "1.4.2",
        hostKind: "chatspace",
        hostBuild: BUILD,
        metric: "panelOpenMs",
        schemaVersion: 1,
        count: 2,
        mean: null,
        max: null,
        p50: null,
        p95: null,
        suppressed: true,
      },
    ]);
    // A percentile of the day's own buckets: the 900 ms of the day before would have moved it.
    expect(day.perf[0]!.p50).toBeLessThan(50);

    expect(day.contract).toEqual([
      { clientVersion: "1.4.1", hostBuild: null, reports: 1, failedReports: 0, missing: [] },
      {
        clientVersion: "1.4.2",
        hostBuild: BUILD,
        reports: 3,
        failedReports: 2,
        missing: [{ anchor: "composer.editor", reports: 2 }, { anchor: "chat.list", reports: 1 }],
      },
    ]);
    // The node count is a level: never among the counters.
    expect(day.counters).toEqual([
      { code: "error.CG-NET-TIMEOUT", total: 5 },
      { code: "p1.insert-misplaced", total: 1 },
    ]);
    // Four reports carried the sizes, one the node count: under the minimum, so no percentile of them.
    expect(day.footprint).toEqual([
      { clientVersion: "1.4.1", cachesKBp95: null, logsKBp95: null, domNodesP95: null },
      { clientVersion: "1.4.2", cachesKBp95: null, logsKBp95: null, domNodesP95: null },
    ]);

    // The day after holds only its own report, the day before only its own.
    const after = await view({ from: "2026-10-04", to: "2026-10-04" });
    expect(after.contract).toEqual([{
      clientVersion: "1.4.2", hostBuild: BUILD, reports: 1, failedReports: 1, missing: [{ anchor: "chat.header", reports: 1 }],
    }]);
    expect(after.counters).toEqual([{ code: "error.CG-NET-TIMEOUT", total: 1000 }]);
    expect(after.perf.map((row) => [row.metric, row.count])).toEqual([["insertMs", 1]]);
    const earlier = await view({ from: "2026-10-02", to: "2026-10-02" });
    expect(earlier.counters).toEqual([{ code: "error.CG-NET-TIMEOUT", total: 100 }]);

    // All three days: every report once.
    const all = await view({ from: "2026-10-02", to: "2026-10-04" });
    expect(all.contract.find((row) => row.hostBuild === BUILD)).toMatchObject({ reports: 5, failedReports: 3 });
    expect(all.perf.find((row) => row.metric === "insertMs")).toMatchObject({ count: 28, max: 1400 });
    expect(all.counters).toEqual([
      { code: "error.CG-NET-TIMEOUT", total: 1105 },
      { code: "p1.insert-misplaced", total: 1 },
    ]);
    // A day with no report at all.
    expect(await view({ from: "2026-09-01", to: "2026-09-30" }))
      .toMatchObject({ perf: [], contract: [], counters: [], footprint: [] });

    // Five reads later: the rollups as they were, and nothing journaled.
    expect(await storedRollups()).toEqual(before);
    expect(await journaled()).toBe(journaledBefore);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shows a group's figures from its twentieth observation on, and its size before", async (context) => {
    if (!server) return context.skip();

    // 19 observations of one metric, over two hours and two reports.
    await fold("2026-10-03T08:00:00.000Z", healthReport({ perf: [histogramFor("boardOpenMs", range(10, 20, 4))] }));
    await fold("2026-10-03T09:00:00.000Z", healthReport({ perf: [histogramFor("boardOpenMs", range(9, 700, 1))] }));

    const under = await view({ from: DAY, to: DAY });
    expect(under.perf).toEqual([expect.objectContaining({
      metric: "boardOpenMs", count: 19, mean: null, max: null, p50: null, p95: null, suppressed: true,
    })]);
    // No sample of the group is anywhere in the answer.
    expect(JSON.stringify(under.perf)).not.toMatch(/70[0-8]/);

    await fold("2026-10-03T09:30:00.000Z", healthReport({ perf: [histogramFor("boardOpenMs", [640])] }));
    const [shown] = (await view({ from: DAY, to: DAY })).perf;
    expect(shown).toMatchObject({ metric: "boardOpenMs", count: 20, max: 708, suppressed: false });
    expect(shown!.p50).not.toBeNull();
    expect(shown!.p95).toBeGreaterThan(500);

    // The footprint: 3 reports so far. Seventeen more of the same version on another build make 20.
    expect((await view({ from: DAY, to: DAY })).footprint)
      .toEqual([{ clientVersion: "1.4.2", cachesKBp95: null, logsKBp95: null, domNodesP95: null }]);
    const sizes = range(17, 1000, 500);
    await fold("2026-10-03T10:00:00.000Z", ...sizes.map((cachesKB) => healthReport({
      build: "index-Bq81xZ0a",
      cachesKB,
      logsKB: 70,
      counters: { "footprint.dom-nodes-max": cachesKB * 2 },
    })));
    const [footprint] = (await view({ from: DAY, to: DAY })).footprint;
    const caches = [420, 420, 420, ...sizes];
    expect(footprint).toEqual({
      clientVersion: "1.4.2",
      cachesKBp95: clientHealthPercentile({
        bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS, counts: bucketsOf(CLIENT_HEALTH_FOOTPRINT_BOUNDS, caches), max: 9000,
      }, 0.95),
      logsKBp95: clientHealthPercentile({
        bounds: CLIENT_HEALTH_FOOTPRINT_BOUNDS,
        counts: bucketsOf(CLIENT_HEALTH_FOOTPRINT_BOUNDS, [900, 900, 900, ...sizes.map(() => 70)]),
        max: 900,
      }, 0.95),
      // Seventeen reports carried the node count: still under the minimum.
      domNodesP95: null,
    });
    expect(footprint!.cachesKBp95).toBeGreaterThan(8192);

    // Three more reports with a node count: twenty.
    await fold("2026-10-03T11:00:00.000Z", ...[2100, 2200, 2300].map((nodes) => healthReport({
      counters: { "footprint.dom-nodes-max": nodes },
    })));
    const nodes = [...sizes.map((size) => size * 2), 2100, 2200, 2300];
    expect((await view({ from: DAY, to: DAY })).footprint[0]!.domNodesP95).toBe(clientHealthPercentile({
      bounds: CLIENT_HEALTH_DOM_NODES_BOUNDS, counts: bucketsOf(CLIENT_HEALTH_DOM_NODES_BOUNDS, nodes), max: 18_000,
    }, 0.95));
    // The levels are footprint rows, never perf rows.
    expect((await view({ from: DAY, to: DAY })).perf.map((row) => row.metric)).toEqual(["boardOpenMs"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("narrows by client and by metric", async (context) => {
    if (!server) return context.skip();

    await fold("2026-10-03T08:00:00.000Z", healthReport({
      perf: [histogramFor("insertMs", range(20, 10, 2)), histogramFor("panelOpenMs", range(20, 10, 2))],
      counters: { "p1.insert-misplaced": 1 },
    }));
    // The report schema names one client today; a row of another is written the way a later intake would.
    await testDb!.pool.query(
      `insert into client_health_contract_hourly (hour, client_name, client_version, host_kind, host_build, reports, failed_reports)
       values ('2026-10-03T08:00:00Z', 'other-client', '9.9.9', 'chatspace', 'index-Zz', 4, 1)`,
    );
    await testDb!.pool.query(
      `insert into client_health_counters_hourly (hour, client_name, client_version, host_kind, host_build, code, total)
       values ('2026-10-03T08:00:00Z', 'other-client', '9.9.9', 'chatspace', 'index-Zz', 'p1.insert-misplaced', 40)`,
    );

    const everyone = await view({ from: DAY, to: DAY });
    expect(everyone.contract.map((row) => [row.clientVersion, row.reports])).toEqual([["1.4.2", 1], ["9.9.9", 4]]);
    expect(everyone.counters).toEqual([{ code: "p1.insert-misplaced", total: 41 }]);

    const extension = await view({ from: DAY, to: DAY, clientName: "chat-extension" });
    expect(extension.contract.map((row) => [row.clientVersion, row.reports])).toEqual([["1.4.2", 1]]);
    expect(extension.counters).toEqual([{ code: "p1.insert-misplaced", total: 1 }]);
    expect(extension.perf.map((row) => row.metric)).toEqual(["insertMs", "panelOpenMs"]);

    const other = await view({ from: DAY, to: DAY, clientName: "other-client" });
    expect(other.contract).toEqual([{ clientVersion: "9.9.9", hostBuild: "index-Zz", reports: 4, failedReports: 1, missing: [] }]);
    expect(other.counters).toEqual([{ code: "p1.insert-misplaced", total: 40 }]);
    expect(other).toMatchObject({ perf: [], footprint: [] });
    expect(await view({ from: DAY, to: DAY, clientName: "nobody" }))
      .toMatchObject({ perf: [], contract: [], counters: [], footprint: [] });

    // A metric narrows the perf rows alone.
    const insert = await view({ from: DAY, to: DAY, metric: "insertMs" });
    expect(insert.perf.map((row) => row.metric)).toEqual(["insertMs"]);
    expect(insert.contract).toEqual(everyone.contract);
    expect(insert.counters).toEqual(everyone.counters);
    expect(insert.footprint).toEqual(everyone.footprint);
    expect((await view({ from: DAY, to: DAY, metric: "footprint.cachesKB" })).perf).toEqual([]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("is the owner's cookie session only, in both auth-policy modes", async (context) => {
    if (!server || !enforceServer) return context.skip();

    const ownerId = await fixtureUserId(app, "owner");
    const chatterId = await fixtureUserId(app, "grisha");
    const ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": EXTENSION_VERSION },
      payload: {
        username: "grisha", password: PASSWORDS.chatter, label: "Firefox · Windows · ChatSpace", mode: "active", client: "chat-extension",
      },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const narrowToken = signIn.json<{ token: string }>().token;
    const fullToken = (await issueDeviceTokenForUserId(app, { userId: chatterId, label: "chatter client" })).token;
    await insertAgentKey(app.db, {
      name: "client-health-view-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:messages"],
      pageIds: [pageId],
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });
    const cookies = {
      lead: await loginCookie("lead", PASSWORDS.lead),
      chatter: await loginCookie("grisha", PASSWORDS.chatter),
    };

    const cases: Array<{ who: string; headers: Record<string, string>; status: number }> = [
      { who: "anonymous", headers: {}, status: 401 },
      { who: "unknown bearer", headers: { authorization: "Bearer agency_hub_device_not-a-real-token" }, status: 401 },
      { who: "owner cookie", headers: { cookie: ownerCookie }, status: 200 },
      { who: "team_lead cookie", headers: { cookie: cookies.lead }, status: 403 },
      { who: "chatter cookie", headers: { cookie: cookies.chatter }, status: 403 },
      { who: "owner device token", headers: { authorization: `Bearer ${ownerToken}` }, status: 403 },
      { who: "chatter device token", headers: { authorization: `Bearer ${fullToken}` }, status: 403 },
      {
        who: "chat-extension token",
        headers: { authorization: `Bearer ${narrowToken}`, "x-client-version": EXTENSION_VERSION },
        status: 403,
      },
      { who: "agent key", headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` }, status: 403 },
    ];
    for (const [mode, via] of [["log", server], ["enforce", enforceServer]] as const) {
      for (const testCase of cases) {
        const label = `${mode} mode, ${testCase.who}`;
        const response = await viewRequest({ from: DAY, to: DAY }, testCase.headers, via);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(testCase.status);
        if (testCase.status === 200) {
          adminClientHealthResponseSchema.parse(response.json());
          continue;
        }
        const error = errorResponseSchema.safeParse(response.json());
        expect(error.success, `${label}: ${response.body}`).toBe(true);
        expect(error.data?.error, label).toBe(testCase.status === 401 ? "unauthorized" : "forbidden");
      }
    }

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses a range it cannot read with 400", async (context) => {
    if (!server) return context.skip();

    for (const query of [
      {},
      { from: DAY },
      { to: DAY },
      { from: "2026-10-04", to: "2026-10-03" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2025-10-02", to: "2026-10-03" },
      { from: DAY, to: DAY, userId: "7" },
      { from: DAY, to: DAY, clientName: "" },
    ] as Array<Record<string, string>>) {
      const response = await viewRequest(query, { cookie: ownerCookie });
      expect(response.statusCode, `${JSON.stringify(query)}: ${response.body}`).toBe(400);
      expect(errorResponseSchema.safeParse(response.json()).success, response.body).toBe(true);
    }
    // The longest range it does read: a year of days.
    expect((await viewRequest({ from: "2025-10-03", to: "2026-10-03" }, { cookie: ownerCookie })).statusCode).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("shows a report sent on the capture lane, and nothing of who sent it", async (context) => {
    if (!server) return context.skip();

    const patch = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/config",
      headers: { cookie: ownerCookie },
      payload: { patches: [{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }] },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const signIn = await server.inject({
      method: "POST",
      url: "/api/v1/auth/device-tokens/password",
      headers: { "x-client-version": EXTENSION_VERSION },
      payload: {
        username: "grisha", password: PASSWORDS.chatter, label: "Firefox · Windows · ChatSpace", mode: "active", client: "chat-extension",
      },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const sent = await server.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: { authorization: `Bearer ${signIn.json<{ token: string }>().token}`, "x-client-version": EXTENSION_VERSION },
      payload: {
        events: [{
          clientEventId: randomUUID(),
          kind: "client_health",
          observedAt: new Date().toISOString(),
          payload: healthReport({
            perf: [histogramFor("insertMs", range(24, 10, 2))],
            contractOk: false,
            missing: ["composer.editor"],
            counters: { "p1.insert-misplaced": 1 },
          }),
        }],
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toEqual({ accepted: 1, duplicates: 0 });

    // The hub files the report under the hour it received it: today, give or take a midnight during the test.
    const today = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
    const response = await viewRequest({ from: previousBusinessDate(today), to: nextBusinessDate(today) }, { cookie: ownerCookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = adminClientHealthResponseSchema.parse(response.json());
    expect(body.contract).toEqual([{
      clientVersion: "1.4.2", hostBuild: BUILD, reports: 1, failedReports: 1, missing: [{ anchor: "composer.editor", reports: 1 }],
    }]);
    expect(body.perf).toEqual([expect.objectContaining({ metric: "insertMs", count: 24, max: 56, suppressed: false })]);
    expect(body.counters).toEqual([{ code: "p1.insert-misplaced", total: 1 }]);

    // The answer as served: no person, page or device in it.
    expect(response.body).not.toMatch(/grisha|lora-of|100000001|Firefox|userId|username|"latest"/);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort())
      .toEqual(["asOf", "contract", "counters", "footprint", "minGroupSize", "perf", "range"]);

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

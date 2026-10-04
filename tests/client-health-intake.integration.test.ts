import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_HEALTH_PERF_METRICS,
  clientBootstrapResponseSchema,
  clientHealthReportV1Schema,
  type ClientBootstrapResponse,
} from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount, setUserPassword } from "../apps/runtime/src/services/auth.ts";
import {
  CLIENT_HEALTH_FOOTPRINT_BOUNDS,
  intakeClientHealthReports,
} from "../apps/runtime/src/services/client-health-intake.ts";
import { clientHealthP50P95 } from "../apps/runtime/src/services/client-health-perf.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// chat-extension H-11b, storage variant B′: the capture lane folds a
// `client_health` report into hourly rollups that hold no user and never
// journals it. The pure half (grouping, the fold, the histogram checks, the
// migration's shape) is tests/client-health-intake.test.ts.

const PASSWORDS = { owner: "owner-secret", chatter: "chatter-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
const ROLLUP_TABLES = [
  "client_health_receipts",
  "client_health_contract_hourly",
  "client_health_missing_hourly",
  "client_health_counters_hourly",
  "client_health_perf_hourly",
] as const;
const GROUP = { client_name: "chat-extension", client_version: "1.4.2", host_kind: "chatspace", host_build: "index-DEVowLko" };

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type Histogram = {
  metric: string; unit: "ms"; schemaVersion: number; bounds: number[]; counts: number[]; count: number; sum: number; max: number;
};

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerCookie = "";
let narrowToken = "";
let fullToken = "";
let secondChatterToken = "";
let chatterId = 0;

/** A histogram on the registry's bounds, built the way the client builds one. */
function histogramFor(metric: keyof typeof CLIENT_HEALTH_PERF_METRICS, samples: number[]): Histogram {
  const entry = CLIENT_HEALTH_PERF_METRICS[metric];
  const bounds = [...entry.bounds];
  const counts: number[] = Array.from({ length: bounds.length + 1 }, () => 0);
  for (const sample of samples) {
    const index = bounds.findIndex((bound) => sample <= bound);
    counts[index === -1 ? bounds.length : index]! += 1;
  }
  return {
    metric,
    unit: entry.unit,
    schemaVersion: entry.schemaVersion,
    bounds,
    counts,
    count: samples.length,
    sum: samples.reduce((total, sample) => total + sample, 0),
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
      build: overrides.build === undefined ? "index-DEVowLko" : overrides.build,
      contractOk: overrides.contractOk ?? true,
      missing: overrides.missing ?? [],
    },
    disabled: ["previewSend"],
    perf: overrides.perf ?? [],
    counters: overrides.counters ?? {},
    footprint: { kind: "owned-estimate", cachesKB: overrides.cachesKB ?? 420, logsKB: overrides.logsKB ?? 900 },
  };
}

function healthEvent(payload: Record<string, unknown>, clientEventId: string = randomUUID()) {
  return { clientEventId, kind: "client_health", observedAt: "2026-10-03T10:15:00.456Z", payload };
}

function acceptanceEvent(clientEventId: string = randomUUID()) {
  return {
    clientEventId,
    kind: "ai_acceptance",
    observedAt: "2026-10-03T12:00:00.000Z",
    payload: { generationRef: randomUUID(), lifecycle: "inserted" },
    pageLabel: "lora-of",
  };
}

async function ingest(token: string, events: unknown[], clientVersion: string = EXTENSION_VERSION) {
  return server!.inject({
    method: "POST",
    url: "/api/v1/ingest/observations",
    headers: { authorization: `Bearer ${token}`, "x-client-version": clientVersion },
    payload: { events },
  });
}

async function ingestOk(token: string, events: unknown[], clientVersion?: string) {
  const response = await ingest(token, events, clientVersion);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ accepted: number; duplicates: number }>();
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

async function bootstrap(token: string): Promise<ClientBootstrapResponse> {
  const response = await server!.inject({
    method: "GET",
    url: "/api/v1/client/bootstrap",
    headers: { authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION },
  });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json());
}

async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ROLLUP_TABLES) {
    counts[table] = Number((await testDb!.pool.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n);
  }
  return counts;
}

const NOTHING_KEPT = Object.fromEntries(ROLLUP_TABLES.map((table) => [table, 0]));

async function journal() {
  return (await testDb!.pool.query<{ producer: string; kind: string }>(
    "select producer, kind from observations where source = 'client_capture' order by id",
  )).rows;
}

/** Rollups summed over hours: a test that runs across the top of an hour reads the same totals. */
async function contractTotals() {
  return (await testDb!.pool.query(
    `select client_name, client_version, host_kind, host_build,
            sum(reports)::int as reports, sum(failed_reports)::int as failed_reports
       from client_health_contract_hourly
      group by 1, 2, 3, 4
      order by client_name collate "C", client_version collate "C", host_kind collate "C", host_build collate "C"`,
  )).rows;
}

async function counterTotals() {
  return (await testDb!.pool.query<{ client_version: string; code: string; total: number }>(
    `select client_version, code, sum(total)::int as total
       from client_health_counters_hourly group by 1, 2 order by client_version collate "C", code collate "C"`,
  )).rows;
}

async function missingTotals() {
  return (await testDb!.pool.query<{ anchor: string; reports: number }>(
    `select anchor, sum(reports)::int as reports from client_health_missing_hourly group by 1 order by anchor collate "C"`,
  )).rows;
}

interface PerfRow {
  hour: Date;
  client_version: string;
  host_build: string;
  metric: string;
  schema_version: number;
  unit: string;
  bounds: number[];
  counts: number[];
  count: number;
  sum: number;
  max: number;
}

async function perfRows(metric?: string): Promise<PerfRow[]> {
  const rows = await testDb!.pool.query<Omit<PerfRow, "counts" | "count"> & { counts: string[]; count: string }>(
    `select hour, client_version, host_build, metric, schema_version, unit, bounds, counts, count, sum, max
       from client_health_perf_hourly
      where $1::text is null or metric = $1
      order by hour, client_version collate "C", host_build collate "C", metric collate "C", schema_version`,
    [metric ?? null],
  );
  return rows.rows.map((row) => ({ ...row, counts: row.counts.map(Number), count: Number(row.count) }));
}

/** The intake called as the capture lane calls it, at a chosen instant. */
async function intakeAt(receivedAt: Date, events: Array<{ clientEventId: string; payload: Record<string, unknown> }>) {
  return app.db.transaction((tx) => intakeClientHealthReports(app, tx, { events, enabled: true, receivedAt }));
}

describe("client_health intake (H-11b)", () => {
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
    for (const username of ["grisha", "masha"]) {
      await createUserAccount(app, { username, role: "chatter" }, AUDIT);
      const userId = await fixtureUserId(app, username);
      await setUserPassword(app, { userId, password: PASSWORDS.chatter }, AUDIT);
    }
    chatterId = await fixtureUserId(app, "grisha");

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const page = await createOnlyFansPage(app.db, { modelId: lora!.id, label: "lora-of" });
    await testDb.pool.query(`update pages set external_page_id = '100000001' where id = $1`, [page!.id]);
    for (const userId of [chatterId, await fixtureUserId(app, "masha")]) {
      await assignPageToUser(app, { userId, pageLabel: "lora-of" }, AUDIT);
    }

    server = await buildApiServer(app);
    await server.ready();

    const signIn = async (username: string, body: Record<string, unknown>, clientVersion: string) => {
      const response = await server!.inject({
        method: "POST",
        url: "/api/v1/auth/device-tokens/password",
        headers: { "x-client-version": clientVersion },
        payload: { username, password: PASSWORDS.chatter, label: "Firefox · Windows · ChatSpace", mode: "active", ...body },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ token: string }>().token;
    };
    narrowToken = await signIn("grisha", { client: "chat-extension" }, EXTENSION_VERSION);
    fullToken = await signIn("grisha", {}, "2.7.1");
    secondChatterToken = await signIn("masha", { client: "chat-extension" }, EXTENSION_VERSION);

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: PASSWORDS.owner },
    });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    ownerCookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
    trap = await armNoOutboundTrap(testDb);
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("switch off: a report is accepted, nothing is kept and the bootstrap does not list the capability", async (context) => {
    if (!server) return context.skip();

    const report = healthReport({ perf: [histogramFor("insertMs", [10, 40, 90])], counters: { "p1.insert-misplaced": 1 } });
    // At rest every switch is off.
    expect((await bootstrap(narrowToken)).capabilities).not.toContain("client-health-perf-v1");
    expect(await ingestOk(narrowToken, [healthEvent(report)])).toEqual({ accepted: 1, duplicates: 0 });
    // A full token of the same person: the kind is not journaled as desktop.unknown either.
    expect(await ingestOk(fullToken, [healthEvent(report)], "2.7.1")).toEqual({ accepted: 1, duplicates: 0 });

    // The health switch alone, with the master switch off, keeps nothing: the master switch turns everything off.
    await patchConfig([{ key: "chatExtensionHealthIngestEnabled", value: true }]);
    expect((await bootstrap(narrowToken)).capabilities).not.toContain("client-health-perf-v1");
    expect(await ingestOk(narrowToken, [healthEvent(report)])).toEqual({ accepted: 1, duplicates: 0 });

    // The master switch alone keeps nothing either.
    await patchConfig([{ key: "chatExtensionHealthIngestEnabled", value: false }, { key: "chatExtensionEnabled", value: true }]);
    expect((await bootstrap(narrowToken)).capabilities).not.toContain("client-health-perf-v1");
    // Not even a malformed report is read while the switch is off.
    expect(await ingestOk(narrowToken, [healthEvent(report), healthEvent({ v: 2 })])).toEqual({ accepted: 2, duplicates: 0 });

    expect(await tableCounts()).toEqual(NOTHING_KEPT);
    expect(await journal()).toEqual([]);
    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a mixed batch: acceptance is journaled as before, the health report is folded and never journaled", async (context) => {
    if (!server) return context.skip();

    const before = await bootstrap(narrowToken);
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }]);
    const after = await bootstrap(narrowToken);
    expect(after.capabilities).toContain("client-health-perf-v1");
    expect(after.configRevision).toBeGreaterThan(before.configRevision);

    const insert = histogramFor("insertMs", [10, 40, 90]);
    const report = healthReport({
      contractOk: false,
      missing: ["fansMap"],
      perf: [insert, histogramFor("routeToDockMs", [3])],
      counters: { "CG-SEND-UNCERTAIN": 2, "p1.insert-misplaced": 0, constructor: 3 },
    });
    // The client's own schema of the report holds.
    expect(clientHealthReportV1Schema.safeParse(report).success).toBe(true);
    expect(await ingestOk(narrowToken, [acceptanceEvent(), healthEvent(report), acceptanceEvent()]))
      .toEqual({ accepted: 3, duplicates: 0 });

    // The journal holds the acceptance events as before and no trace of the report.
    expect(await journal()).toEqual([
      { producer: "chat-extension@1.4.2", kind: "desktop.ai_acceptance" },
      { producer: "chat-extension@1.4.2", kind: "desktop.ai_acceptance" },
    ]);
    const anywhere = await testDb!.pool.query(
      "select 1 from observations where kind like '%client_health%' or payload::text like '%owned-estimate%'",
    );
    expect(anywhere.rowCount).toBe(0);

    expect(await tableCounts()).toEqual({
      client_health_receipts: 1,
      client_health_contract_hourly: 1,
      client_health_missing_hourly: 1,
      client_health_counters_hourly: 3,
      // insertMs, routeToDockMs and the two footprint sizes.
      client_health_perf_hourly: 4,
    });
    expect(await contractTotals()).toEqual([{ ...GROUP, reports: 1, failed_reports: 1 }]);
    expect(await missingTotals()).toEqual([{ anchor: "fansMap", reports: 1 }]);
    expect(await counterTotals()).toEqual([
      { client_version: "1.4.2", code: "CG-SEND-UNCERTAIN", total: 2 },
      { client_version: "1.4.2", code: "constructor", total: 3 },
      { client_version: "1.4.2", code: "p1.insert-misplaced", total: 0 },
    ]);
    const [stored] = await perfRows("insertMs");
    expect(stored).toMatchObject({
      client_version: "1.4.2", host_build: "index-DEVowLko", schema_version: 1, unit: "ms",
      bounds: insert.bounds, counts: insert.counts, count: 3, sum: 140, max: 90,
    });
    // Filed under the hour the HUB received it (this hour), not the client's window of 3 October.
    const sinceReceived = Date.now() - stored!.hour.getTime();
    expect(sinceReceived).toBeGreaterThanOrEqual(0);
    expect(sinceReceived).toBeLessThan(2 * 3_600_000);
    expect(stored!.hour.getTime() % 3_600_000).toBe(0);
    const [caches] = await perfRows("footprint.cachesKB");
    expect(caches).toMatchObject({ unit: "KB", bounds: [...CLIENT_HEALTH_FOOTPRINT_BOUNDS], count: 1, sum: 420, max: 420 });

    // The receipt is the client event id and the hour, nothing of the sender.
    const receipt = await testDb!.pool.query<{ received_hour: Date }>("select received_hour from client_health_receipts");
    expect(receipt.rows[0]!.received_hour.getTime()).toBe(stored!.hour.getTime());

    await trap!.assertNoOutbound();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("holds no column that names a person, a page, a fan or a device", async (context) => {
    if (!server) return context.skip();

    const columns = await testDb!.pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = any($1) order by table_name, ordinal_position`,
      [[...ROLLUP_TABLES]],
    );
    const group = ["hour", "client_name", "client_version", "host_kind", "host_build"];
    const byTable = Object.fromEntries(ROLLUP_TABLES.map((table) => [
      table,
      columns.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
    ]));
    expect(byTable).toEqual({
      client_health_receipts: ["client_event_id", "received_hour"],
      client_health_contract_hourly: [...group, "reports", "failed_reports"],
      client_health_missing_hourly: [...group, "anchor", "reports"],
      client_health_counters_hourly: [...group, "code", "total"],
      client_health_perf_hourly: [...group, "metric", "schema_version", "unit", "bounds", "counts", "count", "sum", "max"],
    });
    // No report body can hide in a column: no json, no bytes.
    expect(columns.rows.filter((row) => /json|bytea/.test(row.data_type))).toEqual([]);
    const foreignKeys = await testDb!.pool.query(
      `select 1 from information_schema.table_constraints
        where table_schema = 'public' and table_name = any($1) and constraint_type = 'FOREIGN KEY'`,
      [[...ROLLUP_TABLES]],
    );
    expect(foreignKeys.rowCount).toBe(0);

    // The database itself refuses free text in a group column, whoever writes.
    const hour = "2026-10-03T10:00:00Z";
    for (const [version, build] of [["1.4.2 (dev build)", "index-DEVowLko"], ["1.4.2", "index DEVowLko"], ["", "x"]] as const) {
      await expect(testDb!.pool.query(
        `insert into client_health_contract_hourly (hour, client_name, client_version, host_kind, host_build, reports, failed_reports)
         values ($1, 'chat-extension', $2, 'chatspace', $3, 1, 0)`,
        [hour, version, build],
      ), `${version} / ${build}`).rejects.toMatchObject({ code: "23514" });
    }
    await expect(testDb!.pool.query(
      `insert into client_health_counters_hourly (hour, client_name, client_version, host_kind, host_build, code, total)
       values ($1, 'chat-extension', '1.4.2', 'chatspace', '', 'Маша написала фану', 1)`,
      [hour],
    )).rejects.toMatchObject({ code: "23514" });
    // An hour that is not a whole UTC hour is refused too.
    await expect(testDb!.pool.query(
      `insert into client_health_receipts (client_event_id, received_hour) values ($1, '2026-10-03T10:15:00Z')`,
      [randomUUID()],
    )).rejects.toMatchObject({ code: "23514" });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("merges reports of one hour bucket by bucket, from any sender, and starts new rows in a new hour", async (context) => {
    if (!server) return context.skip();

    const tenPast = new Date("2026-10-03T10:10:00Z");
    const first = histogramFor("insertMs", [10, 40, 90]);
    const second = histogramFor("insertMs", [10, 12, 700, 1500]);
    expect(await intakeAt(tenPast, [
      { clientEventId: randomUUID(), payload: healthReport({ perf: [first], counters: { "CG-HUB-UNAVAILABLE": 2 }, cachesKB: 100 }) },
    ])).toEqual({ accepted: 1, duplicates: 0 });
    // Another batch, the same hour: two reports, one of another version.
    expect(await intakeAt(new Date("2026-10-03T10:59:59.999Z"), [
      { clientEventId: randomUUID(), payload: healthReport({ perf: [second], counters: { "CG-HUB-UNAVAILABLE": 5 }, contractOk: false, missing: ["composer"], cachesKB: 5_000 }) },
      { clientEventId: randomUUID(), payload: healthReport({ version: "1.5.0", perf: [first] }) },
    ])).toEqual({ accepted: 2, duplicates: 0 });
    // The next hour.
    expect(await intakeAt(new Date("2026-10-03T11:00:00Z"), [
      { clientEventId: randomUUID(), payload: healthReport({ perf: [first] }) },
    ])).toEqual({ accepted: 1, duplicates: 0 });

    const rows = await perfRows("insertMs");
    expect(rows.map((row) => [row.hour.toISOString(), row.client_version, row.count])).toEqual([
      ["2026-10-03T10:00:00.000Z", "1.4.2", 7],
      ["2026-10-03T10:00:00.000Z", "1.5.0", 3],
      ["2026-10-03T11:00:00.000Z", "1.4.2", 3],
    ]);
    const merged = rows[0]!;
    expect(merged.counts).toEqual(first.counts.map((bucket, index) => bucket + second.counts[index]!));
    expect(merged).toMatchObject({ bounds: first.bounds, sum: 2362, max: 1500 });
    expect(merged.counts.reduce((total, bucket) => total + bucket, 0)).toBe(merged.count);
    // The percentile is read off the merged buckets; a group under 20 observations shows none.
    expect(clientHealthP50P95(merged)).toEqual({ p50: null, p95: null, suppressed: true });
    expect(clientHealthP50P95(merged, 5).suppressed).toBe(false);

    const caches = (await perfRows("footprint.cachesKB"))[0]!;
    expect(caches).toMatchObject({ client_version: "1.4.2", count: 2, sum: 5_100, max: 5_000 });
    expect(caches.counts[CLIENT_HEALTH_FOOTPRINT_BOUNDS.indexOf(128)]).toBe(1);
    expect(caches.counts[CLIENT_HEALTH_FOOTPRINT_BOUNDS.indexOf(8192)]).toBe(1);

    const contract = await testDb!.pool.query(
      `select hour, client_version, reports::int as reports, failed_reports::int as failed_reports
         from client_health_contract_hourly order by hour, client_version collate "C"`,
    );
    expect(contract.rows.map((row) => [row.hour.toISOString(), row.client_version, row.reports, row.failed_reports])).toEqual([
      ["2026-10-03T10:00:00.000Z", "1.4.2", 2, 1],
      ["2026-10-03T10:00:00.000Z", "1.5.0", 1, 0],
      ["2026-10-03T11:00:00.000Z", "1.4.2", 1, 0],
    ]);
    expect(await counterTotals()).toEqual([{ client_version: "1.4.2", code: "CG-HUB-UNAVAILABLE", total: 7 }]);
    expect(await missingTotals()).toEqual([{ anchor: "composer", reports: 1 }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("a resent report is not counted twice: a resent batch, the same id twice in a batch, concurrent resends", async (context) => {
    if (!server) return context.skip();
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }]);

    const report = healthReport({ perf: [histogramFor("insertMs", [10, 40, 90])], counters: { "CG-SEND-UNCERTAIN": 1 } });
    const event = healthEvent(report);
    const acceptance = acceptanceEvent();
    expect(await ingestOk(narrowToken, [acceptance, event])).toEqual({ accepted: 2, duplicates: 0 });
    // The client resends the whole batch until it gets a 2xx.
    expect(await ingestOk(narrowToken, [acceptance, event])).toEqual({ accepted: 0, duplicates: 2 });
    // The id in another letter case is the same id.
    expect(await ingestOk(narrowToken, [healthEvent(report, event.clientEventId.toUpperCase())])).toEqual({ accepted: 0, duplicates: 1 });

    // Twice in one batch: the first is folded, the second is a duplicate.
    const twice = healthEvent(healthReport({ counters: { "CG-SEND-UNCERTAIN": 1 } }));
    expect(await ingestOk(narrowToken, [twice, twice])).toEqual({ accepted: 1, duplicates: 1 });

    // Eight concurrent sends of one new report: folded exactly once.
    const raced = healthEvent(healthReport({ counters: { "CG-SEND-UNCERTAIN": 1 } }));
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestOk(narrowToken, [raced])));
    expect(results.filter((result) => result.accepted === 1)).toHaveLength(1);
    expect(results.filter((result) => result.duplicates === 1)).toHaveLength(7);

    expect((await tableCounts()).client_health_receipts).toBe(3);
    expect(await contractTotals()).toEqual([{ ...GROUP, reports: 3, failed_reports: 0 }]);
    expect(await counterTotals()).toEqual([{ client_version: "1.4.2", code: "CG-SEND-UNCERTAIN", total: 3 }]);
    expect((await perfRows("insertMs")).reduce((total, row) => total + row.count, 0)).toBe(3);
    expect(await journal()).toEqual([{ producer: "chat-extension@1.4.2", kind: "desktop.ai_acceptance" }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("concurrent batches of different senders lose nothing and do not deadlock", async (context) => {
    if (!server) return context.skip();
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }]);

    const samples = [10, 40, 90];
    // Each batch touches the rows of both groups, in opposite orders.
    const batch = (flip: boolean) => {
      const events = [
        healthEvent(healthReport({ perf: [histogramFor("insertMs", samples)], counters: { a: 1, b: 1 }, missing: ["x", "y"], contractOk: false })),
        healthEvent(healthReport({ version: "1.5.0", perf: [histogramFor("insertMs", samples)], counters: { b: 1, a: 1 }, missing: ["y", "x"], contractOk: false })),
        acceptanceEvent(),
      ];
      return flip ? events.reverse() : events;
    };
    const tokens = [narrowToken, secondChatterToken, fullToken];
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      ingestOk(tokens[index % tokens.length]!, batch(index % 2 === 1), index % tokens.length === 2 ? "2.7.1" : undefined)));
    expect(results).toEqual(Array.from({ length: 12 }, () => ({ accepted: 3, duplicates: 0 })));

    expect(await contractTotals()).toEqual([
      { ...GROUP, reports: 12, failed_reports: 12 },
      { ...GROUP, client_version: "1.5.0", reports: 12, failed_reports: 12 },
    ]);
    expect(await counterTotals()).toEqual([
      { client_version: "1.4.2", code: "a", total: 12 },
      { client_version: "1.4.2", code: "b", total: 12 },
      { client_version: "1.5.0", code: "a", total: 12 },
      { client_version: "1.5.0", code: "b", total: 12 },
    ]);
    expect(await missingTotals()).toEqual([{ anchor: "x", reports: 24 }, { anchor: "y", reports: 24 }]);
    const insert = await perfRows("insertMs");
    expect(insert.reduce((total, row) => total + row.count, 0)).toBe(24 * samples.length);
    for (const row of insert) {
      expect(row.counts.reduce((total, bucket) => total + bucket, 0)).toBe(row.count);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("an invalid report is dropped alone, with nothing of it in the log; the rest of the batch is kept", async (context) => {
    if (!server) return context.skip();
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }]);
    const warn = vi.spyOn(app.logger!, "warn");

    const freeText = "Маша написала фану 777000777";
    const invalid = [
      // Free text where a code belongs: a counter key, an anchor.
      healthReport({ counters: { [freeText]: 1 } }),
      healthReport({ contractOk: false, missing: [freeText] }),
      // An unknown key: the report is strict.
      { ...healthReport(), fanName: freeText },
      // Another report version, and no report at all.
      { ...healthReport(), v: 2 },
      {},
      // A histogram whose count is not the sum of its buckets.
      healthReport({ perf: [{ ...histogramFor("insertMs", [10, 40]), count: 9 }] }),
    ];
    const valid = healthReport({ counters: { "p1.send-without-human": 1 } });
    // observedAt of a health report is never read: one that is no instant does not refuse the batch.
    const events = [
      acceptanceEvent(),
      ...invalid.map((payload) => healthEvent(payload)),
      { ...healthEvent(valid), observedAt: "not an instant" },
    ];
    const response = await ingest(narrowToken, events);
    expect(response.statusCode, response.body).toBe(200);
    // Dropped reports count as accepted: the client must not resend what would fail the same way.
    expect(response.json()).toEqual({ accepted: events.length, duplicates: 0 });

    expect(await contractTotals()).toEqual([{ ...GROUP, reports: 1, failed_reports: 0 }]);
    expect(await counterTotals()).toEqual([{ client_version: "1.4.2", code: "p1.send-without-human", total: 1 }]);
    expect((await tableCounts()).client_health_receipts).toBe(1);
    expect(await journal()).toEqual([{ producer: "chat-extension@1.4.2", kind: "desktop.ai_acceptance" }]);

    // One line for the batch: how many reports it dropped and the fields they failed on,
    // never their content or their sender.
    const dropped = warn.mock.calls.filter(([, message]) => String(message).startsWith("client_health reports dropped"));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]![0]).toEqual({
      dropped: invalid.length,
      fields: {
        // The empty report misses every field; the others fail on one each.
        v: 2, window: 1, client: 1, host: 2, disabled: 1, perf: 2, counters: 2, footprint: 1, "(report)": 1,
      },
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("Маша");
    expect(logged).not.toContain("777000777");
    expect(logged).not.toContain("grisha");
    expect(logged).not.toContain("fanName");

    // An acceptance event with an unreadable observedAt still refuses its whole batch, as before.
    const refused = await ingest(narrowToken, [{ ...acceptanceEvent(), observedAt: "not an instant" }, healthEvent(valid)]);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({ error: "invalid_ingest_event" });
    expect((await tableCounts()).client_health_receipts).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("one bad histogram is left out; a version or build that is not a code goes under the placeholder", async (context) => {
    if (!server) return context.skip();
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }]);
    const warn = vi.spyOn(app.logger!, "warn");

    const good = histogramFor("routeToDockMs", [3, 5]);
    const insert = histogramFor("insertMs", [10, 40, 90]);
    const report = healthReport({
      version: "1.4.2 (dev build)",
      build: "https://cdn.example/index DEVowLko.js",
      perf: [
        good,
        { ...insert, sum: 5_000 },
        { ...histogramFor("panelOpenMs", [10]), metric: "someFutureMs" },
        { ...histogramFor("ttfcMs", [300]), schemaVersion: 2 },
        { ...histogramFor("searchMs", [3]), bounds: histogramFor("searchMs", [3]).bounds.map((bound) => bound + 1) },
        { ...histogramFor("handlerMs", [0.4]), metric: "constructor" },
      ],
      counters: { "p1.read-without-human": 1 },
    });
    expect(await ingestOk(narrowToken, [healthEvent(report), healthEvent(healthReport({ build: null }))]))
      .toEqual({ accepted: 2, duplicates: 0 });

    expect(await contractTotals()).toEqual([
      { ...GROUP, client_version: "(other)", host_build: "(other)", reports: 1, failed_reports: 0 },
      { ...GROUP, host_build: "", reports: 1, failed_reports: 0 },
    ]);
    expect(await counterTotals()).toEqual([{ client_version: "(other)", code: "p1.read-without-human", total: 1 }]);
    const metrics = (await perfRows()).filter((row) => row.client_version === "(other)").map((row) => row.metric);
    expect(metrics.sort()).toEqual(["footprint.cachesKB", "footprint.logsKB", "routeToDockMs"]);

    const left = warn.mock.calls.filter(([, message]) => String(message).startsWith("client_health histograms left out"));
    expect(left).toHaveLength(1);
    expect((left[0]![0] as { dropped: unknown[] }).dropped).toEqual([
      { metric: "insertMs", reason: "does_not_fit", histograms: 1 },
      { metric: "someFutureMs", reason: "unknown_metric", histograms: 1 },
      { metric: "ttfcMs", reason: "unknown_schema_version", histograms: 1 },
      { metric: "searchMs", reason: "bounds_mismatch", histograms: 1 },
      { metric: "constructor", reason: "unknown_metric", histograms: 1 },
    ]);
    // The free-text version and build reach neither a table nor the log.
    const everything = await testDb!.pool.query<{ dump: string }>(
      `select coalesce(string_agg(t::text, ' '), '') as dump from (
         select client_version || host_build from client_health_contract_hourly
         union all select client_version || host_build from client_health_counters_hourly
         union all select client_version || host_build from client_health_perf_hourly) t`,
    );
    expect(everything.rows[0]!.dump).not.toContain("dev build");
    expect(everything.rows[0]!.dump).not.toContain("cdn.example");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("cdn.example");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("leaves a stored row alone when its bounds are not the report's, and says so", async (context) => {
    if (!server) return context.skip();
    const error = vi.spyOn(app.logger!, "error");

    const hour = new Date("2026-10-03T10:00:00Z");
    // A row written under another set of bounds for the same metric and schema version:
    // only a registry edited without a new schemaVersion can produce one.
    await testDb!.pool.query(
      `insert into client_health_perf_hourly
         (hour, client_name, client_version, host_kind, host_build, metric, schema_version, unit, bounds, counts, count, sum, max)
       values ($1, 'chat-extension', '1.4.2', 'chatspace', 'index-DEVowLko', 'insertMs', 1, 'ms', '{10,20}', '{1,1,0}', 2, 25, 15)`,
      [hour],
    );
    expect(await intakeAt(new Date("2026-10-03T10:30:00Z"), [{
      clientEventId: randomUUID(),
      payload: healthReport({ perf: [histogramFor("insertMs", [10, 40, 90]), histogramFor("routeToDockMs", [3])] }),
    }])).toEqual({ accepted: 1, duplicates: 0 });

    const [stale] = await perfRows("insertMs");
    expect(stale).toMatchObject({ bounds: [10, 20], counts: [1, 1, 0], count: 2, sum: 25, max: 15 });
    // The rest of the report is merged.
    expect((await perfRows("routeToDockMs"))[0]).toMatchObject({ count: 1 });
    expect(await contractTotals()).toEqual([{ ...GROUP, reports: 1, failed_reports: 0 }]);
    const said = error.mock.calls.filter(([, message]) => String(message).startsWith("client_health histograms not merged"));
    expect(said).toHaveLength(1);
    expect((said[0]![0] as { unmerged: unknown[] }).unmerged).toEqual([{ metric: "insertMs", schemaVersion: 1 }]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the narrow token still refuses a batch with a kind outside its profile, and nothing of it is kept", async (context) => {
    if (!server) return context.skip();
    await patchConfig([{ key: "chatExtensionEnabled", value: true }, { key: "chatExtensionHealthIngestEnabled", value: true }]);

    const mixed = await ingest(narrowToken, [healthEvent(healthReport()), { ...acceptanceEvent(), kind: "send_audit" }]);
    expect(mixed.statusCode, mixed.body).toBe(400);
    expect(mixed.json()).toMatchObject({ error: "invalid_ingest_event" });
    expect(await tableCounts()).toEqual(NOTHING_KEPT);
    expect(await journal()).toEqual([]);

    // The sender is authenticated, yet no table of the intake can say who it was.
    expect(await ingestOk(narrowToken, [healthEvent(healthReport())])).toEqual({ accepted: 1, duplicates: 0 });
    // The capture lane journals nothing of the report; the only journal rows that name the sender are its sign-ins.
    const captured = await testDb!.pool.query(
      "select 1 from observations where actor_principal_id = $1 and source = 'client_capture'",
      [chatterId],
    );
    expect(captured.rowCount).toBe(0);
    expect((await tableCounts()).client_health_receipts).toBe(1);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

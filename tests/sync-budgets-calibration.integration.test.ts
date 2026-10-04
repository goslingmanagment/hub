import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, writeSyncRouteState, type Database, type SyncRouteStateEntryWrite } from "@agency_hub_core/db";

import { buildSyncEngineCommandGroup } from "../apps/runtime/src/sync/cli.ts";
import { routePolicyVersion, type FanslyRoute } from "../apps/runtime/src/sync/fansly/routes.ts";
import { SYNC_ROUTE_RAISE_AUDIT_EVENT } from "../apps/runtime/src/sync/route-raise.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedSyncPage, testConfig } from "./helpers/sync-engine-host.ts";
import { replaceHoldRows, routeEntryOf, routeHoldRows } from "./helpers/sync-holds.ts";

// `budgets-calibration.sql` (step 3b A2, owner decisions D3, №21–№22) on a
// fixture database: the read-only evidence behind a route budget step. Per
// live page and route (and family): the hours on the step (since the window,
// the route's newest 429 and its newest raise), the 429s of the route and of
// its family on the step (a shadow journal's never), saturated 2-hour
// stretches in different UTC hours, `low_exposure`, an unreadable route
// state; for an eligible slowed route the owner's `sync route raise` command,
// pinned to the revision it read — which the CLI then accepts as it stands.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

const REPORT = readFileSync(new URL("../apps/runtime/src/sync/budgets-calibration.sql", import.meta.url), "utf8");
const BUCKET_S = 600;
const HOUR_S = 3_600;

interface ReportRow {
  page: string;
  scope: "route" | "family";
  name: string;
  family: string | null;
  ceiling_per_min: number;
  current_per_min: number;
  effective_per_min: number;
  slowed: boolean;
  revision: number | null;
  hours_on_step: number;
  sends_on_step: number;
  refusals_429_on_step: number;
  saturated_buckets: number;
  stretches_2h: number;
  stretch_utc_hours: number[];
  verdict: string;
  next_per_min: number | null;
  step: string | null;
}

/** The report's counts and rates as numbers (the driver hands out `bigint`
 *  and `numeric` as BigInt and text). */
const NUMERIC_COLUMNS = [
  "ceiling_per_min", "current_per_min", "effective_per_min", "revision", "hours_on_step", "sends_on_step",
  "refusals_429_on_step", "saturated_buckets", "stretches_2h", "next_per_min",
] as const;

/** The report as psql runs it with `-v since=…`. */
async function report(since: Date): Promise<ReportRow[]> {
  const text = REPORT.replace(/:since\b/g, `'${since.toISOString()}'`);
  const rows = (await testDb!.pool.query<Record<string, unknown>>(text)).rows;
  return rows.map((raw) => {
    const normalised: Record<string, unknown> = { ...raw };
    for (const column of NUMERIC_COLUMNS) {
      const value = raw[column];
      normalised[column] = value === null || value === undefined ? null : Number(value);
    }
    return normalised as unknown as ReportRow;
  });
}

function row(rows: ReportRow[], page: string, name: string): ReportRow {
  const found = rows.find((candidate) => candidate.page === page && candidate.name === name);
  if (found === undefined) throw new Error(`no report row ${page} ${name}: ${JSON.stringify(rows.map((r) => [r.page, r.name]))}`);
  return found;
}

/** The database clock, epoch seconds. */
async function dbNowS(): Promise<number> {
  return Number((await testDb!.pool.query<{ now: string }>("select extract(epoch from clock_timestamp())::text as now")).rows[0]!.now);
}

/** Sends of `route` at the given instants (epoch seconds). */
async function sendsAt(
  pageId: number,
  route: string,
  atS: number[],
  options: { status?: number; shadow?: boolean } = {},
): Promise<void> {
  const shadow = options.shadow === true;
  await testDb!.pool.query(
    `insert into sync_attempts (page_id, shadow, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, send_mark, completed_at, operation, request, outcome, http_status, error_class)
     select $1, $2, 'test.read', '', 'planned', 1, 2000, 0, 2000,
            to_timestamp(t) - interval '50 milliseconds', to_timestamp(t), $3, to_timestamp(t) + interval '200 milliseconds',
            $4, '{}'::jsonb, $5, $6::smallint, case when $6::int = 429 then 'rate_limit' end
       from unnest($7::double precision[]) as t`,
    [pageId, shadow, shadow ? "shadow" : "request_start", route, shadow ? "shadow" : "response", options.status ?? 200, atS],
  );
}

/** `perBucket` sends in each of `buckets` consecutive 10-minute buckets, the
 *  first being the bucket of `fromS`. */
async function saturate(pageId: number, route: string, fromS: number, buckets: number, perBucket: number): Promise<void> {
  const first = Math.floor(fromS / BUCKET_S);
  const atS: number[] = [];
  for (let bucket = first; bucket < first + buckets; bucket += 1) {
    for (let i = 0; i < perBucket; i += 1) atS.push(bucket * BUCKET_S + 5 + i * Math.floor((BUCKET_S - 10) / perBucket));
  }
  await sendsAt(pageId, route, atS);
}

function entry(route: FanslyRoute, overrides: Partial<SyncRouteStateEntryWrite>): SyncRouteStateEntryWrite {
  return {
    holdUntil: null,
    ladderStep: 1,
    effectivePerMin: null,
    policyVersion: routePolicyVersion(route),
    last429AttemptId: null,
    last429At: null,
    ...overrides,
  };
}

/** Write the route's entry `revisions` times (the revision the report reads). */
async function routeState(pageId: number, route: FanslyRoute, revisions: number, value: SyncRouteStateEntryWrite): Promise<void> {
  for (let revision = 0; revision < revisions; revision += 1) {
    expect(await writeSyncRouteState(db(), { pageId, route, expectRevision: revision, entry: value }))
      .toEqual({ kind: "written", revision: revision + 1 });
  }
}

/** `pnpm cli sync route raise …` as the report prints it. */
async function runStep(step: string): Promise<Record<string, unknown>> {
  const tokens = [...step.matchAll(/'((?:[^']|'')*)'|(\S+)/g)].map((match) => match[1]?.replaceAll("''", "'") ?? match[2]!);
  expect(tokens.slice(0, 3)).toEqual(["pnpm", "cli", "sync"]);
  const lines: string[] = [];
  await buildSyncEngineCommandGroup({
    openContext: async () => ({ db: db(), rawConfig: testConfig(testDb!.connectionString), close: async () => undefined }),
    print: (line) => lines.push(line),
  }).parseAsync(["node", "sync", ...tokens.slice(3)]);
  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("budgets-calibration.sql", () => {
  it("judges each live page+route and family on its step and prints the raise the evidence allows", async (context) => {
    if (!testDb) return context.skip();
    const now = await dbNowS();
    const since = new Date((now - 40 * HOUR_S) * 1_000);
    const handles = { db: db(), pool: testDb.pool };

    // cal-a: the media statistics halved 30 h ago (2.5/min, revision 2), then
    // two saturated 2-hour stretches (≥ 0.9 × 2.5 × 10 = 23 a bucket) 8 h
    // apart, no 429 on the route since — a shadow journal's 429 and a 429 of
    // another route (no family) count for nothing. The list: a few reads.
    const a = await seedSyncPage(handles, { label: "cal-a", mode: "live" });
    const last429 = now - 30 * HOUR_S;
    await sendsAt(a.pageId, "media.offer_stats", [last429 - 1], { status: 429 });
    await routeState(a.pageId, "media.offer_stats", 2, entry("media.offer_stats", {
      effectivePerMin: 2.5, last429At: new Date(last429 * 1_000),
    }));
    await saturate(a.pageId, "media.offer_stats", now - 28 * HOUR_S, 12, 23);
    await saturate(a.pageId, "media.offer_stats", now - 20 * HOUR_S, 12, 23);
    await sendsAt(a.pageId, "media.offer_stats", [now - 3 * HOUR_S], { status: 429, shadow: true });
    await sendsAt(a.pageId, "followers.page", [now - 2 * HOUR_S, now - HOUR_S], { status: 429 });
    await sendsAt(a.pageId, "messaging.groups", [now - 3 * HOUR_S, now - 2 * HOUR_S]);

    // cal-b: a 429 on `/message` an hour ago — its family (the list) waits
    // too; the media statistics raised 10 h ago (3.5/min, revision 5) with
    // two stretches since — fewer than 24 h on the step.
    const b = await seedSyncPage(handles, { label: "cal-b", mode: "live" });
    await sendsAt(b.pageId, "messages.page", [now - 3 * HOUR_S, now - 2 * HOUR_S]);
    await sendsAt(b.pageId, "messages.page", [now - HOUR_S], { status: 429 });
    await sendsAt(b.pageId, "messaging.groups", [now - 4 * HOUR_S, now - 30]);
    await routeState(b.pageId, "media.offer_stats", 5, entry("media.offer_stats", {
      effectivePerMin: 3.5, last429At: new Date(last429 * 1_000),
    }));
    const raisedAt = now - 10 * HOUR_S;
    await testDb.pool.query(
      `insert into audit_events (platform_account_id, source, event_type, metadata, created_at)
       values ($1, 'cli', $2, jsonb_build_object('route', 'media.offer_stats'), to_timestamp($3))`,
      [b.pageId, SYNC_ROUTE_RAISE_AUDIT_EVENT, raisedAt],
    );
    await saturate(b.pageId, "media.offer_stats", now - 9 * HOUR_S, 12, 32);
    await saturate(b.pageId, "media.offer_stats", now - 5 * HOUR_S, 12, 32);

    // A shadow page is no evidence; a route state this build cannot read is
    // said so.
    const shadow = await seedSyncPage(handles, { label: "cal-shadow", mode: "shadow" });
    await sendsAt(shadow.pageId, "notifications.page", [now - HOUR_S]);
    const unreadable = await seedSyncPage(handles, { label: "cal-unreadable", mode: "live" });
    // The state of another of its routes is no rate: one unreadable route
    // closes the page (as the engine judges it), so every route says so.
    await replaceHoldRows(testDb, unreadable.pageId, "route", routeHoldRows("polls", { effectivePerMin: -1 }));
    await sendsAt(unreadable.pageId, "followers.page", [now - HOUR_S]);

    const rows = await report(since);
    expect(rows.some((candidate) => candidate.page === "cal-shadow")).toBe(false);

    const media = row(rows, "cal-a", "media.offer_stats");
    expect(media).toMatchObject({
      scope: "route", family: null, ceiling_per_min: 12, current_per_min: 5, effective_per_min: 2.5, slowed: true, revision: 2,
      refusals_429_on_step: 0, saturated_buckets: 24, stretches_2h: 2, verdict: "eligible", next_per_min: 3.5,
    });
    expect(media.hours_on_step).toBeGreaterThanOrEqual(29.9);
    expect(media.stretch_utc_hours).toHaveLength(2);
    expect(media.step).toBe(`pnpm cli sync route raise --page cal-a --route media.offer_stats --to 3.5 --revision 2 `
      + `--evidence 'budgets-calibration since ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}'`);

    expect(row(rows, "cal-a", "followers.page")).toMatchObject({ verdict: "had_429", refusals_429_on_step: 2, step: null });
    expect(row(rows, "cal-a", "messaging.groups")).toMatchObject({ family: "messaging", slowed: false, verdict: "low_exposure", step: null });
    expect(row(rows, "cal-a", "family:messaging")).toMatchObject({ scope: "family", verdict: "low_exposure", sends_on_step: 2 });

    expect(row(rows, "cal-b", "messages.page")).toMatchObject({ verdict: "had_429", refusals_429_on_step: 1 });
    expect(row(rows, "cal-b", "messaging.groups")).toMatchObject({ verdict: "had_429", refusals_429_on_step: 1 });
    expect(row(rows, "cal-b", "family:messaging")).toMatchObject({ verdict: "had_429", sends_on_step: 5 });
    const raised = row(rows, "cal-b", "media.offer_stats");
    expect(raised).toMatchObject({ slowed: true, revision: 5, stretches_2h: 2, verdict: "not_yet", step: null });
    expect(raised.hours_on_step).toBeLessThan(10.1);

    expect(row(rows, "cal-unreadable", "followers.page")).toMatchObject({ verdict: "route_state_unreadable", step: null });

    // The printed step is the owner's lever as it stands: one audited raise.
    expect(await runStep(media.step!)).toMatchObject({
      page: "cal-a", route: "media.offer_stats", fromPerMin: 2.5, toPerMin: 3.5, revision: 3, slowdownEnded: false,
    });
    expect(routeEntryOf((await getSyncPage(db(), a.pageId))!, "media.offer_stats")).toMatchObject({ effectivePerMin: 3.5, revision: 3 });
    // The next step starts with the raise: nothing proven on it yet, and the
    // same evidence is refused (its revision is gone).
    const after = row(await report(since), "cal-a", "media.offer_stats");
    expect(after).toMatchObject({ revision: 3, stretches_2h: 0, verdict: "low_exposure", step: null });
    expect(after.hours_on_step).toBeLessThan(0.1);
    await expect(runStep(media.step!)).rejects.toThrow(/stale_revision/);
  }, 120_000);
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  countSendsSince,
  createFanslyPage,
  createModel,
  ensureSyncPage,
  paceFloorFromDb,
  readRouteJournal,
  type Database,
} from "@agency_hub_core/db";

import { routeOfEngineOperation } from "../apps/runtime/src/sync/fansly/routes.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// sync_attempts.origin (0271; Project Browser plan §3.2, stage 3 PR 8): the
// site's own requests and the owner's login operations, journaled next to
// the engine's sends with the class 'site' and no work, are seen by the
// takeover floor, the route clocks and the send counts without code of
// their own; the checks keep an engine send an engine send.

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

async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await testDb!.pool.query(text, values);
  return result.rows as T[];
}

async function seedPage(): Promise<number> {
  const label = `origin-${randomUUID().slice(0, 8)}`;
  const model = await createModel(db(), { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(db(), { modelId: model!.id, label });
  await ensureSyncPage(db(), { pageId: page!.id });
  return page!.id;
}

interface Row {
  origin?: string;
  klass: string;
  workId?: number | null;
  operation: string;
  outcome: string;
  admittedAgoMs: number;
  sentAgoMs: number | null;
}

async function insert(pageId: number, row: Row): Promise<void> {
  await query(
    `insert into sync_attempts (page_id, work_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                admitted_at, sent_at, operation, request, outcome${row.origin === undefined ? "" : ", origin"})
     select $1, $2, 'site', '', $3, 1, 2500, 0.1, 2750, a, s, $4, '{}'::jsonb, $5${row.origin === undefined ? "" : ", $8"}
       from (select clock_timestamp() - $6::double precision * interval '1 millisecond' as a,
                    case when $7::double precision is null then null
                         else clock_timestamp() - $7::double precision * interval '1 millisecond' end as s) t`,
    [pageId, row.workId ?? null, row.klass, row.operation, row.outcome, row.admittedAgoMs, row.sentAgoMs, ...(row.origin === undefined ? [] : [row.origin])],
  );
}

describe("sync_attempts.origin", () => {
  it("an engine attempt keeps the default origin", async () => {
    const pageId = await seedPage();
    await insert(pageId, { klass: "planned", workId: 7, operation: "polls", outcome: "response", admittedAgoMs: 2_000, sentAgoMs: 1_500 });
    expect(await query("select origin from sync_attempts where page_id = $1", [pageId])).toEqual([{ origin: "engine" }]);
  });

  it("a site and a login attempt count on their routes and as sends of the page", async () => {
    const pageId = await seedPage();
    const since = new Date(Date.now() - 60_000);
    await insert(pageId, { origin: "site", klass: "site", operation: "site.other", outcome: "response", admittedAgoMs: 3_000, sentAgoMs: 2_500 });
    await insert(pageId, { origin: "site", klass: "site", operation: "messaging.groups", outcome: "response", admittedAgoMs: 2_000, sentAgoMs: 1_500 });
    await insert(pageId, { origin: "login", klass: "site", operation: "auth.login", outcome: "response", admittedAgoMs: 1_000, sentAgoMs: 900 });

    const journal = await readRouteJournal(db(), { pageId, withinMs: 60_000 });
    expect(journal.map((send) => `${send.journal}:${send.operation}`).sort()).toEqual(["engine:auth.login", "engine:messaging.groups", "engine:site.other"]);
    // The route clocks read each on its route, none against every route.
    for (const send of journal) expect(routeOfEngineOperation(send.operation)).toBe(send.operation);

    const counts = await countSendsSince(db(), { pageId, since });
    expect(counts).toMatchObject({ urgent: 0, requests: 0, planned: 0, site: 3 });
  });

  it("an admitted site request holds the takeover floor like an engine send", async () => {
    const pageId = await seedPage();
    const before = await paceFloorFromDb(db(), { pageId, settingMs: 2_500 });
    await insert(pageId, { origin: "site", klass: "site", operation: "site.other", outcome: "admitted", admittedAgoMs: 0, sentAgoMs: null });
    const after = await paceFloorFromDb(db(), { pageId, settingMs: 2_500 });
    // Admission + the send window + 1.2 × S, against 1.2 × S from now.
    expect(after).toBeGreaterThan(before + 10_000);
  });

  it("the checks keep an engine send an engine send", async () => {
    const pageId = await seedPage();
    const bad: Array<[string, Row]> = [
      ["a site request in an engine class", { origin: "site", klass: "urgent", operation: "site.other", outcome: "response", admittedAgoMs: 100, sentAgoMs: null }],
      ["an engine send in the site class", { origin: "engine", klass: "site", operation: "polls", outcome: "response", admittedAgoMs: 100, sentAgoMs: null }],
      ["a site request with a work", { origin: "site", klass: "site", workId: 3, operation: "site.other", outcome: "response", admittedAgoMs: 100, sentAgoMs: null }],
      ["an unknown origin", { origin: "agent", klass: "site", operation: "site.other", outcome: "response", admittedAgoMs: 100, sentAgoMs: null }],
      ["an unknown class", { origin: "site", klass: "background", operation: "site.other", outcome: "response", admittedAgoMs: 100, sentAgoMs: null }],
    ];
    for (const [name, row] of bad) await expect(insert(pageId, row), name).rejects.toThrow(/sync_attempts_(origin|class)_check/);
    expect(await query("select count(*)::int as n from sync_attempts where page_id = $1", [pageId])).toEqual([{ n: 0 }]);
  });
});

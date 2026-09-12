import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getLatestOfapiEventTimesForPages,
  getLatestSettledOfapiDmEventTimes,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// docs/diag/2026-09-11-agency-hub-load: the per-page "latest settled webhook"
// readers used to take max(received_at) over every row of the page (a full
// scan of the journal, 38 s on production). They now probe the
// (platform_account_id, received_at) index once per page; the answers must not
// change: newest SETTLED event per page, pending rows ignored, the DM variant
// restricted to its event types, pages without events absent from the map.

let harness: StartedTestDatabase;

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) {
    throw new Error("Docker-backed Postgres is required for this integration test");
  }
  harness = started;
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

async function seedPage(label: string, ofapiAccountId: string) {
  const model = await createModel(harness.db, { slug: label, name: label });
  if (!model) throw new Error("model seed failed");
  const page = await createOnlyFansPage(harness.db, { modelId: model.id, label });
  if (!page) throw new Error("page seed failed");
  await setPageOfapiAccountId(harness.db, { pageId: page.id, ofapiAccountId });
  return page;
}

async function insertEvent(input: {
  key: string; pageId: number; ofapiAccountId: string; eventType: string;
  status: "pending" | "processed"; receivedAgoSeconds: number;
}) {
  await harness.pool.query(
    `insert into ofapi_webhook_events
       (idempotency_key, event_type, ofapi_account_id, platform_account_id, payload, status, received_at, processed_at)
     values ($1, $2, $3, $4, '{}', $5, now() - make_interval(secs => $6), case when $5 = 'processed' then now() else null end)`,
    [input.key, input.eventType, input.ofapiAccountId, input.pageId, input.status, input.receivedAgoSeconds],
  );
}

describe("per-page latest settled webhook times (0184 index probe)", () => {
  it("returns the newest settled event per page, ignoring pending rows and empty pages", async () => {
    const a = await seedPage("recency-a", "acct_recency_a");
    const b = await seedPage("recency-b", "acct_recency_b");
    const empty = await seedPage("recency-empty", "acct_recency_empty");

    await insertEvent({ key: "r-a-1", pageId: a.id, ofapiAccountId: "acct_recency_a", eventType: "messages.received", status: "processed", receivedAgoSeconds: 600 });
    await insertEvent({ key: "r-a-2", pageId: a.id, ofapiAccountId: "acct_recency_a", eventType: "transactions.new", status: "processed", receivedAgoSeconds: 300 });
    await insertEvent({ key: "r-a-3", pageId: a.id, ofapiAccountId: "acct_recency_a", eventType: "messages.received", status: "pending", receivedAgoSeconds: 10 });
    await insertEvent({ key: "r-b-1", pageId: b.id, ofapiAccountId: "acct_recency_b", eventType: "messages.received", status: "processed", receivedAgoSeconds: 1200 });

    const anyType = await getLatestOfapiEventTimesForPages(harness.db, [a.id, b.id, empty.id]);
    expect([...anyType.keys()].sort()).toEqual([a.id, b.id].sort());
    const ageA = (Date.now() - anyType.get(a.id)!.getTime()) / 1000;
    const ageB = (Date.now() - anyType.get(b.id)!.getTime()) / 1000;
    expect(ageA).toBeGreaterThan(250); // the settled transactions.new row, not the pending one
    expect(ageA).toBeLessThan(350);
    expect(ageB).toBeGreaterThan(1150);
    expect(ageB).toBeLessThan(1250);

    const dmOnly = await getLatestSettledOfapiDmEventTimes(harness.db, {
      pageIds: [a.id, b.id, empty.id],
      eventTypes: ["messages.received"],
    });
    expect([...dmOnly.keys()].sort()).toEqual([a.id, b.id].sort());
    const dmAgeA = (Date.now() - dmOnly.get(a.id)!.getTime()) / 1000;
    expect(dmAgeA).toBeGreaterThan(550); // the settled messages.received row (600 s), not transactions.new
    expect(dmAgeA).toBeLessThan(650);

    expect(await getLatestOfapiEventTimesForPages(harness.db, [])).toEqual(new Map());
    expect(await getLatestSettledOfapiDmEventTimes(harness.db, { pageIds: [a.id], eventTypes: [] })).toEqual(new Map());
  });
});

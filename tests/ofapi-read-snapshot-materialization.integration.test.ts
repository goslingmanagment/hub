import {
  createModel,
  createOfapiCollectionJob,
  createOnlyFansPage,
  createUser,
  getProjectionWatermark,
  readOfapiStoredSnapshots,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { captureOfapiCollectionRead } from "../apps/runtime/src/services/ofapi-collection-read-transport.ts";
import { materializeOfapiReadSnapshot } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import {
  OFAPI_READ_SNAPSHOT_PROJECTION,
  projectOfapiReadSnapshotObservation,
  runOfapiReadSnapshotProjection,
} from "../apps/runtime/src/services/projections/ofapi-read-snapshots.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let db: StartedTestDatabase;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("DB unavailable");
  db = started;
}, 120000);
afterAll(async () => { await db?.stop(); });
beforeEach(async () => { await resetIntegrationDatabase(db.pool); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("materializes the exact captured fact beyond 10000 unrelated events without advancing replay or refetching", async () => {
  const app = createTestAppContext(db);
  const actor = (await createUser(app.db, { username: "owner", role: "owner", passwordHash: "synthetic" }))!.id;
  const model = (await createModel(app.db, { slug: "materialization", name: "Materialization" }))!;
  const pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "snapshot-page" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_test" });
  // A mature account's unrelated event history exceeds the projector's single-run bound.
  await db.pool.query(`
    insert into domain_events(account_id,account_seq,type,occurred_at,data,schema_version,observation_id,dedup_key)
    select $1,n,'message.sent',now(),'{}'::jsonb,1,0,'history:'||n
    from generate_series(1,10001) n`, [pageId]);
  await db.pool.query("insert into domain_event_seq(account_id,next_seq) values($1,10002)", [pageId]);
  await db.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
  app.ofapi = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: { id: "123", username: "model" },
    _meta: { _credits: { used: 1, balance: 9999 } },
  })));
  vi.stubGlobal("fetch", fetch);
  const job = await createOfapiCollectionJob(app.db, {
    pageId, category: "profile_notifications", expectedRevision: 0,
    maxCalls: 1, maxCredits: 1, maxBytes: 100000,
    from: null, to: null, selection: ["me"],
  }, actor);
  const step = { operation: "ofapi_read_me", pathname: "/acct_test/me", query: {} };
  const captured = await captureOfapiCollectionRead(app, {
    pageId, accountId: "acct_test", step, stepKey: `backlog:${job.id}`,
    context: { category: "profile_notifications", purpose: "one_off", jobId: job.id },
    maxBytes: 100000, beforeDispatch: async () => true,
  });
  await materializeOfapiReadSnapshot(app, {
    pageId, step, body: captured.body, observationId: captured.observationId,
    observationReceivedAt: captured.observationReceivedAt,
  });
  const snapshots = await readOfapiStoredSnapshots(app.db, { pageId });
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]!.observationId).toBe(String(captured.observationId));
  expect(await getProjectionWatermark(app.db, OFAPI_READ_SNAPSHOT_PROJECTION, pageId)).toBe(0);

  // Repeated target projection uses two indexed point reads, independent of account history.
  const queries = vi.spyOn(db.pool, "query");
  await projectOfapiReadSnapshotObservation(app, { accountId: pageId, observationId: captured.observationId });
  const capturedQueries: unknown[] = queries.mock.calls.map(([query]) => query);
  const statements = capturedQueries.map(query =>
    typeof query === "object" && query !== null && "text" in query ? String(query.text) : String(query));
  expect(statements.filter(statement => /from domain_event_keys|from domain_events de/.test(statement))).toHaveLength(2);
  expect(statements.some(statement => /de\.account_seq\s*>/.test(statement))).toBe(false);
  queries.mockRestore();
  expect(await getProjectionWatermark(app.db, OFAPI_READ_SNAPSHOT_PROJECTION, pageId)).toBe(0);

  // Ordinary replay still consumes the retained prefix and idempotently applies the same fact.
  const prefix = await runOfapiReadSnapshotProjection(app, { accountId: pageId });
  expect(prefix).toMatchObject({ eventsSeen: 10000, applied: 0 });
  const tail = await runOfapiReadSnapshotProjection(app, { accountId: pageId });
  expect(tail.applied).toBe(1);
  expect(await readOfapiStoredSnapshots(app.db, { pageId })).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

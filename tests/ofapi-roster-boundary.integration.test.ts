import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancePageOfapiAuthStatus, createModel, createOnlyFansPage,
  insertOfapiWebhookEvent, type Database,
} from "@agency_hub_core/db";
import { createTestAppContext } from "./helpers/runtime.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;
beforeAll(async () => { testDb = await startIntegrationTestDatabase(); }, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
beforeEach(async context => {
  if (!testDb) return context.skip();
  await resetIntegrationDatabase(testDb.pool);
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("PLAN REVISION 06 boundary", () => {
  it("REGRESSION 06 captures the boundary before journal nextval waits and accepts a post-body failure", async () => {
    const model = await createModel(testDb!.db, { slug: "revision-boundary", name: "Boundary" });
    const page = await createOnlyFansPage(testDb!.db, { modelId: model!.id, label: "boundary-of" });
    const atNextval = barrier();
    const releaseNextval = barrier();
    const underlying = testDb!.db;
    let firstExecute = true;
    const delayedDb = new Proxy(underlying, {
      get(target, property, receiver) {
        if (property === "execute") {
          return async (...args: Parameters<Database["execute"]>) => {
            // Scope admission can query before the response. Delay only the actual
            // journal nextval, so this exercises the captured-body boundary.
            const query = typeof args[0] === "string" ? args[0] : new PgDialect().sqlToQuery(args[0].getSQL()).sql;
            if (firstExecute && query.includes("nextval(pg_get_serial_sequence('observations', 'id'))")) {
              firstExecute = false;
              atNextval.release();
              await releaseNextval.promise;
            }
            return target.execute(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = createTestAppContext(testDb!);
    const policy = ofapiCredentialPolicy(delayedDb, app.config, app.logger);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: "acct_new", onlyfans_id: 123, is_authenticated: true },
    ]), { status: 200 })));
    const client = createOfapiClient({
      apiKey: "synthetic-test-key", restDelayMs: 0,
      ...policy,
    });
    // Control both receipt clocks: Docker VM and host can differ by milliseconds.
    const bodyTime = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(bodyTime);
    const rosterPromise = client.listAccountsSnapshot!();
    await atNextval.promise;
    let failureAt!: Date;
    try {
      vi.setSystemTime(bodyTime + 1);
      const event = await insertOfapiWebhookEvent(underlying, {
        idempotencyKey: randomUUID(), eventType: "accounts.authentication_failed", ofapiAccountId: "acct_new", payload: {},
      });
      await testDb!.pool.query("update ofapi_webhook_events set received_at=$2 where id=$1", [event!.id, new Date()]);
      failureAt = (await testDb!.pool.query("select received_at from ofapi_webhook_events where id=$1", [event!.id])).rows[0].received_at;
      // Moving the clock while nextval is held makes a late helper timestamp fail deterministically.
      vi.setSystemTime(bodyTime + 2);
    } finally {
      releaseNextval.release();
    }
    const snapshot = await rosterPromise;
    expect(snapshot.accounts[0]?.isAuthenticated).toBe(true);
    const evidence = snapshot.evidence;
    expect(evidence).not.toBeNull();
    expect(evidence!.receivedAt.getTime()).toBe(bodyTime);
    expect(evidence!.receivedAt.getTime()).toBeLessThanOrEqual(failureAt.getTime());
    // Apply the revised plan's proposed boundary value, then use the real forward-only projection.
    await testDb!.pool.query("update pages set ofapi_account_id='acct_new',ofapi_auth_status=null,ofapi_auth_changed_at=$2 where id=$1", [page!.id, evidence!.receivedAt]);
    expect(await advancePageOfapiAuthStatus(underlying, {
      pageId: page!.id, authStatus: "authentication_failed", changedAt: failureAt,
    })).toBe(true);
    const row = (await testDb!.pool.query("select ofapi_auth_status from pages where id=$1", [page!.id])).rows[0];
    expect(row.ofapi_auth_status).toBe("authentication_failed");
  });
});

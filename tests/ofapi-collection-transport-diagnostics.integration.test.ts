import {
  createModel,
  createOfapiCollectionJob,
  createOnlyFansPage,
  createUser,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { captureOfapiCollectionRead } from "../apps/runtime/src/services/ofapi-collection-read-transport.ts";
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

it.each(["body", "headers", "size"] as const)("retains safe %s failure diagnostics without exposing provider material or changing custody", async (failure) => {
  const app = createTestAppContext(db);
  const actor = (await createUser(app.db, { username: "owner", role: "owner", passwordHash: "synthetic" }))!.id;
  const model = (await createModel(app.db, { slug: "diagnostics", name: "Diagnostics" }))!;
  const pageId = (await createOnlyFansPage(app.db, { modelId: model.id, label: "diagnostic-page" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: "acct_private" });
  await db.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
  app.ofapi = createOfapiClient({ apiKey: "secret-provider-key", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
  const warning = vi.spyOn(app.logger, "warn");
  const privateUrl = "socks5://private-user:private-password@private-proxy.invalid:1080";
  const privateBody = Buffer.from("private-response-body");
  const nested = Object.assign(new Error(`Bearer secret-provider-key ${privateUrl}`), {
    name: privateUrl, code: "private-error-code", address: "private-proxy.invalid",
  });
  const streamFailure = Object.assign(new TypeError("private-error-message", { cause: nested }), { code: "UND_ERR_SOCKET" });
  const maxBytes = 100000;
  let pulls = 0;
  const fetch = vi.fn(async () => {
    if (failure === "headers") throw streamFailure;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(privateBody);
        else controller.error(streamFailure);
      },
    }), { status: 200, headers: { "content-length": String(failure === "size" ? maxBytes + 1 : 100), "x-private-token": "private-header-value" } });
  });
  vi.stubGlobal("fetch", fetch);
  const job = await createOfapiCollectionJob(app.db, {
    pageId, category: "profile_notifications", expectedRevision: 0,
    maxCalls: 1, maxCredits: 1, maxBytes, from: null, to: null, selection: ["me"],
  }, actor);
  const input = {
    pageId, accountId: "acct_private", step: { operation: "ofapi_read_me", pathname: "/acct_private/me", query: {} },
    stepKey: `diagnostics:${job.id}`,
    context: { category: "profile_notifications" as const, purpose: "one_off" as const, jobId: job.id },
    maxBytes, beforeDispatch: async () => true,
  };
  const reason = failure === "body" ? "body_read" : failure === "headers" ? "transport" : "body_too_large";
  await expect(captureOfapiCollectionRead(app, input)).rejects.toMatchObject({ phase: "post_dispatch", reason });
  expect(fetch).toHaveBeenCalledTimes(1);
  const receipts = await db.pool.query("select credits,estimated,details from ofapi_credit_ledger where operation='ofapi_read_me'");
  expect(receipts.rows).toHaveLength(1);
  const receipt = receipts.rows[0]!;
  const expected = {
    phase: "post_dispatch", reason,
    stage: failure === "headers" ? "response_headers" : "response_body",
    status: failure === "headers" ? null : 200,
    declaredLength: failure === "headers" ? null : failure === "size" ? maxBytes + 1 : 100,
    bytesRead: failure === "body" ? privateBody.length : 0,
    maxResponseBytes: maxBytes, timeoutMs: 60000,
    transportClass: failure === "size" ? null : "transport",
    causeName: failure === "size" ? null : "TypeError",
    causeCode: failure === "size" ? null : "UND_ERR_SOCKET",
  };
  expect(receipt).toMatchObject({ credits: 1, estimated: true, details: { certainty: "indeterminate", outcome: "transport", ...expected } });
  expect(receipt.details.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(warning).toHaveBeenCalledWith({ operation: "ofapi_read_me", jobId: job.id, ...expected, elapsedMs: receipt.details.elapsedMs }, "OFAPI collection transport failed");
  const exposed = JSON.stringify({ receipt, warnings: warning.mock.calls });
  for (const secret of [privateUrl, "private-error-code", "private-error-message", "secret-provider-key", "private-proxy.invalid", "private-response-body", "private-header-value", "acct_private", "/me"])
    expect(exposed).not.toContain(secret);
  // The uncertain safe read is settled as billed: counted as spent, holding no reserve.
  expect((await db.pool.query("select state,credit_state,settled_credits,certainty_resolution from ofapi_request_attempts where operation='ofapi_read_me'")).rows)
    .toEqual([{ state: "indeterminate", credit_state: "settled", settled_credits: 1, certainty_resolution: "safe_read_retry_assumed_billed" }]);
  expect((await db.pool.query("select governed_unsettled_credits from ofapi_credit_state")).rows[0].governed_unsettled_credits).toBe(0);
  // Diagnostics do not open a retry path or release the original allowance:
  // the step's one call is spent, before and after its capture job's retry time.
  await expect(captureOfapiCollectionRead(app, input)).rejects.toThrow("Collection capture unavailable");
  await db.pool.query("update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second'");
  await expect(captureOfapiCollectionRead(app, input)).rejects.toThrow("Capture admission: job_cap");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await db.pool.query("select used_calls,used_credits::int,max_calls,max_credits::int from ofapi_collection_jobs where id=$1", [job.id])).rows[0]).toEqual({ used_calls: 1, used_credits: 1, max_calls: 1, max_credits: 1 });
  expect((await db.pool.query("select count(*)::int count from observations where source='ofapi_capture'")).rows[0].count).toBe(0);
});

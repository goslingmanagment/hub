import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyOfapiKeyDeclaration, getOfapiKeyDeclaration, saveOfapiVendorUsage, compareOfapiVendorUsage, insertObservation } from "@agency_hub_core/db";
import { assertOfapiConfiguredAccess } from "../apps/runtime/src/services/ofapi-vendor-usage.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
let testDb: StartedTestDatabase;
let app: AppContext;
let actor: number;
const fingerprint = createHash("sha256").update("synthetic").digest("hex");
beforeAll(async () => { const started = await startIntegrationTestDatabase(); if (!started) throw new Error("Integration database unavailable"); testDb = started; }, 120_000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool); app = createTestAppContext(testDb);
  const result = await testDb.pool.query("insert into users(username,password_hash,role) values ('scope-test','synthetic','owner') returning id");
  actor = Number(result.rows[0].id);
});
describe("durable key declarations and vendor usage", () => {
  it("CAS fences two windows, retains audit and scopes declarations to the exact credential", async () => {
    const input = { credentialFingerprint: fingerprint, expectedVersion: 0, capabilities: ["reads" as const], accountIds: ["acct_a"], visibility: "declared_restricted" as const };
    expect(await Promise.all([applyOfapiKeyDeclaration(app.db, input, actor), applyOfapiKeyDeclaration(app.db, input, actor)])).toEqual(expect.arrayContaining([true, false]));
    expect((await getOfapiKeyDeclaration(app.db, fingerprint))?.version).toBe(1);
    expect(await getOfapiKeyDeclaration(app.db, "b".repeat(64))).toBeNull();
    const audit = await testDb.pool.query("select count(*)::int as n from ofapi_key_scope_audit");
    expect(audit.rows[0].n).toBe(1);
    await expect(assertOfapiConfiguredAccess(app.db, fingerprint, { operation: "ofapi_send_text", method: "POST", accountId: "acct_a" })).rejects.toThrow("commands");
    await expect(assertOfapiConfiguredAccess(app.db, fingerprint, { operation: "ofapi_fans", method: "GET", accountId: "acct_b" })).rejects.toThrow("account");
    await expect(assertOfapiConfiguredAccess(app.db, fingerprint, { operation: "ofapi_fans", method: "GET", accountId: "acct_a" })).resolves.toBeUndefined();
    await expect(assertOfapiConfiguredAccess(app.db, fingerprint, { operation: "ofapi_vendor_usage", method: "GET" })).resolves.toBeUndefined();
  });
  it("saves provider evidence without creating or double-counting a ledger expense", async () => {
    const window = { from: "2026-01-01", to: "2026-01-02", groupBy: "day" as const, accountId: null, includeToday: false };
    const observation = await insertObservation(app.db, { source: "operator", producer: "ofapi:admin", platform: "onlyfans", kind: "ofapi_vendor_usage", payload: {}, payloadHash: createHash("sha256").update("{}").digest(), idempotencyKey: "usage-test" });
    const snapshot = await saveOfapiVendorUsage(app.db, { observationId: observation.observationId, fingerprint, scope: window, data: { from: window.from, to: window.to, groupBy: "day", includesToday: false, totals: { credits: 50, requests: 50 }, results: [] }, observedAt: new Date() });
    expect(snapshot).toBeGreaterThan(0);
    expect(await compareOfapiVendorUsage(app.db, window)).toEqual({ recordedCredits: 0, estimatedCredits: 0, externalResidualCredits: 0 });
    expect((await testDb.pool.query("select count(*)::int as n from ofapi_credit_ledger")).rows[0].n).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOfapiCollectionPolicy, createModel, createOnlyFansPage, createOfapiCollectionJob, ensurePageSyncStates, getOfapiCollectionSnapshot, getEffectiveOfapiCollectionPolicy, previewOfapiCollectionPolicy, reserveOfapiCollectionRequest, settleOfapiCollectionRequest, updateOfapiCollectionJob, resumeOfapiCollectionJob, getOfapiCollectionJob } from "@agency_hub_core/db";
import type { OfapiCollectionSettings } from "@agency_hub_core/shared";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase;
let pageId: number;
let app: ReturnType<typeof createTestAppContext>;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
beforeAll(async () => { const started = await startIntegrationTestDatabase(); if (!started) throw new Error("Integration database unavailable"); testDb = started; }, 120_000);
afterAll(async () => { await testDb?.stop(); });
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); server = null; });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  const model = await createModel(app.db, { slug: "policy", name: "Policy" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "policy-of" }))!.id;
});
const settings = (overrides: Partial<OfapiCollectionSettings> = {}): OfapiCollectionSettings => ({ pageId, category: "posts_comments", mode: "on_demand", intervalMinutes: 15, dailyCreditLimit: 2, maxCallsPerRun: 2, includeDetails: false, ...overrides });
const admission = (overrides: Partial<Parameters<typeof reserveOfapiCollectionRequest>[1]> = {}) => reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_gateway_posts", requestId: randomUUID(), context: { category: "posts_comments", purpose: "interactive" }, ...overrides });
async function cookie(username: string, role: "owner" | "team_lead") {
  await createUserAccount(app, { username, role, password: "synthetic-password" }, { source: "cli" });
  server ??= await buildApiServer(app);
  const response = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header[0]! : String(header)).split(";")[0]!;
}
describe("OFAPI effective collection control", () => {
  it("rejects generic jobs with no executor and directs owned uploads to their specialized approval flow", async () => {
    const owner = await cookie("owner", "owner");
    const snapshot = await getOfapiCollectionSnapshot(app.db, null);
    for (const category of ["vault_files", "core_messages", "core_payments", "core_audience"] as const) {
      const response = await server!.inject({ method: "POST", url: "/api/v1/admin/ofapi/collection/jobs", headers: { cookie: owner }, payload: { expectedRevision: 0, pageId, category, maxCalls: 2, maxCredits: 2, maxBytes: 100, from: null, to: null, selection: ["owned-source"] } });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(category === "vault_files" ? "/ofapi-media" : "existing collector");
      expect(snapshot.catalog.find(entry => entry.id === category)?.supportsOneOff).toBe(category === "vault_files");
    }
    expect((await testDb.pool.query("select count(*)::int as n from ofapi_collection_jobs")).rows[0].n).toBe(0);
  });
  it("keeps new collection off, preserves only enumerated legacy baseline, and never falls back after explicit off", async () => {
    expect(await getEffectiveOfapiCollectionPolicy(app.db, "posts_comments", pageId)).toMatchObject({ mode: "off", source: "default_off" });
    await expect(admission()).rejects.toThrow("collection_off");
    await reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_capture_posts", requestId: "baseline" });
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings({ mode: "off" })] }, 1);
    await expect(reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_capture_posts", requestId: "explicit-off" })).rejects.toThrow("collection_off");
  });
  it("preview has no egress; two windows cannot overwrite the same revision", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const input = { expectedRevision: 0, changes: [settings()] };
    expect(await previewOfapiCollectionPolicy(app.db, input)).toMatchObject({ revision: 0, cost: { source: "unknown", estimatedCredits: null } });
    expect(fetch).not.toHaveBeenCalled();
    const results = await Promise.allSettled([applyOfapiCollectionPolicy(app.db, input, 1), applyOfapiCollectionPolicy(app.db, input, 2)]);
    expect(results.map(row => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await getOfapiCollectionSnapshot(app.db, null)).audit).toHaveLength(1);
  });
  it("two workers share an atomic ceiling while interactive and background allowances stay separate", async () => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings({ mode: "scheduled", dailyCreditLimit: 1 })] }, 1);
    const results = await Promise.allSettled([admission(), admission()]);
    expect(results.map(row => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    await admission({ context: { category: "posts_comments", purpose: "background" } });
    const snapshot = await getOfapiCollectionSnapshot(app.db, null);
    expect(snapshot.policies.find(row => row.category === "posts_comments")?.usage).toMatchObject({ callsToday: 2, reservedCreditsToday: 2, actualCreditsToday: null });
  });
  it("limits apply to physical retries and unknown operation names fail closed", async () => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings({ category: "core_audience", mode: "scheduled", dailyCreditLimit: 1 })] }, 1);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "retry", _meta: { credits_used: 1 } }), { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
    await expect(client.listActiveFans!({ pageId }, "acct_test", { limit: 10 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_new_unreviewed", requestId: "unknown" })).rejects.toThrow("unregistered_operation");
  });
  it("default off stops hydration and governed worker dispatch before the dispatch fence or fetch", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
    const fence = vi.fn(async () => true);
    await expect(client.dispatchGovernedRaw!({ pageId, collectionContext: { category: "posts_comments", purpose: "background" } }, {
      attemptId: randomUUID(), operation: "ofapi_capture_posts", method: "GET", pathname: "/acct_test/posts", priorityClass: "bulk", deadlineAt: new Date(Date.now() + 10000), beforeDispatch: fence,
    })).rejects.toMatchObject({ phase: "pre_dispatch" });
    expect(fence).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await expect(client.proxyRead!({ pageId, collectionContext: { category: "posts_comments", purpose: "interactive" } }, { operation: "ofapi_gateway_posts", pathname: "/acct_test/posts", query: {}, fallbackCredits: 1, fallbackEstimated: true })).rejects.toThrow("collection_off");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("page override dominates default and an unavailable policy store does not revive baseline", async () => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings({ pageId: null })] }, 1);
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 1, changes: [settings({ mode: "off" })] }, 1);
    expect(await getEffectiveOfapiCollectionPolicy(app.db, "posts_comments", pageId)).toMatchObject({ mode: "off", source: "page" });
    await testDb.pool.query("delete from ofapi_collection_state");
    await expect(reserveOfapiCollectionRequest(app.db, { pageId, operation: "ofapi_capture_posts", requestId: "missing" })).rejects.toThrow("state_unavailable");
  });
  it("pause retains checkpoints and capture settlement; approved one-off work has call, credit and byte ceilings", async () => {
    await ensurePageSyncStates(app.db, { pageId });
    await testDb.pool.query("insert into page_sync_cursors(page_id,stream,state) values($1,'posts',$2::jsonb)", [pageId, JSON.stringify({ cursor: "saved-123" })]);
    const job = await createOfapiCollectionJob(app.db, { expectedRevision: 0, pageId, category: "posts_comments", maxCalls: 2, maxCredits: 2, maxBytes: 10, from: null, to: null, selection: [] }, 1);
    const context = { category: "posts_comments" as const, purpose: "one_off" as const, jobId: job.id };
    await admission({ context, requestId: "paid-first" });
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [], backgroundPaused: true }, 1);
    await expect(admission({ context })).rejects.toThrow("background_paused");
    await settleOfapiCollectionRequest(app.db, "paid-first", 3);
    await updateOfapiCollectionJob(app.db, job.id, { state: "running", bytesAdded: 10, checkpoint: { next: "kept" } });
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 1, changes: [], backgroundPaused: false }, 1);
    await expect(admission({ context })).rejects.toThrow("job_limit");
    expect((await testDb.pool.query("select state from page_sync_cursors where page_id=$1 and stream='posts'", [pageId])).rows[0].state).toEqual({ cursor: "saved-123" });
    expect((await getOfapiCollectionSnapshot(app.db, null)).policies.find(row => row.category === "posts_comments")?.usage.actualCreditsToday).toBe(3);
  });
  it("API permits only owner mutations and scopes team-lead reads to assigned pages", async () => {
    const owner = await cookie("owner", "owner"); const lead = await cookie("lead", "team_lead");
    const preview = await server!.inject({ method: "POST", url: "/api/v1/admin/ofapi/collection/preview", headers: { cookie: lead }, payload: { expectedRevision: 0, changes: [settings()] } });
    expect(preview.statusCode).toBe(403);
    const scoped = await server!.inject({ method: "GET", url: `/api/v1/admin/ofapi/collection?pageId=${pageId}`, headers: { cookie: lead } });
    expect(scoped.statusCode).toBe(403);
    const all = await server!.inject({ method: "GET", url: "/api/v1/admin/ofapi/collection", headers: { cookie: lead } });
    expect(all.statusCode).toBe(200); expect(all.json().pages).toEqual([]); expect(all.json().audit).toEqual([]);
    const apply = () => server!.inject({ method: "POST", url: "/api/v1/admin/ofapi/collection/apply", headers: { cookie: owner }, payload: { expectedRevision: 0, changes: [settings()] } });
    expect((await apply()).statusCode).toBe(200); expect((await apply()).statusCode).toBe(409);
  });
  it("category off parks approved work; explicit resume keeps caps/checkpoint and does not restart history", async () => {
    const job = await createOfapiCollectionJob(app.db, { expectedRevision: 0, pageId, category: "posts_comments", maxCalls: 3, maxCredits: 3, maxBytes: 100, from: null, to: null, selection: [] }, 1);
    await updateOfapiCollectionJob(app.db, job.id, { state: "running", checkpoint: { offset: 100 }, bytesAdded: 10 });
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings({ mode: "off" })] }, 1);
    await expect(admission({ context: { category: "posts_comments", purpose: "one_off", jobId: job.id } })).rejects.toThrow("job_unavailable");
    await expect(resumeOfapiCollectionJob(app.db, job.id, 0, 1)).rejects.toThrow("revision_conflict");
    expect(await resumeOfapiCollectionJob(app.db, job.id, 1, 1)).toMatchObject({ state: "queued", revision: 2 });
    const resumed = await getOfapiCollectionJob(app.db, job.id);
    expect(resumed?.checkpoint).toEqual({ offset: 100 });
    expect(Number(resumed?.max_bytes)).toBe(100); expect(Number(resumed?.used_bytes)).toBe(10);
    await admission({ context: { category: "posts_comments", purpose: "one_off", jobId: job.id } });
  });
  it("a lost dispatch fence releases the unused category reservation", async () => {
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [settings()] }, 1);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
    await expect(client.dispatchGovernedRaw!({ pageId, collectionContext: { category: "posts_comments", purpose: "interactive" } }, {
      attemptId: randomUUID(), operation: "ofapi_capture_posts", method: "GET", pathname: "/acct_test/posts", priorityClass: "interactive", deadlineAt: new Date(Date.now() + 10000), beforeDispatch: async () => false,
    })).rejects.toMatchObject({ phase: "pre_dispatch" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await getOfapiCollectionSnapshot(app.db, null)).policies.find(row => row.category === "posts_comments")?.usage.callsToday).toBe(0);
    await admission(); await admission();
  });
});

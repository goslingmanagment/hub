import { resumeOwnerOfapiTypedExport } from "../apps/runtime/src/services/ofapi-export-resume.ts";
import { prepareOwnerOfapiExportControl, readOfapiExportInventory, refreshOfapiExportInventory } from "../apps/runtime/src/services/ofapi-export-controls.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { rebuildOfapiTypedExportsProjection } from "../apps/runtime/src/services/projections/ofapi-typed-exports.ts";
import type * as DnsPromises from "node:dns/promises";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approveBlockedOfapiExportPilotJob, applyOfapiCollectionPolicy, createModel, createOnlyFansPage, getOfapiCaptureJob, getOfapiCollectionJob, listOfapiProfileVisitorsDaily, reserveOfapiCollectionRequest, setPageOfapiAccountId, settleOfapiCollectionRequest } from "@agency_hub_core/db";
import { OFAPI_TYPED_EXPORT_COLUMNS, OFAPI_TYPED_EXPORT_PROFILES } from "@agency_hub_core/shared";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createOwnerOfapiTypedExport, approveOwnerOfapiTypedExport, captureOwnerOfapiTypedArtifact, parseOfapiTypedExportArtifact } from "../apps/runtime/src/services/ofapi-typed-exports.ts";
import { buildOfapiExportQuoteRequest } from "../apps/runtime/src/services/ofapi-export-quotes.ts";
import { runOfapiTypedExportSweep } from "../apps/runtime/src/services/ofapi-typed-export-worker.ts";
import { materializeOfapiProfileVisitorsRest } from "../apps/runtime/src/services/ofapi-profile-visitors.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { startIntegrationTestDatabase, resetIntegrationDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
vi.mock("node:dns/promises", async importOriginal => ({ ...await importOriginal<typeof DnsPromises>(), lookup: vi.fn(async () => [{ address: "52.216.1.1", family: 4 }]) }));
let testDb: StartedTestDatabase; let app: ReturnType<typeof createTestAppContext>; let pageId: number; let actorId: number;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
const accountId = "acct_typed"; const exportId = "data_export_typed";
const downloadUrl = `https://example-bucket.s3.amazonaws.com/data-exports/team-test/${exportId}.csv?X-Amz-Signature=synthetic`;
const input = { profile: "profile_visitors" as const, startDate: "2026-07-01T00:00:00.000Z", endDate: "2026-07-02T23:59:59.000Z", maxRows: 10, maxCredits: 10, maxBytes: 4096, expectedPolicyRevision: 0, fanType: "all" as const, dryRun: false };
const csv = (account = accountId, date = "2026-07-01", total = "0") => Buffer.from(`${OFAPI_TYPED_EXPORT_COLUMNS.profile_visitors.join(",")}\n${account},${date},${total},0,0,0,\n`);
let responses: Record<string, unknown>[]; let vendorFetch: ReturnType<typeof vi.fn>;
beforeAll(async () => { const started = await startIntegrationTestDatabase(); if (!started) throw new Error("Integration database unavailable"); testDb = started; }, 120000);
afterAll(async () => { await testDb?.stop(); });
afterEach(async () => { vi.unstubAllGlobals(); await server?.close(); server = null; });
beforeEach(async () => {
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb, { ofapiMirrorBackgroundCaptureEnabled: false, ofapiDmDailyCreditBudget: 100, ofapiBackfillDailyCreditBudget: 100, ofapiCreditFloor: 10 });
  app.config.ofapiExpectedTeamSlug = "team-test";
  const model = await createModel(app.db, { slug: "typed", name: "Typed" });
  pageId = (await createOnlyFansPage(app.db, { modelId: model!.id, label: "typed-page" }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: accountId });
  const user = await createUserAccount(app, { username: "typed-owner", role: "owner", password: "synthetic-password" }, { source: "cli" }); actorId = user!.id;
  await testDb.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at,updated_at) values(1,1000,now(),now()) on conflict(id) do update set last_balance=1000,last_balance_at=now(),updated_at=now()");
  responses = [];
  vendorFetch = vi.fn(async (url: URL | string) => {
    if (String(url).startsWith("https://example-bucket.s3.amazonaws.com/")) return new Response(csv(), { headers: { "content-type": "text/csv" } });
    const body = responses.shift(); if (!body) throw new Error(`Unexpected vendor request ${String(url)}`);
    return new Response(JSON.stringify({ ...body, _meta: { _credits: { used: 0, balance: 1000 } } }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", vendorFetch);
  app.ofapi = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, ...ofapiCollectionPolicyHooks(app.db) });
});
function identity(extra: Record<string, unknown>) { return { data: { id: exportId, type: "profile_visitors", start_date: input.startDate, end_date: input.endDate, file_type: "csv", accounts: [{ id: accountId }], ...extra } }; }
async function createQuoted(maxCredits = input.maxCredits) {
  const created = await createOwnerOfapiTypedExport(app, { ...input, pageId, maxCredits }, actorId);
  responses.push(identity({ status: "calculating_credits_completed", total_rows: 1, credit_cost: 1 }));
  expect((await runOfapiTypedExportSweep(app))[0]?.kind).toBe("success");
  expect((await runOfapiTypedExportSweep(app))[0]?.kind).toBe("blocked");
  return (await getOfapiCaptureJob(app.db, created.jobId!))!;
}
async function completed(creditCost = 1, terminalStatus: "completed" | "failed" = "completed") {
  const quoted = await createQuoted();
  await approveOwnerOfapiTypedExport(app, { jobId: quoted.id, expectedRowVersion: quoted.rowVersion, approvedMaxCredits: 2, reason: "bounded test", dryRun: false }, actorId);
  responses.push({ data: { id: exportId, status: "pending" } }, identity({ status: terminalStatus, total_rows: 1, rows_processed: 1, credit_cost: creditCost, failed_downloads: 0, download_url: downloadUrl }));
  expect((await runOfapiTypedExportSweep(app))[0]?.kind).toBe("success");
  expect((await runOfapiTypedExportSweep(app))[0]?.kind).toBe("success");
  await testDb.pool.query("update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second' where id=$1", [quoted.id]);
  expect((await runOfapiTypedExportSweep(app))[0]?.kind).toBe("success");
  expect((await runOfapiTypedExportSweep(app))[0]?.kind).toBe("blocked");
  return (await getOfapiCaptureJob(app.db, quoted.id))!;
}
describe("bounded typed exports and visitor coverage", () => {
  it("runs quote → separate approval → captured status → safe download → source-attributed daily report with legacy capture off", async () => {
    expect(await createOwnerOfapiTypedExport(app, { ...input, pageId, dryRun: true }, actorId)).toMatchObject({ state: "preview", estimatedCredits: 1 });
    expect(vendorFetch).not.toHaveBeenCalled();
    const job = await completed();
    expect(job).toMatchObject({ reasonCode: "artifact_capture_required", spentCredits: 1 });
    const firstRequest = vendorFetch.mock.calls[0]!; const createBody = JSON.parse(Buffer.from((firstRequest[1] as RequestInit).body as Uint8Array).toString("utf8"));
    expect(createBody).toMatchObject({ type: "profile_visitors", auto_start: false, export_columns: OFAPI_TYPED_EXPORT_COLUMNS.profile_visitors });
    expect(vendorFetch.mock.calls.filter(call => String(call[0]).endsWith("/start"))).toHaveLength(1);
    const imported = await captureOwnerOfapiTypedArtifact(app, { jobId: job.id, expectedRowVersion: job.rowVersion, reason: "Import verified vendor artifact" }, actorId);
    expect(imported).toMatchObject({ rowCount: 1, sha256: createHash("sha256").update(csv()).digest("hex"), duplicate: false });
    expect(await captureOwnerOfapiTypedArtifact(app, { jobId: job.id, expectedRowVersion: job.rowVersion, reason: "Replay receipt" }, actorId)).toMatchObject({ duplicate: true });
    const days = await listOfapiProfileVisitorsDaily(app.db, { pageId, from: "2026-07-01", to: "2026-07-02", source: "export" });
    expect(days).toMatchObject([{ date: "2026-07-01", totalVisitors: 0, avgViewDuration: null, availability: "complete", source: "export" }, { date: "2026-07-02", totalVisitors: null, source: "missing", availability: "missing" }]);
    expect((await getOfapiCollectionJob(app.db, String(job.target.collectionJobId)))?.state).toBe("completed");
    expect((await rebuildOfapiTypedExportsProjection(app, { accountId: pageId })).applied).toBe(1);
    expect(await listOfapiProfileVisitorsDaily(app.db, { pageId, from: "2026-07-01", to: "2026-07-02", source: "export" })).toEqual(days);
    expect((await getOfapiCaptureJob(app.db, job.id))?.state).toBe("complete");
    expect((await testDb.pool.query("select state,actual_credits::text from ofapi_collection_requests where operation='ofapi_export_start'")).rows).toEqual([{ state: "captured", actual_credits: "1" }]);
  });
  it("resumes the exact funded export cursor after pause while free polls leave start authority unchanged", async () => {
    const quoted = await createQuoted(2);
    await approveOwnerOfapiTypedExport(app, { jobId: quoted.id, expectedRowVersion: quoted.rowVersion, approvedMaxCredits: 2, reason: "full task cap", dryRun: false }, actorId);
    responses.push({ data: { id: exportId, status: "pending" } });
    await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    const pending = (await getOfapiCaptureJob(app.db, quoted.id))!;
    const collectionId = String(pending.target.collectionJobId);
    expect(Number((await getOfapiCollectionJob(app.db, collectionId))?.used_credits)).toBe(2);
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [], backgroundPaused: true }, actorId);
    await testDb.pool.query("update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second' where id=$1", [quoted.id]);
    await runOfapiTypedExportSweep(app);
    const paused = (await getOfapiCaptureJob(app.db, quoted.id))!;
    expect(paused.reasonCode).toBe("background_paused");
    const snapshot = { jobId: paused.id, expectedRowVersion: paused.rowVersion, expectedPolicyRevision: 1, reason: "resume existing authority" };
    await expect(resumeOwnerOfapiTypedExport(app, snapshot, actorId)).rejects.toThrow("paused");
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 1, changes: [], backgroundPaused: false }, actorId);
    await expect(resumeOwnerOfapiTypedExport(app, snapshot, actorId)).rejects.toThrow("policy changed");
    await expect(resumeOwnerOfapiTypedExport(app, { ...snapshot, expectedPolicyRevision: 2, expectedRowVersion: paused.rowVersion - 1 }, actorId)).rejects.toThrow("snapshot");
    await testDb.pool.query("update pages set ofapi_account_id='acct_changed' where id=$1", [pageId]);
    await expect(resumeOwnerOfapiTypedExport(app, { ...snapshot, expectedPolicyRevision: 2 }, actorId)).rejects.toThrow("binding changed");
    await testDb.pool.query("update pages set ofapi_account_id=$2 where id=$1", [pageId, accountId]);
    server = await buildApiServer(app);
    const login = await server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "typed-owner", password: "synthetic-password" } });
    const raw = login.headers["set-cookie"]; const cookie = (Array.isArray(raw) ? raw[0]! : String(raw)).split(";")[0]!;
    const response = await server.inject({ method: "POST", url: `/api/v1/admin/ofapi/exports/${quoted.id}/resume`, headers: { cookie }, payload: { expectedRowVersion: paused.rowVersion, expectedPolicyRevision: 2, reason: "same allowance" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(await getOfapiCaptureJob(app.db, quoted.id)).toMatchObject({ state: "ready", cursor: pending.cursor, maxCredits: pending.maxCredits, maxCalls: pending.maxCalls });
    await testDb.pool.query("update ofapi_collection_jobs set state='paused',reason='owner_paused' where id=$1", [collectionId]);
    await runOfapiTypedExportSweep(app);
    const locallyPaused = (await getOfapiCaptureJob(app.db, quoted.id))!;
    expect(locallyPaused.reasonCode).toBe("job_unavailable");
    await resumeOwnerOfapiTypedExport(app, { jobId: quoted.id, expectedRowVersion: locallyPaused.rowVersion, expectedPolicyRevision: 2, reason: "resume owner-paused task" }, actorId);
    responses.push(identity({ status: "completed", total_rows: 1, rows_processed: 1, credit_cost: 1, failed_downloads: 0, download_url: downloadUrl }));
    await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    expect(await getOfapiCaptureJob(app.db, quoted.id)).toMatchObject({ reasonCode: "artifact_capture_required", spentCredits: 1 });
    expect(vendorFetch.mock.calls.filter(call => String(call[0]).endsWith("/start"))).toHaveLength(1);
    expect((await testDb.pool.query("select reserved_credits::text,actual_credits::text from ofapi_collection_requests where operation='ofapi_export_quote_status'")).rows).toEqual([{ reserved_credits: "0", actual_credits: "0" }]);
  });
  it("refuses to revive uncertain stateful export attempts through pause recovery", async () => {
    const quoted = await createQuoted(2);
    await approveOwnerOfapiTypedExport(app, { jobId: quoted.id, expectedRowVersion: quoted.rowVersion, approvedMaxCredits: 2, reason: "bounded", dryRun: false }, actorId);
    vendorFetch.mockImplementationOnce(async () => { throw new Error("synthetic lost response"); });
    await runOfapiTypedExportSweep(app);
    const unknown = (await getOfapiCaptureJob(app.db, quoted.id))!;
    expect(unknown.reasonCode).toBe("indeterminate");
    await expect(resumeOwnerOfapiTypedExport(app, { jobId: unknown.id, expectedRowVersion: unknown.rowVersion, expectedPolicyRevision: 0, reason: "cannot repeat" }, actorId)).rejects.toThrow("safely resumable");
    // Even a subsequently recorded policy stop cannot hide the retained uncertain intent.
    await testDb.pool.query("update ofapi_capture_jobs set reason_code='background_paused' where id=$1", [unknown.id]);
    await expect(resumeOwnerOfapiTypedExport(app, { jobId: unknown.id, expectedRowVersion: unknown.rowVersion, expectedPolicyRevision: 0, reason: "still cannot repeat" }, actorId)).rejects.toThrow("uncertain");
    await runOfapiTypedExportSweep(app);
    expect(vendorFetch.mock.calls.filter(call => String(call[0]).endsWith("/start"))).toHaveLength(1);
  });
  it("keeps the chat pilot gate separate and never starts without reviewed approval", async () => {
    const quoted = await createQuoted();
    expect(await approveBlockedOfapiExportPilotJob(app.db, { jobId: quoted.id, expectedRowVersion: quoted.rowVersion, approvedMaxCredits: 2, reason: "wrong endpoint", actorUserId: actorId, execute: true })).toMatchObject({ outcome: "conflict" });
    expect(await approveOwnerOfapiTypedExport(app, { jobId: quoted.id, expectedRowVersion: quoted.rowVersion, approvedMaxCredits: 2, reason: "preview", dryRun: true }, actorId)).toMatchObject({ dryRun: true });
    expect((await getOfapiCaptureJob(app.db, quoted.id))?.state).toBe("blocked");
    expect(await runOfapiTypedExportSweep(app)).toEqual([]);
    expect(vendorFetch).toHaveBeenCalledTimes(1);
  });
  it("captures rejected account bytes before parsing and refuses to replace the frozen artifact", async () => {
    const job = await completed(); const wrong = csv("acct_other");
    const oversized = Buffer.alloc(1_000_000, 97);
    await expect(captureOwnerOfapiTypedArtifact(app, { jobId: job.id, expectedRowVersion: job.rowVersion, csvBase64: oversized.toString("base64"), expectedSha256: createHash("sha256").update(oversized).digest("hex"), reason: "bounded manual import" }, actorId)).rejects.toThrow("byte ceiling");
    await expect(captureOwnerOfapiTypedArtifact(app, { jobId: job.id, expectedRowVersion: job.rowVersion, csvBase64: wrong.toString("base64"), expectedSha256: createHash("sha256").update(wrong).digest("hex"), reason: "test wrong account" }, actorId)).rejects.toThrow("different account");
    expect((await testDb.pool.query("select state from ofapi_typed_export_artifacts")).rows).toEqual([{ state: "rejected" }]);
    expect((await testDb.pool.query("select count(*)::text from ofapi_profile_visitors_daily")).rows[0].count).toBe("0");
    await expect(captureOwnerOfapiTypedArtifact(app, { jobId: job.id, expectedRowVersion: job.rowVersion, reason: "different bytes" }, actorId)).rejects.toThrow("Different artifact bytes");
    expect((await getOfapiCaptureJob(app.db, job.id))?.state).toBe("blocked");
  });
  it("records an actual vendor overrun before blocking, and repeated reconciliation is idempotent", async () => {
    const job = await completed(5); expect(job.reasonCode).toBe("export_budget_exceeded"); expect(job.spentCredits).toBe(5);
    const start = String(job.cursor?.startAttemptId);
    await settleOfapiCollectionRequest(app.db, start, 5); await settleOfapiCollectionRequest(app.db, start, null);
    expect(Number((await getOfapiCollectionJob(app.db, String(job.target.collectionJobId)))?.used_credits)).toBe(5);
    expect((await testDb.pool.query("select actual_credits::text from ofapi_collection_requests where request_id=$1", [start])).rows[0].actual_credits).toBe("5");
  });
  it("preserves REST categories separately, refuses coarse ranges, and never turns missing duration into an average", async () => {
    const base = { pageId, accountId, startDate: "2026-07-01T00:00:00Z", endDate: "2026-07-01T23:59:59Z", observationId: 1, observationReceivedAt: new Date(), body: { data: { isAvailable: true, hasStats: true, chart: { visitors: [{ date: "2026-07-01", count: 0 }], duration: [{ date: "2026-07-01", count: 4 }] } } } };
    await materializeOfapiProfileVisitorsRest(app.db, { ...base, type: "total" });
    await materializeOfapiProfileVisitorsRest(app.db, { ...base, type: "users" });
    await expect(materializeOfapiProfileVisitorsRest(app.db, { ...base, type: "total", endDate: "2026-07-02T23:59:59Z" })).rejects.toThrow("one-day");
    const result = await listOfapiProfileVisitorsDaily(app.db, { pageId, from: "2026-07-01", to: "2026-07-01", source: "rest" });
    expect(result[0]).toMatchObject({ totalVisitors: 0, userVisitors: null, chartDuration: "4", avgViewDuration: null, availability: "partial" });
    expect((await listOfapiProfileVisitorsDaily(app.db, { pageId, from: "2026-07-01", to: "2026-07-01", source: "export" }))[0]?.availability).toBe("missing");
  });
  it("exports every supported typed profile with explicit columns, bounded identity and free quote mode", async () => {
    for (const profile of OFAPI_TYPED_EXPORT_PROFILES) {
      const created = await createOwnerOfapiTypedExport(app, { ...input, pageId, profile }, actorId);
      const job = (await getOfapiCaptureJob(app.db, created.jobId!))!;
      const plan = buildOfapiExportQuoteRequest({ ...job, state: "leased" })!;
      expect(JSON.parse(plan.bodyBytes!.toString())).toMatchObject({ type: profile, auto_start: false, export_columns: OFAPI_TYPED_EXPORT_COLUMNS[profile] });
      if (profile !== "profile_visitors") {
        const table = OFAPI_TYPED_EXPORT_COLUMNS[profile]; const row = table.map(key => key === "account_id" ? accountId : key === "onlyfans_id" ? "123" : key === "link_url" ? "https://onlyfans.com/link/test" : "");
        const cursor = { phase: "artifact_pending", vendorExportId: exportId, vendorStatus: "completed", pollCount: 1, quoteRequestedAt: new Date().toISOString(), lastStatusAt: new Date().toISOString(), lastObservationId: null, lastObservationReceivedAt: null, rowsProcessed: 1 };
        const parsed = parseOfapiTypedExportArtifact({ ...job, cursor } as typeof job, Buffer.from(`${table.join(",")}\n${row.join(",")}\n`));
        expect(parsed[0]?.data.account_id).toBe(accountId);
      }
      await testDb.pool.query("update ofapi_capture_jobs set state='cancelled',completed_at=now() where id=$1", [job.id]);
    }
  });
  it("page erasure removes populated policy, request, artifact and visitor records before parent jobs", async () => {
    const job = await completed(); await captureOwnerOfapiTypedArtifact(app, { jobId: job.id, expectedRowVersion: job.rowVersion, reason: "erasure fixture" }, actorId);
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [{ pageId, category: "visitors", mode: "off", dailyCreditLimit: 5, intervalMinutes: 60, maxCallsPerRun: 1, includeDetails: false }] }, actorId);
    const appForErasure = { ...app, pool: testDb.pool, config: { ...app.config, lakeDir: "/nonexistent-lake-dir" } };
    const scope = { scopeType: "page" as const, pageLabel: "typed-page" };
    const plan = await planErasure(appForErasure, scope);
    for (const name of ["ofapi_collection_policies", "ofapi_collection_jobs", "ofapi_collection_requests", "ofapi_typed_export_artifacts", "ofapi_typed_export_rows", "ofapi_profile_visitors_daily"]) expect(plan.targets.find(target => target.target === name)?.rows).toBeGreaterThan(0);
    await executeErasure(appForErasure, scope, { initiatedBy: actorId });
    for (const name of ["ofapi_collection_policies", "ofapi_collection_jobs", "ofapi_collection_requests", "ofapi_typed_export_artifacts", "ofapi_typed_export_rows", "ofapi_profile_visitors_daily"]) expect((await testDb.pool.query(`select count(*)::text from ${name}`)).rows[0].count).toBe("0");
  });
  it("owner report GETs are local and unassigned team leads cannot read or mutate the page", async () => {
    await createUserAccount(app, { username: "typed-lead", role: "team_lead", password: "synthetic-password" }, { source: "cli" });
    server = await buildApiServer(app);
    async function cookie(username: string) { const response = await server!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password: "synthetic-password" } }); const raw = response.headers["set-cookie"]; return (Array.isArray(raw) ? raw[0]! : String(raw)).split(";")[0]!; }
    const owner = await cookie("typed-owner"), lead = await cookie("typed-lead");
    const url = `/api/v1/admin/ofapi/profile-visitors?pageId=${pageId}&from=2026-07-01&to=2026-07-02`;
    expect((await server.inject({ method: "GET", url, headers: { cookie: owner } })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url, headers: { cookie: lead } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/ofapi/exports", headers: { cookie: lead }, payload: { ...input, pageId } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/ofapi/exports/00000000-0000-4000-8000-000000000000/resume", headers: { cookie: lead }, payload: { expectedRowVersion: 0, expectedPolicyRevision: 0, reason: "forbidden" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/ofapi/export-inventory", headers: { cookie: owner } })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/v1/admin/ofapi/export-inventory", headers: { cookie: lead } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/v1/admin/ofapi/export-inventory/refresh", headers: { cookie: lead }, payload: { type: "profile_visitors" } })).statusCode).toBe(403);
    expect(vendorFetch).not.toHaveBeenCalled();
  });
  it("allows an unknown visitor quote only within the frozen day cap and rejects unknown fan pricing", async () => {
    for (const profile of ["profile_visitors", "fans"] as const) {
      const created = await createOwnerOfapiTypedExport(app, { ...input, pageId, profile }, actorId);
      responses.push({ data: { ...(identity({ status: "calculating_credits_completed", requires_scraping: true, auto_started: false }).data), type: profile, ...(profile === "fans" ? { effective_options: { type: "all" } } : {}) } });
      await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
      const job = (await getOfapiCaptureJob(app.db, created.jobId!))!;
      expect(job.reasonCode).toBe("export_quote_requires_start");
      const approval = approveOwnerOfapiTypedExport(app, { jobId: job.id, expectedRowVersion: job.rowVersion, approvedMaxCredits: 1, reason: "unknown quote review", dryRun: true }, actorId);
      if (profile === "profile_visitors") await expect(approval).resolves.toMatchObject({ dryRun: true });
      else await expect(approval).rejects.toThrow("conflict");
      await testDb.pool.query("update ofapi_capture_jobs set state='cancelled',completed_at=now() where id=$1", [job.id]);
    }
  });
  it("previews and cancels exactly once under background pause, retaining original export charges", async () => {
    const quote = await createQuoted();
    await approveOwnerOfapiTypedExport(app, { jobId: quote.id, expectedRowVersion: quote.rowVersion, approvedMaxCredits: 2, reason: "start", dryRun: false }, actorId);
    responses.push({ data: { id: exportId, status: "pending" } }); await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    const source = (await getOfapiCaptureJob(app.db, quote.id))!;
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [], backgroundPaused: true }, actorId);
    const action = { jobId: source.id, action: "cancel" as const, expectedRowVersion: source.rowVersion, expectedPolicyRevision: 1, approvedMaxCredits: 1, reason: "Cancel bounded export", dryRun: true };
    expect(await prepareOwnerOfapiExportControl(app, action, actorId)).toMatchObject({ dryRun: true, maximumCredits: 0 });
    expect((await getOfapiCaptureJob(app.db, source.id))?.state).toBe("retry_wait");
    const control = await prepareOwnerOfapiExportControl(app, { ...action, dryRun: false }, actorId);
    await expect(prepareOwnerOfapiExportControl(app, { ...action, dryRun: false }, actorId)).rejects.toThrow("snapshot changed");
    expect((await getOfapiCaptureJob(app.db, source.id))?.reasonCode).toBe("vendor_cancel_pending");
    responses.push({ data: { id: exportId, status: "cancelled" } }); await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    expect((await getOfapiCaptureJob(app.db, source.id))?.state).toBe("cancelled");
    expect((await getOfapiCaptureJob(app.db, source.id))?.spentCredits).toBe(2);
    expect((await getOfapiCaptureJob(app.db, control.jobId!))?.state).toBe("cancelled");
    expect(vendorFetch.mock.calls.filter(call => (call[1] as RequestInit).method === "DELETE")).toHaveLength(1);
    expect(await runOfapiTypedExportSweep(app)).toEqual([]);
  });
  it.each(["rejected", "unknown"] as const)("reconciles a %s cancellation with captured GET and never repeats DELETE", async failure => {
    const quote = await createQuoted();
    await approveOwnerOfapiTypedExport(app, { jobId: quote.id, expectedRowVersion: quote.rowVersion, approvedMaxCredits: 2, reason: "start", dryRun: false }, actorId);
    responses.push({ data: { id: exportId, status: "pending" } }); await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    const source = (await getOfapiCaptureJob(app.db, quote.id))!;
    const control = await prepareOwnerOfapiExportControl(app, { jobId: source.id, action: "cancel", expectedRowVersion: source.rowVersion, expectedPolicyRevision: 0, approvedMaxCredits: 1, reason: "cancel once", dryRun: false }, actorId);
    vendorFetch.mockImplementationOnce(async () => {
      if (failure === "unknown") throw new Error("synthetic lost cancellation acknowledgment");
      return new Response(JSON.stringify({ error: "export already finished" }), { status: 422 });
    });
    await runOfapiTypedExportSweep(app);
    if (failure === "rejected") await runOfapiTypedExportSweep(app);
    expect(await getOfapiCaptureJob(app.db, control.jobId!)).toMatchObject({ state: "blocked", reasonCode: failure === "unknown" ? "indeterminate" : "export_cancel_http_422" });
    responses.push(identity({ status: "cancelled" }));
    await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    expect(await getOfapiCaptureJob(app.db, source.id)).toMatchObject({ state: "cancelled", reasonCode: "vendor_cancelled", spentCredits: 2 });
    expect(vendorFetch.mock.calls.filter(call => (call[1] as RequestInit).method === "DELETE")).toHaveLength(1);
    expect(await runOfapiTypedExportSweep(app)).toEqual([]);
  });
  it("a separately approved paid retry captures the new export identity and reaches artifact import", async () => {
    const source = await completed(1, "failed");
    expect(source.reasonCode).toBe("export_failed");
    const action = { jobId: source.id, action: "retry" as const, expectedRowVersion: source.rowVersion, expectedPolicyRevision: 0, approvedMaxCredits: 2, reason: "New bounded paid retry", dryRun: true };
    expect(await prepareOwnerOfapiExportControl(app, action, actorId)).toMatchObject({ maximumCredits: 2, jobId: null });
    const control = await prepareOwnerOfapiExportControl(app, { ...action, dryRun: false }, actorId);
    const newId = "data_export_retry";
    responses.push({ data: { id: newId, original_id: exportId, type: "profile_visitors", status: "pending" } });
    await runOfapiTypedExportSweep(app);
    expect((await getOfapiCaptureJob(app.db, control.jobId!))?.spentCredits).toBe(2);
    await runOfapiTypedExportSweep(app);
    const started = (await getOfapiCaptureJob(app.db, control.jobId!))!;
    expect(started.cursor).toMatchObject({ vendorExportId: newId, phase: "in_progress" });
    responses.push(identity({ id: newId, status: "completed", total_rows: 1, rows_processed: 1, failed_downloads: 0, credit_cost: 1, download_url: downloadUrl.replaceAll(exportId, newId) }));
    await testDb.pool.query("update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second' where id=$1", [control.jobId]);
    await runOfapiTypedExportSweep(app); await runOfapiTypedExportSweep(app);
    const ready = (await getOfapiCaptureJob(app.db, control.jobId!))!;
    expect(await captureOwnerOfapiTypedArtifact(app, { jobId: ready.id, expectedRowVersion: ready.rowVersion, reason: "Import retried export" }, actorId)).toMatchObject({ state: "imported" });
    expect((await getOfapiCaptureJob(app.db, source.id))?.spentCredits).toBe(1);
    expect((await getOfapiCaptureJob(app.db, ready.id))?.spentCredits).toBe(1);
    expect(vendorFetch.mock.calls.filter(call => String(call[0]).endsWith("/retry"))).toHaveLength(1);
    expect(vendorFetch.mock.calls.filter(call => String(call[0]).endsWith("/start"))).toHaveLength(1);
  });
  it("does not repeat an indeterminate retry or accept a stale approval", async () => {
    const source = await completed(1, "failed");
    const action = { jobId: source.id, action: "retry" as const, expectedRowVersion: source.rowVersion, expectedPolicyRevision: 0, approvedMaxCredits: 2, reason: "Indeterminate bounded retry", dryRun: false };
    const control = await prepareOwnerOfapiExportControl(app, action, actorId);
    vendorFetch.mockImplementationOnce(async () => { throw new Error("synthetic connection lost after dispatch"); });
    await runOfapiTypedExportSweep(app);
    expect(await getOfapiCaptureJob(app.db, control.jobId!)).toMatchObject({ state: "blocked", reasonCode: "indeterminate" });
    const count = vendorFetch.mock.calls.length; expect(await runOfapiTypedExportSweep(app)).toEqual([]); expect(vendorFetch).toHaveBeenCalledTimes(count);
    await expect(prepareOwnerOfapiExportControl(app, action, actorId)).rejects.toThrow("snapshot changed");
  });
  it("captures a free provider inventory page globally and serves a capability-free local summary", async () => {
    app.ofapi = createOfapiClient({ apiKey: "synthetic", restDelayMs: 0, onAdminResponse: ofapiCredentialPolicy(app.db, app.config, app.logger).onAdminResponse });
    expect((await readOfapiExportInventory(app)).rows).toEqual([]); expect(vendorFetch).not.toHaveBeenCalled();
    responses.push({ data: { data: [{ id: exportId, type: "profile_visitors", status: "completed", total_rows: 1, rows_processed: 1, credit_cost: 1, download_url: downloadUrl, accounts: [{ id: accountId }] }], meta: { current_page: 1, last_page: 1 } } });
    const observed = await refreshOfapiExportInventory(app, { page: 1, perPage: 25, type: "profile_visitors" });
    expect(observed.rows[0]).toMatchObject({ id: exportId, accounts: [accountId] });
    expect(JSON.stringify(observed)).not.toContain("X-Amz-Signature");
    expect(await readOfapiExportInventory(app)).toEqual(observed); expect(vendorFetch).toHaveBeenCalledTimes(1);
    expect((await testDb.pool.query("select account_id from observations where id=$1", [observed.observationId])).rows[0].account_id).toBeNull();
  });
  it("free polling counts against the bounded request cap and pause fences physical requests", async () => {
    const quoted = await createQuoted(); const context = { category: "visitors" as const, purpose: "one_off" as const, jobId: String(quoted.target.collectionJobId), reservedCredits: 0 };
    await testDb.pool.query("update ofapi_collection_jobs set max_calls=2 where id=$1", [context.jobId]);
    await reserveOfapiCollectionRequest(app.db, { operation: "ofapi_export_quote_status", pageId, requestId: "free-poll", context, reservedCredits: 0 });
    await expect(reserveOfapiCollectionRequest(app.db, { operation: "ofapi_export_quote_status", pageId, requestId: "over-cap", context, reservedCredits: 0 })).rejects.toThrow("job_limit");
    await applyOfapiCollectionPolicy(app.db, { expectedRevision: 0, changes: [], backgroundPaused: true }, actorId);
    await expect(reserveOfapiCollectionRequest(app.db, { operation: "ofapi_export_quote_status", pageId, requestId: "paused", context, reservedCredits: 0 })).rejects.toThrow("background_paused");
  });
});

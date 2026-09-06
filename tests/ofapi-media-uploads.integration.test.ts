import { runMediaPlaneProjection } from "../apps/runtime/src/services/projections/media-plane.ts";
import { getOfapiAsyncLifecycle } from "../apps/runtime/src/services/ofapi-async-lifecycle.ts";
import { encryptJson } from "@agency_hub_core/shared";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  applyOfapiCollectionPolicy,
  createModel,
  createOnlyFansPage,
  createOfapiCollectionJob,
  getOfapiCaptureJob,
  listPendingOfapiCollectionJobs,
  claimOfapiCollectionJob,
  setPageOfapiAccountId,
  reserveOfapiProviderOperation,
  upsertOfapiWebhookConfig,
} from "@agency_hub_core/db";
import { createTestAppContext } from "./helpers/runtime.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import {
  captureOwnerOfapiMediaSource,
  createOwnerOfapiMediaUpload,
  resumeOwnerOfapiMediaUpload,
} from "../apps/runtime/src/services/ofapi-media-sources.ts";
import {
  handoffOfapiMedia,
  readOfapiMedia,
} from "../apps/runtime/src/services/ofapi-media-catalog.ts";
import { runOfapiMediaUploadSweep } from "../apps/runtime/src/services/ofapi-media-worker.ts";
import { runOfapiCollectionJob } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { ofapiCollectionHandlers } from "../apps/runtime/src/services/ofapi-collection-handlers.ts";
import {
  recordOfapiMediaFacts,
  rebuildOfapiMediaProjection,
} from "../apps/runtime/src/services/projections/ofapi-media.ts";
import { processOfapiWebhookEvent } from "../apps/runtime/src/services/ofapi-events.ts";
import {
  executeErasure,
  planErasure,
} from "../apps/runtime/src/services/erasure/index.ts";
let db: StartedTestDatabase;
let app: ReturnType<typeof createTestAppContext>;
let pageId: number, actor: number;
let server: Awaited<ReturnType<typeof buildApiServer>>;
const account = "acct_media",
  token = "ofapi_media_test",
  secret = "synthetic-secret";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const sha = createHash("sha256").update(png).digest("hex");
let responses: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("DB required");
  db = started;
}, 120000);
afterAll(async () => {
  await db?.stop();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
});
beforeEach(async () => {
  await resetIntegrationDatabase(db.pool);
  app = createTestAppContext(db, {
    ofapiMirrorBackgroundCaptureEnabled: false,
    ofapiDmDailyCreditBudget: 100,
    ofapiBackfillDailyCreditBudget: 100,
    ofapiCreditFloor: 10,
    ofapiDesktopCommandOutboxEnabled: true,
  });
  const model = await createModel(app.db, { slug: "media", name: "Media" });
  pageId = (await createOnlyFansPage(app.db, {
    modelId: model!.id,
    label: "media-page",
  }))!.id;
  await setPageOfapiAccountId(app.db, { pageId, ofapiAccountId: account });
  actor = (await createUserAccount(
    app,
    { username: "owner", role: "owner", password: "synthetic-password" },
    { source: "cli" },
  ))!.id;
  await db.pool.query(
    "insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,1000,now()) on conflict(id) do update set last_balance=1000,last_balance_at=now()",
  );
  responses = [];
  fetchMock = vi.fn(async () => {
    const body = responses.shift();
    if (!body) throw new Error("Unexpected synthetic vendor request");
    return new Response(
      JSON.stringify({
        ...body,
        _meta: { _credits: { used: 0, balance: 1000 } },
      }),
      {
        status: body.polling_url ? 202 : 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  app.ofapi = createOfapiClient({
    apiKey: "synthetic",
    restDelayMs: 0,
    ...ofapiCollectionPolicyHooks(app.db),
  });
  await upsertOfapiWebhookConfig(app.db, {
    externalWebhookId: "wh_media",
    endpointUrl: "https://example.test/webhook",
    accountScope: "global",
    events: ["media_uploads.completed", "media_uploads.failed"],
    encryptedSigningSecret: JSON.stringify(
      encryptJson(
        secret,
        app.config.encryptionKey,
        app.config.encryptionKeyVersion,
      ),
    ),
  });
  server = await buildApiServer(app);
});
const read = () => readOfapiMedia(app, { pageId, offset: 0, limit: 50 });
async function source() {
  return captureOwnerOfapiMediaSource(
    app,
    {
      pageId,
      filename: "own.png",
      fileBase64: png.toString("base64"),
      expectedSha256: sha,
    },
    actor,
  );
}
async function upload(destination: "vault" | "cdn" = "vault") {
  const saved = await source();
  const body = {
    pageId,
    sourceId: saved.id,
    destination,
    requestId: randomUUID(),
    expectedPolicyRevision: 0,
    maxCredits: 3,
    dryRun: false,
  };
  const created = await createOwnerOfapiMediaUpload(app, body, actor);
  return { body, id: created.jobId!, source: saved };
}
async function pending(destination: "vault" | "cdn" = "vault") {
  const job = await upload(destination);
  responses.push({
    status: "pending",
    prefixed_id: token,
    polling_url: `https://app.onlyfansapi.com/api/${account}/media/uploads/${token}/status`,
  });
  await runOfapiMediaUploadSweep(app);
  await runOfapiMediaUploadSweep(app);
  return job;
}
async function status(id: string, extra: Record<string, unknown>) {
  responses.push({
    status: "completed",
    prefixed_id: token,
    media: {
      id: 123,
      type: "photo",
      isReady: true,
      hasError: false,
      canView: true,
      files: { full: { size: png.length, width: 1, height: 1 } },
      releaseForms: [{ id: 7, name: "Reviewed", status: "approved" }],
    },
    credits_used: 1,
    ...extra,
  });
  await db.pool.query(
    "update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second' where id=$1",
    [id],
  );
  await runOfapiMediaUploadSweep(app);
  await runOfapiMediaUploadSweep(app);
}
async function webhook(
  payload: Record<string, unknown>,
  key = randomUUID(),
  acct = account,
) {
  const body = JSON.stringify({
    event: "media_uploads.completed",
    account_id: acct,
    payload,
  });
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/ofapi/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      signature: createHmac("sha256", secret).update(body).digest("hex"),
      "x-ofapi-idempotency-key": key,
    },
  });
  expect(response.statusCode).toBe(200);
  const row = (
    await db.pool.query(
      "select id from ofapi_webhook_events order by id desc limit 1",
    )
  ).rows[0];
  await processOfapiWebhookEvent(app, Number(row.id));
  return response.json();
}
describe("owned OFAPI uploads and vault catalog", () => {
  it("captures source custody, previews free, dispatches async multipart once and provides a verified reusable vault ID", async () => {
    const saved = await source();
    expect(await source()).toEqual(saved);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = {
      pageId,
      sourceId: saved.id,
      destination: "vault" as const,
      requestId: randomUUID(),
      expectedPolicyRevision: 0,
      maxCredits: 3,
      dryRun: true,
    };
    expect(await createOwnerOfapiMediaUpload(app, body, actor)).toMatchObject({
      estimatedCredits: 1,
      state: "preview",
      jobId: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const first = await createOwnerOfapiMediaUpload(
      app,
      { ...body, dryRun: false },
      actor,
    );
    expect(await listPendingOfapiCollectionJobs(app.db)).toEqual([]);
    expect(
      await claimOfapiCollectionJob(
        app.db,
        String(
          (await getOfapiCaptureJob(app.db, first.jobId!))!.target
            .collectionJobId,
        ),
      ),
    ).toBeNull();
    expect(
      (
        await createOwnerOfapiMediaUpload(
          app,
          { ...body, dryRun: false },
          actor,
        )
      ).jobId,
    ).toBe(first.jobId);
    responses.push({
      status: "pending",
      prefixed_id: token,
      polling_url: `https://app.onlyfansapi.com/api/${account}/media/uploads/${token}/status`,
    });
    await runOfapiMediaUploadSweep(app);
    await runOfapiMediaUploadSweep(app);
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const multipart = Buffer.from(request.body as Uint8Array);
    expect(multipart.includes(png)).toBe(true);
    expect(multipart.toString()).toContain('name="async"\r\n\r\ntrue');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `https://app.onlyfansapi.com/api/${account}/media/vault`,
    );
    await status(first.jobId!, {});
    const job = (await getOfapiCaptureJob(app.db, first.jobId!))!;
    expect(job).toMatchObject({ state: "complete", spentCredits: 1 });
    expect(
      await handoffOfapiMedia(
        app,
        {
          pageId,
          jobId: job.id,
          expectedRowVersion: job.rowVersion,
          reason: "review",
        },
        actor,
      ),
    ).toMatchObject({
      materialId: "123",
      materialKind: "vault",
      isReady: true,
    });
    expect((await read()).media[0]).toMatchObject({
      mediaRef: "123",
      releaseForms: [{ id: "7", name: "Reviewed", status: "approved" }],
    });
    expect(
      (
        await createOwnerOfapiMediaUpload(
          app,
          { ...body, dryRun: false },
          actor,
        )
      ).jobId,
    ).toBe(first.jobId);
    expect(
      fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit).method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      (
        await db.pool.query(
          "select actual_credits::text from ofapi_collection_requests where operation='ofapi_upload_status'",
        )
      ).rows[0].actual_credits,
    ).toBe("0");
  });
  it("rejects corrupt or unsupported sources, foreign-page source use, stale approvals and account rebinding", async () => {
    await expect(
      captureOwnerOfapiMediaSource(
        app,
        {
          pageId,
          filename: "x",
          fileBase64: png.toString("base64"),
          expectedSha256: "0".repeat(64),
        },
        actor,
      ),
    ).rejects.toThrow("checksum");
    const html = Buffer.from("<script>bad</script>");
    await expect(
      captureOwnerOfapiMediaSource(
        app,
        {
          pageId,
          filename: "photo.jpg",
          fileBase64: html.toString("base64"),
          expectedSha256: createHash("sha256").update(html).digest("hex"),
        },
        actor,
      ),
    ).rejects.toThrow("supported");
    const job = await upload();
    const foreignModel = await createModel(app.db, {
      slug: "foreign-media",
      name: "Foreign",
    });
    const foreignPage = await createOnlyFansPage(app.db, {
      modelId: foreignModel!.id,
      label: "foreign-media-page",
    });
    await expect(
      createOwnerOfapiMediaUpload(
        app,
        { ...job.body, pageId: foreignPage!.id },
        actor,
      ),
    ).rejects.toThrow("not found for this page");
    await expect(
      createOwnerOfapiMediaUpload(app, { ...job.body, maxCredits: 2 }, actor),
    ).rejects.toThrow("different approval");
    await applyOfapiCollectionPolicy(
      app.db,
      { expectedRevision: 0, changes: [], backgroundPaused: true },
      actor,
    );
    await expect(
      createOwnerOfapiMediaUpload(
        app,
        { ...job.body, requestId: randomUUID() },
        actor,
      ),
    ).rejects.toThrow("policy changed");
    await runOfapiMediaUploadSweep(app);
    expect(fetchMock).not.toHaveBeenCalled();
    await db.pool.query("update pages set ofapi_account_id=$2 where id=$1", [
      pageId,
      "acct_other",
    ]);
    await expect(
      createOwnerOfapiMediaUpload(
        app,
        { ...job.body, expectedPolicyRevision: 1, requestId: randomUUID() },
        actor,
      ),
    ).rejects.toThrow("different account");
    expect((await read()).sources).toEqual([]);
    expect((await source()).id).not.toBe(job.source.id);
  });
  it("reconciles an early signed completion exactly once while keeping upload complete separate from transcoding readiness", async () => {
    const job = await upload();
    const key = randomUUID();
    const payload = {
      id: token,
      account_id: account,
      status: "completed",
      media_id: 123,
      media: { id: 123, isReady: false, type: "photo" },
      credits_used: 1,
    };
    await webhook(payload, key);
    expect((await webhook(payload, key)).duplicate).toBe(true);
    expect(
      await getOfapiAsyncLifecycle(app, {
        resourceKind: "media_upload",
        resourceId: token,
        ofapiAccountId: account,
      }),
      JSON.stringify(
        (
          await db.pool.query(
            "select event_type,projection_status,projection_error,payload from ofapi_webhook_events",
          )
        ).rows,
      ),
    ).not.toBeNull();
    responses.push({
      status: "pending",
      prefixed_id: token,
      polling_url: `https://app.onlyfansapi.com/api/${account}/media/uploads/${token}/status`,
    });
    await runOfapiMediaUploadSweep(app);
    await runOfapiMediaUploadSweep(app);
    expect((await runOfapiMediaUploadSweep(app))[0]?.kind).toBe("webhook");
    const completed = (await getOfapiCaptureJob(app.db, job.id))!;
    expect(completed.state).toBe("complete");
    await expect(
      handoffOfapiMedia(
        app,
        {
          pageId,
          jobId: job.id,
          expectedRowVersion: completed.rowVersion,
          reason: "premature",
        },
        actor,
      ),
    ).rejects.toThrow("transcoding");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fact = (
      await db.pool.query(
        "select data from domain_events where type='ofapi.media_observed' order by id limit 1",
      )
    ).rows[0].data;
    await recordOfapiMediaFacts(app.db, pageId, [fact]);
    const before = await read();
    await rebuildOfapiMediaProjection(app, { accountId: pageId });
    expect((await read()).media).toEqual(before.media);
    expect(
      (
        await db.pool.query(
          "select count(*)::text n from domain_events where type='ofapi.media_observed'",
        )
      ).rows[0].n,
    ).toBe("1");
    const refreshed = await createOfapiCollectionJob(
      app.db,
      {
        pageId,
        category: "vault_catalog",
        expectedRevision: 0,
        maxCalls: 2,
        maxCredits: 2,
        maxBytes: 100000,
        from: null,
        to: null,
        selection: ["vault_item:123"],
      },
      actor,
    );
    responses.push({
      data: { id: 123, type: "photo", isReady: true, hasError: false },
    });
    expect(
      await runOfapiCollectionJob(app, refreshed.id, ofapiCollectionHandlers),
    ).toMatchObject({ state: "completed" });
    expect(
      (
        await handoffOfapiMedia(
          app,
          {
            pageId,
            jobId: job.id,
            expectedRowVersion: completed.rowVersion,
            reason: "ready after refresh",
          },
          actor,
        )
      ).materialId,
    ).toBe("123");
    const current = await read();
    await recordOfapiMediaFacts(app.db, pageId, [fact]);
    expect((await read()).media).toEqual(current.media);
    await rebuildOfapiMediaProjection(app, { accountId: pageId });
    expect((await read()).media).toEqual(current.media);
    await expect(
      recordOfapiMediaFacts(app.db, pageId, [
        { ...fact, observationId: 987654321 },
      ]),
    ).rejects.toThrow("captured");
  });
  it("accepts an immediate documented 200 vault result without claiming false transcoding readiness", async () => {
    const job = await upload();
    responses.push({
      data: {
        id: 321,
        type: "photo",
        isReady: false,
        files: { full: { url: null, size: 0 } },
      },
    });
    await runOfapiMediaUploadSweep(app);
    await runOfapiMediaUploadSweep(app);
    const complete = (await getOfapiCaptureJob(app.db, job.id))!;
    expect(complete).toMatchObject({
      state: "complete",
      spentCredits: 0,
      cursor: { mediaRef: "321", isReady: false, actualCredits: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      handoffOfapiMedia(
        app,
        {
          pageId,
          jobId: job.id,
          expectedRowVersion: complete.rowVersion,
          reason: "not yet",
        },
        actor,
      ),
    ).rejects.toThrow("transcoding");
    const cdn = await upload("cdn");
    responses.push({ prefixed_id: token, file_name: "own.png" });
    await runOfapiMediaUploadSweep(app);
    await runOfapiMediaUploadSweep(app);
    const cdnComplete = (await getOfapiCaptureJob(app.db, cdn.id))!;
    expect(
      await handoffOfapiMedia(
        app,
        {
          pageId,
          jobId: cdn.id,
          expectedRowVersion: cdnComplete.rowVersion,
          reason: "inline CDN",
        },
        actor,
      ),
    ).toMatchObject({ materialId: token, isReady: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("resumes free polling with the original fully reserved ceiling and settles signed completion even while paused", async () => {
    const job = await pending();
    await applyOfapiCollectionPolicy(
      app.db,
      { expectedRevision: 0, changes: [], backgroundPaused: true },
      actor,
    );
    await db.pool.query(
      "update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [job.id],
    );
    await runOfapiMediaUploadSweep(app);
    const paused = (await getOfapiCaptureJob(app.db, job.id))!;
    expect(paused.reasonCode).toBe("background_paused");
    await expect(
      resumeOwnerOfapiMediaUpload(
        app,
        {
          jobId: job.id,
          expectedRowVersion: paused.rowVersion,
          expectedPolicyRevision: 1,
          reason: "too early",
        },
        actor,
      ),
    ).rejects.toThrow("paused");
    await applyOfapiCollectionPolicy(
      app.db,
      { expectedRevision: 1, changes: [], backgroundPaused: false },
      actor,
    );
    await resumeOwnerOfapiMediaUpload(
      app,
      {
        jobId: job.id,
        expectedRowVersion: paused.rowVersion,
        expectedPolicyRevision: 2,
        reason: "same cap",
      },
      actor,
    );
    await status(job.id, {});
    expect((await getOfapiCaptureJob(app.db, job.id))?.state).toBe("complete");
    expect(
      fetchMock.mock.calls.filter(
        (call) => (call[1] as RequestInit).method === "POST",
      ),
    ).toHaveLength(1);
    const next = await createOwnerOfapiMediaUpload(
      app,
      {
        ...job.body,
        requestId: randomUUID(),
        expectedPolicyRevision: 2,
        dryRun: false,
      },
      actor,
    );
    responses.push({
      status: "pending",
      prefixed_id: token,
      polling_url: `https://app.onlyfansapi.com/api/${account}/media/uploads/${token}/status`,
    });
    await runOfapiMediaUploadSweep(app);
    await runOfapiMediaUploadSweep(app);
    await applyOfapiCollectionPolicy(
      app.db,
      { expectedRevision: 2, changes: [], backgroundPaused: true },
      actor,
    );
    await db.pool.query(
      "update ofapi_capture_jobs set next_attempt_at=now()-interval '1 second' where id=$1",
      [next.jobId],
    );
    await runOfapiMediaUploadSweep(app);
    await webhook({
      id: token,
      account_id: account,
      status: "completed",
      media_id: 124,
      media: { id: 124, isReady: true },
      credits_used: 1,
    });
    expect((await runOfapiMediaUploadSweep(app))[0]?.kind).toBe("webhook");
    expect((await getOfapiCaptureJob(app.db, next.jobId!))?.state).toBe(
      "complete",
    );
  });
  it("ignores foreign-account completion and retains unknown upload charges on failure", async () => {
    const job = await pending();
    await webhook(
      {
        id: token,
        account_id: "acct_other",
        status: "completed",
        media_id: 999,
        media: { id: 999, isReady: true },
      },
      randomUUID(),
      "acct_other",
    );
    await runOfapiMediaUploadSweep(app);
    expect((await getOfapiCaptureJob(app.db, job.id))?.state).toBe(
      "retry_wait",
    );
    await status(job.id, {
      status: "failed",
      media: undefined,
      credits_used: undefined,
      error: "failed",
    });
    expect((await getOfapiCaptureJob(app.db, job.id))?.reasonCode).toBe(
      "upload_failed",
    );
    expect((await read()).uploads[0]).toMatchObject({
      actualCredits: null,
      spentCredits: 3,
    });
    expect((await read()).media).toEqual([]);
  });
  it("records an actual byte-charge overrun before blocking handoff", async () => {
    const job = await pending();
    await status(job.id, { credits_used: 8 });
    expect(await getOfapiCaptureJob(app.db, job.id)).toMatchObject({
      state: "blocked",
      spentCredits: 8,
      reasonCode: "upload_budget_exceeded",
    });
    expect((await read()).uploads[0]?.actualCredits).toBe(8);
  });
  it("never repeats a dispatched upload after uncertain transport", async () => {
    const job = await upload();
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("synthetic connection lost");
    });
    await runOfapiMediaUploadSweep(app);
    expect(await getOfapiCaptureJob(app.db, job.id)).toMatchObject({
      state: "blocked",
      reasonCode: "indeterminate",
    });
    await runOfapiMediaUploadSweep(app);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps one-use CDN tokens out of local lists and canonical facts and refuses custody already reserved by a send", async () => {
    const job = await pending("cdn");
    await status(job.id, { media: { file_name: "own.png" } });
    const complete = (await getOfapiCaptureJob(app.db, job.id))!;
    expect(JSON.stringify(await read())).not.toContain(token);
    expect(
      JSON.stringify(
        (
          await db.pool.query(
            "select data,dedup_key from domain_events where account_id=$1",
            [pageId],
          )
        ).rows,
      ),
    ).not.toContain(token);
    const body = {
      pageId,
      jobId: job.id,
      expectedRowVersion: complete.rowVersion,
      reason: "one use",
    };
    expect(await handoffOfapiMedia(app, body, actor)).toMatchObject({
      materialId: token,
      isReady: null,
    });
    await createUserAccount(
      app,
      { username: "chatter", role: "chatter" },
      { source: "cli" },
    );
    const chatter = (
      await issueChatterApiKey(
        app,
        { username: "chatter", pageLabel: "media-page" },
        { source: "cli" },
      )
    ).key;
    const command = await server.inject({
      method: "POST",
      url: "/api/v1/ofapi/commands",
      headers: { authorization: `Bearer ${chatter}` },
      payload: {
        clientCommandId: randomUUID(),
        kind: "send_media_message_v1",
        accountId: account,
        conversationId: "55",
        payload: {
          text: "own media",
          price: 0,
          mediaFiles: [token],
          previews: [],
        },
      },
    });
    expect(command.statusCode).toBe(202);
    await reserveOfapiProviderOperation(app.db, {
      commandId: command.json().commandId,
      parentCommandId: null,
      reuse: false,
      teamSlug: "synthetic",
      accountId: account,
      endpoint: "/messages",
      bodyHash: "synthetic",
      tokens: [token],
    });
    await expect(handoffOfapiMedia(app, body, actor)).rejects.toThrow(
      "already reserved",
    );
  });
  it("distinguishes a full unfiltered vault traversal from filtered or interrupted scopes", async () => {
    const task = await createOfapiCollectionJob(
      app.db,
      {
        pageId,
        category: "vault_catalog",
        expectedRevision: 0,
        maxCalls: 5,
        maxCredits: 5,
        maxBytes: 100000,
        from: null,
        to: null,
        selection: ["vault_inventory"],
      },
      actor,
    );
    responses.push(
      {
        data: {
          list: [
            { id: 1, type: "photo", isReady: true, releaseForms: [{ id: 7 }] },
          ],
          hasMore: true,
        },
      },
      {
        data: {
          list: [{ id: 2, type: "photo", isReady: false }],
          hasMore: false,
        },
      },
    );
    expect(
      await runOfapiCollectionJob(app, task.id, ofapiCollectionHandlers),
    ).toMatchObject({ state: "completed" });
    expect((await read()).inventory.state).toBe("complete");
    expect((await read()).totalMedia).toBe(2);
    await runMediaPlaneProjection(app, { accountId: pageId });
    expect(
      (
        await db.pool.query(
          "select count(*)::text n from creator_raw_media where page_id=$1 and first_origin='vault' and source_kind='ofapi.collection_read_response.v1'",
          [pageId],
        )
      ).rows[0].n,
    ).toBe("2");
    const limited = await createOfapiCollectionJob(
      app.db,
      {
        pageId,
        category: "vault_catalog",
        expectedRevision: 0,
        maxCalls: 1,
        maxCredits: 1,
        maxBytes: 100000,
        from: null,
        to: null,
        selection: ["vault_inventory?type=photo"],
      },
      actor,
    );
    responses.push({
      data: { list: [{ id: 1, isReady: true }], hasMore: true },
    });
    expect(
      await runOfapiCollectionJob(app, limited.id, ofapiCollectionHandlers),
    ).toMatchObject({ state: "paused" });
    expect((await read()).inventory.state).toBe("partial");
    expect(
      (await read()).media.find((row) => row.mediaRef === "1")?.releaseForms,
    ).toEqual([{ id: "7", name: null, status: null }]);
  });
  it("reads locally with assigned-page ACL and erases populated source and metadata before pages", async () => {
    const job = await pending();
    await status(job.id, {});
    await createUserAccount(
      app,
      { username: "lead", role: "team_lead", password: "synthetic-password" },
      { source: "cli" },
    );
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "lead", password: "synthetic-password" },
    });
    const raw = login.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0]! : String(raw)).split(";")[0]!;
    expect(
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/admin/ofapi/media?pageId=${pageId}`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/admin/ofapi/media/sources",
          headers: { cookie },
          payload: {
            pageId,
            filename: "owned.png",
            fileBase64: png.toString("base64"),
            expectedSha256: sha,
          },
        })
      ).statusCode,
    ).toBe(403);
    const fact = (
      await db.pool.query(
        "select data from domain_events where type='ofapi.media_observed' limit 1",
      )
    ).rows[0].data;
    const plan = await planErasure(app, {
      scopeType: "page",
      pageLabel: "media-page",
    });
    for (const name of ["ofapi_media_sources", "ofapi_media_catalog"])
      expect(
        plan.targets.find((row) => row.target === name)?.rows,
      ).toBeGreaterThan(0);
    await executeErasure(
      app,
      { scopeType: "page", pageLabel: "media-page" },
      { initiatedBy: actor },
    );
    for (const name of ["ofapi_media_sources", "ofapi_media_catalog"])
      expect(
        (await db.pool.query(`select count(*)::text n from ${name}`)).rows[0].n,
      ).toBe("0");
    await recordOfapiMediaFacts(app.db, pageId, [fact]);
    expect((await read()).media).toEqual([]);
  });
});

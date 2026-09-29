import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  getOfapiCaptureJob,
  insertObservation,
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  setPageOfapiAccountId,
  upsertPageDmConversation,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

async function login(username: string, role: "owner" | "team_lead") {
  const user = await createUserAccount(appContext, {
    username,
    role,
    password: "test-password",
  }, { source: "cli" });
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: "test-password" },
  });
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== "string") throw new Error("Expected owner session cookie");
  return { cookie: value.split(";")[0]!, userId: user!.id };
}

async function seedPageAndChat(input?: {
  chatId?: string;
  headId?: string;
  anchorId?: string;
  withCoverage?: boolean;
}) {
  const chatId = input?.chatId ?? "chat-1";
  const headId = input?.headId ?? "102";
  const anchorId = input?.anchorId ?? "100";
  const model = await createModel(appContext.db, {
    slug: `capture-seed-${chatId}`,
    name: `Capture Seed ${chatId}`,
  });
  if (!model) throw new Error("Expected capture seed model");
  const page = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: `capture-seed-${chatId}`,
  });
  if (!page) throw new Error("Expected capture seed page");
  const ofapiAccountId = `acct-${chatId}`;
  await setPageOfapiAccountId(appContext.db, { pageId: page.id, ofapiAccountId });
  await upsertPageDmConversation(appContext.db, {
    platformAccountId: page.id,
    fanId: null,
    platformConversationId: chatId,
    partnerPlatformUserId: "fan-1",
    partnerUsername: "fan",
    partnerDisplayName: "Fan",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: headId,
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-07-16T12:00:00.000Z"),
    lastMessageSenderId: "fan-1",
    lastMessageSenderRole: "fan",
    lastMessagePreview: "head",
    lastSeenGeneration: 1,
  });
  if (input?.withCoverage !== false) {
    await testDb!.pool.query(`
      insert into ofapi_message_coverage (
        page_id, chat_id, classification, source, frozen_head_id,
        oldest_message_id, target, target_hash, page_chain_hash,
        raw_count, accepted_count, boundary_duplicate_count,
        explicitly_irrelevant_count, rejected_count, parse_debt,
        required_serving_high_water, proof_observation_id,
        proof_observation_received_at, proof_policy_version,
        source_contract_version, parser_version, source_account_seq
      ) values (
        $1, $2, 'continuous_history', 'pagination_exhausted', $3,
        '1', '{}'::jsonb, $4, $5,
        1, 1, 0, 0, 0, 0,
        0, 1, now(), $6, 'ofapi-capture-v1', 'ofapi-capture-parser-v1', 1
      )
    `, [
      page.id,
      chatId,
      anchorId,
      "a".repeat(64),
      "b".repeat(64),
      OFAPI_CAPTURE_PROOF_POLICY_VERSION,
    ]);
  }
  return { page, chatId, headId, anchorId, ofapiAccountId };
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

describe("owner bounded OFAPI capture seed", () => {
  it("can bootstrap a first proof only through an explicit exhaustion target", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const seeded = await seedPageAndChat({ withCoverage: false });
    const owner = await login("owner", "owner");

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: {
        dryRun: false,
        goal: "history_to_exhaustion",
        targets: [{ pageId: seeded.page.id, chatId: seeded.chatId }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      dryRun: false,
      created: 1,
      coalesced: 0,
      skipped: 0,
      results: [{
        pageId: seeded.page.id,
        chatId: seeded.chatId,
        goal: "history_to_exhaustion",
        frozenHeadId: seeded.headId,
        anchorMessageId: null,
        status: "created",
      }],
    });
    const jobId = (response.json() as { results: Array<{ jobId: string }> }).results[0]!.jobId;
    expect(await getOfapiCaptureJob(appContext.db, jobId)).toMatchObject({
      pageId: seeded.page.id,
      ofapiAccountId: seeded.ofapiAccountId,
      goal: "history_to_exhaustion",
      activeSlotKey: `page:${seeded.page.id}:chat:${seeded.chatId}`,
      target: {
        chatId: seeded.chatId,
        frozenHeadId: seeded.headId,
        anchorMessageId: null,
        limit: 100,
        reason: "owner_manual_bootstrap",
      },
      budgetScope: "bulk",
      originPrincipalId: owner.userId,
      createdBy: "owner",
      maxCalls: 3,
      maxCredits: 3,
      maxPages: 3,
      maxItems: 300,
    });
  });

  it("dry-runs, creates only explicit targets, and coalesces without changing the target", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const seeded = await seedPageAndChat();
    await upsertPageDmConversation(appContext.db, {
      platformAccountId: seeded.page.id,
      fanId: null,
      platformConversationId: "not-requested",
      partnerPlatformUserId: "fan-2",
      partnerUsername: "other",
      partnerDisplayName: "Other",
      conversationFlags: 0,
      unreadCount: 0,
      subscriptionTierId: null,
      lastMessageId: "999",
      lastUnreadMessageId: null,
      lastMessageAt: new Date("2026-07-16T12:01:00.000Z"),
      lastMessageSenderId: "fan-2",
      lastMessageSenderRole: "fan",
      lastMessagePreview: "other",
      lastSeenGeneration: 1,
    });
    const owner = await login("owner", "owner");
    const target = {
      pageId: seeded.page.id,
      chatId: seeded.chatId,
      anchorMessageId: seeded.anchorId,
    };

    const dryRun = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: { targets: [target] },
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json()).toMatchObject({
      dryRun: true,
      created: 1,
      coalesced: 0,
      skipped: 0,
      limits: {
        maxTargets: 20,
        maxPagesPerJob: 3,
        maxCallsPerJob: 3,
        maxCreditsPerJob: 3,
        maxItemsPerJob: 300,
      },
      results: [{
        ...target,
        frozenHeadId: seeded.headId,
        status: "would_create",
        jobId: null,
      }],
    });
    expect((await testDb.pool.query("select id from ofapi_capture_jobs")).rows).toHaveLength(0);

    const executed = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: { dryRun: false, targets: [target] },
    });
    expect(executed.statusCode).toBe(200);
    const executedBody = executed.json() as {
      results: Array<{ jobId: string; status: string }>;
    };
    expect(executedBody.results[0]?.status).toBe("created");
    const job = await getOfapiCaptureJob(appContext.db, executedBody.results[0]!.jobId);
    expect(job).toMatchObject({
      pageId: seeded.page.id,
      ofapiAccountId: seeded.ofapiAccountId,
      goal: "connect_to_anchor",
      activeSlotKey: `page:${seeded.page.id}:chat:${seeded.chatId}`,
      target: {
        chatId: seeded.chatId,
        frozenHeadId: seeded.headId,
        anchorMessageId: seeded.anchorId,
        limit: 100,
        reason: "owner_manual",
      },
      budgetScope: "bulk",
      originPrincipalId: owner.userId,
      createdBy: "owner",
      maxCalls: 3,
      maxCredits: 3,
      maxPages: 3,
      maxItems: 300,
    });
    expect((job?.manifest?.targetSlotKeys as string[])).toEqual([
      `page:${seeded.page.id}:chat:${seeded.chatId}`,
    ]);
    expect((await testDb.pool.query("select id from ofapi_capture_jobs")).rows).toHaveLength(1);

    const repeated = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: { dryRun: false, targets: [target] },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      created: 0,
      coalesced: 1,
      results: [{ status: "coalesced", jobId: job!.id }],
    });
    expect((await getOfapiCaptureJob(appContext.db, job!.id))?.target).toEqual(job?.target);
    expect((await testDb.pool.query("select id from ofapi_capture_jobs")).rows).toHaveLength(1);

    await testDb.pool.query(`
      update page_dm_threads
      set last_message_id = '103', last_message_at = '2026-07-16T12:02:00.000Z'
      where platform_account_id = $1 and platform_conversation_id = $2
    `, [seeded.page.id, seeded.chatId]);
    const shiftedHead = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: { dryRun: false, targets: [target] },
    });
    expect(shiftedHead.statusCode).toBe(409);
    expect((await getOfapiCaptureJob(appContext.db, job!.id))?.target).toEqual(job?.target);

    await testDb.pool.query(`
      update page_dm_threads
      set last_message_id = $3,
          last_message_at = '2026-07-16T12:00:00.000Z'
      where platform_account_id = $1 and platform_conversation_id = $2
    `, [seeded.page.id, seeded.chatId, seeded.headId]);
    const terminal = await insertObservation(appContext.db, {
      source: "ofapi_capture",
      producer: "seed-test",
      platform: "onlyfans",
      accountId: seeded.page.id,
      kind: "ofapi.capture_completed.v1",
      payload: { jobId: job!.id, classification: "connected_to_anchor" },
      payloadHash: Buffer.alloc(32, 1),
      idempotencyKey: `seed-test-complete:${job!.id}`,
    });
    await testDb.pool.query(`
      update ofapi_capture_jobs
      set state = 'complete',
          terminal_observation_id = $2,
          terminal_observation_received_at = $3,
          completed_at = now(),
          updated_at = now()
      where id = $1
    `, [job!.id, terminal.observationId, terminal.receivedAt]);
    const completedRepeat = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: { dryRun: false, targets: [target] },
    });
    expect(completedRepeat.statusCode).toBe(200);
    expect(completedRepeat.json()).toMatchObject({
      created: 0,
      coalesced: 0,
      skipped: 1,
      results: [{ status: "already_captured", jobId: job!.id, state: "complete" }],
    });
    expect((await testDb.pool.query("select id from ofapi_capture_jobs")).rows).toHaveLength(1);

    const audit = await testDb.pool.query<{ event_type: string }>(`
      select event_type from audit_events
      where event_type = 'admin.ofapi_capture_jobs_seed'
      order by id
    `);
    expect(audit.rows).toHaveLength(3);
  });

  it("rejects unauthorized, duplicate, and unverified targets before creating jobs", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const seeded = await seedPageAndChat();
    const target = {
      pageId: seeded.page.id,
      chatId: seeded.chatId,
      anchorMessageId: seeded.anchorId,
    };
    const anonymous = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      payload: { targets: [target] },
    });
    expect(anonymous.statusCode).toBe(401);

    const lead = await login("lead", "team_lead");
    const forbidden = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: lead.cookie },
      payload: { targets: [target] },
    });
    expect(forbidden.statusCode).toBe(403);

    const owner = await login("owner", "owner");
    const duplicate = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: { dryRun: false, targets: [target, target] },
    });
    expect(duplicate.statusCode).toBe(400);

    const badAnchor = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/capture-jobs/seed",
      headers: { cookie: owner.cookie },
      payload: {
        dryRun: false,
        targets: [{ ...target, anchorMessageId: "arbitrary" }],
      },
    });
    expect(badAnchor.statusCode).toBe(409);
    expect((await testDb.pool.query("select id from ofapi_capture_jobs")).rows).toHaveLength(0);
  });
});

describe("owner OFAPI export quote boundary", () => {
  it("defaults to dry-run and exposes quote-only status plus CAS cancellation", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const seeded = await seedPageAndChat({ chatId: "42" });
    const owner = await login("owner", "owner");
    const payload = {
      pageId: seeded.page.id,
      profile: "pilot_chats",
      chatIds: ["42"],
      startDate: "2016-11-01T00:00:00.000Z",
      endDate: "2026-07-15T00:00:00.000Z",
      maxMessages: 100,
      quoteTtlMinutes: 1_440,
    };
    const dryRun = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/export-quotes",
      headers: { cookie: owner.cookie },
      payload,
    });
    expect(dryRun.statusCode, dryRun.body).toBe(200);
    expect(dryRun.json()).toMatchObject({
      dryRun: true,
      status: "would_create",
      jobId: null,
      pageId: seeded.page.id,
      profile: "pilot_chats",
    });
    expect((await testDb.pool.query("select id from ofapi_capture_jobs")).rows).toHaveLength(0);

    const tooEarly = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/export-quotes",
      headers: { cookie: owner.cookie },
      payload: { ...payload, startDate: "2016-10-31T23:59:59.999Z" },
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(400);
    expect(tooEarly.json()).toMatchObject({
      message: "OFAPI export quote startDate cannot be before 2016-11-01T00:00:00.000Z",
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/export-quotes",
      headers: { cookie: owner.cookie },
      payload: { ...payload, dryRun: false },
    });
    expect(created.statusCode, created.body).toBe(200);
    const jobId = (created.json() as { jobId: string }).jobId;
    expect(created.json()).toMatchObject({ dryRun: false, status: "created", jobId });
    const configured = await testDb.pool.query<{ max_calls: number }>(
      "select max_calls from ofapi_capture_jobs where id = $1",
      [jobId],
    );
    expect(configured.rows[0]?.max_calls).toBe(97);

    const status = await server.inject({
      method: "GET",
      url: `/api/v1/admin/ofapi/export-quotes/${jobId}`,
      headers: { cookie: owner.cookie },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      jobId,
      state: "ready",
      quote: null,
      attemptCount: 0,
      dispatchCount: 0,
    });

    await testDb.pool.query(`
      update ofapi_capture_jobs
      set state = 'blocked', reason_code = 'export_contract_rejected'
      where id = $1
    `, [jobId]);
    const unsafeCancel = await server.inject({
      method: "POST",
      url: `/api/v1/admin/ofapi/export-quotes/${jobId}/cancel`,
      headers: { cookie: owner.cookie },
      payload: { expectedState: "blocked", reason: "must reconcile vendor object first" },
    });
    expect(unsafeCancel.statusCode, unsafeCancel.body).toBe(409);

    await testDb.pool.query(`
      update ofapi_capture_jobs
      set state = 'blocked', reason_code = 'export_create_http_422'
      where id = $1
    `, [jobId]);
    const cancelled = await server.inject({
      method: "POST",
      url: `/api/v1/admin/ofapi/export-quotes/${jobId}/cancel`,
      headers: { cookie: owner.cookie },
      payload: { expectedState: "blocked", reason: "captured validation rejection" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({
      jobId,
      state: "cancelled",
      reasonCode: "owner_cancelled",
    });
  });

  it("dry-runs and CAS-approves only a bounded pilot", async (context) => {
    if (!testDb || !server) {
      context.skip();
      return;
    }
    const seeded = await seedPageAndChat({ chatId: "84" });
    const owner = await login("owner", "owner");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/admin/ofapi/export-quotes",
      headers: { cookie: owner.cookie },
      payload: {
        pageId: seeded.page.id,
        profile: "pilot_chats",
        chatIds: ["84"],
        startDate: "2016-11-01T00:00:00.000Z",
        endDate: "2026-07-15T00:00:00.000Z",
        maxMessages: 100,
        quoteTtlMinutes: 1_440,
        dryRun: false,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const jobId = (created.json() as { jobId: string }).jobId;
    await testDb.pool.query(`
      update ofapi_capture_jobs
      set state = 'blocked',
          reason_code = 'export_quote_requires_start',
          cursor = jsonb_build_object(
            'phase', 'quote_unavailable',
            'vendorExportId', 'data_export_route_pilot',
            'vendorStatus', 'calculating_credits_completed',
            'pollCount', 0,
            'quoteRequestedAt', '2026-07-16T00:00:00.000Z',
            'lastStatusAt', '2026-07-16T00:00:00.000Z',
            'totalRows', null,
            'creditCost', null,
            'quotedAt', null,
            'expiresAt', null,
            'lastObservationId', 1,
            'lastObservationReceivedAt', '2026-07-16T00:00:00.000Z'
          ),
          row_version = row_version + 1
      where id = $1
    `, [jobId]);
    const before = await testDb.pool.query<{ row_version: number }>(
      "select row_version from ofapi_capture_jobs where id = $1",
      [jobId],
    );
    const expectedRowVersion = Number(before.rows[0]!.row_version);

    const preview = await server.inject({
      method: "POST",
      url: `/api/v1/admin/ofapi/export-quotes/${jobId}/approve-pilot`,
      headers: { cookie: owner.cookie },
      payload: {
        expectedRowVersion,
        approvedMaxCredits: 5,
        reason: "bounded route pilot",
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      dryRun: true,
      jobId,
      requiredMaxCredits: 5,
      nextState: "ready",
    });
    expect((await testDb.pool.query(
      "select state from ofapi_capture_jobs where id = $1",
      [jobId],
    )).rows[0]?.state).toBe("blocked");

    const approved = await server.inject({
      method: "POST",
      url: `/api/v1/admin/ofapi/export-quotes/${jobId}/approve-pilot`,
      headers: { cookie: owner.cookie },
      payload: {
        expectedRowVersion,
        approvedMaxCredits: 5,
        reason: "bounded route pilot",
        dryRun: false,
      },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ dryRun: false, jobId, nextState: "ready" });
  });
});

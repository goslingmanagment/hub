import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  createOrGetOfapiCaptureJob,
  getOfapiCaptureJob,
  insertObservation,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { executeOfapiCaptureJobChunk } from "../apps/runtime/src/services/ofapi-capture-jobs.ts";
import {
  OFAPI_CHAT_EXPORT_COLUMNS,
} from "../apps/runtime/src/services/ofapi-export-artifact.ts";
import { appendOfapiMessageMaterialPage } from "../apps/runtime/src/services/ofapi-message-material.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let artifactDir: string | null = null;

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvRow(overrides: Partial<Record<(typeof OFAPI_CHAT_EXPORT_COLUMNS)[number], string>>) {
  const defaults: Record<(typeof OFAPI_CHAT_EXPORT_COLUMNS)[number], string> = {
    account_id: "acct-export-test",
    account_name: "Creator",
    account_username: "creator",
    sent_by: "fan",
    fan_id: "12345678",
    fan_username: "fan",
    fan_name: "Fan",
    chat_id: "42",
    message_id: "1001",
    message_text: "hello",
    giphy_id: "",
    locked_text: "false",
    price: "0.00",
    tip_amount: "",
    is_free: "true",
    is_tip: "false",
    is_opened: "true",
    is_from_queue: "false",
    is_new: "false",
    is_reported_by_me: "false",
    is_couple_people_media: "false",
    is_markdown_disabled: "false",
    is_pinned: "false",
    is_liked: "false",
    is_media_ready: "true",
    media_count: "1",
    cancel_seconds: "0",
    can_purchase: "false",
    can_purchase_reason: "",
    can_report: "true",
    can_be_pinned: "true",
    onlyfans_created_at: "2026-07-14 10:00:00",
    onlyfans_changed_at: "2026-07-14 10:05:00",
  };
  const row = { ...defaults, ...overrides };
  return OFAPI_CHAT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(",");
}

async function loginOwner() {
  await createUserAccount(app, {
    username: "export-owner",
    role: "owner",
    password: "test-password",
  }, { source: "cli" });
  const response = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "export-owner", password: "test-password" },
  });
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected owner cookie");
  return value.split(";")[0]!;
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
  artifactDir = await mkdtemp(path.join(tmpdir(), "ofapi-export-import-"));
  app = createTestAppContext(testDb, {
    ofapiMirrorBackgroundCaptureEnabled: true,
    ofapiExportArtifactDir: artifactDir,
  });
  server = await buildApiServer(app);
  await server.ready();
});

afterEach(async () => {
  await server?.close();
  server = null;
  if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  artifactDir = null;
});

afterAll(async () => {
  await testDb?.stop();
});

describe("OFAPI export artifact import", () => {
  it("journals a checked pointer and imports partial material without certifying history", async (context) => {
    if (!testDb || !server || !artifactDir) {
      context.skip();
      return;
    }
    const model = await createModel(app.db, { slug: "export-model", name: "Export Model" });
    if (!model) throw new Error("Expected model");
    const page = await createOnlyFansPage(app.db, { modelId: model.id, label: "export-page" });
    if (!page) throw new Error("Expected page");
    await setPageOfapiAccountId(app.db, {
      pageId: page.id,
      ofapiAccountId: "acct-export-test",
    });
    const cookie = await loginOwner();

    const liveObservation = await insertObservation(app.db, {
      source: "ofapi_capture",
      producer: "test-live-material",
      platform: "onlyfans",
      accountId: page.id,
      nativeAccountRef: "acct-export-test",
      kind: "ofapi.chat_messages_page.v1",
      payload: { test: true },
      payloadHash: createHash("sha256").update("live").digest(),
      idempotencyKey: "test-live-material:1001",
      observedAt: new Date("2026-07-14T10:01:00.000Z"),
    });
    await appendOfapiMessageMaterialPage(app.db, {
      accountId: page.id,
      observationId: liveObservation.observationId,
      observationReceivedAt: liveObservation.receivedAt,
      chatId: "42",
      originClass: "capture_background",
      items: [{
        id: "1001",
        createdAt: "2026-07-14T10:00:00.000Z",
        changedAt: "2026-07-14T10:01:00.000Z",
        isSentByMe: false,
        text: "old text",
        isOpened: false,
        isNew: true,
        isTip: false,
        price: 0,
        fromUser: { id: "12345678" },
        toUser: { id: "acct-export-test" },
        media: [{ id: "live-media-id", type: "photo", canView: true, isReady: true }],
      }],
    });
    await runMessageArchiveProjection(app, { accountId: page.id });

    const target = {
      profile: "pilot_chats",
      type: "chat_messages",
      accountIds: ["acct-export-test"],
      startDate: "2016-11-01T00:00:00.000Z",
      // Vendor-normalized midnight means the inclusive end of this UTC day.
      // Both artifact rows below are later on 2026-07-14 and must remain valid.
      endDate: "2026-07-14T00:00:00.000Z",
      fileType: "csv",
      maxMessages: 1_000,
      quoteTtlMinutes: 1_440,
      chatIds: ["42"],
      autoStart: false,
    };
    const created = await createOrGetOfapiCaptureJob(app.db, {
      pageId: page.id,
      ofapiAccountId: "acct-export-test",
      kind: "account_export",
      activeSlotKey: `page:${page.id}:export`,
      target,
      budgetScope: "bulk",
      createdBy: "owner",
      maxCalls: 97,
      maxCredits: 51,
    });
    await testDb.pool.query(`
      update ofapi_capture_jobs
      set state = 'blocked',
          reason_code = 'artifact_capture_required',
          cursor = $2::jsonb,
          row_version = row_version + 1
      where id = $1
    `, [created.job.id, JSON.stringify({
      phase: "artifact_pending",
      vendorExportId: "data_export_test",
      vendorStatus: "completed",
      pollCount: 1,
      quoteRequestedAt: "2026-07-14T09:00:00.000Z",
      lastStatusAt: "2026-07-14T11:00:00.000Z",
      totalRows: 2,
      creditCost: 1,
      quotedAt: null,
      expiresAt: null,
      lastObservationId: liveObservation.observationId,
      lastObservationReceivedAt: liveObservation.receivedAt.toISOString(),
      approvedMaxCredits: 5,
      approvedAt: "2026-07-14T09:05:00.000Z",
      approvedByUserId: 1,
      approvalReason: "test",
      startAttemptId: "test-attempt",
      rowsProcessed: 2,
      failedDownloads: 0,
      downloadUrl: "https://example.invalid/signed.csv",
    })]);
    const parent = await getOfapiCaptureJob(app.db, created.job.id);
    if (!parent) throw new Error("Expected parent export job");

    const csv = [
      OFAPI_CHAT_EXPORT_COLUMNS.join(","),
      csvRow({ message_id: "1001", message_text: "<p>new,\ntext</p>" }),
      csvRow({
        sent_by: "creator",
        message_id: "1002",
        message_text: "PPV",
        price: "24.00",
        is_free: "false",
        is_opened: "false",
        is_new: "true",
        onlyfans_created_at: "2026-07-14 11:00:00",
        onlyfans_changed_at: "2026-07-14 11:00:00",
      }),
      "",
    ].join("\n");
    await writeFile(path.join(artifactDir, `${parent.id}.csv`), csv, { mode: 0o600 });
    const expectedSha256 = createHash("sha256").update(csv).digest("hex");

    const preview = await server.inject({
      method: "POST",
      url: `/api/v1/admin/ofapi/export-quotes/${parent.id}/capture-artifact`,
      headers: { cookie },
      payload: {
        expectedRowVersion: parent.rowVersion,
        expectedSha256,
        reason: "bounded import test",
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      dryRun: true,
      status: "would_capture",
      classification: "item_presence",
      importJobId: null,
      artifact: { rowCount: 2, chatCount: 1 },
    });

    const captured = await server.inject({
      method: "POST",
      url: `/api/v1/admin/ofapi/export-quotes/${parent.id}/capture-artifact`,
      headers: { cookie },
      payload: {
        expectedRowVersion: parent.rowVersion,
        expectedSha256,
        reason: "bounded import test",
        dryRun: false,
      },
    });
    expect(captured.statusCode, captured.body).toBe(200);
    const body = captured.json() as { importJobId: string };
    expect(captured.json()).toMatchObject({
      dryRun: false,
      status: "captured",
      classification: "item_presence",
      importJobState: "ready",
    });
    expect(await getOfapiCaptureJob(app.db, parent.id)).toMatchObject({
      state: "complete",
      reasonCode: null,
      result: { classification: "item_presence", importJobId: body.importJobId },
    });

    expect(await executeOfapiCaptureJobChunk(app, page.id)).toMatchObject({
      kind: "success",
      jobId: body.importJobId,
    });
    expect(await getOfapiCaptureJob(app.db, body.importJobId)).toMatchObject({
      state: "complete",
      acceptedItems: 2,
      result: {
        classification: "item_presence",
        continuousHistory: false,
        rowCount: 2,
      },
    });

    await runMessageArchiveProjection(app, { accountId: page.id });
    const projected = await testDb.pool.query<{
      message_ref: string;
      text_plain: string;
      media_metadata: Array<{ id: string }>;
      origin_class: string;
    }>(`
      select message_ref, text_plain, media_metadata, origin_class
      from message_archive
      where account_id = $1 and conversation_ref = '42'
      order by message_ref
    `, [page.id]);
    expect(projected.rows).toHaveLength(2);
    expect(projected.rows[0]).toMatchObject({
      message_ref: "1001",
      text_plain: "new,\ntext",
      media_metadata: [{ id: "live-media-id" }],
      origin_class: "export_import",
    });
    expect(projected.rows[1]).toMatchObject({
      message_ref: "1002",
      text_plain: "PPV",
      origin_class: "export_import",
    });
    expect((await testDb.pool.query(
      "select count(*)::int as n from ofapi_message_coverage where page_id = $1 and chat_id = '42'",
      [page.id],
    )).rows[0]?.n).toBe(0);
    expect((await testDb.pool.query(`
      select count(*)::int as n
      from domain_events
      where account_id = $1
        and type not in ('message.material_observed', 'stream.projection_checkpoint')
    `, [page.id])).rows[0]?.n).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import {
  executeOfapiCommand,
  sweepOfapiCommands,
  verifyOfapiCommandFromSentWebhook,
} from "../apps/runtime/src/services/ofapi-command-executor.ts";
import { createOfapiClient, OfapiApiError, OfapiCreditAccountingUnavailableError } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCredentialPolicy } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const ACCOUNT_ONE = "acct_11000000000000000000000000000000";
const ACCOUNT_TWO = "acct_22000000000000000000000000000000";
const CONVERSATION = "123456789";

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let otherChatterKey = "";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await apiServer?.close();
  await testDb?.stop();
});

afterEach(() => vi.unstubAllGlobals());

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await apiServer?.close();
  await resetIntegrationDatabase(testDb.pool);

  appContext = createTestAppContext(testDb, {
    ofapiCreditLedgerEnabled: true,
    ofapiDesktopReadGatewayEnabled: true,
    ofapiDesktopCommandOutboxEnabled: true,
  });
  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const assignedPage = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: "lora-of",
  });
  const unassignedPage = await createOnlyFansPage(appContext.db, {
    modelId: model.id,
    label: "lora-vip-of",
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: assignedPage.id,
    ofapiAccountId: ACCOUNT_ONE,
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: unassignedPage.id,
    ofapiAccountId: ACCOUNT_TWO,
  });

  await createUserAccount(appContext, {
    username: "chatter",
    role: "chatter",
  }, { source: "cli" });
  chatterKey = (await issueChatterApiKey(appContext, {
    username: "chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  await createUserAccount(appContext, {
    username: "other-chatter",
    role: "chatter",
  }, { source: "cli" });
  otherChatterKey = (await issueChatterApiKey(appContext, {
    username: "other-chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  apiServer = await buildApiServer(appContext);
  await apiServer.ready();
});

function commandBody(overrides: Record<string, unknown> = {}) {
  return {
    clientCommandId: randomUUID(),
    kind: "send_text_message_v1",
    accountId: ACCOUNT_ONE,
    conversationId: CONVERSATION,
    payload: { text: "c6b intake validation only" },
    ...overrides,
  };
}

function mediaCommandBody(overrides: Record<string, unknown> = {}) {
  return {
    clientCommandId: randomUUID(),
    kind: "send_media_message_v1",
    accountId: ACCOUNT_ONE,
    conversationId: CONVERSATION,
    payload: {
      text: "c6 media validation only",
      price: 25,
      mediaFiles: ["3866342509", "ofapi_media_abc123"],
      previews: ["3866342509"],
    },
    ...overrides,
  };
}

function typingCommandBody(overrides: Record<string, unknown> = {}) {
  return {
    clientCommandId: randomUUID(),
    kind: "typing_active_v1",
    accountId: ACCOUNT_ONE,
    conversationId: CONVERSATION,
    payload: {},
    ...overrides,
  };
}

function unsendCommandBody(overrides: Record<string, unknown> = {}) {
  return {
    clientCommandId: randomUUID(),
    kind: "unsend_message_v1",
    accountId: ACCOUNT_ONE,
    conversationId: CONVERSATION,
    payload: { messageId: "987654321" },
    ...overrides,
  };
}

function markReadCommandBody(overrides: Record<string, unknown> = {}) {
  return {
    clientCommandId: randomUUID(),
    kind: "mark_chat_read_v1",
    accountId: ACCOUNT_ONE,
    conversationId: CONVERSATION,
    payload: {},
    ...overrides,
  };
}

function createCommand(body: Record<string, unknown>, key = chatterKey) {
  return apiServer!.inject({
    method: "POST",
    url: "/api/v1/ofapi/commands",
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
}

function getCommand(commandId: string, key = chatterKey) {
  return apiServer!.inject({
    method: "GET",
    url: `/api/v1/ofapi/commands/${commandId}`,
    headers: { authorization: `Bearer ${key}` },
  });
}

function cancelCommand(commandId: string, key = chatterKey) {
  return apiServer!.inject({
    method: "POST",
    url: `/api/v1/ofapi/commands/${commandId}/cancel`,
    headers: { authorization: `Bearer ${key}` },
  });
}

function expectResponseOmits(response: { body: string }, text: string) {
  expect(response.body).not.toContain(text);
}

describe("OFAPI command outbox intake", () => {
  it("fails closed while the staged flag is disabled", async () => {
    appContext.config.ofapiDesktopCommandOutboxEnabled = false;
    const response = await createCommand(commandBody());
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      error: "service_unavailable",
    });
  });

  it("creates one queued text command without calling OFAPI or echoing text", async () => {
    const body = commandBody();
    const response = await createCommand(body);
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json() as Record<string, unknown>;
    expect(created).toMatchObject({
      clientCommandId: body.clientCommandId,
      kind: "send_text_message_v1",
      accountId: ACCOUNT_ONE,
      conversationId: CONVERSATION,
      state: "queued",
      attemptCount: 0,
      deduplicated: false,
    });
    expect(JSON.stringify(created)).not.toContain("c6b intake validation only");

    const { rows } = await testDb!.pool.query<{
      payload_text: string;
      horizon_days: number;
    }>(
      `select payload->>'text' as payload_text,
              floor(extract(epoch from (dedupe_expires_at - created_at)) / 86400)::int
                as horizon_days
       from ofapi_commands`,
    );
    expect(rows).toEqual([{
      payload_text: "c6b intake validation only",
      horizon_days: 400,
    }]);

    const ledger = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ofapi_credit_ledger",
    );
    expect(ledger.rows[0]?.count).toBe(0);
  });

  it("creates one queued media command without calling OFAPI or echoing payload", async () => {
    const body = mediaCommandBody();
    const response = await createCommand(body);
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json() as Record<string, unknown>;
    expect(created).toMatchObject({
      clientCommandId: body.clientCommandId,
      kind: "send_media_message_v1",
      accountId: ACCOUNT_ONE,
      conversationId: CONVERSATION,
      state: "queued",
      attemptCount: 0,
      deduplicated: false,
    });
    expect(response.body).not.toContain("c6 media validation only");
    expect(response.body).not.toContain("3866342509");
    expect(response.body).not.toContain("ofapi_media_abc123");

    const { rows } = await testDb!.pool.query<{
      payload: Record<string, unknown>;
      horizon_days: number;
    }>(
      `select payload,
              floor(extract(epoch from (dedupe_expires_at - created_at)) / 86400)::int
                as horizon_days
       from ofapi_commands`,
    );
    expect(rows).toEqual([{
      payload: {
        text: "c6 media validation only",
        price: 25,
        mediaFiles: ["3866342509", "ofapi_media_abc123"],
        previews: ["3866342509"],
      },
      horizon_days: 400,
    }]);

    const ledger = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ofapi_credit_ledger",
    );
    expect(ledger.rows[0]?.count).toBe(0);
  });

  it("creates one queued typing command with an empty payload and no payload echo", async () => {
    const body = typingCommandBody();
    const response = await createCommand(body);
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json() as Record<string, unknown>;
    expect(created).toMatchObject({
      clientCommandId: body.clientCommandId,
      kind: "typing_active_v1",
      accountId: ACCOUNT_ONE,
      conversationId: CONVERSATION,
      state: "queued",
      attemptCount: 0,
      platformMessageId: null,
      deduplicated: false,
    });
    expect("payload" in created).toBe(false);

    const { rows } = await testDb!.pool.query<{
      payload: Record<string, unknown>;
      horizon_seconds: number;
    }>(
      `select payload,
              floor(extract(epoch from (dedupe_expires_at - created_at)))::int
                as horizon_seconds
       from ofapi_commands`,
    );
    expect(rows).toEqual([{
      payload: {},
      horizon_seconds: 120,
    }]);

    const ledger = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ofapi_credit_ledger",
    );
    expect(ledger.rows[0]?.count).toBe(0);
  });

  it("migration 0093 releases legacy 400-day typing rows for bounded cleanup", async () => {
    const created = await createCommand(typingCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
          set created_at = now() - interval '11 seconds',
              dedupe_expires_at = now() + interval '400 days'
        where id = $1`,
      [commandId],
    );

    const migrationSql = readFileSync(
      path.resolve("packages/db/migrations/0093_typing_command_retention.sql"),
      "utf8",
    );
    await testDb!.pool.query(migrationSql);

    // The migration uses PostgreSQL's microsecond clock; a JS Date created in
    // the same millisecond can still precede its strict expiry boundary.
    // Advance from the database clock without sleeping or changing the row.
    const { rows: [clock] } = await testDb!.pool.query<{ sweep_at: Date }>(
      "select clock_timestamp() + interval '1 millisecond' as sweep_at",
    );
    appContext.config.ofapiDesktopCommandExecutionEnabled = false;
    await expect(sweepOfapiCommands(appContext, { send: vi.fn() } as never, clock!.sweep_at))
      .resolves.toMatchObject({ expired: 1, purged: 1, enqueued: 0 });
    expect((await getCommand(commandId)).statusCode).toBe(404);
  });

  it("creates one queued mark-read command with an empty payload and no payload echo", async () => {
    const body = markReadCommandBody();
    const response = await createCommand(body);
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json() as Record<string, unknown>;
    expect(created).toMatchObject({
      clientCommandId: body.clientCommandId,
      kind: "mark_chat_read_v1",
      accountId: ACCOUNT_ONE,
      conversationId: CONVERSATION,
      state: "queued",
      attemptCount: 0,
      platformMessageId: null,
      deduplicated: false,
    });
    expect("payload" in created).toBe(false);

    const { rows } = await testDb!.pool.query<{
      payload: Record<string, unknown>;
      horizon_days: number;
    }>(
      `select payload,
              floor(extract(epoch from (dedupe_expires_at - created_at)) / 86400)::int
                as horizon_days
       from ofapi_commands`,
    );
    expect(rows).toEqual([{
      payload: {},
      horizon_days: 400,
    }]);

    const ledger = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ofapi_credit_ledger",
    );
    expect(ledger.rows[0]?.count).toBe(0);
  });

  it("creates one queued unsend command with a bounded message id payload and no payload echo", async () => {
    const body = unsendCommandBody();
    const response = await createCommand(body);
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json() as Record<string, unknown>;
    expect(created).toMatchObject({
      clientCommandId: body.clientCommandId,
      kind: "unsend_message_v1",
      accountId: ACCOUNT_ONE,
      conversationId: CONVERSATION,
      state: "queued",
      attemptCount: 0,
      platformMessageId: null,
      deduplicated: false,
    });
    expect("payload" in created).toBe(false);
    expect(response.body).not.toContain("987654321");

    const { rows } = await testDb!.pool.query<{
      payload: Record<string, unknown>;
      horizon_days: number;
    }>(
      `select payload,
              floor(extract(epoch from (dedupe_expires_at - created_at)) / 86400)::int
                as horizon_days
       from ofapi_commands`,
    );
    expect(rows).toEqual([{
      payload: { messageId: "987654321" },
      horizon_days: 400,
    }]);

    const ledger = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ofapi_credit_ledger",
    );
    expect(ledger.rows[0]?.count).toBe(0);
  });


  it("deduplicates exact replays and rejects client-id payload mismatches", async () => {
    const body = commandBody();
    const first = await createCommand(body);
    expect(first.statusCode, first.body).toBe(202);
    const firstJson = first.json() as { commandId: string };

    const duplicate = await createCommand(body);
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json()).toMatchObject({
      commandId: firstJson.commandId,
      deduplicated: true,
    });

    const mismatch = await createCommand({
      ...body,
      payload: { text: "different text" },
    });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: "conflict" });

    const count = await testDb!.pool.query<{ count: number }>(
      "select count(*)::int as count from ofapi_commands",
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("enforces page ACLs, ownership, strict payload shape, and idempotent cancel", async () => {
    const unassigned = await createCommand(commandBody({ accountId: ACCOUNT_TWO }));
    expect(unassigned.statusCode, unassigned.body).toBe(404);

    const mediaPayload = await createCommand(commandBody({
      payload: { text: "no media yet", mediaFiles: ["vault_1"] },
    }));
    expect(mediaPayload.statusCode, mediaPayload.body).toBe(400);

    const badMediaCommand = await createCommand(mediaCommandBody({
      payload: {
        text: "bad media",
        price: 25,
        mediaFiles: ["3866342509"],
        previews: ["999"],
      },
    }));
    expect(badMediaCommand.statusCode, badMediaCommand.body).toBe(400);

    const typingPayload = await createCommand(typingCommandBody({
      payload: { text: "not a typing payload" },
    }));
    expect(typingPayload.statusCode, typingPayload.body).toBe(400);

    const unsendPayload = await createCommand(unsendCommandBody({
      payload: { messageId: "../987654321" },
    }));
    expect(unsendPayload.statusCode, unsendPayload.body).toBe(400);

    const markReadPayload = await createCommand(markReadCommandBody({
      payload: { text: "not a mark-read payload" },
    }));
    expect(markReadPayload.statusCode, markReadPayload.body).toBe(400);

    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;

    const hidden = await getCommand(commandId, otherChatterKey);
    expect(hidden.statusCode, hidden.body).toBe(404);
    const hiddenCancel = await cancelCommand(commandId, otherChatterKey);
    expect(hiddenCancel.statusCode, hiddenCancel.body).toBe(404);

    const cancelled = await cancelCommand(commandId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: "cancelled" });
    const repeated = await cancelCommand(commandId);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toMatchObject({ state: "cancelled" });
  });

  it("keeps payload text out of command responses across recovery surfaces", async () => {
    const cancelText = "r3 redaction cancel payload";
    const created = await createCommand(commandBody({ payload: { text: cancelText } }));
    expect(created.statusCode, created.body).toBe(202);
    expectResponseOmits(created, cancelText);

    const commandId = (created.json() as { commandId: string }).commandId;
    const fetched = await getCommand(commandId);
    expect(fetched.statusCode, fetched.body).toBe(200);
    expectResponseOmits(fetched, cancelText);
    const cancelled = await cancelCommand(commandId);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expectResponseOmits(cancelled, cancelText);

    const sourceText = "r3 redaction retry source payload";
    const retrySource = await createCommand(commandBody({ payload: { text: sourceText } }));
    const retrySourceId = (retrySource.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set state = 'indeterminate', updated_at = now() where id = $1",
      [retrySourceId],
    );
    const retryText = "r3 redaction retry payload";
    const retry = await createCommand(commandBody({
      payload: { text: retryText },
      retryOfCommandId: retrySourceId,
    }));
    expect(retry.statusCode, retry.body).toBe(202);
    expectResponseOmits(retry, retryText);
    expectResponseOmits(retry, sourceText);

    const staleText = "r3 redaction stale payload";
    const staleCreated = await createCommand(commandBody({ payload: { text: staleText } }));
    const staleId = (staleCreated.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'in_flight',
           attempt_count = 1,
           attempt_started_at = $2,
           updated_at = $2
       where id = $1`,
      [staleId, new Date("2026-06-19T19:00:00.000Z")],
    );
    appContext.config.ofapiDesktopCommandExecutionEnabled = false;
    await sweepOfapiCommands(
      appContext,
      { send: vi.fn() } as never,
      new Date("2026-06-19T20:00:00.000Z"),
    );
    const staleRecovered = await getCommand(staleId);
    expect(staleRecovered.statusCode, staleRecovered.body).toBe(200);
    expect(staleRecovered.json()).toMatchObject({
      state: "indeterminate",
      lastErrorCode: "worker_attempt_stale",
    });
    expectResponseOmits(staleRecovered, staleText);
  });

  it("accepts retry lineage only from an owned terminal command in the same lane", async () => {
    const original = await createCommand(commandBody());
    const originalId = (original.json() as { commandId: string }).commandId;

    const tooEarly = await createCommand(commandBody({
      retryOfCommandId: originalId,
    }));
    expect(tooEarly.statusCode, tooEarly.body).toBe(409);

    await testDb!.pool.query(
      "update ofapi_commands set state = 'indeterminate', updated_at = now() where id = $1",
      [originalId],
    );
    const retry = await createCommand(commandBody({
      retryOfCommandId: originalId,
    }));
    expect(retry.statusCode, retry.body).toBe(202);
    expect(retry.json()).toMatchObject({
      retryOfCommandId: originalId,
      state: "queued",
    });

    const mediaOriginal = await createCommand(mediaCommandBody());
    const mediaOriginalId = (mediaOriginal.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set state = 'indeterminate', updated_at = now() where id = $1",
      [mediaOriginalId],
    );
    const mediaRetry = await createCommand(mediaCommandBody({
      retryOfCommandId: mediaOriginalId,
    }));
    expect(mediaRetry.statusCode, mediaRetry.body).toBe(202);
    expect(mediaRetry.json()).toMatchObject({
      retryOfCommandId: mediaOriginalId,
      state: "queued",
    });

    const wrongLane = await createCommand(commandBody({
      conversationId: "987654321",
      retryOfCommandId: originalId,
    }));
    expect(wrongLane.statusCode, wrongLane.body).toBe(409);
  });

  it("rejects retry lineage across command kinds", async () => {
    const original = await createCommand(commandBody());
    const originalId = (original.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set state = 'cancelled', updated_at = now() where id = $1",
      [originalId],
    );

    const typingRetry = await createCommand(typingCommandBody({
      retryOfCommandId: originalId,
    }));
    expect(typingRetry.statusCode, typingRetry.body).toBe(400);

    const mediaRetryFromText = await createCommand(mediaCommandBody({
      retryOfCommandId: originalId,
    }));
    expect(mediaRetryFromText.statusCode, mediaRetryFromText.body).toBe(409);

    const typing = await createCommand(typingCommandBody());
    const typingId = (typing.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set state = 'indeterminate', updated_at = now() where id = $1",
      [typingId],
    );
    const textRetryFromTyping = await createCommand(commandBody({
      retryOfCommandId: typingId,
    }));
    expect(textRetryFromTyping.statusCode, textRetryFromTyping.body).toBe(409);

    const media = await createCommand(mediaCommandBody());
    const mediaId = (media.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set state = 'indeterminate', updated_at = now() where id = $1",
      [mediaId],
    );
    const textRetryFromMedia = await createCommand(commandBody({
      retryOfCommandId: mediaId,
    }));
    expect(textRetryFromMedia.statusCode, textRetryFromMedia.body).toBe(409);

    const unsendRetry = await createCommand(unsendCommandBody({
      retryOfCommandId: originalId,
    }));
    expect(unsendRetry.statusCode, unsendRetry.body).toBe(400);

    const markReadRetry = await createCommand(markReadCommandBody({
      retryOfCommandId: originalId,
    }));
    expect(markReadRetry.statusCode, markReadRetry.body).toBe(400);
  });

  it("refuses a queued command from an earlier binding generation without sending", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendTextMessage = vi.fn();
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];
    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query("update pages set ofapi_binding_generation=ofapi_binding_generation+1 where ofapi_account_id=$1", [ACCOUNT_ONE]);
    await executeOfapiCommand(appContext, commandId);
    await executeOfapiCommand(appContext, commandId);
    expect(sendTextMessage).not.toHaveBeenCalled();
    const result = (await getCommand(commandId)).json();
    expect(result).toMatchObject({
      state: "failed_terminal", attemptCount: 1, lastErrorCode: "ofapi_binding_replaced",
      verifierResult: { source: "local_precondition", reason: "binding_replaced" },
    });
    expect(result.verifierResult).not.toHaveProperty("httpStatus");
    const observations = await testDb!.pool.query(
      "select payload from observations where kind='command.failed_terminal' and payload->>'commandId'=$1",
      [commandId],
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0].payload).toMatchObject({ source: "local_precondition", reason: "binding_replaced" });
    expect(observations.rows[0].payload).not.toHaveProperty("httpStatus");
  });

  it.each([
    { expectedTeam: null, body: {}, status: 200, detail: "expected_team_unconfigured", calls: 0 },
    { expectedTeam: "expected", body: { team: { slug: "different" } }, status: 200, detail: "team_mismatch", calls: 1 },
    { expectedTeam: "expected", body: { error: "forbidden" }, status: 403, detail: "provider_access_denied", calls: 1 },
    { expectedTeam: "expected", body: {}, status: 200, detail: "team_missing", calls: 1 },
  ])("records a local credential refusal for $detail without a send or fake HTTP response", async ({ expectedTeam, body, status, detail, calls }) => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    appContext.config.ofapiExpectedTeamSlug = expectedTeam;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    appContext.ofapi = createOfapiClient({
      apiKey: "synthetic-credential", restDelayMs: 0,
      ...ofapiCredentialPolicy(appContext.db, appContext.config, appContext.logger),
    });
    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(appContext, commandId)).resolves.toMatchObject({ status: "failed_terminal" });
    await executeOfapiCommand(appContext, commandId);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/\/whoami$/);
      expect(init).toMatchObject({ method: "GET" });
    }
    const result = (await getCommand(commandId)).json();
    expect(result).toMatchObject({
      state: "failed_terminal", attemptCount: 1, lastErrorCode: "ofapi_credential_not_verified",
      verifierResult: { source: "local_precondition", reason: "credential_not_verified", detail },
    });
    expect(result.verifierResult).not.toHaveProperty("httpStatus");
    const observations = await testDb!.pool.query(
      "select payload from observations where kind='command.failed_terminal' and payload->>'commandId'=$1",
      [commandId],
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0].payload).toMatchObject({ source: "local_precondition", reason: "credential_not_verified", detail });
    expect(observations.rows[0].payload).not.toHaveProperty("httpStatus");
  });

  it.each([
    ["account_not_found", "account_unavailable", "ofapi_account_not_found"],
    ["authentication_failed", "auth_action_required", "ofapi_auth_action_required"],
  ])("keeps an existing %s marker local without redispatch or re-parking", async (authStatus, reason, errorCode) => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    appContext.config.ofapiAccountHealthEnabled = false;
    const sendTextMessage = vi.fn();
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];
    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query("update pages set ofapi_auth_status=$1 where ofapi_account_id=$2", [authStatus, ACCOUNT_ONE]);
    await executeOfapiCommand(appContext, commandId);
    expect(sendTextMessage).not.toHaveBeenCalled();
    const result = (await getCommand(commandId)).json();
    expect(result).toMatchObject({
      state: "failed_terminal", attemptCount: 1, lastErrorCode: errorCode,
      verifierResult: { source: "local_precondition", reason },
    });
    expect(result.verifierResult).not.toHaveProperty("httpStatus");
    const page = await testDb!.pool.query("select ofapi_auth_changed_at from pages where ofapi_account_id=$1", [ACCOUNT_ONE]);
    expect(page.rows[0].ofapi_auth_changed_at).toBeNull();
  });

  it("keeps a real command HTTP 403 distinct from a local credential refusal", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ team: { slug: "expected" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    appContext.ofapi = createOfapiClient({ apiKey: "synthetic-credential", restDelayMs: 0, credentialPolicy: { expectedTeamSlug: "expected" } });
    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await executeOfapiCommand(appContext, commandId);
    await executeOfapiCommand(appContext, commandId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "failed_terminal", attemptCount: 1, lastErrorCode: "ofapi_http_403",
      verifierResult: { source: "ofapi_response", httpStatus: 403 },
    });
  });

  it("R4 confirms a sent command with pending credit evidence and never reexecutes it", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendTextMessage = vi.fn().mockResolvedValue({ messageId: "987654321", creditAccounting: "pending" });
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];
    const created = await createCommand(commandBody());
    const { commandId } = created.json() as { commandId: string };
    await expect(executeOfapiCommand(appContext, commandId)).resolves.toMatchObject({ status: "confirmed" });
    await executeOfapiCommand(appContext, commandId);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect((await getCommand(commandId)).json()).toMatchObject({ state: "confirmed", platformMessageId: "987654321",
      verifierResult: { source: "ofapi_response", creditAccounting: "pending" } });
  });

  it("R4 classifies an accounting admission refusal as local without a false provider response", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    appContext.ofapi = { sendTextMessage: vi.fn().mockRejectedValue(new OfapiCreditAccountingUnavailableError()) } as unknown as AppContext["ofapi"];
    const created = await createCommand(commandBody());
    const { commandId } = created.json() as { commandId: string };
    await expect(executeOfapiCommand(appContext, commandId)).resolves.toMatchObject({ status: "failed_terminal" });
    expect((await getCommand(commandId)).json()).toMatchObject({ state: "failed_terminal",
      lastErrorCode: "ofapi_credit_accounting_unavailable",
      verifierResult: { source: "local_precondition", reason: "credit_accounting_unavailable" } });
  });

  it("executes one vendor attempt and confirms from the response id", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendTextMessage = vi.fn().mockResolvedValue({ messageId: "987654321" });
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(
      appContext,
      commandId,
      new Date("2026-06-19T20:00:00.000Z"),
    )).resolves.toMatchObject({ status: "confirmed", commandId });
    await executeOfapiCommand(appContext, commandId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      { pageId: expect.any(Number) },
      ACCOUNT_ONE,
      CONVERSATION,
      { text: "c6b intake validation only" },
    );
    const fetched = await getCommand(commandId);
    expect(fetched.json()).toMatchObject({
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: "987654321",
      attemptStartedAt: "2026-06-19T20:00:00.000Z",
      attemptFinishedAt: expect.any(String),
      verifierResult: { source: "ofapi_response" },
    });
    expect(fetched.body).not.toContain("c6b intake validation only");

    // Stage 7 producer 5: the settle emitted exactly one command_result
    // observation (the second executeOfapiCommand call above is a no-op on
    // an already-terminal command).
    const observations = await testDb!.pool.query<{
      kind: string;
      idempotency_key: string;
      actor_principal_id: string | null;
    }>(
      `select kind, idempotency_key, actor_principal_id::text as actor_principal_id
       from observations where source = 'command_result'`,
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({
      kind: "command.confirmed",
      idempotency_key: `cmd:${commandId}:confirmed`,
    });
    expect(observations.rows[0]!.actor_principal_id).not.toBeNull();
  });

  it("executes one media vendor attempt and confirms from the response id", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendMediaMessage = vi.fn().mockResolvedValue({ messageId: "987654322" });
    appContext.ofapi = { sendMediaMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(mediaCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(
      appContext,
      commandId,
      new Date("2026-06-19T20:02:00.000Z"),
    )).resolves.toMatchObject({ status: "confirmed", commandId });
    await executeOfapiCommand(appContext, commandId);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(sendMediaMessage).toHaveBeenCalledWith(
      { pageId: expect.any(Number) },
      ACCOUNT_ONE,
      CONVERSATION,
      {
        text: "c6 media validation only",
        price: 25,
        mediaFiles: ["3866342509", "ofapi_media_abc123"],
        previews: ["3866342509"],
      },
    );
    const fetched = await getCommand(commandId);
    expect(fetched.json()).toMatchObject({
      kind: "send_media_message_v1",
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: "987654322",
      attemptStartedAt: "2026-06-19T20:02:00.000Z",
      attemptFinishedAt: expect.any(String),
      verifierResult: { source: "ofapi_response", commandKind: "send_media_message_v1" },
    });
    expect(fetched.body).not.toContain("c6 media validation only");
    expect(fetched.body).not.toContain("ofapi_media_abc123");
  });

  it("executes one typing beacon attempt and confirms without a platform message id", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const startTyping = vi.fn().mockResolvedValue({ success: true });
    appContext.ofapi = { startTyping } as unknown as AppContext["ofapi"];

    const created = await createCommand(typingCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(
      appContext,
      commandId,
      new Date("2026-06-19T20:05:00.000Z"),
    )).resolves.toMatchObject({ status: "confirmed", commandId });
    await executeOfapiCommand(appContext, commandId);

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(startTyping).toHaveBeenCalledWith(
      { pageId: expect.any(Number) },
      ACCOUNT_ONE,
      CONVERSATION,
    );
    const fetched = await getCommand(commandId);
    expect(fetched.json()).toMatchObject({
      kind: "typing_active_v1",
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: null,
      attemptStartedAt: "2026-06-19T20:05:00.000Z",
      attemptFinishedAt: expect.any(String),
      verifierResult: { source: "ofapi_response", commandKind: "typing_active_v1" },
    });
    expect("payload" in (fetched.json() as Record<string, unknown>)).toBe(false);

    const resultFacts = await testDb!.pool.query<{ count: number }>(
      `select count(*)::int as count from observations
       where source = 'command_result' and payload ->> 'commandId' = $1`,
      [commandId],
    );
    expect(resultFacts.rows[0]?.count).toBe(0);

    await testDb!.pool.query(
      `update ofapi_commands
          set created_at = now() - interval '3 minutes',
              dedupe_expires_at = now() - interval '1 second'
        where id = $1`,
      [commandId],
    );
    appContext.config.ofapiDesktopCommandExecutionEnabled = false;
    await expect(sweepOfapiCommands(appContext, { send: vi.fn() } as never))
      .resolves.toMatchObject({ purged: 1 });
    expect((await getCommand(commandId)).statusCode).toBe(404);
  });

  it("never executes a stale typing beacon and purges it after the short dedupe window", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const startTyping = vi.fn().mockResolvedValue({ success: true });
    appContext.ofapi = { startTyping } as unknown as AppContext["ofapi"];

    const created = await createCommand(typingCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set created_at = now() - interval '11 seconds' where id = $1",
      [commandId],
    );

    await expect(executeOfapiCommand(appContext, commandId))
      .resolves.toMatchObject({ status: "not_claimed" });
    expect(startTyping).not.toHaveBeenCalled();

    appContext.config.ofapiDesktopCommandExecutionEnabled = false;
    await expect(sweepOfapiCommands(appContext, { send: vi.fn() } as never))
      .resolves.toMatchObject({ expired: 1, purged: 0, enqueued: 0 });
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "cancelled",
      attemptCount: 0,
      lastErrorCode: "expired_queued_ttl",
    });

    const resultFacts = await testDb!.pool.query<{ count: number }>(
      `select count(*)::int as count from observations
       where source = 'command_result' and payload ->> 'commandId' = $1`,
      [commandId],
    );
    expect(resultFacts.rows[0]?.count).toBe(0);

    await testDb!.pool.query(
      "update ofapi_commands set dedupe_expires_at = now() - interval '1 second' where id = $1",
      [commandId],
    );
    await expect(sweepOfapiCommands(appContext, { send: vi.fn() } as never))
      .resolves.toMatchObject({ expired: 0, purged: 1, enqueued: 0 });
    expect((await getCommand(commandId)).statusCode).toBe(404);
  });

  it("executes one unsend attempt and confirms with the target platform message id", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const unsendMessage = vi.fn().mockResolvedValue({ success: true });
    appContext.ofapi = { unsendMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(unsendCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(
      appContext,
      commandId,
      new Date("2026-06-19T20:06:00.000Z"),
    )).resolves.toMatchObject({ status: "confirmed", commandId });
    await executeOfapiCommand(appContext, commandId);

    expect(unsendMessage).toHaveBeenCalledTimes(1);
    expect(unsendMessage).toHaveBeenCalledWith(
      { pageId: expect.any(Number) },
      ACCOUNT_ONE,
      CONVERSATION,
      "987654321",
    );
    const fetched = await getCommand(commandId);
    expect(fetched.json()).toMatchObject({
      kind: "unsend_message_v1",
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: "987654321",
      attemptStartedAt: "2026-06-19T20:06:00.000Z",
      attemptFinishedAt: expect.any(String),
      verifierResult: { source: "ofapi_response", commandKind: "unsend_message_v1" },
    });
    expect("payload" in (fetched.json() as Record<string, unknown>)).toBe(false);
  });

  it("executes one mark-read attempt and confirms without a platform message id", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const markChatRead = vi.fn().mockResolvedValue({ success: true });
    appContext.ofapi = { markChatRead } as unknown as AppContext["ofapi"];

    const created = await createCommand(markReadCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(
      appContext,
      commandId,
      new Date("2026-06-19T20:07:00.000Z"),
    )).resolves.toMatchObject({ status: "confirmed", commandId });
    await executeOfapiCommand(appContext, commandId);

    expect(markChatRead).toHaveBeenCalledTimes(1);
    expect(markChatRead).toHaveBeenCalledWith(
      { pageId: expect.any(Number) },
      ACCOUNT_ONE,
      CONVERSATION,
    );
    const fetched = await getCommand(commandId);
    expect(fetched.json()).toMatchObject({
      kind: "mark_chat_read_v1",
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: null,
      attemptStartedAt: "2026-06-19T20:07:00.000Z",
      attemptFinishedAt: expect.any(String),
      verifierResult: { source: "ofapi_response", commandKind: "mark_chat_read_v1" },
    });
    expect("payload" in (fetched.json() as Record<string, unknown>)).toBe(false);
  });


  it("repairs an indeterminate send from one matching messages.sent webhook", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendTextMessage = vi.fn().mockRejectedValue(
      new OfapiApiError("sanitized transport outcome", null, null),
    );
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(commandBody({
      payload: { text: "repair me" },
    }));
    const commandId = (created.json() as { commandId: string }).commandId;
    const attemptStartedAt = new Date("2026-06-19T20:10:00.000Z");
    await executeOfapiCommand(appContext, commandId, attemptStartedAt);

    const verified = await verifyOfapiCommandFromSentWebhook(appContext, {
      id: 9001,
      eventType: "messages.sent",
      ofapiAccountId: ACCOUNT_ONE,
      receivedAt: new Date("2026-06-19T20:10:01.000Z"),
      payload: {
        event: "messages.sent",
        account_id: ACCOUNT_ONE,
        payload: {
          id: 1234567890,
          text: "<p>repair me</p>",
          toUser: { id: Number(CONVERSATION) },
        },
      },
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(verified).toMatchObject({ status: "confirmed", commandId });
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: "1234567890",
      verifierResult: { source: "messages.sent", eventId: 9001 },
    });
  });

  it("repairs an indeterminate media send from a matching messages.sent webhook", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendMediaMessage = vi.fn().mockRejectedValue(
      new OfapiApiError("sanitized transport outcome", null, null),
    );
    appContext.ofapi = { sendMediaMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(mediaCommandBody({
      payload: {
        text: "",
        price: 25,
        mediaFiles: ["3866342509", "ofapi_media_abc123"],
        previews: ["3866342509"],
      },
    }));
    const commandId = (created.json() as { commandId: string }).commandId;
    const attemptStartedAt = new Date("2026-06-19T20:11:00.000Z");
    await executeOfapiCommand(appContext, commandId, attemptStartedAt);

    const verified = await verifyOfapiCommandFromSentWebhook(appContext, {
      id: 9003,
      eventType: "messages.sent",
      ofapiAccountId: ACCOUNT_ONE,
      receivedAt: new Date("2026-06-19T20:11:01.000Z"),
      payload: {
        event: "messages.sent",
        account_id: ACCOUNT_ONE,
        payload: {
          id: 1234567892,
          text: "",
          price: 25,
          media: [{ id: "redacted-a" }, { id: "redacted-b" }],
          toUser: { id: Number(CONVERSATION) },
        },
      },
    });

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(verified).toMatchObject({ status: "confirmed", commandId });
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "confirmed",
      attemptCount: 1,
      platformMessageId: "1234567892",
      verifierResult: { source: "messages.sent", eventId: 9003 },
    });
  });

  it("does not match typing commands from messages.sent webhooks", async () => {
    const created = await createCommand(typingCommandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'in_flight',
           attempt_count = 1,
           attempt_started_at = $2,
           updated_at = $2
       where id = $1`,
      [commandId, new Date("2026-06-19T20:20:00.000Z")],
    );

    const verified = await verifyOfapiCommandFromSentWebhook(appContext, {
      id: 9002,
      eventType: "messages.sent",
      ofapiAccountId: ACCOUNT_ONE,
      receivedAt: new Date("2026-06-19T20:20:01.000Z"),
      payload: {
        event: "messages.sent",
        account_id: ACCOUNT_ONE,
        payload: {
          id: 1234567891,
          text: "<p>typing should not match text</p>",
          toUser: { id: Number(CONVERSATION) },
        },
      },
    });

    expect(verified).toEqual({ status: "no_match" });
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "in_flight",
      platformMessageId: null,
    });
  });

  it("sends-as-facts (Wave 2): a direct-confirmed text send lands in dm_message_archive as source=command with observation-key lineage", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    appContext.config.ofapiDmColdArchiveEnabled = true;
    const sendTextMessage = vi.fn().mockResolvedValue({ messageId: "555600555" });
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(commandBody({ payload: { text: "fact me" } }));
    const commandId = (created.json() as { commandId: string }).commandId;
    await expect(executeOfapiCommand(appContext, commandId)).resolves.toMatchObject({
      status: "confirmed",
    });

    const rows = await testDb!.pool.query(
      `select source, source_event_type, source_idempotency_key, source_journal_id,
              sender_role::text as sender_role, is_sent_by_me, text_plain,
              platform_conversation_id, emitted_fingerprint,
              material_fingerprint is not null as has_material
       from dm_message_archive where platform_message_id = '555600555'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      source: "command",
      source_event_type: "messages.sent",
      source_idempotency_key: `cmd:${commandId}:confirmed`,
      source_journal_id: null,
      sender_role: "model",
      is_sent_by_me: true,
      text_plain: "fact me",
      platform_conversation_id: CONVERSATION,
      // emitted NULL: the corrections reconciler appends the first
      // message.sent event through the cmd observation lineage.
      emitted_fingerprint: null,
      has_material: true,
    });

    // A later webhook for the same send is a fill/no-op, never a duplicate
    // row (the candidate path collapses the race by construction).
    const { upsertDmMessageArchive } = await import("@agency_hub_core/db");
    const webhook = await upsertDmMessageArchive(appContext.db, {
      platform: "onlyfans",
      platformAccountId: rows.rows[0]!.platform_account_id ?? (await testDb!.pool.query(
        `select platform_account_id from dm_message_archive where platform_message_id = '555600555'`,
      )).rows[0]!.platform_account_id,
      ofapiAccountId: ACCOUNT_ONE,
      platformConversationId: CONVERSATION,
      fanPlatformUserId: CONVERSATION,
      platformMessageId: "555600555",
      senderPlatformUserId: null,
      senderRole: "model",
      isSentByMe: true,
      // A real late webhook arrives AFTER the confirm — platform createdAt
      // and receipt time both later than the command's confirm instant.
      messageCreatedAt: new Date(Date.now() + 2_000),
      textPlain: "fact me",
      isTip: false,
      tipAmountMills: 0n,
      source: "webhook",
      sourceEventType: "messages.sent",
      sourceIdempotencyKey: "wh-fact-555600555",
      sourceJournalId: 77,
      sourceReceivedAt: new Date(Date.now() + 3_000),
      rawShapeVersion: "ofapi-message-v1",
      mediaMetadata: [],
      retentionPolicy: "default",
      retainUntil: new Date("2126-01-01T00:00:00Z"),
    });
    // Webhook replaces command-grade createdAt under W → written, same row.
    expect(webhook.status).toBe("written");
    const after = await testDb!.pool.query(
      "select count(*)::int as n from dm_message_archive where platform_message_id = '555600555'",
    );
    expect(after.rows[0].n).toBe(1);
  });

  it("raced seam (Wave 2 fix): a failure finalize losing to a webhook confirm records NO failure fact", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    let resolveWebhookDone: () => void;
    const webhookDone = new Promise<void>((resolve) => { resolveWebhookDone = resolve; });
    // The vendor call "fails" client-side AFTER the webhook has already
    // confirmed the command (the send actually landed).
    const sendTextMessage = vi.fn().mockImplementation(async () => {
      await webhookDone;
      throw new OfapiApiError("connection reset mid-response", null, null);
    });
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(commandBody({ payload: { text: "raced send" } }));
    const commandId = (created.json() as { commandId: string }).commandId;
    const attemptStartedAt = new Date("2026-06-19T21:00:00.000Z");
    const execution = executeOfapiCommand(appContext, commandId, attemptStartedAt);
    // Give the executor a beat to claim in_flight, then confirm via webhook.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const verified = await verifyOfapiCommandFromSentWebhook(appContext, {
      id: 9101,
      eventType: "messages.sent",
      ofapiAccountId: ACCOUNT_ONE,
      receivedAt: new Date("2026-06-19T21:00:01.000Z"),
      payload: {
        event: "messages.sent",
        account_id: ACCOUNT_ONE,
        payload: { id: 777800777, text: "<p>raced send</p>", toUser: { id: Number(CONVERSATION) } },
      },
    });
    expect(verified).toMatchObject({ status: "confirmed", commandId });
    resolveWebhookDone!();
    const raced = await execution;
    // Pre-fix this returned failure AND journaled a failed_* observation for
    // a CONFIRMED command; now the executor reports the actual state.
    expect(raced).toMatchObject({ status: "confirmed", commandId, raced: true });

    expect((await getCommand(commandId)).json()).toMatchObject({ state: "confirmed" });
    const observations = await testDb!.pool.query(
      `select kind from observations where source = 'command_result' order by kind`,
    );
    // Exactly ONE fact: the webhook confirm. No failed_* observation exists.
    expect(observations.rows).toEqual([{ kind: "command.confirmed" }]);
  });

  it("marks a stale in-flight attempt indeterminate even while execution is disabled", async () => {
    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'in_flight',
           attempt_count = 1,
           attempt_started_at = $2,
           updated_at = $2
       where id = $1`,
      [commandId, new Date("2026-06-19T19:00:00.000Z")],
    );
    appContext.config.ofapiDesktopCommandExecutionEnabled = false;
    const send = vi.fn();

    await expect(sweepOfapiCommands(
      appContext,
      { send } as never,
      new Date("2026-06-19T20:00:00.000Z"),
    )).resolves.toEqual({ expired: 0, stale: 1, purged: 0, enqueued: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "indeterminate",
      attemptCount: 1,
      lastErrorCode: "worker_attempt_stale",
      verifierResult: { source: "stale_recovery" },
    });
  });

  // W3.2 (A4+A23, decision #125): queued-only rows past the TTL expire to
  // cancelled at the sweep — WHILE execution is disabled (the exact bug
  // window where rows used to park forever and fire hours late on re-enable).
  it("expires parked queued rows past the TTL to cancelled: journaled, idempotent, fresh rows survive, expired rows stay retryable", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = false;

    const aged = await createCommand(commandBody());
    const agedId = (aged.json() as { commandId: string }).commandId;
    const fresh = await createCommand(commandBody());
    const freshId = (fresh.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set created_at = now() - interval '11 minutes' where id = $1",
      [agedId],
    );

    const send = vi.fn();
    await expect(sweepOfapiCommands(appContext, { send } as never))
      .resolves.toMatchObject({ expired: 1, enqueued: 0 });
    expect(send).not.toHaveBeenCalled();

    expect((await getCommand(agedId)).json()).toMatchObject({
      state: "cancelled",
      lastErrorCode: "expired_queued_ttl",
      attemptCount: 0,
    });
    expect((await getCommand(freshId)).json()).toMatchObject({
      state: "queued",
    });

    // Journaled under the same idempotency key a client cancel would use —
    // the two paths dedupe into one fact.
    const observations = await testDb!.pool.query<{ kind: string }>(
      `select kind from observations
       where source = 'command_result' and idempotency_key = $1`,
      [`cmd:${agedId}:cancelled`],
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({ kind: "command.cancelled" });

    // Idempotent re-run: nothing left to expire, no duplicate observation.
    await expect(sweepOfapiCommands(appContext, { send } as never))
      .resolves.toMatchObject({ expired: 0 });
    const observationCount = await testDb!.pool.query<{ count: number }>(
      `select count(*)::int as count from observations
       where source = 'command_result' and idempotency_key = $1`,
      [`cmd:${agedId}:cancelled`],
    );
    expect(observationCount.rows[0]?.count).toBe(1);

    // cancelled is a RETRYABLE_SOURCE_STATES member: the chatter can retry.
    const retry = await createCommand(commandBody({ retryOfCommandId: agedId }));
    expect(retry.statusCode, retry.body).toBe(202);
    expect(retry.json()).toMatchObject({
      retryOfCommandId: agedId,
      state: "queued",
    });
  });

  it("never claims a queued row older than the TTL even when an execute job races the sweep (W3.2 claim belt)", async () => {
    appContext.config.ofapiDesktopCommandExecutionEnabled = true;
    const sendTextMessage = vi.fn().mockResolvedValue({ messageId: "987654321" });
    appContext.ofapi = { sendTextMessage } as unknown as AppContext["ofapi"];

    const created = await createCommand(commandBody());
    const commandId = (created.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      "update ofapi_commands set created_at = now() - interval '11 minutes' where id = $1",
      [commandId],
    );

    await expect(executeOfapiCommand(appContext, commandId))
      .resolves.toMatchObject({ status: "not_claimed" });
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "queued",
      attemptCount: 0,
    });
  });

  it("leaves old terminal payloads intact permanently (Stage 28: redaction switch retired)", async () => {
    const oldTerminalText = "old terminal payload survives the stand-down";
    const oldTerminal = await createCommand(commandBody({ payload: { text: oldTerminalText } }));
    const oldTerminalId = (oldTerminal.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'confirmed',
           updated_at = $2,
           platform_message_id = 'platform-standdown'
       where id = $1`,
      [oldTerminalId, new Date("2026-06-01T20:00:00.000Z")],
    );

    await expect(sweepOfapiCommands(
      appContext,
      { send: vi.fn() } as never,
      new Date("2026-06-19T20:00:00.000Z"),
    )).resolves.toEqual({ expired: 0, stale: 0, purged: 0, enqueued: 0 });

    const payloads = await testDb!.pool.query<{
      payload_text: string;
      payload_redacted_at: Date | null;
    }>(
      `select payload->>'text' as payload_text,
              payload_redacted_at
       from ofapi_commands
       where id = $1`,
      [oldTerminalId],
    );
    expect(payloads.rows[0]).toMatchObject({
      payload_text: oldTerminalText,
      payload_redacted_at: null,
    });
  });
});

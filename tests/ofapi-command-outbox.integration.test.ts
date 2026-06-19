import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { OfapiApiError } from "../apps/runtime/src/services/ofapi.ts";
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

    const wrongLane = await createCommand(commandBody({
      conversationId: "987654321",
      retryOfCommandId: originalId,
    }));
    expect(wrongLane.statusCode, wrongLane.body).toBe(409);
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
    )).resolves.toEqual({ stale: 1, purged: 0, enqueued: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await getCommand(commandId)).json()).toMatchObject({
      state: "indeterminate",
      attemptCount: 1,
      lastErrorCode: "worker_attempt_stale",
      verifierResult: { source: "stale_recovery" },
    });
  });

  it("redacts old terminal payload text without changing status export or recovery rows", async () => {
    const oldTerminalText = "old terminal payload should purge";
    const oldTerminal = await createCommand(commandBody({ payload: { text: oldTerminalText } }));
    const oldTerminalId = (oldTerminal.json() as { commandId: string; payloadHash: string }).commandId;
    const oldTerminalHash = (oldTerminal.json() as { payloadHash: string }).payloadHash;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'confirmed',
           updated_at = $2,
           platform_message_id = 'platform-old'
       where id = $1`,
      [oldTerminalId, new Date("2026-06-01T20:00:00.000Z")],
    );

    const recentText = "recent terminal payload should stay temporarily";
    const recentTerminal = await createCommand(commandBody({ payload: { text: recentText } }));
    const recentTerminalId = (recentTerminal.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'failed_terminal',
           updated_at = $2,
           last_error_code = 'ofapi_http_422',
           last_error_class = 'terminal'
       where id = $1`,
      [recentTerminalId, new Date("2026-06-18T20:00:00.000Z")],
    );

    const recoveryText = "indeterminate payload must remain for manual recovery";
    const recoveryCommand = await createCommand(commandBody({ payload: { text: recoveryText } }));
    const recoveryCommandId = (recoveryCommand.json() as { commandId: string }).commandId;
    await testDb!.pool.query(
      `update ofapi_commands
       set state = 'indeterminate',
           attempt_count = 1,
           attempt_started_at = $2,
           attempt_finished_at = $2,
           updated_at = $2,
           last_error_code = 'ofapi_transport_unknown',
           last_error_class = 'indeterminate'
       where id = $1`,
      [recoveryCommandId, new Date("2026-06-01T20:00:00.000Z")],
    );

    await expect(sweepOfapiCommands(
      appContext,
      { send: vi.fn() } as never,
      new Date("2026-06-19T20:00:00.000Z"),
    )).resolves.toEqual({ stale: 0, purged: 1, enqueued: 0 });

    const payloads = await testDb!.pool.query<{
      id: string;
      payload_text: string;
      payload_redacted_at: Date | null;
      payload_hash: string;
    }>(
      `select id,
              payload->>'text' as payload_text,
              payload_redacted_at,
              payload_hash
       from ofapi_commands
       where id = any($1::uuid[])
       order by id`,
      [[oldTerminalId, recentTerminalId, recoveryCommandId]],
    );
    const byId = new Map(payloads.rows.map((row) => [row.id, row]));
    expect(byId.get(oldTerminalId)).toMatchObject({
      payload_text: "",
      payload_hash: oldTerminalHash,
    });
    expect(byId.get(oldTerminalId)?.payload_redacted_at?.toISOString()).toBe(
      "2026-06-19T20:00:00.000Z",
    );
    expect(byId.get(recentTerminalId)).toMatchObject({
      payload_text: recentText,
      payload_redacted_at: null,
    });
    expect(byId.get(recoveryCommandId)).toMatchObject({
      payload_text: recoveryText,
      payload_redacted_at: null,
    });

    const fetched = await getCommand(oldTerminalId);
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json()).toMatchObject({
      commandId: oldTerminalId,
      state: "confirmed",
      payloadHash: oldTerminalHash,
      platformMessageId: "platform-old",
    });
    expectResponseOmits(fetched, oldTerminalText);
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
});

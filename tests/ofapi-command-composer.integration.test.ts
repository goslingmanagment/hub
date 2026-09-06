import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  setPageOfapiAccountId,
  reserveOfapiProviderOperation,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
import {
  executeOfapiCommand,
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

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  if (!testDb) {
    throw new Error("Integration database required");
  }
  await apiServer?.close();
  await resetIntegrationDatabase(testDb.pool);

  appContext = createTestAppContext(testDb, {
    ofapiCreditLedgerEnabled: true,
    ofapiDesktopReadGatewayEnabled: true,
    ofapiDesktopCommandOutboxEnabled: true,
    ofapiDesktopCommandExecutionEnabled: true,
  });
  const model = await createModel(appContext.db, { slug: "lora", name: "Lora" });
  const assignedPage = await createOnlyFansPage(appContext.db, {
    modelId: model!.id,
    label: "lora-of",
  });
  const unassignedPage = await createOnlyFansPage(appContext.db, {
    modelId: model!.id,
    label: "lora-vip-of",
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: assignedPage!.id,
    ofapiAccountId: ACCOUNT_ONE,
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: unassignedPage!.id,
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


const v2Payload = { text: "hello", priceCents: 697, mediaFiles: ["ofapi_media_token"], previews: [], lockedText: false, replyToMessageId: null, giphyId: null, rfTag: [], rfPartner: [], rfGuest: [], blockBannedWords: null, reuseProviderOperation: false };
async function createCommand(extra: Record<string, unknown> = {}, key = chatterKey) {
  return apiServer!.inject({ method: "POST", url: "/api/v1/ofapi/commands", headers: { authorization: `Bearer ${key}` }, payload: { clientCommandId: randomUUID(), kind: "send_message_v2", accountId: ACCOUNT_ONE, conversationId: CONVERSATION, payload: v2Payload, ...extra } });
}
function installedClient(send: ReturnType<typeof vi.fn>) {
  appContext.ofapi = { executeExtendedCommand: send, getCredentialPreflight: async () => ({ status: "verified", expectedTeam: "team", observedTeam: "team", credentialFingerprint: "synthetic", checkedAt: new Date().toISOString(), reason: null, rosterScope: "unknown" }) } as unknown as AppContext["ofapi"];
}
describe("durable send-v2 provider operation custody", () => {
  it("keeps a failed send one-attempt and only explicit unchanged recovery reuses its provider key", async () => {
    const send = vi.fn().mockRejectedValueOnce(new OfapiApiError("timeout", null, null)).mockResolvedValue({ messageId: "999" }); installedClient(send);
    const created = await createCommand(); expect(created.statusCode).toBe(202); const id = created.json().commandId;
    expect((await executeOfapiCommand(appContext, id)).status).toBe("indeterminate");
    expect((await executeOfapiCommand(appContext, id)).status).toBe("not_claimed"); expect(send).toHaveBeenCalledTimes(1);
    const retry = await createCommand({ retryOfCommandId: id, payload: { ...v2Payload, reuseProviderOperation: true } }); expect(retry.statusCode).toBe(202);
    expect((await executeOfapiCommand(appContext, retry.json().commandId)).status).toBe("confirmed");
    expect(send.mock.calls[0]?.[5]).toBe(send.mock.calls[1]?.[5]);
    const rows = await testDb!.pool.query("select distinct operation_id,first_attempt_at from ofapi_command_provider_operations"); expect(rows.rowCount).toBe(1);
  });
  it("refuses edited replay and reusing a single-use CDN token for another logical send", async () => {
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null)); installedClient(send);
    const first = (await createCommand()).json().commandId; await executeOfapiCommand(appContext, first);
    const edited = (await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, text: "edited", reuseProviderOperation: true } })).json().commandId;
    expect((await executeOfapiCommand(appContext, edited)).status).toBe("failed_terminal");
    const another = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, another)).status).toBe("failed_terminal");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("cannot extend the original 24h recovery window", async () => {
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null)); installedClient(send);
    const first = (await createCommand()).json().commandId; await executeOfapiCommand(appContext, first);
    await testDb!.pool.query("update ofapi_command_provider_operations set first_attempt_at=clock_timestamp()-interval '25 hours' where command_id=$1", [first]);
    const retry = (await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, reuseProviderOperation: true } })).json().commandId;
    expect((await executeOfapiCommand(appContext, retry)).status).toBe("failed_terminal"); expect(send).toHaveBeenCalledTimes(1);
  });
  it("enforces page scope and original command owner on manual recoveries", async () => {
    const forbidden = await createCommand({ accountId: ACCOUNT_TWO }); expect(forbidden.statusCode).toBe(404);
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null)); installedClient(send);
    const first = (await createCommand()).json().commandId; await executeOfapiCommand(appContext, first);
    const foreign = await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, reuseProviderOperation: true } }, otherChatterKey);
    expect(foreign.statusCode).toBe(409);
  });
  it("custody reservations rollback together when a token is already owned", async () => {
    const first = (await createCommand()).json().commandId;
    const second = (await createCommand()).json().commandId;
    const common = { parentCommandId: null, reuse: false, teamSlug: "team", accountId: ACCOUNT_ONE, endpoint: "/messages", bodyHash: "h", tokens: ["ofapi_media_token"] };
    const results = await Promise.allSettled([reserveOfapiProviderOperation(appContext.db, { ...common, commandId: first }), reserveOfapiProviderOperation(appContext.db, { ...common, commandId: second })]);
    expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect((await testDb!.pool.query("select count(*)::int n from ofapi_command_provider_operations")).rows[0].n).toBe(1);
  });
});

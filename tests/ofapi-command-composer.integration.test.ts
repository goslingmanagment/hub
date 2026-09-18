import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  isOfapiMediaTokenReserved,
  releaseOfapiMediaTokenCustody,
  setPageOfapiAccountId,
  reserveOfapiProviderOperation,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import {
  executeOfapiCommand,
  sweepOfapiCommands,
} from "../apps/runtime/src/services/ofapi-command-executor.ts";
import { OfapiApiError, OfapiCreditAccountingUnavailableError } from "../apps/runtime/src/services/ofapi.ts";
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
  chatterKey = (await issueChatterDeviceToken(appContext, {
    username: "chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  await createUserAccount(appContext, {
    username: "other-chatter",
    role: "chatter",
  }, { source: "cli" });
  otherChatterKey = (await issueChatterDeviceToken(appContext, {
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
  it("reserves a legacy CDN attachment at execution and rejects a second v1 or v2 send without replay", async () => {
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null));
    installedClient(send);
    appContext.ofapi!.sendMediaMessage = send;
    const payload = { text: "Legacy media", price: 0, mediaFiles: ["ofapi_media_token"], previews: [] };
    const first = (await createCommand({ kind: "send_media_message_v1", payload })).json().commandId;
    expect((await testDb!.pool.query("select * from ofapi_media_token_fences")).rows).toEqual([]);
    expect((await executeOfapiCommand(appContext, first)).status).toBe("indeterminate");
    expect((await executeOfapiCommand(appContext, first)).status).toBe("not_claimed");
    const second = (await createCommand({ kind: "send_media_message_v1", payload })).json().commandId;
    expect((await executeOfapiCommand(appContext, second)).status).toBe("failed_terminal");
    const v2 = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, v2)).status).toBe("failed_terminal");
    expect(send).toHaveBeenCalledTimes(1);
    expect((await testDb!.pool.query("select operation_id from ofapi_media_token_fences")).rows).toEqual([{ operation_id: first }]);
    expect((await testDb!.pool.query("select * from ofapi_command_provider_operations")).rows).toEqual([]);
  });

  it("does not burn a legacy token when retained payload validation fails before dispatch", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "999" });
    installedClient(send);
    appContext.ofapi!.sendMediaMessage = send;
    const payload = { text: "Legacy media", price: 0, mediaFiles: ["ofapi_media_token"], previews: [] };
    const invalid = (await createCommand({ kind: "send_media_message_v1", payload })).json().commandId;
    await testDb!.pool.query("update ofapi_commands set payload=$2::jsonb where id=$1", [invalid, JSON.stringify({ ...payload, price: 2 })]);
    expect((await executeOfapiCommand(appContext, invalid)).status).toBe("failed_terminal");
    expect((await testDb!.pool.query("select * from ofapi_media_token_fences")).rows).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    const valid = (await createCommand({ kind: "send_media_message_v1", payload })).json().commandId;
    expect((await executeOfapiCommand(appContext, valid)).status).toBe("confirmed");
    expect(send).toHaveBeenCalledTimes(1);
  });

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
  it("refuses edited replay at intake, at dispatch as the belt, and reusing a single-use CDN token for another logical send", async () => {
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null)); installedClient(send);
    const first = (await createCommand()).json().commandId; await executeOfapiCommand(appContext, first);
    const edited = await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, text: "edited", reuseProviderOperation: true } });
    expect(edited.statusCode).toBe(409); expect(edited.json()).toMatchObject({ error: "provider_operation_reuse_unavailable" });
    // Belt: a child accepted while unchanged whose retained body later differs is still refused before dispatch.
    const child = (await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, reuseProviderOperation: true } })).json().commandId;
    await testDb!.pool.query("update ofapi_commands set payload=$2::jsonb where id=$1", [child, JSON.stringify({ ...v2Payload, text: "edited", reuseProviderOperation: true })]);
    expect((await executeOfapiCommand(appContext, child)).status).toBe("failed_terminal");
    const another = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, another)).status).toBe("failed_terminal");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("cannot extend the original 24h recovery window: refused at intake, and at dispatch as the belt", async () => {
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null)); installedClient(send);
    const first = (await createCommand()).json().commandId; await executeOfapiCommand(appContext, first);
    const child = (await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, reuseProviderOperation: true } })).json().commandId;
    await testDb!.pool.query("update ofapi_command_provider_operations set first_attempt_at=clock_timestamp()-interval '25 hours' where command_id=$1", [first]);
    const late = await createCommand({ retryOfCommandId: first, payload: { ...v2Payload, reuseProviderOperation: true } });
    expect(late.statusCode).toBe(409); expect(late.json()).toMatchObject({ error: "provider_operation_reuse_unavailable" });
    expect((await executeOfapiCommand(appContext, child)).status).toBe("failed_terminal"); expect(send).toHaveBeenCalledTimes(1);
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

const custodyRows = async () => (await testDb!.pool.query("select command_id,operation_id,released_at,released_reason from ofapi_media_token_custody order by token")).rows;
const fenceRows = async () => (await testDb!.pool.query("select operation_id,released_at,released_reason from ofapi_media_token_fences")).rows;
const operationOf = async (commandId: string) => (await testDb!.pool.query("select operation_id from ofapi_command_provider_operations where command_id=$1", [commandId])).rows[0]?.operation_id;
const resultObservation = async (commandId: string, state: string) => (await testDb!.pool.query("select payload from observations where kind=$2 and payload->>'commandId'=$1", [commandId, `command.${state}`])).rows[0]?.payload;

describe("one-use media custody release after a definite non-delivery (review #138 fix 1)", () => {
  it("releases custody and fence after a definite 422, journals it, and lets an edited command spend the same token", async () => {
    const send = vi.fn().mockRejectedValueOnce(new OfapiApiError("banned word", 422, null)).mockResolvedValue({ messageId: "999" }); installedClient(send);
    const first = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, first)).status).toBe("failed_terminal");
    expect(await custodyRows()).toEqual([{ command_id: first, operation_id: await operationOf(first), released_at: expect.any(Date), released_reason: "vendor_rejected_422" }]);
    expect(await fenceRows()).toEqual([{ operation_id: await operationOf(first), released_at: expect.any(Date), released_reason: "vendor_rejected_422" }]);
    expect(await resultObservation(first, "failed_terminal")).toMatchObject({ errorCode: "ofapi_http_422", mediaTokensReleased: 1 });
    expect(await isOfapiMediaTokenReserved(appContext.db, ACCOUNT_ONE, "ofapi_media_token")).toBe(false);
    const edited = (await createCommand({ payload: { ...v2Payload, text: "edited" } })).json().commandId;
    expect((await executeOfapiCommand(appContext, edited)).status).toBe("confirmed");
    expect(send).toHaveBeenCalledTimes(2);
    expect(await custodyRows()).toEqual([{ command_id: edited, operation_id: await operationOf(edited), released_at: null, released_reason: null }]);
    expect(await fenceRows()).toEqual([{ operation_id: await operationOf(edited), released_at: null, released_reason: null }]);
    expect(await isOfapiMediaTokenReserved(appContext.db, ACCOUNT_ONE, "ofapi_media_token")).toBe(true);
  });

  it.each([
    ["transport timeout", new OfapiApiError("timeout", null, null), "indeterminate"],
    ["HTTP 503", new OfapiApiError("unavailable", 503, null), "indeterminate"],
    ["HTTP 408", new OfapiApiError("request timeout", 408, null), "indeterminate"],
    ["HTTP 429", new OfapiApiError("throttled", 429, null), "failed_retryable"],
  ])("keeps custody after %s (%s) so the token stays quarantined", async (_label, error, state) => {
    const send = vi.fn().mockRejectedValue(error); installedClient(send);
    const first = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, first)).status).toBe(state);
    expect(await custodyRows()).toEqual([{ command_id: first, operation_id: await operationOf(first), released_at: null, released_reason: null }]);
    expect(await resultObservation(first, state)).not.toHaveProperty("mediaTokensReleased");
    const next = (await createCommand({ payload: { ...v2Payload, text: "edited" } })).json().commandId;
    expect(await executeOfapiCommand(appContext, next)).toMatchObject({ status: "failed_terminal" });
    expect((await testDb!.pool.query("select last_error_code from ofapi_commands where id=$1", [next])).rows[0].last_error_code).toBe("ofapi_media_token_already_used");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps custody after a confirmed send", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "999" }); installedClient(send);
    const first = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, first)).status).toBe("confirmed");
    expect(await custodyRows()).toMatchObject([{ command_id: first, released_at: null }]);
    const next = (await createCommand({ payload: { ...v2Payload, text: "edited" } })).json().commandId;
    expect((await executeOfapiCommand(appContext, next)).status).toBe("failed_terminal");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a reuse child's definite rejection never releases the reservation it inherited from an unconfirmed parent", async () => {
    const send = vi.fn().mockRejectedValueOnce(new OfapiApiError("timeout", null, null)).mockRejectedValueOnce(new OfapiApiError("rejected", 422, null)); installedClient(send);
    const parent = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, parent)).status).toBe("indeterminate");
    const child = (await createCommand({ retryOfCommandId: parent, payload: { ...v2Payload, reuseProviderOperation: true } })).json().commandId;
    expect((await executeOfapiCommand(appContext, child)).status).toBe("failed_terminal");
    expect(await custodyRows()).toEqual([{ command_id: parent, operation_id: await operationOf(parent), released_at: null, released_reason: null }]);
    expect(await resultObservation(child, "failed_terminal")).not.toHaveProperty("mediaTokensReleased");
  });

  it("releases after a local refusal that happened after reservation but before any HTTP", async () => {
    const send = vi.fn().mockRejectedValueOnce(new OfapiCreditAccountingUnavailableError()).mockResolvedValue({ messageId: "999" }); installedClient(send);
    const first = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, first)).status).toBe("failed_terminal");
    expect(await custodyRows()).toMatchObject([{ command_id: first, released_reason: "local_refusal_credit_accounting_unavailable" }]);
    const next = (await createCommand({ payload: { ...v2Payload, text: "edited" } })).json().commandId;
    expect((await executeOfapiCommand(appContext, next)).status).toBe("confirmed");
  });

  it("legacy media sends release on a definite 422 and re-arm on the next legacy send", async () => {
    const send = vi.fn().mockRejectedValueOnce(new OfapiApiError("rejected", 422, null)).mockResolvedValue({ messageId: "999" }); installedClient(send);
    appContext.ofapi!.sendMediaMessage = send;
    const payload = { text: "Legacy media", price: 0, mediaFiles: ["ofapi_media_token"], previews: [] };
    const first = (await createCommand({ kind: "send_media_message_v1", payload })).json().commandId;
    expect((await executeOfapiCommand(appContext, first)).status).toBe("failed_terminal");
    expect(await custodyRows()).toEqual([{ command_id: first, operation_id: first, released_at: expect.any(Date), released_reason: "vendor_rejected_422" }]);
    const second = (await createCommand({ kind: "send_media_message_v1", payload })).json().commandId;
    expect((await executeOfapiCommand(appContext, second)).status).toBe("confirmed");
    expect(await custodyRows()).toEqual([{ command_id: second, operation_id: second, released_at: null, released_reason: null }]);
    expect(await fenceRows()).toEqual([{ operation_id: second, released_at: null, released_reason: null }]);
  });

  it("a release racing a new reservation leaves exactly one holder and no deadlock", async () => {
    const first = (await createCommand()).json().commandId;
    const second = (await createCommand({ payload: { ...v2Payload, text: "edited" } })).json().commandId;
    const common = { parentCommandId: null, reuse: false, teamSlug: "team", accountId: ACCOUNT_ONE, endpoint: "/messages", bodyHash: "h", tokens: ["ofapi_media_token"] };
    await reserveOfapiProviderOperation(appContext.db, { ...common, commandId: first });
    const [release, reserve] = await Promise.allSettled([
      releaseOfapiMediaTokenCustody(appContext.db, { commandId: first, reason: "vendor_rejected_422" }),
      reserveOfapiProviderOperation(appContext.db, { ...common, commandId: second, bodyHash: "h2" }),
    ]);
    expect(release.status).toBe("fulfilled");
    if (reserve.status === "rejected") expect(reserve.reason).toMatchObject({ reason: "media_token_already_used" });
    const live = (await custodyRows()).filter(row => row.released_at === null);
    expect(live.length).toBeLessThanOrEqual(1);
    if (reserve.status === "fulfilled") {
      expect(live).toEqual([{ command_id: second, operation_id: reserve.value.operationId, released_at: null, released_reason: null }]);
      expect(await fenceRows()).toEqual([{ operation_id: reserve.value.operationId, released_at: null, released_reason: null }]);
    } else {
      expect(live).toEqual([]);
      expect(await fenceRows()).toMatchObject([{ released_reason: "vendor_rejected_422" }]);
      const third = (await createCommand({ payload: { ...v2Payload, text: "third" } })).json().commandId;
      const claimed = await reserveOfapiProviderOperation(appContext.db, { ...common, commandId: third, bodyHash: "h3" });
      expect(await custodyRows()).toEqual([{ command_id: third, operation_id: claimed.operationId, released_at: null, released_reason: null }]);
    }
  });

  it("a queued row expired by the TTL sweep or cancelled by the chatter releases any custody it holds", async () => {
    const common = { parentCommandId: null, reuse: false, teamSlug: "team", accountId: ACCOUNT_ONE, endpoint: "/messages", bodyHash: "h", tokens: ["ofapi_media_token"] };
    const aged = (await createCommand()).json().commandId;
    await reserveOfapiProviderOperation(appContext.db, { ...common, commandId: aged });
    await testDb!.pool.query("update ofapi_commands set created_at=now()-interval '11 minutes' where id=$1", [aged]);
    await expect(sweepOfapiCommands(appContext, { send: vi.fn() } as never)).resolves.toMatchObject({ expired: 1 });
    expect(await custodyRows()).toMatchObject([{ command_id: aged, released_reason: "expired_queued_ttl" }]);
    expect(await resultObservation(aged, "cancelled")).toMatchObject({ errorCode: "expired_queued_ttl", mediaTokensReleased: 1 });

    const cancelled = (await createCommand({ payload: { ...v2Payload, text: "edited" } })).json().commandId;
    await reserveOfapiProviderOperation(appContext.db, { ...common, commandId: cancelled, bodyHash: "h2" });
    expect(await custodyRows()).toMatchObject([{ command_id: cancelled, released_at: null }]);
    const response = await apiServer!.inject({ method: "POST", url: `/api/v1/ofapi/commands/${cancelled}/cancel`, headers: { authorization: `Bearer ${chatterKey}` } });
    expect(response.statusCode).toBe(200);
    expect(await custodyRows()).toMatchObject([{ command_id: cancelled, released_reason: "cancelled_before_dispatch" }]);
    expect(await fenceRows()).toMatchObject([{ released_reason: "cancelled_before_dispatch" }]);
  });
});

describe("provider replay eligibility is decided at intake (review #138 fix 4)", () => {
  async function unconfirmedParent() {
    const send = vi.fn().mockRejectedValue(new OfapiApiError("timeout", null, null)); installedClient(send);
    const parent = (await createCommand()).json().commandId;
    expect((await executeOfapiCommand(appContext, parent)).status).toBe("indeterminate");
    return parent;
  }
  const rowCount = async () => (await testDb!.pool.query("select count(*)::int n from ofapi_commands")).rows[0].n;

  it.each([
    ["window_expired", async (parent: string) => { await testDb!.pool.query("update ofapi_command_provider_operations set first_attempt_at=clock_timestamp()-interval '25 hours' where command_id=$1", [parent]); return {}; }],
    ["body_changed", async () => ({ payload: { ...v2Payload, text: "edited", reuseProviderOperation: true } })],
    ["team_changed", async () => { await testDb!.pool.query("update ofapi_command_provider_operations set team_slug='previous-team'"); return {}; }],
    ["parent_operation_missing", async () => { await testDb!.pool.query("delete from ofapi_command_provider_operations"); return {}; }],
    ["credential_not_verified", async () => { appContext.ofapi = undefined; return {}; }],
  ])("answers 409 provider_operation_reuse_unavailable (%s) without creating a command row", async (issue, arrange) => {
    const parent = await unconfirmedParent();
    const before = await rowCount();
    const extra = await arrange(parent);
    const response = await createCommand({ retryOfCommandId: parent, payload: { ...v2Payload, reuseProviderOperation: true }, ...extra });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "provider_operation_reuse_unavailable", message: `Provider operation cannot be reused: ${issue}`, statusCode: 409 });
    expect(await rowCount()).toBe(before);
    expect((await testDb!.pool.query("select state from ofapi_commands where id=$1", [parent])).rows[0].state).toBe("indeterminate");
  });

  it("an exact replay of an already-accepted recovery still dedupes to 200 after the window closes", async () => {
    const parent = await unconfirmedParent();
    const clientCommandId = randomUUID();
    const accepted = await createCommand({ clientCommandId, retryOfCommandId: parent, payload: { ...v2Payload, reuseProviderOperation: true } });
    expect(accepted.statusCode).toBe(202);
    await testDb!.pool.query("update ofapi_command_provider_operations set first_attempt_at=clock_timestamp()-interval '25 hours' where command_id=$1", [parent]);
    const replay = await createCommand({ clientCommandId, retryOfCommandId: parent, payload: { ...v2Payload, reuseProviderOperation: true } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ commandId: accepted.json().commandId, deduplicated: true });
  });

  it("does not consult replay eligibility for a retry that declines reuse", async () => {
    const parent = await unconfirmedParent();
    await testDb!.pool.query("delete from ofapi_command_provider_operations");
    const fresh = await createCommand({ retryOfCommandId: parent, payload: { ...v2Payload, reuseProviderOperation: false } });
    expect(fresh.statusCode).toBe(202);
  });
});

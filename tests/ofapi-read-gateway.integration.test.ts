import {
  createServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import { connect as connectTcp } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyOfapiCollectionPolicy,
  createModel,
  createOnlyFansPage,
  deleteProxyConfig,
  OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  setPageOfapiAccountId,
  storeProxyConfig,
  upsertPageDmConversation,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { loadTranscriptContext } from "../apps/runtime/src/modules/ai/index.ts";
import { runOfapiCaptureMaterialization } from "../apps/runtime/src/services/ofapi-capture-materialization.ts";
import {
  createUserAccount,
} from "../apps/runtime/src/services/auth.ts";
import { issueChatterDeviceToken } from "./helpers/device-credentials.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { createOfapiCreditSpendSink } from "../apps/runtime/src/services/ofapi-credits.ts";
import {
  configureReadGatewayCaptureForTests,
  drainReadGatewayCaptureQueue,
  getReadGatewayCaptureDroppedCount,
} from "../apps/runtime/src/services/ofapi-read-gateway-capture.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { listenOnLoopback } from "./helpers/network.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

const ACCOUNT_ONE = "acct_01000000000000000000000000000000";
const ACCOUNT_TWO = "acct_02000000000000000000000000000000";

interface ScriptedResponse {
  status: number;
  body?: unknown;
  rawBody?: string | Buffer;
  headers?: Record<string, string>;
  destroyAfterHeaders?: boolean;
  /** Never answers: the client's own timeout is the only way out. */
  hang?: boolean;
}

interface UpstreamRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

let testDb: StartedTestDatabase | null = null;
let upstreamServer: HttpServer | null = null;
let upstreamBaseUrl: string | null = null;
let proxyServer: HttpServer | null = null;
let proxyBaseUrl: string | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let assignedPageId = 0;
const scriptedResponses: ScriptedResponse[] = [];
const upstreamRequests: UpstreamRequest[] = [];
const proxyRequests: UpstreamRequest[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  upstreamServer = createServer((request, response) => {
    upstreamRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    const scripted = scriptedResponses.shift() ?? {
      status: 500,
      body: { error: "unscripted request" },
    };
    if (scripted.hang === true) {
      return;
    }
    response.writeHead(scripted.status, {
      "content-type": "application/json",
      ...scripted.headers,
    });
    if (scripted.destroyAfterHeaders === true) {
      response.flushHeaders();
      response.destroy(new Error("scripted upstream body failure"));
      return;
    }
    response.end(scripted.rawBody ?? JSON.stringify(scripted.body ?? null));
  });
  const address = await listenOnLoopback(upstreamServer, "OFAPI read gateway tests");
  if (address) {
    upstreamBaseUrl = `http://${address.host}:${address.port}`;
  }

  proxyServer = createServer((request, response) => {
    proxyRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    if (!upstreamBaseUrl) {
      response.writeHead(502).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "/", upstreamBaseUrl);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const headers = { ...request.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const proxied = httpRequest(target, {
      method: request.method,
      headers,
    }, (proxiedResponse) => {
      response.writeHead(proxiedResponse.statusCode ?? 502, proxiedResponse.headers);
      proxiedResponse.pipe(response);
    });
    proxied.on("error", () => {
      response.writeHead(502).end();
    });
    request.pipe(proxied);
  });
  proxyServer.on("connect", (request, clientSocket, head) => {
    proxyRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    const [host, portText] = (request.url ?? "").split(":");
    const port = Number(portText);
    if (!host || !Number.isFinite(port)) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const upstreamSocket = connectTcp(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on("error", () => {
      clientSocket.end();
    });
    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
  });
  const proxyAddress = await listenOnLoopback(proxyServer, "OFAPI read gateway proxy tests");
  if (proxyAddress) {
    proxyBaseUrl = `http://${proxyAddress.host}:${proxyAddress.port}`;
  }
}, 120_000);

afterAll(async () => {
  await apiServer?.close();
  proxyServer?.close();
  upstreamServer?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb || !upstreamBaseUrl || !proxyBaseUrl) {
    context.skip();
    return;
  }
  await apiServer?.close();
  await resetIntegrationDatabase(testDb.pool);
  scriptedResponses.length = 0;
  upstreamRequests.length = 0;
  proxyRequests.length = 0;
  configureReadGatewayCaptureForTests();

  appContext = createTestAppContext(testDb, {
    ofapiCreditLedgerEnabled: true,
    ofapiDesktopReadGatewayEnabled: true,
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
  assignedPageId = assignedPage.id;
  await setPageOfapiAccountId(appContext.db, {
    pageId: assignedPage.id,
    ofapiAccountId: ACCOUNT_ONE,
  });
  await setPageOfapiAccountId(appContext.db, {
    pageId: unassignedPage.id,
    ofapiAccountId: ACCOUNT_TWO,
  });
  await storeProxyConfig(appContext.db, assignedPage.id, {
    url: proxyBaseUrl,
    encryptedAuth: null,
    keyVersion: null,
    rateLimitScopeKey: "test-proxy:lora-of",
  });
  await testDb.pool.query(
    `update pages
     set username = case when id = $1 then 'loravie' else 'loravievip' end,
         display_name = case when id = $1 then 'Lora Free' else 'Lora VIP' end,
         ofapi_auth_status = case when id = $1 then 'connected' else 'authentication_failed' end,
         metadata = case when id = $1
           then '{"avatarUrl":"https://public.onlyfans.com/files/lora/avatar.jpg"}'::jsonb
           else '{}'::jsonb
         end
     where id in ($1, $2)`,
    [assignedPage.id, unassignedPage.id],
  );

  await createUserAccount(appContext, {
    username: "chatter",
    role: "chatter",
  }, { source: "cli" });
  chatterKey = (await issueChatterDeviceToken(appContext, {
    username: "chatter",
    pageLabel: "lora-of",
  }, { source: "cli" })).key;

  appContext.ofapi = createOfapiClient({
    baseUrl: upstreamBaseUrl,
    apiKey: "core-vendor-key",
    restDelayMs: 0,
    onCreditSpend: createOfapiCreditSpendSink(appContext),
  });
  apiServer = await buildApiServer(appContext);
  await apiServer.ready();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function inject(path: string, readIntent?: string) {
  return apiServer!.inject({
    method: "GET",
    url: `/api/v1/ofapi/read/${path}`,
    headers: {
      authorization: `Bearer ${chatterKey}`,
      ...(readIntent ? { "x-agency-hub-read-intent": readIntent } : {}),
    },
  });
}

function messageFixture(id: number) {
  return { id, isSentByMe: false, createdAt: `2026-07-16T12:0${id % 10}:00.000Z`, text: `message-${id}` };
}

async function seedCertifiedHistory(chatId = "123") {
  appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
  appContext.config.ofapiMessageHistoryShadowEnabled = true;
  appContext.config.ofapiMessageHistoryDbFallbackEnabled = true;
  await upsertPageDmConversation(appContext.db, {
    platformAccountId: assignedPageId,
    fanId: null,
    platformConversationId: chatId,
    partnerPlatformUserId: chatId,
    partnerUsername: "certified-fan",
    partnerDisplayName: "Certified Fan",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: "103",
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-07-16T12:03:00.000Z"),
    lastMessageSenderId: chatId,
    lastMessageSenderRole: "fan",
    lastMessagePreview: "message-103",
    lastSeenGeneration: 1,
  });
  await testDb!.pool.query(`
    insert into message_archive (
      account_id, platform, conversation_ref, message_ref,
      native_message_id, fan_native_id, sender_role, is_sent_by_me,
      occurred_at, text_plain, text_html, price_mills, is_opened, is_new,
      is_tip, tip_amount_mills, tip_text_plain, reply_metadata, media_metadata,
      origin_class, material_observed_at, source_account_seq,
      serving_contract_version, content_pending
    )
    select $1, 'onlyfans', $2, id::text,
           id, $2, case when id % 2 = 0 then 'model' else 'fan' end,
           id % 2 = 0,
           '2026-07-16T12:00:00.000Z'::timestamptz
             + ((id - 100)::text || ' minutes')::interval,
           'message-' || id::text, '<p>message-' || id::text || '</p>',
           case when id = 102 then 1500 else 0 end,
           case when id = 102 then true else false end,
           false,
           id = 100, case when id = 100 then 5000 else 0 end,
           case when id = 100 then 'thank you' else null end,
           case when id = 101 then jsonb_build_object(
             'messageId', '102', 'textHtml', '<p>reply</p>', 'isSentByMe', true
           ) else null end,
           '[]'::jsonb, 'capture_background', now(), id - 99, 1, false
    from unnest(array[100, 101, 102, 103]::bigint[]) as id
  `, [assignedPageId, chatId]);
  await testDb!.pool.query(`
    insert into projection_seq_watermarks (projection, account_id, high_seq)
    values ('message_archive', $1, 4)
    on conflict (projection, account_id) do update set high_seq = excluded.high_seq
  `, [assignedPageId]);
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
      $1, $2, 'continuous_history', 'pagination_exhausted', '103',
      '100', '{}'::jsonb, $3, $4,
      4, 4, 0, 0, 0, 0,
      4, 1, now(), $5, 'ofapi-capture-v1', 'ofapi-capture-parser-v1', 5
    )
  `, [
    assignedPageId,
    chatId,
    "a".repeat(64),
    "b".repeat(64),
    OFAPI_CAPTURE_PROOF_POLICY_VERSION,
  ]);
  await testDb!.pool.query(
    `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
     values (1, current_date, 9000, now())
     on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
  );
}

async function seedUncertifiedHistory(chatId = "456", frozenHeadId = "203") {
  appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
  appContext.config.ofapiMessageHistoryShadowEnabled = true;
  appContext.config.ofapiMessageHistoryDbFallbackEnabled = true;
  await upsertPageDmConversation(appContext.db, {
    platformAccountId: assignedPageId,
    fanId: null,
    platformConversationId: chatId,
    partnerPlatformUserId: chatId,
    partnerUsername: "uncertified-fan",
    partnerDisplayName: "Uncertified Fan",
    conversationFlags: 0,
    unreadCount: 0,
    subscriptionTierId: null,
    lastMessageId: frozenHeadId,
    lastUnreadMessageId: null,
    lastMessageAt: new Date("2026-07-16T13:03:00.000Z"),
    lastMessageSenderId: chatId,
    lastMessageSenderRole: "fan",
    lastMessagePreview: `message-${frozenHeadId}`,
    lastSeenGeneration: 7,
  });
  await testDb!.pool.query(
    `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
     values (1, current_date, 9000, now())
     on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
  );
}

describe("OFAPI read gateway integration", () => {
  it("serves an ascending live tail only after the same messages are available to AI", async () => {
    await seedUncertifiedHistory();
    const data = [
      { id: 201, isSentByMe: true, createdAt: "2026-07-16T13:01Z", text: "previous reply" },
      { id: 202, isSentByMe: false, createdAt: "2026-07-16T13:02Z", text: "new question" },
      { id: 203, isSentByMe: false, createdAt: "2026-07-16T13:03Z", text: "latest question" },
    ];
    // Live material does not require a backward-history pagination certificate.
    scriptedResponses.push({ status: 200, body: { data } });
    const response = await inject(`${ACCOUNT_ONE}/chats/456/messages?order=asc&last_id=201&limit=100`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(data);
    const context = await loadTranscriptContext(appContext, {
      pageId: assignedPageId, conversationRef: "456", unionMode: "serve",
    });
    expect(context.contextManifest).toMatchObject({
      archiveCount: 3, unionCount: 3, archiveHeadRef: "203", unionHeadRef: "203", staleContext: false,
    });
    expect(context.messages).toHaveLength(3);
    expect(upstreamRequests).toHaveLength(1);
    expect((await testDb!.pool.query("select 1 from projection_seq_watermarks")).rows).toHaveLength(0);
    expect((await testDb!.pool.query("select 1 from ofapi_message_coverage")).rows).toHaveLength(0);
  });

  it("refuses a captured message response if serving fails, then recovers locally without another vendor request", async () => {
    await seedUncertifiedHistory();
    scriptedResponses.push({ status: 200, body: { data: [
      { id: 203, isSentByMe: false, createdAt: "2026-07-16T13:03Z", text: "latest question" },
    ] } });
    await testDb!.pool.query(`create function test_gateway_serving_failure() returns trigger language plpgsql as $$
      begin raise exception 'injected serving failure'; end $$;
      create trigger test_gateway_serving_failure before insert on message_archive
      for each row execute function test_gateway_serving_failure()`);
    try {
      const response = await inject(`${ACCOUNT_ONE}/chats/456/messages?order=asc&last_id=202`);
      expect(response.statusCode, response.body).toBe(503);
      const state = await testDb!.pool.query(`select r.state, a.parser_outcome, o.parse_version
        from ofapi_interactive_requests r join ofapi_request_attempts a on a.interactive_request_id = r.id
        join observations o on o.id = a.response_observation_id`);
      expect(state.rows).toEqual([{ state: "failed", parser_outcome: "failed", parse_version: 0 }]);
    } finally {
      await testDb!.pool.query("drop trigger test_gateway_serving_failure on message_archive; drop function test_gateway_serving_failure()");
    }
    expect(await runOfapiCaptureMaterialization(appContext)).toMatchObject({ stamped: 1, errored: 0 });
    const context = await loadTranscriptContext(appContext, {
      pageId: assignedPageId, conversationRef: "456", unionMode: "serve",
    });
    expect(context.contextManifest).toMatchObject({ unionHeadRef: "203", unionCount: 1 });
    expect(upstreamRequests).toHaveLength(1);
  });

  it("synthesizes only assigned accounts and a sanitized whoami", async () => {
    const accounts = await inject("accounts");
    expect(accounts.statusCode, accounts.body).toBe(200);
    expect(accounts.json()).toEqual([{
      id: ACCOUNT_ONE,
      is_authenticated: true,
      authentication_progress: "connected",
      display_name: "Lora Free",
      onlyfans_username: "loravie",
      onlyfans_user_data: {
        name: "Lora Free",
        username: "loravie",
        avatar: "https://public.onlyfans.com/files/lora/avatar.jpg",
      },
    }]);

    const whoami = await inject("whoami");
    expect(whoami.statusCode, whoami.body).toBe(200);
    expect(whoami.json()).toEqual({
      api_key: { name: "Agency Hub chatter: chatter" },
      team: { name: "Agency Hub", slug: "agency-hub" },
    });
    expect(upstreamRequests).toHaveLength(0);
    expect(proxyRequests).toHaveLength(0);
  });

  it("forwards one allowlisted GET with core auth and page-attributed credit telemetry", async () => {
    scriptedResponses.push({
      status: 200,
      body: {
        data: [{ id: 123 }],
        _meta: {
          _credits: { used: 2, balance: 9000 },
          _rate_limits: { remaining_minute: 4999 },
        },
        _pagination: { next_page: null },
      },
      headers: {
        "x-ofapi-credits-used": "2",
        "x-ofapi-credits-balance": "9000",
      },
    });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=50&order=recent&skip_users=none`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual([{ id: 123 }]);
    expect(response.headers["x-ofapi-credits-used"]).toBe("2");
    expect(upstreamRequests).toEqual([{
      method: "GET",
      url: `/${ACCOUNT_ONE}/chats?limit=50&order=recent&skip_users=none`,
      authorization: "Bearer core-vendor-key",
    }]);
    expect(proxyRequests).toHaveLength(0);

    const { rows } = await testDb!.pool.query<{
      operation: string;
      page_id: number;
      credits: number;
      http_status: number;
    }>(
      `select operation, page_id::int, credits, http_status
       from ofapi_credit_ledger
       where operation = 'ofapi_gateway_chats'`,
    );
    expect(rows).toEqual([{
      operation: "ofapi_gateway_chats",
      page_id: assignedPageId,
      credits: 2,
      http_status: 200,
    }]);
  });

  it("does not retry upstream failures and preserves retry-after", async () => {
    scriptedResponses.push(
      { status: 503, body: { error: "temporary" }, headers: { "retry-after": "7" } },
      { status: 200, body: { data: [] } },
    );

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);
    // Under load this once answered a 503 with no retry-after: say whose 503.
    const answered = `${response.statusCode} ${JSON.stringify(response.headers)} ${response.body}; upstream saw ${JSON.stringify(upstreamRequests)}`;
    expect(response.statusCode, answered).toBe(503);
    expect(response.headers["retry-after"], answered).toBe("7");
    expect(upstreamRequests, answered).toHaveLength(1);
    expect(proxyRequests).toHaveLength(0);
    expect(scriptedResponses).toHaveLength(1);
  });

  it("maps upstream response body read failures to service unavailable", async () => {
    scriptedResponses.push({
      status: 200,
      body: { data: [] },
      destroyAfterHeaders: true,
    });

    const response = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=30&order=desc&skip_users=all`,
    );

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      error: "service_unavailable",
      statusCode: 503,
    });
    expect(upstreamRequests).toHaveLength(1);
    expect(proxyRequests).toHaveLength(0);
  });

  it("reads an assigned OFAPI account without a page proxy", async () => {
    await deleteProxyConfig(appContext.db, assignedPageId);
    scriptedResponses.push({
      status: 200,
      body: { data: [{ id: 1 }] },
    });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ id: 1 }] });
    expect(upstreamRequests).toHaveLength(1);
    expect(proxyRequests).toHaveLength(0);
    expect(scriptedResponses).toHaveLength(0);
  });

  it("fails closed before upstream for unknown queries, paths, and unassigned accounts", async () => {
    const badQuery = await inject(`${ACCOUNT_ONE}/chats?not_allowed=1`);
    expect(badQuery.statusCode, badQuery.body).toBe(400);

    const badPath = await inject(`${ACCOUNT_ONE}/media/vault/delete-media`);
    expect(badPath.statusCode, badPath.body).toBe(400);

    const unassigned = await inject(`${ACCOUNT_TWO}/chats?limit=10`);
    expect(unassigned.statusCode, unassigned.body).toBe(404);

    const write = await apiServer!.inject({
      method: "POST",
      url: `/api/v1/ofapi/read/${ACCOUNT_ONE}/chats/123/messages`,
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: { text: "must not be proxied" },
    });
    expect(write.statusCode, write.body).toBe(404);
    expect(upstreamRequests).toHaveLength(0);
    expect(proxyRequests).toHaveLength(0);
  });

  it("records the known-free upload-status poll as zero credits", async () => {
    scriptedResponses.push({
      status: 200,
      body: { status: "processing", prefixed_id: "ofapi_media_123" },
    });

    const response = await inject(
      `${ACCOUNT_ONE}/media/uploads/ofapi_media_123/status`,
    );
    expect(response.statusCode, response.body).toBe(200);

    const { rows } = await testDb!.pool.query<{
      credits: number;
      estimated: boolean;
      page_id: number;
    }>(
      `select credits, estimated, page_id::int
       from ofapi_credit_ledger
       where operation = 'ofapi_gateway_upload_status'`,
    );
    expect(rows).toEqual([{
      credits: 0,
      estimated: false,
      page_id: assignedPageId,
    }]);
  });

  it("requires the staged flag and chatter bearer authentication", async () => {
    appContext.config.ofapiDesktopReadGatewayEnabled = false;
    const disabled = await inject("accounts");
    expect(disabled.statusCode, disabled.body).toBe(503);
    appContext.config.ofapiDesktopReadGatewayEnabled = true;

    const unauthenticated = await apiServer!.inject({
      method: "GET",
      url: "/api/v1/ofapi/read/accounts",
    });
    expect(unauthenticated.statusCode, unauthenticated.body).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("serves only explicit certified backward history from the DB", async () => {
    await seedCertifiedHistory();
    // A certified DB hit must survive vendor-death mode and spend nothing.
    appContext.ofapi = undefined;

    const first = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=103&skip_users=all`,
      "deep-history-v1",
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["x-agency-hub-read-source"]).toBe("db");
    expect(first.headers["x-ofapi-credits-used"]).toBe("0");
    expect(first.json()).toMatchObject({
      data: [
        {
          id: 102,
          text: "<p>message-102</p>",
          price: 1.5,
          isOpened: true,
          isSentByMe: true,
        },
        {
          id: 101,
          text: "<p>message-101</p>",
          replyToMessage: { id: 102, text: "<p>reply</p>", isSentByMe: true },
          isSentByMe: false,
        },
      ],
      _pagination: {
        next_page: `/${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=101&skip_users=all`,
      },
    });

    const last = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=101&skip_users=all`,
      "deep-history-v1",
    );
    expect(last.statusCode, last.body).toBe(200);
    expect(last.json().data.map((item: { id: number }) => item.id)).toEqual([100]);
    expect(last.json()._pagination.next_page).toBeNull();
    expect(upstreamRequests).toHaveLength(0);
    expect(proxyRequests).toHaveLength(0);
    const attempts = await testDb!.pool.query<{ count: string }>(
      "select count(*)::text as count from ofapi_request_attempts",
    );
    expect(attempts.rows[0]?.count).toBe("0");
  });

  it("uses an incomplete webhook head only as the exclusive DB boundary", async () => {
    await seedCertifiedHistory();
    await testDb!.pool.query(
      `update message_archive
       set native_message_id = null,
           source_account_seq = null,
           serving_contract_version = 0,
           text_html = null,
           content_pending = true
       where account_id = $1
         and conversation_ref = '123'
         and message_ref = '103'`,
      [assignedPageId],
    );
    appContext.ofapi = undefined;

    const response = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=103&skip_users=all`,
      "deep-history-v1",
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-agency-hub-read-source"]).toBe("db");
    expect(response.headers["x-ofapi-credits-used"]).toBe("0");
    expect(response.json().data.map((item: { id: number }) => item.id)).toEqual([102, 101]);
    expect(upstreamRequests).toHaveLength(0);
    expect(proxyRequests).toHaveLength(0);
  });

  it("orders certified bigint message ids numerically across digit lengths", async () => {
    await seedCertifiedHistory();
    await testDb!.pool.query(`
      update message_archive
      set native_message_id = case message_ref
        when '100' then 9
        when '101' then 10
        when '102' then 11
        when '103' then 12
      end
      where account_id = $1 and conversation_ref = '123'
        and message_ref in ('100', '101', '102', '103')
    `, [assignedPageId]);
    await testDb!.pool.query(
      "update page_dm_threads set last_message_id = '12' where platform_account_id = $1 and platform_conversation_id = '123'",
      [assignedPageId],
    );
    await testDb!.pool.query(
      "update ofapi_message_coverage set frozen_head_id = '12', oldest_message_id = '9' where page_id = $1 and chat_id = '123'",
      [assignedPageId],
    );
    appContext.ofapi = undefined;

    const response = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=3&order=desc&first_id=12&skip_users=all`,
      "deep-history-v1",
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-agency-hub-read-source"]).toBe("db");
    expect(response.json().data.map((item: { id: number }) => item.id)).toEqual([11, 10, 9]);
    expect(response.json()._pagination.next_page).toBeNull();
  });

  it("keeps repeated explicit no-certificate misses as separate capture-first intents", async () => {
    await seedUncertifiedHistory();
    scriptedResponses.push(
      { status: 200, body: { data: [messageFixture(202)], _pagination: { next_page: null } } },
      { status: 200, body: { data: [messageFixture(202)], _pagination: { next_page: null } } },
    );

    const first = await inject(
      `${ACCOUNT_ONE}/chats/456/messages?limit=2&order=desc&first_id=202&skip_users=all`,
      "deep-history-v1",
    );
    const second = await inject(
      `${ACCOUNT_ONE}/chats/456/messages?limit=2&order=desc&first_id=202&skip_users=all`,
      "deep-history-v1",
    );

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.headers["x-agency-hub-read-fallback"]).toBe("no_certificate");
    expect(second.headers["x-agency-hub-read-fallback"]).toBe("no_certificate");
    expect(upstreamRequests).toHaveLength(2);

    expect((await testDb!.pool.query(
      "select 1 from ofapi_capture_jobs",
    )).rows).toHaveLength(0);
    const intents = await testDb!.pool.query<{
      request_state: string;
      attempt_state: string;
      fallback_reason: string;
    }>(`
      select request.state as request_state,
             attempt.state as attempt_state,
             attempt.fallback_reason
      from ofapi_interactive_requests request
      join ofapi_request_attempts attempt
        on attempt.interactive_request_id = request.id
      order by request.created_at, request.id
    `);
    expect(intents.rows).toEqual([
      {
        request_state: "served",
        attempt_state: "response_captured",
        fallback_reason: "no_certificate",
      },
      {
        request_state: "served",
        attempt_state: "response_captured",
        fallback_reason: "no_certificate",
      },
    ]);
  });

  it("keeps old clients and non-certified history on one capture-first vendor fallback", async () => {
    await seedCertifiedHistory();
    scriptedResponses.push(
      {
        status: 200,
        body: { data: [messageFixture(102)], _pagination: { next_page: null } },
      },
      {
        status: 200,
        body: { data: [messageFixture(102)], _pagination: { next_page: null } },
      },
    );

    // No intent means no DB cutover, even though the query happens to contain first_id.
    const legacy = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=102&skip_users=all`,
    );
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.headers["x-agency-hub-read-source"]).toBe("vendor");
    expect(legacy.headers["x-agency-hub-read-fallback"]).toBe("surface_not_cutover");
    expect((await testDb!.pool.query(
      "select 1 from ofapi_capture_jobs",
    )).rows).toHaveLength(0);

    // An independent head advance invalidates the proof and takes exactly one live GET.
    await testDb!.pool.query(
      "update page_dm_threads set last_message_id = '104' where platform_account_id = $1",
      [assignedPageId],
    );
    const stale = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=102&skip_users=all`,
      "deep-history-v1",
    );
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.headers["x-agency-hub-read-source"]).toBe("vendor");
    expect(stale.headers["x-agency-hub-read-fallback"]).toBe("stale_head");
    expect(upstreamRequests).toHaveLength(2);

    expect((await testDb!.pool.query(
      "select 1 from ofapi_capture_jobs",
    )).rows).toHaveLength(0);

    const attempts = await testDb!.pool.query<{
      serving_mode: string;
      fallback_reason: string;
      state: string;
    }>(`
      select serving_mode, fallback_reason, state
      from ofapi_request_attempts
      order by reserved_at, id
    `);
    expect(attempts.rows).toEqual([
      { serving_mode: "db_fallback", fallback_reason: "surface_not_cutover", state: "response_captured" },
      { serving_mode: "db_fallback", fallback_reason: "stale_head", state: "response_captured" },
    ]);
  });

  it("falls back instead of returning a partial page or false EOF", async () => {
    await seedCertifiedHistory();
    await testDb!.pool.query(
      "delete from message_archive where account_id = $1 and message_ref = '100'",
      [assignedPageId],
    );
    scriptedResponses.push({
      status: 200,
      body: { data: [messageFixture(100)], _pagination: { next_page: null } },
    });

    const response = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=101&skip_users=all`,
      "deep-history-v1",
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-agency-hub-read-source"]).toBe("vendor");
    expect(response.headers["x-agency-hub-read-fallback"]).toBe("gap");
    expect(response.json().data.map((item: { id: number }) => item.id)).toEqual([100]);
    expect(upstreamRequests).toHaveLength(1);
    expect((await testDb!.pool.query(
      "select 1 from ofapi_capture_jobs",
    )).rows).toHaveLength(0);
  });

  it("shadows certified ids without changing the vendor response", async () => {
    await seedCertifiedHistory();
    appContext.config.ofapiMessageHistoryDbFallbackEnabled = false;
    scriptedResponses.push({
      status: 200,
      body: {
        data: [messageFixture(102), messageFixture(101)],
        _pagination: { next_page: "vendor-next" },
      },
    });

    const response = await inject(
      `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=103&skip_users=all`,
      "deep-history-v1",
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-agency-hub-read-source"]).toBe("vendor");
    expect(response.headers["x-agency-hub-history-shadow"]).toBe("match");
    expect(response.json()._pagination.next_page).toBe("vendor-next");
    expect(upstreamRequests).toHaveLength(1);
    const attempt = await testDb!.pool.query<{
      serving_mode: string;
      fallback_reason: string;
    }>("select serving_mode, fallback_reason from ofapi_request_attempts");
    expect(attempt.rows).toEqual([{
      serving_mode: "shadow",
      fallback_reason: "shadow_probe",
    }]);
  });

  it("tees a gateway 200 into the journal with principal and template kind (Stage 9)", async () => {
    scriptedResponses.push({
      status: 200,
      body: {
        data: [{ id: 42 }],
        _meta: { _credits: { used: 1, balance: 8999 } },
      },
    });
    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);
    expect(response.statusCode, response.body).toBe(200);
    await drainReadGatewayCaptureQueue();

    const chatterId = (await testDb!.pool.query<{ id: number }>(
      "select id from users where username = 'chatter'",
    )).rows[0]!.id;

    const observations = await testDb!.pool.query<{
      producer: string;
      kind: string;
      account_id: string;
      actor_principal_id: string;
      payload: unknown;
    }>(
      `select producer, kind, account_id::text as account_id,
              actor_principal_id::text as actor_principal_id, payload
       from observations where source = 'readthrough'`,
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({
      producer: "read-gateway",
      kind: "ofapi_gateway_chats",
      account_id: String(assignedPageId),
      actor_principal_id: String(chatterId),
    });
    // The payload is the response body verbatim.
    expect(observations.rows[0]!.payload).toMatchObject({ data: [{ id: 42 }] });

    // Attribution: the ledger row carries the acting chatter.
    const ledger = await testDb!.pool.query<{ actor_user_id: string | null; credits: number }>(
      "select actor_user_id::text as actor_user_id, credits from ofapi_credit_ledger order by id desc limit 1",
    );
    expect(ledger.rows[0]).toMatchObject({ actor_user_id: String(chatterId), credits: 1 });
    expect(getReadGatewayCaptureDroppedCount()).toBe(0);
  });

  it("does not capture non-2xx responses (Stage 9)", async () => {
    scriptedResponses.push({ status: 404, body: { error: "not found" } });
    const response = await inject(`${ACCOUNT_ONE}/chats`);
    expect(response.statusCode).toBe(404);
    await drainReadGatewayCaptureQueue();
    const observations = await testDb!.pool.query(
      "select 1 from observations where source = 'readthrough'",
    );
    expect(observations.rows).toHaveLength(0);
  });

  it("answers a collection-policy refusal as 409/429 with the reason, never 500/503 (review #136)", async () => {
    appContext.ofapi = createOfapiClient({
      baseUrl: upstreamBaseUrl!,
      apiKey: "core-vendor-key",
      restDelayMs: 0,
      onCreditSpend: createOfapiCreditSpendSink(appContext),
      ...ofapiCollectionPolicyHooks(appContext.db),
    });
    const policy = (overrides: Record<string, unknown>) => ({
      pageId: assignedPageId, category: "core_messages" as const, mode: "scheduled" as const,
      intervalMinutes: 15, dailyCreditLimit: 1, maxCallsPerRun: 2, includeDetails: false, ...overrides,
    });

    // Capture-first path: the refusal is the pre-dispatch cause of a governed
    // attempt; the released attempt must not turn it into a 503.
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
    );
    await applyOfapiCollectionPolicy(appContext.db, { expectedRevision: 0, changes: [policy({ mode: "off" })] }, 1);
    const off = await inject(`${ACCOUNT_ONE}/chats?limit=10`);
    expect(off.statusCode, off.body).toBe(409);
    expect(off.json()).toMatchObject({
      error: "ofapi_collection_refused",
      reason: "collection_off",
      statusCode: 409,
      retryAfterMs: null,
    });
    expect(upstreamRequests).toHaveLength(0);

    // Proxy-read path: the second read of the day crosses the 1-credit cap.
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = false;
    await applyOfapiCollectionPolicy(appContext.db, { expectedRevision: 1, changes: [policy({})] }, 1);
    scriptedResponses.push({
      status: 200,
      body: { data: [{ id: 1 }], _meta: { _credits: { used: 1, balance: 8999 } }, _pagination: { next_page: null } },
      headers: { "x-ofapi-credits-used": "1", "x-ofapi-credits-balance": "8999" },
    });
    const first = await inject(`${ACCOUNT_ONE}/chats?limit=10`);
    expect(first.statusCode, first.body).toBe(200);
    const capped = await inject(`${ACCOUNT_ONE}/chats?limit=10`);
    expect(capped.statusCode, capped.body).toBe(429);
    expect(capped.json()).toMatchObject({
      error: "ofapi_collection_refused",
      reason: "daily_limit",
      statusCode: 429,
    });
    expect(capped.json().retryAfterMs).toBeGreaterThan(0);
    expect(Number(capped.headers["retry-after"])).toBeGreaterThan(0);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("serves the welcome template only after capture, with page ACL and actual credit accounting", async () => {
    expect(appContext.config.ofapiMirrorInteractiveCaptureEnabled).not.toBe(true);
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())`,
    );
    const denied = await inject(`${ACCOUNT_TWO}/settings/welcome-message`);
    expect(denied.statusCode).toBe(404);
    expect(upstreamRequests).toHaveLength(0);
    const template = { id: "42", template: "reply_on_subscribe", text: "<p>welcome</p>", isActive: false };
    scriptedResponses.push({ status: 200, body: { data: template, _meta: { _credits: { used: 2, balance: 8998 } } } });
    const response = await inject(`${ACCOUNT_ONE}/settings/welcome-message`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual(template);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({ method: "GET", url: `/${ACCOUNT_ONE}/settings/welcome-message` });
    const custody = await testDb!.pool.query(
      `select request.state, attempt.parser_outcome, attempt.settled_credits,
        attempt.response_observation_id is not null as captured
       from ofapi_interactive_requests request join ofapi_request_attempts attempt
        on attempt.interactive_request_id = request.id`,
    );
    expect(custody.rows).toEqual([{ state: "served", parser_outcome: "accepted", settled_credits: 2, captured: true }]);
    const ledger = await testDb!.pool.query(`select sum(credits)::int as credits, bool_and(actor_user_id is not null) as attributed from ofapi_credit_ledger where attempt_id is not null`);
    expect(ledger.rows).toEqual([{ credits: 2, attributed: true }]);
  });

  it("capture-first serves only after the raw response and attempt are durable", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
    );
    scriptedResponses.push({
      status: 200,
      body: {
        data: [{ id: 77 }],
        _meta: { _credits: { used: 2, balance: 8998 } },
      },
    });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual([{ id: 77 }]);
    expect(upstreamRequests).toHaveLength(1);
    expect(proxyRequests).toHaveLength(0);
    const state = await testDb!.pool.query<{
      request_state: string;
      attempt_state: string;
      parser_outcome: string;
      settled_credits: number;
      credit_estimated: boolean;
      egress_key: string;
    }>(
      `select request.state as request_state,
              attempt.state as attempt_state,
              attempt.parser_outcome,
              attempt.settled_credits,
              attempt.credit_estimated,
              attempt.egress_key
       from ofapi_interactive_requests request
       join ofapi_request_attempts attempt
         on attempt.interactive_request_id = request.id`,
    );
    expect(state.rows).toEqual([{
      request_state: "served",
      attempt_state: "response_captured",
      parser_outcome: "accepted",
      settled_credits: 2,
      credit_estimated: false,
      egress_key: "vendor:ofapi",
    }]);
    const observations = await testDb!.pool.query<{
      source: string;
      producer: string;
      kind: string;
    }>(
      `select source, producer, kind
       from observations
       where source = 'ofapi_capture'
       order by id`,
    );
    expect(observations.rows).toEqual([{
      source: "ofapi_capture",
      producer: "ofapi-mirror-interactive",
      kind: "ofapi.interactive_response.v1",
    }]);
    const ledger = await testDb!.pool.query<{ credits: number }>(
      `select coalesce(sum(credits), 0)::int as credits
       from ofapi_credit_ledger
       where attempt_id is not null`,
    );
    expect(ledger.rows[0]?.credits).toBe(2);
  });

  it("capture-first records malformed success once and refuses to serve it", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
    );
    scriptedResponses.push({ status: 200, rawBody: "{not-json" });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);

    expect(response.statusCode, response.body).toBe(503);
    expect(upstreamRequests).toHaveLength(1);
    const attempt = await testDb!.pool.query<{
      parser_outcome: string;
      raw_body: string;
    }>(
      `select attempt.parser_outcome,
              observation.payload #>> '{response,body}' as raw_body
       from ofapi_request_attempts attempt
       join observations observation
         on observation.id = attempt.response_observation_id
        and observation.received_at = attempt.response_observation_received_at`,
    );
    expect(attempt.rows).toEqual([{
      parser_outcome: "contract_rejected",
      raw_body: "{not-json",
    }]);
  });

  it("capture-first rejects an empty 2xx body instead of accepting JSON null", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
    );
    scriptedResponses.push({ status: 200, rawBody: Buffer.alloc(0) });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);

    expect(response.statusCode, response.body).toBe(503);
    expect(upstreamRequests).toHaveLength(1);
    const attempt = await testDb!.pool.query<{
      request_state: string;
      parser_outcome: string;
      raw_body: string;
    }>(
      `select request.state as request_state,
              attempt.parser_outcome,
              observation.payload #>> '{response,body}' as raw_body
       from ofapi_interactive_requests request
       join ofapi_request_attempts attempt
         on attempt.interactive_request_id = request.id
       join observations observation
         on observation.id = attempt.response_observation_id
        and observation.received_at = attempt.response_observation_received_at`,
    );
    expect(attempt.rows).toEqual([{
      request_state: "failed",
      parser_outcome: "contract_rejected",
      raw_body: "",
    }]);
  });

  it("capture-first records but refuses a valid 2xx outside the operation envelope", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
    );
    scriptedResponses.push({ status: 200, body: {} });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);

    expect(response.statusCode, response.body).toBe(503);
    expect(upstreamRequests).toHaveLength(1);
    const attempt = await testDb!.pool.query<{
      request_state: string;
      parser_outcome: string;
      raw_body: string;
    }>(
      `select request.state as request_state,
              attempt.parser_outcome,
              observation.payload #>> '{response,body}' as raw_body
       from ofapi_interactive_requests request
       join ofapi_request_attempts attempt
         on attempt.interactive_request_id = request.id
       join observations observation
         on observation.id = attempt.response_observation_id
        and observation.received_at = attempt.response_observation_received_at`,
    );
    expect(attempt.rows).toEqual([{
      request_state: "failed",
      parser_outcome: "contract_rejected",
      raw_body: "{}",
    }]);
  });

  it("capture-first accepts the data.list variant for registered list operations", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
       set last_balance = excluded.last_balance,
           last_balance_at = excluded.last_balance_at`,
    );
    scriptedResponses.push({
      status: 200,
      body: {
        data: { list: [{ id: "tx-1" }], hasMore: false },
        _meta: { _credits: { used: 1, balance: 8999 } },
      },
    });

    const response = await inject(`${ACCOUNT_ONE}/transactions?limit=10`);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      data: { list: [{ id: "tx-1" }], hasMore: false },
    });
    const attempt = await testDb!.pool.query<{
      request_state: string;
      parser_outcome: string;
    }>(
      `select request.state as request_state, attempt.parser_outcome
       from ofapi_interactive_requests request
       join ofapi_request_attempts attempt
         on attempt.interactive_request_id = request.id`,
    );
    expect(attempt.rows).toEqual([{
      request_state: "served",
      parser_outcome: "accepted",
    }]);
  });

  it("fails open when the tee queue is full: serves 200, counts drops, raises the incident (Stage 9)", async () => {
    configureReadGatewayCaptureForTests({ queueCap: 0, dropIncidentThreshold: 1 });
    scriptedResponses.push({
      status: 200,
      body: { data: [], _meta: { _credits: { used: 1, balance: 8998 } } },
    });
    const response = await inject(`${ACCOUNT_ONE}/chats`);
    expect(response.statusCode, response.body).toBe(200);
    expect(getReadGatewayCaptureDroppedCount()).toBe(1);

    // The incident write is fire-and-forget; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const incidents = await testDb!.pool.query<{ kind: string }>(
      "select kind from notification_incidents where kind = 'read_gateway_capture'",
    );
    expect(incidents.rows).toHaveLength(1);
    const observations = await testDb!.pool.query(
      "select 1 from observations where source = 'readthrough'",
    );
    expect(observations.rows).toHaveLength(0);
  });
});

describe("OFAPI read gateway timeouts", () => {
  const FAST_READS = [
    { path: `${ACCOUNT_ONE}/chats?limit=10`, body: { data: [] } },
    { path: `${ACCOUNT_ONE}/transactions?limit=10`, body: { data: { list: [] } } },
    { path: `${ACCOUNT_ONE}/chats/123/messages?limit=10&order=desc`, body: { data: [] } },
    // first_id alone is an old-client page, not an explicit deep-history read.
    { path: `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=102&skip_users=all`, body: { data: [] } },
  ];
  const DEEP_HISTORY = {
    path: `${ACCOUNT_ONE}/chats/123/messages?limit=2&order=desc&first_id=102&skip_users=all`,
    readIntent: "deep-history-v1",
    body: { data: [] },
  };
  // Any read outside the three classes keeps today's transport default.
  const OTHER_READ = { path: `${ACCOUNT_ONE}/chats/123/messages/456`, body: { data: { id: 456 } } };

  async function seedFreshBalance() {
    await testDb!.pool.query(
      `insert into ofapi_credit_state (id, spend_day, last_balance, last_balance_at)
       values (1, current_date, 9000, now())
       on conflict (id) do update
         set last_balance = excluded.last_balance,
             last_balance_at = excluded.last_balance_at`,
    );
  }

  async function readArmingTimeout(read: { path: string; readIntent?: string; body: unknown }) {
    scriptedResponses.push({ status: 200, body: read.body });
    const armed = vi.spyOn(AbortSignal, "timeout");
    const startedAt = Date.now();
    const response = await inject(read.path, read.readIntent);
    const finishedAt = Date.now();
    const timeouts = armed.mock.calls.map(([ms]) => ms);
    armed.mockRestore();
    expect(response.statusCode, response.body).toBe(200);
    return { timeouts, startedAt, finishedAt };
  }

  it("arms 20 s on the proxy path for chats, transactions and chat messages, 60 s for deep history and other reads", async () => {
    const proxyRead = vi.spyOn(appContext.ofapi!, "proxyRead");

    for (const read of FAST_READS) {
      expect((await readArmingTimeout(read)).timeouts, read.path).toEqual([20_000]);
    }
    expect((await readArmingTimeout(DEEP_HISTORY)).timeouts).toEqual([60_000]);
    expect((await readArmingTimeout(OTHER_READ)).timeouts).toEqual([60_000]);

    expect(proxyRead.mock.calls.map(([, options]) => [options.operation, options.timeoutMs])).toEqual([
      ["ofapi_gateway_chats", 20_000],
      ["ofapi_gateway_transactions", 20_000],
      ["ofapi_gateway_chat_messages", 20_000],
      ["ofapi_gateway_chat_messages", 20_000],
      ["ofapi_gateway_chat_messages", 60_000],
      // No override at all: the transport default stays the only source.
      ["ofapi_gateway_chat_message", undefined],
    ]);
    expect(proxyRead.mock.calls.at(-1)?.[1]).not.toHaveProperty("timeoutMs");
  });

  it("arms the same timeouts capture-first and reserves each attempt until timeout + 5 s", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await seedFreshBalance();
    const governed = vi.spyOn(appContext.ofapi!, "dispatchGovernedRaw");

    const windows: Array<{ timeoutMs: number; startedAt: number; finishedAt: number }> = [];
    for (const [read, timeoutMs] of [
      ...FAST_READS.map((read) => [read, 20_000] as const),
      [DEEP_HISTORY, 60_000] as const,
      [OTHER_READ, 60_000] as const,
    ]) {
      const { timeouts, startedAt, finishedAt } = await readArmingTimeout(read);
      expect(timeouts, read.path).toEqual([timeoutMs]);
      windows.push({ timeoutMs, startedAt, finishedAt });
    }

    const calls = governed.mock.calls.map(([, options]) => options);
    expect(calls.map((options) => [options.operation, options.timeoutMs])).toEqual([
      ["ofapi_gateway_chats", 20_000],
      ["ofapi_gateway_transactions", 20_000],
      ["ofapi_gateway_chat_messages", 20_000],
      ["ofapi_gateway_chat_messages", 20_000],
      ["ofapi_gateway_chat_messages", 60_000],
      ["ofapi_gateway_chat_message", 60_000],
    ]);
    const attempts = await testDb!.pool.query<{ id: string; deadline_at: Date }>(
      "select id::text, deadline_at from ofapi_request_attempts",
    );
    const durableDeadline = new Map(attempts.rows.map((row) => [row.id, row.deadline_at.getTime()]));
    calls.forEach((options, index) => {
      const { timeoutMs, startedAt, finishedAt } = windows[index]!;
      const deadline = options.deadlineAt.getTime();
      // Today's fixed 65 s is the 60 s default + 5 s; the fast classes get 25 s.
      expect(deadline).toBeGreaterThanOrEqual(startedAt + timeoutMs + 5_000);
      expect(deadline).toBeLessThanOrEqual(finishedAt + timeoutMs + 5_000);
      expect(durableDeadline.get(options.attemptId)).toBe(deadline);
    });
  });

  it("records a timed-out fast read like a timed-out default read, only with its own timeout", async () => {
    appContext.config.ofapiMirrorInteractiveCaptureEnabled = true;
    await seedFreshBalance();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    // A hung OFAPI read without the wait: the transport arms and reports its
    // real timeout, but the abort itself fires after 50 ms.
    const armed = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => realTimeout(
      ms === 20_000 || ms === 60_000 ? 50 : ms,
    ));
    const warn = vi.spyOn(appContext.logger, "warn");
    scriptedResponses.push({ status: 200, hang: true }, { status: 200, hang: true });

    const fast = await inject(`${ACCOUNT_ONE}/chats?limit=10`);
    const other = await inject(OTHER_READ.path);

    expect(armed.mock.calls.map(([ms]) => ms)).toEqual([20_000, 60_000]);
    expect(upstreamRequests).toHaveLength(2);
    expect(fast.statusCode, fast.body).toBe(503);
    expect(fast.json()).toEqual(other.json());
    expect(fast.json()).toMatchObject({ error: "service_unavailable", statusCode: 503 });

    const attempts = await testDb!.pool.query<{ operation: string; state: string; dispatch_outcome: string; credit_state: string }>(
      `select operation, state, dispatch_outcome, credit_state
       from ofapi_request_attempts order by reserved_at, id`,
    );
    expect(attempts.rows).toEqual([
      { operation: "ofapi_gateway_chats", state: "indeterminate", dispatch_outcome: "transport", credit_state: "indeterminate" },
      { operation: "ofapi_gateway_chat_message", state: "indeterminate", dispatch_outcome: "transport", credit_state: "indeterminate" },
    ]);
    const receipts = await testDb!.pool.query<{ operation: string; credits: number; estimated: boolean; details: Record<string, unknown> }>(
      `select operation, credits, estimated, details
       from ofapi_credit_ledger where attempt_id is not null order by id`,
    );
    expect(receipts.rows.map((row) => row.operation)).toEqual(["ofapi_gateway_chats", "ofapi_gateway_chat_message"]);
    const [fastReceipt, otherReceipt] = receipts.rows;
    expect(fastReceipt).toMatchObject({
      credits: 1,
      estimated: true,
      details: {
        certainty: "indeterminate", outcome: "transport", reason: "transport", phase: "post_dispatch",
        stage: "response_headers", transportClass: "timeout", status: null, bytesRead: 0, timeoutMs: 20_000,
      },
    });
    expect(otherReceipt?.details.timeoutMs).toBe(60_000);
    const shape = ({ details }: { details: Record<string, unknown> }) => {
      const { elapsedMs: _elapsedMs, timeoutMs: _timeoutMs, ...rest } = details;
      return rest;
    };
    expect(otherReceipt).toMatchObject({ credits: 1, estimated: true });
    expect(shape(fastReceipt!)).toEqual(shape(otherReceipt!));

    const transportWarnings = warn.mock.calls.filter(([, message]) => message === "OFAPI interactive capture transport failed");
    expect(transportWarnings.map(([fields]) => (fields as { timeoutMs: number }).timeoutMs)).toEqual([20_000, 60_000]);
  });

  it("answers a timed-out fast proxy read like a timed-out default one", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const armed = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => realTimeout(
      ms === 20_000 || ms === 60_000 ? 50 : ms,
    ));
    scriptedResponses.push({ status: 200, hang: true }, { status: 200, hang: true });

    const fast = await inject(`${ACCOUNT_ONE}/transactions?limit=10`);
    const other = await inject(OTHER_READ.path);

    expect(armed.mock.calls.map(([ms]) => ms)).toEqual([20_000, 60_000]);
    expect(upstreamRequests).toHaveLength(2);
    expect(fast.statusCode, fast.body).toBe(503);
    expect(fast.json()).toEqual(other.json());
    expect(fast.json()).toMatchObject({ error: "service_unavailable", statusCode: 503 });
    expect((await testDb!.pool.query("select 1 from ofapi_credit_ledger")).rows).toHaveLength(0);
  });
});

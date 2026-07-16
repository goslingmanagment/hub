import {
  createServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import { connect as connectTcp } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createModel,
  createOnlyFansPage,
  deleteProxyConfig,
  setPageOfapiAccountId,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  createUserAccount,
  issueChatterApiKey,
} from "../apps/runtime/src/services/auth.ts";
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
  chatterKey = (await issueChatterApiKey(appContext, {
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

function inject(path: string) {
  return apiServer!.inject({
    method: "GET",
    url: `/api/v1/ofapi/read/${path}`,
    headers: { authorization: `Bearer ${chatterKey}` },
  });
}

describe("OFAPI read gateway integration", () => {
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
    expect(proxyRequests).toHaveLength(1);

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
    expect(response.statusCode, response.body).toBe(503);
    expect(response.headers["retry-after"]).toBe("7");
    expect(upstreamRequests).toHaveLength(1);
    expect(proxyRequests).toHaveLength(1);
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
    expect(proxyRequests).toHaveLength(1);
  });

  it("fails loudly before upstream when an assigned OFAPI account has no page proxy", async () => {
    await deleteProxyConfig(appContext.db, assignedPageId);
    scriptedResponses.push({
      status: 200,
      body: { data: [{ id: 1 }] },
    });

    const response = await inject(`${ACCOUNT_ONE}/chats?limit=10`);

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      error: "service_unavailable",
      statusCode: 503,
    });
    expect(upstreamRequests).toHaveLength(0);
    expect(proxyRequests).toHaveLength(0);
    expect(scriptedResponses).toHaveLength(1);
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
    const state = await testDb!.pool.query<{
      request_state: string;
      attempt_state: string;
      parser_outcome: string;
      settled_credits: number;
      credit_estimated: boolean;
    }>(
      `select request.state as request_state,
              attempt.state as attempt_state,
              attempt.parser_outcome,
              attempt.settled_credits,
              attempt.credit_estimated
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

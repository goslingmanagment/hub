import { createServer, type Server as HttpServer } from "node:http";

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
import { createOfapiCreditSpendSink } from "../apps/runtime/src/services/ofapi-credits.ts";
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
  body: unknown;
  headers?: Record<string, string>;
}

interface UpstreamRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

let testDb: StartedTestDatabase | null = null;
let upstreamServer: HttpServer | null = null;
let upstreamBaseUrl: string | null = null;
let appContext: AppContext;
let apiServer: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let chatterKey = "";
let assignedPageId = 0;
const scriptedResponses: ScriptedResponse[] = [];
const upstreamRequests: UpstreamRequest[] = [];

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
    response.end(JSON.stringify(scripted.body));
  });
  const address = await listenOnLoopback(upstreamServer, "OFAPI read gateway tests");
  if (address) {
    upstreamBaseUrl = `http://${address.host}:${address.port}`;
  }
}, 120_000);

afterAll(async () => {
  await apiServer?.close();
  upstreamServer?.close();
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb || !upstreamBaseUrl) {
    context.skip();
    return;
  }
  await apiServer?.close();
  await resetIntegrationDatabase(testDb.pool);
  scriptedResponses.length = 0;
  upstreamRequests.length = 0;

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
  await testDb.pool.query(
    `update pages
     set username = case when id = $1 then 'loravie' else 'loravievip' end,
         display_name = case when id = $1 then 'Lora Free' else 'Lora VIP' end,
         ofapi_auth_status = case when id = $1 then 'connected' else 'authentication_failed' end,
         metadata = case when id = $1
           then '{"avatarUrl":"https://images.example/lora.jpg"}'::jsonb
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
        avatar: "https://images.example/lora.jpg",
      },
    }]);

    const whoami = await inject("whoami");
    expect(whoami.statusCode, whoami.body).toBe(200);
    expect(whoami.json()).toEqual({
      api_key: { name: "Agency Hub chatter: chatter" },
      team: { name: "Agency Hub", slug: "agency-hub" },
    });
    expect(upstreamRequests).toHaveLength(0);
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
});

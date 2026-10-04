import net from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  clientBootstrapResponseSchema,
  errorResponseSchema,
  type ClientBootstrapResponse,
} from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, createFanslyPage, deletePageByLabel, insertAgentKey } from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap, type NoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const PASSWORDS = { owner: "owner-secret", lead: "lead-secret", chatter: "chatter-secret" } as const;
const AUDIT = { source: "cli" } as const;
/** A live Agent Read Plane key, granted lora-of: its refusal is about the principal kind, not a page. */
const AGENT_KEY_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}clientbootstrap0000`;

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
/** authPolicyEnforcement "log" (the test default): the handler's own guards answer. */
let server: ApiServer | null = null;
/** authPolicyEnforcement "enforce": the declared policy answers before the handler. */
let enforceServer: ApiServer | null = null;
let trap: NoOutboundTrap | null = null;
let ownerToken = "";
let leadToken = "";
let chatterToken = "";
let chatterId = 0;
let leadId = 0;
let ownerId = 0;
const pageIds: Record<string, number> = {};

const everyFeature = (reason: string) => Object.fromEntries(
  CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, { available: false, reason }]),
);

async function bootstrap(headers: Record<string, string>, via: ApiServer = server!) {
  return via.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers });
}

async function loginCookie(username: keyof typeof PASSWORDS): Promise<string> {
  const login = await server!.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username, password: PASSWORDS[username] },
  });
  expect(login.statusCode, login.body).toBe(200);
  const header = login.headers["set-cookie"];
  return (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
}

async function bootstrapAs(token: string): Promise<ClientBootstrapResponse> {
  const response = await bootstrap({ authorization: `Bearer ${token}` });
  expect(response.statusCode, response.body).toBe(200);
  return clientBootstrapResponseSchema.parse(response.json());
}

describe("GET /api/v1/client/bootstrap", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  }, 120_000);

  beforeEach(async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "lead", role: "team_lead", password: PASSWORDS.lead }, AUDIT);
    await createUserAccount(app, { username: "chatter", role: "chatter" }, AUDIT);
    ownerId = await fixtureUserId(app, "owner");
    leadId = await fixtureUserId(app, "lead");
    chatterId = await fixtureUserId(app, "chatter");
    // A chatter is created without a password and sets one later; it ends every
    // sign-in, so it comes before the device tokens below.
    await setUserPassword(app, { userId: chatterId, password: PASSWORDS.chatter }, AUDIT);

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const mia = await createModel(app.db, { slug: "mia", name: "Mia" });
    for (const [label, modelId, create] of [
      ["lora-of", lora!.id, createOnlyFansPage],
      ["lora-vip-of", lora!.id, createOnlyFansPage],
      ["lora-fansly", lora!.id, createFanslyPage],
      ["lora-old-of", lora!.id, createOnlyFansPage],
      ["mia-of", mia!.id, createOnlyFansPage],
    ] as const) {
      const page = await create(app.db, { modelId, label });
      pageIds[label] = page!.id;
    }
    // external_page_id is the platform's own account id; the binding
    // generation counts upstream rebinds of an OnlyFans page.
    await testDb.pool.query(
      `update pages set external_page_id = $2, display_name = $3, ofapi_binding_generation = $4 where id = $1`,
      [pageIds["lora-of"], "100000001", "Lora OF", 3],
    );
    await testDb.pool.query(
      `update pages set external_page_id = $2, display_name = '  ' where id = $1`,
      [pageIds["lora-vip-of"], "100000002"],
    );
    await testDb.pool.query(`update pages set external_page_id = '100000003' where id = $1`, [pageIds["mia-of"]]);
    // A chat with unread messages, so the trap's unread check has something to hold.
    await testDb.pool.query(
      `insert into page_dm_threads (platform_account_id, platform_conversation_id, unread_count) values ($1, '100000777', 2)`,
      [pageIds["lora-of"]],
    );

    for (const label of ["lora-of", "lora-fansly", "lora-old-of"]) {
      await assignPageToUser(app, { userId: chatterId, pageLabel: label }, AUDIT);
    }
    for (const label of ["lora-vip-of", "mia-of", "lora-old-of"]) {
      await assignPageToUser(app, { userId: leadId, pageLabel: label }, AUDIT);
    }
    await deletePageByLabel(app.db, "lora-old-of");

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    leadToken = (await issueDeviceTokenForUserId(app, { userId: leadId, label: "lead client" })).token;
    chatterToken = (await issueDeviceTokenForUserId(app, { userId: chatterId, label: "chatter client" })).token;
    await insertAgentKey(app.db, {
      name: "client-bootstrap-probe",
      keyPrefix: AGENT_KEY_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(AGENT_KEY_TOKEN),
      capabilities: ["read:messages"],
      pageIds: [pageIds["lora-of"]!],
      dailyRequestBudget: 5000,
      dailyRowBudget: 500_000,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdBy: null,
    });

    server = await buildApiServer(app);
    await server.ready();
    enforceServer = await buildApiServer(createTestAppContext(testDb, { authPolicyEnforcement: "enforce" }));
    await enforceServer.ready();
    trap = await armNoOutboundTrap(testDb);
  });

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
    await enforceServer?.close();
    enforceServer = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("a chatter's device token lists only its active assigned pages, every feature off", async (context) => {
    if (!server) return context.skip();

    const body = await bootstrapAs(chatterToken);

    expect(body.protocol).toBe(1);
    expect(Number.isNaN(Date.parse(body.issuedAt))).toBe(false);
    expect(body.ttlSec).toBe(300);
    expect(body.configRevision).toBe(0);
    expect(body.minVersion).toBe("0.0.0");
    expect(body.identity).toEqual({ userId: chatterId, username: "chatter", role: "chatter", tokenClient: null });
    // Assigned: lora-of, lora-fansly and the tombstoned lora-old-of. Not
    // assigned: lora-vip-of, mia-of.
    expect(body.pages).toEqual([
      {
        pageId: pageIds["lora-fansly"],
        pageLabel: "lora-fansly",
        title: "Lora",
        platform: "fansly",
        platformAccountId: null,
        bindingRevision: 1,
        features: everyFeature("platform_unsupported"),
      },
      {
        pageId: pageIds["lora-of"],
        pageLabel: "lora-of",
        title: "Lora OF",
        platform: "onlyfans",
        platformAccountId: "100000001",
        bindingRevision: 3,
        features: everyFeature("disabled"),
      },
    ]);
    expect(body.bindingsByHost).toEqual({});
    expect(body.flags).toEqual(Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, false])));
    expect(body.limits).toEqual({
      freshTextMaxItems: 60,
      freshTextMaxChars: 5000,
      feedMax: 100,
      deepMax: 1500,
      audienceWindowHours: 720,
      claimLeaseSec: 120,
      claimRenewSec: 40,
      claimActivityWindowSec: 120,
      previewSendPerMinute: 6,
      navInsertTimeoutSec: 20,
      dispatchTicketSec: 10,
      previewSendReceiptProfiles: [],
    });
    // What this hub serves today: the AI stream's context frame (H-4b), the
    // fresh text of the open chat (H-4c), the shared recaps read (H-13), the
    // dossier save from a stored generation (H-5) and Split for Ping, Hi and
    // Coach drafts (H-10; the flag itself is off at rest).
    expect(body.capabilities).toEqual([
      "context-v1",
      "live-text-v1",
      "shared-recaps-v1",
      "recap-profile-v1",
      "split-all-v1",
    ]);
    expect(body.capabilities).toEqual([...SERVED_CLIENT_CAPABILITIES]);

    await trap!.assertNoOutbound();
  });

  it("the owner's device token lists every active page and never a tombstone", async (context) => {
    if (!server) return context.skip();

    const body = await bootstrapAs(ownerToken);

    expect(body.identity).toEqual({ userId: ownerId, username: "owner", role: "owner", tokenClient: null });
    expect(body.pages.map((page) => [page.pageLabel, page.platformAccountId, page.title])).toEqual([
      ["lora-fansly", null, "Lora"],
      ["lora-of", "100000001", "Lora OF"],
      // A blank display name falls back to the model's name.
      ["lora-vip-of", "100000002", "Lora"],
      ["mia-of", "100000003", "Mia"],
    ]);
    expect(body.pages.find((page) => page.pageLabel === "lora-vip-of")?.bindingRevision).toBe(1);

    await trap!.assertNoOutbound();
  });

  it("a team lead's device token lists only its active assigned pages", async (context) => {
    if (!server) return context.skip();

    const body = await bootstrapAs(leadToken);

    expect(body.identity).toEqual({ userId: leadId, username: "lead", role: "team_lead", tokenClient: null });
    // Assigned: lora-vip-of, mia-of and the tombstoned lora-old-of.
    expect(body.pages.map((page) => page.pageLabel)).toEqual(["lora-vip-of", "mia-of"]);
    for (const page of body.pages) {
      expect(page.features, page.pageLabel).toEqual(everyFeature("disabled"));
    }

    await trap!.assertNoOutbound();
  });

  it("holds the rights-matrix row in both auth-policy modes: device tokens only, agent keys refused", async (context) => {
    if (!server || !enforceServer) return context.skip();

    const cookies = {
      owner: await loginCookie("owner"),
      lead: await loginCookie("lead"),
      chatter: await loginCookie("chatter"),
    };
    const cases: Array<{ who: string; headers: Record<string, string>; status: number }> = [
      { who: "anonymous", headers: {}, status: 401 },
      { who: "unknown bearer", headers: { authorization: "Bearer agency_hub_device_not-a-real-token" }, status: 401 },
      { who: "owner cookie", headers: { cookie: cookies.owner }, status: 403 },
      { who: "team_lead cookie", headers: { cookie: cookies.lead }, status: 403 },
      { who: "chatter cookie", headers: { cookie: cookies.chatter }, status: 403 },
      // Live and granted lora-of: refused by kind, so it never sees the page list.
      { who: "agent key", headers: { authorization: `Bearer ${AGENT_KEY_TOKEN}` }, status: 403 },
      { who: "owner device token", headers: { authorization: `Bearer ${ownerToken}` }, status: 200 },
      { who: "team_lead device token", headers: { authorization: `Bearer ${leadToken}` }, status: 200 },
      { who: "chatter device token", headers: { authorization: `Bearer ${chatterToken}` }, status: 200 },
    ];

    for (const [mode, via] of [["log", server], ["enforce", enforceServer]] as const) {
      for (const testCase of cases) {
        const label = `${mode} mode, ${testCase.who}`;
        const response = await bootstrap(testCase.headers, via);
        expect(response.statusCode, `${label}: ${response.body}`).toBe(testCase.status);
        if (testCase.status === 200) {
          clientBootstrapResponseSchema.parse(response.json());
          continue;
        }
        // Every refusal is the declared error body, so the SDK raises a typed error.
        const error = errorResponseSchema.safeParse(response.json());
        expect(error.success, `${label}: ${response.body}`).toBe(true);
        expect(error.data?.statusCode, label).toBe(testCase.status);
        expect(error.data?.error, label).toBe(testCase.status === 401 ? "unauthorized" : "forbidden");
      }
    }

    await trap!.assertNoOutbound();
  });

  it("the no-outbound trap refuses and reports traffic that leaves the process", async (context) => {
    if (!server || !testDb) return context.skip();

    // TEST-NET-3 (RFC 5737): never routed, and refused before any packet is sent.
    await expect(fetch("https://203.0.113.10/x")).rejects.toThrow(/no-outbound trap/);
    const socketError = await new Promise<Error>((resolve) => {
      net.connect(443, "203.0.113.10").once("error", resolve);
    });
    expect(socketError.message).toMatch(/no-outbound trap/);
    // The database stays reachable under the trap.
    expect((await testDb.pool.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);

    expect(trap!.attempts).toEqual(["fetch https://203.0.113.10/x", "connect 203.0.113.10:443"]);
    await expect(trap!.assertNoOutbound()).rejects.toThrow(/outbound attempts/);
  });
});

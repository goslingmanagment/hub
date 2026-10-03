import net from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  clientBootstrapResponseSchema,
  type ClientBootstrapResponse,
} from "@agency_hub_core/contracts";
import { createModel, createOnlyFansPage, createFanslyPage, deletePageByLabel } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
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

const OWNER_PASSWORD = "owner-secret";
const AUDIT = { source: "cli" } as const;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
let trap: NoOutboundTrap | null = null;
let ownerToken = "";
let chatterToken = "";
let chatterId = 0;
let ownerId = 0;
const pageIds: Record<string, number> = {};

const everyFeature = (reason: string) => Object.fromEntries(
  CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, { available: false, reason }]),
);

async function bootstrap(headers: Record<string, string>) {
  return server!.inject({ method: "GET", url: "/api/v1/client/bootstrap", headers });
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
    await createUserAccount(app, { username: "owner", role: "owner", password: OWNER_PASSWORD }, AUDIT);
    await createUserAccount(app, { username: "chatter", role: "chatter" }, AUDIT);
    ownerId = await fixtureUserId(app, "owner");
    chatterId = await fixtureUserId(app, "chatter");

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
    await deletePageByLabel(app.db, "lora-old-of");

    ownerToken = (await issueDeviceTokenForUserId(app, { userId: ownerId, label: "owner client" })).token;
    chatterToken = (await issueDeviceTokenForUserId(app, { userId: chatterId, label: "chatter client" })).token;

    server = await buildApiServer(app);
    await server.ready();
    trap = await armNoOutboundTrap(testDb);
  });

  afterEach(async () => {
    await trap?.restore();
    trap = null;
    await server?.close();
    server = null;
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
    expect(body.capabilities).toEqual([]);

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

  it("a cookie session is refused with 403, a missing or unknown bearer with 401", async (context) => {
    if (!server) return context.skip();

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: OWNER_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;

    const bySession = await bootstrap({ cookie });
    expect(bySession.statusCode, bySession.body).toBe(403);

    const anonymous = await bootstrap({});
    expect(anonymous.statusCode, anonymous.body).toBe(401);

    const unknown = await bootstrap({ authorization: "Bearer agency_hub_device_not-a-real-token" });
    expect(unknown.statusCode, unknown.body).toBe(401);

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

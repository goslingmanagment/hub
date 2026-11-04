import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { clientFanslyProxiesResponseSchema, errorResponseSchema } from "@agency_hub_core/contracts";
import { createFanslyPage, createModel, createOnlyFansPage } from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { assignPageToUser, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { saveProxy } from "../apps/runtime/src/services/page-context.ts";
import { issueDeviceTokenForUserId } from "./helpers/device-credentials.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// fansly-proxies-v1: a proxy's login leaves the hub only here, so what matters is who gets which row: the caller's own
// active Fansly pages, never another page's, never another platform's, never without a device token.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

const AUDIT = { source: "cli" } as const;
type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let grishaToken = "";
let emptyToken = "";

const read = (headers: Record<string, string>) => server!.inject({ method: "GET", url: "/api/v1/client/fansly-proxies", headers });
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "x-client-version": "chat-extension/3.22.0" });

describe("client fansly proxies", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    await createUserAccount(app, { username: "nobody", role: "chatter" }, AUDIT);
    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    const ids: Record<string, number> = {};
    for (const [label, create] of [
      ["lora-fansly", createFanslyPage],
      ["mia-fansly", createFanslyPage],
      ["plain-fansly", createFanslyPage],
      ["lora-of", createOnlyFansPage],
    ] as const) {
      ids[label] = (await create(app.db, { modelId: lora!.id, label }))!.id;
    }
    await saveProxy(app, ids["lora-fansly"]!, { url: "socks5://203.0.113.10:12324", username: "granted-user", password: "granted-pass" });
    await saveProxy(app, ids["mia-fansly"]!, { url: "socks5://203.0.113.11:12324", username: "other-user", password: "other-pass" });
    await saveProxy(app, ids["lora-of"]!, { url: "socks5://203.0.113.12:12324", username: "of-user", password: "of-pass" });
    const grisha = await fixtureUserId(app, "grisha");
    for (const pageLabel of ["lora-fansly", "plain-fansly", "lora-of"]) await assignPageToUser(app, { userId: grisha, pageLabel }, AUDIT);
    grishaToken = (await issueDeviceTokenForUserId(app, { userId: grisha, label: "grisha client" })).token;
    emptyToken = (await issueDeviceTokenForUserId(app, { userId: await fixtureUserId(app, "nobody"), label: "nobody client" })).token;
    server = await buildApiServer(app);
    await server.ready();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await testDb?.stop();
  });

  it("answers the caller's own Fansly pages with a proxy, with the login, and asks nothing to keep it", async () => {
    if (!server) return;
    const response = await read(bearer(grishaToken));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = clientFanslyProxiesResponseSchema.parse(response.json());
    expect(body.proxies).toEqual([
      { pageLabel: "lora-fansly", platformAccountId: null, scheme: "socks5", host: "203.0.113.10", port: 12324, username: "granted-user", password: "granted-pass" },
    ]);
    // Neither another page's nor another platform's login, under any name.
    expect(response.body).not.toMatch(/other-(user|pass)|of-(user|pass)/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("answers nothing to a person with no pages", async () => {
    if (!server) return;
    const body = clientFanslyProxiesResponseSchema.parse((await read(bearer(emptyToken))).json());
    expect(body.proxies).toEqual([]);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses without a token", async () => {
    if (!server) return;
    const response = await read({ "x-client-version": "chat-extension/3.22.0" });
    expect(response.statusCode).toBe(401);
    errorResponseSchema.parse(response.json());
    expect(response.body).not.toMatch(/granted-(user|pass)/);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

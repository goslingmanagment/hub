import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_TOKEN_PROFILES,
  errorResponseSchema,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  assignPageToUser,
  createUserAccount,
  setUserPassword,
} from "../apps/runtime/src/services/auth.ts";
import { CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE } from "../apps/runtime/src/services/client-token-profile.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Fixture passwords hash at minimum cost; sign-in still runs the real argon2
// verify (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

// chat-extension H-3: the narrow device token. Issued through the real
// password sign-in with `client: "chat-extension"`, it reaches only the
// profile's routes (CLIENT_TOKEN_PROFILES); a full token of the same person
// is untouched. The allowlist's static half (keys, kinds, paths) is
// tests/client-token-scopes.test.ts.

const PASSWORDS = { owner: "owner-secret", chatter: "chatter-secret" } as const;
const AUDIT = { source: "cli" } as const;
const EXTENSION_VERSION = "chat-extension/1.4.2";
/** Route kinds that take no principal: the allowlist does not apply to them. */
const NO_PRINCIPAL_KINDS = new Set(["public", "hmac", "pending-device-token"]);
/** Test-only: a request carrying it stops right after the auth hooks (see the walk). */
const WALK_HEADER = "x-test-route-walk";

type ApiServer = Awaited<ReturnType<typeof buildApiServer>>;
type InjectResponse = Awaited<ReturnType<ApiServer["inject"]>>;

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let server: ApiServer | null = null;
let narrowToken = "";
let fullToken = "";
const pageIds: Record<string, number> = {};

async function signIn(body: Record<string, unknown>, clientVersion = EXTENSION_VERSION) {
  return server!.inject({
    method: "POST",
    url: "/api/v1/auth/device-tokens/password",
    headers: { "x-client-version": clientVersion },
    payload: { username: "grisha", password: PASSWORDS.chatter, label: "Firefox · macOS · ChatSpace", ...body },
  });
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, "x-client-version": EXTENSION_VERSION, ...extra };
}

async function call(token: string, method: "GET" | "DELETE", url: string, extra: Record<string, string> = {}) {
  return server!.inject({ method, url, headers: bearer(token, extra) });
}

/** The narrow token's refusal: 403, the plain envelope, never a `reason`. */
function expectRouteRefused(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(403);
  const body = response.json<Record<string, unknown>>();
  expect(body).toEqual({ error: "forbidden", message: CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE, statusCode: 403 });
  expect(errorResponseSchema.safeParse(body).success).toBe(true);
}

/** A concrete URL for a registered route: the chatter's page for :pageLabel, "1" for any other parameter. */
function concreteUrl(url: string): string {
  return url
    .replace(":pageLabel", "lora-of")
    .replace(/:[A-Za-z]+/g, "1")
    .replace(/\*$/, "x");
}

describe("narrow chat-extension device token (H-3)", () => {
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
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    const chatterId = await fixtureUserId(app, "grisha");
    await setUserPassword(app, { userId: chatterId, password: PASSWORDS.chatter }, AUDIT);

    const lora = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const [label, create] of [
      ["lora-of", createOnlyFansPage],
      ["mia-of", createOnlyFansPage],
      ["lora-fansly", createFanslyPage],
    ] as const) {
      const page = await create(app.db, { modelId: lora!.id, label });
      pageIds[label] = page!.id;
      await storeProxyConfig(app.db, page!.id, {
        url: "socks5://proxy.example:1080",
        encryptedAuth: null,
        keyVersion: null,
        rateLimitScopeKey: "shared-ai-proxy",
      });
    }
    await testDb.pool.query(`update pages set external_page_id = '100000001' where id = $1`, [pageIds["lora-of"]]);
    await testDb.pool.query(`update pages set external_page_id = '100000002' where id = $1`, [pageIds["mia-of"]]);
    for (const label of ["lora-of", "lora-fansly"]) {
      await assignPageToUser(app, { userId: chatterId, pageLabel: label }, AUDIT);
    }

    server = await buildApiServer(app);
    // The route walk below asks only what the auth hooks decide: a request
    // carrying WALK_HEADER stops right after them (this hook is the last
    // onRequest hook), so no handler runs, no stream opens, nothing is written.
    server.addHook("onRequest", async (request, reply) => {
      if (request.headers[WALK_HEADER] === "1") {
        await reply.code(299).send({ reachedHandler: true });
      }
    });
    await server.ready();

    const narrow = await signIn({ mode: "active", client: "chat-extension" });
    expect(narrow.statusCode, narrow.body).toBe(200);
    narrowToken = narrow.json<{ token: string }>().token;
    const full = await signIn({ mode: "active" }, "2.7.1");
    expect(full.statusCode, full.body).toBe(200);
    fullToken = full.json<{ token: string }>().token;
  }, 120_000);

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("walks every route of the policy table: the narrow token reaches its list only, a full token is untouched", async (context) => {
    if (!server) return context.skip();
    const allowed: readonly string[] = CLIENT_TOKEN_PROFILES["chat-extension"].operations;
    const trap = await armNoOutboundTrap(testDb!);
    let refused = 0;
    let passed = 0;
    try {
      for (const row of server.routePolicyTable) {
        const request = {
          method: row.method as "GET",
          url: concreteUrl(row.url),
          ...(row.method === "GET" ? {} : { payload: {} }),
        };
        const label = `${row.method} ${row.url} (${row.routeKey}, ${row.auth?.kind})`;
        const narrow = await server.inject({ ...request, headers: bearer(narrowToken, { [WALK_HEADER]: "1" }) });
        const full = await server.inject({
          ...request,
          headers: { authorization: `Bearer ${fullToken}`, "x-client-version": "2.7.1", [WALK_HEADER]: "1" },
        });

        // A full token never meets the narrow token's refusal.
        expect(full.body, label).not.toContain(CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE);
        if (NO_PRINCIPAL_KINDS.has(row.auth!.kind) || allowed.includes(row.routeKey)) {
          // On its list (or on a route with no principal) the narrow token
          // gets exactly what a full token of the same person gets.
          expect({ status: narrow.statusCode, body: narrow.json() }, label)
            .toEqual({ status: full.statusCode, body: full.json() });
          passed += 1;
        } else {
          expect(narrow.statusCode, label).toBe(403);
          expect(narrow.json(), label)
            .toEqual({ error: "forbidden", message: CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE, statusCode: 403 });
          refused += 1;
        }
      }
      // The refused routes never reached a handler, so nothing left the process.
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }
    expect(refused + passed).toBe(server.routePolicyTable.length);
    expect(passed).toBeGreaterThanOrEqual(allowed.length);
    expect(refused).toBeGreaterThan(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the list works and keeps the page scope; a revoked narrow token says token_revoked", async (context) => {
    if (!server) return context.skip();
    expect((await call(narrowToken, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
    expect((await call(narrowToken, "GET", "/api/v1/pages/lora-of/spender-autolists")).statusCode).toBe(200);
    // An unassigned page on a listed route: the ordinary page refusal, not the client one.
    const foreign = await call(narrowToken, "GET", "/api/v1/pages/mia-of/spender-autolists");
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(foreign.body).not.toContain(CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE);
    expect((await call(fullToken, "GET", "/api/v1/pages/mia-of/spender-autolists")).statusCode).toBe(403);

    for (const url of [
      "/api/v1/pages",
      "/api/v1/pages/lora-of/subscribers",
      "/api/v1/ai/personas",
      "/api/v1/ofapi/read/accounts",
      "/api/v1/events/v2/snapshot",
    ]) {
      expectRouteRefused(await call(narrowToken, "GET", url));
      expect((await call(fullToken, "GET", url)).body).not.toContain(CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE);
    }

    const revoked = await call(narrowToken, "DELETE", "/api/v1/auth/device-tokens/current");
    expect(revoked.statusCode, revoked.body).toBe(200);
    // A dead token is a 401 with its reason everywhere, on and off the list.
    for (const url of ["/api/v1/auth/me", "/api/v1/pages"]) {
      const response = await call(narrowToken, "GET", url);
      expect(response.statusCode, `${url} ${response.body}`).toBe(401);
      expect(errorResponseSchema.parse(response.json())).toMatchObject({ reason: "token_revoked" });
    }
    expect((await call(fullToken, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

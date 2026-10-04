import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_TOKEN_PROFILES,
  clientBootstrapResponseSchema,
  errorResponseSchema,
} from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  seedBundledAiPersona,
  storeProxyConfig,
} from "@agency_hub_core/db";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import type { AiGatewayProvider } from "../apps/runtime/src/services/ai-gateway.ts";
import {
  assignPageToUser,
  createUserAccount,
  setDeviceTokenHarvestCapabilityForUserId,
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
// profile's routes (CLIENT_TOKEN_PROFILES), in both auth-policy modes; a full
// token of the same person is untouched. The allowlist's static half (keys,
// kinds, paths) is tests/client-token-scopes.test.ts.

const PASSWORDS = { owner: "owner-secret", chatter: "chatter-secret" } as const;
const AUDIT = { source: "cli" } as const;
const FAN = "777000777";
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
let ownerCookie = "";
let narrowToken = "";
let fullToken = "";
const pageIds: Record<string, number> = {};

function capturingProvider(): AiGatewayProvider {
  return {
    provider: "anthropic",
    async *stream() {
      yield { type: "content_delta", text: "sure thing" };
      yield {
        type: "usage",
        providerResponseId: "msg_narrow",
        cacheHit: false,
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costMicroUsd: 100,
          costApproximate: false,
        },
      };
      yield { type: "done", stopReason: "end_turn" };
    },
  };
}

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

function expectFeatureRefused(response: InjectResponse, reason: string) {
  expect(response.statusCode, response.body).toBe(409);
  expect(errorResponseSchema.parse(response.json())).toMatchObject({ error: "client_feature_disabled", reason });
}

async function patchConfig(patches: Array<{ key: string; value: unknown }>) {
  const response = await server!.inject({
    method: "PATCH",
    url: "/api/v1/admin/config",
    headers: { cookie: ownerCookie },
    payload: { patches },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function generate(token: string, feature: string, pageLabel: string, headers: Record<string, string> = {}) {
  return server!.inject({
    method: "POST",
    url: `/api/v1/ai/features/${feature}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: { clientRequestId: randomUUID(), pageLabel, platform: "onlyfans", conversationRef: FAN, replyTone: "casual" },
  });
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
    app = createTestAppContext(testDb, { authPolicyEnforcement: "log" });
    app.config.chatMuseAiGatewayEnabled = true;
    app.aiGatewayProvider = capturingProvider();
    await createUserAccount(app, { username: "owner", role: "owner", password: PASSWORDS.owner }, AUDIT);
    await createUserAccount(app, { username: "grisha", role: "chatter" }, AUDIT);
    const chatterId = await fixtureUserId(app, "grisha");
    await setUserPassword(app, { userId: chatterId, password: PASSWORDS.chatter }, AUDIT);

    const persona = createBundledPersonalities()[0]!;
    await seedBundledAiPersona(app.db, {
      key: persona.id,
      displayName: persona.name,
      systemBlock: persona.content,
      bundledVersion: persona.builtinVersion!,
    });
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
    await testDb.pool.query(
      `insert into message_archive (account_id, platform, conversation_ref, message_ref,
         fan_native_id, is_sent_by_me, occurred_at, text_plain, is_tip, tip_amount_mills)
       values ($1, 'onlyfans', $2, '9001', $2, false, now() - interval '1 hour', 'hey babe', false, 0)`,
      [pageIds["lora-of"], FAN],
    );

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

    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "owner", password: PASSWORDS.owner },
    });
    expect(login.statusCode, login.body).toBe(200);
    const header = login.headers["set-cookie"];
    ownerCookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  }, 120_000);

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("a sign-in with client stores the profile, echoes it and audits it; a plain sign-in stays full", async (context) => {
    if (!server) return context.skip();

    const echoed = await signIn({ mode: "active", client: "chat-extension" });
    expect(echoed.json()).toMatchObject({ mode: "active", client: "chat-extension" });
    const plain = await signIn({ mode: "active" });
    expect(plain.json()).toMatchObject({ mode: "active", client: null });

    const rows = await testDb!.pool.query<{ id: string; client_profile: string | null }>(
      "select id::text, client_profile from device_tokens order by id",
    );
    expect(rows.rows.map((row) => row.client_profile)).toEqual(["chat-extension", null, "chat-extension", null]);

    const audits = await testDb!.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where event_type = 'device_token.issued' order by id",
    );
    expect(audits.rows.map((row) => row.metadata.clientProfile ?? null))
      .toEqual(["chat-extension", null, "chat-extension", null]);
    expect(audits.rows[1]!.metadata).not.toHaveProperty("clientProfile");

    // A reservation carries no profile: refused before anything is minted.
    const pending = await signIn({ mode: "pending", client: "chat-extension" });
    expect(pending.statusCode, pending.body).toBe(400);
    const pendingRows = await testDb!.pool.query<{ count: number }>("select count(*)::int as count from pending_device_tokens");
    expect(pendingRows.rows[0]!.count).toBe(0);
    expect((await signIn({ mode: "active", client: "desktop" })).statusCode).toBe(400);

    // The bootstrap says which token the client holds.
    for (const [token, tokenClient] of [[narrowToken, "chat-extension"], [fullToken, null]] as const) {
      const response = await call(token, "GET", "/api/v1/client/bootstrap");
      expect(response.statusCode, response.body).toBe(200);
      expect(clientBootstrapResponseSchema.parse(response.json()).identity.tokenClient).toBe(tokenClient);
    }
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("the profile cannot be changed in place, and only a known profile is stored", async (context) => {
    if (!server) return context.skip();
    const tokenIds = await testDb!.pool.query<{ id: string; client_profile: string | null }>(
      "select id::text, client_profile from device_tokens order by id",
    );
    const [narrowId, fullId] = tokenIds.rows.map((row) => row.id);

    await expect(testDb!.pool.query("update device_tokens set client_profile = null where id = $1", [narrowId]))
      .rejects.toThrow(/client_profile is immutable/);
    await expect(testDb!.pool.query("update device_tokens set client_profile = 'chat-extension' where id = $1", [fullId]))
      .rejects.toThrow(/client_profile is immutable/);
    // Other columns move freely (the sliding expiry and the label).
    await testDb!.pool.query("update device_tokens set label = 'renamed', last_used_at = now() where id = $1", [narrowId]);
    await expect(testDb!.pool.query(
      `insert into device_tokens (user_id, token_digest, key_prefix, expires_at, client_profile)
       select user_id, 'other-digest', key_prefix, expires_at, 'desktop' from device_tokens where id = $1`,
      [narrowId],
    )).rejects.toThrow(/check constraint/);

    // The narrow token still authenticates as narrow after the label change.
    expectRouteRefused(await call(narrowToken, "GET", "/api/v1/pages"));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  for (const mode of ["log", "enforce"] as const) {
    it(`walks every route of the policy table in ${mode} mode: the narrow token reaches its list only, a full token is untouched`, async (context) => {
      if (!server) return context.skip();
      app.config.authPolicyEnforcement = mode;
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
  }

  for (const mode of ["log", "enforce"] as const) {
    it(`${mode} mode: the list works and keeps the page scope; a revoked narrow token says token_revoked`, async (context) => {
      if (!server) return context.skip();
      app.config.authPolicyEnforcement = mode;

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
  }

  it("captures only ai_acceptance, under chat-extension@<version>; the harvest lane is shut", async (context) => {
    if (!server) return context.skip();
    const event = (kind: string) => ({
      clientEventId: randomUUID(),
      kind,
      observedAt: "2026-10-03T12:00:00.000Z",
      payload: { generationRef: randomUUID(), lifecycle: "inserted" },
      pageLabel: "lora-of",
    });
    const ingest = (token: string, clientVersion: string, kinds: string[]) => server!.inject({
      method: "POST",
      url: "/api/v1/ingest/observations",
      headers: { authorization: `Bearer ${token}`, "x-client-version": clientVersion },
      payload: { events: kinds.map(event) },
    });
    const journal = async () => (await testDb!.pool.query<{ producer: string; kind: string; account_id: string | null }>(
      "select producer, kind, account_id::text from observations where source = 'client_capture' order by id",
    )).rows;

    // One kind outside the profile refuses the whole batch.
    const mixed = await ingest(narrowToken, EXTENSION_VERSION, ["ai_acceptance", "send_audit"]);
    expect(mixed.statusCode, mixed.body).toBe(400);
    expect(mixed.json()).toMatchObject({ error: "invalid_ingest_event" });
    expect(await journal()).toEqual([]);

    expect((await ingest(narrowToken, EXTENSION_VERSION, ["ai_acceptance"])).json()).toEqual({ accepted: 1, duplicates: 0 });
    // The profile decides the producer; the header only names the version.
    expect((await ingest(narrowToken, "desktop/0.1.64", ["ai_acceptance"])).statusCode).toBe(200);
    // The full token of the same person is journaled as before.
    expect((await ingest(fullToken, "2.7.1", ["ai_acceptance", "send_audit"])).json()).toEqual({ accepted: 2, duplicates: 0 });
    expect(await journal()).toEqual([
      { producer: "chat-extension@1.4.2", kind: "desktop.ai_acceptance", account_id: String(pageIds["lora-of"]) },
      { producer: "chat-extension@unknown", kind: "desktop.ai_acceptance", account_id: String(pageIds["lora-of"]) },
      { producer: "desktop@2.7.1", kind: "desktop.ai_acceptance", account_id: String(pageIds["lora-of"]) },
      { producer: "desktop@2.7.1", kind: "desktop.send_audit", account_id: String(pageIds["lora-of"]) },
    ]);

    // The harvest lane: a narrow token never holds the capability, so its header is a 403.
    const harvest = await ingest(narrowToken, "harvest-0.1.64", ["harvest.messages"]);
    expect(harvest.statusCode, harvest.body).toBe(403);
    const narrowId = (await testDb!.pool.query<{ id: string }>(
      "select id::text from device_tokens where client_profile is not null order by id limit 1",
    )).rows[0]!.id;
    await expect(setDeviceTokenHarvestCapabilityForUserId(app, {
      userId: await fixtureUserId(app, "grisha"),
      deviceTokenId: Number(narrowId),
      machineId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }, AUDIT)).rejects.toMatchObject({ statusCode: 400 });
    expect((await testDb!.pool.query("select 1 from device_tokens where harvest_machine_id is not null")).rowCount).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("AI: the owner's switches and minimum version decide the narrow token's generations, which are labelled; a full token is untouched", async (context) => {
    if (!server) return context.skip();
    const narrowHeaders = (version: string | null) => ({
      authorization: `Bearer ${narrowToken}`,
      ...(version === null ? {} : { "x-client-version": version }),
    });

    // At rest the master switch is off: every narrow generation is refused before any spend.
    for (const feature of ["fast-reply", "improve-draft", "hi-greeting", "ping"]) {
      expectFeatureRefused(await generate(narrowToken, feature, "lora-of", { "x-client-version": EXTENSION_VERSION }), "disabled");
    }
    expectFeatureRefused(await generate(narrowToken, "coach-chat", "lora-of", { "x-client-version": EXTENSION_VERSION }), "disabled");
    // The full token generates as before, and its record carries no profile.
    const full = await generate(fullToken, "fast-reply", "lora-of", { "x-client-version": "0.1.64" });
    expect(full.statusCode, full.body).toBe(200);
    expect(full.body).toContain("sure thing");

    await patchConfig([
      { key: "chatExtensionEnabled", value: true },
      { key: "chatExtensionMinVersion", value: "1.2.0" },
      { key: "chatExtensionFeatures", value: JSON.stringify({ "lora-of": { coach: true, recap: true } }) },
    ]);

    // Below the owner's minimum, or unreadable: refused on the hub (critic 6).
    for (const version of ["chat-extension/1.1.9", "desktop/0.1.64", null]) {
      expectFeatureRefused(await server.inject({
        method: "POST",
        url: "/api/v1/ai/features/fast-reply",
        headers: narrowHeaders(version),
        payload: { clientRequestId: randomUUID(), pageLabel: "lora-of", platform: "onlyfans", conversationRef: FAN },
      }), "client_outdated");
    }
    const narrow = await generate(narrowToken, "fast-reply", "lora-of", { "x-client-version": "chat-extension/1.2.0" });
    expect(narrow.statusCode, narrow.body).toBe(200);
    expect(narrow.body).toContain("sure thing");

    const params = await testDb!.pool.query<{ params: Record<string, unknown> }>(
      "select params from ai_generation_content order by id",
    );
    expect(params.rows).toHaveLength(2);
    expect(params.rows[0]!.params).not.toHaveProperty("clientProfile");
    expect(params.rows[1]!.params).toMatchObject({ clientProfile: "chat-extension" });

    // The features with a flag of their own run the full check on the page.
    const at = { "x-client-version": "chat-extension/1.2.0" };
    // Coach is on for lora-of: past the switch, the feature's own validation answers.
    const coach = await generate(narrowToken, "coach-chat", "lora-of", at);
    expect(coach.statusCode, coach.body).toBe(400);
    expect(coach.body).not.toContain("client_feature_disabled");
    expectFeatureRefused(await generate(narrowToken, "coach-chat", "lora-of", { "x-client-version": "chat-extension/1.1.0" }), "client_outdated");
    expectFeatureRefused(await generate(narrowToken, "chat-review", "lora-of", at), "flag_off");
    // Recap is on for lora-of, and the hub serves all of it (the shared read
    // and the dossier save): past the switch, the feature's own gate answers.
    const recap = await generate(narrowToken, "fan-summary", "lora-of", at);
    expect(recap.statusCode, recap.body).toBe(400);
    expect(recap.json()).toMatchObject({ error: "gate_min_messages" });
    expectFeatureRefused(await generate(narrowToken, "fan-summary", "lora-of", { "x-client-version": "chat-extension/1.1.0" }), "client_outdated");
    // A page not granted and a page that does not exist answer the same.
    expectFeatureRefused(await generate(narrowToken, "coach-chat", "mia-of", at), "not_granted");
    expectFeatureRefused(await generate(narrowToken, "coach-chat", "ghost-of", at), "not_granted");
    // The full token's Coach is decided by the feature alone, as before.
    const fullCoach = await generate(fullToken, "coach-chat", "lora-of", { "x-client-version": "0.1.64" });
    expect(fullCoach.statusCode, fullCoach.body).toBe(400);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

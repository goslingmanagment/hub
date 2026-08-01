import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createUser,
  findAgentKeyByDigest,
  insertAgentKey,
  revokeAgentKey,
  setConfigOverride,
} from "@agency_hub_core/db";
import { createUserAccount, issueChatterApiKey } from "../apps/runtime/src/services/auth.ts";
import { sha256Hex } from "@agency_hub_core/shared";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { AGENT_KEY_TOKEN_PREFIX } from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

/**
 * Agent Read Plane slice A: the END-TO-END isolation suite.
 *
 * Everything here is a property of the REAL routes, booted with the declarative
 * middleware in `enforce` (the dual-layer law says the in-handler guards must
 * hold in `log` mode too, and both layers are exercised: the middleware refuses
 * some of these before any handler runs, the handlers refuse the rest).
 *
 * The properties, in the order the design argues for them:
 *   an agent key is admitted ONLY on agent routes and refused on every other
 *   kind including the event streams; a human is refused on agent routes; a
 *   revoked or expired key is inert; an out-of-grant page and a nonexistent page
 *   answer BYTE-IDENTICALLY; the ramp modes behave; every response is no-store.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;
/** A REAL owner session cookie and a REAL chatter api key, so the "a human is
 *  refused on an agent route" property is exercised with actual principals. The
 *  first revision asserted a failed LOGIN and never called an agent route with a
 *  human at all — it would have passed with the isolation removed. */
let ownerCookie = "";
let chatterApiKey = "";

const AGENT_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}slice-a-isolation-token`;
const OTHER_TOKEN = `${AGENT_KEY_TOKEN_PREFIX}slice-a-other-token`;

let grantedPageId = 0;
let hiddenPageLabel = "";

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await server?.close();
  await testDb?.stop();
});

/**
 * The suite runs TWICE, once per policy mode.
 *
 * The declarative middleware defaults to `log` in this repository and only `prod`
 * runs `enforce`, so the dual-layer law (#143) requires every isolation property
 * to hold from the IN-HANDLER guards alone. Running only under `enforce` would let
 * someone delete an in-handler check and never notice.
 */
const POLICY_MODES = ["log", "enforce"] as const;
let policyMode: (typeof POLICY_MODES)[number] = "enforce";

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb, { authPolicyEnforcement: policyMode });

  const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
  if (!model) {
    throw new Error("fixture model was not created");
  }
  const granted = await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-2" });
  const hidden = await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-hidden" });
  if (!granted || !hidden) {
    throw new Error("fixture pages were not created");
  }
  grantedPageId = granted.id;
  hiddenPageLabel = hidden.label;

  const owner = await createUserAccount(appContext, {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await createUserAccount(appContext, {
    username: "chatter",
    role: "chatter",
  }, { source: "cli" });
  const issued = await issueChatterApiKey(appContext, { username: "chatter" }, { source: "cli" });
  chatterApiKey = issued.key;
  await insertAgentKey(testDb.db, {
    name: "slice-a",
    keyPrefix: AGENT_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(AGENT_TOKEN),
    capabilities: ["read:messages", "read:money", "read:datasets", "read:observations_envelope"],
    pageIds: [grantedPageId],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: owner?.id ?? null,
  });

  // The plane is OFF by default; every test that wants an answer turns it on.
  await setConfigOverride(testDb.db, {
    key: "agentReadPlaneMode",
    value: "full",
    userId: owner?.id ?? null,
    groupId: randomUUID(),
  });

  await server?.close();
  server = await buildApiServer(appContext);
  await server.ready();

  const login = await server.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "owner", password: "owner-secret" },
  });
  const setCookie = login.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  ownerCookie = String(raw ?? "").split(";")[0] ?? "";
  expect(ownerCookie).not.toBe("");
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function agentGet(url: string, token = AGENT_TOKEN) {
  return server!.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

async function setPlaneMode(mode: "off" | "read_only" | "full") {
  await setConfigOverride(testDb!.db, {
    key: "agentReadPlaneMode",
    value: mode,
    userId: null,
    groupId: randomUUID(),
  });
}

describe.each(POLICY_MODES)("[sync-critical] agent read plane isolation (%s)", (mode) => {
  policyMode = mode;
  beforeEach(() => {
    policyMode = mode;
  });

  it("an agent key is admitted on its own routes", async () => {
    const response = await agentGet("/api/v1/agent/capabilities");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.grant.pages.map((page: { pageLabel: string }) => page.pageLabel)).toEqual(["lora-2"]);
    // The DIFFERENCE is what an agent is allowed to know, and it is what lets
    // the person operations answer 200-empty instead of becoming an oracle.
    expect(body.grant.totalPages).toBe(2);
    expect(body.conclusion.blockers).toContain("claim_not_declared");
  });

  it("every agent response is no-store, errors included", async () => {
    const ok = await agentGet("/api/v1/agent/capabilities");
    expect(ok.headers["cache-control"]).toBe("no-store");
    const refused = await agentGet("/api/v1/agent/capabilities", "agency_hub_agent_nope");
    expect(refused.statusCode).toBe(401);
    expect(refused.headers["cache-control"]).toBe("no-store");
  });

  it("an agent key is refused on routes of kind `any`", async () => {
    // `any` used to be a wildcard; it is now an allowlist of the pre-agent
    // authentication methods, which is why these 26 routes stay closed.
    for (const url of ["/api/v1/auth/me", "/api/v1/pages", "/api/v1/pages/lora-2/fans"]) {
      const response = await agentGet(url);
      expect([401, 403], url).toContain(response.statusCode);
    }
  });

  it("an agent key is refused on the event streams (no SSE for agents)", async () => {
    for (const url of ["/api/v1/events/stream", "/api/v1/events/v2/stream"]) {
      const response = await agentGet(url);
      expect([401, 403], url).toContain(response.statusCode);
    }
  });

  it("an unauthenticated caller is refused on agent routes", async () => {
    const anonymous = await server!.inject({ method: "GET", url: "/api/v1/agent/capabilities" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("a REAL owner session is refused on every agentKey route", async () => {
    // Isolation is symmetric: the owner cookie opens the whole dashboard and none
    // of the agent plane. Asserted with a live session, not with a failed login.
    for (const url of [
      "/api/v1/agent/capabilities",
      "/api/v1/agent/threads",
      "/api/v1/agent/coverage?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z",
    ]) {
      const response = await server!.inject({
        method: "GET",
        url,
        headers: { cookie: ownerCookie },
      });
      expect([401, 403], url).toContain(response.statusCode);
    }
    // ... and the SAME cookie does reach the owner-session half of the plane, so
    // the refusals above are about the route kind and not a broken session.
    const payload = await server!.inject({
      method: "GET",
      url: "/api/v1/agent/observations/999999/payload?reason=isolation-check",
      headers: { cookie: ownerCookie },
    });
    expect([404, 503]).toContain(payload.statusCode);
  });

  it("the hydration family is isolated in BOTH directions (#11-#13)", async () => {
    // #13 and the owner approval queue are owner-session. The principal that
    // ASKS for the work is structurally not the principal that authorizes it, so
    // the key that can file a request cannot decide one — and cannot even see
    // the board.
    const decide = await server!.inject({
      method: "POST",
      url: `/api/v1/agent/hydration-requests/${randomUUID()}/decision`,
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: {
        decision: "approve",
        expectedVersion: 0,
        coverageFingerprint: "0".repeat(64),
        idempotencyKey: randomUUID(),
        maxCalls: 1,
        expiresAt: "2026-12-01T00:00:00Z",
        allowMarkReadSideEffect: false,
      },
    });
    expect([401, 403]).toContain(decide.statusCode);
    const queue = await agentGet("/api/v1/agent/hydration-requests");
    expect([401, 403]).toContain(queue.statusCode);

    // ... and symmetrically: the owner cookie opens the whole dashboard and
    // neither of the two agentKey hydration operations.
    const create = await server!.inject({
      method: "POST",
      url: "/api/v1/agent/pages/lora-2/threads/abc/hydration-requests",
      headers: { cookie: ownerCookie },
      payload: {
        target: { kind: "thread_backfill_before", beforeAt: "2026-02-01T00:00:00Z" },
        reason: "owner should not be able to file this",
        idempotencyKey: randomUUID(),
      },
    });
    expect([401, 403]).toContain(create.statusCode);
    const poll = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/hydration-requests/${randomUUID()}`,
      headers: { cookie: ownerCookie },
    });
    expect([401, 403]).toContain(poll.statusCode);
  });

  it("a REAL chatter api key is refused on every agentKey route", async () => {
    for (const url of ["/api/v1/agent/capabilities", "/api/v1/agent/threads"]) {
      const response = await server!.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${chatterApiKey}` },
      });
      expect([401, 403], url).toContain(response.statusCode);
    }
  });

  it("a revoked key is inert immediately", async () => {
    const before = await agentGet("/api/v1/agent/capabilities");
    expect(before.statusCode).toBe(200);
    const key = await findAgentKeyByDigest(testDb!.db, sha256Hex(AGENT_TOKEN));
    await revokeAgentKey(testDb!.db, { id: key!.id });
    const after = await agentGet("/api/v1/agent/capabilities");
    expect(after.statusCode).toBe(401);
  });

  it("an expired key is inert", async () => {
    const owner = await createUser(testDb!.db, {
      username: "owner-2",
      role: "owner",
      passwordHash: null,
    });
    const createdAt = new Date(Date.now() - 400 * DAY_MS);
    await insertAgentKey(testDb!.db, {
      name: "expired",
      keyPrefix: OTHER_TOKEN.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(OTHER_TOKEN),
      capabilities: ["read:messages"],
      pageIds: [grantedPageId],
      dailyRequestBudget: 10,
      dailyRowBudget: 10,
      expiresAt: new Date(createdAt.getTime() + 10 * DAY_MS),
      createdBy: owner?.id ?? null,
      createdAt,
    });
    const response = await agentGet("/api/v1/agent/capabilities", OTHER_TOKEN);
    expect(response.statusCode).toBe(401);
  });

  it("no existence oracle: out-of-grant and nonexistent pages answer BYTE-IDENTICALLY", async () => {
    const window = "from=2026-01-08T00:00:00Z&to=2026-01-20T00:00:00Z";
    const hidden = await agentGet(
      `/api/v1/agent/pages/${hiddenPageLabel}/threads/abc/messages?${window}`,
    );
    const missing = await agentGet(
      `/api/v1/agent/pages/no-such-page-at-all/threads/abc/messages?${window}`,
    );
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    // Byte for byte. A different `message` would put the oracle back through the
    // difference in wording.
    expect(hidden.body).toBe(missing.body);
  });

  it("the same holds for the dataset route", async () => {
    const body = {
      from: "2026-01-08T00:00:00Z",
      to: "2026-01-20T00:00:00Z",
      filters: [],
      sort: [],
      limit: 10,
    };
    const post = (label: string) => server!.inject({
      method: "POST",
      url: `/api/v1/agent/pages/${label}/datasets/fan_memberships/query`,
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: body,
    });
    const hidden = await post(hiddenPageLabel);
    const missing = await post("no-such-page-at-all");
    expect(hidden.statusCode).toBe(404);
    expect(missing.body).toBe(hidden.body);
  });

  it("a globally addressable fan answers 200-empty, never 404", async () => {
    const response = await agentGet("/api/v1/agent/people/fansly/438766025723355136");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.identity).toBeNull();
    // Mandatory even on the empty answer: this is the field that stops "no trace
    // of this person" from being reported as a fact.
    expect(body.capture.scopeNarrowing.keyGrantExcludedPages).toBe(1);
    expect(body.conclusion.blockers).toContain("key_grant_narrowed_scope");
  });

  it("an unknown platform is a boundary 400, not an oracle", async () => {
    const response = await agentGet("/api/v1/agent/people/myspace/1");
    expect(response.statusCode).toBe(400);
  });

  it("plane mode off answers 503 with the plane's own code", async () => {
    await setPlaneMode("off");
    const response = await agentGet("/api/v1/agent/capabilities");
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("agent_plane_disabled");
  });

  it("plane mode read_only serves but pins the conclusion false", async () => {
    await setPlaneMode("read_only");
    const response = await agentGet("/api/v1/agent/capabilities");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.contract.planeMode).toBe("read_only");
    expect(body.conclusion.blockers).toContain("read_only_mode");
  });

  it("observations stay 503 until their own flag is on", async () => {
    const window = "from=2026-07-06T00:00:00Z&to=2026-07-08T00:00:00Z";
    const off = await agentGet(`/api/v1/agent/observations?${window}`);
    expect(off.statusCode).toBe(503);
    await setConfigOverride(testDb!.db, {
      key: "agentObservationsEnabled",
      value: "true",
      userId: null,
      groupId: randomUUID(),
    });
    const on = await agentGet(`/api/v1/agent/observations?${window}`);
    expect(on.statusCode).toBe(200);
  });

  it("search answers 503 when its backend flag is off", async () => {
    await setConfigOverride(testDb!.db, {
      key: "agentSearchBackend",
      value: "off",
      userId: null,
      groupId: randomUUID(),
    });
    const response = await server!.inject({
      method: "POST",
      url: "/api/v1/agent/search/messages",
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { q: "custom", from: "2026-01-08T00:00:00Z", to: "2026-01-20T00:00:00Z" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("agent_plane_disabled");
  });

  it("a missing capability is a 403 with the plane's own code", async () => {
    const owner = await createUser(testDb!.db, {
      username: "owner-3",
      role: "owner",
      passwordHash: null,
    });
    const narrow = `${AGENT_KEY_TOKEN_PREFIX}narrow-key-token`;
    await insertAgentKey(testDb!.db, {
      name: "narrow",
      keyPrefix: narrow.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(narrow),
      capabilities: ["read:datasets"],
      pageIds: [grantedPageId],
      dailyRequestBudget: 100,
      dailyRowBudget: 100,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? null,
    });
    const response = await agentGet("/api/v1/agent/threads", narrow);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("agent_capability_missing");
  });

  it("a request budget refuses BEFORE the work, with the plane's 429", async () => {
    const owner = await createUser(testDb!.db, {
      username: "owner-4",
      role: "owner",
      passwordHash: null,
    });
    const broke = `${AGENT_KEY_TOKEN_PREFIX}broke-key-token`;
    await insertAgentKey(testDb!.db, {
      name: "broke",
      keyPrefix: broke.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
      keyDigest: sha256Hex(broke),
      capabilities: ["read:messages"],
      pageIds: [grantedPageId],
      dailyRequestBudget: 1,
      dailyRowBudget: 1,
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      createdBy: owner?.id ?? null,
    });
    const first = await agentGet("/api/v1/agent/capabilities", broke);
    expect(first.statusCode).toBe(200);
    const second = await agentGet("/api/v1/agent/capabilities", broke);
    expect(second.statusCode).toBe(429);
    // A real AppError with the plane's own code, not the shared login builder's
    // "Too many login attempts" (which the boundary would turn into a 500).
    expect(second.json().error).toBe("agent_budget_exhausted");
  });

  it("a malformed or foreign cursor is a 400, never an empty 200", async () => {
    const response = await agentGet("/api/v1/agent/threads?cursor=not-a-real-cursor");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("agent_cursor_invalid");
  });

  it("the coverage probe answers with journal facts and an honest conclusion", async () => {
    const response = await agentGet(
      "/api/v1/agent/coverage?from=2026-01-08T00:00:00Z&to=2026-01-20T00:00:00Z",
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([]);
    // The whole point: an empty collection arrives WITH capture and blockers.
    expect(body.capture.planes).not.toHaveLength(0);
    expect(body.conclusion.blockers.length).toBeGreaterThan(0);
    expect(body.journalFloor).toHaveProperty("observationsFirstReceivedAt");
  });

  it("a Fansly transcript read is empty AND unprovable, never a bare list", async () => {
    const response = await agentGet(
      "/api/v1/agent/pages/lora-2/threads/810272281019305984/messages"
      + "?from=2026-01-08T00:00:00Z&to=2026-01-20T00:00:00Z"
      + "&claimFields=textPlain&claimTargets=all_in_scope",
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([]);
    // Nothing was ever captured for this thread, so the floor is unknown and the
    // answer says so rather than returning a bare [].
    const archive = body.capture.planes.find(
      (plane: { plane: string }) => plane.plane === "message_archive",
    );
    expect(archive.captureFloor).toEqual({ at: null, kind: "unknown" });
    expect(body.conclusion.blockers).toContain("capture_floor_unknown");
  });
});

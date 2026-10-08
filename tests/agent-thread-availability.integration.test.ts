import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { agentThreadAvailabilityResponseSchema } from "@agency_hub_core/contracts";
import {
  createFanslyPage,
  createModel,
  insertAgentKey,
  setConfigOverride,
  type Database,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";
import { createClient } from "@kernel/sdk";

import { buildApiServer } from "../apps/runtime/src/api/server.ts";
import { AGENT_KEY_TOKEN_PREFIX, createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  HUB_THREAD_AVAILABILITY_NONE,
  HUB_THREAD_AVAILABILITY_UNKNOWN,
} from "../packages/hub-agent-cli/src/commands.ts";
import { HUB_EXIT_ERROR, HUB_EXIT_OK, runHubCli, type HubCliDeps } from "../packages/hub-agent-cli/src/main.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { seedWsThread } from "./helpers/fansly-ws-capture.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Fixture passwords hash at minimum cost (tests/helpers/cheap-argon2.ts).
vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

/**
 * `agentThreadAvailability` (arena "vanished chat", plan §5) against a real
 * database and the real server: a chat's open unavailability episode, or null
 * — "no open episode recorded", never "Fansly serves the chat".
 *
 *  - the page's grant like the transcript: a page outside it and a page that
 *    does not exist answer the same bytes, from the middleware and, in `log`
 *    mode, from the handler's own guard; `read:messages` is required;
 *  - a ref the granted page holds no thread for is the plane's static 404;
 *  - no episode, an ended one → null; a refusing and an established episode →
 *    their fields, `cause: unchecked`, the owner's note with its date;
 *  - every answer passes the strict contract, and the `hub` CLI reads it over
 *    a listening server — and tells a hub without the route (its router's 404)
 *    from the plane's 404.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MESSAGES = `${AGENT_KEY_TOKEN_PREFIX}availability-messages-token`;
const NO_MESSAGES = `${AGENT_KEY_TOKEN_PREFIX}availability-datasets-token`;

const GROUP = {
  none: "810272281019300001",
  established: "810272281019300002",
  refusing: "810272281019300003",
  ended: "810272281019300004",
  otherPage: "810272281019300005",
  unknown: "810272281019300099",
} as const;

const OPENED_AT = "2026-10-06T08:00:00.000Z";
const ESTABLISHED_AT = "2026-10-06T15:11:00.000Z";
const LAST_REFUSAL_AT = "2026-10-08T15:20:00.000Z";
const RETRY_NOT_BEFORE = "2026-10-09T15:20:00.000Z";
const NOTE = { text: "06.10: the profile does not open from lora-1", at: "2026-10-06T22:14:00.000Z" };

let testDb: StartedTestDatabase | null = null;
let server: Awaited<ReturnType<typeof buildApiServer>> | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function insertKey(token: string, capabilities: string[], pageIds: number[], ownerId: number) {
  await insertAgentKey(testDb!.db, {
    name: token.slice(AGENT_KEY_TOKEN_PREFIX.length),
    keyPrefix: token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(token),
    capabilities: capabilities as never,
    pageIds,
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
    createdBy: ownerId,
  });
}

/** An episode as the page's actor (and the owner's note) leaves it. */
async function episode(threadId: number, input: {
  state: "refusing" | "established";
  refusals: number;
  ended?: true;
  note?: { text: string; at: string };
}): Promise<void> {
  const established = input.state === "established";
  await testDb!.pool.query(
    `insert into page_dm_thread_unavailability (thread_id, state, opened_at, established_at, ended_at, end_reason, refusals,
            last_refusal_at, last_http_status, retry_not_before, first_attempt_id, last_attempt_id, first_observation_id,
            first_observation_received_at, last_observation_id, last_observation_received_at, owner_note, owner_note_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 500, $9, 41, 45, 901, $3, 905, $8, $10, $11)`,
    [
      threadId, input.state, OPENED_AT, established ? ESTABLISHED_AT : null,
      input.ended ? LAST_REFUSAL_AT : null, input.ended ? "read_served" : null, input.refusals, LAST_REFUSAL_AT,
      established ? RETRY_NOT_BEFORE : null, input.note?.text ?? null, input.note?.at ?? null,
    ],
  );
}

async function boot(authPolicyEnforcement: "enforce" | "log" = "enforce") {
  const appContext = createTestAppContext(testDb!, { authPolicyEnforcement });
  server = await buildApiServer(appContext);
  await server.ready();
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  const handles = { db: db(), pool: testDb.pool };
  const model = await createModel(db(), { slug: "lora", name: "Lora" });
  const granted = (await createFanslyPage(db(), { modelId: model!.id, label: "lora-1" }))!.id;
  const hidden = (await createFanslyPage(db(), { modelId: model!.id, label: "lora-2" }))!.id;

  await seedWsThread(handles, { pageId: granted, groupId: GROUP.none, fanRef: "200000000000000001" });
  await episode(await seedWsThread(handles, { pageId: granted, groupId: GROUP.established, fanRef: "200000000000000002" }), {
    state: "established", refusals: 8, note: NOTE,
  });
  await episode(await seedWsThread(handles, { pageId: granted, groupId: GROUP.refusing, fanRef: "200000000000000003" }), {
    state: "refusing", refusals: 2,
  });
  await episode(await seedWsThread(handles, { pageId: granted, groupId: GROUP.ended, fanRef: "200000000000000004" }), {
    state: "established", refusals: 5, ended: true,
  });
  // The other page's chat has an episode: its 404 is not "nothing there".
  await episode(await seedWsThread(handles, { pageId: hidden, groupId: GROUP.otherPage, fanRef: "200000000000000005" }), {
    state: "established", refusals: 6,
  });

  const owner = await createUserAccount(createTestAppContext(testDb), {
    username: "owner",
    role: "owner",
    password: "owner-secret",
  }, { source: "cli" });
  await insertKey(MESSAGES, ["read:messages"], [granted], owner!.id);
  await insertKey(NO_MESSAGES, ["read:datasets"], [granted], owner!.id);
  await setConfigOverride(testDb.db, { key: "agentReadPlaneMode", value: "full", userId: null, groupId: randomUUID() });
});

function availability(pageLabel: string, conversationRef: string, token = MESSAGES) {
  return server!.inject({
    method: "GET",
    url: `/api/v1/agent/pages/${pageLabel}/threads/${conversationRef}/availability`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("agentThreadAvailability over HTTP", () => {
  it("a chat with no episode, and one whose episode ended: null — no open episode recorded", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    for (const group of [GROUP.none, GROUP.ended]) {
      const response = await availability("lora-1", group);
      expect(response.statusCode, group).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const document = agentThreadAvailabilityResponseSchema.parse(response.json());
      expect(document.scope).toEqual({ pageLabel: "lora-1", platform: "fansly", conversationRef: group });
      expect(document.episode).toBeNull();
      expect(document.delivery).toMatchObject({ returned: 0, matchedInScope: { value: 0, exact: true }, nextCursor: null });
      // The engine's own record, not captured data: no plane, no floor.
      expect(document.conclusion.blockers).toContain("capture_floor_unknown");
    }
  });

  it("an established episode: its fields, cause unchecked, the owner's note with its date", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const response = await availability("lora-1", GROUP.established);
    expect(response.statusCode).toBe(200);
    const document = agentThreadAvailabilityResponseSchema.parse(response.json());
    expect(document.episode).toEqual({
      state: "established",
      openedAt: OPENED_AT,
      establishedAt: ESTABLISHED_AT,
      lastRefusalAt: LAST_REFUSAL_AT,
      refusals: 8,
      retryNotBefore: RETRY_NOT_BEFORE,
      ownerNote: NOTE,
      cause: "unchecked",
    });
    expect(document.delivery).toMatchObject({ returned: 1, matchedInScope: { value: 1, exact: true } });
    // The episode above is all of it (no evidence ids), and nothing of the fan.
    expect(response.body).not.toContain("200000000000000002");
  });

  it("a refusing episode: not established, no retry boundary, no note", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const document = agentThreadAvailabilityResponseSchema.parse((await availability("lora-1", GROUP.refusing)).json());
    expect(document.episode).toEqual({
      state: "refusing",
      openedAt: OPENED_AT,
      establishedAt: null,
      lastRefusalAt: LAST_REFUSAL_AT,
      refusals: 2,
      retryNotBefore: null,
      ownerNote: null,
      cause: "unchecked",
    });
  });

  it("a page the key may not read answers the bytes of a page that does not exist, by the middleware and by the handler", async (context) => {
    if (!testDb) return context.skip();
    for (const mode of ["enforce", "log"] as const) {
      await boot(mode);
      const hidden = await availability("lora-2", GROUP.otherPage);
      const missing = await availability("no-such-page-at-all", GROUP.otherPage);
      expect(hidden.statusCode, mode).toBe(404);
      expect(missing.statusCode, mode).toBe(404);
      expect(hidden.body, mode).toBe(missing.body);
      expect(hidden.json(), mode).toMatchObject({ error: "not_found" });
      await server!.close();
      server = null;
    }
  });

  it("a ref the granted page holds no thread for is the plane's static 404 (another page's chat included)", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const unknown = await availability("lora-1", GROUP.unknown);
    const elsewhere = await availability("lora-1", GROUP.otherPage);
    const hiddenPage = await availability("lora-2", GROUP.otherPage);
    expect(unknown.statusCode).toBe(404);
    expect(elsewhere.statusCode).toBe(404);
    expect(unknown.body).toBe(hiddenPage.body);
    expect(elsewhere.body).toBe(hiddenPage.body);
  });

  it("needs read:messages", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const response = await availability("lora-1", GROUP.established, NO_MESSAGES);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "agent_capability_missing" });
  });

  it("a path the hub has no route for is its router's 404, never the plane's not_found (what `hub` reads as an older hub)", async (context) => {
    if (!testDb) return context.skip();
    await boot();
    const response = await server!.inject({
      method: "GET",
      url: `/api/v1/agent/pages/lora-1/threads/${GROUP.established}/availability-in-a-later-build`,
      headers: { authorization: `Bearer ${MESSAGES}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not Found" });
  });
});

describe("hub thread-availability against the real hub", () => {
  async function listen(): Promise<string> {
    await boot();
    await server!.listen({ port: 0, host: "127.0.0.1" });
    const address = server!.server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    return `http://127.0.0.1:${address.port}`;
  }

  function hub(baseUrl: string, argv: string[], createHubClient?: HubCliDeps["createHubClient"]) {
    return runHubCli({
      argv,
      env: { HUB_AGENT_KEY: MESSAGES, HUB_BASE_URL: baseUrl },
      readFile: () => null,
      fileMode: () => null,
      ...(createHubClient === undefined ? {} : { createHubClient }),
    });
  }

  it("prints the validated answer and its note: an established episode, and a chat with none", async (context) => {
    if (!testDb) return context.skip();
    const baseUrl = await listen();
    const established = await hub(baseUrl, ["thread-availability", "--page-label", "lora-1", "--conversation", GROUP.established]);
    expect(established.exitCode, JSON.stringify(established.document)).toBe(HUB_EXIT_OK);
    expect(established.document).toMatchObject({
      ok: true,
      operation: "agentThreadAvailability",
      data: { episode: { state: "established", refusals: 8, cause: "unchecked", ownerNote: NOTE } },
    });
    expect(established.document.note).toContain(`established: Fansly does not serve this chat to the page since ${OPENED_AT}`);
    expect(established.document.note).toContain(NOTE.text);

    const none = await hub(baseUrl, ["thread-availability", "--page-label", "lora-1", "--conversation", GROUP.none]);
    expect(none.exitCode).toBe(HUB_EXIT_OK);
    expect(none.document).toMatchObject({ ok: true, note: HUB_THREAD_AVAILABILITY_NONE, data: { episode: null } });
  });

  it("a page or thread out of reach stays an error (exit 4)", async (context) => {
    if (!testDb) return context.skip();
    const baseUrl = await listen();
    for (const [page, group] of [["lora-2", GROUP.otherPage], ["lora-1", GROUP.unknown]] as const) {
      const result = await hub(baseUrl, ["thread-availability", "--page-label", page, "--conversation", group]);
      expect(result.exitCode, `${page} ${group}`).toBe(HUB_EXIT_ERROR);
      expect(result.document).toMatchObject({ ok: false, error: { status: 404, code: "not_found" } });
    }
  });

  it("a hub without the route: state unknown, exit 0", async (context) => {
    if (!testDb) return context.skip();
    const baseUrl = await listen();
    // A hub built before the route answers its path the way it answers any
    // path it has none for: the request is sent where this build has no route.
    const older: HubCliDeps["createHubClient"] = (input) => createClient({
      baseUrl: input.baseUrl,
      auth: { mode: "bearer", token: () => input.token },
      fetch: (url, init) => fetch(String(url).replace(/\/availability$/, "/availability-in-a-later-build"), init),
    });
    const result = await hub(baseUrl, ["thread-availability", "--page-label", "lora-1", "--conversation", GROUP.established], older);
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(result.document).toEqual({
      ok: true,
      operation: "agentThreadAvailability",
      exitCode: HUB_EXIT_OK,
      blockers: [],
      note: HUB_THREAD_AVAILABILITY_UNKNOWN,
      data: null,
    });
  });
});

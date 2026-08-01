import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_KEY_MAX_LIFETIME_DAYS,
  AGENT_KEY_SLIDING_TTL_DAYS,
  createUser,
  findAgentKeyByDigest,
  insertAgentKey,
  revokeAgentKey,
} from "@agency_hub_core/db";
import { sha256Hex } from "@agency_hub_core/shared";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  AGENT_KEY_TOKEN_PREFIX,
  authenticateAgentKey,
  authenticateBearerToken,
  isAgentPrincipal,
} from "../apps/runtime/src/services/auth.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Agent Read Plane slice 0b: the authenticator over slice 0a's key table.
// Everything asserted here is a refusal property except the happy path — a key
// that is revoked, expired or simply unknown must produce no principal AND no
// write that would extend its life.

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  if (testDb) {
    appContext = createTestAppContext(testDb);
  }
}, 180_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
});

async function issueKey(input: {
  token: string;
  name?: string;
  pageIds?: number[];
  capabilities?: string[];
  createdAt?: Date;
  expiresAt?: Date;
}) {
  const owner = await createUser(testDb!.db, {
    username: `owner-${Math.random().toString(36).slice(2, 8)}`,
    role: "owner",
    passwordHash: null,
  });
  const createdAt = input.createdAt ?? new Date();
  return insertAgentKey(testDb!.db, {
    name: input.name ?? `key-${Math.random().toString(36).slice(2, 10)}`,
    keyPrefix: input.token.slice(0, AGENT_KEY_TOKEN_PREFIX.length + 6),
    keyDigest: sha256Hex(input.token),
    capabilities: input.capabilities ?? ["read:messages", "read:money"],
    pageIds: input.pageIds ?? [4, 5],
    dailyRequestBudget: 5000,
    dailyRowBudget: 500_000,
    expiresAt: input.expiresAt ?? new Date(createdAt.getTime() + 30 * DAY_MS),
    createdBy: owner?.id ?? null,
    createdAt,
  });
}

async function keyRow(id: number) {
  const result = await testDb!.pool.query<{
    expires_at: Date;
    last_used_at: Date | null;
  }>("select expires_at, last_used_at from agent_keys where id = $1", [id]);
  return result.rows[0]!;
}

describe("authenticateAgentKey", () => {
  it("resolves a live key into an agent principal with no human user", async () => {
    const token = `${AGENT_KEY_TOKEN_PREFIX}live0000000000000000`;
    const key = await issueKey({ token, name: "analyst", pageIds: [4, 5] });

    const principal = await authenticateAgentKey(appContext, token);

    expect(principal).toEqual({
      kind: "agent",
      authMethod: "agent_key",
      agentKeyId: key.id,
      keyName: "analyst",
      capabilities: ["read:messages", "read:money"],
      pageIds: [4, 5],
    });
    // The whole point of the variant: there is no user object to borrow.
    expect(principal && "user" in principal).toBe(false);
    expect(principal && isAgentPrincipal(principal)).toBe(true);
  });

  it("refuses an unknown digest", async () => {
    await expect(
      authenticateAgentKey(appContext, `${AGENT_KEY_TOKEN_PREFIX}nosuchkey00000000000`),
    ).resolves.toBeNull();
  });

  it("refuses a revoked key without stamping it", async () => {
    const token = `${AGENT_KEY_TOKEN_PREFIX}revoked00000000000000`;
    const key = await issueKey({ token });
    await revokeAgentKey(testDb!.db, { id: key.id });
    const before = await keyRow(key.id);

    await expect(authenticateAgentKey(appContext, token)).resolves.toBeNull();

    const after = await keyRow(key.id);
    expect(after.last_used_at).toBeNull();
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
  });

  it("refuses an expired key and never resurrects its expiry", async () => {
    const token = `${AGENT_KEY_TOKEN_PREFIX}expired00000000000000`;
    const createdAt = new Date(Date.now() - 100 * DAY_MS);
    const key = await issueKey({
      token,
      createdAt,
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    const before = await keyRow(key.id);

    await expect(authenticateAgentKey(appContext, token)).resolves.toBeNull();

    const after = await keyRow(key.id);
    expect(after.last_used_at).toBeNull();
    expect(after.expires_at.getTime()).toBe(before.expires_at.getTime());
  });

  it("slides the expiry on use and clamps it at the hard ceiling", async () => {
    const token = `${AGENT_KEY_TOKEN_PREFIX}sliding00000000000000`;
    const key = await issueKey({ token });
    const before = await keyRow(key.id);

    await expect(authenticateAgentKey(appContext, token)).resolves.not.toBeNull();

    const after = await keyRow(key.id);
    expect(after.last_used_at).not.toBeNull();
    const slid = Date.now() + AGENT_KEY_SLIDING_TTL_DAYS * DAY_MS;
    expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());
    expect(Math.abs(after.expires_at.getTime() - slid)).toBeLessThan(60_000);

    // A key near the end of its 365-day life slides only up to the ceiling.
    const oldToken = `${AGENT_KEY_TOKEN_PREFIX}oldkey000000000000000`;
    const oldCreatedAt = new Date(Date.now() - 350 * DAY_MS);
    const oldKey = await issueKey({
      token: oldToken,
      createdAt: oldCreatedAt,
      expiresAt: new Date(Date.now() + 5 * DAY_MS),
    });
    await expect(authenticateAgentKey(appContext, oldToken)).resolves.not.toBeNull();
    const ceiling = oldCreatedAt.getTime() + AGENT_KEY_MAX_LIFETIME_DAYS * DAY_MS;
    const slidOld = await keyRow(oldKey.id);
    expect(slidOld.expires_at.getTime()).toBeLessThanOrEqual(ceiling + 1000);
    expect(slidOld.expires_at.getTime()).toBeLessThan(slid);
  });
});

describe("authenticateBearerToken prefix routing", () => {
  it("routes an agent-prefixed token to the agent lane, never to the api-key lane", async () => {
    const token = `${AGENT_KEY_TOKEN_PREFIX}routed000000000000000`;
    await issueKey({ token });

    const principal = await authenticateBearerToken(appContext, token);
    expect(principal && isAgentPrincipal(principal)).toBe(true);

    // The api-key lane must not see this digest at all: nothing was written to
    // api_keys, and a same-digest lookup there finds nothing.
    const apiKeys = await testDb!.pool.query(
      "select 1 from api_keys where token_digest = $1",
      [sha256Hex(token)],
    );
    expect(apiKeys.rows).toHaveLength(0);
    expect(await findAgentKeyByDigest(testDb!.db, sha256Hex(token))).not.toBeNull();
  });

  it("does not treat a legacy bearer as an agent key", async () => {
    const principal = await authenticateBearerToken(appContext, "agency_hub_core_unknownkey");
    expect(principal).toBeNull();
  });
});

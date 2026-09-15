import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockDb = {
  failAudit: boolean;
};

const repoMocks = vi.hoisted(() => ({
  assignUserToPage: vi.fn(),
  createApiKey: vi.fn(),
  createAuthSession: vi.fn(),
  createUser: vi.fn(),
  deleteExpiredAuthSessions: vi.fn(),
  findActiveApiKeysForUser: vi.fn(),
  findApiKeyByDigest: vi.fn(),
  findAuthSessionByDigest: vi.fn(),
  findPageSummaryByLabel: vi.fn(),
  findUserById: vi.fn(),
  findUserByUsername: vi.fn(),
  insertAuditEvent: vi.fn(),
  insertObservation: vi.fn(),
  listApiKeys: vi.fn(),
  listUserPageAssignments: vi.fn(),
  listUsers: vi.fn(),
  lockUserForDeviceTokenMutation: vi.fn(),
  revokeApiKeysByIds: vi.fn(),
  revokeApiKeysForUser: vi.fn(),
  revokeAuthSession: vi.fn(),
  revokeAuthSessionsForUser: vi.fn(),
  touchApiKey: vi.fn(),
  touchAuthSession: vi.fn(),
  unassignUserFromPage: vi.fn(),
  updateUserPasswordHash: vi.fn(),
}));

const argon2Mocks = vi.hoisted(() => ({
  hash: vi.fn(async () => "hashed-secret"),
  verify: vi.fn(async () => false),
}));

vi.mock("@agency_hub_core/db", () => repoMocks);
vi.mock("argon2", () => ({
  default: {
    argon2id: "argon2id",
    hash: argon2Mocks.hash,
    verify: argon2Mocks.verify,
  },
}));

import { loginWithPassword } from "../apps/runtime/src/services/auth.ts";

beforeEach(() => {
  for (const mock of Object.values(repoMocks)) {
    mock.mockReset();
  }
  argon2Mocks.hash.mockClear();
  argon2Mocks.verify.mockClear();
  argon2Mocks.verify.mockResolvedValue(false);
  repoMocks.listUserPageAssignments.mockResolvedValue([]);
  repoMocks.insertAuditEvent.mockImplementation(async (db: MockDb) => {
    if (db.failAudit) {
      throw new Error("audit failed");
    }

    return {
      id: 1,
      eventType: "auth.login_failed",
    };
  });
});

describe("loginWithPassword", () => {
  it("keeps the unauthorized response when unknown-user login auditing fails", async () => {
    repoMocks.findUserByUsername.mockResolvedValue(null);
    const logger = { warn: vi.fn() };

    await expect(loginWithPassword({
      db: { failAudit: true },
      logger,
    } as never, {
      username: "ghost",
      password: "wrong",
    })).rejects.toMatchObject({
      message: "Invalid username or password",
      statusCode: 401,
    });

    expect(repoMocks.insertAuditEvent).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      username: "ghost",
      targetUserId: null,
    }), "Failed-login audit insert failed; continuing with unauthorized response");
  });

  it("keeps the unauthorized response when bad-password auditing fails", async () => {
    repoMocks.findUserByUsername.mockResolvedValue({
      id: 7,
      username: "dima",
      role: "owner",
      passwordHash: "hashed-password",
    });
    argon2Mocks.verify.mockResolvedValue(false);
    const logger = { warn: vi.fn() };

    await expect(loginWithPassword({
      db: { failAudit: true },
      logger,
    } as never, {
      username: "dima",
      password: "wrong",
    })).rejects.toMatchObject({
      message: "Invalid username or password",
      statusCode: 401,
    });

    expect(argon2Mocks.verify).toHaveBeenCalledWith("hashed-password", "wrong");
    expect(repoMocks.insertAuditEvent).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      username: "dima",
      targetUserId: 7,
    }), "Failed-login audit insert failed; continuing with unauthorized response");
  });
});

describe("per-account login backoff (audit B7)", () => {
  // The backoff registry is keyed per AppContext, so each test shares one
  // app object across attempts and gets isolated state from its neighbours.
  function makeApp() {
    return {
      db: { failAudit: false },
      logger: { warn: vi.fn() },
      config: { sessionTtlDays: 30 },
    } as never;
  }

  const failedAttempt = (app: never, username: string, password = "wrong") =>
    loginWithPassword(app, { username, password });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-13T12:00:00.000Z"));
    repoMocks.findUserByUsername.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks an account after five consecutive failures without touching the db", async () => {
    const app = makeApp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });
    }
    expect(repoMocks.findUserByUsername).toHaveBeenCalledTimes(5);

    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({
      statusCode: 429,
      message: "Too many login attempts",
    });
    // The locked attempt is rejected before any user lookup, so the fast
    // path leaks no timing signal and costs no argon2 work.
    expect(repoMocks.findUserByUsername).toHaveBeenCalledTimes(5);
  });

  it("keys the backoff on the normalized username", async () => {
    const app = makeApp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failedAttempt(app, "Ghost")).rejects.toMatchObject({ statusCode: 401 });
    }

    await expect(failedAttempt(app, "  GHOST ")).rejects.toMatchObject({ statusCode: 429 });
    await expect(failedAttempt(app, "other")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("releases the lock after the backoff window and escalates on repeat failures", async () => {
    const app = makeApp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 429 });

    // First lock is 30s; afterwards the next failure earns a 60s lock.
    vi.advanceTimersByTime(30_000);
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });

    vi.advanceTimersByTime(30_000);
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 429 });

    vi.advanceTimersByTime(30_000);
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("forgets stale failures after the forget window", async () => {
    const app = makeApp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 429 });

    vi.advanceTimersByTime(30 * 60_000);
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });
    // Counter restarted: still in the free-failure band, no lock yet.
    await expect(failedAttempt(app, "ghost")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("clears the counter on a successful login", async () => {
    const app = makeApp();
    const user = {
      id: 7,
      username: "dima",
      role: "owner",
      passwordHash: "hashed-password",
    };

    repoMocks.findUserByUsername.mockResolvedValue(user);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(failedAttempt(app, "dima")).rejects.toMatchObject({ statusCode: 401 });
    }

    argon2Mocks.verify.mockResolvedValue(true);
    repoMocks.createAuthSession.mockResolvedValue({ id: 1 });
    repoMocks.findUserById.mockResolvedValue(user);
    // Decision 349 §4.3: the session is created only after the user row is
    // re-read under the lock and still carries the verified authority.
    repoMocks.lockUserForDeviceTokenMutation.mockResolvedValue(user);
    const success = await loginWithPassword(app, { username: "dima", password: "right" });
    expect(success.authMethod).toBe("session");

    // The failure streak restarts from zero: five more are free again.
    argon2Mocks.verify.mockResolvedValue(false);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(failedAttempt(app, "dima")).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(failedAttempt(app, "dima")).rejects.toMatchObject({ statusCode: 429 });
  });
});

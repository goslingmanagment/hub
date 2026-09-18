import { beforeEach, describe, expect, it, vi } from "vitest";

type MockState = {
  users: Array<{
    id: number;
    username: string;
    role: "owner" | "team_lead" | "chatter";
    passwordHash: string | null;
  }>;
  authSessions: Array<{
    id: number;
    userId: number;
    revokedAt: Date | null;
    revokedReason: string | null;
  }>;
  auditEvents: Array<{
    eventType: string;
    targetUserId: number | null;
    metadata: Record<string, unknown>;
  }>;
};

type MockDb = {
  state: MockState;
  failAudit: boolean;
  transaction: <T>(callback: (tx: MockDb) => Promise<T>) => Promise<T>;
};

const repoMocks = vi.hoisted(() => ({
  assignUserToPage: vi.fn(),
  advanceDeviceTokenEpoch: vi.fn(),
  insertAccessGrant: vi.fn(),
  revokeAccessGrants: vi.fn(),
  updateUserMustChangePassword: vi.fn(),
  createApiKey: vi.fn(),
  createAuthSession: vi.fn(),
  createUser: vi.fn(),
  deleteExpiredAuthSessions: vi.fn(),
  deletePendingDeviceTokensForUser: vi.fn(),
  findActiveApiKeysForUser: vi.fn(),
  findApiKeyByDigest: vi.fn(),
  findAuthSessionByDigest: vi.fn(),
  findPageSummaryByLabel: vi.fn(),
  findUserById: vi.fn(),
  findUserByUsername: vi.fn(),
  insertAuditEvent: vi.fn(),
  listApiKeys: vi.fn(),
  listUserPageAssignments: vi.fn(),
  listUsers: vi.fn(),
  lockUserForDeviceTokenMutation: vi.fn(),
  revokeActiveAccountLinks: vi.fn(),
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
}));

vi.mock("@agency_hub_core/db", () => repoMocks);
vi.mock("argon2", () => ({
  default: {
    argon2id: "argon2id",
    hash: argon2Mocks.hash,
  },
}));

import { setUserPassword } from "../apps/runtime/src/services/auth.ts";

function createMockDb(initialState: MockState, failAudit = false): MockDb {
  const db: MockDb = {
    state: structuredClone(initialState),
    failAudit,
    async transaction<T>(callback: (tx: MockDb) => Promise<T>) {
      const tx: MockDb = {
        state: structuredClone(db.state),
        failAudit: db.failAudit,
        transaction: db.transaction,
      };

      const result = await callback(tx);
      db.state = tx.state;
      return result;
    },
  };

  return db;
}

beforeEach(() => {
  for (const mock of Object.values(repoMocks)) {
    mock.mockReset();
  }
  argon2Mocks.hash.mockClear();
  argon2Mocks.hash.mockResolvedValue("hashed-secret");

  repoMocks.findUserByUsername.mockImplementation(async (db: MockDb, username: string) =>
    db.state.users.find((user) => user.username === username) ?? null);
  repoMocks.findUserById.mockImplementation(async (db: MockDb, userId: number) =>
    db.state.users.find((user) => user.id === userId) ?? null);
  repoMocks.lockUserForDeviceTokenMutation.mockImplementation(async (db: MockDb, userId: number) =>
    db.state.users.find((user) => user.id === userId) ?? null);
  repoMocks.advanceDeviceTokenEpoch.mockResolvedValue({ deviceTokenEpoch: 1 });
  repoMocks.deletePendingDeviceTokensForUser.mockResolvedValue([]);
  repoMocks.revokeActiveAccountLinks.mockResolvedValue([]);
  repoMocks.updateUserPasswordHash.mockImplementation(async (db: MockDb, userId: number, passwordHash: string) => {
    const user = db.state.users.find((entry) => entry.id === userId) ?? null;
    if (user) {
      user.passwordHash = passwordHash;
    }
    return user;
  });
  repoMocks.revokeAuthSessionsForUser.mockImplementation(
    async (db: MockDb, userId: number, revokedReason: string | null) => {
      const revokedAt = new Date("2026-03-22T10:00:00.000Z");
      const revoked = db.state.authSessions.filter((session) => session.userId === userId && session.revokedAt === null);
      for (const session of revoked) {
        session.revokedAt = revokedAt;
        session.revokedReason = revokedReason;
      }
      return revoked;
    },
  );
  repoMocks.insertAuditEvent.mockImplementation(async (db: MockDb, input: {
    eventType: string;
    targetUserId?: number | null;
    metadata?: Record<string, unknown>;
  }) => {
    if (db.failAudit) {
      throw new Error("audit failed");
    }

    db.state.auditEvents.push({
      eventType: input.eventType,
      targetUserId: input.targetUserId ?? null,
      metadata: input.metadata ?? {},
    });
    return db.state.auditEvents.at(-1) ?? null;
  });
});

describe("password reset transactions", () => {
  it("rolls back password resets when audit logging fails", async () => {
    const db = createMockDb({
      users: [{
        id: 1,
        username: "dima",
        role: "owner",
        passwordHash: "old-hash",
      }],
      authSessions: [{
        id: 10,
        userId: 1,
        revokedAt: null,
        revokedReason: null,
      }],
      auditEvents: [],
    }, true);

    await expect(setUserPassword({ db } as never, {
      userId: 1,
      password: "owner-secret-2",
    }, { source: "cli" })).rejects.toThrow("audit failed");

    expect(db.state.users[0]?.passwordHash).toBe("old-hash");
    expect(db.state.authSessions[0]?.revokedAt).toBeNull();
    expect(db.state.auditEvents).toEqual([]);
  });
});

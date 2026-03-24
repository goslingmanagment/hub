import { beforeEach, describe, expect, it, vi } from "vitest";

type MockState = {
  users: Array<{
    id: number;
    username: string;
    role: "owner" | "team_lead" | "chatter";
    passwordHash: string | null;
  }>;
  pages: Array<{
    id: number;
    label: string;
  }>;
  apiKeys: Array<{
    id: number;
    userId: number;
    keyPrefix: string;
    tokenDigest: string;
    revokedAt: Date | null;
    revokedReason: string | null;
  }>;
  assignments: Array<{
    userId: number;
    platformAccountId: number;
  }>;
  auditEvents: Array<{
    eventType: string;
    targetUserId: number | null;
    platformAccountId: number | null;
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
  listApiKeys: vi.fn(),
  listUserPageAssignments: vi.fn(),
  listUsers: vi.fn(),
  revokeApiKeysByIds: vi.fn(),
  revokeApiKeysForUser: vi.fn(),
  revokeAuthSession: vi.fn(),
  revokeAuthSessionsForUser: vi.fn(),
  touchApiKey: vi.fn(),
  touchAuthSession: vi.fn(),
  unassignUserFromPage: vi.fn(),
  updateUserPasswordHash: vi.fn(),
}));

vi.mock("@agency_hub_core/db", () => repoMocks);

import { issueChatterApiKey } from "../apps/runtime/src/services/auth.ts";

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

  repoMocks.findUserByUsername.mockImplementation(async (db: MockDb, username: string) =>
    db.state.users.find((user) => user.username === username) ?? null);
  repoMocks.findUserById.mockImplementation(async (db: MockDb, userId: number) =>
    db.state.users.find((user) => user.id === userId) ?? null);
  repoMocks.findPageSummaryByLabel.mockImplementation(async (db: MockDb, label: string) =>
    db.state.pages.find((page) => page.label === label) ?? null);
  repoMocks.listUserPageAssignments.mockImplementation(async (db: MockDb, userId: number) =>
    db.state.assignments
      .filter((assignment) => assignment.userId === userId)
      .map((assignment) => ({
        pageId: assignment.platformAccountId,
        label: db.state.pages.find((page) => page.id === assignment.platformAccountId)?.label ?? "unknown",
        platform: "fansly" as const,
        modelSlug: "mock-model",
        modelName: "Mock Model",
      })));
  repoMocks.assignUserToPage.mockImplementation(async (db: MockDb, userId: number, platformAccountId: number) => {
    const existing = db.state.assignments.find((assignment) =>
      assignment.userId === userId && assignment.platformAccountId === platformAccountId);
    if (existing) {
      return existing;
    }

    const assignment = {
      userId,
      platformAccountId,
    };
    db.state.assignments.push(assignment);
    return assignment;
  });
  repoMocks.findActiveApiKeysForUser.mockImplementation(async (db: MockDb, userId: number) =>
    db.state.apiKeys.filter((apiKey) => apiKey.userId === userId && apiKey.revokedAt === null));
  repoMocks.createApiKey.mockImplementation(async (db: MockDb, input: {
    userId: number;
    keyPrefix: string;
    tokenDigest: string;
  }) => {
    const created = {
      id: db.state.apiKeys.reduce((maxId, apiKey) => Math.max(maxId, apiKey.id), 0) + 1,
      userId: input.userId,
      keyPrefix: input.keyPrefix,
      tokenDigest: input.tokenDigest,
      revokedAt: null,
      revokedReason: null,
    };
    db.state.apiKeys.push(created);
    return created;
  });
  repoMocks.revokeApiKeysByIds.mockImplementation(
    async (db: MockDb, apiKeyIds: number[], revokedReason: string | null) => {
      const revokedAt = new Date("2026-03-22T10:05:00.000Z");
      const revoked = db.state.apiKeys.filter((apiKey) =>
        apiKeyIds.includes(apiKey.id) && apiKey.revokedAt === null);
      for (const apiKey of revoked) {
        apiKey.revokedAt = revokedAt;
        apiKey.revokedReason = revokedReason;
      }
      return revoked;
    },
  );
  repoMocks.insertAuditEvent.mockImplementation(async (db: MockDb, input: {
    eventType: string;
    targetUserId?: number | null;
    platformAccountId?: number | null;
    metadata?: Record<string, unknown>;
  }) => {
    if (db.failAudit) {
      throw new Error("audit failed");
    }

    db.state.auditEvents.push({
      eventType: input.eventType,
      targetUserId: input.targetUserId ?? null,
      platformAccountId: input.platformAccountId ?? null,
      metadata: input.metadata ?? {},
    });
    return db.state.auditEvents.at(-1) ?? null;
  });
});

describe("API key rotation transactions", () => {
  it("keeps the replacement API key active while revoking prior keys", async () => {
    const db = createMockDb({
      users: [{
        id: 2,
        username: "anton",
        role: "chatter",
        passwordHash: null,
      }],
      pages: [{
        id: 55,
        label: "lana",
      }],
      apiKeys: [{
        id: 9,
        userId: 2,
        keyPrefix: "agency_hub_core_old",
        tokenDigest: "old-digest",
        revokedAt: null,
        revokedReason: null,
      }],
      assignments: [],
      auditEvents: [],
    });

    const result = await issueChatterApiKey({ db } as never, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" });

    expect(result.key).toMatch(/^agency_hub_core_/);
    expect(db.state.assignments).toEqual([{
      userId: 2,
      platformAccountId: 55,
    }]);
    expect(db.state.apiKeys).toHaveLength(2);
    expect(db.state.apiKeys.find((apiKey) => apiKey.id === 9)?.revokedAt).not.toBeNull();
    const replacementKey = db.state.apiKeys.find((apiKey) => apiKey.id !== 9);
    expect(replacementKey?.revokedAt).toBeNull();
    expect(replacementKey?.keyPrefix).toBe(result.keyPrefix);
    expect(result.assignedPages).toEqual([{
      id: 55,
      label: "lana",
      platform: "fansly",
      modelSlug: "mock-model",
      modelName: "Mock Model",
    }]);
    expect(db.state.auditEvents).toEqual([expect.objectContaining({
      eventType: "api_key.issued",
      targetUserId: 2,
      platformAccountId: 55,
      metadata: expect.objectContaining({
        rotatedKeys: 1,
      }),
    })]);
  });

  it("rolls back API key rotation when audit logging fails", async () => {
    const db = createMockDb({
      users: [{
        id: 2,
        username: "anton",
        role: "chatter",
        passwordHash: null,
      }],
      pages: [{
        id: 55,
        label: "lana",
      }],
      apiKeys: [{
        id: 9,
        userId: 2,
        keyPrefix: "agency_hub_core_old",
        tokenDigest: "old-digest",
        revokedAt: null,
        revokedReason: null,
      }],
      assignments: [],
      auditEvents: [],
    }, true);

    await expect(issueChatterApiKey({ db } as never, {
      username: "anton",
      pageLabel: "lana",
    }, { source: "cli" })).rejects.toThrow("audit failed");

    expect(db.state.assignments).toEqual([]);
    expect(db.state.apiKeys).toEqual([{
      id: 9,
      userId: 2,
      keyPrefix: "agency_hub_core_old",
      tokenDigest: "old-digest",
      revokedAt: null,
      revokedReason: null,
    }]);
    expect(db.state.auditEvents).toEqual([]);
  });
});

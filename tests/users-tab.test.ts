import { describe, expect, it, vi } from "vitest";

import { findAdminUserByUsername, provisionChatter } from "../apps/dashboard/src/pages/settings/UsersTab.tsx";

describe("findAdminUserByUsername", () => {
  it("returns the latest user record for modal-backed settings flows", () => {
    const staleUser = {
      id: 7,
      username: "anton",
      role: "chatter" as const,
      mustChangePassword: false,
      assignedPages: [],
      apiKeyStatus: null,
    };
    const refreshedUser = {
      ...staleUser,
      assignedPages: [{
        id: 11,
        label: "lana",
        platform: "fansly" as const,
        modelSlug: "lana",
        modelName: "Lana",
      }],
      apiKeyStatus: {
        activeKeyPrefix: "agency_hub",
        activeKeyCount: 1,
        activeKeyCreatedAt: "2026-03-24T00:00:00.000Z",
        activeKeyLastUsedAt: "2026-03-24T00:05:00.000Z",
      },
    };

    expect(findAdminUserByUsername([refreshedUser], staleUser.username)).toEqual(refreshedUser);
  });

  it("returns null when the target user is no longer present", () => {
    expect(findAdminUserByUsername([], "missing")).toBeNull();
  });
});

// #116 chatter provisioning orchestration (review R3-7): create → optional
// password → optional page assign, with the idempotent partial-retry guard.
describe("provisionChatter", () => {
  function deps() {
    return {
      createUser: vi.fn(async () => {}),
      onUserCreated: vi.fn(),
      setPassword: vi.fn(async () => {}),
      assignPage: vi.fn(async () => {}),
    };
  }

  it("runs create → password → assign for a full submission", async () => {
    const d = deps();
    await provisionChatter({
      username: " alice ",
      password: "hunter2!",
      pageLabel: "p1",
      createdUsername: null,
      ...d,
    });
    expect(d.createUser).toHaveBeenCalledWith("alice");
    expect(d.onUserCreated).toHaveBeenCalledWith("alice");
    expect(d.setPassword).toHaveBeenCalledWith("hunter2!");
    expect(d.assignPage).toHaveBeenCalledWith("p1");
  });

  it("retry after a failed later step does not recreate the user (#116 idempotent retry)", async () => {
    const d = deps();
    d.setPassword.mockRejectedValueOnce(new Error("boom"));
    await expect(
      provisionChatter({
        username: "alice",
        password: "hunter2!",
        pageLabel: "",
        createdUsername: null,
        ...d,
      }),
    ).rejects.toThrow("boom");
    expect(d.createUser).toHaveBeenCalledTimes(1);
    expect(d.onUserCreated).toHaveBeenCalledWith("alice");

    // The component feeds the recorded username back on retry.
    await provisionChatter({
      username: "alice",
      password: "hunter2!",
      pageLabel: "",
      createdUsername: "alice",
      ...d,
    });
    expect(d.createUser).toHaveBeenCalledTimes(1); // not recreated
    expect(d.setPassword).toHaveBeenCalledTimes(2); // idempotent server-side set retried
  });

  it("skips password and page steps when blank", async () => {
    const d = deps();
    await provisionChatter({
      username: "bob",
      password: "",
      pageLabel: "",
      createdUsername: null,
      ...d,
    });
    expect(d.createUser).toHaveBeenCalledWith("bob");
    expect(d.setPassword).not.toHaveBeenCalled();
    expect(d.assignPage).not.toHaveBeenCalled();
  });
});

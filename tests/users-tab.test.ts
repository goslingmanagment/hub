import { describe, expect, it } from "vitest";

import { findAdminUserByUsername } from "../apps/dashboard/src/pages/settings/UsersTab.tsx";

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

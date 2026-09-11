import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import type { AdminUser } from "@agency_hub_core/contracts";

const queryMocks = vi.hoisted(() => ({ useAdminUsers: vi.fn() }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({ ...queryMocks, useIssuedUserApiKeys: () => ({ issued: [], pending: false, acknowledge: vi.fn() }) }));

import { UsersTab } from "../apps/dashboard/src/pages/settings/UsersTab.tsx";

function renderUsers(data: AdminUser[] | undefined, isError = false) {
  queryMocks.useAdminUsers.mockReturnValue({
    data,
    isLoading: false,
    isError,
    error: isError ? new Error("Connection interrupted") : null,
    isFetching: false,
    refetch: vi.fn(),
  });
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(UsersTab)));
}

describe("users catalog loading failures", () => {
  it("shows an error and retry instead of an empty team when the first request fails", () => {
    const markup = renderUsers(undefined, true);
    expect(markup).toContain("Не удалось загрузить команду");
    expect(markup).toContain("Connection interrupted");
    expect(markup).toContain("Повторить");
    expect(markup).not.toContain("В команде пока нет участников");
  });

  it("keeps the last successful users visible with a stale notice when refresh fails", () => {
    const owner: AdminUser = {
      id: 1,
      username: "dmitriy",
      role: "owner",
      mustChangePassword: false,
      assignedPages: [],
      apiKeyStatus: null,
      disabledAt: null,
      lastActiveAt: null,
    };
    const markup = renderUsers([owner], true);
    expect(markup).toContain("dmitriy");
    expect(markup).toContain("Показан последний загруженный список");
    expect(markup).toContain("Connection interrupted");
    expect(markup).toContain("Повторить");
    expect(markup).not.toContain("Не удалось загрузить команду");
  });

  it("shows the empty team only after a successful empty response", () => {
    const markup = renderUsers([]);
    expect(markup).toContain("В команде пока нет участников");
    expect(markup).not.toContain("Не удалось загрузить команду");
    expect(markup).not.toContain("Показан последний загруженный список");
  });
});

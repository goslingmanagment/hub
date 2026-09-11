import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminUser } from "@agency_hub_core/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  useAdminLogs: vi.fn(), useAdminQueueJobs: vi.fn(), useAdminIncidents: vi.fn(),
  useAdminPages: vi.fn(), useAdminUserApiKeys: vi.fn(), useAdminAssignPage: vi.fn(),
  useAdminUnassignPage: vi.fn(), useAdminSetPassword: vi.fn(), useAgentKeys: vi.fn(),
  useCreateAgentKey: vi.fn(), useRevokeAgentKey: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);

import { LogPage } from "../apps/dashboard/src/pages/dev/LogPage.tsx";
import { QueuePage } from "../apps/dashboard/src/pages/dev/QueuePage.tsx";
import { IncidentsPage } from "../apps/dashboard/src/pages/dev/IncidentsPage.tsx";
import { ChatterDetailModal } from "../apps/dashboard/src/pages/settings/UsersTab.tsx";
import { CreateAgentKeyModal } from "../apps/dashboard/src/pages/settings/AgentKeysTab.tsx";
import { UserPageAssignmentModal } from "../apps/dashboard/src/pages/settings/UserPageAssignmentModal.tsx";

const user: AdminUser = {
  id: 7, username: "anton", role: "chatter", mustChangePassword: false,
  assignedPages: [], apiKeyStatus: null, disabledAt: null, lastActiveAt: null,
};

function query(data: unknown, isError = false) {
  return { data, isError, isLoading: data === undefined && !isError, refetch: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.useAdminPages.mockReturnValue(query([]));
  queries.useAdminUserApiKeys.mockReturnValue(query([]));
  for (const mutation of [queries.useAdminAssignPage, queries.useAdminUnassignPage,
    queries.useAdminSetPassword, queries.useCreateAgentKey, queries.useRevokeAgentKey]) {
    mutation.mockReturnValue({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  }
});

describe("access catalogs do not turn failures into absence", () => {
  it("shows key-history failure without claiming no keys were issued", () => {
    queries.useAdminUserApiKeys.mockReturnValue(query(undefined, true));
    const html = renderToStaticMarkup(createElement(ChatterDetailModal, { user, onClose: vi.fn(), onDeactivate: vi.fn() }));
    expect(html).toContain("История ключей");
    expect(html).toContain("Не удалось загрузить данные");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("API-ключи ещё не выдавались");
    expect(html).toContain("Доступ к страницам");
  });

  it("keeps known key history visible when refresh fails", () => {
    queries.useAdminUserApiKeys.mockReturnValue(query([{
      id: 1, keyPrefix: "test_prefix", isActive: true, revokedReason: null,
      createdAt: "2026-09-10T00:00:00Z", lastUsedAt: null,
    }], true));
    const html = renderToStaticMarkup(createElement(ChatterDetailModal, { user, onClose: vi.fn(), onDeactivate: vi.fn() }));
    expect(html).toContain("test_prefix");
    expect(html).toContain("ранее полученные данные");
    expect(html).not.toContain("API-ключи ещё не выдавались");
  });

  it("explains an unavailable page catalog in the assignment dialog", () => {
    queries.useAdminPages.mockReturnValue(query(undefined, true));
    const html = renderToStaticMarkup(createElement(UserPageAssignmentModal, { user, onClose: vi.fn() }));
    expect(html).toContain("Данные не удалось загрузить");
    expect(html).toContain("Повторить");
    expect(html).toContain("Доступ к страницам");
    expect(html).not.toContain("В каталоге пока нет доступных страниц");
  });

  it("explains why an agent-key page scope cannot be selected", () => {
    queries.useAdminPages.mockReturnValue(query(undefined, true));
    const html = renderToStaticMarkup(createElement(CreateAgentKeyModal, {
      create: queries.useCreateAgentKey(), onClose: vi.fn(), onIssued: vi.fn(),
    }));
    expect(html).toContain("Данные не удалось загрузить");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("В каталоге нет страниц");
    expect(html).toMatch(/<button[^>]+type="submit"[^>]+disabled=""/);
  });
});

const eventRow = {
  id: 1, pageLabel: "lora", stream: "messages", severity: "error",
  eventType: "sync_failed", message: "Fixture diagnostic", details: null,
  emittedAt: "2026-09-11T00:00:00Z", syncRunId: 1,
};

describe.each([
  { component: LogPage, hook: queries.useAdminLogs, title: "Logs", empty: "No log entries found", data: [eventRow] },
  { component: QueuePage, hook: queries.useAdminQueueJobs, title: "Queue", empty: "No jobs found", data: [{
    id: "job-1", name: "Fixture diagnostic", state: "failed", createdOn: "2026-09-11T00:00:00Z",
    startedOn: null, completedOn: null, retryCount: 1, data: null, output: null,
  }] },
  { component: IncidentsPage, hook: queries.useAdminIncidents, title: "Incidents", empty: "No incidents found", data: {
    summary: [{ code: "sync_failed", severity: "error", count: 1 }], items: [eventRow],
  } },
])("diagnostic query recovery: $title", ({ component, hook, title, empty, data }) => {
  it("keeps its heading and recovery visible after initial failure", () => {
    hook.mockReturnValue(query(undefined, true));
    const html = renderToStaticMarkup(createElement(component));
    expect(html).toContain(`>${title}<`);
    expect(html).toContain("Повторить");
    expect(html).not.toContain(empty);
    if (title !== "Incidents") expect(html).toContain(">All<");
  });

  it("preserves cached diagnostics and keyboard disclosure during failed refresh", () => {
    hook.mockReturnValue(query(data, true));
    const html = renderToStaticMarkup(createElement(component));
    expect(html).toContain("Fixture diagnostic");
    expect(html).toContain("ранее полученные данные");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("overflow-x-auto");
  });
});

import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { agentHydrationRequestDecideBodySchema } from "../packages/contracts/src/routes-agent.ts";

const queries = vi.hoisted(() => ({
  useAdminDbStats: vi.fn(), useAdminLogs: vi.fn(), useAdminQueueJobs: vi.fn(), useAdminIncidents: vi.fn(), useAdminSyncRunDetail: vi.fn(),
  useAgentHydrationRequests: vi.fn(), useDecideAgentHydrationRequest: vi.fn(),
  useAgentKeys: vi.fn(), useCreateAgentKey: vi.fn(), useRevokeAgentKey: vi.fn(), useAdminPages: vi.fn(),
  useNotificationsSettings: vi.fn(), useUpdateNotificationsSettings: vi.fn(), useSendTestMessage: vi.fn(), useDiscoverTelegramChats: vi.fn(),
  useReportPreview: vi.fn(), useReportHistory: vi.fn(), useSendReport: vi.fn(), useNotificationIncidents: vi.fn(), useResolveIncident: vi.fn(),
}));
const webhook = vi.hoisted(() => ({ useOfapiWebhookRecovery: vi.fn(), ofapiWebhookRecoveryActions: {} }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/src/api/adminOfapiWebhookRecovery.ts", () => webhook);
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ KernelApiError: class KernelApiError extends Error { status = 500; } }));

import {
  AgentHydrationPage, createHydrationDraft, hydrationApprovalError, hydrationDraftMatches,
  prepareHydrationDecision, reviewHydrationDraft, hydrationDecisionAttempt,
  hydrationDecisionStatusIsDefiniteRefusal, frozenHydrationDecisionSummary,
} from "../apps/dashboard/src/pages/AgentHydrationPage.tsx";
import { editWebhookSelection, OfapiWebhookRecovery, webhookApplyIsSettledOrRunning, webhookReadbackResolvesAction } from "../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx";
import { AgentKeysTab } from "../apps/dashboard/src/pages/settings/AgentKeysTab.tsx";
import { PageAssignmentsEditor } from "../apps/dashboard/src/pages/settings/PageAssignmentsEditor.tsx";
import { DbStatsPage } from "../apps/dashboard/src/pages/dev/DbStatsPage.tsx";
import { IncidentsPage } from "../apps/dashboard/src/pages/dev/IncidentsPage.tsx";
import { LogPage } from "../apps/dashboard/src/pages/dev/LogPage.tsx";
import { QueuePage } from "../apps/dashboard/src/pages/dev/QueuePage.tsx";
import { SyncStatusPage } from "../apps/dashboard/src/pages/dev/SyncStatusPage.tsx";
import { NotificationsSettingsTab } from "../apps/dashboard/src/pages/notifications/NotificationsSettingsTab.tsx";
import { NotificationsReportsTab } from "../apps/dashboard/src/pages/notifications/NotificationsReportsTab.tsx";
import { NotificationsIncidentsTab } from "../apps/dashboard/src/pages/notifications/NotificationsIncidentsTab.tsx";
import { NotificationsPage } from "../apps/dashboard/src/pages/NotificationsPage.tsx";

function render(component: ComponentType, path = "/") {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(component)));
}
function query(data: unknown, isError = false) {
  return { data, isError, isLoading: false, isPending: false, isFetching: false, error: isError ? new Error("Refresh failed") : null, refetch: vi.fn() };
}
const request = { requestRef: "request-1", rowVersion: 4, coverageFingerprint: "a".repeat(64) };
const notificationSettings = {
  configured: false, botTokenSet: false, chatId: null, enabled: true,
  dailyReportEnabled: true, syncFailureAlertsEnabled: true, aiCriticalAlertsEnabled: false, reportHourUtc: 9,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["useDecideAgentHydrationRequest", "useCreateAgentKey", "useRevokeAgentKey", "useUpdateNotificationsSettings", "useSendTestMessage", "useDiscoverTelegramChats", "useSendReport", "useResolveIncident"] as const) {
    queries[name].mockReturnValue({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  }
  queries.useReportPreview.mockReturnValue(query(undefined));
  queries.useReportHistory.mockReturnValue(query({ items: [] }));
  queries.useNotificationsSettings.mockReturnValue(query(notificationSettings));
  queries.useNotificationIncidents.mockReturnValue(query({ items: [], total: 0 }));
});

describe("hydration approval review", () => {
  it("binds all caps and explicit mark-read consent to the reviewed request", () => {
    const draft = { ...createHydrationDraft(request), maxCalls: 3, maxPages: 4, maxCredits: 0, allowMarkRead: true };
    const prepared = prepareHydrationDecision(request, draft, "approve");
    expect("body" in prepared).toBe(true);
    if (!("body" in prepared)) return;
    expect(agentHydrationRequestDecideBodySchema.safeParse(prepared.body).success).toBe(true);
    expect(prepared.body).toMatchObject({ expectedVersion: 4, coverageFingerprint: request.coverageFingerprint, maxCalls: 3, maxPages: 4, maxCredits: 0, allowMarkReadSideEffect: true });
  });

  it.each([
    { ...request, rowVersion: 5 },
    { ...request, coverageFingerprint: "b".repeat(64) },
  ])("refuses a stale approval even if only version or coverage changed", (changed) => {
    const draft = { ...createHydrationDraft(request), allowMarkRead: true };
    expect(hydrationDraftMatches(draft, changed)).toBe(false);
    expect(prepareHydrationDecision(changed, draft, "approve")).toEqual({ error: expect.stringContaining("Review the current version") });
    expect(prepareHydrationDecision(changed, { ...draft, reason: "No need" }, "reject")).toHaveProperty("error");
    expect(draft.expectedVersion).toBe(4);
    expect(draft.coverageFingerprint).toBe(request.coverageFingerprint);
    expect(draft.allowMarkRead).toBe(true);
  });

  it("requires new mark-read consent after an explicit review, while preserving limits", () => {
    const draft = { ...createHydrationDraft(request), maxCalls: 17, maxPages: 12, maxCredits: 23, allowMarkRead: true };
    const changed = { ...request, rowVersion: 5, coverageFingerprint: "b".repeat(64) };
    const reviewed = reviewHydrationDraft(draft, changed);
    expect(reviewed).toMatchObject({ expectedVersion: 5, coverageFingerprint: changed.coverageFingerprint, maxCalls: 17, maxPages: 12, maxCredits: 23, allowMarkRead: false });
    const prepared = prepareHydrationDecision(changed, reviewed, "approve");
    expect("body" in prepared && prepared.body.allowMarkReadSideEffect).toBe(false);
    expect(prepareHydrationDecision({ ...changed, rowVersion: 6 }, reviewed, "approve")).toHaveProperty("error");
  });

  it("retries an uncertain decision with the exact original key, expiry, caps and consent", () => {
    const first = prepareHydrationDecision(request, { ...createHydrationDraft(request), allowMarkRead: true }, "approve");
    if (!("body" in first)) throw new Error("Expected a first decision body");
    const newer = { ...request, rowVersion: 5, coverageFingerprint: "b".repeat(64) };
    const retry = hydrationDecisionAttempt(first.body, newer, { ...createHydrationDraft(newer), maxCalls: 200, allowMarkRead: false }, "reject");
    expect(retry).toEqual(first);
    expect("body" in retry && retry.body).toBe(first.body);
    const summary = frozenHydrationDecisionSummary(first.body);
    expect(summary).toContain("Frozen approval");
    expect(summary).toContain("calls 5");
    expect(summary).toContain(`expires ${first.body.expiresAt}`);
    expect(summary).toContain("mark-read allowed");
    expect(summary).not.toContain("calls 200");
  });

  it("retains uncertain decisions for timeout, rate limit and server errors", () => {
    for (const status of [null, 408, 429, 499, 500, 502, 503, 504]) expect(hydrationDecisionStatusIsDefiniteRefusal(status)).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 422]) expect(hydrationDecisionStatusIsDefiniteRefusal(status)).toBe(true);
  });

  it.each([
    { maxCalls: 1.5 }, { maxCalls: 0 }, { maxCalls: 501 }, { maxPages: 501 },
    { maxCredits: -1 }, { maxCredits: 100_001 }, { expiresInHours: 0 }, { expiresInHours: Infinity },
  ])("does not send invalid caps or expiry: %j", (patch) => {
    const draft = { ...createHydrationDraft(request), ...patch };
    expect(hydrationApprovalError(draft)).not.toBeNull();
    expect(prepareHydrationDecision(request, draft, "approve")).toHaveProperty("error");
  });

  it("requires a rejection reason and never includes approval fields in a rejection", () => {
    const draft = createHydrationDraft(request);
    expect(prepareHydrationDecision(request, draft, "reject")).toHaveProperty("error");
    const prepared = prepareHydrationDecision(request, { ...draft, reason: "  Existing archive is enough  " }, "reject");
    if (!("body" in prepared)) throw new Error("Expected a rejection body");
    expect(agentHydrationRequestDecideBodySchema.safeParse(prepared.body).success).toBe(true);
    expect(prepared.body.reason).toBe("Existing archive is enough");
    expect(prepared.body).not.toHaveProperty("maxCalls");
    expect(prepared.body).not.toHaveProperty("allowMarkReadSideEffect");
    expect(frozenHydrationDecisionSummary(prepared.body)).toBe("Frozen rejection · v4 · reason: Existing archive is enough");
  });

  it("keeps a stale queue visible and pauses decisions", () => {
    queries.useAgentHydrationRequests.mockReturnValue(query({ items: [] }, true));
    const html = render(AgentHydrationPage);
    expect(html).toContain("Queue refresh failed; decisions are paused");
    expect(html).toContain("Refresh requests");
  });
});

describe("webhook selection review", () => {
  it("does not resolve an unknown apply from the old pending state or an active apply", () => {
    const baseline = { version: 7, applyState: "pending" };
    expect(webhookReadbackResolvesAction(baseline, { version: 7, applyState: "pending" })).toBe(false);
    expect(webhookReadbackResolvesAction(baseline, { version: 7, applyState: "applying" })).toBe(false);
    expect(webhookReadbackResolvesAction(baseline, { version: 6, applyState: "applied" })).toBe(false);
    expect(webhookReadbackResolvesAction(baseline, { version: 7, applyState: "applied" })).toBe(true);
    expect(webhookReadbackResolvesAction(baseline, { version: 7, applyState: "failed" })).toBe(true);
    expect(webhookReadbackResolvesAction(baseline, { version: 8, applyState: "pending" })).toBe(true);
    expect(webhookReadbackResolvesAction({ version: 7, applyState: "failed" }, { version: 7, applyState: "failed" })).toBe(false);
  });
  it("does not offer repeated provider apply for already applied or active policy", () => {
    expect(webhookApplyIsSettledOrRunning("applied")).toBe(true);
    expect(webhookApplyIsSettledOrRunning("applying")).toBe(true);
    expect(webhookApplyIsSettledOrRunning("pending")).toBe(false);
    expect(webhookApplyIsSettledOrRunning("failed")).toBe(false);
  });
  it("preserves edited groups and their version across polling and another field edit", () => {
    const policy = { version: 7, desiredGroups: ["engagement"], historyEnabled: false };
    const draft = editWebhookSelection(null, policy, { desiredGroups: ["account_lifecycle"] });
    const refreshed = { version: 8, desiredGroups: ["media_uploads"], historyEnabled: false };
    const edited = editWebhookSelection(draft, refreshed, { historyEnabled: true });
    expect(edited).toEqual({ version: 7, desiredGroups: ["account_lifecycle"], historyEnabled: true });
    expect(policy.desiredGroups).toEqual(["engagement"]);
    expect(editWebhookSelection(null, refreshed, { historyEnabled: true }).version).toBe(8);
  });

  it("marks a failed refresh while preserving the previously applied state", () => {
    webhook.useOfapiWebhookRecovery.mockReturnValue(query({
      policy: { version: 7, desiredGroups: [], appliedGroups: [], historyEnabled: false, groups: [], applyState: "applied", errorCode: null },
      catalog: null, history: { webhookId: null, latestScan: null, attempts: [] },
    }, true));
    const html = render(OfapiWebhookRecovery);
    expect(html).toContain("Показан предыдущий срез вебхуков");
    expect(html).toContain("Состояние: applied");
    expect(html).toMatch(/disabled=""[^>]*>Применить события/);
  });
});

describe("settings and diagnostics error states", () => {
  it.each([
    [DbStatsPage, "useAdminDbStats", { tables: [], migrations: [] }, "/dev/db"],
    [IncidentsPage, "useAdminIncidents", { summary: [], items: [] }, "/dev/incidents"],
    [LogPage, "useAdminLogs", [], "/dev/logs"],
    [QueuePage, "useAdminQueueJobs", [], "/dev/queue"],
    [SyncStatusPage, "useAdminSyncRunDetail", { run: { runId: 1, pageLabel: "example", platform: "fansly", status: "completed", startedAt: "2026-09-11T00:00:00Z", finishedAt: null }, events: [], attempts: [] }, "/dev/sync?runId=1"],
  ] as const)("keeps the %s snapshot with a visible refresh warning", (component, hook, data, path) => {
    queries[hook].mockReturnValue(query(data, true));
    const html = render(component, path);
    expect(html).toContain("Showing cached data");
    expect(html).toContain("Refresh failed");
    expect(html).toContain("overflow-x-auto");
  });

  it("does not present unknown database bytes as zero", () => {
    queries.useAdminDbStats.mockReturnValue(query({ tables: [{ table: "missing_size", rowEstimate: 0, totalBytes: null, indexBytes: 0 }], migrations: [] }));
    const html = render(DbStatsPage);
    expect(html).toContain("Rows (estimate)");
    expect(html.match(/0 B/g)).toHaveLength(1);
    expect(html).toContain("—");
  });

  it("explains a missing page catalog and preserves the assignment selection", () => {
    const html = renderToStaticMarkup(createElement(PageAssignmentsEditor, {
      assignedPages: [], availablePages: [{ id: 1, label: "example", platform: "fansly", modelName: "Model" }], selectedLabel: "example",
      onSelectedLabelChange: vi.fn(), onAssign: vi.fn(), onUnassign: vi.fn(), assignPending: false, unassignPending: false, pagesError: true,
    }));
    expect(html).toContain("Available pages could not be refreshed");
    expect(html).toContain('value="example" selected=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Assign<\/button>/);
  });

  it("shows stale agent key permissions explicitly", () => {
    queries.useAgentKeys.mockReturnValue(query([], true));
    expect(render(AgentKeysTab)).toContain("Showing cached data");
  });

  it("preserves the Telegram credential form during refresh errors and explains its send", () => {
    queries.useNotificationsSettings.mockReturnValue(query(notificationSettings, true));
    const html = render(NotificationsSettingsTab);
    expect(html).toContain("Settings refresh failed; your input is kept");
    expect(html).toContain('aria-label="Bot Token"');
    expect(html).toContain("Save &amp; Send Test");
    expect(html).toMatch(/role="switch"[^>]*disabled=""/);
  });

  it("shows preview failure while keeping the previous report and history", () => {
    queries.useReportPreview.mockReturnValue(query({ reportDate: "2026-09-10", text: "Previous report text" }, true));
    queries.useReportHistory.mockReturnValue(query({ items: [{ id: 1, reportDate: "2026-09-10", kind: "daily_report_scheduled", status: "sent", createdAt: "2026-09-11T00:00:00Z" }] }, true));
    const html = render(NotificationsReportsTab);
    expect(html).toContain("Preview refresh failed");
    expect(html).toContain("Previous report text");
    expect(html).toContain("Showing cached data");
    expect(html).toContain("Scheduled");
  });

  it("keeps filtered incident emptiness distinct from global system health", () => {
    queries.useNotificationIncidents.mockReturnValue(query({ items: [], total: 0 }, true));
    const html = render(NotificationsIncidentsTab);
    expect(html).toContain("Showing cached data");
    expect(html).toContain("No incidents match this view");
    expect(html).not.toContain("No incidents recorded");
  });

  it("opens notification reports from a shareable tab URL", () => {
    const html = render(NotificationsPage, "/notifications?tab=reports");
    expect(html).toContain("Preview Next Report");
    expect(html).not.toContain("Connect Telegram");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});

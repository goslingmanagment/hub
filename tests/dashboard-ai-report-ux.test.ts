import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("../apps/dashboard/src/api/workboard.ts", () => ({
  useWorkboardV2Ai: api.report,
  useWorkboardV2AiSettings: () => ({ isPending: false, mutate: vi.fn() }),
  useWorkboardV2AiClassify: () => ({ isPending: false, mutate: vi.fn() }),
}));
import { AiPageDashboard } from "../apps/dashboard/src/components/ai/AiPageDashboard.tsx";
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const report = { settings: { override: { enabled: null, dailyCapMax: null, model: null }, enabled: true, envEnabled: true, dailyCapMax: 100, model: "model-from-server", hasApiKey: false }, usage: { today: usage, last30d: usage }, coverage: {}, states: [], recent: [] };
const render = (client = new QueryClient()) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AiPageDashboard, { pageLabel: "synthetic-page" })));
beforeEach(() => api.report.mockReturnValue({ data: report, isLoading: false, isError: false, refetch: vi.fn() }));
describe("AI report and editable settings", () => {
  it("shows a retryable initial error instead of indefinite loading", () => {
    api.report.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Не удалось загрузить отчёт ИИ");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("Загружаем");
  });
  it("keeps cached report facts when refresh fails", () => {
    api.report.mockReturnValue({ data: report, isLoading: false, isError: true, refetch: vi.fn() });
    const html = render();
    expect(html).toContain("Показаны ранее полученные данные");
    expect(html).toContain("model-from-server");
    expect(html).toContain("$0");
  });
  it("keeps a draft separate from a refreshed report and from another account", () => {
    const client = new QueryClient();
    client.setQueryData(["dashboard-workspace", "ai-settings:synthetic-page"], { enabledChoice: "off", capInput: "234", modelInput: "unsaved-model" });
    client.setQueryData(["dashboard-workspace", "ai-settings:other-page"], { enabledChoice: "on", capInput: "999", modelInput: "other-page-secret-draft" });
    const html = render(client);
    expect(html).toContain('value="234"');
    expect(html).toContain('value="unsaved-model"');
    expect(html).toContain("model-from-server");
    expect(html).toContain("Есть несохранённые изменения");
    expect(html).not.toContain("other-page-secret-draft");
  });
});

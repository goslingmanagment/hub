import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Sparkles } from "lucide-react";

import { useWorkboardV2AiRuns } from "@/api/workboard";
import { useDashboardShell } from "@/components/layout/DashboardShellContext";
import { AiPageDashboard } from "@/components/ai/AiPageDashboard";
import { AiRunLog } from "@/components/ai/AiRunLog";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { resolveOfapiPage } from "@/lib/ofapiNavigation";

export function AiAnalyticsPage() {
  const { pages, pageCatalogState } = useDashboardShell();
  const [searchParams, setSearchParams] = useSearchParams();
  const fanslyPages = useMemo(() => pages.filter((p) => p.platform === "fansly"), [pages]);
  const requestedPage = searchParams.get("page");
  const activeLabel = resolveOfapiPage(fanslyPages, requestedPage)?.label ?? "";

  function handlePageChange(pageLabel: string) {
    const next = new URLSearchParams(searchParams);
    next.set("page", pageLabel);
    setSearchParams(next);
  }

  // Poll fast while any run is live (instant feedback), idle-poll otherwise.
  const runsQuery = useWorkboardV2AiRuns({
    refetchInterval: (data) => (data?.runs.some((r) => r.status === "running") ? 2500 : 15000),
  });
  const runs = runsQuery.data?.runs ?? [];
  const runningForActive = runs.some((r) => r.pageLabel === activeLabel && r.status === "running");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
            <Sparkles size={18} className="text-accent" />
            ИИ-аналитика диалогов
          </h1>
          <p className="text-[13px] text-text-secondary">
            Детектор ответа на Haiku: что происходит в чатах, расход, управление и журнал запусков.
          </p>
        </div>
        {fanslyPages.length > 0 && (
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            Страница
            <select
              value={activeLabel}
              onChange={(e) => handlePageChange(e.target.value)}
              className="rounded-md border border-border bg-card px-2 py-1.5 text-[13px] font-medium text-text-primary"
            >
              {!activeLabel && <option value="">Выберите доступную страницу</option>}
              {fanslyPages.map((p) => (
                <option key={p.id} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {pageCatalogState === "loading" && pages.length === 0 ? (
        <StatusPanel title="Загружаем список страниц…" />
      ) : pageCatalogState === "error" && pages.length === 0 ? (
        <StatusPanel title="Не удалось загрузить список страниц" description="Доступность AI-аналитики пока неизвестна. Обновите страницу, чтобы повторить запрос." tone="error" />
      ) : activeLabel ? (
        <div className="space-y-4">
          {pageCatalogState === "error" && <p role="alert" className="rounded-lg border border-warning px-3 py-2 text-sm text-text-secondary">Список страниц не обновился. Показан ранее доступный аккаунт.</p>}
          <AiPageDashboard key={activeLabel} pageLabel={activeLabel} running={runningForActive} />
          <AiRunLog
            runs={runs}
            isLoading={runsQuery.isLoading}
            isFetching={runsQuery.isFetching}
            isError={runsQuery.isError}
            hasData={runsQuery.data !== undefined}
            onRefresh={() => void runsQuery.refetch()}
          />
        </div>
      ) : (
        <StatusPanel title={requestedPage !== null ? "Страница из ссылки недоступна для анализа" : "Нет Fansly-страниц для анализа"} description={requestedPage !== null ? "Выберите доступную Fansly-страницу в списке выше." : "AI-аналитика диалогов доступна для Fansly."} />
      )}
    </div>
  );
}

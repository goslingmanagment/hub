import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Sparkles } from "lucide-react";

import { useWorkboardV2AiRuns } from "@/api/workboard";
import { useDashboardShell } from "@/components/layout/DashboardShellContext.js";
import { AiPageDashboard } from "@/components/ai/AiPageDashboard";
import { AiRunLog } from "@/components/ai/AiRunLog";

export function AiAnalyticsPage() {
  const { pages } = useDashboardShell();
  const [searchParams, setSearchParams] = useSearchParams();
  const fanslyPages = useMemo(() => pages.filter((p) => p.platform === "fansly"), [pages]);
  const requestedPage = searchParams.get("page") ?? "";

  const activeLabel = fanslyPages.some((p) => p.label === requestedPage)
    ? requestedPage
    : fanslyPages[0]?.label ?? "";

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
              {fanslyPages.map((p) => (
                <option key={p.id} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {activeLabel ? (
        <div className="space-y-4">
          <AiPageDashboard key={activeLabel} pageLabel={activeLabel} running={runningForActive} />
          <AiRunLog
            runs={runs}
            isLoading={runsQuery.isLoading}
            isFetching={runsQuery.isFetching}
            onRefresh={() => void runsQuery.refetch()}
          />
        </div>
      ) : (
        <div className="rounded-card border border-border bg-card px-4 py-12 text-center text-[13px] text-text-muted">
          Нет Fansly-страниц для анализа.
        </div>
      )}
    </div>
  );
}

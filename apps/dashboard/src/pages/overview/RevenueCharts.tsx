import { lazy, Suspense } from "react";
import type { OverviewRevenueResponse } from "@agency_hub_core/contracts";
import { useRevenueChart } from "@/api/overview";
import { PERIOD_LABELS } from "@/lib/overviewNavigation";
import type { PeriodOption } from "@/stores/periodStore";
import { calendarSeries, money } from "./presentation.js";
import { QueryNotice } from "@/components/shared/QueryNotice";

const PageActivityChart = lazy(() =>
  import("@/components/page/PageActivityChart").then((module) => ({
    default: module.PageActivityChart,
  })),
);

function ChartSkeleton() {
  return (
    <div role="status" className="h-[300px] animate-pulse rounded-lg bg-hover-alt">
      <span className="sr-only">Загружаем график…</span>
    </div>
  );
}

/** One card: daily revenue of the agency, a model or a page, picked in one
 *  select. The choice lives in the URL (`chart`). */
export function RevenueCharts({
  report,
  period,
  scope,
  selectScope,
}: {
  report: OverviewRevenueResponse;
  period: PeriodOption;
  scope: string;
  selectScope: (scope: string) => void;
}) {
  const models = [...report.models].sort(
    (a, b) =>
      b.netEarningsMills - a.netEarningsMills ||
      a.modelSlug.localeCompare(b.modelSlug),
  );
  const selectedPage = scope.startsWith("page:")
    ? report.pages.find((page) => page.pageLabel === scope.slice(5))
    : undefined;
  const selectedModel = scope.startsWith("model:")
    ? report.models.find((model) => model.modelSlug === scope.slice(6))
    : undefined;
  const valid =
    scope === "agency" ||
    Boolean(selectedModel) ||
    Boolean(selectedPage && selectedPage.status !== "deleted");
  const daily = useRevenueChart(
    scope,
    period,
    report.windowAt,
    valid && Boolean(report.windowAt),
  );
  const windows = selectedPage?.platform
    ? report.platformWindows.filter(
        (window) => window.platform === selectedPage.platform,
      )
    : selectedModel
      ? report.platformWindows.filter((window) =>
          report.pages.some(
            (page) =>
              page.modelSlug === selectedModel.modelSlug &&
              page.platform === window.platform,
          ),
        )
      : report.platformWindows;

  return (
    <section
      className="card"
      id="overview-chart"
      aria-labelledby="overview-chart-title"
    >
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="overview-chart-title" className="card-title">
            Доход по дням
          </h2>
          {valid && (
            <p className="card-description">
              Итого за период:{" "}
              <span className="font-medium text-text-primary tabular-nums">
                {money((selectedPage ?? selectedModel ?? report).netEarningsMills)}
              </span>
            </p>
          )}
        </div>
        <select
          id="overview-chart-scope"
          className="select w-auto max-w-full sm:min-w-56"
          aria-label="Что показать на графике"
          value={scope}
          onChange={(event) => selectScope(event.target.value)}
        >
          <option value="agency">Всё агентство</option>
          {!valid && <option value={scope}>Выбор недоступен</option>}
          <optgroup label="Модели">
            {models.map((model) => (
              <option key={model.modelSlug} value={`model:${model.modelSlug}`}>
                {model.modelName}
              </option>
            ))}
          </optgroup>
          <optgroup label="Страницы">
            {report.pages
              .filter((page) => page.status !== "deleted")
              .map((page) => (
                <option key={page.pageId} value={`page:${page.pageLabel}`}>
                  {page.pageLabel}
                </option>
              ))}
          </optgroup>
        </select>
      </div>
      <div className="card-body">
        <QueryNotice
          error={daily.isError}
          stale={Boolean(daily.data)}
          retry={daily.refetch}
        />
        {!valid || !report.windowAt ? (
          <p className="empty-text ov-chart-empty">
            Для этого выбора график недоступен.
          </p>
        ) : daily.isLoading ? (
          <ChartSkeleton />
        ) : (
          daily.data &&
          (daily.data.series.length > 0 ? (
            <div className="ov-chart-plot">
              <Suspense fallback={<ChartSkeleton />}>
                <PageActivityChart
                  title="Доход"
                  selectedPeriod={period}
                  selectedPeriodLabel={PERIOD_LABELS[period]}
                  points={calendarSeries(daily.data.series, windows)}
                  allowMonthly={false}
                  valueFormatter={money}
                  yAxisWidth={72}
                  color="var(--color-accent)"
                />
              </Suspense>
            </div>
          ) : (
            <p className="empty-text ov-chart-empty">
              За этот период операций нет.
            </p>
          ))
        )}
      </div>
    </section>
  );
}

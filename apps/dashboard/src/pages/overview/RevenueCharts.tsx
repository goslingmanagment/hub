import { lazy, Suspense } from "react";
import type { OverviewRevenueResponse } from "@agency_hub_core/contracts";
import { useOverviewRevenueByModel, useRevenueChart } from "@/api/overview";
import { TrendSparkline } from "@/components/shared/TrendSparkline";
import { PERIOD_LABELS } from "@/lib/overviewNavigation";
import type { PeriodOption } from "@/stores/periodStore";
import { calendarSeries, money, describeWindows } from "./presentation.js";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { RevenueDelta } from "./RevenueValue.js";

const PageActivityChart = lazy(() =>
  import("@/components/page/PageActivityChart").then((module) => ({
    default: module.PageActivityChart,
  })),
);

export function RevenueCharts({
  report,
  period,
  scope,
  selectScope,
}: {
  report: OverviewRevenueResponse;
  period: PeriodOption;
  scope: string;
  selectScope: (scope: string, scroll?: boolean) => void;
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
  const byModel = useOverviewRevenueByModel(period, report.windowAt);
  const name =
    selectedPage?.pageLabel ?? selectedModel?.modelName ?? "Агентство";
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
    <>
      <section
        className="v1-chart-section"
        id="overview-chart"
        aria-label="График дохода"
      >
        <div className="v1-chart-controls">
          <label htmlFor="overview-chart-scope">График</label>
          <select
            id="overview-chart-scope"
            className="v1-chart-select"
            value={scope}
            onChange={(event) => selectScope(event.target.value)}
          >
            <option value="agency">Всё агентство</option>
            {!valid && (
              <option value={scope}>Выбранная область недоступна</option>
            )}
            <optgroup label="Модели">
              {models.map((model) => (
                <option
                  key={model.modelSlug}
                  value={`model:${model.modelSlug}`}
                >
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
          {scope !== "agency" && (
            <button
              type="button"
              className="v1-text-button"
              onClick={() => selectScope("agency")}
            >
              Вернуть агентство
            </button>
          )}
          {valid && (
            <span className="v1-chart-scope-total">
              За окно{" "}
              <strong>
                {money(
                  (selectedPage ?? selectedModel ?? report).netEarningsMills,
                )}
              </strong>
            </span>
          )}
        </div>
        <QueryNotice
          error={daily.isError}
          stale={Boolean(daily.data)}
          retry={daily.refetch}
        />
        {!valid || !report.windowAt ? (
          <p className="v1-chart-missing">
            Подневный ряд выбранной области недоступен.
          </p>
        ) : daily.isLoading ? (
          <p className="v1-chart-missing" role="status">
            Загружаем график…
          </p>
        ) : (
          daily.data &&
          (daily.data.series.length > 0 ? (
            <Suspense fallback={<p role="status">Загружаем график…</p>}>
              <PageActivityChart
                title={`Доход · ${name}`}
                selectedPeriod={period}
                selectedPeriodLabel={PERIOD_LABELS[period]}
                points={calendarSeries(daily.data.series, windows)}
                allowMonthly={false}
                valueFormatter={money}
                yAxisWidth={72}
                color="var(--color-accent)"
              />
            </Suspense>
          ) : (
            <p className="v1-chart-missing">
              В этом окне операций не записано.
            </p>
          ))
        )}
        {valid && (
          <p className="v1-chart-footnote">
            {describeWindows(windows)}. Даты UTC; ноль — нулевой итог
            сохранённых операций за дату. Полнота захвата не подтверждена.
          </p>
        )}
      </section>
      <section className="v1-models" aria-label="Доход по моделям">
        <div className="v1-models-header">
          Доход по моделям · {PERIOD_LABELS[period]}
        </div>
        <QueryNotice
          error={byModel.isError}
          stale={Boolean(byModel.data)}
          retry={byModel.refetch}
        />
        {models.map((model) => {
          const trend = report.windowAt
            ? byModel.data?.models.find(
                (item) => item.modelSlug === model.modelSlug,
              )
            : undefined;
          return (
            <div className="v1-model-row" key={model.modelSlug}>
              <div className="v1-model-info">
                <button
                  type="button"
                  id={`model-chart-${model.modelId}`}
                  onClick={() => selectScope(`model:${model.modelSlug}`, true)}
                >
                  {model.modelName}
                  {model.status === "retired" ? " · архив" : ""}
                </button>
                <p>
                  {model.pageCount} стр.
                  {trend
                    ? ` · ${trend.transactionCount.toLocaleString("ru-RU")} операций`
                    : ""}
                </p>
              </div>
              <div className="v1-sparkline">
                {trend ? (
                  <TrendSparkline
                    values={calendarSeries(
                      trend.series,
                      report.platformWindows.filter((window) =>
                        report.pages.some(
                          (page) =>
                            page.modelSlug === model.modelSlug &&
                            page.platform === window.platform,
                        ),
                      ),
                    ).map((point) => point.value)}
                  />
                ) : (
                  <span aria-label="Тренд недоступен">—</span>
                )}
              </div>
              <div className="v1-model-money">
                {money(model.netEarningsMills)}
              </div>
              <div className="v1-model-delta">
                <RevenueDelta {...model} />
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}

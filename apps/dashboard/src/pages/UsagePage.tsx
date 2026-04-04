import { Fragment, useMemo, useState } from "react";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { useAdminChatterUsage } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";

const FEATURE_LABELS: Record<string, string> = {
  "fast-reply": "Fast Reply",
  "improve-draft": "Improve Draft",
  "help-me": "Help Me",
  "fan-summary": "Fan Summary",
  "chat-review": "Chat Review",
  scan: "Scan",
  ping: "Ping",
  "hi-greeting": "Hi Greeting",
};

type UsageRow = AdminChatterUsageResponse["rows"][number];

function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  return String(value);
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatFeatureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getFeatureCount(row: UsageRow, feature: string): number {
  return row.featureBreakdown.find((f) => f.feature === feature)?.requestCount ?? 0;
}

export function UsagePage() {
  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

  const { data, isLoading, isError } = useAdminChatterUsage({
    from: selectedDate,
    to: selectedDate,
  });

  const rows = data?.rows ?? [];
  const activeRows = rows.filter((r) => r.totalGenerations > 0);

  const activeFeatures = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of activeRows) {
      for (const fb of row.featureBreakdown) {
        if (fb.requestCount > 0) {
          totals.set(fb.feature, (totals.get(fb.feature) ?? 0) + fb.requestCount);
        }
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([feature]) => feature);
  }, [activeRows]);

  function toggleExpanded(userId: number) {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  if (isLoading) {
    return <StatusPanel title="Loading usage" description="Fetching chatter AI usage." />;
  }

  if (isError) {
    return (
      <StatusPanel title="Usage failed to load" description="Could not fetch usage report." tone="error" />
    );
  }

  if (!data) {
    return <StatusPanel title="No data" description="The report returned no data." tone="error" />;
  }

  const colCount = activeFeatures.length + 3;

  return (
    <div>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">Usage</h1>
          <p className="mt-1 text-sm text-text-muted">Daily AI usage by chatter and feature.</p>
        </div>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => {
            setSelectedDate(e.target.value);
            setExpandedUsers(new Set());
          }}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent"
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Name
              </th>
              {activeFeatures.map((feature) => (
                <th
                  key={feature}
                  className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                >
                  {formatFeatureLabel(feature)}
                </th>
              ))}
              <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Total
              </th>
              <th className="px-4 py-3 text-right text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Regen
              </th>
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-sm text-text-muted">
                  No activity for this day.
                </td>
              </tr>
            )}
            {activeRows.map((row) => {
              const isExpanded = expandedUsers.has(row.userId);
              return (
                <Fragment key={row.userId}>
                  <tr
                    onClick={() => toggleExpanded(row.userId)}
                    className={`cursor-pointer border-t border-border transition-colors hover:bg-hover ${
                      row.warning ? "bg-warning/[0.06]" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      <span className="mr-1.5 inline-block w-3 text-text-muted">
                        {isExpanded ? "▾" : "▸"}
                      </span>
                      {row.username}
                    </td>
                    {activeFeatures.map((feature) => {
                      const count = getFeatureCount(row, feature);
                      return (
                        <td
                          key={feature}
                          className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary"
                        >
                          {count > 0 ? count : "–"}
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-text-primary">
                      {row.totalGenerations}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums">
                      <span className={row.warning ? "font-semibold text-warning-dark" : "text-text-secondary"}>
                        {formatPercent(row.regenerateRatePct)}
                      </span>
                      {row.warning && (
                        <span className="ml-1.5 inline-block rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-warning-dark">
                          !
                        </span>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-t border-border-light">
                      <td colSpan={colCount} className="bg-hover-alt/50 px-4 py-3">
                        <div className="space-y-1 text-[13px] text-text-secondary">
                          {row.featureBreakdown.map((fb, i) => (
                            <div key={fb.feature} className="flex items-baseline gap-2">
                              <span className="w-3 text-center text-text-muted">
                                {i === row.featureBreakdown.length - 1 ? "└" : "├"}
                              </span>
                              <span className="min-w-[120px] font-medium text-text-primary">
                                {formatFeatureLabel(fb.feature)}
                              </span>
                              <span className="tabular-nums">
                                {formatCompact(fb.tokenCounts.input)} in
                                {" · "}
                                {formatCompact(fb.tokenCounts.output)} out
                                {" · "}
                                {formatCompact(fb.tokenCounts.cacheTotal)} cache
                              </span>
                              {fb.regenerateRatePct > 0 && (
                                <span className="tabular-nums text-text-muted">
                                  · {formatPercent(fb.regenerateRatePct)} regen
                                </span>
                              )}
                            </div>
                          ))}
                          <div className="mt-1.5 border-t border-border-light pt-1.5 text-[12px] tabular-nums text-text-muted">
                            Total: {formatCompact(row.tokenCounts.input)} in
                            {" · "}
                            {formatCompact(row.tokenCounts.output)} out
                            {" · "}
                            {formatCompact(row.tokenCounts.cacheTotal)} cache
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

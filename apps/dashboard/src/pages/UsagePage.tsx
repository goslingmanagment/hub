import { Fragment, useState } from "react";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";
import { useAdminChatterUsage } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { UsageDateNav } from "@/components/shared/UsageDateNav";
import { type UsagePeriod, usageRange, shiftAnchor, usageDateLabel } from "@/lib/format";

const FEATURE_ORDER: { key: string; label: string }[] = [
  { key: "fast-reply", label: "Fast Reply" },
  { key: "fan-summary", label: "Fan Summary" },
  { key: "improve-draft", label: "Improve Draft" },
  { key: "help-me", label: "Help Me" },
  { key: "chat-review", label: "Chat Review" },
  { key: "scan", label: "Scan" },
  { key: "ping", label: "Ping" },
  { key: "hi-greeting", label: "Hi Greeting" },
];

const FEATURE_LABELS: Record<string, string> = Object.fromEntries(
  FEATURE_ORDER.map((f) => [f.key, f.label]),
);

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
  return toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
}

function getFeatureCount(row: UsageRow, feature: string): number {
  return row.featureBreakdown.find((f) => f.feature === feature)?.requestCount ?? 0;
}

const SUBTITLE: Record<UsagePeriod, string> = {
  day: "Daily AI usage by chatter and feature.",
  week: "Weekly AI usage by chatter and feature.",
  month: "Monthly AI usage by chatter and feature.",
};

export function UsagePage() {
  const [mode, setMode] = useState<UsagePeriod>("day");
  const [anchor, setAnchor] = useState(todayISO);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

  const range = usageRange(anchor, mode);
  const today = todayISO();
  const canGoNext = range.to < today;

  const { data, isLoading, isError } = useAdminChatterUsage(range);

  const rows = data?.rows ?? [];
  const activeRows = rows.filter((r) => r.totalGenerations > 0);

  const visibleFeatures = FEATURE_ORDER.map((f) => f.key);

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

  const colCount = visibleFeatures.length + 3;

  return (
    <div>
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">Usage</h1>
          <p className="mt-1 text-sm text-text-muted">{SUBTITLE[mode]}</p>
        </div>
        <UsageDateNav
          mode={mode}
          onModeChange={(m) => {
            setMode(m);
            setExpandedUsers(new Set());
          }}
          label={usageDateLabel(anchor, mode)}
          onPrev={() => {
            setAnchor(shiftAnchor(anchor, mode, -1));
            setExpandedUsers(new Set());
          }}
          onNext={() => {
            setAnchor(shiftAnchor(anchor, mode, 1));
            setExpandedUsers(new Set());
          }}
          canGoNext={canGoNext}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              <th className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted">
                Name
              </th>
              {visibleFeatures.map((feature) => (
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
                    {visibleFeatures.map((feature) => {
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

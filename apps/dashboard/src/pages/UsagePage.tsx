import { useEffect, useState } from "react";
import type { AdminChatterUsageResponse } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useAdminChatterUsage } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";

const FEATURE_LABELS: Record<string, string> = {
  "fast-reply": "Fast Reply",
  "improve-draft": "Improve Draft",
  "help-me": "Help Me",
  "fan-summary": "Fan Summary",
  "chat-review": "Chat Review",
  ping: "Ping",
  "hi-greeting": "Hi Greeting",
};

type UsageRow = AdminChatterUsageResponse["rows"][number];

function formatInteger(value: number) {
  return value.toLocaleString();
}

function formatPercent(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function formatFeatureLabel(feature: string) {
  return FEATURE_LABELS[feature] ?? feature;
}

function formatTopFeature(topFeature: UsageRow["topFeature"]) {
  if (!topFeature) {
    return "\u2014";
  }

  return `${formatFeatureLabel(topFeature.feature)} (${formatPercent(topFeature.sharePct)})`;
}

export function UsagePage() {
  const [submittedRange, setSubmittedRange] = useState<{ from?: string; to?: string } | null>(null);
  const { data, isLoading, isError } = useAdminChatterUsage(submittedRange ?? {});
  const [draftFrom, setDraftFrom] = useState(() => data?.range.from ?? "");
  const [draftTo, setDraftTo] = useState(() => data?.range.to ?? "");
  const [didHydrateRange, setDidHydrateRange] = useState(Boolean(data?.range));

  useEffect(() => {
    if (didHydrateRange || !data?.range) {
      return;
    }

    setDraftFrom(data.range.from);
    setDraftTo(data.range.to);
    setDidHydrateRange(true);
  }, [data, didHydrateRange]);

  function handleApply() {
    if (!draftFrom || !draftTo) {
      toast.error("Select both from and to dates");
      return;
    }

    if (draftFrom > draftTo) {
      toast.error("From date must be on or before the to date");
      return;
    }

    setSubmittedRange({ from: draftFrom, to: draftTo });
  }

  if (isLoading || !data) {
    return isLoading ? (
      <StatusPanel title="Loading usage" description="Fetching chatter AI usage for the selected period." />
    ) : isError ? (
      <StatusPanel title="Usage failed to load" description="The chatter AI usage report could not be fetched." tone="error" />
    ) : (
      <StatusPanel title="Usage unavailable" description="The chatter AI usage report did not return data." tone="error" />
    );
  }

  const rows = data.rows ?? [];

  return (
    <div>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-text-primary">Usage</h1>
          <p className="mt-1 text-sm text-text-muted">
            AI generations and token usage by chatter for the selected Moscow date range.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">From</span>
            <input
              type="date"
              value={draftFrom}
              onChange={(event) => setDraftFrom(event.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-text-muted">To</span>
            <input
              type="date"
              value={draftTo}
              onChange={(event) => setDraftTo(event.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={handleApply}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90"
          >
            Apply
          </button>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-hover-alt">
              {["Name", "Total Generations", "Input Tokens", "Output Tokens", "Cache Tokens", "Top Feature", "Regenerate Rate"].map((column) => (
                <th
                  key={column}
                  className={`px-4 py-3 text-[12px] font-semibold uppercase tracking-wider text-text-muted ${
                    column === "Name" || column === "Top Feature" ? "text-left" : "text-right"
                  }`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-text-muted">
                  No chatters found.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.userId}
                className={`border-t border-border ${
                  row.warning ? "bg-warning/[0.06]" : "transition-colors hover:bg-hover"
                }`}
              >
                <td className="px-4 py-3 text-sm font-medium text-text-primary">{row.username}</td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                  {formatInteger(row.totalGenerations)}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                  {formatInteger(row.tokenCounts.input)}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                  {formatInteger(row.tokenCounts.output)}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-text-secondary">
                  {formatInteger(row.tokenCounts.cacheTotal)}
                </td>
                <td className="px-4 py-3 text-sm text-text-secondary">
                  {formatTopFeature(row.topFeature)}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums">
                  <div className="flex items-center justify-end gap-2">
                    <span className={row.warning ? "font-semibold text-warning-dark" : "text-text-secondary"}>
                      {formatPercent(row.regenerateRatePct)}
                    </span>
                    {row.warning && (
                      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warning-dark">
                        High
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { useAdminSyncRunDetail } from "@/api/queries";
import { getEventDisplaySeverity } from "@/components/shared/EventDetailPanel";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import type { SyncRunDetailResponse } from "@agency_hub_core/contracts";

function formatRunState(state: string) {
  return state
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveEventCode(details: Record<string, unknown> | null, fallback: string | null) {
  return typeof details?.code === "string" ? details.code : fallback;
}

export function SyncStatusPage() {
  const [searchParams] = useSearchParams();
  const runId = Number(searchParams.get("runId") ?? "0");
  const isValidRunId = Number.isInteger(runId) && runId > 0;
  const { data, isLoading, isError, error } = useAdminSyncRunDetail(isValidRunId ? runId : 0);

  const attemptsByStream = useMemo<Map<string, SyncRunDetailResponse["attempts"]>>(() => {
    const grouped = new Map<string, SyncRunDetailResponse["attempts"]>();
    if (!data) {
      return grouped;
    }
    for (const attempt of data.attempts) {
      const existing = grouped.get(attempt.stream);
      if (existing) {
        existing.push(attempt);
      } else {
        grouped.set(attempt.stream, [attempt]);
      }
    }
    return grouped;
  }, [data]);

  if (!isValidRunId) {
    return (
      <StatusPanel
        title="Sync run not selected"
        description="Open this page with a valid run ID to inspect sync events and attempts."
        tone="error"
      />
    );
  }

  if (isLoading && !data) {
    return (
      <StatusPanel
        title="Loading sync run"
        description="Fetching run details, events, and request attempts."
      />
    );
  }

  if (!data) {
    return (
      <StatusPanel
        title="Sync run failed to load"
        description="The requested sync run details could not be fetched."
        tone="error"
      />
    );
  }

  return (
    <div className="space-y-6">
      {isError && <StaleDataNotice error={error} />}
      <div>
        <h1 className="text-xl font-extrabold text-text-primary">Sync Run #{data.run.runId}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-text-muted">
          <span>{data.run.pageLabel}</span>
          <span>{data.run.platform}</span>
          <span>{formatRunState(data.run.status)}</span>
          <span>Started {formatDateTime(data.run.startedAt)}</span>
          {data.run.finishedAt && <span>Finished {formatDateTime(data.run.finishedAt)}</span>}
        </div>
      </div>

      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Events</h2>
        </div>
        {data.events.length === 0 ? (
          <div className="px-4 py-6">
            <StatusPanel
              title="No events recorded"
              description="This run has no emitted events."
            />
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-hover-alt">
                {["When", "Stream", "Severity", "Type", "Message"].map((label) => (
                  <th
                    key={label}
                    className="px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                (() => {
                  const eventCode = resolveEventCode(event.details, event.eventType);
                  const displaySeverity = getEventDisplaySeverity({
                    eventCode,
                    severity: event.severity,
                    details: event.details,
                  });

                  return (
                    <tr key={event.id} className="border-t border-border">
                      <td className="px-4 py-3 text-sm text-text-muted">{formatRelativeTime(event.emittedAt)}</td>
                      <td className="px-4 py-3 text-sm text-text-primary">{event.stream}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{displaySeverity}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{event.eventType}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{event.message}</td>
                    </tr>
                  );
                })()
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="overflow-x-auto rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Attempts</h2>
        </div>
        {data.attempts.length === 0 ? (
          <div className="px-4 py-6">
            <StatusPanel
              title="No attempts recorded"
              description="This run has no request-attempt details."
            />
          </div>
        ) : (
          <div className="space-y-4 px-4 py-4">
            {[...attemptsByStream.entries()].map(([stream, attempts]) => (
              <div key={stream} className="rounded-xl border border-border">
                <div className="border-b border-border bg-hover-alt px-4 py-2 text-sm font-semibold text-text-primary">
                  {stream}
                </div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-hover-alt/50">
                      {["Attempt", "State", "HTTP", "Started", "Duration", "Error"].map((label) => (
                        <th
                          key={label}
                          className="px-4 py-2 text-left text-[12px] font-semibold uppercase tracking-wider text-text-muted"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((attempt) => (
                      <tr key={attempt.attemptId} className="border-t border-border">
                        <td className="px-4 py-2 text-sm text-text-primary">#{attempt.attemptNumber}</td>
                        <td className="px-4 py-2 text-sm text-text-secondary">{attempt.state}</td>
                        <td className="px-4 py-2 text-sm text-text-secondary">{attempt.httpStatus ?? "—"}</td>
                        <td className="px-4 py-2 text-sm text-text-muted">{formatDateTime(attempt.startedAt)}</td>
                        <td className="px-4 py-2 text-sm text-text-muted">{attempt.durationMs != null ? `${attempt.durationMs}ms` : "—"}</td>
                        <td className="px-4 py-2 text-sm text-text-secondary">{attempt.errorMessage ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

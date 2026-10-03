import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { formatDateTime } from "@/lib/format";
import type { AnalyticsPanelState } from "@/pages/analytics-query-state";

import {
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
} from "./AnalyticsPanel.js";

type EngineStreamRow = NonNullable<StatsCoverageResponse["engine"]>["streams"][number];

function instant(value: string | null): string {
  return value === null ? "—" : formatDateTime(value);
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function engineLabel(stream: EngineStreamRow): { text: string; tone: "off" | "on" } {
  if (stream.paused) {
    return { text: "paused", tone: "off" };
  }
  if (stream.needsAttention) {
    return { text: "needs attention", tone: "off" };
  }
  return { text: "reading", tone: "on" };
}

/**
 * Panel 8 — the honesty panel.
 *
 * It answers the questions that make every other panel on this page
 * readable: what do we hold, how far back does it reach, and is the Fansly Sync
 * Engine still reading it — when it last did, when it reads next, and why it
 * waits. A chart above with no rows means one thing when its data is read and
 * the world was empty, and a completely different thing when nobody reads it —
 * and only this panel can tell them apart.
 */
export function CoveragePanel({
  state,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsCoverageResponse>;
  onRetry: () => void;
}) {
  // The old shape took `data | undefined` and mapped `!data` to "No coverage
  // data for this page" — which read a FAILED request, a pending one and a
  // genuinely empty response as the same sentence. On the page that exists to
  // make holes visible, that was the worst possible conflation: the panel that
  // explains every other panel's emptiness was itself lying about its own.
  if (state.status === "loading") {
    return (
      <AnalyticsPanel title="Coverage">
        <AnalyticsLoading what="Loading coverage…" />
      </AnalyticsPanel>
    );
  }
  if (state.status === "error") {
    return (
      <AnalyticsPanel title="Coverage">
        <AnalyticsError message={state.message} onRetry={onRetry} />
      </AnalyticsPanel>
    );
  }

  const data = state.data;
  const holdings = data.holdings.filter((row) => row.rowCount > 0);
  const empty = data.holdings.filter((row) => row.rowCount === 0);

  return (
    <AnalyticsPanel
      title="Coverage — what this page actually holds"
      cached={state.refreshFailed}
      subtitle={
        "Read this before believing any chart above. An empty chart over data the "
        + "engine reads means the world was empty; the same chart over data it does "
        + "not read means nobody looked."
      }
    >
      <div className="space-y-6">
        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Capture floors
          </h3>
          {data.planes.length === 0 ? (
            <AnalyticsEmpty reason="No capture-coverage rows: no lane has claimed anything for this page." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
                    <th className="pb-2 font-semibold">Plane</th>
                    <th className="pb-2 font-semibold">Scope</th>
                    <th className="pb-2 font-semibold">Status</th>
                    <th className="pb-2 font-semibold">Proof</th>
                    <th className="pb-2 font-semibold">Reaches back to</th>
                    <th className="pb-2 text-right font-semibold">Seen / expected</th>
                  </tr>
                </thead>
                <tbody>
                  {data.planes.map((plane) => (
                    <tr key={`${plane.plane}:${plane.scopeRef}`} className="border-t border-border">
                      <td className="py-2">{plane.plane}</td>
                      <td className="py-2 font-mono text-[12px] text-text-secondary">
                        {plane.scopeRef}
                      </td>
                      <td className="py-2">{plane.status.replace(/_/g, " ")}</td>
                      <td className="py-2 text-text-secondary">
                        {plane.proof.replace(/_/g, " ")}
                      </td>
                      <td className="py-2 tabular-nums">{instant(plane.oldestCapturedAt)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {count(plane.observedUniqueCount)} / {count(plane.expectedCount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Fansly Sync Engine — what it reads
          </h3>
          {data.engine === null ? (
            <AnalyticsEmpty reason="The Fansly Sync Engine does not own this page: nothing reads its data." />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {data.engine.streams.map((stream) => {
                const label = engineLabel(stream);
                return (
                  <div key={stream.stream} className="rounded-lg border border-border p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium text-text-primary">
                        {stream.stream}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          label.tone === "off"
                            ? "border-warning-dark/60 text-warning-dark"
                            : "border-border text-text-muted"
                        }`}
                      >
                        {label.text}
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-text-secondary">
                      <dt className="text-text-muted">Last read</dt>
                      <dd className="tabular-nums">{instant(stream.succeededAt)}</dd>
                      <dt className="text-text-muted">Next due</dt>
                      <dd className="tabular-nums">{instant(stream.nextDueAt)}</dd>
                      {stream.consecutiveFailures > 0 ? (
                        <>
                          <dt className="text-text-muted">Failures</dt>
                          <dd className="tabular-nums text-warning-dark">
                            {count(stream.consecutiveFailures)}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                    {stream.reason ? (
                      <p
                        className={`mt-2 break-words text-[12px] ${
                          stream.needsAttention ? "text-warning-dark" : "text-text-secondary"
                        }`}
                      >
                        {stream.reason}
                      </p>
                    ) : null}
                    <p className="mt-1 break-words font-mono text-[11px] text-text-muted">
                      {stream.resources.join(", ")}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Rows held
          </h3>
          <div className="flex flex-wrap gap-2">
            {holdings.map((row) => (
              <span
                key={row.projection}
                className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-text-secondary"
                title={`${instant(row.oldestAt)} → ${instant(row.newestAt)}`}
              >
                {row.projection}{" "}
                <span className="font-semibold tabular-nums text-text-primary">
                  {row.rowCount.toLocaleString("en-US")}
                </span>
              </span>
            ))}
          </div>
          {empty.length > 0 ? (
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
              Empty here, and named rather than hidden:{" "}
              {empty.map((row) => row.projection).join(", ")}. Zero rows is a fact about
              this system, not about the platform — check what the engine reads above
              before reading any of these as an absence in the world.
            </p>
          ) : null}
        </div>
      </div>
    </AnalyticsPanel>
  );
}

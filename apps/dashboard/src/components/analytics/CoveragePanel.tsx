import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { formatDateTime } from "@/lib/format";

import { AnalyticsEmpty, AnalyticsPanel } from "./AnalyticsPanel.js";

type StreamRow = StatsCoverageResponse["streams"][number];

function instant(value: string | null): string {
  return value === null ? "—" : formatDateTime(value);
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

/**
 * The live long-tail cycle, in words (A16 item 3).
 *
 * Computed by the LANE from the live class census and the live cap, and read
 * off the wire here. Never a documentation constant: at M = 2 000 the tail comes
 * round every 26 days, at M = 5 000 every 96 — and a design that calls the
 * second one "monthly" is telling a lie the plan explicitly forbids.
 */
function cycleSentence(progress: StreamRow["progress"]): string | null {
  const days = progress.estimatedCycleDays;
  if (days === null) {
    return null;
  }
  if (days > 90) {
    return `Long tail comes round every ${Math.round(days)} days — QUARTERLY or worse, not monthly.`;
  }
  if (days > 31) {
    return `Long tail comes round every ${Math.round(days)} days — slower than monthly.`;
  }
  return `Long tail comes round every ${Math.round(days)} days.`;
}

function gateLabel(stream: StreamRow): { text: string; tone: "off" | "on" | "none" } {
  if (stream.flagEnabled === null) {
    return { text: "no ramp gate", tone: "none" };
  }
  if (!stream.flagEnabled) {
    return { text: "flag off", tone: "off" };
  }
  if (stream.allowlisted === false) {
    return { text: "not allowlisted", tone: "off" };
  }
  return { text: "ramped", tone: "on" };
}

/**
 * Panel 8 — the honesty panel.
 *
 * It answers the four questions that make every other panel on this page
 * readable: what do we hold, how far back does it reach, what is the lane
 * allowed to do today, and how long until it comes round again. A chart above
 * with no rows means one thing when its lane is ramped and exhausted, and a
 * completely different thing when its flag is off — and only this panel can
 * tell them apart.
 */
export function CoveragePanel({
  data,
  isLoading,
}: {
  data: StatsCoverageResponse | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <AnalyticsPanel title="Coverage">
        <AnalyticsEmpty reason="Loading…" />
      </AnalyticsPanel>
    );
  }
  if (!data) {
    return (
      <AnalyticsPanel title="Coverage">
        <AnalyticsEmpty reason="No coverage data for this page." />
      </AnalyticsPanel>
    );
  }

  const holdings = data.holdings.filter((row) => row.rowCount > 0);
  const empty = data.holdings.filter((row) => row.rowCount === 0);

  return (
    <AnalyticsPanel
      title="Coverage — what this page actually holds"
      subtitle={
        "Read this before believing any chart above. An empty chart over a ramped, "
        + "exhausted lane means the world was empty; the same chart over a lane whose "
        + "flag is off means nobody looked."
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
            Lanes — gate, budget and backlog
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {data.streams.map((stream) => {
              const gate = gateLabel(stream);
              const cycle = cycleSentence(stream.progress);
              const cap = stream.progress.dailyCap;
              const called = stream.progress.calledToday ?? stream.progress.callsToday;
              return (
                <div key={stream.stream} className="rounded-lg border border-border p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-text-primary">
                      {stream.stream}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        gate.tone === "off"
                          ? "border-warning-dark/60 text-warning-dark"
                          : "border-border text-text-muted"
                      }`}
                    >
                      {gate.text}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-text-secondary">
                    <dt className="text-text-muted">Last success</dt>
                    <dd className="tabular-nums">{instant(stream.succeededAt)}</dd>
                    {cap !== null ? (
                      <>
                        <dt className="text-text-muted">Budget today</dt>
                        <dd className="tabular-nums">
                          {count(called)} / {count(cap)}
                        </dd>
                      </>
                    ) : null}
                    {stream.progress.dueToday !== null ? (
                      <>
                        <dt className="text-text-muted">Due / deferred</dt>
                        <dd className="tabular-nums">
                          {count(stream.progress.dueToday)} / {count(stream.progress.deferredToday)}
                        </dd>
                      </>
                    ) : null}
                    {stream.progress.mediaKnown !== null ? (
                      <>
                        <dt className="text-text-muted">Media known (M)</dt>
                        <dd className="tabular-nums">{count(stream.progress.mediaKnown)}</dd>
                      </>
                    ) : null}
                    {stream.progress.uniqueMediaCount !== null ? (
                      <>
                        <dt className="text-text-muted">Unique media</dt>
                        <dd className="tabular-nums">
                          {count(stream.progress.uniqueMediaCount)}
                          {stream.progress.albumMembershipSum === null ? null : (
                            <span className="ml-1 text-text-muted">
                              (Σ album counts {count(stream.progress.albumMembershipSum)} —
                              double-counts)
                            </span>
                          )}
                        </dd>
                      </>
                    ) : null}
                    {stream.progress.rootsKnown !== null ? (
                      <>
                        <dt className="text-text-muted">Roots walked</dt>
                        <dd className="tabular-nums">
                          {count(stream.progress.rootsWalked)} / {count(stream.progress.rootsKnown)}
                        </dd>
                      </>
                    ) : null}
                    {stream.progress.paginationMode !== null ? (
                      <>
                        <dt className="text-text-muted">Pagination</dt>
                        <dd>
                          {stream.progress.paginationMode}
                          {stream.progress.possiblyTruncated
                            ? ` · ${stream.progress.possiblyTruncated} rows unproven`
                            : ""}
                        </dd>
                      </>
                    ) : null}
                    {stream.blockerKind !== null ? (
                      <>
                        <dt className="text-text-muted">Blocked</dt>
                        <dd className="text-warning-dark">
                          {stream.blockerKind}
                          {stream.blockerCode ? ` (${stream.blockerCode})` : ""}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {cycle ? (
                    <p
                      className={`mt-2 text-[12px] ${
                        (stream.progress.estimatedCycleDays ?? 0) > 90
                          ? "text-warning-dark"
                          : "text-text-secondary"
                      }`}
                    >
                      {cycle}
                      {stream.progress.saturating
                        ? " The lane is spending its whole cap; this is the design, not a fault."
                        : ""}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
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
              this system, not about the platform — check the lane's gate above before
              reading any of these as an absence in the world.
            </p>
          ) : null}
        </div>
      </div>
    </AnalyticsPanel>
  );
}

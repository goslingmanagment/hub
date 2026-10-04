import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { formatDateTime } from "@/lib/format";
import type { AnalyticsPanelState } from "@/pages/analytics-query-state";
import { engineWaitLabel } from "@/pages/settings/engine/engineDisplay";
import { getStreamLabel } from "@/pages/settings/sync/syncBlockDisplay";

import {
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  AnalyticsPanel,
} from "./AnalyticsPanel.js";

type FloorRow = StatsCoverageResponse["planes"][number];
type Engine = NonNullable<StatsCoverageResponse["engine"]>;
type EngineStreamRow = Engine["streams"][number];

/** The panel's time format. An instant of another year carries its year: a
 *  floor two years deep must not read as this autumn's. */
function instant(value: string | null): string {
  return value === null ? "—" : formatDateTime(value, { yearUnlessCurrent: true });
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

/** A floor's scope as a person reads it: the planes kept per page (media
 *  statistics, post replies) store the page's own id there. */
function scopeText(row: FloorRow, pageId: number | null): string {
  return pageId !== null && row.scopeRef === String(pageId) ? "this page" : row.scopeRef;
}

type EngineBadge = { text: string; tone: "off" | "on"; detail: string };

/**
 * The one thing that is true of a stream now. "reading" is a claim, not a
 * default: it takes a host that runs the page and work that is open. Without a
 * host nothing of the page is read, whatever its work says; a stream nothing
 * asked for yet has neither work nor a read.
 */
export function engineStreamBadge(engine: Pick<Engine, "mode" | "ownerRunning">, stream: EngineStreamRow): EngineBadge {
  if (!engine.ownerRunning) {
    return engine.mode === "handover"
      ? {
        text: "not running: switching",
        tone: "off",
        detail: "The page is switching to the engine: nothing of it is read until the switch completes.",
      }
      : { text: "not running: no owner", tone: "off", detail: "No sync host owns the page: nothing of it is read." };
  }
  if (stream.paused) {
    return { text: "paused", tone: "off", detail: "The owner paused the page or every key of this stream." };
  }
  if (stream.needsAttention) {
    return { text: "needs attention", tone: "off", detail: "Some of its work is quarantined or refused by Fansly." };
  }
  if (stream.activeWork > 0) {
    return { text: "reading", tone: "on", detail: "A sync host runs the page and work of this stream is open." };
  }
  return stream.succeededAt === null
    ? { text: "nothing asked yet", tone: "on", detail: "No work has been filed for this stream on this page." }
    : { text: "idle", tone: "on", detail: "No work of this stream is open now; it was read before." };
}

/** Why a stream's earliest work waits, in the words every sync surface uses
 *  for the engine's reasons and the time format of this panel. */
function waitingText(waiting: NonNullable<EngineStreamRow["waiting"]>): string {
  const until = waiting.until === null ? "" : ` until ${instant(waiting.until)}`;
  return `${waiting.resource}: ${engineWaitLabel(waiting.reason, "en")}${until}`;
}

/** A stream's name as the sync tabs give it, as a card title. */
function streamTitle(stream: string): string {
  const label = getStreamLabel(stream);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const FLOOR_HEAD = "pb-2 pr-4 font-semibold last:pr-0";
const FLOOR_CELL = "py-2 pr-4 align-top last:pr-0";

/** The capture floors: a table where its six columns fit, and one labelled
 *  block per floor where they would run together (a phone, a narrow window). */
function CaptureFloors({ rows, pageId }: { rows: readonly FloorRow[]; pageId: number | null }) {
  const floors = rows.map((row) => ({
    key: `${row.plane}:${row.scopeRef}`,
    plane: row.plane,
    scope: scopeText(row, pageId),
    status: row.status.replace(/_/g, " "),
    proof: row.proof.replace(/_/g, " "),
    reachesBackTo: instant(row.oldestCapturedAt),
    seen: `${count(row.observedUniqueCount)} / ${count(row.expectedCount)}`,
  }));
  return (
    <div className="@container overflow-x-auto">
      <table className="hidden w-full text-[13px] @2xl:table" data-floors="table">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted">
            <th className={FLOOR_HEAD}>Plane</th>
            <th className={FLOOR_HEAD}>Scope</th>
            <th className={FLOOR_HEAD}>Status</th>
            <th className={FLOOR_HEAD}>Proof</th>
            <th className={`${FLOOR_HEAD} whitespace-nowrap`}>Reaches back to</th>
            <th className={`${FLOOR_HEAD} whitespace-nowrap text-right`}>Seen / expected</th>
          </tr>
        </thead>
        <tbody>
          {floors.map((floor) => (
            <tr key={floor.key} className="border-t border-border">
              <td className={`${FLOOR_CELL} whitespace-nowrap`}>{floor.plane}</td>
              <td className={`${FLOOR_CELL} break-all font-mono text-[12px] text-text-secondary`}>
                {floor.scope}
              </td>
              <td className={FLOOR_CELL}>{floor.status}</td>
              <td className={`${FLOOR_CELL} text-text-secondary`}>{floor.proof}</td>
              <td className={`${FLOOR_CELL} whitespace-nowrap tabular-nums`}>{floor.reachesBackTo}</td>
              <td className={`${FLOOR_CELL} whitespace-nowrap text-right tabular-nums`}>{floor.seen}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="text-[13px] @lg:grid @lg:grid-cols-2 @lg:gap-x-8 @2xl:hidden" data-floors="list">
        {floors.map((floor) => (
          <li key={floor.key} className="border-t border-border py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium text-text-primary">{floor.plane}</span>
              {floor.scope ? (
                <span className="break-all font-mono text-[12px] text-text-secondary">{floor.scope}</span>
              ) : null}
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-text-secondary">
              <dt className="text-text-muted">Status</dt>
              <dd className="text-text-primary">{floor.status}</dd>
              <dt className="text-text-muted">Proof</dt>
              <dd>{floor.proof}</dd>
              <dt className="text-text-muted">Reaches back to</dt>
              <dd className="tabular-nums">{floor.reachesBackTo}</dd>
              <dt className="text-text-muted">Seen / expected</dt>
              <dd className="tabular-nums">{floor.seen}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EngineStreamCard({ engine, stream }: { engine: Engine; stream: EngineStreamRow }) {
  const badge = engineStreamBadge(engine, stream);
  return (
    <div className="rounded-lg border border-border p-3" data-engine-stream={stream.stream}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-text-primary" title={stream.stream}>
          {streamTitle(stream.stream)}
        </span>
        <span
          title={badge.detail}
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
            badge.tone === "off"
              ? "border-warning-dark/60 text-warning-dark"
              : "border-border text-text-muted"
          }`}
        >
          {badge.text}
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
      {/* What needs attention is the server's sentence (counts, keys and the
          command that lists them); why work waits is worded here. */}
      {stream.needsAttention && stream.reason ? (
        <p className="mt-2 break-words text-[12px] text-warning-dark">{stream.reason}</p>
      ) : stream.waiting ? (
        <p className="mt-2 break-words text-[12px] text-text-secondary">{waitingText(stream.waiting)}</p>
      ) : null}
      <p className="mt-1 break-words font-mono text-[11px] text-text-muted">
        {stream.resources.join(", ")}
      </p>
    </div>
  );
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
  pageId = null,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsCoverageResponse>;
  /** The page's id, to recognise a floor scoped by the page itself. */
  pageId?: number | null;
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
  const engine = data.engine;
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
            <AnalyticsEmpty reason="No capture floors: the engine has recorded none for this page yet." />
          ) : (
            <CaptureFloors rows={data.planes} pageId={pageId} />
          )}
        </div>

        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Fansly Sync Engine — what it reads
          </h3>
          {engine === null ? (
            <AnalyticsEmpty reason="The Fansly Sync Engine does not own this page: nothing reads its data." />
          ) : (
            <>
              {engine.ownerRunning ? null : (
                <p
                  className="mb-3 rounded-lg border border-warning-dark/60 px-3 py-2 text-[12px] text-warning-dark"
                  data-engine-not-running
                >
                  {engine.mode === "handover"
                    ? "The page is switching to the engine (handover): nothing of it is read until the switch completes."
                    : "No sync host owns this page: none of the streams below is being read "
                      + "(pnpm cli sync ownership status)."}
                </p>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {engine.streams.map((stream) => (
                  <EngineStreamCard key={stream.stream} engine={engine} stream={stream} />
                ))}
              </div>
            </>
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

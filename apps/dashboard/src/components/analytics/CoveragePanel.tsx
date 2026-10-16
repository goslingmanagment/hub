import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import type { StatsCoverageResponse } from "@agency_hub_core/contracts";

import { formatDateTime } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import type { AnalyticsPanelState } from "@/pages/analytics-query-state";
import {
  engineReadingState,
  engineReadingTone,
  engineReadingWords,
  engineStopText,
  engineWaitLabel,
} from "@/pages/settings/engine/engineDisplay";
import { getStreamLabel } from "@/pages/settings/sync/syncBlockDisplay";

import {
  AnalyticsEmpty,
  AnalyticsError,
  AnalyticsLoading,
  CachedBadge,
} from "./AnalyticsPanel.js";
import {
  captureProofWords,
  captureStatusWords,
  formatCount,
  planeLabel,
  projectionLabel,
} from "./analytics-words.js";

type FloorRow = StatsCoverageResponse["planes"][number];
type Engine = NonNullable<StatsCoverageResponse["engine"]>;
type EngineStreamRow = Engine["streams"][number];

/** The panel's time format. An instant of another year carries its year: a
 *  floor two years deep must not read as this autumn's. */
function instant(value: string | null): string {
  return value === null ? "—" : formatDateTime(value, { yearUnlessCurrent: true });
}

function count(value: number | null): string {
  return value === null ? "—" : formatCount(value);
}

/** A floor's scope as a person reads it: the planes kept per page (media
 *  statistics, post replies) store the page's own id there, and the account
 *  statistics keep their recent window apart as `steady`. */
function scopeText(row: FloorRow, pageId: number | null): string {
  if (pageId !== null && row.scopeRef === String(pageId)) return "эта страница";
  if (row.scopeRef === "steady") return "свежие данные";
  return row.scopeRef;
}

type EngineBadge = { text: string; tone: "off" | "on"; detail: string };

/**
 * The one thing that is true of a stream now. "reading" is a claim, not a
 * default: it takes a host that runs the page, work that is open and keys
 * nothing stops — by the engine's own hold evaluator (the page's hold, a
 * resource breaker, a 429's hold of the stream's routes) and the owner's
 * pauses, which the server judges key by key (`stopped`, `stops`). Without a
 * host nothing of the page is read, whatever its work says; a stream nothing
 * asked for yet has neither work nor a read.
 */
export function engineStreamBadge(engine: Pick<Engine, "mode" | "ownerRunning">, stream: EngineStreamRow): EngineBadge {
  const state = engineReadingState({
    mode: engine.mode,
    ownerRunning: engine.ownerRunning,
    stopped: stream.stopped,
    stops: stream.stops,
    paused: stream.paused,
    needsAttention: stream.needsAttention,
    activeWork: stream.activeWork,
    everRead: stream.succeededAt !== null,
  });
  // The owner's pause is said as loudly as a hold: the stream is not read.
  const off = engineReadingTone(state) === "warn" || state === "paused";
  return { ...engineReadingWords(state, "ru"), tone: off ? "off" : "on" };
}

/** The reasons a stop says for every key it stops: a stream's waiting line
 *  would only repeat it for one of them. */
const STOP_REASONS: ReadonlySet<string> = new Set(["paused", "page_hold", "resource_hold", "route_hold"]);

/** Why a stream's earliest work waits, in the words every sync surface uses
 *  for the engine's reasons and the time format of this panel. */
function waitingText(waiting: NonNullable<EngineStreamRow["waiting"]>): string {
  const until = waiting.until === null ? "" : ` до ${instant(waiting.until)}`;
  return `${waiting.resource}: ${engineWaitLabel(waiting.reason, "ru")}${until}`;
}

/** What stops keys of a stream, one line a cause; the keys are named unless
 *  it stops them all. */
function stopLines(stream: EngineStreamRow): string[] {
  return stream.stops.map((stop) => engineStopText(stop, {
    language: "ru",
    until: instant,
    listKeys: stop.resources.length < stream.resources.length,
  }));
}

/** What needs the owner, in the server's sentence — without the command line
 *  it may end with: a terminal command is not something this page asks for. */
function attentionText(reason: string): string {
  return reason.split(/;\s*pnpm\s/)[0]!.trim();
}

/** A stream's name as the sync tabs give it, as a card title. */
function streamTitle(stream: string): string {
  const label = getStreamLabel(stream);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** The capture floors: a table where its six columns fit, and one labelled
 *  block per floor where they would run together (a phone, a narrow window). */
function CaptureFloors({ rows, pageId }: { rows: readonly FloorRow[]; pageId: number | null }) {
  const floors = rows.map((row) => ({
    key: `${row.plane}:${row.scopeRef}`,
    plane: row.plane,
    planeLabel: planeLabel(row.plane),
    scope: scopeText(row, pageId),
    status: captureStatusWords(row.status),
    proof: captureProofWords(row.proof),
    reachesBackTo: instant(row.oldestCapturedAt),
    seen: `${count(row.observedUniqueCount)} / ${count(row.expectedCount)}`,
  }));
  return (
    <div className="@container">
      <div className="@2xl:overflow-x-auto @2xl:rounded-[10px] @2xl:border @2xl:border-border">
        <table className="hidden data-table @2xl:table" data-floors="table">
          <thead>
            <tr>
              <th>Раздел</th>
              <th>Область</th>
              <th>Статус</th>
              <th>Подтверждение</th>
              <th>Собрано с</th>
              <th className="num">Получено / ожидалось</th>
            </tr>
          </thead>
          <tbody>
            {floors.map((floor) => (
              <tr key={floor.key}>
                <td className="whitespace-nowrap" title={floor.plane}>{floor.planeLabel}</td>
                <td className="muted break-all">{floor.scope}</td>
                <td>{floor.status}</td>
                <td className="muted">{floor.proof}</td>
                <td className="whitespace-nowrap tabular-nums">{floor.reachesBackTo}</td>
                <td className="num">{floor.seen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="text-[13px] @lg:grid @lg:grid-cols-2 @lg:gap-x-8 @2xl:hidden" data-floors="list">
        {floors.map((floor) => (
          <li key={floor.key} className="border-t border-border-light py-2.5 first:border-t-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium text-text-primary" title={floor.plane}>{floor.planeLabel}</span>
              {floor.scope ? (
                <span className="break-all text-xs text-text-secondary">{floor.scope}</span>
              ) : null}
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-text-secondary">
              <dt className="text-text-muted">Статус</dt>
              <dd className="text-text-primary">{floor.status}</dd>
              <dt className="text-text-muted">Подтверждение</dt>
              <dd>{floor.proof}</dd>
              <dt className="text-text-muted">Собрано с</dt>
              <dd className="tabular-nums">{floor.reachesBackTo}</dd>
              <dt className="text-text-muted">Получено / ожидалось</dt>
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
    <div className="rounded-[10px] bg-hover-alt px-3.5 py-3" data-engine-stream={stream.stream}>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium text-text-primary" title={stream.stream}>
          {streamTitle(stream.stream)}
        </span>
        <span title={badge.detail} className={badge.tone === "off" ? "badge badge-warning" : "badge"}>
          {badge.text}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-text-secondary">
        <dt className="text-text-muted">Последний сбор</dt>
        <dd className="tabular-nums">{instant(stream.succeededAt)}</dd>
        <dt className="text-text-muted">Следующий сбор</dt>
        <dd className="tabular-nums">{instant(stream.nextDueAt)}</dd>
        {stream.consecutiveFailures > 0 ? (
          <>
            <dt className="text-text-muted">Ошибок подряд</dt>
            <dd className="tabular-nums text-warning-dark">
              {count(stream.consecutiveFailures)}
            </dd>
          </>
        ) : null}
      </dl>
      {/* What needs attention is the server's sentence (counts and keys);
          what stops the stream's keys and why its work waits are worded here. */}
      {stream.needsAttention && stream.reason ? (
        <p className="mt-2 break-words text-xs text-warning-dark">{attentionText(stream.reason)}</p>
      ) : null}
      {stopLines(stream).map((line) => (
        <p key={line} className="mt-2 break-words text-xs text-warning-dark" data-engine-stop>{line}</p>
      ))}
      {!stream.needsAttention && stream.waiting && !(stream.stops.length > 0 && STOP_REASONS.has(stream.waiting.reason)) ? (
        <p className="mt-2 break-words text-xs text-text-secondary">{waitingText(stream.waiting)}</p>
      ) : null}
      <p className="mt-1.5 break-words font-mono text-xs text-text-muted">
        {stream.resources.join(", ")}
      </p>
    </div>
  );
}

/** The one line the collapsed card shows: is this page's data being read. */
export function coverageSummary(state: AnalyticsPanelState<StatsCoverageResponse>): string {
  if (state.status === "loading") return "Загружаем сведения о том, какие данные собраны.";
  if (state.status === "error") return "Не удалось загрузить сведения о сборе данных.";
  const engine = state.data.engine;
  if (engine === null) return "Сбор данных Fansly не ведёт эту страницу — новые данные не поступают.";
  if (!engine.ownerRunning) {
    return engine.mode === "handover"
      ? "Страница переключается на новый сбор данных — пока ничего не читается."
      : "Сбор данных остановлен: страницу сейчас никто не читает.";
  }
  const total = engine.streams.length;
  const off = engine.streams.filter((stream) => engineStreamBadge(engine, stream).tone === "off").length;
  const streams = (value: number) => `${formatCount(value)} ${ruPlural(value, "поток", "потока", "потоков")}`;
  if (off === 0) return `Сбор данных работает: ${streams(total)} без остановок.`;
  return `Сбор данных работает с ограничениями: ${formatCount(off)} из ${streams(total)} `
    + "на паузе, удержаны или требуют внимания.";
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-text-primary">{children}</h3>;
}

/**
 * Panel 8 — the honesty panel, collapsed at the bottom of the page.
 *
 * It answers the questions that make every other panel on this page
 * readable: is the Fansly Sync Engine still reading this page's data — when it
 * last did, when it reads next, and why it waits — how far back each kind of
 * data reaches, and what we hold. A chart above with no rows means one thing
 * when its data is read and the world was empty, and a completely different
 * thing when nobody reads it — and only this panel can tell them apart. Its
 * one-line summary stays visible while it is collapsed.
 */
export function CoveragePanel({
  state,
  pageId = null,
  onRetry,
  likers,
}: {
  state: AnalyticsPanelState<StatsCoverageResponse>;
  /** The page's id, to recognise a floor scoped by the page itself. */
  pageId?: number | null | undefined;
  onRetry: () => void;
  /** The likers note: an empty-by-design surface, named here, not in the grid. */
  likers?: ReactNode;
}) {
  return (
    <details className="group card xl:col-span-2" data-coverage>
      <summary className="card-header cursor-pointer list-none border-b-0 group-open:border-b [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="card-title">Покрытие данных</h2>
            {state.status === "ready" && state.refreshFailed ? <CachedBadge /> : null}
          </div>
          <p className="card-description">{coverageSummary(state)}</p>
        </div>
        <span className="flex items-center gap-1 text-[13px] font-medium text-text-secondary">
          <span className="group-open:hidden">Подробнее</span>
          <span className="hidden group-open:inline">Свернуть</span>
          <ChevronDown size={16} aria-hidden="true" className="transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="card-body space-y-7">
        <CoverageBody state={state} pageId={pageId} onRetry={onRetry} />
        {likers}
      </div>
    </details>
  );
}

function CoverageBody({
  state,
  pageId,
  onRetry,
}: {
  state: AnalyticsPanelState<StatsCoverageResponse>;
  pageId: number | null;
  onRetry: () => void;
}) {
  // The old shape took `data | undefined` and mapped `!data` to "No coverage
  // data for this page" — which read a FAILED request, a pending one and a
  // genuinely empty response as the same sentence. On the page that exists to
  // make holes visible, that was the worst possible conflation: the panel that
  // explains every other panel's emptiness was itself lying about its own.
  if (state.status === "loading") {
    return <AnalyticsLoading what="Загружаем сведения о сборе…" />;
  }
  if (state.status === "error") {
    return <AnalyticsError message={state.message} onRetry={onRetry} />;
  }

  const data = state.data;
  const engine = data.engine;
  const holdings = data.holdings.filter((row) => row.rowCount > 0);
  const empty = data.holdings.filter((row) => row.rowCount === 0);

  return (
    <>
      <div>
        <SubTitle>Что сейчас собирается</SubTitle>
        {engine === null ? (
          <AnalyticsEmpty reason="Сбор данных Fansly не ведёт эту страницу: её данные никто не читает." />
        ) : (
          <>
            {engine.ownerRunning ? null : (
              <p className="notice notice-warning mb-3" data-engine-not-running>
                {engine.mode === "handover"
                  ? "Страница переключается на новый сбор данных: пока переключение не закончится, ничего не читается."
                  : "Страницу не ведёт ни один обработчик сбора: ни один поток ниже сейчас не читается."}
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {engine.streams.map((stream) => (
                <EngineStreamCard key={stream.stream} engine={engine} stream={stream} />
              ))}
            </div>
          </>
        )}
      </div>

      <div>
        <SubTitle>Глубина собранных данных</SubTitle>
        {data.planes.length === 0 ? (
          <AnalyticsEmpty reason="Сведений о глубине сбора для этой страницы пока нет." />
        ) : (
          <CaptureFloors rows={data.planes} pageId={pageId} />
        )}
      </div>

      <div>
        <SubTitle>Хранится в Hub</SubTitle>
        {holdings.length === 0 ? (
          <p className="text-[13px] text-text-secondary">Для этой страницы пока ничего не сохранено.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {holdings.map((row) => (
              <span
                key={row.projection}
                className="badge"
                title={`${row.projection}: ${instant(row.oldestAt)} → ${instant(row.newestAt)}`}
              >
                {projectionLabel(row.projection)}{" "}
                <span className="font-semibold tabular-nums text-text-primary">
                  {formatCount(row.rowCount)}
                </span>
              </span>
            ))}
          </div>
        )}
        {empty.length > 0 ? (
          <p className="mt-3 text-xs leading-relaxed text-text-muted">
            Пока пусто: {empty.map((row) => projectionLabel(row.projection)).join(", ")}. Ноль
            записей — это факт о Hub, а не о Fansly: сначала проверьте выше, читается ли
            нужный поток.
          </p>
        ) : null}
      </div>
    </>
  );
}

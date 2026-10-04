import type { ReactNode } from "react";
import {
  engineAgeText,
  historyClosedText,
  historyDepthText,
  historyEtaText,
  historyFansText,
  historyHoldText,
  historyRateText,
  historyReadsText,
  historyReadyPercent,
  historyRequesterText,
  historySlowdownText,
  historyWaitingText,
  openHistoryRequests,
  type EngineHistoryRequest,
} from "./engineDisplay.js";

// History requests of a page (plan §4.3): how many fans are ready, the reads
// made and still needed, and the time left — always the lower bound and the
// estimate, with a hold or a slowdown shown apart from them.

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary">{children}</span>
    </>
  );
}

/** One request: what was asked, its fans, its reads and its time. */
export function HistoryRequestCard({ request, now = Date.now() }: { request: EngineHistoryRequest; now?: number }) {
  const open = request.state === "open";
  const hold = historyHoldText(request, now);
  const slowdown = historySlowdownText(request);
  const waiting = historyWaitingText(request, now);
  const filed = engineAgeText(request.createdAt, now);
  return (
    <li className="rounded-lg border border-border px-3 py-2.5" data-history-request={request.ref}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="font-medium text-text-primary">
          {historyDepthText(request.depth)}
          <span className="font-normal text-text-secondary">
            {" · "}{historyRequesterText(request.requesterKind)}
            {" · "}подана {filed} назад
            {" · "}
            {/* The start of its ref: `pnpm cli sync history status <ref>` takes the whole one. */}
            <code className="text-[11px] text-text-muted" title={request.ref}>{request.ref.slice(0, 8)}</code>
          </span>
        </span>
        <span className="text-text-muted">
          {open
            ? request.queuePosition === null ? "ждёт очереди" : `№ ${request.queuePosition} в очереди страницы`
            : historyClosedText(request, now)}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 max-w-[320px] rounded-full bg-hover-alt overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={request.counts.total}
        aria-valuenow={request.counts.ready}
        aria-label="Готово фанов"
      >
        <div
          className={`h-full rounded-full ${open ? "bg-accent" : "bg-green"}`}
          style={{ width: `${historyReadyPercent(request)}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-text-secondary">{historyFansText(request)}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <Row label="Чтения">{historyReadsText(request)}</Row>
        {open && (
          <>
            <Row label="Время">
              {historyEtaText(request)}
              <span className="ml-1.5 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-text-muted">
                оценка
              </span>
            </Row>
            <Row label="Темп">{historyRateText(request)}</Row>
            {waiting !== null && <Row label="Ждёт">{waiting}</Row>}
          </>
        )}
      </div>
      {open && hold !== null && (
        <p className="mt-2 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning-dark">
          {hold}
        </p>
      )}
      {open && slowdown !== null && <p className="mt-1.5 text-[11px] text-warning-dark">{slowdown}</p>}
    </li>
  );
}

export interface HistoryRequestsState {
  /** Undefined: the list has not loaded (or the session may not read it). */
  requests: readonly EngineHistoryRequest[] | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * The history requests of a page: its open ones in the order the page serves
 * them, then `closed` (the page's detail shows the ones that ended lately).
 * `limit` caps the open ones a list card shows; `more` is where the rest are.
 */
export function HistoryRequestsBlock({
  state,
  closed = [],
  limit,
  more,
  now = Date.now(),
}: {
  state: HistoryRequestsState;
  closed?: readonly EngineHistoryRequest[];
  limit?: number;
  more?: ReactNode;
  now?: number;
}) {
  const open = openHistoryRequests(state.requests ?? []);
  const shown = limit === undefined ? open : open.slice(0, limit);
  const hidden = open.length - shown.length;
  return (
    <section aria-label="Заявки на историю">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
        Заявки на историю{open.length > 0 ? ` · открыто ${open.length}` : ""}
      </p>
      {state.requests === undefined
        ? (
          <p className="text-xs text-text-muted">
            {state.isLoading ? "Загружаем заявки…" : state.isError ? "Заявки не загрузились." : "Заявки недоступны."}
          </p>
        )
        : (
          <>
            {open.length === 0 && <p className="text-xs text-text-muted">Открытых заявок нет.</p>}
            {shown.length > 0 && (
              <ul className="space-y-2">
                {shown.map((request) => <HistoryRequestCard key={request.ref} request={request} now={now} />)}
              </ul>
            )}
            {hidden > 0 && (
              <p className="mt-1.5 text-xs text-text-muted">
                Ещё {hidden}{more ? <> — {more}</> : null}
              </p>
            )}
            {closed.length > 0 && (
              <>
                <p className="mt-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Недавно закрытые
                </p>
                <ul className="space-y-2">
                  {closed.map((request) => <HistoryRequestCard key={request.ref} request={request} now={now} />)}
                </ul>
              </>
            )}
          </>
        )}
    </section>
  );
}

import { Fragment, useState } from "react";
import { Link } from "react-router";
import { useSyncHistoryRequests } from "@/api/queries";
import { Disclosure } from "@/components/ui/Disclosure";
import { KeyValue } from "@/components/ui/KeyValue";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  historyClosedText,
  historyCountsText,
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
} from "@/pages/settings/engine/engineDisplay";
import { RowChevron, WhenCell } from "../shared.js";

/** The server's cap of one history-request read. */
export const OPEN_REQUESTS_LIMIT = 200;

function RequestDetail({ request, now }: { request: EngineHistoryRequest; now: number }) {
  const open = request.state === "open";
  const hold = historyHoldText(request, now);
  const slowdown = historySlowdownText(request);
  const waiting = historyWaitingText(request, now);
  return (
    <div className="sys-detail">
      <KeyValue
        rows={[
          { label: "Чтения", value: historyReadsText(request) },
          ...(open
            ? [
              { label: "Время", value: <>{historyEtaText(request)} <span className="badge">оценка</span></> },
              { label: "Темп", value: historyRateText(request) },
              ...(waiting === null ? [] : [{ label: "Ждёт", value: waiting }]),
            ]
            : []),
        ]}
      />
      {open && hold !== null && <Notice tone="warning">{hold}</Notice>}
      {open && slowdown !== null && <p className="cell-second">{slowdown}</p>}
      <Disclosure label="Подробнее">
        <p>Код заявки: <span className="sys-code">{request.ref}</span></p>
      </Disclosure>
    </div>
  );
}

/** History requests a table: what is read, how far, how long is left (design/screens/system.md §5, block 3). */
export function EngineRequestsTable({ requests, showPage = true, now = Date.now() }: {
  requests: readonly EngineHistoryRequest[];
  showPage?: boolean;
  now?: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const columns = showPage ? 5 : 4;
  return (
    <div className="table-wrap">
      <table className="data-table sys-requests">
        <thead>
          <tr>
            {showPage && <th>Страница</th>}
            <th>Что читаем</th>
            <th>Готово</th>
            <th>Осталось</th>
            <th className="sys-col-opened">Подана</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => {
            const isOpen = open === request.ref;
            const live = request.state === "open";
            const counts = historyCountsText(request);
            return (
              <Fragment key={request.ref}>
                <tr className="sys-click-row" data-history-request={request.ref} onClick={() => setOpen(isOpen ? null : request.ref)}>
                  {showPage && (
                    <td className="whitespace-nowrap">
                      <RowChevron open={isOpen} label={isOpen ? "Свернуть заявку" : "Раскрыть заявку"} onToggle={() => setOpen(isOpen ? null : request.ref)} />
                      <Link to={`/system/collection/${encodeURIComponent(request.pageLabel ?? "")}`} className="sys-row-link">{request.pageLabel ?? "—"}</Link>
                    </td>
                  )}
                  <td>
                    {!showPage && (
                      <RowChevron open={isOpen} label={isOpen ? "Свернуть заявку" : "Раскрыть заявку"} onToggle={() => setOpen(isOpen ? null : request.ref)} />
                    )}
                    {historyDepthText(request.depth)}
                    <span className={`cell-second${showPage ? "" : " sys-indent"}`}>{historyRequesterText(request.requesterKind)}</span>
                  </td>
                  <td className="sys-ready">
                    <span className="sys-ready-line">
                      <span
                        className={`sys-bar${live ? "" : " sys-bar-done"}`}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={request.counts.total}
                        aria-valuenow={request.counts.ready}
                        aria-label="Готово фанов"
                      >
                        <span style={{ width: `${historyReadyPercent(request)}%` }} />
                      </span>
                      <span className="whitespace-nowrap tabular-nums">{historyFansText(request)}</span>
                    </span>
                    {counts && <span className="cell-second">{counts}</span>}
                  </td>
                  <td className="muted">{live ? historyEtaText(request) : historyClosedText(request)}</td>
                  <td className="sys-col-opened">
                    <WhenCell at={request.createdAt} />
                    {live && (
                      <span className="cell-second whitespace-nowrap">
                        {request.queuePosition === null ? "ждёт очереди" : `№ ${request.queuePosition} в очереди страницы`}
                      </span>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="sys-detail-row">
                    <td colSpan={columns}><RequestDetail request={request} now={now} /></td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * «Чтение истории Fansly · открыто N»: the requests the Fansly collection reads, open
 * first in the page's order, the last closed ones folded below. `pageLabel` narrows the
 * read to one page (the page filter, or a page of its own screen).
 */
export function EngineRequestsCard({ pageLabel }: { pageLabel?: string | undefined }) {
  const open = useSyncHistoryRequests({ ...(pageLabel ? { pageLabel } : {}), state: "open", limit: OPEN_REQUESTS_LIMIT });
  const recent = useSyncHistoryRequests({ ...(pageLabel ? { pageLabel } : {}), limit: 50 });
  const openList = openHistoryRequests(open.data?.requests ?? []);
  const closed = (recent.data?.requests ?? []).filter((request) => request.state !== "open");
  return (
    <section className="card" aria-labelledby="engine-requests-title">
      <div className="card-header">
        <div className="min-w-0">
          <h2 id="engine-requests-title" className="card-title">
            Чтение истории Fansly{open.data ? ` · открыто ${openList.length}` : ""}
          </h2>
          <p className="card-description">Заявки, которые читает сбор данных Fansly: сколько фанов готово и сколько осталось.</p>
        </div>
      </div>
      {open.isLoading && !open.data ? (
        <div className="card-body"><Skeleton width={320} /></div>
      ) : !open.data ? (
        <div className="card-body sys-pause-missing">
          <span>Заявки не загрузились.</span>
          <button type="button" className="btn btn-sm" onClick={() => void open.refetch()}>Повторить</button>
        </div>
      ) : openList.length === 0 ? (
        <p className="card-body text-text-secondary">Открытых заявок нет.</p>
      ) : (
        <>
          <EngineRequestsTable requests={openList} />
          {open.data.requests.length >= OPEN_REQUESTS_LIMIT && (
            <p className="card-footer">Открытых заявок больше {OPEN_REQUESTS_LIMIT}: показаны самые новые.</p>
          )}
        </>
      )}
      {closed.length > 0 && (
        <div className="card-body sys-card-tail">
          <Disclosure label="Последние закрытые">
            <EngineRequestsTable requests={closed} />
          </Disclosure>
        </div>
      )}
    </section>
  );
}

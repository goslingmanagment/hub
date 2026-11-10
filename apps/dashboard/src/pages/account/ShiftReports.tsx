import type { AccountReport, AccountReportLine } from "@agency_hub_core/contracts";
import { ChevronDown } from "lucide-react";
import { useSearchParams } from "react-router";

import { useMyReports } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatMills } from "@/lib/format";
import { SHIFT_REPORT_STATUS } from "@/lib/statusWords";
import { REPORT_PERIODS, clockOf, fanOf, kindWord, reasonText, reportDay, reportWindow, savedLine, splitLines } from "./reportsView.js";

// «Отчёт смены» in the cabinet: the chatter's own shift reports as the team's
// chat agent composed them at the end of each shift, read from the agency
// ledger. The newest first, each a card that opens to its sales: what is in the
// total and what was held out, and why. Sales only, no pay.

/** `?days=14|30`; anything else is 14. */
function daysOf(raw: string | null): number {
  const value = Number(raw);
  return REPORT_PERIODS.some((period) => period.days === value) ? value : 14;
}

function LineRow({ line }: { line: AccountReportLine }) {
  const fan = fanOf(line);
  const what = [line.pageLabel, fan, kindWord(line.kind)].filter((part): part is string => part !== null && part !== "");
  return (
    <li className="rp-line" data-held={line.counted ? undefined : ""}>
      <span className="rp-line-time">{clockOf(line.occurredAt)}</span>
      <div className="rp-line-main">
        <p className="rp-line-what">
          {what.join(" · ")}
          {line.added && <span className="rp-added">добавлено вручную</span>}
        </p>
        {line.added && line.what !== "" && <p className="rp-line-note">{line.what}</p>}
        {!line.counted && line.flags.map((flag, index) => <p key={index} className="rp-line-reason">{reasonText(flag)}</p>)}
        {line.notes.map((note, index) => <p key={index} className="rp-line-note">{note}</p>)}
      </div>
      <span className="rp-line-money">{formatMills(line.netMills)}</span>
    </li>
  );
}

function ReportCard({ report }: { report: AccountReport }) {
  const { counted, held } = splitLines(report.lines);
  const status = SHIFT_REPORT_STATUS[report.status];
  return (
    <details className="card rp-report">
      <summary className="rp-summary">
        <div className="rp-head">
          <div className="min-w-0">
            <h2 className="rp-date">
              {reportDay(report.reportDate)}
              <span className="rp-window">{reportWindow(report)}</span>
            </h2>
            <p className="rp-state">
              {status ? <StatusBadge status={status} /> : <StatusBadge tone="off">{report.status}</StatusBadge>}
              {report.status === "draft" && <span>проверь и отправь в Отчётность</span>}
            </p>
          </div>
          <div className="rp-total">
            <span className="rp-total-number">{formatMills(report.totalMills)}</span>
            <ChevronDown size={18} aria-hidden="true" className="rp-chevron" />
          </div>
        </div>
        {report.pages.length > 0 && (
          <ul className="rp-pages" aria-label="По страницам">
            {report.pages.map((page) => (
              <li key={page.pageLabel}>
                <span className="rp-page-label">{page.pageLabel}</span>
                <span className="rp-page-amount">{formatMills(page.amountMills)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="rp-meta">{savedLine(report)}</p>
      </summary>
      <div className="rp-body">
        {counted.length === 0
          ? <p className="rp-none">Продаж в итоге нет.</p>
          : <ul className="rp-lines" aria-label="Вошло в итог">{counted.map((line, index) => <LineRow key={index} line={line} />)}</ul>}
        {held.length > 0 && (
          <section className="rp-held" aria-labelledby={`rp-held-${report.id}`}>
            <h3 id={`rp-held-${report.id}`} className="rp-held-title">Не вошло в итог</h3>
            <ul className="rp-lines">{held.map((line, index) => <LineRow key={index} line={line} />)}</ul>
          </section>
        )}
      </div>
    </details>
  );
}

export function ShiftReports() {
  const [params, setParams] = useSearchParams();
  const days = daysOf(params.get("days"));
  const reports = useMyReports(days);
  const pick = (next: number) => {
    const query = new URLSearchParams(params);
    if (next === 14) query.delete("days");
    else query.set("days", String(next));
    setParams(query, { replace: true });
  };
  const head = (
    <header className="rp-headline">
      <div className="cs-toolbar">
        <h1 className="cs-greeting">Отчёт смены</h1>
        <Segmented
          label="Период"
          value={String(days)}
          onChange={(value) => pick(Number(value))}
          options={REPORT_PERIODS.map((period) => ({ value: String(period.days), label: period.label }))}
        />
      </div>
      <p className="rp-lead">Отчёты, которые собрали в конце твоих смен: продажи по страницам и что не вошло в итог.</p>
    </header>
  );

  if (reports.isLoading) {
    return (
      <div className="rp-page" aria-busy="true">
        {head}
        {[0, 1].map((index) => (
          <section key={index} className="card rp-skeleton" aria-hidden="true">
            <Skeleton width="40%" />
            <div className="mt-3"><Skeleton width="25%" /></div>
            <div className="mt-4"><Skeleton width="60%" /></div>
          </section>
        ))}
      </div>
    );
  }
  if (reports.isError || !reports.data) {
    const unavailable = reports.error instanceof KernelApiError && reports.error.status === 503;
    return (
      <div className="rp-page">
        {head}
        <div className="status-panel empty" role={unavailable ? "status" : "alert"}>
          {unavailable
            ? <p className="empty-title">Отчёты сейчас недоступны, попробуй позже</p>
            : (
              <>
                <p className="empty-title">Hub не ответил</p>
                <p className="empty-text">Отчёты не пришли: они могут быть, просто экран их не получил.</p>
              </>
            )}
          <div className="empty-actions">
            <button type="button" className="btn btn-sm" disabled={reports.isFetching} onClick={() => void reports.refetch()}>Повторить</button>
          </div>
        </div>
      </div>
    );
  }
  const list = reports.data.reports;
  return (
    <div className="rp-page" data-refreshing={reports.isFetching && reports.isPlaceholderData ? "" : undefined}>
      {head}
      {list.length === 0
        ? (
          <div className="status-panel empty">
            <p className="empty-title">Отчётов за этот период нет.</p>
            <p className="empty-text">Отчёт появится здесь, когда его соберут в конце смены.</p>
          </div>
        )
        : list.map((report) => <ReportCard key={report.id} report={report} />)}
    </div>
  );
}

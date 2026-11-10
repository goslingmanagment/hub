import { ChevronDown, RotateCw } from "lucide-react";
import { useSearchParams } from "react-router";
import type { AccountReport, AccountReportLine } from "@agency_hub_core/contracts";
import { Badge, Button, EmptyState, ErrorState, Money, PageLabel, Segmented, Skeleton, type Tone } from "@agency_hub_core/ui";
import {
  REPORT_DRAFT_NEXT,
  REPORT_PERIODS,
  clockOf,
  fanOf,
  kindWord,
  reasonText,
  reportDay,
  reportPeriodOf,
  reportStatusWord,
  reportWindow,
  savedLine,
  splitLines,
} from "@agency_hub_core/ui/shiftReports";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { useMyReports } from "./data";
import "./my-reports.css";

/**
 * Мои отчёты — a chatter's own part of Workboard (owner, 2026-11-10): the
 * reports the team's chat agent composed at the end of each of their shifts,
 * as the agency ledger keeps them — the same as the cabinet's «Отчёт смены».
 * The newest first, each a sheet that opens to its sales: what is in the total,
 * what was held out and why. Sales only: no rates, pay, payouts or debts, and
 * nobody else's. The window is the screen's own, `?days=14|30` (14 without it):
 * the team's period and page filter are not a chatter's.
 */

const STATUS_TONE: Readonly<Record<string, Tone>> = { draft: "warning", posted: "success", superseded: "off" };

/** One sale of a report: when (Moscow), where, from whom, what it is; why it is out of the total; the net amount. */
function LineRow({ line }: { line: AccountReportLine }) {
  const what = [line.pageLabel, fanOf(line), kindWord(line.kind)].filter((part): part is string => part !== null && part !== "");
  return (
    <li className="myr-line">
      <span className="myr-line__time">{clockOf(line.occurredAt)}</span>
      <div className="myr-line__main">
        <p className="myr-line__what">
          <span>{what.join(" · ")}</span>
          {line.added && <Badge tone="neutral">добавлено вручную</Badge>}
        </p>
        {line.added && line.what !== "" && <p className="myr-line__note">{line.what}</p>}
        {!line.counted && line.flags.map((flag, index) => <p key={index} className="myr-line__reason">{reasonText(flag)}</p>)}
        {line.notes.map((note, index) => <p key={index} className="myr-line__note">{note}</p>)}
      </div>
      <Money mills={line.netMills} muted={!line.counted} className="myr-line__money" />
    </li>
  );
}

function ReportSheet({ report }: { report: AccountReport }) {
  const { counted, held } = splitLines(report.lines);
  const sales = counted.length + held.length;
  return (
    <details className="ui-card myr-report">
      <summary className="myr-report__summary">
        <div className="myr-report__head">
          <h2 className="myr-report__date">
            <span className="myr-report__day">{reportDay(report.reportDate)}</span>
            <span className="myr-report__window">{reportWindow(report)}</span>
          </h2>
          <span className="myr-report__total">
            <Money mills={report.totalMills} strong />
            <ChevronDown size={18} strokeWidth={1.75} aria-hidden className="myr-report__chevron" />
          </span>
        </div>
        <p className="myr-report__state">
          <Badge tone={STATUS_TONE[report.status] ?? "off"}>{reportStatusWord(report.status)}</Badge>
          {report.status === "draft" && <span>{REPORT_DRAFT_NEXT}</span>}
        </p>
        {report.pages.length > 0 && (
          <ul className="myr-report__pages" aria-label="По страницам">
            {report.pages.map((page) => (
              <li key={page.pageLabel} className="myr-report__page">
                <PageLabel label={page.pageLabel} />
                <Money mills={page.amountMills} />
              </li>
            ))}
          </ul>
        )}
        <p className="myr-report__saved">{savedLine(report)}</p>
      </summary>
      <div className="myr-report__body">
        {sales === 0 && <p className="myr-report__none">В отчёте нет продаж.</p>}
        {counted.length > 0 && (
          <section aria-labelledby={`myr-counted-${report.id}`}>
            <h3 id={`myr-counted-${report.id}`} className="myr-report__group">Вошло в итог</h3>
            <ul className="myr-lines">{counted.map((line, index) => <LineRow key={index} line={line} />)}</ul>
          </section>
        )}
        {held.length > 0 && (
          <section aria-labelledby={`myr-held-${report.id}`}>
            <h3 id={`myr-held-${report.id}`} className="myr-report__group">Не вошло в итог</h3>
            <ul className="myr-lines">{held.map((line, index) => <LineRow key={index} line={line} />)}</ul>
          </section>
        )}
      </div>
    </details>
  );
}

function ListSkeleton() {
  return (
    <div className="myr-list" aria-busy>
      {[0, 1, 2].map((index) => (
        <div key={index} className="ui-card myr-skeleton" aria-hidden>
          <Skeleton width="45%" height={20} />
          <Skeleton width="30%" />
          <Skeleton width="60%" />
        </div>
      ))}
    </div>
  );
}

export function MyReportsScreen() {
  const [search, setSearch] = useSearchParams();
  const days = reportPeriodOf(search.get("days"));
  const reports = useMyReports(days);
  const pick = (next: number) => setSearch((current) => {
    const query = new URLSearchParams(current);
    query.set("days", String(next));
    return query;
  }, { replace: true });

  const data = reports.data;
  let content;
  if (data) {
    content = data.reports.length === 0 ? (
      <EmptyState title="Отчётов за этот период нет." className="myr-state">
        Отчёт появится здесь, когда его соберут в конце смены.
      </EmptyState>
    ) : (
      <div className="myr-list" data-refreshing={reports.isPlaceholderData ? "" : undefined}>
        {data.reports.map((report) => <ReportSheet key={report.id} report={report} />)}
      </div>
    );
  } else if (reports.isPending) {
    content = <ListSkeleton />;
  } else if (reports.unavailable) {
    content = (
      <EmptyState
        title="Отчёты сейчас недоступны, попробуй позже"
        action={<Button size="sm" icon={RotateCw} loading={reports.isFetching} onClick={() => void reports.refetch()}>Повторить</Button>}
        className="myr-state"
      />
    );
  } else {
    content = (
      <ErrorState onRetry={() => void reports.refetch()} retrying={reports.isFetching} className="myr-state">
        Отчёты не пришли. Это не значит, что их нет: экран их просто не получил.
      </ErrorState>
    );
  }

  return (
    <>
      <ScreenHeader
        title="Мои отчёты"
        actions={(
          <Segmented
            label="Период"
            value={String(days)}
            onChange={(value) => pick(Number(value))}
            options={REPORT_PERIODS.map((period) => ({ value: String(period.days), label: period.label }))}
          />
        )}
        meta="Отчёты, которые собрали в конце твоих смен: продажи по страницам и что не вошло в итог."
        updatedAt={reports.data ? reports.dataUpdatedAt : undefined}
        onRefresh={() => void reports.refetch()}
        refreshing={reports.isFetching}
        stale={reports.isError && reports.data !== undefined}
      />
      <div className="wb-content">{content}</div>
    </>
  );
}

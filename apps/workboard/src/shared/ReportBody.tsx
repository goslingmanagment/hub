import { useLayoutEffect, type CSSProperties, type RefObject } from "react";
import type { AccountReport, AccountReportLine, AccountShiftReport } from "@agency_hub_core/contracts";
import { Badge, Fan, Mark, Money, PageLabel } from "@agency_hub_core/ui";
import { formatDateTime } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { clockOf, kindWord, reasonText, savedLine, splitLines } from "@agency_hub_core/ui/shiftReports";
import "./report.css";

/**
 * A shift's report, opened in its row — the chatter's («Мои смены»). A draft not
 * posted yet: the pages with the draft's amounts (a page at zero too), when it
 * was composed and which version. A posted report: the pages as posted — the
 * post is the report that counts — with the draft's amount beside a page the
 * chatter changed or left out (ReportPages, as the owner's «Отчёты» show them),
 * when it was composed and sent. Then the sales of the draft — what is in the
 * total first, then «Не вошло в итог», each held-out sale with its reason; a post
 * written without the agent has none, and says so. Money, pages and Moscow times
 * as the app shows them.
 */
export function ReportBody({ report }: { report: AccountShiftReport }) {
  // The box takes the cell's width and gives the table none of its own (report.css): an opened report never widens the sheet.
  return <div className="wb-report-box"><ReportContent report={report} /></div>;
}

function ReportContent({ report }: { report: AccountShiftReport }) {
  const saved = savedOf(report);
  if (report.source === "draft") {
    return (
      <div className="wb-report">
        <div className="wb-report__head">
          <ul className="wb-report__pages" aria-label="По страницам">
            {report.pages.map((page) => (
              <li key={page.pageLabel} className={page.amountMills === 0 ? "wb-report__page wb-report__page--zero" : "wb-report__page"}>
                <PageLabel label={page.pageLabel} />
                <Money mills={page.amountMills} muted={page.amountMills === 0} />
              </li>
            ))}
          </ul>
          {saved !== null && <p className="wb-report__saved">{saved}</p>}
        </div>
        <ReportLines report={report} />
      </div>
    );
  }
  const when = [saved, report.postedAt === null ? null : `отправлен ${formatDateTime(report.postedAt)}`].filter((part): part is string => part !== null).join(" · ");
  return (
    <div className="wb-report">
      <div className="wb-report__posted">
        <ReportPages
          pages={report.pages.map((page) => ({ ...page, state: page.postState, diffMills: null }))}
          drafts="changed"
        />
        {when !== "" && <p className="wb-report__saved">{when}</p>}
      </div>
      {report.source === "post"
        ? <p className="wb-report__none">Отчёт написан без Генгара: списка продаж нет.</p>
        : <ReportLines report={report} />}
    </div>
  );
}

/** «собран в 23:54 · версия 2 из 2» of a report with a draft; null — a post written without the agent. */
function savedOf(report: AccountShiftReport): string | null {
  const { savedAt, version, versions } = report;
  return savedAt === null || version === null || versions === null ? null : savedLine({ reportDate: report.reportDate, savedAt, version, versions });
}

/** A page of a posted report as ReportPages shows it. */
export interface ReportPageRow {
  pageLabel: string;
  /** The agent's draft of the page; null — not in a draft. */
  draftMills: number | null;
  /** The page in the post; null — not posted. */
  postedMills: number | null;
  /** posted − draft where the chatter changed it, for the owner's marked column; null — not changed or not shown. */
  diffMills: number | null;
  /** The ledger's state of the page: draft_only — drafted, not in the post. */
  state: string;
}

/**
 * The pages of a posted report — the owner's «Отчёты» and a chatter's «Мои смены» show them alike. Read left to right
 * as it happened: what the agent drafted (quiet), what the chatter changed (`changes`: the owner's marked column),
 * what the post says — strong, at the right edge, under the row's own sum. `drafts`: the draft's column whenever a
 * page was drafted (the owner's), or only when a page's post differs from its draft (the chatter's: a report posted as
 * drafted has nothing to compare).
 */
export function ReportPages({ pages, drafts = "drafted", changes = false }: {
  pages: readonly ReportPageRow[];
  drafts?: "drafted" | "changed";
  changes?: boolean;
}) {
  const drafted = drafts === "drafted"
    ? pages.some((page) => page.draftMills !== null)
    // The ledger's word, to the cent: a draft in thousandths beside its own post in cents is not a change.
    : pages.some((page) => page.draftMills !== null && page.postedMills !== page.draftMills && page.state !== "posted_equal");
  const changed = changes && pages.some((page) => page.diffMills !== null);
  const columns = 1 + Number(drafted) + Number(changed);
  return (
    <div className="wb-report-pages" role="table" aria-label="Страницы отчёта" style={{ "--wb-report-page-columns": columns } as CSSProperties}>
      <div className="wb-report-pages__row wb-report-pages__row--head" role="row">
        <span role="columnheader">Страница</span>
        {drafted && <span role="columnheader">Черновик</span>}
        {changed && <span role="columnheader">Изменено</span>}
        <span role="columnheader">В посте</span>
      </div>
      {pages.map((page) => (
        <div key={page.pageLabel} className="wb-report-pages__row" role="row">
          <span role="cell"><PageLabel label={page.pageLabel} /></span>
          {drafted && <span role="cell">{page.draftMills === null ? <span className="ui-muted">—</span> : <Money mills={page.draftMills} muted={page.postedMills !== null} />}</span>}
          {changed && (
            <span role="cell">
              {page.diffMills !== null && <Mark hint="Чаттер поменял сумму страницы в посте: в оплату идёт сумма поста."><Money mills={page.diffMills} signed /></Mark>}
            </span>
          )}
          <span role="cell">
            {page.postedMills === null
              ? <span className="ui-muted">{page.state === "draft_only" ? "не в посте" : "—"}</span>
              : <Money mills={page.postedMills} strong={page.postedMills !== 0} muted={page.postedMills === 0} />}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The report's sales: «В итоге», then «Не вошло в итог»; none at all is said. */
export function ReportLines({ report }: { report: Pick<AccountReport, "lines"> }) {
  const { counted, held } = splitLines(report.lines);
  if (counted.length + held.length === 0) return <p className="wb-report__none">В отчёте нет продаж.</p>;
  return (
    <div className="wb-report__groups">
      {counted.length > 0 && <Lines title="В итоге" lines={counted} />}
      {held.length > 0 && <Lines title="Не вошло в итог" lines={held} />}
    </div>
  );
}

function Lines({ title, lines }: { title: string; lines: readonly AccountReportLine[] }) {
  return (
    <section className="wb-report__group">
      <h3 className="wb-report__title">
        {title}
        <span className="wb-report__count">{lines.length} {ruPlural(lines.length, "продажа", "продажи", "продаж")}</span>
      </h3>
      <ul className="wb-lines">
        {lines.map((line, index) => <LineRow key={`${line.n ?? "x"}-${index}`} line={line} />)}
      </ul>
    </section>
  );
}

/**
 * One sale: when (Moscow), where, from whom (the app's one way to show a fan:
 * the name, else «фан ·0120» — never the platform's long id), what it is; why
 * it is out of the total; the net amount. An amount added by hand has no fan.
 */
function LineRow({ line }: { line: AccountReportLine }) {
  const kind = kindWord(line.kind);
  const fan = line.fanName.trim() !== "" || line.fanRef.trim() !== "";
  return (
    <li className={line.counted ? "wb-line" : "wb-line wb-line--held"}>
      <span className="wb-line__time">{clockOf(line.occurredAt)}</span>
      <div className="wb-line__main">
        <p className="wb-line__what">
          {line.pageLabel !== "" && <PageLabel label={line.pageLabel} />}
          {fan && <Fan name={line.fanName} fanRef={line.fanRef} className="wb-line__fan" />}
          {kind !== "" && <span className="wb-line__kind">{kind}</span>}
          {line.added && <Badge tone="neutral" className="wb-line__added">добавлено вручную</Badge>}
        </p>
        {line.added && line.what !== "" && <p className="wb-line__note">{line.what}</p>}
        {!line.counted && line.flags.map((flag, index) => <p key={index} className="wb-line__reason">{reasonText(flag)}</p>)}
        {line.notes.map((note, index) => <p key={index} className="wb-line__note">{note}</p>)}
      </div>
      <Money mills={line.netMills} muted={!line.counted} className="wb-line__money" />
    </li>
  );
}

/**
 * Where a table's money column ends, from the table's left edge: an opened
 * report's amounts end there too, right under the row's sum (one right edge).
 * Set as `--wb-report-edge` on the box around the table; measured again
 * whenever the table resizes.
 */
export function useReportEdge(box: RefObject<HTMLDivElement | null>, columnIndex: number) {
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined" || columnIndex < 0) return;
    const update = () => {
      const table = element.querySelector("table");
      const head = table?.querySelectorAll(":scope > thead > tr > th")[columnIndex];
      if (!table || !head) return;
      const edge = Math.round(head.getBoundingClientRect().right - table.getBoundingClientRect().left);
      if (edge > 0) element.style.setProperty("--wb-report-edge", `${edge}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  });
}

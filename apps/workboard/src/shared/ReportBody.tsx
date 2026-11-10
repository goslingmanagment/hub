import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import type { AccountReport, AccountReportLine } from "@agency_hub_core/contracts";
import { Badge, Fan, Money, PageLabel } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { clockOf, kindWord, reasonText, savedLine, splitLines } from "@agency_hub_core/ui/shiftReports";
import "./report.css";

/**
 * A shift's report, opened in its row — one look for the chatter («Мои смены»)
 * and the owner («Выплаты»): the head (by default the pages with their amounts,
 * a page at zero too, and when it was composed and which version), then the
 * sales — what is in the total first, then «Не вошло в итог», each held-out sale
 * with its reason. An amount added by hand says so and why; the agent's notes
 * are quiet lines under their sale. Money, pages and Moscow times as the app
 * shows them. The owner's head is his own (the posted and drafted pages).
 */
export function ReportBody({ report, head }: { report: AccountReport; head?: ReactNode }) {
  return (
    <div className="wb-report">
      {head ?? (
        <div className="wb-report__head">
          <ul className="wb-report__pages" aria-label="По страницам">
            {report.pages.map((page) => (
              <li key={page.pageLabel} className={page.amountMills === 0 ? "wb-report__page wb-report__page--zero" : "wb-report__page"}>
                <PageLabel label={page.pageLabel} />
                <Money mills={page.amountMills} muted={page.amountMills === 0} />
              </li>
            ))}
          </ul>
          <p className="wb-report__saved">{savedLine(report)}</p>
        </div>
      )}
      <ReportLines report={report} />
    </div>
  );
}

/** The report's sales: «В итоге», then «Не вошло в итог»; none at all is said. */
export function ReportLines({ report }: { report: AccountReport }) {
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

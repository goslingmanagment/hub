import type { AccountReport, AccountReportLine } from "@agency_hub_core/contracts";
import { Badge, Fan, Money, PageLabel } from "@agency_hub_core/ui";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { clockOf, kindWord, reasonText, savedLine, splitLines } from "@agency_hub_core/ui/shiftReports";

/**
 * A shift's report, opened in its row: the pages with their amounts (a page at
 * zero too), when it was composed and which version, then the sales — what is
 * in the total first, then «Не вошло в итог», each held-out sale with its
 * reason. An amount added by hand says so and why; the agent's notes are quiet
 * lines under their sale. Money, pages and Moscow times as the app shows them.
 */
export function ReportBody({ report }: { report: AccountReport }) {
  const { counted, held } = splitLines(report.lines);
  return (
    <div className="mys-report">
      <div className="mys-report__head">
        <ul className="mys-report__pages" aria-label="По страницам">
          {report.pages.map((page) => (
            <li key={page.pageLabel} className={page.amountMills === 0 ? "mys-report__page mys-report__page--zero" : "mys-report__page"}>
              <PageLabel label={page.pageLabel} />
              <Money mills={page.amountMills} muted={page.amountMills === 0} />
            </li>
          ))}
        </ul>
        <p className="mys-report__saved">{savedLine(report)}</p>
      </div>
      {counted.length + held.length === 0 ? (
        <p className="mys-report__none">В отчёте нет продаж.</p>
      ) : (
        <div className="mys-report__groups">
          {counted.length > 0 && <Lines title="В итоге" lines={counted} />}
          {held.length > 0 && <Lines title="Не вошло в итог" lines={held} />}
        </div>
      )}
    </div>
  );
}

function Lines({ title, lines }: { title: string; lines: readonly AccountReportLine[] }) {
  return (
    <section className="mys-report__group">
      <h3 className="mys-report__title">
        {title}
        <span className="mys-report__count">{lines.length} {ruPlural(lines.length, "продажа", "продажи", "продаж")}</span>
      </h3>
      <ul className="mys-lines">
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
    <li className={line.counted ? "mys-line" : "mys-line mys-line--held"}>
      <span className="mys-line__time">{clockOf(line.occurredAt)}</span>
      <div className="mys-line__main">
        <p className="mys-line__what">
          {line.pageLabel !== "" && <PageLabel label={line.pageLabel} />}
          {fan && <Fan name={line.fanName} fanRef={line.fanRef} className="mys-line__fan" />}
          {kind !== "" && <span className="mys-line__kind">{kind}</span>}
          {line.added && <Badge tone="neutral" className="mys-line__added">добавлено вручную</Badge>}
        </p>
        {line.added && line.what !== "" && <p className="mys-line__note">{line.what}</p>}
        {!line.counted && line.flags.map((flag, index) => <p key={index} className="mys-line__reason">{reasonText(flag)}</p>)}
        {line.notes.map((note, index) => <p key={index} className="mys-line__note">{note}</p>)}
      </div>
      <Money mills={line.netMills} muted={!line.counted} className="mys-line__money" />
    </li>
  );
}

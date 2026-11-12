import "@agency_hub_core/ui/styles/markdown.css";

import type { AgentReportMeta, AgentReportSection } from "@agency_hub_core/contracts";
import { Markdown } from "@agency_hub_core/ui/components/Markdown";
import { moscowDayOf } from "@agency_hub_core/ui/moscow";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatAgo, formatDateTimeMsk, formatTimeMsk } from "@/lib/format";
import { AGENT_REPORT_STATUS } from "@/lib/statusWords";

/**
 * A page an agent published (package O): its title, when it came by Moscow's
 * clock, a mark when it is older than the validity the agent gave it, and its
 * markdown in the app's own type (packages/ui Markdown). The body is the
 * agent's text: money, dates and periods in it are shown as written.
 */

export const AGENT_REPORT_SECTION_WORD: Readonly<Record<AgentReportSection, string>> = {
  traffic: "Трафик",
  team: "Команда",
  content: "Контент",
  system: "Система",
};

/** «в 09:40 по Москве» today, «11 нояб., 09:40 по Москве» before. */
export function reportMoment(at: string, now: number): string {
  return moscowDayOf(at) === moscowDayOf(now) ? `в ${formatTimeMsk(at)}` : formatDateTimeMsk(at);
}

/** «Обновлено в 09:40 по Москве, 3 ч назад». */
export function reportPublishedLine(report: Pick<AgentReportMeta, "publishedAt">, now: number): string {
  return `Обновлено ${reportMoment(report.publishedAt, now)}, ${formatAgo(report.publishedAt, now)}`;
}

/** The mark of a report against its validity: none without one. */
export function reportFreshness(report: Pick<AgentReportMeta, "stale" | "staleAt">) {
  if (report.staleAt === null) return null;
  return report.stale ? AGENT_REPORT_STATUS.stale : AGENT_REPORT_STATUS.fresh;
}

export function AgentReportCard({ report, body, now, titled = true }: {
  report: AgentReportMeta;
  body: string;
  /** The server's clock of the answer. */
  now: number;
  /** False where the screen's header already names the report. */
  titled?: boolean;
}) {
  const by = report.publishedBy === null ? null : `агент «${report.publishedBy.name}»`;
  return (
    <section className="card min-w-0" aria-label={titled ? undefined : report.title} aria-labelledby={titled ? `report-${report.slug}` : undefined}>
      <header className="card-header">
        <div className="min-w-0">
          {titled && <h2 id={`report-${report.slug}`} className="card-title">{report.title}</h2>}
          <p className="card-description">
            {reportPublishedLine(report, now)}
            {by && ` · ${by}`}
          </p>
          {report.stale && report.staleAt !== null && report.validHours !== null && (
            <p className="card-description">
              Агент обновляет страницу каждые {report.validHours} ч: новая должна была прийти {reportMoment(report.staleAt, now)}.
            </p>
          )}
        </div>
        {report.stale && <StatusBadge status={AGENT_REPORT_STATUS.stale} />}
      </header>
      <div className="card-body">
        <Markdown source={body} headingLevel={3} />
      </div>
    </section>
  );
}

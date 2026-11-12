import { Link, useNavigate } from "react-router";
import { useAgentReports } from "@/api/reports";
import { AGENT_REPORT_SECTION_WORD, reportFreshness } from "@/components/shared/AgentReportCard";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatMomentAgo } from "@/lib/format";
import { pathSegment } from "@agency_hub_core/ui/path";
import { isPlainRowClick } from "@/lib/rowClick";

/**
 * Система → Отчёты агентов: every page an agent published, with when it last
 * came and whether it is older than the validity its agent gave it. A row
 * opens the page. The owner's only (a team lead reads the pages opened to
 * team leads through the same API, not here).
 */
export function AgentReportsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useAgentReports();

  if (!data) return isLoading ? <TableSkeleton rows={4} columns={5} /> : <NoAnswerPanel retry={refetch} />;

  const now = Date.parse(data.serverNow);
  const open = (event: React.MouseEvent<HTMLElement>, slug: string) => {
    if (isPlainRowClick(event)) navigate(`/system/reports/${pathSegment(slug)}`);
  };

  return (
    <div className="space-y-6 sys-screen">
      <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />
      {data.reports.length === 0 ? (
        <StatusPanel
          title="Отчётов пока нет"
          description="Агенты ещё не публиковали страниц. Ключу агента для этого нужно право «Публиковать отчёты»."
          action={<Link to="/system/agent-keys" className="btn btn-sm">Доступ ИИ-агентов</Link>}
        />
      ) : (
        <section className="card" aria-labelledby="agent-reports-title">
          <header className="card-header">
            <div className="min-w-0">
              <h2 id="agent-reports-title" className="card-title">
                Отчёты <span className="team-count">{formatCount(data.reports.length)}</span>
              </h2>
              <p className="card-description">Новые сверху. «Устарел»: агент не прислал новую страницу в срок, который сам назвал.</p>
            </div>
          </header>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Отчёт</th>
                  <th scope="col">Раздел</th>
                  <th scope="col">Кто читает</th>
                  <th scope="col">Обновлено (по Москве)</th>
                  <th scope="col">Состояние</th>
                </tr>
              </thead>
              <tbody>
                {data.reports.map((report) => {
                  const freshness = reportFreshness(report);
                  return (
                    <tr key={report.slug} className="sys-click-row" onClick={(event) => open(event, report.slug)}>
                      <td>
                        <Link to={`/system/reports/${pathSegment(report.slug)}`} className="sys-row-link">{report.title}</Link>
                        <span className="cell-second">
                          {report.publishedBy === null ? "агент неизвестен" : `агент «${report.publishedBy.name}»`} · версия {report.version}
                        </span>
                      </td>
                      <td>{AGENT_REPORT_SECTION_WORD[report.section]}</td>
                      <td>{report.teamLeads ? "Владелец и тимлиды" : "Владелец"}</td>
                      <td className="muted whitespace-nowrap">{formatMomentAgo(report.publishedAt, now)}</td>
                      <td className="status-col">
                        {freshness === null
                          ? <span className="muted">Срок не задан</span>
                          : <StatusBadge status={freshness} title={report.validHours === null ? undefined : `Агент обновляет каждые ${report.validHours} ч`} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

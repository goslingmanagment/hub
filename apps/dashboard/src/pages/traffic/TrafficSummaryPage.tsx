import { Link } from "react-router";
import { KernelApiError } from "@/api/sdk";
import { useAgentReport } from "@/api/reports";
import { AgentReportCard } from "@/components/shared/AgentReportCard";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";

/** The slug the traffic routine publishes its daily summary under. */
export const TRAFFIC_REPORT_SLUG = "traffic";

/**
 * Трафик → Сводка: the traffic routine's daily summary. traffic-control stays
 * on the owner's Mac (its inputs live there); its agent publishes the board
 * here as a report page, and this screen shows it as it came.
 */
export function TrafficSummaryPage() {
  const query = useAgentReport(TRAFFIC_REPORT_SLUG);
  const { data, error, isLoading, isError, refetch, dataUpdatedAt } = query;

  if (!data) {
    if (error instanceof KernelApiError && error.status === 404) {
      return (
        <StatusPanel
          title="Сводки пока нет"
          description="Агент трафика ещё не присылал сводку. Она появится здесь после его следующего прогона."
          action={<Link to="/system/reports" className="btn btn-sm">Все отчёты агентов</Link>}
        />
      );
    }
    return isLoading ? <TableSkeleton rows={8} columns={4} /> : <NoAnswerPanel retry={refetch} />;
  }

  return (
    <div className="space-y-6">
      <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />
      <AgentReportCard report={data.report} body={data.report.body} now={Date.parse(data.serverNow)} />
    </div>
  );
}

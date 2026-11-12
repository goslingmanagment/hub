import { Link, useParams } from "react-router";
import { KernelApiError } from "@/api/sdk";
import { useAgentReport } from "@/api/reports";
import { AgentReportCard } from "@/components/shared/AgentReportCard";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { PageHeader } from "@/components/ui/PageHeader";

/** Система → Отчёты агентов → one page, as its agent published it. */
export function AgentReportPage() {
  const { slug } = useParams<{ slug: string }>();
  const { data, error, isLoading, isError, refetch, dataUpdatedAt } = useAgentReport(slug);

  if (!data) {
    if (error instanceof KernelApiError && (error.status === 404 || error.status === 400)) {
      return (
        <>
          <PageHeader title="Отчёт не найден" />
          <StatusPanel
            title="Отчёт не найден"
            description="Такой страницы агент не публиковал. Возможно, ссылка устарела или в ней опечатка."
            action={<Link to="/system/reports" className="btn btn-sm">Все отчёты агентов</Link>}
          />
        </>
      );
    }
    return isLoading ? <TableSkeleton rows={8} columns={4} /> : <NoAnswerPanel retry={refetch} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title={data.report.title} />
      <QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} />
      <AgentReportCard report={data.report} body={data.report.body} now={Date.parse(data.serverNow)} titled={false} />
    </div>
  );
}

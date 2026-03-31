import { toast } from "sonner";
import { useReportHistory, useReportPreview, useSendReport } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatDateTime } from "@/lib/format";

export function NotificationsReportsTab() {
  const { data: preview, refetch: fetchPreview, isFetching: previewLoading } = useReportPreview();
  const sendReport = useSendReport();
  const { data: history, isLoading: historyLoading, isError: historyError } = useReportHistory();

  function handlePreview() {
    void fetchPreview();
  }

  function handleSendNow() {
    sendReport.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Report sent");
        } else {
          toast.error(result.error ?? "Failed to send report");
        }
      },
      onError: () => toast.error("Failed to send report"),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={handlePreview}
          disabled={previewLoading}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
        >
          {previewLoading ? "Loading..." : "Preview Next Report"}
        </button>
        <button
          onClick={handleSendNow}
          disabled={sendReport.isPending}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {sendReport.isPending ? "Sending..." : "Send Now"}
        </button>
      </div>

      {preview && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] text-text-muted">Preview for {preview.reportDate}</div>
          <pre className="whitespace-pre-wrap rounded-lg bg-hover p-3 font-mono text-[12px] text-text-primary">
            {preview.text}
          </pre>
        </div>
      )}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Report History</h3>
        {historyLoading ? (
          <StatusPanel title="Loading report history" description="Fetching recent notification reports." />
        ) : historyError || !history ? (
          <StatusPanel
            title="Report history failed to load"
            description="The notification report history could not be fetched."
            tone="error"
          />
        ) : history.items.length === 0 ? (
          <StatusPanel
            title="No reports sent yet"
            description="Enable daily reports in the Settings tab to start receiving revenue summaries."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Date</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Kind</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Status</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Error</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Sent At</th>
                </tr>
              </thead>
              <tbody>
                {history.items.map((item) => (
                  <tr key={item.id} className="border-t border-border hover:bg-hover">
                    <td className="px-4 py-2.5 text-[13px] font-medium tabular-nums text-text-primary">{item.reportDate ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-secondary">
                      {item.kind === "daily_report_scheduled" ? "Scheduled" : "Manual"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[12px] font-medium ${item.status === "sent" ? "text-green" : "text-danger"}`}>
                        {item.status === "sent" ? "Sent" : "Failed"}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-[12px] text-text-muted">{item.error ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{formatDateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}


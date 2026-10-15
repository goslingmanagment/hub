import { toast } from "sonner";
import { useReportHistory, useReportPreview, useSendReport } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatDateTime } from "@/lib/format";

/** The daily revenue report: what the next one says, send one now, and what was sent. */
export function NotificationsReportsTab() {
  const { data: preview, refetch: fetchPreview, isFetching: previewLoading, isError: previewError, error: previewErrorValue } = useReportPreview();
  const sendReport = useSendReport();
  const { data: history, isLoading: historyLoading, isError: historyError, error: historyErrorValue } = useReportHistory();

  function handlePreview() {
    void fetchPreview();
  }

  function handleSendNow() {
    sendReport.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Отчёт отправлен");
        } else {
          toast.error(result.error ?? "Отчёт не отправился");
        }
      },
      onError: () => toast.error("Отчёт не отправился"),
    });
  }

  return (
    <section className="card" aria-labelledby="daily-report-title">
      <div className="card-header">
        <div>
          <h3 id="daily-report-title" className="card-title">Ежедневный отчёт</h3>
          <p className="card-description">Предпросмотр и отправка в Telegram вручную.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={handlePreview} disabled={previewLoading} className="btn btn-sm">
            {previewLoading ? "Загружаем…" : "Показать следующий отчёт"}
          </button>
          <button type="button" onClick={handleSendNow} disabled={sendReport.isPending} className="btn btn-primary btn-sm">
            {sendReport.isPending ? "Отправляем…" : "Отправить сейчас"}
          </button>
        </div>
      </div>

      {(previewError || preview) && (
        <div className="card-body space-y-3 border-b border-border">
          {previewError && (
            <StatusPanel
              tone="error"
              title={preview ? "Не удалось обновить предпросмотр — ниже прежний" : "Предпросмотр не загрузился"}
              description={previewErrorValue instanceof Error ? previewErrorValue.message : "Нажмите «Показать следующий отчёт» ещё раз."}
            />
          )}
          {preview && (
            <div>
              <div className="mb-2 text-[13px] text-text-secondary">Отчёт за {preview.reportDate}</div>
              <pre className="whitespace-pre-wrap rounded-lg bg-hover-alt p-3 font-mono text-[13px] text-text-primary">
                {preview.text}
              </pre>
            </div>
          )}
        </div>
      )}

      <div>
        <h4 className="px-5 pb-2 pt-4 text-sm font-semibold text-text-primary">История отправок</h4>
        {historyError && history && <StaleDataNotice error={historyErrorValue} className="mx-5 mb-3" />}
        {historyLoading && !history ? (
          <p className="px-5 pb-5 text-[13px] text-text-secondary">Загружаем историю…</p>
        ) : !history ? (
          <div className="px-5 pb-5">
            <StatusPanel
              title="История отправок не загрузилась"
              description="Сервер не ответил. Попробуйте обновить страницу."
              tone="error"
            />
          </div>
        ) : history.items.length === 0 ? (
          <p className="px-5 pb-5 text-[13px] text-text-secondary">
            Отчёты ещё не отправлялись. Здесь появится каждая отправка — по расписанию или вручную.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>За день</th>
                  <th>Как</th>
                  <th>Статус</th>
                  <th>Отправлен</th>
                </tr>
              </thead>
              <tbody>
                {history.items.map((item) => (
                  <tr key={item.id}>
                    <td className="font-medium tabular-nums">{item.reportDate ?? "—"}</td>
                    <td className="muted">{item.kind === "daily_report_scheduled" ? "По расписанию" : "Вручную"}</td>
                    <td>
                      <span className={item.status === "sent" ? "badge badge-success" : "badge badge-danger"} title={item.error ?? undefined}>
                        {item.status === "sent" ? "Отправлен" : "Ошибка"}
                      </span>
                      {item.error && <div className="mt-0.5 max-w-[320px] truncate text-xs text-text-secondary" title={item.error}>{item.error}</div>}
                    </td>
                    <td className="muted whitespace-nowrap">{formatDateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

import { useRef } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useReportHistory, useReportPreview, useSendReport, useNotificationsSettings } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { formatDateTime } from "@/lib/format";
import { NotificationDeliveryNotice } from "./NotificationDeliveryNotice.js";

export function NotificationsReportsTab() {
  const { data: preview, refetch: fetchPreview, isFetching: previewLoading, isError: previewError } = useReportPreview();
  const settings = useNotificationsSettings();
  const sendReport = useSendReport();
  const inFlight = useRef(false);
  const { data: history, isLoading: historyLoading, isError: historyError, refetch: refreshHistory } = useReportHistory();

  function handlePreview() {
    void fetchPreview();
  }

  function handleSendNow() {
    if (inFlight.current || sendReport.isPending || sendReport.deliveryBlocked || !settings.data?.configured || settings.isError) return;
    inFlight.current = true;
    sendReport.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Отчёт отправлен");
        } else {
          toast.error(result.error ?? "Telegram не подтвердил отправку отчёта");
        }
      },
      onError: () => { toast.error("Не удалось получить результат отправки. Сохранённый исход показан на экране."); },
      onSettled: () => { inFlight.current = false; },
    });
  }

  return (
    <div className="space-y-6">
      <NotificationDeliveryNotice current={sendReport.delivery} history={sendReport.deliveryHistory} error={sendReport.deliveryError} pending={sendReport.isPending} onRefresh={() => { void Promise.all([settings.refetch(), refreshHistory()]).then(() => sendReport.recoverDelivery()); }} onAllowSeparate={sendReport.allowSeparateDelivery} />
      <div className="space-y-2">
        <p className="text-sm text-text-secondary">{settings.data ? settings.data.configured ? `Отчёт отправится в Telegram: чат ${settings.data.chatId}.` : "Для отправки отчёта нужно подключение Telegram." : settings.isLoading ? "Проверяем получателя отчёта…" : "Получатель отчёта пока неизвестен."} <Link className="text-accent underline" to="/notifications?tab=settings">Проверить подключение</Link></p>
        <QueryNotice error={settings.isError} stale={settings.data !== undefined} retry={() => settings.refetch()} />
        <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handlePreview}
          disabled={previewLoading}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
        >
          {previewLoading ? "Загружаем…" : "Предпросмотр отчёта"}
        </button>
        <button
          onClick={handleSendNow}
          disabled={sendReport.isPending || sendReport.deliveryBlocked || !settings.data?.configured || settings.isError}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          {sendReport.isPending ? "Отправляем…" : "Отправить отчёт в Telegram"}
        </button>
        </div>
      </div>
      <QueryNotice error={previewError} stale={preview !== undefined} retry={fetchPreview} />

      {preview && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] text-text-muted">Отчёт за {preview.reportDate}</div>
          <pre className="whitespace-pre-wrap rounded-lg bg-hover p-3 font-mono text-[12px] text-text-primary">
            {preview.text}
          </pre>
        </div>
      )}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-text-primary">История отправок</h3>
        <QueryNotice error={historyError} stale={history !== undefined} retry={refreshHistory} />
        {historyLoading && !history ? (
          <StatusPanel title="Загружаем историю отчётов…" description="Получаем последние попытки отправки." />
        ) : !history ? (
          <StatusPanel
            title="Не удалось загрузить историю"
            description="Повторите запрос с помощью кнопки выше."
            tone="error"
          />
        ) : history.items.length === 0 ? (
          <StatusPanel
            title={historyError ? "Предыдущий ответ не содержал попыток отправки" : "Попыток отправки ещё не было"}
            description={historyError ? "Текущая история не подтверждена. Повторите чтение перед новой отправкой." : "Включите ежедневный отчёт в настройках или отправьте его вручную."}
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Дата отчёта</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Запуск</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Статус</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Причина</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Создано</th>
                </tr>
              </thead>
              <tbody>
                {history.items.map((item) => (
                  <tr key={item.id} className="border-t border-border hover:bg-hover">
                    <td className="px-4 py-2.5 text-[13px] font-medium tabular-nums text-text-primary">{item.reportDate ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-secondary">
                      {item.kind === "daily_report_scheduled" ? "По расписанию" : "Вручную"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[12px] font-medium ${item.status === "sent" ? "text-green" : "text-danger"}`}>
                        {item.status === "sent" ? "Отправлен" : item.status === "skipped" ? "Не отправлен" : item.status === "failed" ? "Ошибка" : "Исход не подтверждён"}
                      </span>
                    </td>
                    <td className="min-w-48 max-w-xs px-4 py-2.5 text-[12px] text-text-muted">{item.error ? <details><summary className="cursor-pointer">Показать причину</summary><p className="mt-2 break-words">{item.error}</p></details> : "—"}</td>
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

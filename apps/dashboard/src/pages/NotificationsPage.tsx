import { useState, useRef } from "react";
import { toast } from "sonner";
import {
  useNotificationsSettings,
  useUpdateNotificationsSettings,
  useSendTestMessage,
  useNotificationIncidents,
  useResolveIncident,
  useReportPreview,
  useSendReport,
  useReportHistory,
} from "@/api/queries";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

type Tab = "settings" | "incidents" | "reports";

const tabs: { key: Tab; label: string }[] = [
  { key: "settings", label: "Settings" },
  { key: "incidents", label: "Incidents" },
  { key: "reports", label: "Reports" },
];

export function NotificationsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("settings");

  return (
    <div>
      <h1 className="text-xl font-extrabold text-text-primary mb-5">Notifications</h1>

      <div className="mb-5 flex items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "settings" && <SettingsTab />}
      {activeTab === "incidents" && <IncidentsTab />}
      {activeTab === "reports" && <ReportsTab />}
    </div>
  );
}

function SettingsTab() {
  const { data, isLoading } = useNotificationsSettings();
  const updateSettings = useUpdateNotificationsSettings();
  const sendTest = useSendTestMessage();
  const botTokenRef = useRef<HTMLInputElement>(null);
  const chatIdRef = useRef<HTMLInputElement>(null);

  if (isLoading || !data) {
    return <div className="py-12 text-center text-sm text-text-muted">Loading...</div>;
  }

  function handleToggle(field: "enabled" | "dailyReportEnabled" | "syncFailureAlertsEnabled", value: boolean) {
    updateSettings.mutate({ [field]: value });
  }

  function handleReportHourChange(hour: number) {
    updateSettings.mutate({ reportHourUtc: hour });
  }

  function handleSaveCredentials() {
    const botToken = botTokenRef.current?.value?.trim() || undefined;
    const chatId = chatIdRef.current?.value?.trim() || undefined;

    // First-time setup: both required
    if (!data.configured && (!botToken || !chatId)) {
      toast.error("Both fields are required");
      return;
    }

    // Edit: at least one must be provided
    if (!botToken && !chatId) {
      toast.error("Nothing to update");
      return;
    }

    updateSettings.mutate({ botToken, chatId }, {
      onSuccess: () => {
        toast.success("Credentials saved");
        if (botTokenRef.current) botTokenRef.current.value = "";
      },
      onError: () => toast.error("Failed to save credentials"),
    });
  }

  function handleSendTest() {
    sendTest.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === "sent") {
          toast.success("Test message sent");
        } else {
          toast.error(result.error ?? "Failed to send test message");
        }
      },
      onError: () => toast.error("Failed to send test message"),
    });
  }

  return (
    <div className="space-y-4">
      {/* Credentials / Connection */}
      {!data.configured ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-1">Connect Telegram</h3>
          <p className="text-[12px] text-text-muted mb-4">
            Create a bot via @BotFather, paste the token below. Send any message to the bot, then find your chat ID at{" "}
            <span className="font-mono">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</span>
          </p>
          <div className="space-y-3 max-w-md">
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1">Bot Token</label>
              <input
                ref={botTokenRef}
                type="password"
                placeholder="7123456789:AAH..."
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-text-secondary mb-1">Chat ID</label>
              <input
                ref={chatIdRef}
                type="text"
                defaultValue={data.chatId ?? ""}
                placeholder="123456789 or -100..."
                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
            <button
              onClick={handleSaveCredentials}
              disabled={updateSettings.isPending}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {updateSettings.isPending ? "Saving..." : "Save & Connect"}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`h-2.5 w-2.5 rounded-full ${
              data.connectionStatus === "connected" ? "bg-green"
                : data.connectionStatus === "last_message_failed" ? "bg-danger"
                : "bg-text-muted"
            }`} />
            <div>
              <span className="text-sm font-medium text-text-primary">
                {data.connectionStatus === "connected" ? "Connected" : "Last message failed"}
              </span>
              {data.chatId && (
                <span className="ml-2 text-[12px] text-text-muted">
                  Chat {data.chatId}
                </span>
              )}
              {data.lastMessageAt && (
                <span className="ml-2 text-[12px] text-text-muted">
                  &middot; {formatRelativeTime(data.lastMessageAt)}
                </span>
              )}
              {data.lastMessageError && (
                <p className="text-[12px] text-danger mt-0.5">{data.lastMessageError}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CredentialsEdit chatId={data.chatId} onSave={handleSaveCredentials} botTokenRef={botTokenRef} chatIdRef={chatIdRef} isPending={updateSettings.isPending} />
            <button
              onClick={handleSendTest}
              disabled={sendTest.isPending}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              {sendTest.isPending ? "Sending..." : "Send Test"}
            </button>
          </div>
        </div>
      )}

      {/* Kill switch */}
      <ToggleRow
        label="Notifications Enabled"
        description="When off, blocks automatic incident alerts and scheduled daily reports. Manual actions still work."
        checked={data.enabled}
        onChange={(v) => handleToggle("enabled", v)}
      />

      {/* Report hour */}
      <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">Report Hour (UTC)</div>
          <div className="text-[12px] text-text-muted">Hour when the daily revenue report is sent</div>
        </div>
        <select
          value={data.reportHourUtc}
          onChange={(e) => handleReportHourChange(Number(e.target.value))}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          {Array.from({ length: 24 }, (_, i) => (
            <option key={i} value={i}>{String(i).padStart(2, "0")}:00 UTC</option>
          ))}
        </select>
      </div>

      {/* Individual toggles */}
      <ToggleRow
        label="Daily Revenue Report"
        description="Send a daily revenue summary via Telegram"
        checked={data.dailyReportEnabled}
        onChange={(v) => handleToggle("dailyReportEnabled", v)}
      />

      <ToggleRow
        label="Sync Failure Alerts"
        description="Send alerts when sync incidents open or resolve"
        checked={data.syncFailureAlertsEnabled}
        onChange={(v) => handleToggle("syncFailureAlertsEnabled", v)}
      />
    </div>
  );
}

function CredentialsEdit({ chatId, onSave, botTokenRef, chatIdRef, isPending }: {
  chatId: string | null;
  onSave: () => void;
  botTokenRef: React.RefObject<HTMLInputElement | null>;
  chatIdRef: React.RefObject<HTMLInputElement | null>;
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover"
      >
        Edit Credentials
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20" onClick={() => setOpen(false)}>
      <div className="bg-card border border-border rounded-xl p-5 w-full max-w-md shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Update Telegram Credentials</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1">Bot Token</label>
            <input
              ref={botTokenRef}
              type="password"
              placeholder="Paste new token (leave empty to keep current)"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1">Chat ID</label>
            <input
              ref={chatIdRef}
              type="text"
              defaultValue={chatId ?? ""}
              placeholder="123456789"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => { onSave(); setOpen(false); }}
            disabled={isPending}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
      <div>
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div className="text-[12px] text-text-muted">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          checked ? "bg-accent" : "bg-border"
        }`}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`} />
      </button>
    </div>
  );
}

function IncidentsTab() {
  const [status, setStatus] = useState<string | undefined>();
  const [kind, setKind] = useState<string | undefined>();
  const [pageLabel, setPageLabel] = useState<string | undefined>();
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const { data, isLoading } = useNotificationIncidents({
    status,
    kind,
    pageLabel,
    limit: LIMIT,
    offset,
  });
  const resolveIncident = useResolveIncident();

  function handleResolve(incidentId: number) {
    resolveIncident.mutate(incidentId, {
      onSuccess: () => toast.success("Incident resolved"),
      onError: () => toast.error("Failed to resolve incident"),
    });
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={status ?? ""}
          onChange={(e) => { setStatus(e.target.value || undefined); setOffset(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>

        <select
          value={kind ?? ""}
          onChange={(e) => { setKind(e.target.value || undefined); setOffset(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">All Types</option>
          <option value="auth_failed">Auth Failed</option>
          <option value="proxy_failed">Proxy Failed</option>
          <option value="stream_failed_threshold">Stream Failed 3x</option>
        </select>

        <input
          type="text"
          placeholder="Filter by page..."
          value={pageLabel ?? ""}
          onChange={(e) => { setPageLabel(e.target.value || undefined); setOffset(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted w-48"
        />
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-text-muted">Loading...</div>
      ) : !data || data.items.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-muted">No incidents found.</div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-hover-alt">
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Status</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Page</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Type</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Stream</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Opened</th>
                  <th className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase text-text-muted tracking-wider">Error</th>
                  <th className="px-4 py-2.5 text-right text-[12px] font-semibold uppercase text-text-muted tracking-wider">Alerts</th>
                  <th className="px-4 py-2.5 text-[12px] font-semibold uppercase text-text-muted tracking-wider" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} className="border-t border-border hover:bg-hover">
                    <td className="px-4 py-2.5">
                      <div className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${
                        item.status === "open" ? "text-danger" : "text-green"
                      }`}>
                        <div className={`h-2 w-2 rounded-full ${item.status === "open" ? "bg-danger" : "bg-green"}`} />
                        {item.status === "open" ? "Open" : "Resolved"}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-[13px] text-text-primary font-medium">{item.pageLabel}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-secondary">{kindLabel(item.kind)}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{item.stream ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{formatRelativeTime(item.openedAt)}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted max-w-[200px] truncate">{item.errorSummary ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted text-right tabular-nums">{item.notificationCount}</td>
                    <td className="px-4 py-2.5 text-right">
                      {item.status === "open" && (
                        <button
                          onClick={() => handleResolve(item.id)}
                          disabled={resolveIncident.isPending}
                          className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-text-secondary hover:bg-hover disabled:opacity-40"
                        >
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.total > LIMIT && (
            <div className="mt-3 flex items-center justify-between text-[12px] text-text-muted">
              <span>{offset + 1}–{Math.min(offset + LIMIT, data.total)} of {data.total}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                  disabled={offset === 0}
                  className="px-2.5 py-1 rounded border border-border disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset(offset + LIMIT)}
                  disabled={offset + LIMIT >= data.total}
                  className="px-2.5 py-1 rounded border border-border disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function kindLabel(kind: string) {
  switch (kind) {
    case "auth_failed": return "Auth Failed";
    case "proxy_failed": return "Proxy Failed";
    case "stream_failed_threshold": return "Stream Failed 3x";
    default: return kind;
  }
}

function ReportsTab() {
  const { data: preview, refetch: fetchPreview, isFetching: previewLoading } = useReportPreview();
  const sendReport = useSendReport();
  const { data: history, isLoading: historyLoading } = useReportHistory();

  function handlePreview() {
    fetchPreview();
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
      {/* Actions */}
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

      {/* Preview */}
      {preview && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-[12px] text-text-muted mb-2">Preview for {preview.reportDate}</div>
          <pre className="text-[12px] text-text-primary whitespace-pre-wrap font-mono bg-hover rounded-lg p-3">
            {preview.text}
          </pre>
        </div>
      )}

      {/* History */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">Report History</h3>
        {historyLoading ? (
          <div className="py-8 text-center text-sm text-text-muted">Loading...</div>
        ) : !history || history.items.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-muted">No reports sent yet.</div>
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
                    <td className="px-4 py-2.5 text-[13px] text-text-primary font-medium tabular-nums">{item.reportDate ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-secondary">
                      {item.kind === "daily_report_scheduled" ? "Scheduled" : "Manual"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[12px] font-medium ${item.status === "sent" ? "text-green" : "text-danger"}`}>
                        {item.status === "sent" ? "Sent" : "Failed"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted max-w-[200px] truncate">{item.error ?? "—"}</td>
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

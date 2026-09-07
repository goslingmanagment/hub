import { useState } from "react";
import type { NotificationsIncidentItem } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import { useNotificationIncidents, useResolveIncident } from "@/api/queries";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { formatRelativeTime } from "@/lib/format";

const LIMIT = 50;

type IncidentKind = NotificationsIncidentItem["kind"];

const INCIDENT_KIND_LABELS = {
  auth_blocked: "Auth Blocked",
  proxy_failed: "Proxy Failed",
  proxy_missing: "Proxy Missing",
  stream_failed_threshold: "Stream Failed 3x",
  ofapi_auth: "OFAPI Auth",
  ofapi_binding_conflict: "OFAPI Binding Conflict",
  ofapi_low_credit: "OFAPI Low Credit",
  ofapi_webhook_silence: "OFAPI Webhook Silence",
  ofapi_burn_rate: "OFAPI Burn Rate",
  db_disk_usage: "Database Disk Usage",
  observations_partitions: "Observations Partitions",
  wrong_transactions_writer: "Wrong Transactions Writer",
  read_gateway_capture: "Read Gateway Capture",
  golden_signal_lag: "Golden Signal Lag",
  scheduler_silent: "Scheduler Silent",
  ops_sampler_silent: "Ops Sampler Silent",
  ofapi_chargebacks_reconcile_failed: "OFAPI Chargebacks Reconcile",
  ofapi_link_stats_reconcile_failed: "OFAPI Link Stats Reconcile",
  ai_provider_billing: "AI Provider Billing",
  ai_provider_failed: "AI Provider Failed",
  capture_payload_parity: "Capture Payload Parity",
} satisfies Record<IncidentKind, string>;

function deliveryState(item: NotificationsIncidentItem): {
  label: string;
  className: string;
  title?: string;
} {
  switch (item.outboxState) {
    case null:
      return {
        label: String(item.notificationCount),
        className: "text-text-muted",
      };
    case "pending":
      return {
        label: `Queued (${item.outboxAttemptCount ?? 0})`,
        className: "text-warning",
        title: item.outboxLastError ?? "Waiting for the notification worker",
      };
    case "leased":
      return {
        label: `Sending (${item.outboxAttemptCount ?? 0})`,
        className: "text-warning",
        title: item.outboxLastError ?? "Notification delivery is leased",
      };
    case "delivered":
      return {
        label: `Delivered (${item.outboxAttemptCount ?? 0})`,
        className: "text-green",
      };
    case "suppressed":
      return {
        label: "Suppressed",
        className: "text-warning",
        title: item.outboxSuppressionReason === "ai_critical_alerts_disabled"
          ? "AI critical paging was off when this transition was recorded"
          : item.outboxSuppressionReason === "sync_failure_alerts_disabled"
            ? "Sync failure paging was off when this transition was recorded"
            : "Notifications were off when this transition was recorded",
      };
    case "exhausted":
      return {
        label: `Exhausted (${item.outboxAttemptCount ?? 0})`,
        className: "text-danger",
        title: item.outboxLastError ?? undefined,
      };
  }
}

export function NotificationsIncidentsTab() {
  const [status, setStatus] = useState<string | undefined>();
  const [kind, setKind] = useState<string | undefined>();
  const [pageLabel, setPageLabel] = useState<string | undefined>();
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError } = useNotificationIncidents({
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
      <div className="mb-4 flex items-center gap-3">
        <select
          value={status ?? ""}
          onChange={(event) => { setStatus(event.target.value || undefined); setOffset(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>

        <select
          value={kind ?? ""}
          onChange={(event) => { setKind(event.target.value || undefined); setOffset(0); }}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary"
        >
          <option value="">All Types</option>
          {(Object.entries(INCIDENT_KIND_LABELS) as Array<[IncidentKind, string]>)
            .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>

        <input
          type="text"
          placeholder="Filter by page..."
          value={pageLabel ?? ""}
          onChange={(event) => { setPageLabel(event.target.value || undefined); setOffset(0); }}
          className="w-48 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
        />
      </div>

      {isLoading ? (
        <StatusPanel title="Loading incidents" description="Fetching notification incidents." />
      ) : isError || !data ? (
        <StatusPanel
          title="Incidents failed to load"
          description="The notification incidents feed could not be fetched."
          tone="error"
        />
      ) : data.items.length === 0 ? (
        <StatusPanel
          title="No incidents recorded"
          description="Incidents appear when an operational condition opens an alert."
        />
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
                    <td className="px-4 py-2.5 text-[13px] font-medium text-text-primary">{item.pageLabel ?? "Global"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-secondary">
                      {INCIDENT_KIND_LABELS[item.kind]}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{item.stream ?? "—"}</td>
                    <td className="px-4 py-2.5 text-[12px] text-text-muted">{formatRelativeTime(item.openedAt)}</td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-[12px] text-text-muted">{item.errorSummary ?? "—"}</td>
                    <td
                      className={`px-4 py-2.5 text-right text-[12px] tabular-nums ${
                        deliveryState(item).className
                      }`}
                      title={deliveryState(item).title}
                    >
                      {deliveryState(item).label}
                    </td>
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
                  className="rounded border border-border px-2.5 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset(offset + LIMIT)}
                  disabled={offset + LIMIT >= data.total}
                  className="rounded border border-border px-2.5 py-1 disabled:opacity-40"
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

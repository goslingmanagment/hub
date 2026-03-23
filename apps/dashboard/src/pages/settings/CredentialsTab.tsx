import { useState } from "react";
import type { ConnectionItem } from "@agency_hub_core/contracts";
import { useAdminConnections } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusDot } from "@/components/shared/StatusDot";
import { formatRelativeTime } from "@/lib/format";
import { CredentialsModal, type CredentialsModalConnection } from "./CredentialsModal";

export function CredentialsTab() {
  const { data: connections, isLoading } = useAdminConnections();
  const [selectedConnection, setSelectedConnection] = useState<CredentialsModalConnection | null>(null);

  if (isLoading) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading connections...</div>
    );
  }

  const items = connections ?? [];

  return (
    <>
      <div className="space-y-3">
        {items.length === 0 && (
          <p className="text-sm text-text-muted">No connections configured.</p>
        )}
        {items.map((conn) => (
          <div
            key={conn.id}
            className="flex items-center justify-between rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-center gap-3">
              <StatusDot status={conn.connectionStatus} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-text-primary">
                    {conn.label}
                  </span>
                  <PlatformBadge platform={conn.platform} />
                </div>
                <div className="mt-0.5 text-xs text-text-muted">
                  @{conn.username ?? conn.displayName ?? "unknown"}
                  {conn.lastLightSyncAt && (
                    <> &middot; Last sync: {formatRelativeTime(conn.lastLightSyncAt)}</>
                  )}
                  <> &middot; {conn.subscriberCount} subs</>
                  {conn.platform === "fansly" && <> &middot; {conn.followerCount} followers</>}
                </div>
                {conn.lastSyncError && (
                  <div className="mt-1 text-xs text-danger">{conn.lastSyncError}</div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setSelectedConnection({
                  label: conn.label,
                  platform: conn.platform,
                  proxyConfigured: conn.proxyConfigured,
                })}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
            >
              Update Credentials
            </button>
          </div>
        ))}
      </div>

      {selectedConnection && (
        <CredentialsModal
          connection={selectedConnection}
          onClose={() => setSelectedConnection(null)}
        />
      )}
    </>
  );
}

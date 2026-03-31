import { useState } from "react";
import { useAdminConnections } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { getSyncUxDisplayMode } from "@/components/shared/syncUxDisplay";
import { CredentialsModal, type CredentialsModalConnection } from "./CredentialsModal.js";

function formatPageMetric(metric: {
  value: number | null;
  available: boolean;
}, label: string) {
  if (!metric.available || typeof metric.value !== "number") {
    return `${label} N/A`;
  }

  return `${metric.value.toLocaleString()} ${label}`;
}

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
        {items.map((conn) => {
          const syncMode = getSyncUxDisplayMode(conn.syncUx, "credentials");
          const reconnect = conn.syncUx.requiresAction;

          return (
            <div
              key={conn.id}
              className={`flex items-start justify-between gap-4 rounded-xl border bg-card p-4 ${
                reconnect ? "border-danger/30 bg-danger/[0.03]" : "border-border"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-text-primary">
                      {conn.label}
                    </span>
                    <PlatformBadge platform={conn.platform} />
                  </div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    @{conn.username ?? conn.displayName ?? "unknown"}
                    <> &middot; {formatPageMetric(conn.subscriberCount, "subs")}</>
                    {conn.platform === "fansly" && (
                      <> &middot; {formatPageMetric(conn.followerCount, "followers")}</>
                    )}
                  </div>
                  {syncMode === "exception" && (
                    <div className="mt-2 text-xs text-danger">
                      Credentials may need updating
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setSelectedConnection({
                    label: conn.label,
                    platform: conn.platform,
                    proxyUrl: conn.proxyUrl,
                    proxyHasAuth: conn.proxyHasAuth,
                  })}
                className={reconnect
                  ? "rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
                  : "rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"}
              >
                {reconnect ? "Reconnect" : "Update Credentials"}
              </button>
            </div>
          );
        })}
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

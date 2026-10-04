import { useState } from "react";
import { Link } from "react-router";
import { useAdminConnections } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { getSyncUxDisplayMode } from "@/components/shared/syncUxDisplay";
import { buildPageSyncRoute } from "@/lib/navigation";
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
  const { data: connections, isLoading, isError, error } = useAdminConnections();
  const [selectedConnection, setSelectedConnection] = useState<CredentialsModalConnection | null>(null);

  if (isLoading && !connections) {
    return (
      <div className="py-12 text-center text-sm text-text-muted">Loading connections...</div>
    );
  }

  if (isError && !connections) {
    return (
      <StatusPanel
        title="Connections failed to load"
        description={error instanceof Error ? error.message : "The connections catalog could not be fetched."}
        tone="error"
      />
    );
  }

  const items = connections ?? [];

  return (
    <>
      <div className="space-y-3">
        {isError && connections && (
          <StaleDataNotice error={error} />
        )}
        {items.length === 0 && (
          <p className="text-sm text-text-muted">No connections configured.</p>
        )}
        {items.map((conn) => {
          const syncMode = getSyncUxDisplayMode(conn.syncUx, "credentials");
          const reconnect = conn.syncUx.requiresAction;
          const usesOfapi = conn.platform === "onlyfans";

          return (
            <div
              key={conn.id}
              className={`flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-4 ${
                reconnect ? "border-danger/30 bg-danger/[0.03]" : "border-border"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-text-primary">
                      {conn.label}
                    </span>
                    <PlatformBadge platform={conn.platform} />
                    {conn.platform === "fansly" && (
                      conn.proxyUrl ? (
                        <span className="rounded-full border border-border bg-hover px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                          Proxy
                        </span>
                      ) : (
                        <span
                          className="rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
                          title="Fansly egress is fail-closed: without a proxy this page cannot sync"
                        >
                          No proxy — sync refused
                        </span>
                      )
                    )}
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
                      {usesOfapi ? "OFAPI connection needs attention" : "Credentials may need updating"}
                    </div>
                  )}
                  {usesOfapi && (
                    <p className="mt-2 max-w-xl text-xs text-text-muted">
                      Access is managed in OFAPI. Reconnect the account there if access expired.
                      Hub account mapping repairs require owner review; Sync shows the current blocks.
                    </p>
                  )}
                </div>
              </div>
              {usesOfapi ? (
                <Link
                  to={buildPageSyncRoute(conn.platform, conn.label)}
                  className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-hover"
                >
                  Connection diagnostics
                </Link>
              ) : (
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
              )}
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

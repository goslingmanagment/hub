import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { useSyncOverview } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { buildSettingsRoute, syncSettingsTab } from "@/lib/navigation";
import { SyncBlockRow } from "./SyncBlockRow.js";
import { SyncDiagnosisNotice } from "./SyncDiagnosisNotice.js";
import { SyncPageAttention } from "./SyncPageAttention.js";
import { getBlockOrder } from "./syncBlockDisplay.js";

function PageCard({
  page,
  onSelect,
}: {
  page: SyncBlocksPage;
  onSelect: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">
            {page.pageLabel}
          </span>
          <PlatformBadge platform={page.platform} />
          {page.username && (
            <span className="text-xs text-text-muted">@{page.username}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onSelect}
          className="text-xs font-medium text-accent hover:underline shrink-0"
        >
          View details &rarr;
        </button>
      </div>

      {/* Block rows */}
      <div className="mt-3 border-t border-border pt-2">
        {getBlockOrder().map((key) => (
          <SyncBlockRow key={key} block={page.blocks[key]} />
        ))}
      </div>

      {/* Error bar */}
      <SyncPageAttention page={page} />
    </div>
  );
}

/** The pages the Fansly Sync Engine reads are not listed here: say where. */
function EnginePagesPointer({ count }: { count: number }) {
  return (
    <p className="text-xs text-text-secondary">
      Страницы Fansly ({count}) читает Fansly Sync Engine — они на вкладке{" "}
      <Link to={buildSettingsRoute("engine")} className="font-semibold text-accent hover:underline">
        «Синк»
      </Link>
      .
    </p>
  );
}

/** The pages of the legacy page-sync executor with their five blocks. */
export function SyncPageList({
  onSelectPage,
}: {
  onSelectPage: (pageLabel: string) => void;
}) {
  const { data, isLoading, isError, error } = useSyncOverview();

  if (isLoading && !data) {
    return <p className="text-sm text-text-muted">Loading sync status...</p>;
  }

  if (isError && !data) {
    return (
      <StatusPanel
        title="Sync status failed to load"
        description={error instanceof Error ? error.message : "The sync overview could not be fetched."}
        tone="error"
      />
    );
  }

  const visible = data?.pages ?? [];
  const pages = visible.filter((page) => syncSettingsTab(page.platform) === "sync");
  const enginePages = visible.length - pages.length;
  // The overview's own diagnosis is that of its first page in trouble, of
  // either engine; this tab speaks for its pages only.
  const diagnosis = pages.find((page) => page.diagnosis !== null)?.diagnosis ?? null;

  if (pages.length === 0) {
    return (
      <div className="space-y-3">
        {isError && data && (
          <StaleDataNotice error={error} />
        )}
        {enginePages > 0
          ? <EnginePagesPointer count={enginePages} />
          : (
            <EmptyState
              title="No pages configured"
              description="Add a page to start syncing."
            />
          )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isError && data && (
        <StaleDataNotice error={error} />
      )}
      {diagnosis && (
        <SyncDiagnosisNotice diagnosis={diagnosis} />
      )}
      {pages.map((page) => (
        <PageCard
          key={page.pageId}
          page={page}
          onSelect={() => onSelectPage(page.pageLabel)}
        />
      ))}
      {enginePages > 0 && <EnginePagesPointer count={enginePages} />}
    </div>
  );
}

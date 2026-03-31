import type { SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { useSyncOverview } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { EmptyState } from "@/components/shared/EmptyState";
import { SyncBlockRow } from "./SyncBlockRow.js";
import { SyncDiagnosisNotice } from "./SyncDiagnosisNotice.js";
import { getBlockOrder, getReasonSummary, isDependencyWait, needsVisualAttention } from "./syncBlockDisplay.js";

function PageErrorBar({ page }: { page: SyncBlocksPage }) {
  if (page.diagnosis) {
    return <SyncDiagnosisNotice diagnosis={page.diagnosis} className="mt-3" />;
  }

  const blocks = getBlockOrder().map((key) => page.blocks[key]);
  const attentionBlocks = blocks.filter(needsVisualAttention).filter((block) => !isDependencyWait(block));
  if (attentionBlocks.length === 0) return null;

  const authFailed = attentionBlocks.find((b) => b.statusReason?.code === "credentials_invalid");
  if (authFailed) {
    return (
      <div className="mt-3 rounded-lg border border-danger/20 bg-danger/[0.04] px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="text-danger font-medium">
            {getReasonSummary(authFailed) ?? "Credentials may have expired"}
          </span>
          <Link
            to="/settings?tab=credentials"
            className="font-semibold text-accent hover:underline"
          >
            Update credentials
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-danger/20 bg-danger/[0.04] px-3 py-2.5">
      {attentionBlocks.map((b) => (
        <div
          key={b.block}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
        >
          <span className="text-danger font-medium">
            {getReasonSummary(b) ?? `${b.block} needs attention`}
          </span>
        </div>
      ))}
    </div>
  );
}

function PageCard({
  page,
  onSelect,
}: {
  page: SyncBlocksPage;
  onSelect: () => void;
}) {
  const blockKeys = getBlockOrder();

  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
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
        {blockKeys.map((key) => (
          <SyncBlockRow key={key} block={page.blocks[key]} />
        ))}
      </div>

      {/* Error bar */}
      <PageErrorBar page={page} />
    </div>
  );
}

export function SyncPageList({
  onSelectPage,
}: {
  onSelectPage: (pageLabel: string) => void;
}) {
  const { data, isLoading } = useSyncOverview();

  if (isLoading && !data) {
    return <p className="text-sm text-text-muted">Loading sync status...</p>;
  }

  const pages = data?.pages ?? [];

  if (pages.length === 0) {
    return (
      <EmptyState
        title="No pages configured"
        description="Add a page to start syncing."
      />
    );
  }

  return (
    <div className="space-y-3">
      {data?.diagnosis && (
        <SyncDiagnosisNotice diagnosis={data.diagnosis} />
      )}
      {pages.map((page) => (
        <PageCard
          key={page.pageId}
          page={page}
          onSelect={() => onSelectPage(page.pageLabel)}
        />
      ))}
    </div>
  );
}

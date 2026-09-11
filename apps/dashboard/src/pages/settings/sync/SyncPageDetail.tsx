import type { SyncBlockStatus, SyncBlocksPage } from "@agency_hub_core/contracts";
import { usePageSyncBlocks } from "@/api/queries";
import { PlatformBadge } from "@/components/shared/PlatformBadge";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { StaleDataNotice } from "@/components/shared/StaleDataNotice";
import { formatRelativeTime } from "@/lib/format";
import { SyncBlockBadge } from "./SyncBlockRow.js";
import { SyncBlockActions } from "./SyncBlockActions.js";
import { SyncDiagnosisNotice } from "./SyncDiagnosisNotice.js";
import {
  getBlockOrder,
  getBlockLabel,
  getBlockDescription,
  formatBlockSummary,
  formatBlockProgressCaption,
  getBlockProgressFillClass,
  getBlockProgressBarMode,
  formatCadence,
  formatNextTime,
  getDependencyWaitDetail,
  getBlockTone,
  getReasonSummary,
  getStreamLabel,
  getSubstreamTone,
  isDependencyWait,
  formatSubstreamStateLabel,
} from "./syncBlockDisplay.js";

function BlockDetailCard({
  block,
  pageLabel,
  platform,
}: {
  block: SyncBlockStatus;
  pageLabel: string;
  platform: SyncBlocksPage["platform"];
}) {
  const label = getBlockLabel(block.block);
  const description = getBlockDescription(block.block);
  const isNA = block.state === "not_available";

  if (isNA) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text-muted">{label}</span>
          <SyncBlockBadge block={block} />
        </div>
        <p className="mt-1 text-xs text-text-muted">
          Not available on this platform
        </p>
      </div>
    );
  }

  const summary = formatBlockSummary(block);
  const dependencyWait = isDependencyWait(block);
  const statusSummary = getReasonSummary(block) ??
    (block.state === "delayed"
      ? formatBlockSummary(block)
      : block.state === "failed"
        ? `${label} needs attention`
        : null);
  const statusTitle = dependencyWait
    ? "Waiting for prerequisite syncs"
    : statusSummary ?? (block.state === "failed" ? `${label} needs attention` : "Sync is delayed");
  const queueWaiting = block.statusReason?.code === "queue_waiting";
  const hasStatusNotice = dependencyWait || block.state === "failed" || block.state === "delayed";
  const hasSubstreams = block.substreams.length > 1;
  const dependencyDetail = getDependencyWaitDetail(block);
  const progressCaption = formatBlockProgressCaption(block);
  const progressBarMode = getBlockProgressBarMode(block);
  const statusTone = dependencyWait || queueWaiting
    ? "border-border bg-hover-alt text-text-secondary"
    : block.state === "failed"
    ? "border-danger/20 bg-danger/[0.04] text-danger"
    : "border-warning/25 bg-warning/10 text-warning-dark";
  const physicalAttemptCount24h = typeof block.metrics.physicalAttemptCount24h === "number"
    ? block.metrics.physicalAttemptCount24h
    : 0;
  const physicalSuccessCount24h = typeof block.metrics.physicalSuccessCount24h === "number"
    ? block.metrics.physicalSuccessCount24h
    : 0;
  const maxPhysicalAttemptsSinceLastSuccess =
    typeof block.metrics.maxPhysicalAttemptsSinceLastSuccess === "number"
      ? block.metrics.maxPhysicalAttemptsSinceLastSuccess
      : 0;
  const stalePhysicalAttemptCount = typeof block.metrics.stalePhysicalAttemptCount === "number"
    ? block.metrics.stalePhysicalAttemptCount
    : 0;

  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        <SyncBlockBadge block={block} />
      </div>

      {/* What this block does */}
      <p className="mt-0.5 text-xs text-text-muted">{description}</p>

      {/* Summary */}
      <p className={`mt-2 text-xs ${getBlockTone(block).text}`}>
        {summary}
      </p>

      {/* Progress bar */}
      {progressBarMode !== "hidden" && block.progress && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 max-w-[240px] rounded-full bg-hover-alt overflow-hidden">
            {progressBarMode === "determinate"
              ? (
                <div
                  className={`h-full rounded-full transition-all ${getBlockProgressFillClass(block)}`}
                  style={{
                    width: `${Math.min(100, block.progress.percent ?? (
                      block.progress.total && block.progress.total > 0
                        ? (block.progress.current / block.progress.total) * 100
                        : 0
                    ))}%`,
                  }}
                />
              )
              : (
                <div
                  className={`h-full w-[35%] rounded-full animate-pulse ${getBlockProgressFillClass(block)}`}
                />
              )}
          </div>
          <span className="text-[11px] text-text-muted">
            {progressCaption ?? block.progress.label}
          </span>
        </div>
      )}

      {/* Status details */}
      {hasStatusNotice && (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 space-y-1 ${statusTone}`}>
          <p className="text-xs font-medium">
            {statusTitle}
          </p>
          {dependencyWait && dependencyDetail && (
            <p className="text-[11px] text-text-secondary">
              Prerequisites: {dependencyDetail}
            </p>
          )}
          {!dependencyWait && block.statusReason?.summary && block.statusReason.summary !== statusSummary && (
            <p className="text-[11px] text-text-secondary">{block.statusReason.summary}</p>
          )}
          {block.error?.code && (
            <p className="text-[11px] text-text-muted">Code: {block.error.code}</p>
          )}
          {block.error?.failedAt && (
            <p className="text-[11px] text-text-muted">
              Last failed: {formatRelativeTime(block.error.failedAt)}
            </p>
          )}
          {block.error && block.error.consecutiveFailures > 0 && (
            <p className="text-[11px] text-text-muted">
              Consecutive failures: {block.error.consecutiveFailures}
            </p>
          )}
        </div>
      )}

      {/* Timing */}
      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        {physicalAttemptCount24h > 0 && (
          <>
            <span className="text-text-muted">Sync HTTP attempts (24h)</span>
            <span className="text-text-secondary">
              {physicalSuccessCount24h}/{physicalAttemptCount24h} succeeded (
              {Math.round((physicalSuccessCount24h / physicalAttemptCount24h) * 100)}%)
            </span>
          </>
        )}
        {stalePhysicalAttemptCount > 0 && (
          <>
            <span className="text-text-muted">Stuck sync attempts</span>
            <span className="text-danger font-medium">{stalePhysicalAttemptCount}</span>
          </>
        )}
        {maxPhysicalAttemptsSinceLastSuccess > 0 && (
          <>
            <span className="text-text-muted">Attempts without success</span>
            <span className="text-warning-dark font-medium">
              {maxPhysicalAttemptsSinceLastSuccess}
            </span>
          </>
        )}
        {block.succeededAt && (
          <>
            <span className="text-text-muted">Last success</span>
            <span className="text-text-secondary">
              {formatRelativeTime(block.succeededAt)}
            </span>
          </>
        )}
        {block.nextDueAt && (
          <>
            <span className="text-text-muted">Next due</span>
            <span className="text-text-secondary">{formatNextTime(block.nextDueAt)}</span>
          </>
        )}
        {block.nextRetryAt && (
          <>
            <span className="text-text-muted">Next retry</span>
            <span className="text-text-secondary">
              {formatNextTime(block.nextRetryAt)}
            </span>
          </>
        )}
        {block.intervals.length > 0 && (
          <>
            <span className="text-text-muted">Intervals</span>
            <span className="text-text-secondary">
              {block.intervals
                .map((i) => `${getStreamLabel(i.stream)} (${formatCadence(i.cadenceSeconds)})`)
                .join(", ")}
            </span>
          </>
        )}
      </div>

      {/* Substreams (Messages) */}
      {hasSubstreams && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
            Substreams
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-hover-alt">
                  <th className="px-3 py-1.5 text-left font-medium text-text-muted">
                    Stream
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium text-text-muted">
                    State
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium text-text-muted">
                    Last success
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium text-text-muted">
                    Next due
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium text-text-muted">
                    Interval
                  </th>
                </tr>
              </thead>
              <tbody>
                {block.substreams.map((sub) => {
                  const subTone = getSubstreamTone(sub);
                  return (
                    <tr key={sub.stream} className="border-t border-border">
                      <td className="px-3 py-1.5 text-text-primary font-medium">
                        {getStreamLabel(sub.stream)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span
                            className={`inline-block h-1.5 w-1.5 rounded-full ${subTone.dot}`}
                          />
                          <span className={subTone.text}>
                            {formatSubstreamStateLabel(sub)}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary">
                        {sub.succeededAt
                          ? formatRelativeTime(sub.succeededAt)
                          : "\u2014"}
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary">
                        {formatNextTime(sub.nextDueAt) ?? "\u2014"}
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary">
                        {formatCadence(sub.cadenceSeconds)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex justify-end">
        <SyncBlockActions pageLabel={pageLabel} platform={platform} block={block} />
      </div>
    </div>
  );
}

function PageHeader({
  page,
  onBack,
}: {
  page: SyncBlocksPage;
  onBack: () => void;
}) {
  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-text-muted hover:text-text-secondary transition-colors mb-3"
      >
        &larr; Back to overview
      </button>
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-text-primary">
          {page.pageLabel}
        </span>
        <PlatformBadge platform={page.platform} />
        {page.username && (
          <span className="text-xs text-text-muted">@{page.username}</span>
        )}
        {page.displayName && page.displayName !== page.username && (
          <span className="text-xs text-text-muted">{page.displayName}</span>
        )}
      </div>
    </div>
  );
}

export function SyncPageDetail({
  pageLabel,
  onBack,
}: {
  pageLabel: string;
  onBack: () => void;
}) {
  const { data, isLoading, isError, error } = usePageSyncBlocks(pageLabel);

  if (isLoading && !data) {
    return (
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors mb-3"
        >
          &larr; Back to overview
        </button>
        <p className="text-sm text-text-muted">Loading page details...</p>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors mb-3"
        >
          &larr; Back to overview
        </button>
        <StatusPanel
          title="Sync page failed to load"
          description={error instanceof Error ? error.message : "The page sync details could not be fetched."}
          tone="error"
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-muted hover:text-text-secondary transition-colors mb-3"
        >
          &larr; Back to overview
        </button>
        <p className="text-sm text-text-muted">Page not found.</p>
      </div>
    );
  }

  const page = data.page;
  const blockKeys = getBlockOrder();

  return (
    <div>
      <PageHeader page={page} onBack={onBack} />
      <div className="space-y-3">
        {isError && data && (
          <StaleDataNotice error={error} />
        )}
        {page.diagnosis && (
          <SyncDiagnosisNotice diagnosis={page.diagnosis} pageLabel={page.pageLabel} />
        )}
        {blockKeys.map((key) => (
          <BlockDetailCard
            key={key}
            block={page.blocks[key]}
            pageLabel={pageLabel}
            platform={page.platform}
          />
        ))}
      </div>
    </div>
  );
}

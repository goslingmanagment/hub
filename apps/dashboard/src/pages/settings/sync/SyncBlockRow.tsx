import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import {
  getBlockTone,
  getBlockLabel,
  getBlockStateLabel,
  getBlockProgressFillClass,
  getBlockProgressBarMode,
  formatBlockSummary,
  formatBlockProgressCaption,
  getWsHintGenerationNotice,
} from "./syncBlockDisplay.js";

export function SyncBlockRow({ block }: { block: SyncBlockStatus }) {
  const tone = getBlockTone(block);
  const label = getBlockLabel(block.block);
  const summary = formatBlockSummary(block);
  const isNA = block.state === "not_available";
  const progressCaption = formatBlockProgressCaption(block);
  const progressBarMode = getBlockProgressBarMode(block);
  const hintNotice = getWsHintGenerationNotice(block);

  return (
    <div className="grid grid-cols-[9rem_1fr] gap-x-3 py-1 items-baseline">
      <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
        {label}
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
        <span className={`text-xs ${isNA ? "text-text-muted" : tone.text}`}>
          {summary}
        </span>
        {progressBarMode !== "hidden" && block.progress && (
          <div className="flex items-center gap-2 basis-full mt-0.5">
            <div className="h-1.5 flex-1 max-w-[180px] rounded-full bg-hover-alt overflow-hidden">
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
        {hintNotice && (
          <span className="basis-full text-[11px] text-warning-dark">
            {hintNotice.headline} &middot; {hintNotice.summary}
          </span>
        )}
      </div>
    </div>
  );
}

export function SyncBlockBadge({ block }: { block: SyncBlockStatus }) {
  const tone = getBlockTone(block);
  const label = getBlockStateLabel(block);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {label}
    </span>
  );
}

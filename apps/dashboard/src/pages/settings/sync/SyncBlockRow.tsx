import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import {
  getBlockTone,
  getBlockLabel,
  getBlockStateLabel,
  getBlockProgressFillClass,
  getBlockProgressBarMode,
  getBlockProgressPercent,
  formatBlockSummary,
  formatBlockProgressCaption,
} from "./syncBlockDisplay.js";

/** A block's progress: a bar and what it counts. Nothing when there is none to show. */
export function SyncBlockProgress({ block, width = "max-w-[200px]" }: { block: SyncBlockStatus; width?: string }) {
  const mode = getBlockProgressBarMode(block);
  if (mode === "hidden" || !block.progress) return null;
  const caption = formatBlockProgressCaption(block) ?? block.progress.label;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <div className={`h-1.5 w-full flex-1 ${width} overflow-hidden rounded-full bg-hover`}>
        {mode === "determinate"
          ? (
            <div
              className={`h-full rounded-full transition-all ${getBlockProgressFillClass(block)}`}
              style={{ width: `${getBlockProgressPercent(block)}%` }}
            />
          )
          : <div className={`h-full w-[35%] animate-pulse rounded-full ${getBlockProgressFillClass(block)}`} />}
      </div>
      {caption && <span className="text-xs text-text-muted">{caption}</span>}
    </div>
  );
}

/** A block at a glance (a page's card of the list). */
export function SyncBlockRow({ block }: { block: SyncBlockStatus }) {
  const tone = getBlockTone(block);
  const isNA = block.state === "not_available";

  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-3 py-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]" data-sync-block={block.block}>
      <span className="flex items-center gap-2 font-medium text-text-secondary">
        <span className={tone.dot} />
        {getBlockLabel(block.block)}
      </span>
      <div className="min-w-0 space-y-1">
        <span className={`break-words ${isNA ? "text-text-muted" : tone.text}`}>{formatBlockSummary(block)}</span>
        <SyncBlockProgress block={block} width="max-w-[180px]" />
      </div>
    </div>
  );
}

export function SyncBlockBadge({ block }: { block: SyncBlockStatus }) {
  return <span className={getBlockTone(block).badge} data-sync-state={block.state}>{getBlockStateLabel(block)}</span>;
}

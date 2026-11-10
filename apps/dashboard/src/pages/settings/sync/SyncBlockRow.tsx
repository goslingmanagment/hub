import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import {
  getBlockProgressFillClass,
  getBlockProgressBarMode,
  getBlockProgressPercent,
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


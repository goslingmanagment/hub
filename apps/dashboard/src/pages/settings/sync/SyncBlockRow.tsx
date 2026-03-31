import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import {
  getBlockTone,
  getBlockLabel,
  getBlockStateLabel,
  formatBlockSummary,
  shouldShowBlockProgressBar,
} from "./syncBlockDisplay.js";

export function SyncBlockRow({ block }: { block: SyncBlockStatus }) {
  const tone = getBlockTone(block.state);
  const label = getBlockLabel(block.block);
  const summary = formatBlockSummary(block);
  const isNA = block.state === "not_available";

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
        {shouldShowBlockProgressBar(block) && block.progress && block.progress.total != null && block.progress.total > 0 && (
          <div className="flex items-center gap-2 basis-full mt-0.5">
            <div className="h-1.5 flex-1 max-w-[180px] rounded-full bg-hover-alt overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{
                  width: `${Math.min(100, block.progress.percent ?? (block.progress.current / block.progress.total) * 100)}%`,
                }}
              />
            </div>
            <span className="text-[11px] text-text-muted">
              {block.progress.current.toLocaleString()} / {block.progress.total.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function SyncBlockBadge({ state }: { state: SyncBlockStatus["state"] }) {
  const tone = getBlockTone(state);
  const label = getBlockStateLabel(state);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {label}
    </span>
  );
}

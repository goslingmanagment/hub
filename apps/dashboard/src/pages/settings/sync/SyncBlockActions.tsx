import { useState } from "react";
import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import {
  useAdminSyncBlockTrigger,
  useAdminSyncBlockPause,
  useAdminSyncBlockResume,
  useAdminSyncBlockReset,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { toast } from "sonner";
import { getBlockLabel, getStreamLabel } from "./syncBlockDisplay.js";
import type { SyncBlockKey, SyncBlockState } from "./syncBlockDisplay.js";

// Detailed status keeps compatibility rows visible for auditability, but they
// must not create a fake recovery action: OnlyFans `light` and `transactions`
// are webhook/OFAPI-era no-ops.
const ONLYFANS_NON_RESUMABLE_STREAMS = new Set([
  "light",
  "transactions",
]);

function canTrigger(state: SyncBlockState): boolean {
  return (
    state === "not_started" ||
    state === "scheduled" ||
    state === "up_to_date" ||
    state === "retrying" ||
    state === "delayed" ||
    state === "failed"
  );
}

function canTriggerDisabled(state: SyncBlockState): boolean {
  return state === "syncing" || state === "backfilling";
}

function canPause(state: SyncBlockState): boolean {
  return state !== "paused" && state !== "not_available";
}

function canResume(state: SyncBlockState): boolean {
  return state === "paused";
}

function canReset(state: SyncBlockState): boolean {
  return state !== "not_available";
}

/** The buttons of a block of a page the legacy page-sync executor serves
 *  (OnlyFans). A Fansly page's blocks have their own on «Синк»
 *  (`engine/EngineBlocks.tsx`). */
export function getSyncBlockActionPresentation(block: SyncBlockStatus) {
  const pausedSubstreams = block.substreams.filter((substream) => (
    substream.state === "paused" && !ONLYFANS_NON_RESUMABLE_STREAMS.has(substream.stream)
  ));
  const hasPartialPause = block.state !== "paused" && pausedSubstreams.length > 0;
  const showResume = block.substreams.length > 0 ? pausedSubstreams.length > 0 : canResume(block.state);

  return {
    showTrigger: !hasPartialPause && (canTrigger(block.state) || canTriggerDisabled(block.state)),
    showPause: !hasPartialPause && canPause(block.state),
    showResume,
    showReset: canReset(block.state),
    resumeLabel: hasPartialPause && pausedSubstreams.length === 1
      ? `Resume ${getStreamLabel(pausedSubstreams[0]!.stream)}`
      : "Resume",
    resetLabel: "Reset",
  };
}

export function SyncBlockActions({
  pageLabel,
  block,
}: {
  pageLabel: string;
  block: SyncBlockStatus;
}) {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const triggerMut = useAdminSyncBlockTrigger();
  const pauseMut = useAdminSyncBlockPause();
  const resumeMut = useAdminSyncBlockResume();
  const resetMut = useAdminSyncBlockReset();

  const state = block.state;
  const blockKey = block.block as SyncBlockKey;
  const label = getBlockLabel(blockKey);
  const anyPending =
    triggerMut.isPending || pauseMut.isPending || resumeMut.isPending || resetMut.isPending;

  if (state === "not_available") return null;

  async function handleTrigger() {
    try {
      await triggerMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`Sync triggered for ${label}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to trigger sync");
    }
  }

  async function handlePause() {
    try {
      await pauseMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label} paused`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to pause");
    }
  }

  async function handleResume() {
    try {
      await resumeMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label} resumed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to resume");
    }
  }

  async function handleReset() {
    try {
      await resetMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label} reset`);
      setShowResetConfirm(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to reset");
    }
  }

  const {
    showTrigger,
    showPause,
    showResume,
    showReset,
    resumeLabel,
    resetLabel,
  } = getSyncBlockActionPresentation(block);

  return (
    <>
      <div className="flex items-center gap-2">
        {showTrigger && (
          <button
            type="button"
            onClick={handleTrigger}
            disabled={anyPending || canTriggerDisabled(state)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
          >
            Sync Now
          </button>
        )}
        {showPause && (
          <button
            type="button"
            onClick={handlePause}
            disabled={anyPending}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
          >
            Pause
          </button>
        )}
        {showResume && (
          <button
            type="button"
            onClick={handleResume}
            disabled={anyPending}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
          >
            {resumeLabel}
          </button>
        )}
        {showReset && (
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            disabled={anyPending}
            className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
          >
            {resetLabel}
          </button>
        )}
      </div>

      {showResetConfirm && (
        <ConfirmModal
          title={`Reset ${label}?`}
          message={`This will clear all sync state for ${label} on ${pageLabel}. The block will re-sync from scratch.`}
          confirmLabel={resetLabel}
          isPending={resetMut.isPending}
          onConfirm={handleReset}
          onClose={() => setShowResetConfirm(false)}
        />
      )}
    </>
  );
}

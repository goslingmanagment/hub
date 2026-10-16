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
import { getBlockLabel, syncResetConfirmText } from "./syncBlockDisplay.js";
import type { SyncBlockKey, SyncBlockState } from "./syncBlockDisplay.js";
import { SYNC_LEVER_LABELS, syncStreamLabel } from "./syncVocabulary.js";

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
 *  (OnlyFans). A Fansly page's blocks have their own on the Fansly screen
 *  (`engine/EngineBlocks.tsx`), with the same verbs. */
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
      ? `${SYNC_LEVER_LABELS.resume}: ${syncStreamLabel(pausedSubstreams[0]!.stream)}`
      : SYNC_LEVER_LABELS.resume,
    resetLabel: SYNC_LEVER_LABELS.reset,
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
      toast.success(`${label}: обновление поставлено в очередь`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось запустить обновление");
    }
  }

  async function handlePause() {
    try {
      await pauseMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: на паузе`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось поставить на паузу");
    }
  }

  async function handleResume() {
    try {
      await resumeMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: пауза снята`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось снять паузу");
    }
  }

  async function handleReset() {
    try {
      await resetMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: сброшено, загрузка начнётся заново`);
      setShowResetConfirm(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сбросить");
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        {showReset && (
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            disabled={anyPending}
            className="btn btn-ghost btn-sm text-danger"
          >
            {resetLabel}
          </button>
        )}
        {showPause && (
          <button type="button" onClick={handlePause} disabled={anyPending} className="btn btn-sm">
            {SYNC_LEVER_LABELS.pause}
          </button>
        )}
        {showResume && (
          <button type="button" onClick={handleResume} disabled={anyPending} className="btn btn-sm">
            {resumeLabel}
          </button>
        )}
        {showTrigger && (
          <button
            type="button"
            onClick={handleTrigger}
            disabled={anyPending || canTriggerDisabled(state)}
            className="btn btn-primary btn-sm"
          >
            {SYNC_LEVER_LABELS.trigger}
          </button>
        )}
      </div>

      {showResetConfirm && (
        <ConfirmModal
          title={`Сбросить «${label}»?`}
          message={syncResetConfirmText(blockKey, pageLabel)}
          confirmLabel={resetLabel}
          isPending={resetMut.isPending}
          onConfirm={handleReset}
          onClose={() => setShowResetConfirm(false)}
        />
      )}
    </>
  );
}

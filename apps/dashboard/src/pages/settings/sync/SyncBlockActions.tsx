import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import type { SyncBlockState } from "./syncBlockDisplay.js";
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
 *  (`pages/system/collection/EngineBlocksTable.tsx`), with the same verbs;
 *  the levers themselves are `pages/system/collection/LegacyBlocksTable.tsx`. */
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

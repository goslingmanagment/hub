import { useRef, useState } from "react";
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

type SyncPlatform = "fansly" | "onlyfans";
type ResetReview = Readonly<{ pageLabel: string; block: SyncBlockKey; label: string }>;

// Detailed status keeps compatibility rows visible for auditability, but they
// must not create a fake recovery action. OnlyFans `light` and `transactions`
// are webhook/OFAPI-era no-ops, while legacy `dm_messages` is retired.
const ONLYFANS_NON_RESUMABLE_STREAMS = new Set([
  "light",
  "transactions",
  "dm_messages",
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

export function getSyncBlockActionPresentation(
  block: SyncBlockStatus,
  platform: SyncPlatform,
) {
  const pausedSubstreams = block.substreams.filter((substream) => (
    substream.state === "paused" && !(
      platform === "onlyfans" && ONLYFANS_NON_RESUMABLE_STREAMS.has(substream.stream)
    )
  ));
  const hasPartialPause = block.state !== "paused" && pausedSubstreams.length > 0;
  const showResume = platform === "onlyfans" && block.substreams.length > 0
    ? pausedSubstreams.length > 0
    : canResume(block.state) || hasPartialPause;

  return {
    showTrigger: !hasPartialPause && (canTrigger(block.state) || canTriggerDisabled(block.state)),
    showPause: !hasPartialPause && canPause(block.state),
    showResume,
    showReset: block.block !== "messages_history" && canReset(block.state),
    resumeLabel: hasPartialPause && pausedSubstreams.length === 1
      ? `Продолжить: ${getStreamLabel(pausedSubstreams[0]!.stream)}`
      : "Продолжить",
  };
}

export function SyncBlockActions({
  pageLabel,
  platform,
  block,
  disabled = false,
}: {
  pageLabel: string;
  platform: SyncPlatform;
  block: SyncBlockStatus;
  disabled?: boolean;
}) {
  const [resetReview, setResetReview] = useState<ResetReview | null>(null);
  const [actionError, setActionError] = useState("");
  const inFlight = useRef(false);
  const triggerMut = useAdminSyncBlockTrigger();
  const pauseMut = useAdminSyncBlockPause();
  const resumeMut = useAdminSyncBlockResume();
  const resetMut = useAdminSyncBlockReset();

  const state = block.state;
  const blockKey = block.block as SyncBlockKey;
  const label = getBlockLabel(blockKey);
  const anyPending =
    disabled || triggerMut.isPending || pauseMut.isPending || resumeMut.isPending || resetMut.isPending;

  if (state === "not_available") return null;

  async function perform(action: () => Promise<unknown>, success: string, target = { pageLabel, label }) {
    if (inFlight.current || anyPending) return;
    inFlight.current = true;
    setActionError("");
    try {
      await action();
      toast.success(`${target.pageLabel} · ${target.label}: ${success}`);
      setResetReview(null);
    } catch (e) {
      setActionError(`${target.pageLabel} · ${target.label}: ${e instanceof Error ? e.message : "Не удалось выполнить действие. Обновите состояние перед повтором."}`);
    } finally {
      inFlight.current = false;
    }
  }

  function handleTrigger() {
    return perform(() => triggerMut.mutateAsync({ pageLabel, block: blockKey }), "запуск запрошен");
  }
  function handlePause() {
    return perform(() => pauseMut.mutateAsync({ pageLabel, block: blockKey }), "приостановлено");
  }
  function handleResume() {
    return perform(() => resumeMut.mutateAsync({ pageLabel, block: blockKey }), "продолжение запрошено");
  }
  function handleReset() {
    const target = resetReview;
    if (!target || target.block === "messages_history") return;
    return perform(() => resetMut.mutateAsync({ pageLabel: target.pageLabel, block: target.block }), "состояние сброшено, запуск запрошен", target);
  }

  const {
    showTrigger,
    showPause,
    showResume,
    showReset,
    resumeLabel,
  } = getSyncBlockActionPresentation(block, platform);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {showTrigger && (
          <button
            type="button"
            onClick={handleTrigger}
            disabled={anyPending || canTriggerDisabled(state)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-40"
          >
            Синхронизировать
          </button>
        )}
        {showPause && (
          <button
            type="button"
            onClick={handlePause}
            disabled={anyPending}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-hover disabled:opacity-40"
          >
            Приостановить
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
            onClick={() => {
              if (inFlight.current || anyPending) return;
              setResetReview(Object.freeze({ pageLabel, block: blockKey, label }));
            }}
            disabled={anyPending}
            className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
          >
            Сбросить состояние
          </button>
        )}
      </div>
      {blockKey === "messages_history" && <p className="mt-2 text-xs text-text-muted">Сброс истории сообщений недоступен: сервер защищает сохранённые переписки от удаления.</p>}
      {actionError && <p role="alert" className="mt-2 text-sm text-danger">{actionError}</p>}

      {resetReview && (
        <ConfirmModal
          title={`Сбросить состояние: ${resetReview.label}?`}
          message={`Страница ${resetReview.pageLabel}. Прогресс и контрольные точки этого блока будут сброшены; синхронизация начнётся заново.`}
          confirmLabel="Сбросить"
          isPending={resetMut.isPending}
          onConfirm={handleReset}
          onClose={() => { if (!inFlight.current) setResetReview(null); }}
        />
      )}
    </>
  );
}

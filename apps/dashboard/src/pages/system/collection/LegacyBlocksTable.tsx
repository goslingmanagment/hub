import { Fragment, useState } from "react";
import type { SyncBlocksPage, SyncBlockStatus } from "@agency_hub_core/contracts";
import { toast } from "sonner";
import {
  useAdminSyncBlockPause,
  useAdminSyncBlockReset,
  useAdminSyncBlockResume,
  useAdminSyncBlockTrigger,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { Disclosure } from "@/components/ui/Disclosure";
import { RowMenu, type RowMenuItem } from "@/components/ui/RowMenu";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { COLLECTION_STATUS, OFAPI_OFF_REASON, type OfapiStatus, type StatusWord } from "@/lib/statusWords";
import { SyncBlockProgress } from "@/pages/settings/sync/SyncBlockRow";
import { getSyncBlockActionPresentation } from "@/pages/settings/sync/SyncBlockActions";
import {
  formatAttemptsLine,
  formatBlockSummary,
  formatCadence,
  formatNextTime,
  formatSubstreamStateLabel,
  getBlockDescription,
  getBlockLabel,
  getBlockOrder,
  getDependencyWaitDetail,
  getReasonSummary,
  getServerReasonText,
  syncResetConfirmText,
  type SyncBlockKey,
} from "@/pages/settings/sync/syncBlockDisplay";
import { SYNC_LEVER_LABELS, syncStreamLabel } from "@/pages/settings/sync/syncVocabulary";
import { MomentCell, momentOr, RowChevron } from "../shared.js";

/** An OnlyFans block in the one vocabulary (design/screens/system.md §3.2). Null: «Недоступно», plain text. */
function legacyWord(block: SyncBlockStatus, ofapi: OfapiStatus): StatusWord | null {
  if (ofapi === "off") return COLLECTION_STATUS.ofapiOff;
  if (ofapi === "unknown") return COLLECTION_STATUS.unknown;
  switch (block.state) {
    case "not_started": return COLLECTION_STATUS.setup;
    case "scheduled": return block.succeededAt === null ? COLLECTION_STATUS.setup : COLLECTION_STATUS.healthy;
    case "backfilling": return COLLECTION_STATUS.catching_up;
    case "up_to_date":
    case "syncing": return COLLECTION_STATUS.healthy;
    case "retrying":
    case "delayed": return COLLECTION_STATUS.delayed;
    case "failed": return COLLECTION_STATUS.attention;
    case "paused": return COLLECTION_STATUS.paused;
    default: return null;
  }
}

/** The levers of an OnlyFans block, behind «…». The requests are the old screen's; «Обновить сейчас» now asks first: it spends credits. */
function LegacyLevers({ pageLabel, block, blocked }: { pageLabel: string; block: SyncBlockStatus; blocked: string | null }) {
  const [confirm, setConfirm] = useState<"trigger" | "reset" | null>(null);
  const triggerMut = useAdminSyncBlockTrigger();
  const pauseMut = useAdminSyncBlockPause();
  const resumeMut = useAdminSyncBlockResume();
  const resetMut = useAdminSyncBlockReset();
  const blockKey = block.block as SyncBlockKey;
  const label = getBlockLabel(blockKey);
  const anyPending = triggerMut.isPending || pauseMut.isPending || resumeMut.isPending || resetMut.isPending;
  if (block.state === "not_available") return null;

  async function handleTrigger() {
    try {
      await triggerMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: обновление поставлено в очередь`);
    } catch {
      toast.error("Не удалось запустить обновление", { duration: Infinity, closeButton: true });
    }
    setConfirm(null);
  }
  async function handlePause() {
    try {
      await pauseMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: на паузе`);
    } catch {
      toast.error("Не удалось поставить на паузу", { duration: Infinity, closeButton: true });
    }
  }
  async function handleResume() {
    try {
      await resumeMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: пауза снята`);
    } catch {
      toast.error("Не удалось снять паузу", { duration: Infinity, closeButton: true });
    }
  }
  async function handleReset() {
    try {
      await resetMut.mutateAsync({ pageLabel, block: blockKey });
      toast.success(`${label}: сброшено, загрузка начнётся заново`);
    } catch {
      toast.error("Не удалось сбросить", { duration: Infinity, closeButton: true });
    }
    setConfirm(null);
  }

  const shown = getSyncBlockActionPresentation(block);
  const off = blocked !== null;
  const why = blocked ?? undefined;
  const items: RowMenuItem[] = [];
  if (shown.showTrigger) {
    const busy = block.state === "syncing" || block.state === "backfilling";
    items.push({ label: SYNC_LEVER_LABELS.trigger, onSelect: () => setConfirm("trigger"), disabled: off || anyPending || busy, title: why, hint: off ? blocked : undefined });
  }
  if (shown.showPause) items.push({ label: SYNC_LEVER_LABELS.pause, onSelect: () => void handlePause(), disabled: off || anyPending, title: why });
  if (shown.showResume) items.push({ label: shown.resumeLabel, onSelect: () => void handleResume(), disabled: off || anyPending, title: why });
  // The server always refuses a reset of «Сообщения»: it would erase every message of the page.
  if (shown.showReset && block.block !== "messages_history") {
    items.push({ label: shown.resetLabel, onSelect: () => setConfirm("reset"), disabled: off || anyPending, title: why, danger: true });
  }
  if (items.length === 0) return null;

  return (
    <div className="sys-actions-inner">
      <RowMenu label={`Ещё: ${label}`} items={items} />
      {confirm === "trigger" && (
        <ConfirmModal
          title={`Обновить «${label}» у ${pageLabel}?`}
          message="Hub пойдёт в OnlyFans API, это тратит кредиты."
          facts={[
            { label: "Куда", value: `${pageLabel}, OnlyFans` },
            { label: "Сколько стоит", value: "зависит от объёма, точной оценки нет" },
            { label: "Отменить", value: "нельзя, запросы уйдут сразу" },
          ]}
          confirmLabel={SYNC_LEVER_LABELS.trigger}
          pendingLabel="Обновляем…"
          tone="primary"
          initialFocus="cancel"
          isPending={triggerMut.isPending}
          onConfirm={() => void handleTrigger()}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "reset" && (
        <ConfirmModal
          title={`Сбросить «${label}»?`}
          message={<>{syncResetConfirmText(blockKey, pageLabel)} Новый сбор тратит кредиты OnlyFans API.</>}
          confirmLabel={shown.resetLabel}
          isPending={resetMut.isPending}
          onConfirm={() => void handleReset()}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function LegacyDetail({ block, off }: { block: SyncBlockStatus; off: boolean }) {
  const dependency = getDependencyWaitDetail(block);
  const attempts = formatAttemptsLine(block);
  const server = [
    getReasonSummary(block),
    getServerReasonText(block),
    block.error?.code ? `код ${block.error.code}` : null,
    block.error && block.error.consecutiveFailures > 0 ? `ошибок подряд: ${block.error.consecutiveFailures}` : null,
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <div className="sys-detail">
      {!off && (
        <>
          <p>{formatBlockSummary(block)}</p>
          {dependency && <p>Сначала: {dependency}</p>}
          {block.nextRetryAt && <p>Следующая попытка: {formatNextTime(block.nextRetryAt)}</p>}
          {attempts && <p className="cell-second">{attempts}</p>}
        </>
      )}
      {block.substreams.length > 1 && (
        <div>
          <p className="sys-label">Потоки блока ({block.substreams.length})</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Поток</th>
                  <th>Состояние</th>
                  <th>Последние данные</th>
                  <th>Следующее</th>
                  <th>Как часто</th>
                </tr>
              </thead>
              <tbody>
                {block.substreams.map((sub) => (
                  <tr key={sub.stream}>
                    <td className="whitespace-nowrap">{syncStreamLabel(sub.stream)}</td>
                    <td className="muted">{off ? "выключено" : formatSubstreamStateLabel(sub)}</td>
                    <td className="muted whitespace-nowrap">{momentOr(sub.succeededAt)}</td>
                    <td className="muted whitespace-nowrap">{off ? "—" : formatNextTime(sub.nextDueAt) ?? "—"}</td>
                    <td className="muted whitespace-nowrap">{off || sub.cadenceSeconds <= 0 ? "—" : formatCadence(sub.cadenceSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {server.length > 0 && (
        <Disclosure label="Подробнее">
          <p className="text-text-secondary" lang="en">{server.join(" · ")}</p>
        </Disclosure>
      )}
    </div>
  );
}

/** «Что собирается» of an OnlyFans page (§3.2): grey while the API is off, the old levers behind «…» while it is on. */
export function LegacyBlocksTable({ page, ofapi, blocked }: { page: SyncBlocksPage; ofapi: OfapiStatus; blocked: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const off = ofapi !== "on";
  return (
    <section className="card" aria-labelledby="legacy-blocks-title">
      <div className="card-header">
        <h2 id="legacy-blocks-title" className="card-title">Что собирается</h2>
      </div>
      <div className="table-wrap">
        <table className={`data-table sys-blocks${off ? " sys-mute" : ""}`}>
          <thead>
            <tr>
              <th>Блок</th>
              <th>Состояние</th>
              <th>Последние данные</th>
              <th className="sys-col-next">Следующее</th>
              <th className="sys-col-cadence">Как часто</th>
              <th><span className="sr-only">Действия</span></th>
            </tr>
          </thead>
          <tbody>
            {getBlockOrder().map((key) => {
              const block = page.blocks[key];
              const word = legacyWord(block, ofapi);
              const isOpen = open === key;
              const first = block.intervals[0];
              const description = key === "audience" ? "Подписчики страницы." : getBlockDescription(key);
              return (
                <Fragment key={key}>
                  <tr className="sys-click-row" data-sync-block={key} onClick={() => setOpen(isOpen ? null : key)}>
                    <td>
                      <span className="sys-block-name">
                        <RowChevron open={isOpen} label={`${isOpen ? "Свернуть" : "Раскрыть"}: ${getBlockLabel(key)}`} onToggle={() => setOpen(isOpen ? null : key)} />
                        {getBlockLabel(key)}
                      </span>
                      <span className="cell-second sys-indent">{description}</span>
                    </td>
                    <td className="status-col">
                      {word === null ? <span className="text-text-secondary">Недоступно</span> : <StatusBadge status={word} bare />}
                      {!off && block.state !== "not_available" && (
                        <>
                          <span className="cell-second sys-clamp">{formatBlockSummary(block)}</span>
                          <SyncBlockProgress block={block} width="max-w-[180px]" />
                        </>
                      )}
                    </td>
                    <td className="muted"><MomentCell at={block.succeededAt} empty="ещё не было" /></td>
                    <td className="sys-col-next muted whitespace-nowrap">{off ? "—" : formatNextTime(block.nextDueAt) ?? "—"}</td>
                    <td className="sys-col-cadence muted whitespace-nowrap">{off || !first ? "—" : formatCadence(first.cadenceSeconds)}</td>
                    <td className="sys-actions" onClick={(event) => event.stopPropagation()}>
                      <LegacyLevers pageLabel={page.pageLabel} block={block} blocked={off ? blocked ?? OFAPI_OFF_REASON : null} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="sys-detail-row">
                      <td colSpan={6}><LegacyDetail block={block} off={off} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

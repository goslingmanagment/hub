import { Fragment, useState } from "react";
import type { AdminSyncBlockResponse, SyncBlocksPage } from "@agency_hub_core/contracts";
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
import { COLLECTION_STATUS } from "@/lib/statusWords";
import { SYNC_LEVER_LABELS } from "@/pages/settings/sync/syncVocabulary";
import {
  ENGINE_BLOCK_NOT_READ,
  engineAttentionLines,
  engineBlockButtons,
  engineBlockDescription,
  engineBlockLabel,
  engineBlockOrder,
  engineBlockState,
  engineBlockStopText,
  engineBlockWord,
  engineCadenceText,
  engineChatsUnavailableLine,
  engineDueText,
  engineLeverNotice,
  engineRequeueConfirmText,
  engineStreamLabel,
  engineSubstreamState,
  engineSubstreamStateText,
  isEngineBlock,
  type EngineBlock,
  type EngineLeverAction,
} from "@/pages/settings/engine/engineBlockDisplay";
import { engineReadingWords, type EngineReadingState } from "@/pages/settings/engine/engineDisplay";
import { momentOr, RowChevron } from "../shared.js";

/** The states in which nothing of a block is due: no host runs the page, or every key of it is stopped. */
const NOTHING_DUE: ReadonlySet<EngineReadingState> = new Set(["no_owner", "switching", "paused", "page_held", "held"]);

const LEVER_FAILED: Record<EngineLeverAction, string> = {
  trigger: "Не удалось запустить обновление",
  pause: "Не удалось поставить на паузу",
  resume: "Не удалось снять паузу",
  reset: "Не удалось вернуть в работу",
};

function notify(notice: ReturnType<typeof engineLeverNotice>): void {
  if (notice.kind === "success") toast.success(notice.text);
  else if (notice.kind === "warning") toast.warning(notice.text);
  else toast.message(notice.text);
}

/**
 * The levers of one block: each acts on the block's own keys, the page from the
 * path and the block from the row; its toast says what the lever answered. The
 * requests, the honest toast and the cache reset are the old screen's
 * (`EngineBlockActions`); one button is visible, the rest are behind «…».
 */
function BlockLevers({ pageLabel, block }: { pageLabel: string; block: EngineBlock }) {
  const [confirmRequeue, setConfirmRequeue] = useState(false);
  const mutations = {
    trigger: useAdminSyncBlockTrigger(),
    pause: useAdminSyncBlockPause(),
    resume: useAdminSyncBlockResume(),
    reset: useAdminSyncBlockReset(),
  };
  const pending = Object.values(mutations).some((mutation) => mutation.isPending);
  const buttons = engineBlockButtons(block);
  const label = engineBlockLabel(block.block);
  const state = engineBlockState(block);
  const word = engineBlockWord(block).word;

  async function run(action: EngineLeverAction) {
    try {
      const response: AdminSyncBlockResponse = await mutations[action].mutateAsync({ pageLabel, block: block.block });
      notify(engineLeverNotice(action, block, response));
      if (action === "reset") setConfirmRequeue(false);
    } catch {
      toast.error(LEVER_FAILED[action], { duration: Infinity, closeButton: true });
      if (action === "reset") setConfirmRequeue(false);
    }
  }

  const lagging = word.word === COLLECTION_STATUS.delayed.word;
  const blockPaused = state === "paused" || state === "partly_paused";
  // The first that fits is the visible one: return to work, lift a pause, refresh a lagging block.
  const visible: "requeue" | "resume" | "trigger" | null = buttons.requeue
    ? "requeue"
    : buttons.resume && blockPaused
      ? "resume"
      : buttons.trigger && lagging
        ? "trigger"
        : null;
  const menu: RowMenuItem[] = [];
  if (buttons.trigger && visible !== "trigger") menu.push({ label: SYNC_LEVER_LABELS.trigger, onSelect: () => void run("trigger"), disabled: pending });
  if (buttons.pause) menu.push({ label: buttons.pause.label, onSelect: () => void run("pause"), disabled: pending });
  if (buttons.resume && visible !== "resume") menu.push({ label: buttons.resume.label, onSelect: () => void run("resume"), disabled: pending });

  return (
    <div className="sys-actions-inner">
      {visible === "requeue" && buttons.requeue && (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => setConfirmRequeue(true)}>{buttons.requeue.label}</button>
      )}
      {visible === "resume" && buttons.resume && (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void run("resume")}>{buttons.resume.label}</button>
      )}
      {visible === "trigger" && (
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => void run("trigger")}>{SYNC_LEVER_LABELS.trigger}</button>
      )}
      {menu.length > 0 && <RowMenu label={`Ещё: ${label}`} items={menu} />}
      {confirmRequeue && (
        <ConfirmModal
          title={`Вернуть в работу: ${label}?`}
          message={engineRequeueConfirmText(block, pageLabel)}
          confirmLabel="Вернуть в работу"
          pendingLabel="Возвращаем…"
          tone="primary"
          isPending={mutations.reset.isPending}
          onConfirm={() => void run("reset")}
          onClose={() => setConfirmRequeue(false)}
        />
      )}
    </div>
  );
}

/** What the row's opening holds: the stops in full, the work set aside, the streams. */
function BlockDetail({ block, now }: { block: EngineBlock; now: number }) {
  const state = engineBlockState(block);
  const { engine } = block;
  const attention = engineAttentionLines(block);
  const chats = engineChatsUnavailableLine(block);
  const codes = [
    ...engine.stops.flatMap((stop) => stop.resources),
    ...engine.quarantined.resources,
    ...engine.blockedByVendor.resources,
  ];
  return (
    <div className="sys-detail">
      {!engine.ownerRunning && <p>Если сервер сбора не ведёт страницу: {engineReadingWords(state, "ru").detail}</p>}
      {engine.stops.length > 0 && (
        <ul className="sys-lines">
          {engine.stops.map((stop) => (
            <li key={`${stop.reason}:${stop.by.join(",")}:${stop.until ?? ""}`}>{engineBlockStopText(stop, now, engine.keys.length)}</li>
          ))}
        </ul>
      )}
      {attention.length > 0 && (
        <ul className="sys-lines">
          {attention.map((line) => <li key={line}>{line.charAt(0).toUpperCase() + line.slice(1)}</li>)}
        </ul>
      )}
      {chats && <p>{chats}</p>}
      <div>
        <p className="sys-label">Как часто</p>
        <p>
          {block.intervals.length === 0
            ? "по запросу, без расписания"
            : block.intervals.map((interval) => `${engineStreamLabel(interval.stream)} — ${engineCadenceText(interval.cadenceSeconds)}`).join(", ")}
        </p>
      </div>
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
                {block.substreams.map((substream) => {
                  const subState = engineSubstreamState(block, substream);
                  return (
                    <tr key={substream.stream}>
                      <td className="whitespace-nowrap">{engineStreamLabel(substream.stream)}</td>
                      <td>{engineSubstreamStateText(block, substream)}</td>
                      <td className="muted whitespace-nowrap">{momentOr(substream.succeededAt, "ещё не было")}</td>
                      <td className="muted whitespace-nowrap">
                        {NOTHING_DUE.has(subState) || substream.nextDueAt === null ? "—" : engineDueText(substream.nextDueAt, now)}
                      </td>
                      <td className="muted whitespace-nowrap">{substream.cadenceSeconds > 0 ? engineCadenceText(substream.cadenceSeconds) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {codes.length > 0 && (
        <Disclosure label="Подробнее">
          <p>Задачи, о которых речь выше: <span className="sys-code">{[...new Set(codes)].join(", ")}</span></p>
        </Disclosure>
      )}
    </div>
  );
}

/** «Что собирается» of a Fansly page: five rows, a chevron opens each (design/screens/system.md §3.1, block 3). */
export function EngineBlocksTable({ page, now = Date.now() }: { page: SyncBlocksPage; now?: number }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <section className="card" aria-labelledby="engine-blocks-title">
      <div className="card-header">
        <h2 id="engine-blocks-title" className="card-title">Что собирается</h2>
      </div>
      <div className="table-wrap">
        <table className="data-table sys-blocks">
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
            {engineBlockOrder().map((key) => {
              const block = page.blocks[key];
              const label = engineBlockLabel(key);
              if (!isEngineBlock(block)) {
                return (
                  <tr key={key} data-engine-block={key}>
                    <td>
                      <span className="sys-block-name">{label}</span>
                      <span className="cell-second">{engineBlockDescription(key)}</span>
                    </td>
                    <td className="status-col">
                      <StatusBadge status={COLLECTION_STATUS.attention} bare />
                      <span className="cell-second">{ENGINE_BLOCK_NOT_READ}</span>
                    </td>
                    <td className="muted">{momentOr(block.succeededAt, "ещё не было")}</td>
                    <td className="sys-col-next muted">—</td>
                    <td className="sys-col-cadence muted">—</td>
                    <td />
                  </tr>
                );
              }
              const state = engineBlockState(block);
              const word = engineBlockWord(block, now);
              const isOpen = open.has(key);
              const first = block.intervals[0];
              return (
                <Fragment key={key}>
                  <tr data-engine-block={key} className="sys-click-row" onClick={() => toggle(key)}>
                    <td>
                      <span className="sys-block-name">
                        <RowChevron open={isOpen} label={`${isOpen ? "Свернуть" : "Раскрыть"}: ${label}`} onToggle={() => toggle(key)} />
                        {label}
                      </span>
                      <span className="cell-second sys-indent">{engineBlockDescription(key)}</span>
                    </td>
                    <td className="status-col">
                      <StatusBadge status={word.word} bare />
                      {word.second && <span className="cell-second sys-clamp">{word.second}</span>}
                    </td>
                    <td className="muted whitespace-nowrap">{momentOr(block.succeededAt, "ещё не было")}</td>
                    <td className="sys-col-next muted whitespace-nowrap">
                      {NOTHING_DUE.has(state) || block.nextDueAt === null ? "—" : engineDueText(block.nextDueAt, now)}
                    </td>
                    <td className="sys-col-cadence muted whitespace-nowrap">{first ? engineCadenceText(first.cadenceSeconds) : "—"}</td>
                    <td className="sys-actions" onClick={(event) => event.stopPropagation()}>
                      <BlockLevers pageLabel={page.pageLabel} block={block} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="sys-detail-row">
                      <td colSpan={6}><BlockDetail block={block} now={now} /></td>
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

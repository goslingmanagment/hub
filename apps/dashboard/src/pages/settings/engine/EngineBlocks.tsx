import { useState } from "react";
import type { AdminSyncBlockResponse, SyncBlockStatus, SyncBlocksPage } from "@agency_hub_core/contracts";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  useAdminSyncBlockPause,
  useAdminSyncBlockReset,
  useAdminSyncBlockResume,
  useAdminSyncBlockTrigger,
} from "@/api/queries";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { buildSettingsRoute } from "@/lib/navigation";
import { SYNC_LEVER_LABELS } from "../sync/syncVocabulary.js";
import {
  ENGINE_BLOCK_NOT_READ,
  engineAttentionLines,
  engineBlockButtons,
  engineBlockCredentialsRefused,
  engineBlockDescription,
  engineBlockLabel,
  engineBlockOrder,
  engineBlockState,
  engineBlockStopText,
  engineBlockSummary,
  engineCadenceText,
  engineChatsUnavailableLine,
  engineDueText,
  engineLeverNotice,
  engineRequeueConfirmText,
  engineStateLabel,
  engineStateTone,
  engineStreamLabel,
  engineSubstreamState,
  engineSubstreamStateText,
  isEngineBlock,
  type EngineBlock,
  type EngineLeverAction,
} from "./engineBlockDisplay.js";
import {
  engineAgeText,
  engineReadingTone,
  engineReadingWords,
  isCredentialsStop,
  type EngineReadingState,
} from "./engineDisplay.js";

// The five blocks of a Fansly page as the Fansly screen shows them: a line
// each on the page's card of the list, a card each on the page's detail, and
// the buttons that act on the engine. What a block says — read, paused, held,
// without a processing host — is the server's verdict over the block's own
// keys (`engineBlockDisplay.ts`); a button says what it moved.

const CREDENTIALS_LINK = "Обновить данные входа";

/** The states in which nothing of a block is due: no host runs the page, or
 *  every key of it is stopped. */
const NOTHING_DUE: ReadonlySet<EngineReadingState> = new Set(["no_owner", "switching", "paused", "page_held", "held"]);

/** A block at a glance (the page's card of the list). */
export function EngineBlockRow({ block, now = Date.now() }: { block: SyncBlockStatus; now?: number }) {
  const label = engineBlockLabel(block.block);
  const engine = isEngineBlock(block) ? block : null;
  const tone = engine === null ? null : engineStateTone(engineBlockState(engine));
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-3 py-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]" data-engine-block={block.block}>
      <span className="flex items-center gap-2 font-medium text-text-secondary">
        <span className={tone?.dot ?? "status-dot"} />
        {label}
      </span>
      <span className={`min-w-0 break-words ${tone?.text ?? "text-text-muted"}`}>
        {engine === null ? "не читается" : engineBlockSummary(engine, now)}
      </span>
    </div>
  );
}

/** What on a page needs the owner: new credentials, else the work of its
 *  blocks that is quarantined or refused by Fansly. Nothing when nothing
 *  does. The commands that list that work are the screen's «Для разработчика». */
export function EnginePageAttention({
  page,
  className = "",
  now = Date.now(),
}: {
  page: SyncBlocksPage;
  className?: string;
  now?: number;
}) {
  const blocks = engineBlockOrder().map((key) => page.blocks[key]).filter(isEngineBlock);
  const refusal = blocks.flatMap((block) => block.engine.stops).find(isCredentialsStop);
  if (refusal !== undefined) {
    return (
      <div className={`notice notice-danger ${className}`} data-engine-attention="credentials">
        <p className="min-w-0">
          <span className="font-semibold">{engineBlockStopText(refusal, now)}</span>{" "}
          <span>Из страницы ничего не читается.</span>{" "}
          <Link to={buildSettingsRoute("credentials")} className="link font-semibold">
            {CREDENTIALS_LINK}
          </Link>
        </p>
      </div>
    );
  }
  const lines = blocks.flatMap((block) =>
    engineAttentionLines(block).map((line) => `${engineBlockLabel(block.block)} — ${line}`));
  if (lines.length === 0) return null;
  return (
    <div className={`notice notice-warning ${className}`} data-engine-attention="work">
      <ul className="min-w-0 space-y-0.5">
        {lines.map((line) => <li key={line} className="break-words">{line}</li>)}
      </ul>
    </div>
  );
}

function notify(notice: ReturnType<typeof engineLeverNotice>): void {
  if (notice.kind === "success") toast.success(notice.text);
  else if (notice.kind === "warning") toast.warning(notice.text);
  else toast.message(notice.text);
}

const LEVER_FAILED: Record<EngineLeverAction, string> = {
  trigger: "Не удалось запустить обновление",
  pause: "Не удалось поставить на паузу",
  resume: "Не удалось снять паузу",
  reset: "Не удалось сбросить карантин",
};

/** The buttons of a block: each acts on the block's own keys, and its toast
 *  says what the engine's lever answered. The same verbs as on the OnlyFans
 *  screen; the reset here returns quarantined work, and its confirmation
 *  says so. */
export function EngineBlockActions({ pageLabel, block }: { pageLabel: string; block: EngineBlock }) {
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

  async function run(action: EngineLeverAction) {
    try {
      const response: AdminSyncBlockResponse = await mutations[action].mutateAsync({ pageLabel, block: block.block });
      notify(engineLeverNotice(action, block, response));
      if (action === "reset") setConfirmRequeue(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : LEVER_FAILED[action]);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {buttons.requeue && (
          <button
            type="button"
            onClick={() => setConfirmRequeue(true)}
            disabled={pending}
            className="btn btn-ghost btn-sm text-danger"
          >
            {buttons.requeue.label}
          </button>
        )}
        {buttons.pause && (
          <button type="button" onClick={() => void run("pause")} disabled={pending} className="btn btn-sm">
            {buttons.pause.label}
          </button>
        )}
        {buttons.resume && (
          <button type="button" onClick={() => void run("resume")} disabled={pending} className="btn btn-sm">
            {buttons.resume.label}
          </button>
        )}
        {buttons.trigger && (
          <button type="button" onClick={() => void run("trigger")} disabled={pending} className="btn btn-primary btn-sm">
            {SYNC_LEVER_LABELS.trigger}
          </button>
        )}
      </div>

      {confirmRequeue && (
        <ConfirmModal
          title={`Сбросить карантин: ${label}?`}
          message={engineRequeueConfirmText(block, pageLabel)}
          confirmLabel={SYNC_LEVER_LABELS.reset}
          cancelLabel="Отмена"
          closeLabel="Закрыть"
          tone="primary"
          isPending={mutations.reset.isPending}
          onConfirm={() => void run("reset")}
          onClose={() => setConfirmRequeue(false)}
        />
      )}
    </>
  );
}

function StateBadge({ state }: { state: EngineReadingState }) {
  return (
    <span title={engineReadingWords(state, "ru").detail} className={engineStateTone(state).badge} data-engine-state={state}>
      {engineStateLabel(state)}
    </span>
  );
}

function readAgo(iso: string | null, now: number): string {
  const age = engineAgeText(iso, now);
  return age === null ? "—" : `${age} назад`;
}

/** The streams of a block: a table where its five columns fit, and one
 *  labelled block per stream where they would run past the card (a phone, a
 *  narrow window). */
function EngineStreams({ block, now }: { block: EngineBlock; now: number }) {
  const streams = block.substreams.map((substream) => {
    const state = engineSubstreamState(block, substream);
    const tone = engineStateTone(state);
    return {
      stream: substream.stream,
      label: engineStreamLabel(substream.stream),
      dot: tone.dot,
      stateClass: engineReadingTone(state) === "warn" ? tone.text : "text-text-secondary",
      stateText: engineSubstreamStateText(block, substream),
      read: readAgo(substream.succeededAt, now),
      // Nothing is due of a stream no host reads, or every key of which is stopped.
      next: NOTHING_DUE.has(state) || substream.nextDueAt === null ? "—" : engineDueText(substream.nextDueAt, now),
      // A stream read on a trigger, not on a poll, has no period.
      poll: substream.cadenceSeconds > 0 ? engineCadenceText(substream.cadenceSeconds) : "—",
    };
  });
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border">
      <table className="hidden data-table @md:table" data-engine-streams="table">
        <thead>
          <tr>
            <th>Поток</th>
            <th>Состояние</th>
            <th>Последнее чтение</th>
            <th>Следующее</th>
            <th>Опрос</th>
          </tr>
        </thead>
        <tbody>
          {streams.map((row) => (
            <tr key={row.stream} data-engine-stream={row.stream}>
              <td className="font-medium">{row.label}</td>
              <td>
                <span className="flex items-center gap-2">
                  <span className={row.dot}></span><span className={row.stateClass}>{row.stateText}</span>
                </span>
              </td>
              <td className="muted">{row.read}</td>
              <td className="muted">{row.next}</td>
              <td className="muted">{row.poll}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y divide-border-light text-sm @md:hidden" data-engine-streams="list">
        {streams.map((row) => (
          <li key={row.stream} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium text-text-primary">{row.label}</span>
              <span className="flex items-center gap-2">
                <span className={row.dot}></span><span className={row.stateClass}>{row.stateText}</span>
              </span>
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-text-secondary">
              <dt className="text-text-muted">Последнее чтение</dt>
              <dd>{row.read}</dd>
              <dt className="text-text-muted">Следующее</dt>
              <dd>{row.next}</dd>
              <dt className="text-text-muted">Опрос</dt>
              <dd>{row.poll}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One block of a page in detail: what is true of it, what stops it, what of
 *  it needs the owner, its streams and its buttons. */
export function EngineBlockCard({
  block,
  pageLabel,
  now = Date.now(),
}: {
  block: SyncBlockStatus;
  pageLabel: string;
  now?: number;
}) {
  const label = engineBlockLabel(block.block);
  if (!isEngineBlock(block)) {
    return (
      <section className="card" data-engine-block={block.block}>
        <div className="card-header">
          <div>
            <h4 className="card-title text-text-secondary">{label}</h4>
            <p className="card-description">{ENGINE_BLOCK_NOT_READ}</p>
          </div>
        </div>
      </section>
    );
  }

  const state = engineBlockState(block);
  const { engine } = block;
  const attention = engineAttentionLines(block);
  const chatsUnavailable = engineChatsUnavailableLine(block);
  const nothingDue = NOTHING_DUE.has(state);
  // The owner's pause is the owner's own doing: it is said, not sounded.
  const stopsTone = engine.stops.every((stop) => stop.reason === "paused") ? "notice" : "notice notice-warning";

  return (
    <section className="@container card" data-engine-block={block.block}>
      <div className="card-header">
        <div className="min-w-0">
          <h4 className="card-title">{label}</h4>
          <p className="card-description">{engineBlockDescription(block.block)}</p>
        </div>
        <StateBadge state={state} />
      </div>

      <div className="card-body space-y-3">
        {!engine.ownerRunning && (
          <p className="notice notice-warning font-medium">{engineReadingWords(state, "ru").detail}</p>
        )}

        {engine.stops.length > 0 && (
          <div className={`${stopsTone} flex-col gap-1`} data-engine-stops>
            {engine.stops.map((stop) => (
              <p key={`${stop.reason}:${stop.by.join(",")}:${stop.until ?? ""}`} className="break-words font-medium">
                {engineBlockStopText(stop, now, engine.keys.length)}
              </p>
            ))}
            {block.block === "connection" && engineBlockCredentialsRefused(block) && (
              <Link to={buildSettingsRoute("credentials")} className="link inline-block font-semibold">
                {CREDENTIALS_LINK} &rarr;
              </Link>
            )}
          </div>
        )}

        {attention.length > 0 && (
          <div className="notice notice-warning flex-col gap-1" data-engine-attention="work">
            {attention.map((line) => (
              <p key={line} className="break-words font-medium">{line}</p>
            ))}
          </div>
        )}

        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <span className="text-text-muted">Последнее чтение</span>
          <span className="text-text-secondary">{block.succeededAt === null ? "ещё не было" : readAgo(block.succeededAt, now)}</span>
          {!nothingDue && block.nextDueAt !== null && (
            <>
              <span className="text-text-muted">Следующее</span>
              <span className="text-text-secondary">{engineDueText(block.nextDueAt, now)}</span>
            </>
          )}
          {block.intervals.length > 0 && (
            <>
              <span className="text-text-muted">Опросы</span>
              <span className="text-text-secondary">
                {block.intervals
                  .map((interval) => `${engineStreamLabel(interval.stream)} — ${engineCadenceText(interval.cadenceSeconds)}`)
                  .join(", ")}
              </span>
            </>
          )}
        </div>

        {chatsUnavailable !== null && (
          <p className="break-words text-sm text-text-secondary" data-engine-chats-unavailable>
            {chatsUnavailable}
          </p>
        )}

        {block.substreams.length > 1 && (
          <details className="help">
            <summary>Потоки блока ({block.substreams.length})</summary>
            <EngineStreams block={block} now={now} />
          </details>
        )}
      </div>

      <div className="card-footer justify-end">
        <EngineBlockActions pageLabel={pageLabel} block={block} />
      </div>
    </section>
  );
}
